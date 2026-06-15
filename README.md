# reapp-protocol

Agent-driven payments on Stellar. A user signs an AP2 **IntentMandate**, an AI
agent pays for a 402-gated resource via **x402**, and a Soroban contract
(**MandateRegistry**) enforces scope, budget, expiry, and replay at consume
time, so a compromised agent or SDK cannot exceed the mandate.

> **Status:** Tranche 1 complete through Step 2.
> **Step 1.** `MandateRegistry` deployed, audited, and live on Stellar testnet
> (19/19 tests, 9/9 on-chain e2e, CI green). See
> [docs/tranche-1-step-1.md](docs/tranche-1-step-1.md).
> **Step 2.** `@reapp-sdk/core` and `@reapp-sdk/stellar` published to npm; the
> under-10-line flow runs 8/8 live on testnet through the SDK; SDK independently
> audited (0 defects). See [docs/tranche-1-step-2.md](docs/tranche-1-step-2.md).
> The reference consumer and fulfillment agents and the x402 HTTP flow are
> Tranche 2 and not built yet.

## The core invariant

Money moves only through `MandateRegistry.execute_payment`, which
validates-and-consumes the mandate before it transfers. The user grants the
SEP-41 allowance to the **contract**, never to the agent or SDK. The SDK is
untrusted; the contract is the source of truth.

## Layout

```
contracts/mandate-registry/   Rust / soroban-sdk, the enforcement contract (live, audited)
packages/sdk/                 @reapp-sdk/core, thin untrusted client (published)
packages/stellar/             @reapp-sdk/stellar, typed Soroban layer (published)
scripts/audit-mandate.mjs     npm run audit, independent on-chain mandate auditor
playbook/demo.ts              npm run demo, the on-chain "aha" (happy path + rogue rejections)
security/                     contract and SDK audit records
apps/fulfillment-agent/       402-gated merchant server (Tranche 2, stub today)
apps/consumer-agent/          agent that buys a gated resource via the SDK (Tranche 2, stub today)
```

## The demo today

`npm run demo` runs the canonical on-chain flow against testnet: a user authorizes
a mandate, the agent pays, 1 XLM moves, and then the rogue cases the contract
refuses (overspend, replay, pay-after-revoke). The SDK is untrusted; the limit
lives in the contract, so a hostile agent changes nothing.

The 402-gated HTTP version of this story (a consumer agent buying a gated resource
from the fulfillment server via x402) is the Tranche 2 deliverable. Setup, version
pins, and the command sequence live in the build skill so they update in one place.
