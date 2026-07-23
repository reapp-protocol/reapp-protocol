# T2 threat model — Stellar testnet

Scope: current upgradeable MandateRegistry deployments, core 0.3.1, Express
middleware 0.2.2, AP2 package 0.2.2 (AP2 profile v0.1), CLI 0.1.5, and the reference agents.

## Protected assets

- user funds and token allowance;
- mandate budget, merchant scope, expiry, status, and sequence;
- admin authority, pause state, and pending upgrade;
- agent and user secret keys;
- merchant challenge secret;
- pending settlement receipts;
- merchant redemption records and delivered results;
- protected resource data.

## Trust boundaries

- The contract is the spending authority. SDK, CLI, agent, cached state, HTTP
  claims, and merchant application code are untrusted for budget enforcement.
- The 402 challenge is an authenticated quote, not permission to spend.
- The merchant independently verifies proof authentication and chain evidence.
- RPC availability is not trusted; outage fails closed.
- Receipt and redemption stores must be durable at their documented deployment scope.

## Invariants

1. Only the mandate agent can invoke payment.
2. Only the stored merchant and asset receive funds.
3. Cumulative spending never exceeds the stored budget.
4. Expired, revoked, paused, invalid, or replayed requests do not transfer funds.
5. Mandate state and transfer change atomically.
6. Bound delivery requires an exact authenticated challenge and chain-derived
   agent signature over challenge + transaction + mandate.
7. One transaction binds to one atomic execution and immutable JSON result.
8. The exact proof may recover only its exact-origin GET stored bytes; the
   callback never reruns.
9. Signed hash, validity window, and receipt are durable before broadcast; a
   restart hydrates the lock and application acknowledgment alone clears it.
10. Admin rotation, pause, and upgrade actions require current-admin authorization.
11. Upgrade execution also requires the configured delay (one hour on the
    simple testnet contract), paused state, and keeps the same contract id and storage.

## Adversarial cases and controls

| Attack or failure | Control |
|---|---|
| Unauthorized caller | Contract `require_auth`; negative tests |
| Wrong merchant or asset | Stored contract scope; chain-derived middleware evidence |
| Overspend | Atomic contract cumulative budget check |
| Sequence replay | Atomic sequence increment and expected sequence |
| Expired/revoked mandate | Contract ledger-time/status checks |
| Direct token transfer presented as payment | Require registry event and matching transfer |
| Forged HTTP amount/identity | Ignore header claims; authenticate challenge and verify chain |
| Public transaction hash copied | Agent-signed bound proof required |
| Old transaction re-signed for new request | Atomic transaction-to-first-proof binding; `409` |
| Redirect exfiltration | Manual redirects before and after settlement |
| Receipt envelope retargeted | Complete receipt-envelope integrity check before HTTP |
| Cross-origin authenticated quote relay | Signed audience must equal the requested exact origin |
| Outer scheme/network contradict signed challenge | Strict equality; reject before payment/delivery |
| Future proof-version downgrade or noncanonical base64 | Strict supported version and canonical decoder |
| Submitted RPC timeout/process restart | Pre-broadcast durable hash; block and reconcile exact transaction |
| Truncated 2xx body or crash before app commit | Retain receipt until full-body durable acceptance and explicit acknowledgment |
| RPC/store outage | `503`, no protected delivery |
| Receipt store fails before broadcast | Abort without submitting a transaction |
| Merchant downtime | Exact-proof retry; zero second payment |
| Store restart/cluster split | Stable secret and shared durable linearizable production store |
| Concurrent/restart duplicate fulfillment | Atomic claim plus immutable-result replay; callback never reruns |
| Execution owner dies | Trusted operator/outbox resolves one terminal result; no automatic lease/re-execution |
| Unauthorized upgrade | Admin auth, delay, pause, and positive/negative lifecycle tests |

## Verification coverage

- AP2: 59 tests across valid, signature, identity, scope, amount, expiry, replay,
  normalization, schema, and store failure cases.
- Core and Express: bound challenge/proof, mismatches, redirects, receipt
  durability, chain verification, exact recovery, conflict, and outage tests.
- Contracts: unauthorized caller, expiry, overspend, replay, pause, upgrade
  authorization/timing, and real same-address replacement with preserved state.
- Live drills: revocation after a valid spend, post-settlement merchant outage,
  and mandate expiry before settlement.

## Named production gates

T2 is testnet scope. Mainnet additionally requires production key custody and
rotation, 2-of-3 governance implementation, a shared linearizable redemption
database, durable result/outbox design, encrypted receipt storage, independent
external review, operational monitoring, and a final immutable-release decision.
