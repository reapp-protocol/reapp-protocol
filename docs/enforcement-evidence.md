# On-chain enforcement evidence

Two pieces of evidence make "the SDK is untrusted and cannot bypass the contract"
directly checkable, rather than a design claim:

1. **The agent holds zero spending authority.** After `approveBudget`, the SEP-41
   `allowance(user, spender)` read from the native asset contract returns the full
   mandate budget for `spender = MandateRegistry` and exactly `0` for `spender =
   agent`. A compromised agent key has nothing to `transfer_from`; only the contract
   can move the user's funds, and it does so only inside its own validate-and-consume
   paths.
2. **A rejected payment is rejected on-chain, not just in client preflight.** Soroban
   RPC normally refuses to even assemble an invocation that would revert, so most
   rejections never reach a ledger. Forcing two payments with the same `expected_seq`
   through consecutive account sequences lands both: the first settles
   ([`aaadcb13…8b95`](https://stellar.expert/explorer/testnet/tx/aaadcb13ec89e5b9c4cabd145adab3c615069277ceef8a4e843f2e5925a38b95),
   ledger 3586877, successful) and the second is included and **reverted by the
   contract's replay guard**
   ([`49523d54…8456`](https://stellar.expert/explorer/testnet/tx/49523d546d10ec2645730ebcbb29ee88d5db0b0d6c7e8dd9feade26708d18456),
   ledger 3586878, failed). The enforcement is the deployed WASM, verifiable on any
   explorer.

Both artifacts are reproducible against the published packages with the adversarial
scripts in [`scripts/adversarial/`](../scripts/adversarial/).

## Bound-v2 security properties

- A client without bound-v2 support receives `426` before payment.
- Only exact-origin `GET` routes are accepted.
- The merchant authenticates a short-lived challenge binding audience, method, path
  and query, network, registry, merchant, asset, amount, and decimals.
- The on-chain mandate agent signs the challenge, transaction hash, and mandate id.
- Redirects are manual before and after settlement.
- The signed transaction hash, validity window, and exact receipt are durable before
  broadcast; restart restores the no-second-payment lock.
- The client clears a receipt only after full-body validation, durable business
  acceptance, and explicit `acknowledgeDelivery`.
- One settlement moves atomically from `missing` to `executing` to `completed(exact
  JSON bytes)`.
- The exact completed proof replays stored bytes without chain verification or
  callback execution; another proof for that transaction returns `409`.
- RPC and store failure return `503` and serve no protected data.

`InMemoryBoundRedemptionStore` is demo-only. The included file store is a restart-safe,
single-process reference. An interrupted execution never reruns; after confirming its
owner is dead, trusted operator/outbox code resolves its execution id through
`resolveBoundReappInterruptedDelivery` to one immutable terminal result. Multi-worker
production requires a shared durable linearizable store, stable challenge-secret
custody, and a transactional job/outbox for external side effects. Those are explicit
mainnet gates, not hidden testnet claims.
