# @reapp-sdk/stellar 0.2.2

The Soroban layer for **REAPP**, agent-driven payments on Stellar, enforced
on-chain by the **MandateRegistry** contract.

This package is the low-level building block: a **typed MandateRegistry client**
generated from the contract interface that passed the gate check, network config for testnet, a keypair
signing adapter, and minimal SEP-41 token helpers.

> **Most apps want [`@reapp-sdk/core`](https://www.npmjs.com/package/@reapp-sdk/core), not this.**
> `core` wraps these pieces into a mandate-validated payment in under 10 lines.
> Reach for `@reapp-sdk/stellar` when you need direct, typed access to the contract.

## Install

```
npm install @reapp-sdk/stellar@0.2.2 @stellar/stellar-sdk@14.5.0
```

## What it exports

| Export | What it is |
|---|---|
| `TESTNET` | `NetworkConfig` for Stellar testnet: RPC, passphrase, live MandateRegistry id, native asset |
| `registryClient(net, signer)` | Factory for the typed MandateRegistry client |
| `Client`, `Mandate`, `PendingUpgrade`, `Errors` | Typed contract bindings generated from the exact `simple-v0.2.3` release WASM |
| `keypairSigner(keypair, passphrase)` | Adapt a Stellar `Keypair` into a transaction signer |
| `token.approve(...)`, `token.balance(...)` | Minimal SEP-41 token helpers |

`TESTNET.mandateRegistryId` points at the upgradeable simple contract
[`CCHQ5G4Y4YBMY6D3TYYJSVJVCKUM22Q6TMKCCHVAHY4X7K6QELQACZRM`](https://stellar.expert/explorer/testnet/contract/CCHQ5G4Y4YBMY6D3TYYJSVJVCKUM22Q6TMKCCHVAHY4X7K6QELQACZRM).
Its on-chain WASM hash is
`ba370a80369daa0a0dea2554410dca6f2a9f7a76ba707cb92a83434e2fe76e87`,
matching the [`simple-v0.2.3` release artifact](https://github.com/reapp-protocol/reapp-protocol-contracts/releases/tag/simple-v0.2.3_contracts_simple_mandate_registry_mandate-registry_pkg0.2.3_cli25.1.0).
The binding exposes `get_admin`, `set_admin`, `pause`, `unpause`, `is_paused`,
`get_pending_upgrade`, `get_upgrade_delay`, and the one-hour
`schedule_upgrade`, `cancel_upgrade`, and `execute_upgrade` lifecycle alongside
the unchanged mandate interface. Upgrade execution requires current-admin auth,
an elapsed delay, and paused state; the contract ID and storage are preserved.

## Typed contract methods

| Method | Typed input or result |
|---|---|
| `register_mandate` | user, agent, merchant, asset, budget, expiry, and 32-byte mandate id |
| `get_mandate` | mandate id → `Result<Mandate>` |
| `validate_mandate` | mandate id, merchant, amount, and expected sequence → `Result<void>` |
| `execute_payment` | mandate id, amount, and expected sequence → contract-enforced transfer |
| `revoke_mandate` | mandate id → user-authorized revocation |
| `get_admin`, `set_admin` | read or rotate the operational authority |
| `pause`, `unpause`, `is_paused` | control or read the money-path stop state |
| `schedule_upgrade` | new 32-byte WASM hash → earliest execution timestamp |
| `get_pending_upgrade`, `cancel_upgrade` | inspect or cancel the scheduled change |
| `get_upgrade_delay` | fixed `3600n` seconds |
| `execute_upgrade` | same-address code replacement after all three controls pass |

## Example: read a mandate straight from the contract

```ts
import { TESTNET, keypairSigner, registryClient } from "@reapp-sdk/stellar";
import { Keypair } from "@stellar/stellar-sdk";

const signer = keypairSigner(Keypair.fromSecret(SECRET), TESTNET.networkPassphrase);
const registry = registryClient(TESTNET, signer);

const mandate = (await registry.get_mandate({ mandate_id })).result.unwrap();
console.log(mandate.status, mandate.spent); // e.g. Active, 0
```

Operational reads are typed too:

```ts
const admin = (await registry.get_admin()).result;
const paused = (await registry.is_paused()).result;
const delay = (await registry.get_upgrade_delay()).result; // 3600n
```

The contract is the source of truth: every spend is validated and consumed
on-chain by `execute_payment`, so a buggy or malicious client cannot exceed the
mandate. For the full agent → pay flow, use
[`@reapp-sdk/core`](https://www.npmjs.com/package/@reapp-sdk/core).

Apache-2.0.
