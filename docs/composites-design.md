# MandateRegistry v2 — Composite Mandates (Stage 1) + Admin/Pause + Fee Knob

**Status:** DESIGN — ground truth for the rebuild. Source of truth is the
Composite Mandates brief (D4 admin+pause, D5 composites Stage 1). The fee knob
is included by explicit request (design settled in earlier planning: zero-rate,
non-custodial, no withdraw). Where any older planning text conflicts with the
brief, the brief wins. Deploy/redeploy is OUT of scope for this pass — contract
code + tests only.

---

## 1. Scope

**In:** ClearingPool + composite Stage 1 (ThresholdFloor group buys, atomic
capture), admin + pause/unpause, zero-rate protocol fee knob. Full adversarial
test suite. Backward-compatible behavior for standalone mandates (a mandate
with no pool is byte-identical to today, modulo the fee legs at rate 0 which
are byte-identical by construction).

**Out:** Stage 2 (SpendCeiling/CapacityCeiling clearing, pull settlement, AP2
hash alignment), Stage 3 (discovery/matching, x402/ACP bridge), deploy scripts,
SDK bindings, CLI. The `ClearingKind` enum ships with all three variants for
ABI stability, but `register_pool` rejects non-ThresholdFloor kinds with
`KindNotSupported` in Stage 1.

## 2. Module map (dependencies flow one way, no cycles)

```
lib → {registry, payment, admin, pool} → storage → {mandate, pooltypes, error}
                └──────────┴──────┴────→ events (leaf)
pool → clearing (pure; depends only on mandate/pooltypes/error — NO storage, NO env I/O beyond types)
```

- `lib.rs` — thin dispatch only, no logic.
- `mandate.rs` — `Mandate` type + `Status` + `PoolState` + schedule validation helpers (pure).
- `pooltypes.rs` — `ClearingPool`, `ClearingKind`, `PoolStatus`, `ClearOutcome` (pure data).
- `clearing.rs` — the pure clearing function. The trust core. No storage access;
  takes the pool + a Vec of child mandates, returns `ClearOutcome`. `clear_pool`
  and `simulate_clear` both call exactly this function — that equality IS the
  no-discretion guarantee.
- `pool.rs` — pool lifecycle: `register_pool`, `commit_child`, `clear_pool`,
  `simulate_clear`, `get_pool`. Owns the capture (transfer legs).
- `admin.rs` — `init_admin`, `set_admin`, `pause`, `unpause`, `is_paused`,
  `set_fee_rate`, `set_fee_recipient`, `get_fee_rate`, `get_fee_recipient`.
- `registry.rs` — register/revoke (extended for pool linkage).
- `payment.rs` — solo money path (extended: pause guard, fee legs, pooled-mandate rejection).
- `storage.rs` — the ONLY module touching `env.storage` (unchanged rule).
- `error.rs`, `events.rs` — leaves.

## 3. Data model

### 3.1 Mandate (extended — 3 new fields, everything else unchanged)

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
`price_schedule: Vec<(i128, u128)>`. This is an ABI change; fine — the rebuild
redeploys under a new contract id and bindings regenerate. Standalone callers
pass `(None, vec![])` and get exactly today's behavior.

### 3.2 ClearingPool (new, `pooltypes.rs`)

```rust
pub struct ClearingPool {
    pub originator: Address,
    pub merchant: Address,
    pub asset: Address,
    pub kind: ClearingKind,        // ThresholdFloor | SpendCeiling | CapacityCeiling
    pub threshold_qty: u128,
    pub threshold_value: u128,
    pub aggregate_qty: u128,       // advisory running sums (see 5.4); clearing recomputes
    pub aggregate_value: u128,
    pub clearing_deadline: u64,    // ledger timestamp (seconds)
    pub status: PoolStatus,        // Open | Cleared | Aborted
    pub member_count: u32,
}
```

Member list stored separately: `DataKey::PoolMembers(pool_id) → Vec<BytesN<32>>`
(mandate ids, commit order). Pool capped at `MAX_POOL_MEMBERS = 32` (Stage 1
single-tx ceiling; to be measured on testnet, constant documented as such).
The brief's optional `member_root` Merkle field is dropped for Stage 1: the
member list is small, stored directly, and readable on-chain — a Merkle root
adds nothing until pools outgrow direct storage (Stage 2 pull settlement).

### 3.3 ClearOutcome (returned by `simulate_clear`, computed inside `clear_pool`)

```rust
pub struct ClearOutcome {
    pub fires: bool,
    pub clearing_price: i128,                  // 0 when !fires
    pub allocations: Vec<(BytesN<32>, u128)>,  // (mandate_id, qty), sorted by mandate_id; only qty > 0
    pub total_qty: u128,
    pub total_value: i128,                     // clearing_price * total_qty
}
```

### 3.4 Config storage (instance storage)

`Admin: Address`, `Paused: bool` (default false), `FeeRateBps: u32` (default 0),
`FeeRecipient: Address` (absent until set). Instance storage + instance TTL
bump on write — config is tiny and lives/dies with the contract.

## 4. The clearing function (trust core)

### 4.1 Schedule semantics — CORRECTED from the brief (flagged deviation)

A `price_schedule` entry `(unit_price, max_qty)` means: **"at a uniform
clearing price ≤ unit_price, I authorize buying up to max_qty units."**
It is a demand curve: quantity falls as price rises.

Validation at `register_mandate` (rejects with `ScheduleInvalid`):
- non-empty, `len ≤ MAX_SCHEDULE_POINTS = 8`
- `unit_price` strictly ascending, all `> 0`
- `max_qty` strictly descending, all `> 0` (a later entry offering ≥ qty at a
  higher price is dominated/ambiguous — reject at the source)
- worst-case spend (see 4.2) must not overflow and must be `≤ max_amount`
  (defense in depth: the pool can never breach the child's hard ceiling)

**Demand function:** `demand(schedule, p) = max_qty of the FIRST entry (lowest
price) with unit_price ≥ p; 0 if p exceeds every entry's price.`

Worked example `[(5, 3), (10, 1)]` ("3 at $5, or 1 at $10"):
`demand(5)=3, demand(7)=1, demand(10)=1, demand(11)=0`.

> **Deviation note:** the brief says allocation = "largest max_qty with
> unit_price ≤ p\*". That rule is inverted: at p\*=10 it allocates 3 units at
> $10 = $30 to a buyer who authorized at most $15. The rule above is the
> economically correct reading of the same schedule and preserves every claim
> the brief makes (uniform price, no discretion, determinism).

### 4.2 Worst-case spend (used for allowance + max_amount checks)

`worst_case(schedule) = max over entries of (unit_price * demand(schedule, unit_price))`
— i.e. evaluate the actual spend at every breakpoint, take the max, all with
checked arithmetic (`Overflow` on failure). For `[(5,3),(10,1)]`: max(15, 10) = 15.

### 4.3 Clearing algorithm (ThresholdFloor)

Pure function `clear(pool, children) -> ClearOutcome`:

1. **Eligibility filter (deterministic):** keep children with
   `pool_state == Committed && status == Active && now < expiry`. (Revoked,
   expired, and released children are excluded before any math.)
2. **Order** eligible children by `mandate_id` ascending (byte order) — the
   fixed, content-independent single tie-break. (Members are stored in commit
   order; clearing sorts. n ≤ 32, insertion sort is fine in no_std.)
3. **Candidate prices:** the ascending, deduplicated union of every eligible
   child's schedule breakpoints.
4. **Pick p\*:** the lowest candidate `p` such that
   `total_qty(p) = Σ demand_i(p) ≥ threshold_qty` AND
   `p * total_qty(p) ≥ threshold_value` (checked math; comparisons against the
   u128 thresholds after a checked non-negative cast). Ties impossible by
   construction (first feasible in a strict ascending scan). If no candidate
   is feasible → `fires = false`.
5. **Allocations at p\*:** `alloc_i = demand_i(p*)`; include only `alloc_i > 0`,
   already in mandate_id order. No discretion remains anywhere.

`simulate_clear(pool_id)` (read-only) and `clear_pool(pool_id)` both compute
this exact function over the same stored state — a third party recomputing
`simulate_clear` gets bit-identical output to what capture used.

### 4.4 Allocation root (event payload)

`allocation_root = sha256( p*_as_16B_BE || (mandate_id_0 || qty_0_as_16B_BE) || … )`
over allocations in mandate_id order, via `env.crypto().sha256`. Emitted in
`pool_cleared` so the chosen allocation is publicly reviewable against the
recomputation.

## 5. Lifecycle & entry points

### 5.1 Full contract surface (lib.rs)

```rust
// existing (extended where noted)
register_mandate(env, user, agent, merchant, asset, max_amount, expiry, vc_hash,
                 pool_id: Option<BytesN<32>>, price_schedule: Vec<(i128, u128)>) -> Result<BytesN<32>, Error>
validate_mandate(env, mandate_id, amount, merchant) -> Result<(), Error>   // unchanged
execute_payment(env, mandate_id, amount, expected_seq) -> Result<(), Error> // + pause guard, fee legs, pooled-rejection
revoke_mandate(env, mandate_id) -> Result<(), Error>                        // + pool aggregate release
get_mandate(env, mandate_id) -> Result<Mandate, Error>                      // unchanged

// admin + fee (admin.rs)
init_admin(env, admin: Address) -> Result<(), Error>   // one-time; AlreadyExists on second call
set_admin(env, new_admin: Address) -> Result<(), Error> // require_auth(current admin); rotatable, one line
pause(env) -> Result<(), Error>                         // require_auth(admin)
unpause(env) -> Result<(), Error>                       // require_auth(admin)
is_paused(env) -> bool
set_fee_rate(env, bps: u32) -> Result<(), Error>        // admin; > MAX_FEE_BPS → FeeTooHigh; > 0 requires recipient set
set_fee_recipient(env, recipient: Address) -> Result<(), Error> // admin
get_fee_rate(env) -> u32
get_fee_recipient(env) -> Option<Address>

// composites (pool.rs)
register_pool(env, originator, merchant, asset, kind, threshold_qty,
              threshold_value, clearing_deadline, pool_id) -> Result<BytesN<32>, Error>
commit_child(env, mandate_id) -> Result<(), Error>      // permissionless (see 5.4)
clear_pool(env, pool_id) -> Result<(), Error>           // anyone; the capture
simulate_clear(env, pool_id) -> Result<ClearOutcome, Error> // read-only, == clear_pool's math
get_pool(env, pool_id) -> Result<ClearingPool, Error>
get_pool_members(env, pool_id) -> Result<Vec<BytesN<32>>, Error>
```

### 5.2 Pause guards (brief D4 wins over older Linear text)

Paused blocks **money paths only**: `execute_payment` and `clear_pool`.
Deliberately NOT paused: `revoke_mandate` (a user must always be able to
withdraw consent), `register_mandate`, `register_pool`, `commit_child`
(registering/committing moves no money; allowances are user-signed and
revocable), all read-onlys. Documented choice.

### 5.3 register_pool

`require_auth(originator)`. Validations: pool_id not already used
(`AlreadyExists`), `clearing_deadline > now` (`DeadlinePassed`),
`kind == ThresholdFloor` (`KindNotSupported`), `threshold_qty > 0 ||
threshold_value > 0` (`InvalidAmount`). Initializes aggregates 0, status Open,
member_count 0, empty member list. Emits `pool_registered`.

### 5.4 register_mandate (pool-linked path) + commit_child

Registration with `pool_id = Some(id)`: pool must exist, be Open, deadline not
passed; `merchant == pool.merchant` (`PoolMerchantMismatch`); `asset ==
pool.asset` (`PoolAssetMismatch`); schedule valid per 4.1 (`ScheduleInvalid`)
with `worst_case ≤ max_amount`; `pool_state` starts `Unlinked`.
With `pool_id = None`: schedule must be empty (`ScheduleInvalid` otherwise).

`commit_child(mandate_id)` — **permissionless**: every check is objective
on-chain state, the child's user already authorized the terms at registration,
and the commit stays revocable until clearing; requiring user auth would only
add a second signature for zero security. Checks: mandate exists & Active &
not expired; `pool_id` set; pool Open; `now < clearing_deadline`
(`DeadlinePassed`); `pool_state == Unlinked` (`BadPoolState`);
`member_count < MAX_POOL_MEMBERS` (`PoolFull`); SEP-41
`allowance(user → this contract) ≥ worst_case(schedule)`
(`InsufficientAllowance`). Effects: `pool_state = Committed`, member list push,
`aggregate_qty += schedule[0].max_qty` (demand at the lowest tier — the max
possible), `aggregate_value += worst_case` (checked). Emits `child_committed`.
Aggregates are advisory (UI/preflight); the clearing recomputes from schedules.

### 5.5 Solo path vs pool path — mutual exclusion

`execute_payment` on a mandate with `pool_id != None` fails with
`MandatePooled`. Rationale: the pool's allowance check at commit reserves the
child's allowance for capture; letting the solo path drain it concurrently
would make every commit-time guarantee false. A pooled mandate settles only
via `clear_pool`. (Standalone mandates are completely unaffected.)

### 5.6 clear_pool

Callable by anyone, no auth (the outcome is a pure function of stored state;
the caller only pays the gas). Pause guard first (`Paused`). Pool must exist
and be Open (`PoolNotOpen` — this doubles as the double-clear/idempotency
guard: Cleared and Aborted pools reject re-entry).

1. Load members, compute `outcome = clear(pool, children)` per §4.3.
2. `fires == true` (pre- or post-deadline — clearing early once the predicate
   holds is allowed per the brief): for each allocation in mandate_id order:
   - `leg = alloc_i * p*` (checked)
   - fee = `leg * fee_rate / 10_000` floored; `transfer_from(contract, user_i, merchant, leg - fee)`;
     if `fee > 0`, `transfer_from(contract, user_i, fee_recipient, fee)` — the
     two legs sum exactly to `leg`, contract never holds funds
   - child: `spent += leg` (checked; ≤ max_amount is guaranteed by worst-case
     validation at registration, still asserted), `seq += 1`,
     `pool_state = Captured`, status → Exhausted iff `spent == max_amount`
   - pool: status Cleared, aggregates set to the ACTUAL cleared totals,
     emits `pool_cleared(pool_id; clearing_price, allocation_root, total_value, total_fee)`
   Any `transfer_from` failure reverts the entire transaction (Soroban
   all-or-nothing) — pool stays Open, no participant charged.
3. `fires == false && now >= clearing_deadline`: status Aborted, emit
   `pool_aborted`, no transfers (allowances remain the user's to revoke).
4. `fires == false && now < clearing_deadline`: `Err(ThresholdNotMet)` — pool
   stays Open and can keep accepting commits.

### 5.7 revoke_mandate (extended)

Unchanged for standalone. For a pooled child: always allowed (even while
paused). If `pool_state == Committed` and pool still Open: subtract this
child's contribution from the advisory aggregates, remove from member list,
`member_count -= 1`, `pool_state = Released`, emit `child_released` alongside
`mandate_revoked`. If pool already Cleared (child Captured): the purchase is
final — revoke still marks the mandate Revoked (blocks nothing retroactively).

### 5.8 execute_payment (extended, standalone path)

Order: pause guard (`Paused`) → load → `require_auth(agent)` → `MandatePooled`
guard → seq/replay guard → `check()` (unchanged) → advance spent/seq → fee
split: `fee = amount * rate / 10_000` floored (checked mul), transfer
`amount - fee` to merchant, transfer `fee` to fee_recipient when `fee > 0`.
At rate 0 this is byte-identical to today (single transfer, exact amount).
`spent` counts the full `amount` (merchant-nets-less, Stripe-style — the
locked non-custody decision; the payer's budget semantics don't change).
Event `payment_executed` gains the fee: data `(mandate_id, amount, fee)`.

## 6. Errors (codes 1–9 unchanged, slot 3 stays reserved)

```
1 AlreadyExists      2 NotFound           4 MandateExpired     5 MandateRevoked
6 BudgetExceeded     7 MerchantOutOfScope 8 BadSequence        9 InvalidAmount
10 Paused            11 PoolNotFound      12 PoolNotOpen       13 ScheduleInvalid
14 PoolMerchantMismatch  15 PoolAssetMismatch  16 DeadlinePassed  17 ThresholdNotMet
18 PoolFull          19 BadPoolState      20 MandatePooled     21 InsufficientAllowance
22 Overflow          23 KindNotSupported  24 FeeTooHigh        25 FeeRecipientNotSet
```

(`ScheduleInvalid` covers the brief's `ScheduleNotMonotone` plus empty /
too-long / dominated-entry / worst-case-over-budget cases — one code, the
event of rejection is at registration where the caller has full context.)

## 7. Events

Existing: `mandate_registered`, `mandate_revoked` unchanged;
`payment_executed` data extended to `(mandate_id, amount, fee)`.
New: `admin_set`, `paused`, `unpaused`, `fee_rate_set`, `fee_recipient_set`,
`pool_registered`, `child_committed`, `child_released`,
`pool_cleared` (data: `clearing_price, allocation_root, total_value, total_fee`),
`pool_aborted`.

## 8. Constants

```
MAX_FEE_BPS = 100          // 1% hard cap — a rogue admin cannot set a confiscatory fee
BPS_DENOM   = 10_000
MAX_POOL_MEMBERS = 32      // Stage 1 single-tx ceiling; measure on testnet before raising
MAX_SCHEDULE_POINTS = 8
TTL constants unchanged
```

## 9. Test plan (all must ship in this pass)

**Existing 19 tests stay green** (call sites updated for the two new
`register_mandate` params: `None, vec![]`), plus `reentry_probe` unchanged.

**Admin/pause:** init_admin sets admin; second init_admin → AlreadyExists;
set_admin rotates (old admin loses, new admin gains); non-admin pause →
host-auth revert; pause blocks execute_payment (Paused); pause blocks
clear_pool (Paused); unpause restores both; revoke works while paused;
register_mandate + commit_child work while paused (documented choice).

**Fee:** default rate 0 → payment single-transfer, exact amount (byte-identical);
non-admin set_fee_rate/set_fee_recipient → host-auth revert; set_fee_rate >
MAX_FEE_BPS → FeeTooHigh; set_fee_rate > 0 with no recipient → FeeRecipientNotSet;
rate > 0 → merchant gets amount − fee, recipient gets fee, sum reconciles
exactly (floor rounding, no dust), spent counts full amount; fee never bypasses
validate-and-consume (over-budget with fee still rejected); fee applies per-leg
in clear_pool and reconciles.

**Composites — the adversarial core:**
- register_pool: happy path; duplicate pool_id → AlreadyExists; past deadline →
  DeadlinePassed; SpendCeiling/CapacityCeiling → KindNotSupported.
- child registration: merchant mismatch → PoolMerchantMismatch; asset mismatch
  → PoolAssetMismatch; non-monotone price / non-descending qty / empty-with-pool /
  too-long / worst-case > max_amount → ScheduleInvalid; nonexistent pool → PoolNotFound.
- commit: happy (aggregates advance); allowance below worst-case →
  InsufficientAllowance; double-commit → BadPoolState; after deadline →
  DeadlinePassed; 33rd member → PoolFull.
- solo/pool exclusion: execute_payment on pooled mandate → MandatePooled.
- clearing math: under-threshold pre-deadline → ThresholdNotMet, pool stays
  Open; under-threshold post-deadline → Aborted, zero transfers; fires at exact
  threshold boundary; correct p\* across mixed schedules (value-threshold
  binding case: low p fails value check, higher p clears); **uniform price** —
  every cleared child pays exactly p\* per unit including children whose top
  tier was higher; expired child excluded (pool fires without it if still ≥
  threshold; aborts/waits if not); revoked committed child excluded AND
  aggregates released; demand-curve worked example `[(5,3),(10,1)]` allocates
  3 at p\*≤5 and 1 at 5<p\*≤10 (locks in §4.1 against regression).
- atomicity/idempotency: allowance pulled after commit → clear_pool reverts
  wholesale (try_-call asserts revert; pool still Open; NO sibling was charged);
  double-clear → PoolNotOpen; clear on Aborted pool → PoolNotOpen.
- no-discretion proof: simulate_clear output == the allocation clear_pool
  actually executes (assert equality of price/allocations, then execute and
  assert per-child transfer amounts match); allocation_root recomputes from
  simulate output.
- member-order independence: same children committed in different orders →
  identical ClearOutcome (mandate_id sort, not commit order).

**Overflow/edges:** schedule values near i128::MAX rejected at registration
(Overflow via checked worst-case); u128 aggregate sums checked.

## 10. Judgment calls flagged for review (decided, not blocking)

1. **Demand-curve correction** (§4.1) — deviation from the brief's literal
   allocation rule; the brief's rule can charge a buyer more than any tier
   they authorized. Needs user's eyes but is unambiguous.
2. `set_admin` included (one line, rotatability) though D4's surface omits it.
3. Ceiling kinds rejected at register_pool in Stage 1 (enum reserved).
4. `commit_child` permissionless; `clear_pool` permissionless (both are pure
   functions of authorized state).
5. Pooled mandates are pool-only (`MandatePooled` on the solo path).
6. Fee applies to pool capture legs too (same money-path principle).
7. `member_root` Merkle field dropped for Stage 1 (direct list ≤ 32).
8. Thresholds/qty are u128 per the brief; money stays i128 (SEP-41 native);
   checked casts at the boundary.
