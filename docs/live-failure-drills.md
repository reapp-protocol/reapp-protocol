# Live failure drills — Stellar testnet

Run the current bound-v2 failure suite from the repository root:

```bash
npm ci
npm run drills:testnet
```

The command uses fresh ephemeral testnet actors and the default upgradeable
simple MandateRegistry. It passes only when all three failure experiences match
the expected on-chain and HTTP outcomes.

## Fresh hardened run — 2026-07-12

Contract: [`CC6JMPDH…CRWE`](https://stellar.expert/explorer/testnet/contract/CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE)

Final reference-agent run on the same source settled exactly three purchases,
rejected the fourth for budget, blocked an old-transaction/new-proof attack with
`409`, and measured an exact 3 XLM merchant delta:

- Register: [`0ac41cdb…b8a`](https://stellar.expert/explorer/testnet/tx/0ac41cdbe101ede949485e5c423e555014677c27249bbc7222dd4b8701b13b8a)
- Approve: [`33a50a07…cd5`](https://stellar.expert/explorer/testnet/tx/33a50a0716236fa900b776074c36e66ba0979bf8513a82f044c8b4d297009cd5)
- Payment 1: [`1f35a405…ce4`](https://stellar.expert/explorer/testnet/tx/1f35a40558ac4041d3194bc45000627b94295d6098f7511ce8b22e1a505b9ce4)
- Payment 2: [`b10c2648…d91`](https://stellar.expert/explorer/testnet/tx/b10c2648dc00bb62918a3685572601d6588488d0acf31710650e5741acf4dd91)
- Payment 3: [`c4d9ffec…de3`](https://stellar.expert/explorer/testnet/tx/c4d9ffec47365840618f0c2b5b97b22277f3168bf489a7b94202ac0f1909bde3)

### 1. Rogue agent stays inside the signed envelope

The agent makes one valid within-budget payment. The user then revokes the
mandate, and the next agent request is rejected by the contract.

- Settled transaction: [`89c5f92e…7c73`](https://stellar.expert/explorer/testnet/tx/89c5f92e3bcad2f637790a5b5421d51bb9fcbe5baf2c4770375c007a41c57c73)
- User experience: the valid purchase is delivered; the revoked purchase is
  shown as a terminal contract rejection, not retried.

### 2. Merchant disappears after settlement

The payment transaction is signed and its receipt is durable before broadcast;
the first paid delivery is then deliberately interrupted. The SDK surfaces
`DeliveryPendingError`, retries that exact receipt after recovery, and proves
there is no second payment.

- Settled transaction: [`c8c2ec05…b2cb`](https://stellar.expert/explorer/testnet/tx/c8c2ec0574d19fd012c76d8e549ef8f62c1bdfd490fa9eec83e2a8faa3c9b2cb)
- User experience: “broadcast may have been attempted; settlement or delivery pending,” followed by recovered
  delivery tied to the same transaction.

### 3. Mandate expires between quote and settlement

The merchant issues a valid challenge, the mandate expires, and the contract
rejects settlement. No funds move and no protected resource is delivered.

- User experience: terminal expiry rejection with no receipt because no payment
  settled.

## Recovery guarantees

- The reference `FileSettlementReceiptStore.savePending` fsyncs the signed hash,
  validity window, and exact proof before transaction broadcast; production
  implementations must provide the same durability contract.
- A save failure aborts without submitting a transaction.
- Full-body receipt is not enough to clear state: the application durably accepts
  the result, then `acknowledgeDelivery` calls `clearPending`.
- `retryDelivery` performs no payment, signature, or transaction.
- A `BoundRedemptionStore` atomically claims once and stores exact JSON bytes.
- The exact completed proof replays bytes without callback execution; another
  proof for the transaction conflicts.
- Store or RPC failure returns `503` and serves no protected data.

## Production requirements

The demo uses testnet and reference stores. A production merchant needs a stable
private challenge secret, a shared durable linearizable redemption store across
all workers, an encrypted protected receipt store, and a transactional job/outbox
for external side effects. Only after proving the original execution owner is
dead, a trusted operator/outbox may call
`resolveBoundReappInterruptedDelivery` to store one terminal result; it never
reruns. In-memory stores are demo-only; the included file stores are
single-process references.

## Historical evidence

Earlier transaction hashes remain useful point-in-time records but do not prove
the current bound-v2 release. The evidence above is the post-hardening run.
