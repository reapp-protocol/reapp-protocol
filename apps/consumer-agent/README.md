# Reference consumer agent

The ResearchAgent buys testnet data through `agent.fetch()`. It never transfers
tokens directly and never decides whether a spend is allowed. Every purchase
calls `MandateRegistry.execute_payment`; the contract validates and consumes
the mandate before money moves.

## Run both reference agents

From the repository root:

```bash
npm ci
npm run agents:testnet
```

One command creates fresh testnet-only user, agent, and merchant keys; funds
them; registers and approves a 3 XLM mandate; starts the fulfillment Express
server; and buys four resources sequentially. Three settle and are served. The
fourth exceeds the contract budget and is rejected. The run also verifies that:

- every delivered settlement has a bound-v2 receipt;
- no delivered receipt remains pending;
- a settled transaction re-signed for a fresh challenge cannot unlock a new
  request and receives `409`;
- the merchant receives exactly 3 XLM.

No local secret, browser wallet, or environment file is required. Generated
keys exist only for that process and must never be reused outside testnet.

## Safe pattern

[`buyResearch`](src/research-agent.ts) requires both a durable receipt store and
a durable purchase-outcome store. The outcome store atomically claims each exact
mandate + GET URL + source before `fetch`, so concurrent consumers cannot start
the same purchase twice:

```ts
const agent = reapp.agent({
  mandate,
  signer: agentSecret,
  proofPolicy: "bound-v2-only",
  receiptStore,
});

const response = await agent.fetch(`${serverUrl}/source/${id}`);
const receipt = getSettlementReceipt(response);
const result = await response.json();
await outcomeStore.complete(identity, executionId, validatedResult); // fsync first
await agent.acknowledgeDelivery(receipt);
```

The SDK advertises bound-v2, validates the authenticated challenge before
paying, signs the transaction, derives its hash and deadline, and durably saves
the exact bound receipt before broadcast. Settlement still occurs only through
`execute_payment`. Redirects are never followed with payment proof material.

Purchases are sequential because each payment consumes the mandate's current
sequence. Contract rejection is terminal for that purchase and is surfaced as a
blocked result instead of retried blindly.

## Delivery recovery

If a signed payment was prepared and broadcast may have been attempted, but
settlement or delivery is not yet confirmed, `DeliveryPendingError` contains the
exact `SettlementReceipt`. Never call `fetch` again. Retain the same receipt,
reconcile the captured hash when needed, and use `resumePendingDelivery` or
`agent.retryDelivery(receipt)`:

```ts
const response = await resumePendingDelivery({
  mandate,
  agentSecret,
  receipt,
  receiptStore,
});
const result = await response.json();
await persistAcceptedResult(result, receipt);
await acknowledgePendingDelivery({ mandate, agentSecret, receipt, receiptStore });
```

That path validates the complete receipt envelope, reuses the original proof,
uses zero signatures and zero payments, and refuses a changed origin, method,
path, or query. It downloads the complete successful body so the application can
validate it. The application then durably accepts its result and
calls `acknowledgeDelivery`; only that explicit acknowledgment clears the same
configured store.

On restart, `listPending` hydrates the no-second-payment lock before any new
purchase. Resolve or retry every retained receipt first.

`FileSettlementReceiptStore` and `FilePurchaseOutcomeStore` are the durable
single-process references. All instances in that process targeting the same
normalized path share one queue; files are atomically replaced, fsynced, and
owner-only. A completed outcome is immutable and replays without `fetch`; if a
crash happens after outcome commit but before receipt acknowledgment, restart
only clears that exact matching receipt. An interrupted `executing` claim never
silently leases itself back to runnable. Receipts contain sensitive bearer proof
material; multi-process production deployments should use encrypted shared
storage with linearizable updates and the same claim, pre-broadcast-save,
application-commit, and explicit-acknowledgment lifecycle.

## Unsafe patterns to avoid

- Do not call a token transfer directly; it does not consume or validate a mandate.
- Do not trust cached budget or expiry; only contract state is authoritative.
- Do not treat any `200` as payment proof; the merchant must verify the chain.
- Do not automatically restart a purchase after an ambiguous settlement.
- Do not alter, log, forward, or expose a settlement receipt.
- Do not assume a public transaction hash authorizes delivery. Bound-v2 also
  requires the exact authenticated challenge and the on-chain agent signature.

The default contract is the upgradeable simple MandateRegistry
[`CCHQ5G4Y…CZRM`](https://stellar.expert/explorer/testnet/contract/CCHQ5G4Y4YBMY6D3TYYJSVJVCKUM22Q6TMKCCHVAHY4X7K6QELQACZRM),
from the reproducible [`simple-v0.2.3` release](https://github.com/reapp-protocol/reapp-protocol-contracts/releases/tag/simple-v0.2.3_contracts_simple_mandate_registry_mandate-registry_pkg0.2.3_cli25.1.0),
with WASM SHA-256 `ba370a80369daa0a0dea2554410dca6f2a9f7a76ba707cb92a83434e2fe76e87`.
