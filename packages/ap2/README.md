# @reapp-sdk/ap2 0.1.0

Bind a supported AP2 IntentMandate to REAPP's contract-enforced payment mandate on Stellar.

`@reapp-sdk/ap2` is deliberately narrow. It targets the AP2 v0.2.0 sample
`IntentMandate` data model and supports the human-not-present subset that REAPP
can enforce today: one merchant, explicit budget and asset, and a whole-second
expiry. It does not claim to implement the complete AP2 protocol, credential
signing or verification, Checkout Mandates, Payment Mandates, or x402.

## Install

```bash
npm install @reapp-sdk/ap2 @reapp-sdk/core @stellar/stellar-sdk
```

## Quick start

```ts
import { bindIntentMandate } from "@reapp-sdk/ap2";
import { reapp } from "@reapp-sdk/core";

const { mandate, intentHash } = bindIntentMandate({
  intent: {
    user_cart_confirmation_required: false,
    natural_language_description: "Buy one research dataset",
    merchants: [MERCHANT_ADDRESS],
    intent_expiry: new Date((Math.floor(Date.now() / 1000) + 3600) * 1000).toISOString(),
  },
  stellar: {
    user: USER_ADDRESS,
    agent: AGENT_ADDRESS,
    asset: reapp.testnet.nativeSac,
    maxAmount: "5.00",
  },
});

await reapp.registerMandate(mandate, { signer: USER_KEY });
await reapp.approveBudget(mandate, { signer: USER_KEY });
await reapp.agent({ mandate, signer: AGENT_KEY }).pay("1.00");
```

`intentHash` is evidence of the normalized AP2 payload. `mandate.id` is the
32-byte `vc_hash` stored by MandateRegistry.

## Supported AP2 subset

The bridge is pinned to [AP2 v0.2.0](https://github.com/google-agentic-commerce/AP2/releases/tag/v0.2.0)
and the official sample [`IntentMandate` data shape](https://github.com/google-agentic-commerce/AP2/blob/v0.2.0/code/sdk/python/ap2/models/mandate.py).

| AP2 field | REAPP behavior |
|---|---|
| `user_cart_confirmation_required` | Must be explicitly `false`. REAPP does not pretend to track an unimplemented cart-confirmation step. |
| `natural_language_description` | Canonically bound into `intentHash`; it is evidence, not contract policy. |
| `merchants` | Must contain exactly one valid Stellar address; that address becomes the contract-enforced merchant scope. |
| `intent_expiry` | Must be a future ISO 8601 timestamp with a timezone and whole-second precision; converted to the contract's Unix expiry. |
| `skus` | Must be absent or empty because MandateRegistry does not enforce SKU constraints. |
| `requires_refundability` | Must be absent or `false` because MandateRegistry does not enforce refundability. |

The Stellar authorization supplies the fields AP2's commerce intent does not:
the user, agent, SEP-41 asset contract, and maximum amount. MandateRegistry
enforces those values on every payment.

## Cryptographic binding

The bridge normalizes the supported AP2 fields, recursively sorts JSON object
keys, and computes:

```text
intent_hash = SHA-256(canonical AP2 JSON)
core_nonce  = "reapp-ap2/1:" + intent_hash + ":" + binding_nonce
vc_hash     = existing @reapp-sdk/core mandate hash, including core_nonce
```

The default binding nonce comes from Web Crypto. Supply `stellar.nonce` only
for reproducible vectors. The existing core field order is unchanged, so this
package cannot silently change ids created by `@reapp-sdk/core`.

## Trust boundary

This package validates and translates input; it is not the spending gate. The
SDK remains untrusted infrastructure. Money still moves only through
`MandateRegistry.execute_payment`, where caller authorization, merchant scope,
asset, budget, expiry, status, and sequence are checked and consumed atomically.

The bridge does not verify an AP2 Verifiable Credential. Verify any external
credential before calling the bridge, and keep that verification separate from
contract enforcement. The user-authorized on-chain registration remains the
REAPP authorization boundary.

## API

| Export | Purpose |
|---|---|
| `bindIntentMandate(input)` | Validate and bind the supported AP2 intent to a REAPP core mandate. |
| `normalizeAp2Intent(intent)` | Produce the exact fail-closed normalized AP2 subset and Unix expiry. |
| `canonicalizeJson(value)` | Deterministic recursively key-sorted JSON for supported values. |
| `AP2_SPEC_VERSION` | Pinned upstream version: `0.2.0`. |
| `AP2_INTENT_DATA_KEY` | Upstream data key: `ap2.mandates.IntentMandate`. |
| `REAPP_AP2_BINDING_VERSION` | Binding algorithm identifier: `reapp-ap2/1`. |

The package declarations also export `Ap2IntentMandate`,
`NormalizedAp2IntentMandate`, `StellarMandateAuthorization`,
`BindIntentMandateInput`, `Ap2MandateBinding`, and `CanonicalJsonValue` for
strict TypeScript integrations.

## Current contract target

The `reapp.testnet` default in the example resolves through
`@reapp-sdk/stellar` to the upgradeable simple MandateRegistry:

- Contract: [`CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE`](https://stellar.expert/explorer/testnet/contract/CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE)
- WASM SHA-256: `13f7023d4a361b6e49d3d39f61f55c5eeece51a602013a3cddae420d2ce8552b`
- Reproducible release: [`simple-v0.2.0`](https://github.com/reapp-protocol/reapp-protocol-contracts/releases/tag/simple-v0.2.0_contracts_simple_mandate_registry_mandate-registry_pkg0.2.0_cli25.1.0)

The bridge prepares the mandate; every payment still goes through the contract's
`execute_payment` enforcement path.

Apache-2.0.
