# REAPP threat model

This model is a release gate for the testnet developer toolkit and a required
input to any mainnet decision. The contract is the authorization boundary. SDK,
CLI, HTTP clients, agents, merchants, RPC providers, and browser interfaces are
treated as fallible or hostile unless chain evidence proves the required fact.

## Protected assets

- User token balances and SEP-41 allowances.
- Mandate scope, budget, expiry, status, and payment sequence.
- Administrator authority over pause, rotation, and delayed upgrades.
- Merchant protected resources and one-time settlement proofs.
- User, agent, merchant, and administrator signing keys.
- Release WASM, generated interfaces, deployment IDs, and evidence links.

## Security invariants

1. Tokens move only through `MandateRegistry.execute_payment` or the composite
   contract's explicitly documented capture path.
2. Every simple payment rechecks agent authorization, current sequence, status,
   expiry, merchant, amount, remaining budget, allowance, and balance in one
   atomic contract transaction.
3. The SDK, CLI, or HTTP adapter cannot grant authority that is absent from the
   stored mandate.
4. A signed AP2 credential is admitted only after its user signature, trusted
   signer, binding hash, merchant, amount, expiry, and replay key pass together.
5. A merchant serves only after independently verifying one successful payment
   event from the configured registry and the matching SEP-41 transfer.
6. One settlement proof can unlock at most one protected resource.
7. A payment whose HTTP delivery is uncertain is never classified as unpaid;
   the exact receipt is retained for delivery-only retry.
8. Pause blocks money movement before contract state or funds change.
9. An upgrade requires administrator authorization, an exact scheduled WASM
   hash, the fixed delay, and paused state.

## Trust boundaries

| Boundary | Trust decision |
|---|---|
| External AP2 input → profile validator | Unknown fields and unsupported versions fail closed; signed user must equal the separately trusted account identity. |
| User → contract | The user's signature authorizes registration, allowance, and revocation. Application claims do not. |
| Agent → contract | The agent signature authorizes only a request; stored contract rules decide whether it succeeds. |
| Merchant → consumer | A 402 response is a quote and routing hint, not authorization. |
| Consumer → merchant | Caller-supplied proof fields are untrusted. Only the normalized transaction hash crosses into verification. |
| Merchant → Stellar RPC | RPC responses are checked for network identity, transaction success, freshness, exact emitting contracts, event shape, mandate state, and transfer evidence. |
| Operator → administration | Current testnet control is single-signer; 2-of-3 custody is mandatory before early mainnet. |
| Source → deployment | Tagged source, release artifact, interface, SHA-256, provenance, and on-chain WASM must agree. |

## Threats and controls

| Threat | Control | Continuous evidence |
|---|---|---|
| Forged, altered, expired, or replayed AP2 mandate | Versioned Ed25519 envelope binds the full canonical profile payload and normalized intent to the recomputed mandate hash; trusted signer/scope/amount/expiry checks run before atomic admission replay consumption. | 47 validator tests including tampering, exact boundaries, 100-way concurrency, store outages, and replay-poisoning attempts. |
| Compromised agent overspends | Contract checks `spent + amount <= max_amount` on every payment. Agent never receives the user's allowance. | Single and cumulative overspend tests; CLI and reference-agent fourth-purchase rejection; rogue-agent live drill. |
| Agent pays the wrong merchant or asset | Merchant and asset come from stored mandate state; client mismatch checks fail early but are not trusted. | Wrong-merchant contract test; SDK 402 merchant/asset tests; verifier mandate and transfer matching tests. |
| Replayed or out-of-order payment | Stored sequence must equal `expected_seq`; successful payment increments it atomically. | Stale and out-of-order sequence tests; middleware proof replay and 100-way concurrency tests. |
| Payment after expiry or revocation | Contract uses ledger time and stored status at settlement. | Expired/revoked contract tests and live quote-before-expiry rejection drill. |
| Direct token transfer bypass | Allowance is granted to the contract, not the agent or SDK. Official examples never grant agent allowance. | Reference-app code, registration flow, allowance evidence, and property that stored spend equals transferred amount. |
| Forged successful transaction | Middleware requires the configured registry event plus matching same-transaction SEP-41 transfer and current mandate facts. | Golden event vectors; wrong emitter/type/topic, ambiguity, failed/stale/future transaction, and missing-transfer tests. |
| Proof used twice or for another resource | Atomic redemption key binds network, registry, and transaction; store consumes exactly once. | Cross-resource, duplicate, network/registry isolation, and concurrent replay tests. |
| Merchant fails after settlement | SDK throws `DeliveryPendingError` for network failure or non-2xx paid retry and preserves the receipt. | Network plus paid HTTP 402/409/503 tests; live downtime/recovery/replay drill. |
| Malicious or unavailable RPC | Network identity and evidence are checked; malformed or unavailable evidence fails closed. | RPC identity, polling, unavailable lookup, incomplete transaction, and insecure-RPC tests. |
| Administrator key compromise | 24-hour delay, required pause, public pending hash, event monitoring, separated 2-of-3 target custody. | Unauthorized lifecycle tests, live pause/unpause checks, and upgrade authority runbook. |
| Release artifact substitution | Hosted artifact and on-chain bytes must have identical hash and interface. | Contract repository gate check, provenance links, hash comparison, and live contract reads. |
| Dependency or build compromise | Lockfile install, strict type build, Rust formatting/lint/tests, and minimal published file sets. | `npm ci`, `npm run verify`, contract gate check, package tarball inspection, clean-install imports. |

## Availability and failure behavior

Availability failure must not become an authorization bypass. RPC outage,
merchant outage, rate limiting, malformed proof, store failure, or stale chain
data returns an error and serves no protected resource. A client may retry an
unpaid request. After a settlement receipt exists, it may retry only delivery
with that same receipt.

## Administrator and upgrade risk

The current testnet administrator is a single signer and is therefore a known
operational risk. It is not acceptable for early mainnet. The full custody,
rotation, loss, compromise, and terminal immutability procedures are in
[`upgrade-authority.md`](upgrade-authority.md).

No same-address production upgrade is accepted solely because the transaction
succeeds. The post-upgrade gate must prove the exact executable, interface,
administrator, paused state, and representative pre-existing storage at the same
contract ID before unpausing.

## Residual risks and mainnet gates

- Testnet public services can rate-limit, reset, or disappear; they are evidence
  surfaces, not production availability infrastructure.
- The demo redemption store is one-process only. Production requires a durable,
  linearizable shared store.
- AP2 and x402 formats are evolving. Their adapters must remain replaceable and
  fail closed on unsupported semantics.
- AP2 admission replay state and merchant settlement redemption state require
  separate durable, linearizable stores in production; the in-memory examples
  are development-only.
- Contract and SDK dependency upgrades require renewed release evidence.
- Final immutability is blocked until the threat model, data flow, negative
  suite, custody assignments, recovery rehearsal, monitoring, and migration plan
  all have explicit sign-off.

## Gate check commands

```bash
npm ci
npm run verify
npm run agents:testnet
npm run drills:testnet
```

The contract release repository separately runs:

```bash
./scripts/gatecheck-contracts.sh
```
