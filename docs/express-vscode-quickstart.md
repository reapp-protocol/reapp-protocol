# VS Code to a live REAPP Express endpoint

This guide creates a clean local consumer and connects it to an ephemeral
bound-v2 fulfillment endpoint from [`reapp.live/express`](https://reapp.live/express).
The browser workbench shows the same challenges, settlements, receipts, and
contract rejection produced by the local project.

## 1. Verify the source flow first

```bash
git clone https://github.com/reapp-protocol/reapp-protocol.git
cd reapp-protocol
npm ci
npm run agents:testnet
```

Expected result: the Express fulfillment server starts, `agent.fetch()` serves
three 1 XLM resources, and the fourth purchase is rejected by the 3 XLM mandate.

## 2. Create an endpoint in the browser

1. Open [`reapp.live/express`](https://reapp.live/express).
2. Choose **Create endpoint**.
3. Wait for the testnet user, agent, merchant, allowance, and mandate evidence.
4. Copy the endpoint base, merchant address, and generated consumer example.

The endpoint is ephemeral. Its public route is an exact-origin GET paid JSON
boundary. It never receives your local secret key.

## 3. Create a clean local project

Open an empty folder in VS Code, then run:

```bash
npm init -y
npm pkg set type=module
npm install @reapp-sdk/core@0.3.1 @stellar/stellar-sdk
```

Create `index.mjs` from the browser's generated example. The load-bearing client
configuration must include:

```js
const consumer = reapp.agent({
  mandate,
  signer: agentKey,
  proofPolicy: "bound-v2-only",
  receiptStore,
});
```

Then run:

```bash
node index.mjs
```

Your terminal and the `/express` activity panel should show the same transaction
hashes. The browser polls only public session evidence; secrets remain local.

## 4. Understand the safe recovery path

Before broadcast, `agent.fetch()` signs the transaction and durably saves a
`SettlementReceipt` containing its exact hash and validity window. A transaction
may settle even if its RPC/HTTP response is lost, so uncertainty throws
`DeliveryPendingError`:

```js
try {
  const response = await consumer.fetch(endpoint);
  const receipt = getSettlementReceipt(response);
  const result = await response.json();
  await persistAcceptedResult(result, receipt);
  await consumer.acknowledgeDelivery(receipt);
  console.log(result, receipt);
} catch (error) {
  if (!(error instanceof DeliveryPendingError)) throw error;

  // Do not call fetch again. This cannot pay or sign.
  const recovered = await consumer.retryDelivery(error.receipt);
  const result = await recovered.json();
  await persistAcceptedResult(result, error.receipt);
  await consumer.acknowledgeDelivery(error.receipt);
  console.log(result);
}
```

Keep the exact receipt private and durable. Its integrity id covers the complete
URL, method, settlement fields, and proof. Recovery refuses a retargeted envelope
before making an HTTP request.

## 5. What the server proves

Before serving, the middleware verifies:

- explicit bound-v2 capability;
- merchant-authenticated exact-request challenge;
- chain-derived agent signature over challenge + transaction + mandate;
- expected Stellar network and registry;
- successful fresh settlement transaction;
- one matching MandateRegistry payment event;
- current mandate user, agent, merchant, and asset;
- one matching SEP-41 transfer; and
- atomic `missing -> executing -> completed(exact JSON bytes)` claim/result state.

An exact completed proof replays byte-identical stored JSON without another
chain verifier call or fulfillment callback. Reusing the settlement with a
different proof, origin, path, query, or challenge returns `409`.

## 6. Local merchant instead of the hosted workbench

From the protocol clone:

```bash
REAPP_MERCHANT=G... \
REAPP_READ_SOURCE=G... \
REAPP_PUBLIC_ORIGIN='https://api.example' \
REAPP_CHALLENGE_SECRET='at-least-32-stable-private-bytes' \
REAPP_REDEMPTION_STORE='./private/redemptions.json' \
npm run start -w @reapp-sdk/fulfillment-agent
```

The included file store is restart-safe for one process. Multiple workers or
hosts require a shared durable linearizable `BoundRedemptionStore`. Recovery
never re-enters the callback. External side effects require a transactional
job/outbox. Only after proving the original execution owner is dead, a trusted
operator may call `resolveBoundReappInterruptedDelivery` to store one terminal
result without rerunning work.

## 7. Recording checklist

1. Show the clean VS Code folder.
2. Run install.
3. Create an endpoint on `/express`.
4. Run the generated consumer.
5. Show three matching explorer transaction hashes.
6. Show the fourth contract rejection.
7. Explain that the SDK is untrusted and `execute_payment` is the money boundary.

All accounts and assets in this guide are Stellar testnet only.
