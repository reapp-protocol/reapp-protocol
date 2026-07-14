# Live failure drills — Stellar testnet

Run the current bound-v2 failure suite from the repository root:

```bash
npm ci
npm run drills:testnet
```

The command uses fresh ephemeral testnet actors and the default upgradeable
simple MandateRegistry. It passes only when all three failure experiences match
the expected on-chain and HTTP outcomes.

Because every run creates fresh ephemeral actors, the transaction hashes below
are unique to the recorded run. Re-running `npm run drills:testnet` produces
new, equally verifiable evidence rather than reproducing these exact hashes.

## Fresh run — 2026-07-13

Contract: [`CC6JMPDH…CRWE`](https://stellar.expert/explorer/testnet/contract/CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE)

All three drills passed (`3/3 live failure drills passed`).

### 1. Rogue agent contained by revocation

The agent makes one valid within-budget payment. The user then revokes the
mandate, and the next agent request is rejected by the contract. This drill
demonstrates containment of a misbehaving agent via revocation; containment of
an **overspending** agent is demonstrated separately by the reference-agent
round-trip (the fourth purchase is rejected on-chain for budget) and by the
contract's `BudgetExceeded` negative suite.

- Settled transaction: [`451531f1…ab7b`](https://stellar.expert/explorer/testnet/tx/451531f1e16074a31d9ed3dd159f766c0671bfa53ab6541ebec2c6d835feab7b)
- User experience: the valid purchase is delivered; the revoked purchase is
  shown as a terminal contract rejection, not retried.

### 2. Merchant disappears after settlement

The payment transaction is signed and its receipt is durable before broadcast;
the first paid delivery is then deliberately interrupted. The SDK surfaces
`DeliveryPendingError`, retries that exact receipt after recovery, and proves
there is no second payment.

- Settled transaction: [`4a55cedb…28fe`](https://stellar.expert/explorer/testnet/tx/4a55cedb05cb59647a86358859bbade1d5d7669e395ed62f70c8441ad75f28fe)
- User experience: “broadcast may have been attempted; settlement or delivery pending,” followed by recovered
  delivery tied to the same transaction.

### 3. Mandate expires between quote and settlement

The merchant issues a valid challenge, the mandate expires, and the contract
rejects settlement. No funds move and no protected resource is delivered.

- User experience: terminal expiry rejection with no receipt because no payment
  settled. There is intentionally no transaction hash: nothing reached the
  ledger.

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
the current bound-v2 release. The evidence above is the most recent recorded run.

Post-hardening run of 2026-07-12 (same contract, earlier ephemeral actors):
reference-agent register [`0ac41cdb…b8a`](https://stellar.expert/explorer/testnet/tx/0ac41cdbe101ede949485e5c423e555014677c27249bbc7222dd4b8701b13b8a),
approve [`33a50a07…cd5`](https://stellar.expert/explorer/testnet/tx/33a50a0716236fa900b776074c36e66ba0979bf8513a82f044c8b4d297009cd5),
payments [`1f35a405…
