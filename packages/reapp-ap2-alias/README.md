# @reapp/ap2

Official compatibility name for [`@reapp-sdk/ap2`](https://www.npmjs.com/package/@reapp-sdk/ap2). It pins and re-exports the canonical AP2 v0.2 implementation; AP2 evolution remains isolated from the MandateRegistry and x402 wire adapter.

```bash
npm install @reapp/ap2@0.2.1 @stellar/stellar-sdk@14.5.0
```

```ts
import { InMemoryAp2ReplayStore, createAp2ComplianceValidator } from "@reapp/ap2";

const validator = createAp2ComplianceValidator({
  replayStore: new InMemoryAp2ReplayStore(),
  replayNamespace: "stellar-testnet:CC6JMPDH...CRWE",
});
const result = await validator.validateAndConsume({
  credential,
  expectedUser: USER_KEY.publicKey(),
  merchant: MERCHANT_ADDRESS,
  amount: "1.00",
});
```

API: signature and trusted-user verification, merchant scope, amount and expiry checks, atomic replay admission, strict AP2 profile normalization, and fail-closed binding into the contract-facing REAPP mandate. Contract enforcement remains authoritative for cumulative spending and payment replay.
