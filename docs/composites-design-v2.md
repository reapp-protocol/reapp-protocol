# MandateRegistry v2 — Composite Mandates (Stage 1) + Admin/Pause + Fee Knob — DESIGN v2

**Status:** DESIGN v2 — supersedes composites-design.md. This revision folds in
the 41 findings from the 4-lens adversarial design review (economic / platform /
security / completeness). Every critical and high is resolved here; the change
log is §11. Meaningful deltas from earlier planning are flagged in §10.
Deploy/redeploy, SDK bindings, and CLI are OUT of scope for this pass — contract
code + tests only.

---

## 0. What changed from v1 (the load-bearing decisions)

The review found the clearing *math* sound but the *timing and funding* layer
around it broken in ways that defeat the "organizer provably can't skim" thesis.
Four architectural decisions resolve the criticals; they reshape the product
promise slightly and are called out here so they are not buried:

- **D-A · Clearing is a deadline auction, not a race.** `clear_pool` capture is
  valid only at `now >= clearing_deadline`. Pre-deadline it returns
  `DeadlineNotReached` even if the predicate holds. This removes the timing
  option: p\* is a pure function of the committed set *at close*, not of who
  fires first. (v1 let anyone fire the instant it was feasible, which handed the
  merchant the maximum uniform price — the exact adversarial-selection hole.)

- **D-B · Capture is best-effort over the *able* set, not all-or-nothing over the
  *committed* set.** At clear time the contract reads each committed child's live
  allowance and balance; children who cannot cover their worst-case leg are
  deterministically excluded *before* the clearing math, exactly like expired or
  revoked children. p\* is computed over the able set; the pool fires iff the able
  set still meets the threshold. The captured legs still settle atomically (all
  or nothing *within the fired set*). This keeps the merchant's real guarantee
  (aggregate ≥ threshold) while removing the free "one zero-cost sybil bricks the
  pool" veto. **Pitch nuance:** "the whole *cleared* order settles atomically or
  nobody pays" — the cleared set may exclude members who pulled their allowance;
  it never charges anyone outside their signed schedule.

- **D-C · Admin is set at deploy via `__constructor`, never a separate init.**
  Kills the initializer front-run. `set_admin` remains for rotation.

- **D-D · Pooled mandates have a defined terminal exit.** When a pool Aborts, and
  for any committed child not captured when a pool Clears, the child is set
  `Released`; a `Released` (or never-committed) pooled child may spend on the
  solo path again, still bounded by its own signed `max_amount`/`merchant`/
  `expiry`. No mandate is ever stranded un-spendable-and-un-revocable, and no
  vc_hash is permanently burned by a normal abort.

## 1. Scope

**In:** ClearingPool + composite Stage 1 (ThresholdFloor group buys, deadline
auction, best-effort atomic capture over the able set), admin + pause/unpause via
constructor, zero-rate protocol fee knob pinned at pool registration. Full
adversarial test suite incl. the griefing/DoS/timing cases the review surfaced.
Standalone mandates keep today's stored-state and transfer behavior; the only
observable change to the solo path is a trailing `fee` field on the
`payment_executed` event (0 at rate 0) — flagged loudly in §9.4 as a
consumer-visible ABI change.

**Out:** Stage 2 (SpendCeiling/CapacityCeiling clearing, claimable-balance pull
settlement, AP2/JCS hash alignment), Stage 3 (discovery/matching, x402/ACP
bridge), deploy scripts, SDK bindings, CLI, mainnet hardening
(multisig/timelock/asset allowlist). The `ClearingKind` enum ships all three
variants for ABI stability; `register_pool` rejects non-ThresholdFloor with
`KindNotSupported`.

## 2. Module map (dependencies flow one way, no cycles)

```
lib → {registry, payment, admin, pool} → storage → {mandate, pooltypes, error}
                └──────────┴──────┴────→ events (leaf)
pool → clearing (pure; input = pool + Vec<child-view> + now; NO storage, NO env I/O)
```

- `lib.rs` — thin dispatch + `__constructor`. No logic.
- `mandate.rs` — `Mandate` type, `Status`, `PoolState`, schedule validation +
  `demand()` / `worst_case()` helpers (all pure).
- `pooltypes.rs` — `ClearingPool`, `ClearingKind`, `PoolStatus`, `ClearOutcome`,
  and `ChildView` (the pure-clearing input row). Pure data.
- `clearing.rs` — the trust core. `clear(pool, children: Vec<ChildView>, now) ->
  ClearOutcome`. No storage access. `clear_pool` and `simulate_clear` build the
  identical `Vec<ChildView>` from the same ledger state and call this — that
  equality *is* the no-discretion guarantee (scoped to same-ledger evaluation,
  §4.6).
- `pool.rs` — pool lifecycle: `register_pool`, `commit_child`, `evict_child`,
  `clear_pool`, `simulate_clear`, `get_pool`, `get_pool_members`. Owns the
  capture and the on-chain allowance/balance reads that build `ChildView`.
- `admin.rs` — `set_admin`, `pause`, `unpause`, `is_paused`, `set_fee_rate`,
  `set_fee_recipient`, `get_fee_rate`, `get_fee_recipient`. (`__constructor`
  lives in lib, stores the admin.)
- `registry.rs` — register/revoke (extended for pool linkage + terminal release).
- `payment.rs` — solo money path (extended: pause guard, fee legs, pooled-active
  rejection) + `validate_mandate` (extended to reflect pause + pool state).
- `storage.rs` — the ONLY module touching `env.storage`.
- `error.rs`, `events.rs` — leaves.

## 3. Data model

### 3.1 Mandate (extended — 3 new fields; everything else unchanged)

```rust
pub struct Mandate {
    pub user: Address,
    pub agent: Address,
    pub merchant: Address,
    pub asset: Address,
    pub max_amount: i128,      // hard ceiling, defense in depth — unchanged
    pub spent: i128,
    pub expiry: u64,
    pub seq: u32,
    pub status: Status,        // Active | Revoked | Exhausted — unchanged
    pub vc_hash: BytesN<32>,
    // NEW:
    pub pool_id: Option<BytesN<32>>,        // None == standalone (today's behavior)
    pub price_schedule: Vec<(i128, u128)>,  // (unit_price, max_qty); empty when standalone
    pub pool_state: PoolState,              // Unlinked | Committed | Captured | Released
}

pub enum PoolState { Unlinked, Committed, Captured, Released }
```

`register_mandate` gains two trailing params: `pool_id: Option<BytesN<32>>`,
`price_schedule: Vec<(i128, u128)>`. ABI change (redeploy + regenerate bindings).
Standalone callers pass `(None, vec![])` → today's behavior exactly. A schedule
supplied with `pool_id = None`, or an empty schedule with `pool_id = Some`, is
`ScheduleInvalid`.

### 3.2 ClearingPool (new, `pooltypes.rs`)

```rust
pub struct ClearingPool {
    pub originator: Address,
    pub merchant: Address,
    pub asset: Address,
    pub kind: ClearingKind,        // ThresholdFloor | SpendCeiling | CapacityCeiling
    pub threshold_qty: u128,
    pub threshold_value: u128,     // interpreted NET-of-fee to the merchant (§4.5)
    pub min_child_value: u128,     // floor per committing child's worst_case (anti-dust, §5.4)
    pub clearing_deadline: u64,    // auction close; capture window is [deadline, deadline+CAPTURE_WINDOW]
    pub fee_bps_pinned: u32,       // fee rate captured at register_pool time (§4.5)
    pub status: PoolStatus,        // Open | Cleared | Aborted
    pub member_count: u32,
}
```

**Aggregates dropped.** v1's `aggregate_qty`/`aggregate_value` are removed:
the review proved they are mathematically incoherent (qty at one price, value at
another, no single price realizes both) and, with checked adds, a free
DoS. `simulate_clear` is the correct and already-specified preflight; nothing
else needs a running sum. `member_count` stays (cheap, honest).

Member list: `DataKey::PoolMembers(pool_id) → Vec<BytesN<32>>` (mandate ids,
commit order). `member_root` Merkle field dropped for Stage 1 (list ≤ 8, stored
directly, readable on-chain).

### 3.3 ChildView (pure-clearing input, `pooltypes.rs`)

The row `pool.rs` builds per committed child and feeds to `clear()`. Making the
clearing function take a plain Vec of these (not storage handles) is what keeps
it pure and makes `simulate == capture` a provable equality.

```rust
pub struct ChildView {
    pub mandate_id: BytesN<32>,
    pub schedule: Vec<(i128, u128)>,
    pub eligible: bool,   // Committed && Active && now < expiry && min(allowance,balance) >= worst_case
    pub worst_case: i128, // precomputed, bounded by §8 caps so no scan op can overflow
}
```

### 3.4 ClearOutcome (returned by `simulate_clear`, computed inside `clear_pool`)

```rust
pub struct ClearOutcome {
    pub fires: bool,
    pub clearing_price: i128,                  // 0 when !fires
    pub allocations: Vec<(BytesN<32>, u128)>,  // (mandate_id, qty), mandate_id order, qty > 0 only
    pub total_qty: u128,
    pub gross_value: i128,                      // clearing_price * total_qty (cannot overflow, §8)
    pub total_fee: i128,                        // Σ per-leg floored fee at fee_bps_pinned
    pub net_value: i128,                        // gross_value - total_fee (compared to threshold_value)
}
```

### 3.5 Config storage

Instance storage: `Admin: Address` (set by `__constructor`, always present),
`Paused: bool` (default false), `FeeRateBps: u32` (default 0),
`FeeRecipient: Option<Address>` (None until set). Instance TTL bumped on write.
Pools + member lists live in **persistent** storage (§3.6 TTL).

### 3.6 TTL policy (new)

- `register_pool` requires `clearing_deadline + CAPTURE_WINDOW - now <=
  MAX_POOL_HORIZON` (≤ `TTL_EXTEND` ≈ 30 days) so a pool's lifetime always fits
  one TTL bump; else `DeadlineTooFar`.
- Every pool touchpoint (`register_pool`, `commit_child`, `evict_child`,
  `clear_pool`, and a pooled `revoke_mandate`) bumps the pool entry, the member
  list, AND the touched child mandate TTL to cover `clearing_deadline +
  CAPTURE_WINDOW + margin`. A pool therefore cannot be archived inside its own
  live window regardless of how quiet it goes. Mandate/config TTL constants
  unchanged.

## 4. The clearing function (trust core)

### 4.1 Schedule semantics (unchanged from v1 §4.1 — the correction the review confirmed right)

Entry `(unit_price, max_qty)` = "at uniform clearing price ≤ unit_price, buy up
to max_qty units." A demand curve: quantity falls as price rises.

Validation at `register_mandate` (→ `ScheduleInvalid`): non-empty; `len ≤
MAX_SCHEDULE_POINTS = 8`; `unit_price` strictly ascending, each `> 0` and `≤
MAX_UNIT_PRICE`; `max_qty` strictly descending, each `> 0` and `≤ MAX_QTY`;
`worst_case ≤ max_amount`. (Strict ascending price + strict descending qty
rejects dominated/overlapping entries at the source.)

`demand(schedule, p)` = the `max_qty` of the FIRST entry (lowest price) with
`unit_price ≥ p`; `0` if `p` exceeds every entry's price. Example `[(5,3),(10,1)]`:
`demand(5)=3, demand(7)=1, demand(10)=1, demand(11)=0`.

> The brief's literal "largest max_qty with unit_price ≤ p\*" is inverted (it
> charges 3 units at $10 = $30 to a $15-authorized buyer). This demand-curve
> reading is the economically correct one; the economic lens confirmed it and
> confirmed `worst_case` bounds every reachable leg. Flagged in §10.1.

### 4.2 Worst-case spend

`worst_case(schedule) = max over entries of (unit_price · demand(schedule,
unit_price))`, checked arithmetic. For `[(5,3),(10,1)]`: max(15,10)=15. Bounded
above by `MAX_UNIT_PRICE · MAX_QTY` (§8), and `MAX_POOL_MEMBERS · MAX_UNIT_PRICE
· MAX_QTY` is chosen to fit i128 — so no per-child or pool-level clearing sum can
overflow (removes the whole checked-overflow-DoS class the review found).

### 4.3 Eligibility filter (deterministic, now includes ability-to-pay) — D-B

`pool.rs` builds each `ChildView.eligible` from objective on-chain state at clear
time:

```
eligible = pool_state == Committed
        && status == Active
        && now < expiry
        && min( allowance(user → contract, asset), balance(user, asset) ) >= worst_case(schedule)
```

Allowance and balance are live SEP-41 reads (`TokenClient::allowance`,
`TokenClient::balance`). `simulate_clear` performs the identical reads in the same
ledger, so the eligible set — and therefore the outcome — is bit-identical
between simulate and capture (§4.6). Using `worst_case` (not the p\*-dependent
leg) keeps the filter free of fixed-point circularity: eligibility is decided
once, before p\* is known.

### 4.4 Clearing algorithm (ThresholdFloor)

Pure `clear(pool, children: Vec<ChildView>, now) -> ClearOutcome`:

1. Keep only `children[i].eligible`. (Ineligible = expired, revoked, released, or
   can't-pay — all excluded before any math.)
2. Order the eligible set by `mandate_id` ascending (fixed content-independent
   tie-break; n ≤ 8, insertion sort in no_std).
3. **Candidate prices** = ascending, deduplicated union of every eligible child's
   schedule breakpoints, PLUS, for each breakpoint `b` where `Q(b) ≥
   threshold_qty`, the derived candidate `p' = ceil(threshold_value_gross /
   Q(b))` when `prev_breakpoint < p' ≤ b` (demand is constant on that interval,
   so `Q(p') = Q(b)`). The derived candidates make p\* the *true minimal feasible
   uniform price* instead of an artifact of posted breakpoints (fixes the
   overcharge + the 1-unit-sybil-shaving the review found). `threshold_value_gross`
   here is the gross value whose net equals `threshold_value` (§4.5).
4. **Pick p\*** = the lowest candidate `p` with `Q(p) = Σ demand_i(p) ≥
   threshold_qty` AND `net_value(p) ≥ threshold_value`, where
   `net_value(p) = p·Q(p) − floor_fee_total(p)` (§4.5). If a candidate's `p·Q(p)`
   would exceed i128 (impossible under §8 caps, but asserted), that candidate is
   treated as infeasible, never an error. No feasible candidate → `fires = false`.
5. **Allocations** `alloc_i = demand_i(p*)`; include only `alloc_i > 0`, already
   in mandate_id order.

### 4.5 Fee semantics (pinned, net-threshold) — resolves the merchant-shortfall + rate-front-run findings

- The pool pins `fee_bps_pinned = FeeRateBps` at `register_pool`. Capture uses the
  pinned rate, never the live rate — an admin raising `FeeRateBps` after members
  commit cannot reprice a pool. (Solo `execute_payment` still uses the live rate;
  its payer authorized `amount` and the fee is skimmed within that, unchanged.)
- Per leg: `leg = alloc_i · p*` (checked, cannot overflow under §8);
  `fee_i = leg · fee_bps_pinned / BPS_DENOM` floored; merchant gets `leg − fee_i`,
  recipient gets `fee_i`. The two legs sum exactly to `leg` (floor rounding, no
  dust, contract holds nothing).
- `threshold_value` is compared **net-of-fee**: the firing predicate uses
  `net_value(p*) = Σ(leg_i − fee_i) ≥ threshold_value`, so the merchant's stated
  minimum is what the merchant actually nets. (v1 compared gross, letting the
  pool fire while the vendor received up to 1% below its floor.)

### 4.6 No-discretion equality (scoped) + allocation root

`simulate_clear(pool_id)` and `clear_pool(pool_id)` build the identical
`Vec<ChildView>` from the same ledger state (same `now`, same live
allowance/balance reads) and call the identical `clear()`. The equality is
therefore *same-ledger*: a third party recomputing `simulate_clear` in the
clearing ledger gets bit-identical output to what capture used. The §9
no-discretion test runs both in one test tx.

`allocation_root = sha256( pool_id || p*_i128_BE16 || Σ (mandate_id_32 ||
qty_u128_BE16) )` over allocations in mandate_id order, via `env.crypto().sha256`
on a `soroban_sdk::Bytes` built with `to_be_bytes`. `pool_id` is prefixed so
roots are not comparable across pools. Emitted in `pool_cleared`.

## 5. Lifecycle & entry points

### 5.1 Full contract surface

```rust
// deploy
__constructor(env, admin: Address)                       // stores Admin atomically at deploy — D-C

// existing (extended where noted)
register_mandate(env, user, agent, merchant, asset, max_amount, expiry, vc_hash,
                 pool_id: Option<BytesN<32>>, price_schedule: Vec<(i128,u128)>) -> Result<BytesN<32>, Error>
validate_mandate(env, mandate_id, amount, merchant) -> Result<(), Error>   // + Paused + MandatePooled (§5.9)
execute_payment(env, mandate_id, amount, expected_seq) -> Result<(), Error> // + pause guard, fee legs, pooled-active rejection
revoke_mandate(env, mandate_id) -> Result<(), Error>                        // + terminal release bookkeeping
get_mandate(env, mandate_id) -> Result<Mandate, Error>                      // returns 3 new fields

// admin + fee (admin.rs)
set_admin(env, new_admin: Address) -> Result<(), Error>  // require_auth(current admin)
pause(env) -> Result<(), Error>                          // require_auth(admin)
unpause(env) -> Result<(), Error>                        // require_auth(admin)
is_paused(env) -> bool
set_fee_rate(env, bps: u32) -> Result<(), Error>         // admin; > MAX_FEE_BPS → FeeTooHigh
set_fee_recipient(env, recipient: Address) -> Result<(), Error> // admin
get_fee_rate(env) -> u32
get_fee_recipient(env) -> Option<Address>

// composites (pool.rs)
register_pool(env, originator, merchant, asset, kind, threshold_qty, threshold_value,
              min_child_value, clearing_deadline, nonce: BytesN<32>) -> Result<BytesN<32>, Error>
commit_child(env, mandate_id) -> Result<(), Error>       // permissionless; objective checks (§5.4)
evict_child(env, pool_id, mandate_id) -> Result<(), Error> // permissionless; only removes objectively-ineligible members (§5.5)
clear_pool(env, pool_id) -> Result<(), Error>            // anyone; valid only at now >= deadline (§5.6)
simulate_clear(env, pool_id) -> Result<ClearOutcome, Error> // read-only, == clear_pool math (§4.6)
get_pool(env, pool_id) -> Result<ClearingPool, Error>
get_pool_members(env, pool_id) -> Result<Vec<BytesN<32>>, Error>
```

### 5.2 Pause guards

Paused blocks money movement only: the **capture branch** of `clear_pool` and
`execute_payment`. Deliberately NOT paused: `revoke_mandate` (consent withdrawal
must always work), `register_mandate`, `register_pool`, `commit_child`,
`evict_child`, the **abort branch** of `clear_pool` (a pure state flip + event,
no transfers — so a past-deadline pool can still reach Aborted while paused; fixes
the v1 zombie-pool-while-paused finding), and all read-onlys.

### 5.3 register_pool

`require_auth(originator)`. `pool_id = sha256(originator || merchant || asset ||
kind || threshold_qty || threshold_value || min_child_value || clearing_deadline
|| nonce)` — derived in-contract so the id commits to the terms (front-running the
id with different terms is impossible; the `nonce` lets an originator make
distinct pools with identical terms). Validations: derived id unused
(`AlreadyExists`); `now < clearing_deadline` (`DeadlinePassed`);
`clearing_deadline + CAPTURE_WINDOW - now <= MAX_POOL_HORIZON` (`DeadlineTooFar`);
`kind == ThresholdFloor` (`KindNotSupported`); `threshold_qty > 0 ||
threshold_value > 0` (`InvalidAmount`). Pins `fee_bps_pinned = FeeRateBps`.
Initializes status Open, member_count 0, empty member list. Bumps TTL (§3.6).
Emits `pool_reg`.

### 5.4 commit_child (permissionless) + child registration

**Registration** with `pool_id = Some(id)`: pool exists (`PoolNotFound`), Open
(`PoolNotOpen`), `now < clearing_deadline` (`DeadlinePassed`); `merchant ==
pool.merchant` (`PoolMerchantMismatch`); `asset == pool.asset`
(`PoolAssetMismatch`); schedule valid per §4.1 with `worst_case ≤ max_amount`;
**`expiry > clearing_deadline + CAPTURE_WINDOW`** (`ExpiryBeforeDeadline`) so no
committed child can expire inside the capture window (kills the wait-for-expiry
timing lever, D-A); `worst_case ≥ pool.min_child_value` (`BelowMinChild`,
anti-dust); `pool_state` starts `Unlinked`. With `pool_id = None`: schedule must
be empty (`ScheduleInvalid`).

**`commit_child(mandate_id)`** — permissionless (every check is objective on-chain
state; the user authorized the terms + the pool binding at registration, and the
commit is revocable until the deadline). Checks: mandate exists (`NotFound`);
`pool_id.is_some()` else `NotPooled`; not Revoked (`MandateRevoked`) / not expired
(`MandateExpired`); pool Open (`PoolNotOpen`); `now < clearing_deadline`
(`DeadlinePassed`); `pool_state == Unlinked` (`BadPoolState`); `member_count <
MAX_POOL_MEMBERS` (`PoolFull`); one live check that `min(allowance, balance) ≥
worst_case` as a courtesy preflight (`InsufficientFunds`) — **not** a reservation
(see §5.5). Effects: `pool_state = Committed`, push to member list,
`member_count += 1`, bump TTL. Emits `child_com`.

> **Self-sybil dedup:** a user may hold at most one Committed child per pool. If
> the committing mandate's `user` already owns a Committed member of this pool,
> `DuplicateMember`. This stops one allowance being double-counted toward the
> threshold by one actor (the review's demand-inflation finding). Cross-pool
> double-commit by one user is handled at capture by the ability-to-pay filter
> (§4.3): whichever pool clears first consumes the allowance; the other simply
> excludes that child deterministically.

### 5.5 Allowance is NOT reserved (honest rationale) + evict_child

The commit-time fund check is a **preflight, not a hold** — SEP-41 allowance is a
single fungible `(user, contract, asset)` value the user can reduce, re-use across
mandates/pools, or under-fund by moving balance. The correctness guarantee comes
entirely from the **capture-time ability-to-pay eligibility filter** (§4.3, D-B),
not from commit. `MandatePooled` blocks the solo path of a *Committed/Captured*
child only to stop that child double-spending its own allowance against the pool;
it is not a claim that anything is reserved.

`evict_child(pool_id, mandate_id)` — permissionless, removes a member from the
list and sets its `pool_state = Released` **only if** it is objectively
ineligible right now (`now >= expiry`, or `status != Active`, or `min(allowance,
balance) < worst_case`). Purely a garbage-collection convenience so squatters and
pulled-allowance members free their slot before the deadline; it can never evict a
still-payable member (`MemberStillEligible`). Emits `child_rel`. (Eviction is not
required for correctness — the clearing filter already excludes ineligible members
— but it reclaims the scarce `MAX_POOL_MEMBERS` slots that dust/pull attacks would
otherwise hold, §8.)

### 5.6 clear_pool — deadline auction (D-A) + best-effort capture (D-B)

Callable by anyone, no auth (pure function of stored + live-token state; caller
pays gas). **Valid only at `now >= clearing_deadline`**; earlier →
`DeadlineNotReached`. Pool must be Open (`PoolNotOpen` — doubles as the
double-clear/idempotency guard). Beyond `clearing_deadline + CAPTURE_WINDOW` only
the abort branch is reachable (`fires` forced false) so a met-but-never-cleared
pool cannot be captured months later against unwatching participants.

1. Build `Vec<ChildView>` from members (live allowance/balance reads → `eligible`,
   §4.3). Compute `outcome = clear(pool, views, now)` (§4.4).
2. **fires == true** (within the capture window): **persist all state before any
   transfer** (CEI, matching payment.rs): set `pool.status = Cleared`; for each
   allocation set child `spent += leg` (asserted ≤ max_amount), `seq += 1`,
   `pool_state = Captured`, `status = Exhausted` iff `spent == max_amount`; set
   every *committed-but-not-allocated* child (eligible with `demand=0`, or
   excluded) to `pool_state = Released`. THEN, for each allocation in mandate_id
   order, do the transfer legs (`leg − fee_i` → merchant, `fee_i` → recipient when
   `fee_i > 0`). Any transfer failure reverts the whole tx (Soroban all-or-nothing
   over the *fired set*); because ineligible members were already filtered out,
   the only way a leg fails now is a same-ledger race, and the revert simply
   leaves the pool Open for a retry within the window. Emit one `pool_clr`
   (`clearing_price, allocation_root, net_value, total_fee`) after the loop.
3. **fires == false** (predicate not met, or past capture window): `pool.status =
   Aborted`; set every Committed child `pool_state = Released`; emit `pool_abrt`.
   No transfers. (Allowed while paused, §5.2.)

Reentrancy: state is persisted before the first external call, and the
`PoolNotOpen` guard trips the instant `status = Cleared` is written, so a
re-entrant `clear_pool` during a transfer callback (malicious asset or
fee_recipient contract) finds the pool already Cleared. This is CEI, not merely
Soroban's host-level no-reentrancy rule — the §9 reentry probe asserts it with an
evil asset AND an evil fee_recipient.

### 5.7 revoke_mandate (extended)

Unchanged for standalone. Always allowed, even while paused. For a pooled child:
mark Revoked; if `pool_state == Committed` and pool Open, remove from member list,
`member_count -= 1`, set `pool_state = Released`, bump TTL, emit `child_rel`
alongside `mandate_revoked`. If already Captured (pool Cleared) the purchase is
final; revoke still marks Revoked (retroactively blocks nothing). No arithmetic on
dropped aggregates (they no longer exist) → the v1 underflow-panic-blocks-revoke
finding is gone.

### 5.8 execute_payment (extended, standalone path)

Order: pause guard (`Paused`) → load → `require_auth(agent)` → reject if
`pool_state ∈ {Committed, Captured}` (`MandatePooled`; `Unlinked`/`Released`
pooled children may spend solo within their own signed limits, D-D) → seq/replay
guard → `check()` (unchanged) → advance spent/seq → fee split at the **live** rate
(`fee = amount · FeeRateBps / BPS_DENOM` floored; `amount − fee` → merchant,
`fee` → recipient when `fee > 0` and recipient set; if rate `> 0` and recipient
unset, `FeeRecipientNotSet`). At rate 0: single transfer, exact amount,
byte-identical stored state to today. `spent` counts full `amount`
(merchant-nets-less). Event `payment` data → `(mandate_id, amount, fee)`.

### 5.9 validate_mandate (extended — no longer lies)

Now returns `Paused` when the contract is paused, and `MandatePooled` when
`pool_state ∈ {Committed, Captured}` — both objective stored state, still
read-only, mutates nothing. So the SDK preflight agrees with what
`execute_payment` will actually do. (v1 left this "unchanged," so a pooled/paused
mandate passed preflight then failed the spend.)

## 6. Errors (codes 1–9 unchanged, slot 3 reserved)

```
1 AlreadyExists      2 NotFound            4 MandateExpired      5 MandateRevoked
6 BudgetExceeded     7 MerchantOutOfScope  8 BadSequence         9 InvalidAmount
10 Paused            11 PoolNotFound       12 PoolNotOpen        13 ScheduleInvalid
14 PoolMerchantMismatch 15 PoolAssetMismatch 16 DeadlinePassed   17 ThresholdNotMet
18 PoolFull          19 BadPoolState       20 MandatePooled      21 InsufficientFunds
22 KindNotSupported  23 FeeTooHigh         24 FeeRecipientNotSet 25 NotPooled
26 ExpiryBeforeDeadline 27 BelowMinChild   28 DuplicateMember    29 DeadlineNotReached
30 DeadlineTooFar    31 MemberStillEligible
```

Removed vs v1: `Overflow` (unreachable under §8 caps — any residual is asserted,
not a user-facing code). Per-entry-point precondition→error mapping is inline in
§5 (every check names its code) so the exact-typed-error test convention has no
gaps.

## 7. Events (topics ≤ 9 chars — symbol_short! legal; full tuples pinned)

Existing: `register` (topic `("register", user)`, data `mandate_id`) unchanged;
`revoke` (topic `("revoke",)`, data `mandate_id`) unchanged; `payment` (topic
`("payment", merchant)`, data **`(mandate_id, amount, fee)`** — fee field added).

New:
```
admin_set  topic ("admin_set",)            data new_admin
paused     topic ("paused",)               data ()            // ledger seq implicit
unpaused   topic ("unpaused",)             data ()
fee_rate   topic ("fee_rate",)             data new_bps
fee_rcpt   topic ("fee_rcpt",)             data new_recipient
pool_reg   topic ("pool_reg", originator)  data (pool_id, merchant, asset, threshold_qty, threshold_value, clearing_deadline)
child_com  topic ("child_com", pool_id)    data (mandate_id, worst_case)
child_rel  topic ("child_rel", pool_id)    data mandate_id
pool_clr   topic ("pool_clr", pool_id)     data (clearing_price, allocation_root, net_value, total_fee)
pool_abrt  topic ("pool_abrt", pool_id)    data ()
```

## 8. Constants

```
MAX_FEE_BPS       = 100          // 1% hard cap
BPS_DENOM         = 10_000
MAX_POOL_MEMBERS  = 8            // Stage-1 single-tx capture ceiling — BUILD-TIME VERIFIED (§9.5), not assumed
MAX_SCHEDULE_POINTS = 8
MAX_UNIT_PRICE    = 1e15 (as i128)   // caps so MAX_POOL_MEMBERS · MAX_UNIT_PRICE · MAX_QTY < i128::MAX
MAX_QTY           = 1e9  (as u128)   //   → no clearing sum can overflow; the Overflow error is designed out
CAPTURE_WINDOW    = 17_280 ledgers (~1 day)  // [deadline, deadline+window] is the only capture interval
MAX_POOL_HORIZON  = TTL_EXTEND (~30 days)    // deadline+window must fit one TTL bump
TTL constants unchanged
```

`MAX_POOL_MEMBERS = 8` is the single most safety-relevant constant: the platform
lens showed 32 blows past Soroban's per-tx write-entry (~25 launch) and
event-size (~8 KB) budgets — a pool that big could be built but never cleared.
8 is the conservative starting cap; §9.5 requires a test that actually constructs
a full 8-member pool (fee on, max schedule points) and asserts the capture fits
the budget before the constant is trusted or raised.

## 9. Test plan (all must ship)

### 9.1 Existing suite stays green
The 19 tests + snapshots + `reentry_probe`, with `register_mandate` call sites
updated to `(…, None, vec![])`. `payment_executed`/`get_mandate` snapshot shapes
regenerated (see §9.4).

### 9.2 Admin/pause/fee
constructor sets admin; contract cannot be registered without an admin arg;
`set_admin` rotates (old loses, new gains); non-admin pause/set_fee_* → host-auth
revert; pause blocks execute_payment (Paused) and the **capture** branch of
clear_pool (Paused); pause does NOT block the **abort** branch (past-deadline
unmet pool aborts while paused); unpause restores capture; revoke works while
paused; register/commit work while paused; `set_fee_rate > MAX_FEE_BPS` →
FeeTooHigh; `set_fee_rate > 0` then payment with recipient unset →
FeeRecipientNotSet; rate 0 → single transfer exact amount, snapshot byte-identical
to pre-fee stored state; rate > 0 solo → merchant `amount−fee`, recipient `fee`,
sum reconciles, spent = full amount, over-budget-with-fee still rejected;
**fee pinned**: raise `FeeRateBps` after commits → clear_pool still uses
`fee_bps_pinned`, asserted.

### 9.3 Composites — adversarial core
- register_pool: happy; duplicate derived id → AlreadyExists; past deadline →
  DeadlinePassed; deadline beyond horizon → DeadlineTooFar; ceiling kinds →
  KindNotSupported; id commits to terms (same nonce+different terms → different id).
- child registration: merchant/asset mismatch; non-monotone price / non-descending
  qty / empty-with-pool / schedule-with-None / too-long / worst_case>max_amount →
  ScheduleInvalid; expiry ≤ deadline+window → ExpiryBeforeDeadline; worst_case <
  min_child_value → BelowMinChild; nonexistent pool → PoolNotFound.
- commit: happy; commit on standalone → NotPooled; second commit same user →
  DuplicateMember; below-funds preflight → InsufficientFunds; double-commit →
  BadPoolState; after deadline → DeadlinePassed; 9th member → PoolFull.
- evict: evict expired/revoked/pulled-allowance member → Released + slot freed;
  evict still-payable member → MemberStillEligible.
- solo/pool exclusion: execute_payment on Committed/Captured child → MandatePooled;
  on Unlinked/Released pooled child → succeeds within its own limits.
- timing (D-A): clear_pool before deadline (even when feasible) →
  DeadlineNotReached; clear at deadline fires; clear after `deadline+CAPTURE_WINDOW`
  → Aborted even though threshold was met (window-expiry).
- clearing math: under-threshold at deadline → Aborted, zero transfers; fires at
  exact threshold boundary; **uniform price** — every cleared child pays exactly
  p\* per unit incl. higher-top-tier children; derived-candidate p\* equals the true
  minimal feasible price (single child [(10,10)], threshold_qty 10 threshold_value
  60 → p\*=6 not 10; a 1-unit sybil tier cannot move it); demand-curve example
  [(5,3),(10,1)] → 3 at p\*≤5, 1 at 5<p\*≤10; value-threshold-binding case (low p
  fails net-value, higher p clears); net-of-fee threshold (fee>0 → pool needs
  higher gross to clear, merchant nets ≥ threshold_value).
- ability-to-pay (D-B): committed child zeroes allowance before deadline →
  excluded at clear; pool fires without it if able set still ≥ threshold; aborts if
  not; child drains balance (allowance intact) → excluded; one user two pools one
  allowance → first clear fires, second excludes that child deterministically
  (not a brick).
- exclusion bookkeeping: expired-at-clear committed child → Released not Captured;
  revoked committed child → excluded AND slot freed; committed child with demand 0
  at p\* → Released not charged.
- atomicity/idempotency: same-ledger allowance race on a fired leg → whole capture
  reverts, pool still Open, no sibling charged, retry within window succeeds;
  double-clear → PoolNotOpen; clear on Aborted → PoolNotOpen.
- no-discretion: simulate_clear output == the allocation clear_pool executes
  (assert price + allocations + per-child transfer amounts), run in one ledger;
  allocation_root recomputes from simulate output (incl. pool_id prefix).
- order independence: same children committed in different orders → identical
  ClearOutcome.
- terminal exit (D-D): pool Aborted → child is Released and can spend solo within
  limits, and can be revoked/inspected cleanly; Cleared-with-zero-alloc child →
  Released, can spend solo; Captured child with spent < max_amount stays Active
  with usable remainder solo (still MandatePooled? — NO: Captured blocks solo;
  assert the leftover is intentionally locked to the pool and document).
- squatting: dust below min_child_value rejected; fill 8 slots then evict an
  ineligible squatter to admit a real member.

### 9.4 Backward-compat / migration (loudly flagged)
Consumer-visible shape changes vs the deployed contract, each asserted:
`register_mandate` gains 2 params; `Mandate`/`get_mandate` gains 3 fields;
`payment` event data gains `fee`; 10 new events; new error codes. A test asserts
the exact `payment` tuple at rate 0 (`fee == 0`) and rate > 0. `test_snapshots/`
regenerated. Doc note: `npm run gatecheck`, the demo, and any indexer must handle the
new `payment` arity — this is the same class of break as the ABI change and is
flagged as such (not "byte-identical"; the *transfer legs and stored money state*
are byte-identical at rate 0, the *event* is not).

### 9.5 Resource ceiling (build-time verified)
A test constructs a full `MAX_POOL_MEMBERS`-member pool with fee enabled and
`MAX_SCHEDULE_POINTS` schedules, clears it, and asserts success within the Soroban
test budget (`env.budget()` cost assertion). A companion note requires a testnet
`simulateTransaction` resource report checked into `security/` before the cap is
raised. Until that artifact exists, `MAX_POOL_MEMBERS` stays at 8.

## 10. Judgment calls flagged for review (decided)

1. **Demand-curve correction** (§4.1) — deviation from the brief's literal
   allocation rule (which overcharges); confirmed correct by the economic lens.
2. **Deadline auction, not race** (D-A, §5.6) — clear only at/after deadline; the
   brief's "clear anytime feasible" reading is the timing-option hole and is
   rejected. This changes "fires the instant it's full" to "fires at close."
3. **Best-effort over able set, not all-or-nothing over committed set** (D-B) —
   the only griefing-resistant capture; changes the pitch to "the cleared set
   settles atomically." Merchant's aggregate-≥-threshold guarantee is preserved.
4. **Constructor, not init_admin** (D-C).
5. **Terminal release** (D-D) — `Released`/`Unlinked` pooled children may spend
   solo; `Committed`/`Captured` may not.
6. **Fee pinned at register_pool + net-of-fee threshold** (§4.5).
7. `set_admin` kept (rotatability); ceiling kinds reserved but rejected;
   `member_root` dropped; aggregates dropped; `evict_child` added; self-sybil
   dedup per pool; pool_id derived from terms.
8. **Captured child leftover budget is locked to the pool** (stays `MandatePooled`)
   — a Captured child does not re-open the solo path even with `spent <
   max_amount`; simplest safe rule, documented (§9.3 terminal-exit test).
9. Thresholds/qty u128, money i128, checked casts at the boundary; §8 caps make
   every clearing sum provably non-overflowing so `Overflow` is designed out.
10. **Stage-2 note:** `mandate_id` is the caller-chosen `vc_hash` and thus
    grindable. Harmless in Stage 1 (no rationing — allocation is `demand_i(p*)`
    for all). Stage 2's ceiling kinds must NOT use id-order greedy rationing
    (grindable priority auction); use commit-order or pro-rata. Recorded now
    because the id scheme is locked in this rebuild.

## 11. Change log (v1 → v2), keyed to review findings

| # | v1 problem (severity) | v2 resolution |
|---|---|---|
| C1 | clear-timing unpriced option (critical ×3) | D-A deadline auction (§5.6); expiry > deadline+window (§5.4) |
| C2 | commit ≠ reservation; zero-cost sybil brick / liveness grief (critical ×3) | D-B ability-to-pay filter (§4.3); best-effort capture; evict_child (§5.5); self-sybil dedup (§5.4) |
| C3 | MAX_POOL_MEMBERS=32 unclearable (critical) | cap 8, build-time verified (§8, §9.5) |
| H1 | init_admin front-run (high ×3) | __constructor (D-C, §5.1) |
| H2 | terminal states strand children / burn vc_hash (high ×3) | D-D Released exit (§5.6–5.8) |
| H3 | fee gross → merchant below floor; rate front-run (high) | net-of-fee threshold + fee pinned at register (§4.5) |
| H4 | validate_mandate lies (high) | extended to Paused/MandatePooled (§5.9) |
| H5 | advisory aggregates checked-overflow DoS + incoherent (high/med) | aggregates dropped (§3.2) |
| M1 | p* overcharge / sybil-shaving (med) | derived candidates = true minimal price (§4.4) |
| M2 | PoolFull dust squatting (med) | min_child_value floor + evict_child (§5.4–5.5) |
| M3 | event names > 9 chars (med) | topics pinned ≤ 9 chars (§7) |
| M4 | pool/member TTL unspecified (med) | TTL policy + horizon cap (§3.6, §5.3) |
| M5 | clearing-scan overflow semantics (med) | §8 caps make sums non-overflowing; infeasible-not-error (§4.4) |
| M6 | CEI inverted in capture (med) | state persisted before transfers (§5.6) |
| M7 | error-code mapping gaps; NotPooled (med) | inline per-check codes (§5), NotPooled added (§6) |
| M8 | byte-identical claim false (med) | §9.4 migration callout; claim corrected |
| M9 | 8 event payloads unspecified (med) | full tuples pinned (§7) |
| L* | pool_id squatting, grindable id, abort-while-paused, spec polish | pool_id from terms (§5.3), Stage-2 note (§10.10), abort allowed while paused (§5.2), signatures/ordering fixed |
```
