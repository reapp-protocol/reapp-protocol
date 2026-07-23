# AP2 compliance validator

`@reapp-sdk/ap2` verifies the Stellar Ed25519 signature, separately trusted user,
single-merchant scope, amount, expiry, binding hash, strict schema, and atomic
admission replay state. AP2 and x402 adapters are isolated from the MandateRegistry,
so their profile/wire logic can evolve without touching the contract.

## Validate your own mandate — local and offline

Nothing to clone; validation runs in-process (no chain, no testnet).

```bash
npm install @reapp-sdk/ap2@0.3.0 @reapp-sdk/core@0.3.1 @stellar/stellar-sdk
```

```js
// validate.mjs — sign an AP2 IntentMandate, then check it accepts and fails closed.
import { Keypair } from "@stellar/stellar-sdk";
import { reapp } from "@reapp-sdk/core";
import { signAp2Mandate, createAp2ComplianceValidator, InMemoryAp2ReplayStore } from "@reapp-sdk/ap2";

const user = Keypair.random(), agent = Keypair.random(), merchant = Keypair.random();

const credential = signAp2Mandate({
  intent: {
    user_cart_confirmation_required: false,
    natural_language_description: "Buy one research dataset",
    merchants: [merchant.publicKey()],
    intent_expiry: new Date((Math.floor(Date.now() / 1000) + 3600) * 1000).toISOString(),
  },
  stellar: {
    user: user.publicKey(),
    agent: agent.publicKey(),
    asset: reapp.testnet.nativeSac,
    maxAmount: "5.00",
  },
}, user);

const check = () => createAp2ComplianceValidator({ replayStore: new InMemoryAp2ReplayStore(), replayNamespace: "local" });
const req = (over = {}) => ({ credential, expectedUser: user.publicKey(), merchant: merchant.publicKey(), amount: "1.00", ...over });

console.log("accepted   ", (await check().validateAndConsume(req())).mandateHash.slice(0, 10) + "…");
for (const [label, over] of [["overspend", { amount: "6.00" }], ["wrong merchant", { merchant: Keypair.random().publicKey() }]]) {
  try { await check().validateAndConsume(req(over)); console.log("NOT rejected:", label); }
  catch (e) { console.log("rejected   ", label, "->", e.code); }
}
```

```bash
node validate.mjs
# accepted    mandate 4001e01f3d…
# rejected    overspend -> AMOUNT_EXCEEDS_MANDATE
# rejected    wrong merchant -> MERCHANT_MISMATCH
```

Tamper any signed field — amount, merchant, expiry, the signature itself — and
`validateAndConsume` throws an `Ap2ValidationError` with a stable `code`
(`AMOUNT_EXCEEDS_MANDATE`, `MERCHANT_MISMATCH`, `EXPIRED`, `INVALID_SIGNATURE`,
`REPLAYED`, …). The full API and every field are documented in the package README.

## Test suite

From a clone of the monorepo, the full suite runs with `npm test -w @reapp-sdk/ap2`:
59 passing tests including valid mandates, altered signatures, wrong merchants,
overspend, expiry, replay, schema mutation, and store failure.
