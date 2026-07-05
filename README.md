# reapp-protocol

Agent-driven payments on Stellar. A user signs an AP2 **IntentMandate**, an AI
agent pays for a 402-gated resource via **x402**, and a Soroban contract
(**MandateRegistry**) enforces scope, budget, expiry, and replay at consume
time, so a compromised agent or SDK cannot exceed the mandate.

> **Status:** Tranche 1 complete (Steps 1, 2, 3).
> **Step 1.** `MandateRegistry` deployed, gate-checked, and live on Stellar testnet
> (19/19 tests, 9/9 on-chain e2e, CI green). See
> [docs/mandate-registry-contract.md](docs/mandate-registry-contract.md).
> **Step 2.** `@reapp-sdk/core` and `@reapp-sdk/stellar` published to npm; the
> under-10-line flow runs 8/8 live on testnet; SDK independently gate-checked (0 defects).
> See [docs/reapp-sdk-npm.md](docs/reapp-sdk-npm.md).
> **Step 3.** The x402 round-trip works end to end on testnet: `Agent.fetch(url)`
> receives a 402, pays on-chain, and gets the resource, with the budget enforced
> through the HTTP layer. Reference merchant and ResearchAgent, independently
> gate-checked. See [docs/x402-roundtrip.md](docs/x402-roundtrip.md).

## The core invariant

Money moves only through `MandateRegistry.execute_payment`, which
validates-and-consumes the mandate before it transfers. The user grants the
SEP-41 allowance to the **contract**, never to the agent or SDK. The SDK is
untrusted; the contract is the source of truth.

## Layout

```
contracts/mandate-registry/   Rust / soroban-sdk, the enforcement contract (live, gate-checked)
packages/sdk/                 @reapp-sdk/core, thin untrusted client + Agent.fetch (x402)
packages/stellar/             @reapp-sdk/stellar, typed Soroban layer
apps/fulfillment-agent/       reference 402-gated merchant: verifies payment on-chain before serving
apps/consumer-agent/          reference ResearchAgent: buys sources via agent.fetch, budget enforced on-chain
scripts/audit-mandate.mjs     npm run audit, independent on-chain mandate gate-check tool
scripts/e2e-testnet.mjs       npm run demo, the on-chain "aha" (happy path + rogue rejections)
security/                     contract, SDK, and x402 gate check records
```

## Run it

- `npm run demo` runs the on-chain flow on testnet: a user authorizes a mandate, the agent pays, 1 XLM moves, and the contract refuses the rogue cases (overspend, replay, pay-after-revoke).
- `npm run e2e:x402` runs the full x402 round-trip: the ResearchAgent buys sources from the 402-gated merchant via `agent.fetch`, three settle on-chain, and the fourth is rejected by the budget.

The SDK is untrusted; the limit lives in the contract, so a hostile agent changes
nothing.
