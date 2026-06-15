# Step 3: x402 Round-Trip Working, Audited, Airtight

> **Deliverable.** *x402 testnet payment round-trip working end to end.
> `Agent.fetch(url)` receives a 402, validates the mandate, signs the XDR, pays,
> and receives the resource. Reviewers can reproduce the full ResearchAgent
> scenario on testnet using the SDK.*

**Status: complete, independently audited, and verified live on testnet.** This is
the close-out for Step 3. The full writeup is
[`docs/tranche-1-step-3.md`](../docs/tranche-1-step-3.md); the clause-by-clause proof
is [`tranche-1-step-3-verified.md`](tranche-1-step-3-verified.md).

## What shipped

| Piece | Role |
|---|---|
| `Agent.fetch(url)` (`@reapp-sdk/core`) | the x402 client: 402, validate, pay on-chain, retry with proof, receive the resource |
| `packages/sdk/src/x402.ts` | the wire-format adapter, isolated so x402 v0.2 and v0.3 touch only this file |
| `apps/fulfillment-agent` | the reference 402-gated merchant that verifies payment on-chain before serving |
| `apps/consumer-agent` | the ResearchAgent that buys sources via `fetch`, budget enforced on-chain |

`Agent.fetch` is built on the Step 2 `pay` path, so the contract is still the only
thing that moves money and the SDK still holds no allowance. The MandateRegistry is
unchanged from Step 1.

## Honest record: the audit found a critical bug, this version fixes it

We ran an independent adversarial audit before calling it done, and it earned its
keep. It found a **critical** access-control bypass and a replay window. Both are
fixed, and the critical fix is verified on-chain.

| Found by the audit | Now (fixed) |
|---|---|
| The merchant matched the `payment` event's topic and amount but not the emitting contract, so any contract could publish a forged `("payment", merchant, price)` event and unlock the resource for free | The merchant requires the event to come from the MandateRegistry (`StrKey.encodeContract(ev.contractId())`). Verified on-chain: the token's `transfer` event is ignored, only the registry's `payment` event is honored |
| The replay check ran before the async on-chain verification (a TOCTOU window for concurrent reuse) | The proof is reserved synchronously before the await, released only on a verification failure |

Neither shortcut survived. The merchant now independently proves a real payment to
itself, from the real contract, exactly once.

## Independent audit: airtight for testnet after the fixes

BulletproofBar adversarial sweep on 2026-06-16: 23 agents across 6 attack surfaces
(merchant verification, replay and double-spend, `fetch` cannot bypass the contract,
x402 wire parsing, the consumer agent pattern, correctness). Every finding was
re-verified against the source, several reproduced empirically, then a completeness
critic checked for missed paths.

**Result after the fixes: 0 testnet blockers.** Confirmed strengths:

- `fetch` always settles through `execute_payment`; the 402 is only a hint, never authorization.
- The merchant never trusts the client: it reads the transaction on-chain and confirms the MandateRegistry `payment` event paid it at least the price, and refuses replays.
- The x402 wire format is fully isolated in `x402.ts`.

Full record: [`security/x402-audit-2026-06-16.md`](../security/x402-audit-2026-06-16.md).
The remaining items (per-call price ceiling, per-resource payment binding, deriving
the price from asset decimals) are mainnet-hardening, not testnet blockers.

## Proof, live on testnet (3 of 4 served, the 4th blocked)

Contract [`CA3X76MR…BQCL`](https://stellar.expert/explorer/testnet/contract/CA3X76MRIEHP7LVY6H4FIAOTRQYLSMD6NXUMVM5ZR56EOCCWMT6SBQCL).
Native XLM; friendbot-funded actors.

| Step | What happened | On-chain |
|---|---|---|
| authorize | user signs a 3 XLM mandate | register [tx](https://stellar.expert/explorer/testnet/tx/88d4462c8f15827a77af71a2f3c091f7c0ada5ed05e2dcdae2a23ebf8fead822), approve [tx](https://stellar.expert/explorer/testnet/tx/a42f1dba6590deb585b52ab367bce3ebd387882055cae4b7ccf36145070ad0ec) |
| fetch market | 402, pay, **resource served** | agent-signed [tx](https://stellar.expert/explorer/testnet/tx/f6abd0c11ca9b1e2f856e92aa013bfbd456c2d9363728741799e51d7792e5b90) |
| fetch academic | 402, pay, **resource served** | [tx](https://stellar.expert/explorer/testnet/tx/4be38b500da29b69900ef9cd2ba5d2c9a9f51a832929012532f471c468dc4284) |
| fetch news | 402, pay, **resource served** | [tx](https://stellar.expert/explorer/testnet/tx/90723f4bc810f677b07fb5299b2bc2155f0ba7d36c5bd43c4eb8e8cd9bcabe41) |
| fetch patents | 402, payment **rejected** `BudgetExceeded` | no transaction, no resource |

The merchant earned exactly 3 XLM (Horizon balance `10003.0000000`). The budget held
through the HTTP layer.

## Reproduce it yourself

```bash
npm install && npm run build
npm run e2e:x402
```

**Step 3 is closed. Tranche 1 is complete: the contract (Step 1), the published SDK
(Step 2), and the x402 round-trip (Step 3). Next is Tranche 2.**
