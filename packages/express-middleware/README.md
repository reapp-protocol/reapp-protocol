# @reapp-sdk/express-middleware 0.1.0

Fail-closed Express middleware for REAPP payment-gated APIs on Stellar.

The middleware issues an x402-style `402` challenge, accepts an `X-PAYMENT`
settlement proof, and independently verifies the successful Stellar transaction
before a protected handler runs. The transaction must contain one unambiguous
payment event from the configured MandateRegistry and one matching SEP-41
transfer from the mandate user to the configured merchant. Header claims never
replace contract evidence.

Supports Express 4 and Express 5. Ships as ESM with TypeScript declarations.

## Install

```bash
npm install @reapp-sdk/express-middleware express
```

## Quick start

```ts
import express from "express";
import {
  InMemoryRedemptionStore,
  createReappPaymentMiddleware,
  getVerifiedPayment,
} from "@reapp-sdk/express-middleware";

const app = express();

const requirePayment = createReappPaymentMiddleware({
  merchant: process.env.REAPP_MERCHANT_ADDRESS!,
  sourceAccount: process.env.REAPP_READ_SOURCE_ADDRESS!,
  amount: "1.00",
  resource: "/source/market",
  // Local development and one-process demos only. See Production replay safety.
  redemptionStore: new InMemoryRedemptionStore(),
});

app.get("/source/market", requirePayment, (_request, response) => {
  const payment = getVerifiedPayment(response);
  response.json({
    source: "verified research data",
    settlement: payment?.txHash,
    mandate: payment?.mandateId,
  });
});

app.listen(4021);
```

`sourceAccount` is a funded Stellar `G...` address used only to simulate the
read-only `get_mandate` call. The verifier never signs or submits a transaction.

## What is verified

For each paid retry, the default verifier requires all of the following:

1. The configured RPC reports the exact configured network passphrase.
2. The transaction hash is valid, successful, and inside the configured ledger
   freshness window.
3. Exactly one contract event is emitted by the configured MandateRegistry with
   topics `payment` and the configured merchant, plus a 32-byte mandate id and
   an amount meeting the request price.
4. The event-derived mandate currently stored by the contract names the same
   merchant and SEP-41 asset and supplies the user and agent identities.
5. The same transaction contains exactly one matching transfer emitted by that
   asset, from the mandate user to the merchant, for the exact event amount.
6. A shared redemption store atomically consumes the network + registry +
   transaction key before the protected handler runs.

Only the transaction hash crosses from the HTTP adapter into the verifier.
Caller-supplied `amount` and `mandateId` fields remain wire-format hints; the
verified values placed in `response.locals` come from Stellar and the contract.

## Production replay safety

`InMemoryRedemptionStore` is intentionally limited to one Node.js process. A
production deployment must provide a durable `RedemptionStore` whose
`consumeOnce` operation is linearizable across every worker and host:

```ts
import type {
  RedemptionRecord,
  RedemptionStore,
} from "@reapp-sdk/express-middleware";

class SharedRedemptionStore implements RedemptionStore {
  async consumeOnce(
    record: Readonly<RedemptionRecord>,
  ): Promise<"consumed" | "duplicate"> {
    // Perform one atomic set-if-absent in your durable database.
    // Never delete a consumed key merely because downstream delivery failed.
    return atomicInsert(record.key, record) ? "consumed" : "duplicate";
  }
}
```

Only the caller that receives `consumed` reaches the protected handler. A store
error returns `503` and never serves the resource.

## Response behavior

| Condition | Status | Behavior |
|---|---:|---|
| No proof or malformed/invalid settlement | `402` | Returns a fresh payment requirement. |
| Settlement already consumed | `409` | Does not invite a second payment. |
| RPC, mandate lookup, or redemption store unavailable | `503` | Fails closed with `Retry-After`; retry the same proof. |
| Verified and atomically consumed | next handler | Stores chain-derived evidence in `response.locals.reappPayment`. |

Challenges and successful responses receive `Cache-Control: private, no-store`
and `Vary: X-PAYMENT` so a shared cache cannot bypass the payment boundary.

## Request-specific prices

`amount` and `resource` may be resolver functions. The middleware snapshots the
resolved requirement before any asynchronous verification:

```ts
const requirePayment = createReappPaymentMiddleware({
  merchant: MERCHANT,
  sourceAccount: READ_SOURCE,
  amount: (request) => priceFor(request.params.id),
  resource: (request) => `/source/${request.params.id}`,
  redemptionStore,
});
```

Amounts are decimal strings and are converted to integer stroops. Floating-point
amounts, scientific notation, over-precision, zero, and values outside i128 fail
closed.

## API

### `createReappPaymentMiddleware(options)`

Creates an Express 4/5 `RequestHandler`.

| Option | Type | Meaning |
|---|---|---|
| `merchant` | `string` | Required Stellar address that must receive the transfer. |
| `amount` | `string \| (request) => string` | Required decimal price. |
| `redemptionStore` | `RedemptionStore` | Required atomic consume-once store. |
| `sourceAccount` | `string?` | Funded `G...` address for read-only simulations; required by the default verifier. |
| `resource` | `string \| (request) => string` | Challenge resource id; defaults to `request.originalUrl`. |
| `asset` | `string?` | Required SEP-41 emitter; defaults to the configured network's native SAC. |
| `networkConfig` | `NetworkConfig?` | RPC, passphrase, registry, and native SAC; defaults to REAPP testnet. |
| `scheme` | `string?` | Wire scheme; defaults to `reapp-soroban`. |
| `network` | `string?` | Wire network label; defaults to `stellar-testnet`. |
| `decimals` | `number?` | Asset decimals; defaults to `7`. |
| `maxProofAgeLedgers` | `number?` | Settlement freshness window; defaults to `120`. |
| `pollAttempts` | `number?` | `NOT_FOUND` retries; defaults to `15`. |
| `pollIntervalMs` | `number?` | Retry delay; defaults to `1000`. |
| `maxHeaderBytes` | `number?` | Strict `X-PAYMENT` size limit; defaults to `8192`. |
| `allowHttpRpc` | `boolean?` | Development-only plaintext RPC escape hatch; defaults to `false`. |
| `verifier` | `PaymentVerifier?` | Explicit trusted verifier injection for tests or alternate RPC infrastructure. |

### Runtime exports

| Export | Purpose |
|---|---|
| `createReappPaymentMiddleware` | Build the payment boundary. |
| `getVerifiedPayment(response)` | Read the chain-derived `VerifiedPayment` after the gate. |
| `InMemoryRedemptionStore` | One-process development/test store. |
| `createStellarPaymentVerifier` | Build the independent Stellar verifier. |
| `buildChallenge` | Build the isolated x402-style response object. |
| `createRedemptionKey` | Create the normalized cross-network replay key. |
| `extractContractEvents`, `interpretEvents` | Strict V3/V4 Stellar event decoding helpers. |
| `selectPayment`, `selectTransfer` | Pure fail-closed event selection helpers. |

The package also exports TypeScript types for requirements, verified payments,
verifiers, redemption records and stores, middleware options, and decoded event
evidence.

## Wire-format isolation

x402 is evolving. REAPP keeps the HTTP challenge/proof shape in the isolated
adapter inside `@reapp-sdk/core`; MandateRegistry does not depend on that shape.
An x402 version change can replace the adapter while the same contract methods,
storage, and verifier invariants remain intact.

## Current protocol limits

- The settlement proof is bearer data. Atomic consumption prevents two
  successful redemptions, but a copied proof can race the legitimate requester.
- The challenge resource is not committed into the current contract event.
  Exact requester/resource binding requires an authenticated nonce/signature or
  a future contract/event commitment; this package does not claim that property.
- `get_mandate` reads current contract state, not a historical state snapshot.
  Same-transaction registry and token events prove settlement, while current
  state binds the mandate identities and asset.

## Current contract evidence

The testnet default is the upgradeable simple MandateRegistry:

- Contract: [`CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE`](https://stellar.expert/explorer/testnet/contract/CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE)
- WASM SHA-256: `13f7023d4a361b6e49d3d39f61f55c5eeece51a602013a3cddae420d2ce8552b`
- Reproducible release: [`simple-v0.2.0`](https://github.com/reapp-protocol/reapp-protocol-contracts/releases/tag/simple-v0.2.0_contracts_simple_mandate_registry_mandate-registry_pkg0.2.0_cli25.1.0)

The contract checks and consumes authorization inside `execute_payment` before
the token transfer. Testnet operations include pause, authority rotation, and a
24-hour timelocked same-address upgrade path.

Apache-2.0.
