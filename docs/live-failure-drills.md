# Live SDK failure drills

These drills exercise the payment SDK against the upgradeable simple
MandateRegistry on Stellar testnet:

[`CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE`](https://stellar.expert/explorer/testnet/contract/CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE)

Run all three with one command from the repository root:

```bash
npm run drills:testnet
```

The command creates fresh process-only testnet keys. It does not read a wallet,
local secret, or environment file.

## Verified run: 2026-07-12

| Drill | Expected user experience | Chain result |
|---|---|---|
| Agent acts without another prompt, but stays within the signed envelope | The authorized 1 XLM payment succeeds. After the user revokes, the next 0.5 XLM request is shown as a final contract rejection, not a retryable network error. | [1 XLM settlement](https://stellar.expert/explorer/testnet/tx/12fb051d9aa1dfc2295ae8922056322ab9004823a3afc42ac405c5c7d017683b); stored spend and sequence became 1 XLM and 1. Revocation blocked the next request and the merchant balance did not change again. |
| Merchant disappears after settlement and before delivery | The SDK reports “payment settled; delivery pending” and returns the exact settlement receipt. The caller retries delivery with that receipt and never creates another payment. | [Original settlement](https://stellar.expert/explorer/testnet/tx/1de2e16005444affaf042893d849c993b89894db115ef8d8285ca846d3f2ef84); recovery returned the resource, replay returned HTTP 409, and the merchant balance remained at one payment. |
| Mandate expires after the 402 quote but before settlement | The quote is visible while valid. Once a ledger closes at or after expiry, settlement is rejected as `MandateExpired`; no resource is delivered. | No successful payment transaction exists by design. Stored spend remained 0, sequence remained 0, and the merchant balance did not change. |

## Delivery ambiguity rule

After `execute_payment` settles, a dropped connection or any non-2xx paid retry
is represented by `DeliveryPendingError`. The error carries a
`SettlementReceipt` containing the original transaction hash and proof.

```ts
try {
  const response = await agent.fetch(resourceUrl);
  return await response.json();
} catch (error) {
  if (error instanceof DeliveryPendingError) {
    // Persist this receipt as bearer data. Do not call agent.fetch() again.
    const response = await agent.retryDelivery(error.receipt);
    return await response.json();
  }
  throw error;
}
```

The receipt is bearer data until the fulfillment service consumes it. Production
services must use a durable shared redemption store whose `consumeOnce`
operation is atomic across every worker and host.

## What the drills prove

- Autonomous behavior does not bypass the signed budget or revocation state.
- HTTP delivery failure cannot be confused with an unpaid request.
- A paid delivery retry reuses the original proof and cannot move funds twice.
- Expiry is decided by the contract ledger time at settlement, not by a cached
  SDK value or the time the 402 quote was issued.
- The SDK remains untrusted infrastructure: every money movement still routes
  through `execute_payment`, and the fulfillment service independently verifies
  the resulting chain evidence before serving.
