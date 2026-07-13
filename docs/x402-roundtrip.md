# Bound-v2 402 round trip

REAPP isolates the evolving HTTP payment wire format from the MandateRegistry.
The contract owns spending authorization; the HTTP layer decides whether a
merchant may release one exact resource after independently proving settlement.

Current implementation: `@reapp-sdk/core@0.3.0` and
`@reapp-sdk/express-middleware@0.2.0` on Stellar testnet.

## Sequence

1. The agent sends `GET` with
   `REAPP-PAYMENT-CAPABILITIES: reapp-bound-v2`. Redirect handling is manual.
2. An unsupported client receives `426` before payment.
3. The merchant returns `402` with an HMAC-authenticated challenge containing:
   exact configured public origin, method, path and query, `bodySha256: null`, network
   label and passphrase hash, registry, merchant, asset, amount in stroops,
   decimals, random challenge id, issue time, and first-redemption deadline.
4. A bound-only SDK verifies every field against the requested URL, mandate,
   and configured network before it calls the contract.
5. The SDK signs the transaction, derives its hash and validity window, builds
   the bound proof/receipt, and fsyncs that evidence before broadcast.
6. `Agent.pay` calls `MandateRegistry.execute_payment`. The contract validates
   caller, merchant, amount, expiry, remaining cumulative budget, and monotonic
   sequence, then transfers atomically.
7. The agent proof signs a domain-separated digest of the exact challenge,
   transaction hash, and mandate id with the mandate agent key.
8. After settlement, the SDK retries with the bound `X-PAYMENT` proof and capability header.
9. The merchant verifies challenge authentication, exact request binding,
   signature against the chain-derived mandate agent, RPC network, successful
   fresh transaction, registry event, current mandate identities, and matching
   SEP-41 transfer.
10. One `BoundRedemptionStore` atomically claims
    `missing -> executing`, runs the paid JSON callback once, then commits
    `completed(exact JSON bytes)` before sending.
11. The client receives the complete body, validates and durably accepts its
    business result, then calls `acknowledgeDelivery`. Only that explicit commit
    clears the receipt and permits another payment.

## What is and is not trusted

- The 402 is an authenticated quote, not spending authority.
- The SDK is convenience infrastructure, not the enforcement boundary.
- The transaction hash alone never unlocks content.
- HTTP proof fields remain untrusted until the merchant verifies the challenge,
  signature, and chain evidence.
- The contract event and matching token transfer are the settlement evidence.
- A receipt contains sensitive bearer proof material for its exact bound request.

## Recovery without a second payment

If receipt persistence fails, `Agent.fetch` aborts before broadcast and
propagates that storage error. After the receipt is durable, an uncertain
broadcast/final result, network failure, non-2xx retry, or incomplete body throws
`DeliveryPendingError`. If the application's own durable commit fails, the
application error propagates while the receipt remains locked. In every
post-prepare uncertainty, retain the exact receipt and never call `fetch` again.

```ts
try {
  const response = await agent.fetch(url);
  const receipt = getSettlementReceipt(response)!;
  const result = await response.json();
  await persistAcceptedResult(result, receipt);
  await agent.acknowledgeDelivery(receipt);
} catch (error) {
  if (error instanceof DeliveryPendingError) {
    const response = await agent.retryDelivery(error.receipt);
    const result = await response.json();
    await persistAcceptedResult(result, error.receipt);
    await agent.acknowledgeDelivery(error.receipt);
  } else {
    throw error;
  }
}
```

`retryDelivery` validates the complete receipt envelope and proof, refuses a
changed method or URL, disables redirects, reuses the exact proof, and performs
zero signatures, payments, or transactions.

The redemption store has four outcomes:

- missing transaction: verify the chain, then atomically claim one execution;
- same proof still executing: `503`, never start the callback again;
- same proof completed: replay exact stored bytes without verifier/callback;
- same transaction and different proof digest: `409 Conflict`.

The challenge deadline governs first redemption. A completed exact proof may
recover stored delivery after that deadline because it is not fresh spending
authorization. Recovery never enters the callback. Bound-v2 permits GET only;
external side effects require a transactional job/outbox keyed by execution id.

## Fail-closed responses

| Condition | Result |
|---|---|
| First response is not 402, including 3xx | Returned without payment; redirects are not followed. |
| Capability absent or unsupported | `426`, no payment. |
| Method is not GET | `405`, no payment. |
| Challenge or proof malformed, expired for first use, or mismatched | `402`, no protected delivery. |
| Same transaction, different proof | `409`, no protected delivery. |
| RPC or redemption store unavailable | `503`, fail closed; retry exact proof. |
| Paid retry fails, is non-2xx, or has a truncated body | `DeliveryPendingError` plus retained receipt; never begin another purchase. |
| Application has not durably accepted and acknowledged the result | Receipt remains locked; the next pay/fetch fails closed. |

## Storage requirements

`InMemoryBoundRedemptionStore` is for one-process demos only.
`FileBoundRedemptionStore` is a restart-safe single-process reference. A
multi-worker merchant must use a shared durable linearizable implementation.
The merchant challenge secret must remain stable across restarts. The consumer
receipt store must save before broadcast, enumerate on restart, clear only after
application acknowledgment, and protect proofs as secrets. Confirmed orphaned
merchant executions resolve through the trusted operator/outbox-only
`resolveBoundReappInterruptedDelivery` API to one stored terminal result; they
never rerun. Use it only after proving the original execution owner is dead.

## Run it

```bash
npm ci
npm run agents:testnet
npm run drills:testnet
```

The agent run settles three resources, proves the fourth contract budget
rejection, and rejects re-signing an old settlement for a fresh request. The
failure drills prove revocation, delivery recovery with zero second payment,
and expiry before settlement.

## Historical security record

[`security/x402-gatecheck-2026-06-16.md`](../security/x402-gatecheck-2026-06-16.md)
records the legacy proof-v1 review. It is retained as history, not as evidence
for bound-v2. Current release evidence comes from the T2 gate check, bound-v2
tests, and the fresh live commands above.
