# @reapp/express-middleware

Exact-pin compatibility name for
[`@reapp-sdk/express-middleware`](https://www.npmjs.com/package/@reapp-sdk/express-middleware).
It re-exports the reviewed implementation; no security logic is forked.

```bash
npm install @reapp/express-middleware@0.2.0 express@5.2.1
```

```ts
import express from "express";
import {
  InMemoryBoundRedemptionStore,
  createBoundReappPaidJsonRoute,
} from "@reapp/express-middleware";

const app = express();
const paid = createBoundReappPaidJsonRoute({
  merchant: process.env.REAPP_MERCHANT!,
  sourceAccount: process.env.REAPP_READ_SOURCE!,
  audience: "https://api.example",
  challengeSecret: process.env.REAPP_CHALLENGE_SECRET!,
  redemptionStore: new InMemoryBoundRedemptionStore(), // demo only
  amount: "1.00",
}, async ({ request, payment }) => ({
  body: { ok: true, resource: request.params.id, settledTx: payment.txHash, data: "protected" },
}));

app.get("/source/:id", paid);
```

The route authenticates an exact-origin GET challenge, verifies the agent
signature and Stellar settlement, claims fulfillment once, stores exact JSON
bytes, and replays those bytes without re-running work. Multi-worker production
requires a shared durable linearizable `BoundRedemptionStore` and stable private
challenge-secret custody. External side effects use a transactional outbox;
only after proving the original execution owner is dead, a trusted operator may
call `resolveBoundReappInterruptedDelivery` to store one terminal result. It is
never rerun.
