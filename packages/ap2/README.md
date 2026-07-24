# @reapp-sdk/ap2 0.4.0

AP2 v0.2 mandate admission, merchant verification, and typed authorization for
contract-enforced Stellar payments.

The package has two explicit boundaries:

- the admission bridge validates a deliberately narrow autonomous
  `mandate.payment.open.1` profile that maps into REAPP's unchanged core
  mandate; and
- the merchant APIs verify AP2 v0.2 open/closed Delegate SD-JWT Checkout and
  Payment chains, then create a compact authorization for the separate
  Soroban extension.

The pooled Composite route uses an explicitly named REAPP pool-participation
VCT because base AP2 does not define demand schedules or multi-user clearing.

## Install

```bash
npm install @reapp-sdk/ap2@0.4.0 @reapp-sdk/core@0.3.1 @stellar/stellar-sdk@14.5.0
```

## Quick start

```ts
import { Buffer } from "buffer";
import { StrKey } from "@stellar/stellar-sdk";
import {
  AP2_OPEN_PAYMENT_VCT,
  InMemoryAp2ReplayStore,
  createAp2ComplianceValidator,
  signAp2Mandate,
} from "@reapp-sdk/ap2";
import { reapp } from "@reapp-sdk/core";

const expiry = Math.floor(Date.now() / 1000) + 3600;
const checkoutReference = "sha256-of-associated-open-checkout-mandate";
const agentJwkX = Buffer.from(
  StrKey.decodeEd25519PublicKey(AGENT_KEY.publicKey()),
).toString("base64url");

const credential = signAp2Mandate({
  paymentMandate: {
    vct: AP2_OPEN_PAYMENT_VCT,
    constraints: [
      {
        type: "payment.allowed_payees",
        allowed: [{ id: MERCHANT_ADDRESS, name: "Research Merchant" }],
      },
      { type: "payment.amount_range", currency: "USD", max: 500 },
      { type: "payment.agent_recurrence", frequency: "ON_DEMAND" },
      { type: "payment.budget", currency: "USD", max: 5 },
      {
        type: "payment.execution_date",
        not_after: new Date(expiry * 1000).toISOString(),
      },
      {
        type: "payment.reference",
        conditional_transaction_id: checkoutReference,
      },
    ],
    cnf: { jwk: { kty: "OKP", crv: "Ed25519", x: agentJwkX } },
    exp: expiry,
  },
  stellar: {
    user: USER_KEY.publicKey(),
    agent: AGENT_KEY.publicKey(),
    asset: reapp.testnet.nativeSac,
    decimals: 7,
    currencyDecimals: 2,
  },
}, USER_KEY);

const validator = createAp2ComplianceValidator({
  replayStore: new InMemoryAp2ReplayStore(), // development only
  replayNamespace: `stellar-testnet:${reapp.testnet.mandateRegistryId}`,
});

const accepted = await validator.validateAndConsume({
  credential,
  expectedUser: USER_KEY.publicKey(),
  merchant: MERCHANT_ADDRESS,
  checkoutReference,
  amount: "1.00",
});

await reapp.registerMandate(accepted.binding.mandate, { signer: USER_KEY });
await reapp.approveBudget(accepted.binding.mandate, { signer: USER_KEY });
```

The trusted `expectedUser`, `merchant`, `checkoutReference`, and `amount` inputs
must come from application state, not untrusted HTTP fields.

## Supported v0.2 profile

The bridge follows the official
[AP2 v0.2.0 release](https://github.com/google-agentic-commerce/AP2/releases/tag/v0.2.0)
and accepts a deliberately narrow `mandate.payment.open.1` subset that maps to
the current REAPP payment model.

| AP2 field or constraint | REAPP behavior |
|---|---|
| `cnf` | Must be the RFC 8037 Ed25519 JWK corresponding to `stellar.agent`. |
| `payment.allowed_payees` | Required with exactly one merchant whose `id` is a Stellar address; becomes contract scope. |
| `payment.amount_range` | Required, with a positive safe-integer maximum in ISO-4217 minor units and no `min`. |
| `payment.budget` | Required; currency and maximum must exactly match the amount range after `currencyDecimals` conversion. |
| `payment.agent_recurrence` | Required as `ON_DEMAND` with no occurrence cap; cumulative spend/replay remain on-chain. |
| `payment.execution_date` | Required with canonical `not_after` only; it must equal `exp` and becomes contract expiry. |
| `payment.reference` | Required and compared with separately trusted checkout context during admission. |

Unknown fields, unknown constraints, duplicate constraints, additional payees,
bounded/frequency recurrence, minimum amounts, and `not_before` fail closed.
The asset and token decimals are Stellar-specific signed binding fields because
AP2's ISO-4217 model does not identify a SEP-41 token contract.

## Merchant open/closed verification

`verifyAp2CheckoutAuthorization` verifies the open/closed Checkout chain, the
merchant-signed Checkout JWT, disclosed constraints, merchant, currency, and
hash linkage. `verifyAp2MerchantAuthorization` adds the open/closed Payment
chain, exact pending amount/payee context, Payment-to-Checkout reference,
payment constraints, and cumulative usage when required.

The Delegate SD-JWT verifier supports selective disclosures, chained `cnf`
keys, predecessor hashes, terminal audience and nonce, bounded input, ES256,
and EdDSA. Callers supply trusted root-key and Checkout-JWT-key resolvers; the
package does not silently treat `kid` or `x5c` as trusted.

Supported Checkout and Payment constraints are evaluated rather than merely
parsed. Unknown constraints fail closed. Signed Checkout and Payment
success/error receipt helpers are included.

This covers the supported open/closed flow, but interoperability still depends
on the merchant accepting the issuer and trust profile chosen by the
application.

## Binding and signing

The bridge canonicalizes the normalized AP2 object with recursively sorted
object keys and a fixed constraint order:

```text
payment_mandate_hash = SHA-256(canonical normalized Open Payment Mandate)
core_nonce = "reapp-ap2/2:" + payment_mandate_hash + ":" + binding_nonce
vc_hash = existing @reapp-sdk/core mandate hash, including core_nonce
```

The user signs a domain-separated SHA-256 digest under
`REAPP\0AP2\0SIGNED-MANDATE\0V2\0`. The digest binds the full credential
payload, `reapp-ap2-credential/2`, AP2 version, VCT, binding version, and the
recomputed REAPP mandate hash.

The validator also accepts the exact `reapp-ap2-credential/1` envelope produced
by the legacy v0.1 package. Those credentials retain their v0.1
`IntentMandate`, `reapp-ap2/1` binding, V1 signature domain, merchant/amount
checks, expiry, and admission replay behavior. They are not upgraded,
normalized as v0.2, or allowed to mix version fields.

The core canonical field order is unchanged, so non-AP2 mandate ids remain
stable. Supply `stellar.nonce` only for reproducible vectors; otherwise Web
Crypto generates it.

## Enforcement and replay

`validateAndConsume` atomically consumes a mandate hash once at admission. A
production replay store must be durable, shared, and linearizable. Store errors
fail closed.

This validator is not the payment enforcement boundary. After admission, every
payment still routes through `MandateRegistry.execute_payment`, where merchant
scope, cumulative budget, expiry, revocation, authorization, and sequence are
checked and consumed atomically before transfer. The SEP-41 allowance remains
granted to the contract.

Existing mandates registered through the v0.1 bridge remain executable
on-chain because the contract interface and stored mandate shape have not
changed. The validator also admits a correctly signed v0.1 envelope with the
legacy rules. Together these provide AP2 v0.1 backwards compatibility without
weakening the v0.2 schema.

For a new Simple route, a separately deployed authorization extension can be
registered as the mandate's on-chain agent without changing Simple. The real
shopping agent authenticates to that extension for each exact capture.

Composite source support is opt-in. `verifyReappPoolParticipation` checks the
open/closed REAPP participation chain; `ap2ScheduleHash` matches Composite's
Soroban encoding; and `createAp2PoolParticipationAuthorization` creates the
typed verifier result consumed by `commit_child_ap2` and `clear_pool_ap2`.
Legacy and AP2 pools can coexist, but one pool cannot mix the two member modes.
The updated Composite and extension contracts are not deployed yet.

See [AP2 merchant verification and contract interoperability](../../docs/ap2-merchant-extension.md)
for route selection, security boundaries, schemas, and release status.

## Errors

`validateAndConsume` throws `Ap2ValidationError` with stable codes including:

- `INVALID_CREDENTIAL`, `UNSUPPORTED_VERSION`, `INVALID_SIGNATURE`
- `SIGNER_MISMATCH`, `BINDING_MISMATCH`
- `MERCHANT_MISMATCH`, `CHECKOUT_REFERENCE_MISMATCH`
- `INVALID_AMOUNT`, `AMOUNT_EXCEEDS_MANDATE`, `EXPIRED`
- `REPLAYED`, `REPLAY_STORE_UNAVAILABLE`

## API

| Export | Purpose |
|---|---|
| `signAp2Mandate(input, signer)` | Normalize, bind, and sign the supported v0.2 mandate. |
| `bindPaymentMandate(input)` | Normalize and bind without signing. |
| `normalizeAp2PaymentMandate(paymentMandate, stellar)` | Validate and canonicalize the supported subset. |
| `createAp2ComplianceValidator(options)` | Create the signature/context/amount/expiry/replay admission validator. |
| `InMemoryAp2ReplayStore` | Tests and single-process development only. |
| `canonicalizeJson(value)` | Deterministic recursively key-sorted JSON. |
| `parseSignedAp2V01Mandate` / `rebuildV01CredentialBinding` | Exact legacy v0.1 admission compatibility; no v0.2 reinterpretation. |
| `verifyDelegateSdJwtChain(chain, options)` | Verify bounded AP2 Delegate SD-JWT open/closed chains. |
| `Ap2JsonWebKey` | Package-owned structural JWK type accepted by the JWS APIs without coupling consumers to one `@types/node` layout. |
| `verifyAp2CheckoutAuthorization(input)` | Verify Checkout chain, signed Checkout JWT, context, and constraints. |
| `verifyAp2MerchantAuthorization(input)` | Verify linked Checkout and Payment chains against a pending capture. |
| `signAp2CheckoutReceipt` / `signAp2PaymentReceipt` | Sign AP2 success or error receipts. |
| `createAp2CaptureAuthorization(input)` | Bind verified standard evidence to a typed Simple or CompositeSolo capture. |
| `verifyReappPoolParticipation(input)` | Verify the REAPP open/closed pooled extension and exact expected terms. |
| `ap2ScheduleHash(schedule)` | Produce the byte-exact Composite schedule hash. |
| `createAp2PoolParticipationAuthorization(input)` | Bind verified Checkout and pool evidence to Composite participation. |
| `signAp2CaptureAuthorization` / `signAp2PoolParticipationAuthorization` | Sign the Soroban-typed verifier result. |

## Verification

```bash
npm run build -w @reapp-sdk/ap2
npm run test -w @reapp-sdk/ap2
```

Apache-2.0.
