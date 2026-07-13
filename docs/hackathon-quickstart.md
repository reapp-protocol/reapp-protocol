# REAPP hackathon quickstart — Stellar testnet

This path starts from a clean clone and produces a real contract-enforced agent
payment flow without requiring a wallet extension or an LLM key.

## Fastest proof

```bash
git clone https://github.com/reapp-protocol/reapp-protocol.git
cd reapp-protocol
npm ci
npm run agents:testnet
```

The command creates ephemeral testnet actors, registers a 3 XLM mandate, starts
the 402-gated Express fulfillment agent, and calls it through `agent.fetch()`.
Three purchases settle; the fourth is rejected by the contract budget.

## Terminal-only CLI proof

```bash
npx reapp-protocol-cli@0.1.4 demo research-agent
```

For a reusable CLI project:

```bash
npx reapp-protocol-cli@0.1.4 init
npx reapp-protocol-cli@0.1.4 setup
npx reapp-protocol-cli@0.1.4 mandate create
npx reapp-protocol-cli@0.1.4 pay
npx reapp-protocol-cli@0.1.4 settlement reconcile
npx reapp-protocol-cli@0.1.4 settlement acknowledge <TX_HASH>
```

## Clean VS Code consumer project

1. Open an empty folder in VS Code.
2. Create a Node.js ESM project.
3. Install the client and Stellar SDK.

```bash
npm init -y
npm install @reapp-sdk/core@0.3.0 @stellar/stellar-sdk
```

Use the hosted [`reapp.live/express`](https://reapp.live/express) workbench to
create an ephemeral endpoint. Copy its endpoint, merchant address, and generated
consumer example into your local project. Your testnet signers stay local; the
hosted fulfillment service sees only public identities and signed proofs.

The safe client pattern is:

```ts
const agent = reapp.agent({
  mandate,
  signer: agentKey,
  proofPolicy: "bound-v2-only",
  receiptStore,
});

try {
  const response = await agent.fetch(endpoint);
  const receipt = getSettlementReceipt(response)!;
  const result = await response.json();
  await persistAcceptedResult(result, receipt);
  await agent.acknowledgeDelivery(receipt);
  console.log(result, receipt);
} catch (error) {
  if (error instanceof DeliveryPendingError) {
    // Never start a new purchase. Persist and retry this exact receipt.
    const response = await agent.retryDelivery(error.receipt);
    const result = await response.json();
    await persistAcceptedResult(result, error.receipt);
    await agent.acknowledgeDelivery(error.receipt);
    console.log(result);
  } else {
    throw error;
  }
}
```

## Merchant checklist

- Use `createBoundReappPaidJsonRoute`; its callback receives no Express response.
- Keep `challengeSecret` private and stable across restarts.
- Configure the exact public HTTP(S) origin as `audience`, never the request Host header.
- Use a shared durable linearizable `BoundRedemptionStore` in multi-worker deployments.
- Protect GET only. The route atomically claims once, stores bounded JSON bytes
  before sending, and replays those bytes without rerunning the callback.
- For external side effects, use a transactional job/outbox. Only after proving
  the original execution owner is dead, use the trusted operator/outbox-only
  `resolveBoundReappInterruptedDelivery` API to store one terminal result; never
  lease it back to runnable.
- Never trust HTTP payment fields without contract event and token-transfer evidence.

## Before presenting

```bash
npm run gatecheck:t2
npm run agents:testnet
npm run drills:testnet
```

All keys created by these examples are testnet-only. Never reuse them on mainnet.
