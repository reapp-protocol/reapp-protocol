# @reapp-sdk/stellar

The Soroban layer for **REAPP**, agent-driven payments on Stellar, enforced
on-chain by the **MandateRegistry** contract.

This package is the low-level building block: a **typed MandateRegistry client**
generated from the gatechecked contract ABI, network config for testnet, a keypair
signing adapter, and minimal SEP-41 token helpers.

> **Most apps want [`@reapp-sdk/core`](https://www.npmjs.com/package/@reapp-sdk/core), not this.**
> `core` wraps these pieces into a mandate-validated payment in under 10 lines.
> Reach for `@reapp-sdk/stellar` when you need direct, typed access to the contract.

## Install

```
npm install @reapp-sdk/stellar @stellar/stellar-sdk
```

## What it exports

| Export | What it is |
|---|---|
| `TESTNET` | `NetworkConfig` for Stellar testnet: RPC, passphrase, live MandateRegistry id, native asset |
| `registryClient(net, signer)` | Factory for the typed MandateRegistry client |
| `Client`, `Mandate`, `Errors` | Typed contract bindings: methods, the mandate struct, and typed error codes |
| `keypairSigner(keypair, passphrase)` | Adapt a Stellar `Keypair` into a transaction signer |
| `token.approve(...)`, `token.balance(...)` | Minimal SEP-41 token helpers |

`TESTNET.mandateRegistryId` points at the composite build
[`CBALARHTO5D7JLWHZ5KST4QNIRC64JI5H3DQDHMIUBSRLLOVS6FCWOQX`](https://stellar.expert/explorer/testnet/contract/CBALARHTO5D7JLWHZ5KST4QNIRC64JI5H3DQDHMIUBSRLLOVS6FCWOQX)
(MandateRegistry + clearing pools). The source-verified simple contract
[`CB4KOTLGMM5JEPFPU6QBJLADIBP3RSGUX44FOYTFRICNXKKFPYIW7ZOA`](https://stellar.expert/explorer/testnet/contract/CB4KOTLGMM5JEPFPU6QBJLADIBP3RSGUX44FOYTFRICNXKKFPYIW7ZOA)
stays live and is what current published npm versions pin; publishing this
package is the deliberate cutover step.

## Example: read a mandate straight from the contract

```ts
import { TESTNET, keypairSigner, registryClient } from "@reapp-sdk/stellar";
import { Keypair } from "@stellar/stellar-sdk";

const signer = keypairSigner(Keypair.fromSecret(SECRET), TESTNET.networkPassphrase);
const registry = registryClient(TESTNET, signer);

const mandate = (await registry.get_mandate({ mandate_id })).result.unwrap();
console.log(mandate.status, mandate.spent); // e.g. Active, 0
```

The contract is the source of truth: every spend is validated and consumed
on-chain by `execute_payment`, so a buggy or malicious client cannot exceed the
mandate. For the full agent → pay flow, use
[`@reapp-sdk/core`](https://www.npmjs.com/package/@reapp-sdk/core).

Apache-2.0.
