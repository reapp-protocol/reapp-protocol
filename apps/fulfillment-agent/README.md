# Reference fulfillment agent

An Express 5 API protected by
[`@reapp-sdk/express-middleware`](https://www.npmjs.com/package/@reapp-sdk/express-middleware).
It serves a resource only after independent Stellar verification and atomic
settlement consumption.

## Run the complete live example

From the repository root:

```bash
npm install
npm run agents:testnet
```

The command creates and funds fresh testnet actors, launches this server on an
available local port, and drives it with the reference consumer's
`agent.fetch()`. No stored keys or environment file are required.

## The route boundary

The load-bearing pattern is intentionally small:

```ts
const requirePayment = createReappPaymentMiddleware({
  merchant,
  sourceAccount: merchant,
  amount: "1.00",
  resource: (request) => request.originalUrl,
  redemptionStore,
});

app.get("/source/:id", requirePayment, (_request, response) => {
  const payment = getVerifiedPayment(response);
  response.json({ settledTx: payment?.txHash, data: "protected value" });
});
```

The middleware verifies the RPC network, transaction success and freshness, one
unambiguous event from the configured MandateRegistry, the event-derived
mandate's merchant and asset, and the matching same-transaction SEP-41 transfer.
Only then does an atomic redemption store allow the handler to run.

`InMemoryRedemptionStore` is appropriate only for this one-process demo. A real
deployment must inject a durable shared store whose `consumeOnce` operation is
atomic across every worker and host.

Avoid these unsafe alternatives:

- Never trust the amount, mandate id, or merchant claimed in `X-PAYMENT`.
- Never accept a transaction merely because it succeeded.
- Never use application-cached mandate state as the spending boundary.
- Never serve content before verification and redemption commit.
- Never release a consumed settlement because downstream delivery became uncertain.

## Standalone server

For development against an existing funded testnet merchant:

```bash
REAPP_MERCHANT=G... REAPP_READ_SOURCE=G... \
  npm run start -w @reapp-sdk/fulfillment-agent
```

`REAPP_READ_SOURCE` is used only for read-only contract simulation; the verifier
never signs or submits a transaction.

The default contract is
[`CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE`](https://stellar.expert/explorer/testnet/contract/CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE),
with WASM SHA-256
`13f7023d4a361b6e49d3d39f61f55c5eeece51a602013a3cddae420d2ce8552b`.
