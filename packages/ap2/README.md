# @reapp-sdk/ap2 0.3.0

Signed AP2 v0.1 REAPP profile validation for contract-enforced Stellar payments.

`@reapp-sdk/ap2` turns the supported AP2 v0.1 `IntentMandate` subset into a
versioned Stellar Ed25519 credential, validates it at mandate admission, and
returns the exact REAPP mandate that must be registered on-chain. The validator
checks the signature, trusted user, merchant scope, amount, expiry, binding
hash, and one-time admission replay state.

This is deliberately a narrow **REAPP profile for AP2 v0.1**, not a universal
verifier for every upstream AP2 VC or JWS format. It has no HTTP or x402
dependency, so later AP2 or x402 wire changes can be handled by adapters without
redesigning `MandateRegistry`.

## Install

```bash
npm install @reapp-sdk/ap2@0.3.0 @reapp-sdk/core@0.3.1 @stellar/stellar-sdk@14.5.0
```

## Signed validator quick start

```ts
import {
  InMemoryAp2ReplayStore,
  createAp2ComplianceValidator,
  signAp2Mandate,
} from "@reapp-sdk/ap2";
import { reapp } from "@reapp-sdk/core";

const credential = signAp2Mandate({
  intent: {
    user_cart_confirmation_required: false,
    natural_language_description: "Buy one research dataset",
    merchants: [MERCHANT_ADDRESS],
    intent_expiry: new Date((Math.floor(Date.now() / 1000) + 3600) * 1000).toISOString(),
  },
  stellar: {
    user: USER_KEY.publicKey(),
    agent: AGENT_KEY.publicKey(),
    asset: reapp.testnet.nativeSac,
    maxAmount: "5.00",
  },
}, USER_KEY);

const validator = createAp2ComplianceValidator({
  replayStore: new InMemoryAp2ReplayStore(), // development only
  replayNamespace: `stellar-testnet:${reapp.testnet.mandateRegistryId}`,
});

const accepted = await validator.validateAndConsume({
  credential,
  expectedUser: USER_KEY.publicKey(), // trusted session/account identity
  merchant: MERCHANT_ADDRESS,         // trusted endpoint configuration
  amount: "1.00",                    // semantic amount, not a wire-format claim
});

await reapp.registerMandate(accepted.binding.mandate, { signer: USER_KEY });
await reapp.approveBudget(accepted.binding.mandate, { signer: USER_KEY });
await reapp.agent({ mandate: accepted.binding.mandate, signer: AGENT_KEY }).pay("1.00", {
  onPrepared: (pending) => paymentJournal.save(pending),
});
```

`expectedUser`, `merchant`, and `amount` must come from trusted application
state. The validator never authorizes a payment from untrusted HTTP fields.

## Replay semantics

`validateAndConsume` consumes a mandate hash once at signed-mandate admission or
registration. It is **not** called before every purchase: a REAPP mandate is
intentionally multi-use.

After admission, every payment still goes through
`MandateRegistry.execute_payment`. The contract atomically enforces the stored
merchant, cumulative budget, expiry, agent authorization, and monotonic
sequence. The SDK and this validator are untrusted infrastructure; neither can
bypass the on-chain money path.

`InMemoryAp2ReplayStore` is only for tests, demos, and one-process development.
Production must provide a durable, shared, linearizable `consumeOnce(record)`
implementation. A store error or unsupported result fails closed.

```ts
import type { Ap2ReplayStore } from "@reapp-sdk/ap2";

const replayStore: Ap2ReplayStore = {
  async consumeOnce(record) {
    // Atomically insert record.key with a uniqueness constraint.
    // Return "consumed" only for the winning insert, otherwise "duplicate".
    return durableAtomicInsert(record);
  },
};
```

## What is signed

`signAp2Mandate` first runs the same fail-closed AP2-to-REAPP binding used by
`bindIntentMandate`. The credential contains:

- exact credential, AP2, data-key, binding, and signature algorithm versions;
- the normalized one-merchant AP2 intent;
- the Stellar user, agent, asset, maximum amount, decimals, and binding nonce;
- the recomputed REAPP mandate hash; and
- a canonical 64-byte Stellar Ed25519 signature.

The signature is over a SHA-256 digest with the fixed
`REAPP\0AP2\0SIGNED-MANDATE\0V1\0` domain, all version identifiers, the SHA-256
of the full canonical credential payload, and the 32-byte mandate hash. The
payload hash also binds client interpretation fields such as token decimals,
even when they are not part of the core mandate id. The user public key is taken
from the signed payload and must equal the separately trusted `expectedUser`;
an attacker cannot authorize their own self-signed replacement.

The validator rejects unknown keys at every credential level. That is
intentional: if a later AP2 version adds a constraint this implementation does
not understand, it fails closed instead of silently dropping the field.

## Supported AP2 subset

The profile is pinned to [AP2 v0.1.0](https://github.com/google-agentic-commerce/AP2/releases/tag/v0.1.0)
and its sample [`IntentMandate` data shape](https://github.com/google-agentic-commerce/AP2/blob/v0.1.0/src/ap2/types/mandate.py).

| AP2 field | REAPP behavior |
|---|---|
| `user_cart_confirmation_required` | Must be explicitly `false`; cart-confirmation state is not enforced by the contract. |
| `natural_language_description` | Canonically bound into `intentHash`; evidence, not contract policy. |
| `merchants` | Exactly one valid Stellar address; becomes the contract-enforced merchant scope. |
| `intent_expiry` | Future ISO 8601 timestamp with timezone and whole-second precision; the signed credential stores canonical UTC. |
| `skus` | Absent or empty because `MandateRegistry` does not enforce SKU constraints. |
| `requires_refundability` | Absent or `false` because `MandateRegistry` does not enforce refundability. |

## Binding algorithm

The bridge normalizes the supported AP2 fields, recursively sorts JSON object
keys, and computes:

```text
intent_hash = SHA-256(canonical AP2 JSON)
core_nonce  = "reapp-ap2/1:" + intent_hash + ":" + binding_nonce
vc_hash     = existing @reapp-sdk/core mandate hash, including core_nonce
```

The default binding nonce comes from Web Crypto. Supply `stellar.nonce` only
for reproducible test vectors. Existing non-AP2 mandate ids and core field
ordering are unchanged.

## Errors

`validateAndConsume` throws `Ap2ValidationError` with a stable `code`:

| Code | Meaning |
|---|---|
| `INVALID_CREDENTIAL` | Malformed, unknown, noncanonical, or invalid identity data. |
| `UNSUPPORTED_VERSION` | Credential, AP2, data-key, binding, or signature version is unsupported. |
| `INVALID_SIGNATURE` | Signature encoding or Ed25519 verification failed. |
| `SIGNER_MISMATCH` | Signed user differs from trusted `expectedUser`. |
| `BINDING_MISMATCH` | Payload does not recompute to the envelope mandate hash. |
| `MERCHANT_MISMATCH` | Requested merchant is outside signed scope. |
| `INVALID_AMOUNT` | Amount is zero, negative, malformed, over-precision, or outside i128. |
| `AMOUNT_EXCEEDS_MANDATE` | Requested amount is greater than the signed maximum. |
| `EXPIRED` | Expiry is equal to or earlier than the trusted clock. |
| `REPLAYED` | The same mandate hash was already admitted in this namespace. |
| `REPLAY_STORE_UNAVAILABLE` | Atomic replay storage failed or returned an invalid result. |

## API

| Export | Purpose |
|---|---|
| `signAp2Mandate(input, signer)` | Bind and sign the supported AP2 intent with the Stellar user key. |
| `createAp2ComplianceValidator(options)` | Create the signature/scope/amount/expiry/replay validator with an injected store and clock. |
| `Ap2ValidationError` | Typed fail-closed error with stable codes. |
| `InMemoryAp2ReplayStore` | Single-process development and test replay store. |
| `bindIntentMandate(input)` | Validate and bind without producing a signed envelope. |
| `normalizeAp2Intent(intent)` | Normalize the exact enforceable AP2 subset. |
| `canonicalizeJson(value)` | Deterministic recursively key-sorted JSON for binding evidence. |

TypeScript declarations also expose the credential, validator input/result,
replay-store, intent, binding, and authorization interfaces.

## Verification

```bash
npm run build -w @reapp-sdk/ap2
npm run test -w @reapp-sdk/ap2
```

The package has 59 tests: 12 stable binding/vector tests plus 47 validator tests
covering valid credentials, tampering, every version boundary, malformed
signatures, trusted signer and merchant scope, exact amount limits, overspend,
expiry, replay, 100-way concurrent admission, store outages, replay poisoning,
and namespace isolation.

## Current contract target

The default is the upgradeable simple `MandateRegistry` on Stellar testnet:

- Contract: [`CCHQ5G4Y4YBMY6D3TYYJSVJVCKUM22Q6TMKCCHVAHY4X7K6QELQACZRM`](https://stellar.expert/explorer/testnet/contract/CCHQ5G4Y4YBMY6D3TYYJSVJVCKUM22Q6TMKCCHVAHY4X7K6QELQACZRM)
- WASM SHA-256: `ba370a80369daa0a0dea2554410dca6f2a9f7a76ba707cb92a83434e2fe76e87`
- Reproducible release: [`simple-v0.2.3`](https://github.com/reapp-protocol/reapp-protocol-contracts/releases/tag/simple-v0.2.3_contracts_simple_mandate_registry_mandate-registry_pkg0.2.3_cli25.1.0)

Apache-2.0.
