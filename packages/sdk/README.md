# @reapp-sdk/core 0.3.1

Create an agent, connect to the live MandateRegistry contract on Stellar, and run a crash-safe mandate-validated payment through a small typed surface.

`@reapp-sdk/core` is the high-level client for REAPP, a protocol for agent-driven payments where the spending limit lives inside a Soroban smart contract instead of the application. A user signs a mandate that fixes a budget, a single payee, and an expiry. An agent spends against that mandate, and every payment is validated and consumed on-chain by the contract before any money moves.

The SDK is untrusted by design. It never custodies funds and it never enforces the limit. If the SDK has a bug, or the agent key is stolen, the contract still rejects anything outside the mandate: overspending, paying the wrong merchant, replaying a payment, or paying after the user revokes.

## Install

```
npm install @reapp-sdk/core@0.3.1 @stellar/stellar-sdk@14.5.0
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
const hash = await reapp.agent({ mandate, signer: agent }).pay("1.00", {
  // Must durably save the signed hash before the SDK broadcasts it.
  onPrepared: (pending) => paymentJournal.save(pending),
});
```

After `pay` returns, one real payment has settled on testnet. `hash` is the transaction hash, which you can open on a Stellar explorer.

## How it works

The flow has three signers and one contract. The user authorizes, the agent spends, and the contract is the gate every payment passes through.

1. `createIntentMandate` builds the mandate object and its canonical id locally. No network call happens here. The id is a hash of the mandate fields and becomes the on-chain storage key.
2. `registerMandate` writes the mandate to the contract, signed by the user. The contract sets `spent` to 0, `seq` to 0, and `status` to Active itself, so a caller cannot seed tampered state.
3. `approveBudget` approves a SEP-41 allowance up to the budget. The allowance goes to the **contract**, never to the agent or the SDK. This is the custody boundary: the agent can ask the contract to move money, but only the contract holds the right to pull from the user.
4. `pay` calls `execute_payment`, signed by the agent. The contract re-checks the agent, the sequence, the merchant scope, the expiry, and the remaining budget, then advances `spent` and `seq` and transfers the funds from user to merchant in one atomic step. If any check fails, the whole call reverts and `pay` throws.

## Paying for a resource (bound-v2 x402)

`agent.fetch(url)` is the x402 client. For new paid endpoints, create the agent
with `proofPolicy: "bound-v2-only"`. It advertises the bound-v2 capability and
refuses a legacy challenge before paying. The authenticated challenge fixes the
merchant's exact public origin, GET method, path and query, network, registry, merchant, asset,
amount, decimals, and validity window. After `execute_payment` settles, the
agent signs that exact challenge together with the transaction hash and mandate
id, then retries with the bound proof.

The contract still enforces the spending limit. A revoked, expired,
over-budget, replayed, or out-of-scope payment is rejected on-chain; neither the
SDK nor a cached mandate can bypass `execute_payment`.

```ts
import { getSettlementReceipt } from "@reapp-sdk/core";

const agent = reapp.agent({
  mandate,
  signer: agentKey,
  proofPolicy: "bound-v2-only",
  receiptStore, // required for paid fetch; durable SettlementReceiptStore
});
const res = await agent.fetch("https://merchant.example/report");
const data = await res.json(); // served only after the merchant verified the on-chain payment

const receipt = getSettlementReceipt(res); // exact proof for audit/recovery
await persistAcceptedResult(data, receipt); // application-owned durable commit
await agent.acknowledgeDelivery(receipt!);   // only now clear the payment lock
```

Before broadcast, the agent signs the transaction, derives its canonical hash
and validity deadline, and makes the exact receipt durable. If that storage write
fails, `fetch` aborts before broadcast and propagates the storage error. Once the
receipt is durable, any uncertain broadcast/final ledger result, paid-retry
network failure, non-2xx status, or incomplete body throws
`DeliveryPendingError` with that `SettlementReceipt`. Do not call `fetch` again,
because a fresh `402` could create another payment. Reconcile and retry the exact
existing proof:

```ts
import { DeliveryPendingError } from "@reapp-sdk/core";

try {
  await agent.fetch("https://merchant.example/report");
} catch (error) {
  if (error instanceof DeliveryPendingError) {
    console.log("prepared payment transaction", error.receipt.txHash);
    const response = await agent.retryDelivery(error.receipt);
    const result = await response.json();
    await persistAcceptedResult(result, error.receipt);
    await agent.acknowledgeDelivery(error.receipt);
    // No payment or signature occurs during retryDelivery.
  } else {
    throw error;
  }
}
```

`retryDelivery` verifies the receipt id, mandate, proof version, exact signed
origin, method, path, and query. It never pays or signs and always disables
redirects so proof material cannot be forwarded to another origin. A retry is
not ready for acknowledgment until the complete successful response body has
been received. The receipt remains durable and blocks another payment until the
application validates/persists its business result and explicitly calls
`acknowledgeDelivery`. Treat every receipt as sensitive bearer data for its exact request.
A production merchant also needs one durable, linearizable settlement claim and
immutable-result store keyed by the settlement so a lost response can replay the
same bytes without charging or running fulfillment again.

The x402 wire format lives in its own module, so it tracks the evolving x402 spec
without touching the mandate or the contract. Use
[`@reapp-sdk/express-middleware`](https://www.npmjs.com/package/@reapp-sdk/express-middleware)
to build an Express 4/5 merchant that independently verifies the on-chain
settlement before serving.

## API

### `reapp.createIntentMandate(input, net?)`

Builds an AP2-style mandate and its on-chain id locally, with no chain call. The default nonce makes each id unique; pass an explicit `nonce` for a deterministic id.

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

Approves the contract for a SEP-41 allowance up to the mandate budget. Signed by the user. Returns the transaction hash.

### `reapp.agent({ mandate, signer }, net?).pay(amount, lifecycle)`

Reads the current mandate sequence, then calls `execute_payment` for `amount` (a decimal string), signed by the agent. Returns the transaction hash. Throws if the contract rejects the payment.

Every direct `pay` call must pass a `PaymentSubmissionLifecycle`. Its async
`onPrepared` hook receives the signed hash, sequence, and exact validity deadline
before any broadcast; persist that record atomically or throw to abort without
sending. REAPP's CLI uses this hook and refuses another payment until
`settlement reconcile` proves the result and an exact successful hash is
explicitly acknowledged.

For a user-visible operation that may be retried after a lost HTTP response,
also pass its immutable `expectedSeq`. The SDK compares it with current contract
state before signing. If a prior attempt already consumed that sequence, retry
fails before another transaction is created; the contract repeats the same check
at execution. Concurrent same-mandate operations in one process are rejected by
a synchronous claim before the first chain read.

### `reapp.agent({ mandate, signer, proofPolicy?, receiptStore? }, net?)`

Creates an agent. Set `proofPolicy` to `"bound-v2-only"` for every new paid
endpoint. The default `"legacy-compatible"` exists only for migrations.
`receiptStore` implements `SettlementReceiptStore` and is required before any
402-triggered payment. `savePending` must become durable before transaction
broadcast, `listPending` lets a new process restore the no-second-payment lock,
and `clearPending` records explicit application acknowledgment after full-body
success.

### `agent.fetch(url, init?)`

The x402 client. It requests `url` with bound-v2 capability negotiation; on a
valid `402` it checks the request and mandate binding, signs the transaction,
persists its hash plus bound proof before broadcast, pays on-chain through the
same `pay` path, and retries with `X-PAYMENT`. Automatic redirects are disabled
before and after settlement.
A non-402 response is returned unchanged, with no payment.

If the paid retry fails to connect, returns a non-2xx status, or fails before the
full successful response body is received after settlement, throws
`DeliveryPendingError` carrying a `SettlementReceipt` with the transaction hash
and exact proof. A submitted-but-unconfirmed transaction also produces the same
recoverable receipt and blocks every new payment on that agent until it is
reconciled.

### `agent.retryDelivery(receipt, init?)`

Retries HTTP delivery with the receipt's existing `X-PAYMENT` proof. It never
calls `pay`, never signs, and never submits a transaction. It rejects a receipt
belonging to a different mandate or exact signed request. With a configured
receipt store, successful full-body delivery remains pending until the
application acknowledges it.

### `agent.acknowledgeDelivery(receipt)`

Validates the exact receipt and removes it from durable pending state. Call this
only after the complete HTTP body has been validated and the business result is
durably accepted. If acknowledgment storage fails, it throws
`DeliveryPendingError` and keeps new payments blocked. This explicit boundary
prevents a crash between transport success and application commit from silently
creating a second purchase.

### `agent.getPendingSettlement()` and `agent.reconcilePendingSettlement()`

`getPendingSettlement` returns the captured hash, sequence, and validity deadline
for a prepared transaction whose broadcast/final result or paid delivery has not
been closed. While it is present, `pay` and `fetch` fail closed instead of
risking a second payment. On restart, the first operation hydrates the same lock
from `receiptStore.listPending`. After restarting a direct-pay process, pass the
exact durable journal record to `reconcilePendingSettlement(record)`; it
validates the mandate and queries that hash without submitting anything. The
result is `pending`, `failed`, `expired`, or `succeeded`. A succeeded settlement
with a receipt remains locked until recovery and explicit application
acknowledgment finish the original delivery.

### `getSettlementReceipt(response)`

Returns the immutable receipt attached to a successful paid response. It
includes `receiptId`, proof version, exact URL and method, transaction hash,
mandate id, amount, and the full settlement proof.

### `DeliveryPendingError`, `SettlementUncertainError`, `SettlementReceipt`, and `SettlementReceiptStore`

Typed post-submission recovery evidence. The error means a canonical transaction
hash exists and starting another payment is unsafe until that same hash is
reconciled and its delivery is closed. Surface the hash to the user and retry
the same receipt; never start another payment automatically. A receipt store
must protect the full proof as sensitive data and provide atomic durable
`savePending`, `listPending`, and `clearPending` operations. Multi-process
consumers also need shared linearizable storage rather than the reference file
store.

`SettlementUncertainError` is the direct-`pay` equivalent: broadcast was
attempted and the transaction may have been submitted, but the SDK did not prove
a final ledger result. Retain its transaction hash and call
`reconcilePendingSettlement` on the same agent before attempting any other spend.

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
| `Errors[10]` | Paused | The contract's money path is paused |
| `Errors[11]` | UpgradeNotScheduled | No upgrade is pending |
| `Errors[12]` | UpgradeNotReady | The one-hour delay has not elapsed |
| `Errors[13]` | UpgradeAlreadyScheduled | An upgrade is already pending |
| `Errors[14]` | UpgradeRequiresPause | Execution requires paused state |

```ts
try {
  await reapp.agent({ mandate, signer: agent }).pay("100.00", {
    onPrepared: (pending) => paymentJournal.save(pending),
  });
} catch (err) {
  // The contract refused: budget, scope, expiry, replay, or revocation.
  // Inspect the thrown message, or compare against Errors[...] codes.
}
```

## Network

`@reapp-sdk/core` defaults to Stellar testnet and the upgradeable simple
MandateRegistry pinned in `@reapp-sdk/stellar`:
[`CCHQ5G4Y4YBMY6D3TYYJSVJVCKUM22Q6TMKCCHVAHY4X7K6QELQACZRM`](https://stellar.expert/explorer/testnet/contract/CCHQ5G4Y4YBMY6D3TYYJSVJVCKUM22Q6TMKCCHVAHY4X7K6QELQACZRM).
Pass a custom `NetworkConfig` as the last argument to any call to select a
different compatible deployment, RPC, or passphrase.

The current contract WASM SHA-256 is
`ba370a80369daa0a0dea2554410dca6f2a9f7a76ba707cb92a83434e2fe76e87`,
matching the reproducible [`simple-v0.2.3` release](https://github.com/reapp-protocol/reapp-protocol-contracts/releases/tag/simple-v0.2.3_contracts_simple_mandate_registry_mandate-registry_pkg0.2.3_cli25.1.0).

```ts
reapp.testnet            // the default NetworkConfig
reapp.testnet.nativeSac  // native XLM as a SEP-41 contract id
reapp.testnet.mandateRegistryId // the live contract id
```

## Relationship to `@reapp-sdk/stellar`

`@reapp-sdk/core` is built on [`@reapp-sdk/stellar`](https://www.npmjs.com/package/@reapp-sdk/stellar), which holds the typed MandateRegistry bindings, network config, signing adapter, and SEP-41 helpers. Use `core` for the agent and payment flow. Drop down to `@reapp-sdk/stellar` only when you need direct, typed access to the contract.

## License

Apache-2.0.
