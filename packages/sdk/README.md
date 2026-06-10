# @reapp-sdk/core

Create an agent, connect to the testnet **MandateRegistry**, and execute a
**mandate-validated payment in under 10 lines**.

The SDK is **untrusted by design**: the Soroban contract enforces every spending
limit on-chain (scope, budget, expiry, replay). A buggy or malicious SDK cannot
exceed the mandate — the contract is the source of truth.

## Install

```
npm install @reapp-sdk/core @stellar/stellar-sdk
```

## Quick start (Stellar testnet)

```ts
import { reapp } from "@reapp-sdk/core";
import { Keypair } from "@stellar/stellar-sdk";

const user = Keypair.fromSecret(USER_SECRET);   // owns the funds, signs the mandate
const agent = Keypair.fromSecret(AGENT_SECRET);  // the autonomous spender

const m = reapp.createIntentMandate({
  user: user.publicKey(),
  agent: agent.publicKey(),
  merchant: MERCHANT,
  asset: reapp.testnet.nativeSac,
  maxAmount: "5.00",
  expiry: Math.floor(Date.now() / 1000) + 3600,
});

await reapp.registerMandate(m, { signer: user }); // user authorizes the mandate
await reapp.approveBudget(m, { signer: user });    // SEP-41 allowance → the contract
await reapp.agent({ mandate: m, signer: agent }).pay("1.00"); // agent-signed, on-chain
```

That's it. The `pay` call routes through `MandateRegistry.execute_payment`, which
re-validates everything and moves funds atomically. Try to overspend, pay the
wrong merchant, replay, or pay after `reapp.revokeMandate(...)` — the contract
rejects it, and `pay` throws.

## API

| Call | Does |
|---|---|
| `reapp.createIntentMandate(input)` | Build an AP2-style mandate + its on-chain id (no chain call) |
| `reapp.registerMandate(m, { signer })` | Store it on-chain (user-signed) |
| `reapp.approveBudget(m, { signer })` | Grant the **contract** a SEP-41 allowance (user-signed) |
| `reapp.agent({ mandate, signer }).pay(amount)` | Execute a mandate-validated payment (agent-signed) |
| `reapp.revokeMandate(m, { signer })` | Withdraw consent (user-signed) |
| `Errors` | Typed contract errors (`Errors[6]` = BudgetExceeded, etc.) for branching |

Amounts are strict decimal strings (e.g. `"5.00"`); invalid or over-precise
input throws rather than silently truncating.

## Network

Defaults to Stellar testnet and the live, audited MandateRegistry. Pass a custom
`NetworkConfig` as the last argument to point elsewhere.

Apache-2.0.
