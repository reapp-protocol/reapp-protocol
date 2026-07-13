# @reapp-sdk/express-middleware 0.2.0

Fail-closed Express 4/5 paid JSON routes for REAPP on Stellar.

The package authenticates an exact-origin GET challenge, verifies the on-chain
settlement independently, atomically claims fulfillment, stores the exact JSON
result before sending it, and replays those bytes on recovery. A settlement can
never re-run arbitrary fulfillment work.

## Install

```bash
npm install @reapp-sdk/express-middleware@0.2.0 express@5.2.1
```

The exact T2 compatibility name `@reapp/express-middleware` exposes the same
typed ESM API.

## Safe paid route

```ts
import express from "express";
import {
  InMemoryBoundRedemptionStore,
  createBoundReappPaidJsonRoute,
} from "@reapp-sdk/express-middleware";

const app = express();

const paidResearch = createBoundReappPaidJsonRoute({
  merchant: process.env.REAPP_MERCHANT_ADDRESS!,
  sourceAccount: process.env.REAPP_READ_SOURCE_ADDRESS!,
  audience: "https://api.example", // exact public origin; never Host-derived
  challengeSecret: process.env.REAPP_CHALLENGE_SECRET!, // at least 32 bytes
  amount: "1.00",
  resource: (request) => request.originalUrl,
  // One-process demo only. Production needs a shared linearizable store.
  redemptionStore: new InMemoryBoundRedemptionStore(),
}, async ({ request, payment }) => ({
  body: {
    ok: true,
    resource: request.params.id,
    data: await loadResearchOnce(request.params.id),
    settledTx: payment.txHash,
  },
}));

app.get("/source/:id", paidResearch);
app.listen(4021);
```

The fulfillment callback receives no Express `Response` and cannot stream. Its
JSON result is bounded, hashed, and committed to the same redemption store
before any bytes are written to the client.

## Bound-v2 authorization

Before fulfillment is claimed, the package requires:

1. `REAPP-PAYMENT-CAPABILITIES: reapp-bound-v2`; older clients receive `426`
   before payment.
2. An HMAC-authenticated challenge binding the exact public origin, GET method,
   path and query, network identity, registry, merchant, asset, amount, decimals,
   random id, and first-redemption deadline.
3. A canonical proof whose Stellar Ed25519 signature binds that challenge,
   transaction hash, and mandate id to the chain-derived mandate agent.
4. The configured RPC's exact network passphrase and a successful fresh
   transaction.
5. One unambiguous payment event from the configured MandateRegistry.
6. Current mandate user, agent, merchant, and asset identities.
7. One matching same-transaction SEP-41 transfer from user to merchant.

A copied public transaction hash cannot unlock data. Relaying a genuine quote
through another origin fails before the client pays because the signed audience
must equal the requested URL origin.

## Atomic fulfillment state

`BoundRedemptionStore` owns settlement binding and immutable response bytes in
one linearizable state machine:

```text
missing -> executing -> completed(exact JSON bytes)
```

- First valid proof: chain verification, atomic claim, one callback execution.
- Same proof while executing: `503`; the callback is never started again.
- Same proof after completion: exact stored bytes are replayed; no verifier or
  callback runs.
- Same transaction with another proof: `409`.
- Store/RPC outage: `503`; no protected result is sent.
- Callback exception: one sanitized terminal JSON result is stored and replayed.
- Completion-store failure: no result bytes are sent and the claim remains
  executing; recovery cannot re-run it automatically. After confirming the
  execution owner is dead, trusted operator/outbox code calls
  `resolveBoundReappInterruptedDelivery` to store one terminal result.

The first-redemption deadline does not prevent later replay of an already
completed exact result. That replay is delivery recovery, not fresh payment
authorization.

## Store deployment boundary

`InMemoryBoundRedemptionStore` is only for one-process demos and tests.
`FileBoundRedemptionStore` in the reference fulfillment app is restart-safe for
one Node.js process; instances targeting the same normalized path share one
in-process queue and use fsynced atomic replacement. It is not multi-process or
multi-host storage.

A production deployment must implement `BoundRedemptionStore.lookup`, `claim`,
and `complete` in one shared durable linearizable database. Never add a lease
that silently turns an executing claim back into runnable work. Side effects
must be transactionally coordinated with the claim through a durable job/outbox.

## Response behavior

| Condition | Status |
|---|---:|
| Missing/wrong bound-v2 capability | `426` before payment |
| Method other than GET | `405` |
| Missing, malformed, expired-first-use, mismatched, or unverified proof | `402` |
| Same settlement with a different proof | `409` |
| Existing execution or infrastructure/store outage | `503`, retry exact proof |
| New completed fulfillment | stored 2xx JSON |
| Exact completed recovery | byte-identical stored 2xx JSON |

All responses are private/no-store. Proof and stored result material are
sensitive and must not be logged or exposed.

## Primary API

### `createBoundReappPaidJsonRoute(options, fulfill)`

Required options:

| Option | Meaning |
|---|---|
| `merchant` | Stellar address that must receive the verified transfer. |
| `amount` | Decimal price or request-specific resolver. |
| `audience` | Exact configured public HTTP(S) origin or safe resolver. |
| `challengeSecret` | Stable private 32–4096 byte challenge key. |
| `redemptionStore` | Atomic claim/result store shared by all serving workers. |

Optional controls include `resource`, `asset`, `networkConfig`, `network`,
`decimals`, `sourceAccount`, verifier/polling/freshness/header limits,
`challengeTtlSeconds`, development-only HTTP RPC, and `maxResponseBytes`.

Runtime exports include `createBoundReappPaidJsonRoute`,
`resolveBoundReappInterruptedDelivery`, `InMemoryBoundRedemptionStore`,
`createStellarPaymentVerifier`, strict event
selection helpers, and all TypeScript store/evidence/result types.

Legacy proof-v1 middleware remains available only through the legacy API. The
low-level bound authorization middleware is intentionally not exported from the
package root; public paid endpoints use the result-storing route wrapper.

## Wire-format isolation

x402 and AP2 evolve outside the MandateRegistry. HTTP/profile adapters may
change without changing contract storage or weakening `execute_payment`.

## Current contract evidence

- Testnet contract: [`CC6JMPDH…CRWE`](https://stellar.expert/explorer/testnet/contract/CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE)
- WASM SHA-256: `13f7023d4a361b6e49d3d39f61f55c5eeece51a602013a3cddae420d2ce8552b`
- Release: [`simple-v0.2.0`](https://github.com/reapp-protocol/reapp-protocol-contracts/releases/tag/simple-v0.2.0_contracts_simple_mandate_registry_mandate-registry_pkg0.2.0_cli25.1.0)

Apache-2.0.
