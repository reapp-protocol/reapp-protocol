# REAPP Tranche 2 — testnet completion evidence

This document maps every Tranche 2 deliverable and the Stellar review feedback
to a concrete implementation, a repeatable command, and verifiable evidence.
It is testnet scope. It does not claim mainnet readiness.

## Release facts

| Surface | Current version or deployment |
|---|---|
| Default simple MandateRegistry | [`CCHQ5G4Y…CZRM`](https://stellar.expert/explorer/testnet/contract/CCHQ5G4Y4YBMY6D3TYYJSVJVCKUM22Q6TMKCCHVAHY4X7K6QELQACZRM), release `simple-v0.2.3`, WASM `ba370a80…76e87`, source verified |
| Composite MandateRegistry | [`CCYRF7FK…HEYW`](https://stellar.expert/explorer/testnet/contract/CCYRF7FKYGSNWX5I7WLYXZ6LNUNVCSPE4BOTQFVWVTABOHAP52DYHEYW), release `composites-v0.3.0`, WASM `b3368d7f…f0a1` |
| Typed Stellar package | `@reapp-sdk/stellar@0.2.2` |
| Agent SDK | `@reapp-sdk/core@0.3.1` |
| Express middleware | `@reapp-sdk/express-middleware@0.2.2` |
| AP2 validator | `@reapp-sdk/ap2@0.2.2` |
| CLI | `reapp-protocol-cli@0.1.5`, installed command `reapp` |

The requested unscoped npm name `reapp-cli` is owned by an unrelated publisher.
The safe, verified command is therefore:

```bash
npx reapp-protocol-cli@0.1.5 demo research-agent
```

The deliverable's package names use the `@reapp` npm scope, which is not
available to this project. The packages ship under the `@reapp-sdk` scope
instead, mapping one-to-one:

| Deliverable name | Published package |
|---|---|
| `@reapp/stellar` | `@reapp-sdk/stellar` |
| `@reapp/ap2` | `@reapp-sdk/ap2` |
| `@reapp/express-middleware` | `@reapp-sdk/express-middleware` |

## Deliverable map

### CLI tool

Implemented commands: `init`, `setup`, `mandate create`, `pay`, `settlement
reconcile`, `settlement acknowledge <TX_HASH>`, and `demo research-agent`. Before broadcast, the CLI durably records
the signed hash and validity window; another process cannot pay until exact-hash
reconciliation closes uncertainty. The demo creates testnet actors, registers and funds a
real mandate, settles three purchases, then proves the fourth is rejected by the
contract budget.

Evidence:

```bash
npx reapp-protocol-cli@0.1.5 demo research-agent
```

### Installable, typed SDK packages

The T2 packages are typed ESM implementations published under the `@reapp-sdk`
scope (see the scope mapping above):

```bash
npm install @reapp-sdk/stellar@0.2.2 @reapp-sdk/ap2@0.2.2 @reapp-sdk/express-middleware@0.2.2
```

Each package contains TypeScript declarations, API documentation, and a usage
example in its packed README. The T2 gate check builds real tarballs for every
public package, installs all five into an empty project,
strict-typechecks their public imports, executes ESM imports and the CLI binary,
and rejects lifecycle install scripts or source/secret leakage.

### Reference consumer and fulfillment agents

The consumer uses `agent.fetch()` with `proofPolicy: "bound-v2-only"`, an atomic
purchase claim, a durable pre-broadcast receipt store, an immutable application-
outcome store, restart hydration, and explicit application acknowledgment. The
fulfillment agent uses `createBoundReappPaidJsonRoute` with
an exact public origin, independent Stellar verification, an agent-signed GET
proof, and one atomic claim/result `BoundRedemptionStore`.

```bash
npm ci
npm run agents:testnet
```

The run creates fresh testnet actors and a 3 XLM mandate, serves three paid
resources, proves the fourth contract rejection, retains exact settlement
receipts, and rejects a settled transaction re-signed for a new request with
HTTP `409`.

### AP2 compliance validator

`@reapp-sdk/ap2` verifies the Stellar Ed25519 signature, separately trusted
user, single-merchant scope, amount, expiry, binding hash, strict schema, and
atomic admission replay state. AP2 and x402 adapters are isolated from the
MandateRegistry.

```bash
npm test -w @reapp-sdk/ap2
```

The package has 59 passing tests, including valid mandates, altered signatures,
wrong merchants, overspend, expiry, replay, schema mutation, and store failure.

## Stellar feedback map

| Feedback | Closure evidence |
|---|---|
| x402 and AP2 will evolve | Their wire/profile logic lives in isolated TypeScript adapters. Contract storage and methods contain no x402 or AP2 wire types. |
| MandateRegistry must enforce the money path | `Agent.pay` and `Agent.fetch` settle only through `execute_payment`. The contract validates caller, merchant, amount, expiry, cumulative budget, and sequence before transfer. |
| Negative tests must run continuously | Contract and workspace verification include unauthorized caller, expiry, overspend, replay, pause, upgrade authorization, malformed proof, redirect, RPC outage, store outage, and replay-conflict tests. |
| Threat model and diagrams are gating artifacts | [`security/threat-model.md`](../security/threat-model.md) and [`security/data-flow.md`](../security/data-flow.md) describe the current bound-v2 flow and operational stores. |
| Upgrade governance must be documented | The contracts expose admin rotation, pause/unpause, timelocked same-address execution, and cancellation. The default simple testnet contract has a fixed one-hour delay; the composite testnet contract retains 24 hours. Testnet key custody and the intended 2-of-3 production transition are documented in [`security/upgrade-authority.md`](../security/upgrade-authority.md). |
| SDK must be treated as untrusted | The allowance is granted to the contract, not the SDK or agent. Merchant delivery also requires independently verified chain evidence. Measured on-chain: see "On-chain enforcement artifacts" below. |
| Reference apps must teach the safe path | Both app READMEs show bound-only agents, durable receipts/redemptions, exact-proof recovery, and unsafe-pattern warnings. |
| Live failure behavior must be known | `npm run drills:testnet` covers rogue-agent/revocation, merchant downtime after settlement with zero second payment, and mandate expiry before settlement. |

## On-chain enforcement artifacts

Two pieces of evidence make "the SDK is untrusted and cannot bypass the
contract" directly checkable, rather than a design claim:

1. **The agent holds zero spending authority.** After `approveBudget`, the
   SEP-41 `allowance(user, spender)` read from the native asset contract
   returns the full mandate budget for `spender = MandateRegistry` and exactly
   `0` for `spender = agent`. A compromised agent key has nothing to
   `transfer_from`; only the contract can move the user's funds, and it does so
   only inside its own validate-and-consume paths.
2. **A rejected payment is rejected on-chain, not just in client preflight.**
   Soroban RPC normally refuses to even assemble an invocation that would
   revert, so most rejections never reach a ledger. Forcing two payments with
   the same `expected_seq` through consecutive account sequences lands both:
   the first settles
   ([`aaadcb13…8b95`](https://stellar.expert/explorer/testnet/tx/aaadcb13ec89e5b9c4cabd145adab3c615069277ceef8a4e843f2e5925a38b95),
   ledger 3586877, successful) and the second is included and **reverted by the
   contract's replay guard**
   ([`49523d54…8456`](https://stellar.expert/explorer/testnet/tx/49523d546d10ec2645730ebcbb29ee88d5db0b0d6c7e8dd9feade26708d18456),
   ledger 3586878, failed). The enforcement is the deployed WASM, verifiable on
   any explorer.

Both artifacts are reproducible against the published packages with the
adversarial scripts in [`scripts/adversarial/`](../scripts/adversarial/).

## Bound-v2 security properties

- A client without bound-v2 support receives `426` before payment.
- Only exact-origin `GET` routes are accepted.
- The merchant authenticates a short-lived challenge binding audience, method,
  path and query, network, registry, merchant, asset, amount, and decimals.
- The on-chain mandate agent signs the challenge, transaction hash, and mandate id.
- Redirects are manual before and after settlement.
- The signed transaction hash, validity window, and exact receipt are durable
  before broadcast; restart restores the no-second-payment lock.
- The client clears a receipt only after full-body validation, durable business
  acceptance, and explicit `acknowledgeDelivery`.
- One settlement moves atomically from `missing` to `executing` to
  `completed(exact JSON bytes)`.
- The exact completed proof replays stored bytes without chain verification or
  callback execution; another proof for that transaction returns `409`.
- RPC and store failure return `503` and serve no protected data.

`InMemoryBoundRedemptionStore` is demo-only. The included file store is a
restart-safe, single-process reference. An interrupted execution never reruns;
after confirming its owner is dead, trusted operator/outbox code resolves its
execution id through `resolveBoundReappInterruptedDelivery` to one immutable
terminal result. Multi-worker production requires a shared durable linearizable
store, stable challenge-secret custody, and a transactional job/outbox for
external side effects. Those are explicit mainnet gates, not hidden testnet claims.

## Repeatable gate checks

Protocol and packages:

```bash
npm ci
npm run gatecheck:t2
npm run agents:testnet
npm run drills:testnet
```

Dedicated contracts checkout:

```bash
./scripts/gatecheck-contracts.sh
```

The contract gate includes real positive same-address replacement tests: a new
WASM is scheduled, rejected before the delay, rejected while unpaused, executed
after pause, invoked at the original contract id, and checked for preserved
admin, pause, mandate storage, and cleared pending-upgrade state.

The local gate check does not substitute for npm-registry, GitHub CI, Railway,
or explorer verification. Release completion records those external checks
after publication and deployment.
