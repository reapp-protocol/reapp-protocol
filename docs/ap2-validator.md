# AP2 v0.2 bridge validator

`@reapp-sdk/ap2` provides both REAPP's signed AP2 v0.2 Open Payment admission
profile and merchant-facing open/closed Delegate SD-JWT verification.

The admission profile is intentionally narrow: strict schema/version
boundaries, Stellar Ed25519 user and agent binding, one payee, matching amount
and cumulative budget, expiry, checkout reference, binding hash, and atomic
admission replay. The merchant APIs separately verify open/closed Checkout and
Payment chains, selective disclosures, linkage, supported constraints, and
receipts. Unsupported constraints fail closed. AP2 and x402 remain separate
from `MandateRegistry`.

## Local validation

```bash
npm install @reapp-sdk/ap2@0.4.0 @reapp-sdk/core@0.3.1 @stellar/stellar-sdk
```

See the package [quick start](../packages/ap2/README.md#quick-start) for the full
construction and validation example.

`validateAndConsume` requires trusted `expectedUser`, `merchant`,
`checkoutReference`, and `amount` inputs. On success it returns the exact core
mandate to register. Its replay check is admission-only; cumulative spending
and payment replay remain atomically enforced on-chain.

## Moving from AP2 v0.1

Mandates already registered through the v0.1 bridge remain executable because
the contract interface and stored `Mandate` shape are unchanged. The new
admission bridge supplies the same contract-facing fields, so no Simple
registry change is needed. This is AP2 v0.1 backwards compatibility.

Credential admission recognizes both versioned envelopes. A
`reapp-ap2-credential/1` value follows the exact legacy v0.1 IntentMandate
schema and validation rules; `reapp-ap2-credential/2` follows the v0.2 Open
Payment profile and additionally requires trusted checkout-reference context.
Cross-version hybrids and unknown versions fail closed.

The source implementation also supports a separate AP2 authorization contract
and an AP2-aware Composite pool mode. Simple and released Composite children
use distinct typed capture kinds. Pooled children use the REAPP
pool-participation VCT, exact schedule hash, commit-time authorization, and
capture-time Composite hook. Legacy and AP2 pools coexist but do not mix
member modes inside one pool.

The [merchant interoperability document](ap2-merchant-extension.md) explains
the flows and current release boundary. The extension and updated Composite
source are locally tested but not deployed, so the published testnet contracts
do not yet expose those new routes.

## Test suite

```bash
npm test -w @reapp-sdk/ap2
```

The package suite contains 56 named cases, including 30 individually reported
validator cases. It covers canonical admission binding, open/closed SD-JWT chains,
disclosures, Checkout/Payment linkage, known and unknown constraints,
merchant/amount context, receipts, REAPP pool participation, byte-exact
Soroban authorization vectors, expiry, replay concurrency, store outages, and
replay poisoning.
