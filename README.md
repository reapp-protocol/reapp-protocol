# reapp-protocol

Agent-driven payments on Stellar. A user signs an AP2 **IntentMandate**; an AI
agent pays for a 402-gated resource via **x402**; a Soroban contract
(**MandateRegistry**) enforces scope, budget, expiry, and replay at consume
time — so a compromised agent or SDK cannot exceed the mandate.

> **Status:** Tranche 1 / Step 1 complete — `MandateRegistry` deployed, audited,
> and live on Stellar testnet (18/18 tests, 9/9 on-chain e2e, CI green). See
> [example-output/step-1-contract-signoff.md](example-output/step-1-contract-signoff.md).

## The core invariant

Money moves only through `MandateRegistry.execute_payment`, which
validates-and-consumes the mandate before it transfers. The user grants the
SEP-41 allowance to the **contract**, never to the agent or SDK. The SDK is
untrusted; the contract is the source of truth.

## Layout

```
contracts/mandate-registry/   Rust / soroban-sdk — the enforcement contract
packages/sdk/                 @reapp/sdk — thin, untrusted client
apps/fulfillment-agent/       402-gated Express server (the merchant)
apps/consumer-agent/          ResearchAgent that pays via the SDK
playbook/demo.ts              the 15-minute "aha": happy path + 4 rejections
security/                     threat model / DFDs (built from day one)
```

## The 15-minute playbook

1. A consumer agent signs a $5 mandate scoped to one merchant, registers it,
   grants the allowance, and buys a gated resource for $0.01.
2. A `--rogue` agent then tries four attacks; the contract refuses all four:
   overspend → `BudgetExceeded`, wrong merchant → `MerchantOutOfScope`,
   replay → `BadSequence`, expired → `MandateExpired`.

_Setup, version pins, and the exact command sequence live in the build skill,
not here — so they update in one place instead of rotting in three._
