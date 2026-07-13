# @reapp/stellar

Official compatibility name for [`@reapp-sdk/stellar`](https://www.npmjs.com/package/@reapp-sdk/stellar). It re-exports the exact canonical package and pins that implementation to the same version; it does not fork contract bindings or network configuration.

```bash
npm install @reapp/stellar@0.2.1 @stellar/stellar-sdk@14.5.0
```

```ts
import { TESTNET, registryClient, keypairSigner, token } from "@reapp/stellar";

console.log(TESTNET.mandateRegistryId);
const client = registryClient(TESTNET, keypairSigner(agent, TESTNET.networkPassphrase));
const balance = await token.balance(TESTNET, TESTNET.nativeSac, user.publicKey());
```

API: `TESTNET`, `DEPLOYMENTS`, the generated `Client` and contract types, `registryClient`, `keypairSigner`, and the `token` helpers. The current testnet default is the upgradeable simple MandateRegistry `CC6JMPDH…CRWE`.
