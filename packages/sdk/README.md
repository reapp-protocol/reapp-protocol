# @reapp-sdk/core

Create an agent, connect to the live MandateRegistry contract on Stellar, and run a mandate-validated payment in under 10 lines.

`@reapp-sdk/core` is the high-level client for REAPP, a protocol for agent-driven payments where the spending limit lives inside a Soroban smart contract instead of the application. A user signs a mandate that fixes a budget, a single payee, and an expiry. An agent spends against that mandate, and every payment is validated and consumed on-chain by the contract before any money moves.

The SDK is untrusted by design. It never custodies funds and it never enforces the limit. If the SDK has a bug, or the agent key is stolen, the contract still rejects anything outside the mandate: overspending, paying the wrong merchant, replaying a payment, or paying after the user revokes.

## Install

```
npm install @reapp-sdk/core @stellar/stellar-sdk
```

`@stellar/stellar-sdk` is a direct dependency you also import yourself for `Keypair`. The package ships its own ESM build with TypeScript types.

## Quick start (Stellar testnet)

```ts
import { reapp } from "@reapp-sdk/core";
import { Keypair } from "@stellar/stellar-sdk";

const user = Keypair.fromSecret(USER_SECRET);   // owns the funds, signs the mandate
const agent = Keypair.fromSecret(AGENT_SECRET);  // the autonomous spender

const mandate = reapp.createIntentMandate({
  user: user.publicKey(),
  agent: agent.publicKey(),
  merchant: MERCHANT_ADDRESS,
  asset: reapp.testnet.nativeSac,        // native XLM as a SEP-41 token
  maxAmount: "5.00",                      // total budget the agent may spend
  expiry: Math.floor(Date.now() / 1000) + 3600,
});

await reapp.registerMandate(mandate, { signer: user });  // store the mandate on-chain
await reapp.approveBudget(mandate, { signer: user });     // SEP-41 allowance to the contract
const hash = await reapp.agent({ mandate, signer: agent }).pay("1.00"); // agent-signed payment
```

After `pay` returns, one real payment has settled on testnet. `hash` is the transaction hash, which you can open on a Stellar explorer.

## How it works

The flow has three signers and one contract. The user authorizes, the agent spends, and the contract is the gate every payment passes through.

1. `createIntentMandate` builds the mandate object and its canonical id locally. No network call happens here. The id is a hash of the mandate fields and becomes the on-chain storage key.
2. `registerMandate` writes the mandate to the contract, signed by the user. The contract sets `spent` to 0, `seq` to 0, and `status` to Active itself, so a caller cannot seed tampered state.
3. `approveBudget` grants a SEP-41 allowance up to the budget. The allowance goes to the **contract**, never to the agent or the SDK. This is the custody boundary: the agent can ask the contract to move money, but only the contract holds the right to pull from the user.
4. `pay` calls `execute_payment`, signed by the agent. The contract re-checks the agent, the sequence, the merchant scope, the expiry, and the remaining budget, then advances `spent` and `seq` and transfers the funds from user to merchant in one atomic step. If any check fails, the whole call reverts and `pay` throws.

## API

### `reapp.createIntentMandate(input, net?)`

Builds an AP2-style mandate and its on-chain id. Pure and local: no chain call.

| Field | Type | Meaning |
|---|---|---|
| `user` | `string` | Stellar address that owns the funds and signs the mandate |
| `agent` | `string` | The only address allowed to call `execute_payment` |
| `merchant` | `string` | The single payee this mandate is scoped to |
| `asset` | `string` | SEP-41 / SAC contract id of the token (use `reapp.testnet.nativeSac` for XLM) |
| `maxAmount` | `string` | Total budget as a decimal string, e.g. `"5.00"` |
| `expiry` | `number` | Unix seconds after which the mandate is dead |
| `decimals` | `number?` | Token decimals, default 7 (Stellar assets) |
| `nonce` | `string?` | Optional explicit nonce; defaults to a unique value so ids do not collide |

Returns an `IntentMandate` with the hex `id`, the raw `idBuffer`, the parsed fields, and `maxAmount` as a `bigint` in stroops.

### `reapp.registerMandate(mandate, { signer }, net?)`

Stores the mandate on-chain. Signed by the user. Returns the transaction hash.

### `reapp.approveBudget(mandate, { signer }, net?)`

Grants the contract a SEP-41 allowance up to the mandate budget. Signed by the user. Returns the transaction hash.

### `reapp.agent({ mandate, signer }, net?).pay(amount)`

Reads the current mandate sequence, then calls `execute_payment` for `amount` (a decimal string), signed by the agent. Returns the transaction hash. Throws if the contract rejects the payment.

### `reapp.revokeMandate(mandate, { signer }, net?)`

Marks the mandate revoked. Signed by the user. After this, every `pay` is rejected on-chain.

### `toStroops(human, decimals?)`

Converts a decimal string to stroops as a `bigint`. Strict by design, because this is money: only a non-negative decimal such as `"5"` or `"5.00"` is accepted. Negatives, scientific notation, garbage, or more fraction digits than `decimals` all throw rather than produce a wrong on-chain value.

### `Errors`

Typed contract error codes, re-exported so you can branch on a rejection.

The `signer` field on every user or agent call accepts either a `Keypair` or a raw secret string.

## Amounts

Amounts are decimal strings, not floats. `"5.00"`, `"0.01"`, and `"100"` are valid. The SDK converts them to integer stroops with the asset's decimals (7 by default) and rejects anything ambiguous, so you never round money by accident.

## Errors and what the contract refuses

When `pay` (or any call) is rejected on-chain, the SDK throws and the reason maps to a typed code. These are the guarantees a compromised agent or SDK cannot get around:

| Code | Name | Cause |
|---|---|---|
| `Errors[1]` | AlreadyExists | A mandate with that id is already registered |
| `Errors[2]` | NotFound | No mandate with that id |
| `Errors[4]` | MandateExpired | The payment happened at or after `expiry` |
| `Errors[5]` | MandateRevoked | The user revoked the mandate |
| `Errors[6]` | BudgetExceeded | The spend would push `spent` past `maxAmount` |
| `Errors[7]` | MerchantOutOfScope | The payee is not the mandate's merchant |
| `Errors[8]` | BadSequence | A replayed or out-of-order payment |
| `Errors[9]` | InvalidAmount | A non-positive amount |

```ts
try {
  await reapp.agent({ mandate, signer: agent }).pay("100.00");
} catch (err) {
  // The contract refused: budget, scope, expiry, replay, or revocation.
  // Inspect the thrown message, or compare against Errors[...] codes.
}
```

## Network

`@reapp-sdk/core` defaults to Stellar testnet and the live, audited MandateRegistry at `CA3X76MRIEHP7LVY6H4FIAOTRQYLSMD6NXUMVM5ZR56EOCCWMT6SBQCL`. Pass a custom `NetworkConfig` as the last argument to any call to point at a different RPC, passphrase, or contract.

```ts
reapp.testnet            // the default NetworkConfig
reapp.testnet.nativeSac  // native XLM as a SEP-41 contract id
reapp.testnet.mandateRegistryId // the live contract id
```

## Relationship to `@reapp-sdk/stellar`

`@reapp-sdk/core` is built on [`@reapp-sdk/stellar`](https://www.npmjs.com/package/@reapp-sdk/stellar), which holds the typed MandateRegistry bindings, network config, signing adapter, and SEP-41 helpers. Use `core` for the agent and payment flow. Drop down to `@reapp-sdk/stellar` only when you need direct, typed access to the contract.

## License

Apache-2.0.
