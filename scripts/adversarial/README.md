# Adversarial suite — attack the SDK, watch the contract hold

These scripts try to make REAPP misbehave. They act as a hostile or buggy SDK
and attempt to move money outside a mandate: overspend, replay, pay the wrong
merchant, pay after revocation, pay after expiry, forge an AP2 credential, and
call the token directly. Every attempt is rejected by the deployed
MandateRegistry, and two scripts measure the enforcement on-chain rather than
asserting it.

Everything runs on Stellar testnet against real deployed contracts. Each script
creates fresh ephemeral actors and funds them via friendbot, so no keys, no
`.env`, and no funded account are required.

## Run

```bash
npm ci
npm run build
npm run adversarial:testnet        # all six scripts
```

Or one at a time:

```bash
node scripts/adversarial/a3-bypass-attempts.mjs
```

The scripts import the workspace packages (`@reapp-sdk/core`,
`@reapp-sdk/stellar`, `@reapp-sdk/ap2`, `@reapp-sdk/express-middleware`), so they
exercise the code in this repository. To attack the **published** packages
instead, copy a script into an empty directory and
`npm install @reapp-sdk/core@0.3.1 @reapp-sdk/stellar@0.2.2 @reapp-sdk/ap2@0.4.0 @reapp-sdk/express-middleware@0.2.2 @stellar/stellar-sdk@14.5.0 express@5.2.1`.

## What each script proves

| Script | Attack | Expected outcome |
|---|---|---|
| `a1-lifecycle.mjs` | register → pay → overspend → revoke → expire | overspend, pay-after-revoke, and pay-after-expiry all rejected on-chain; exact-remaining budget still settles |
| `a2-x402-roundtrip.mjs` | pay a 402 API, then replay the proof / retarget it / use a legacy client | 3 paid unlocks, 4th blocked on-chain, `426` for a legacy client, replayed proof never re-runs fulfillment |
| `a3-bypass-attempts.mjs` | rogue caller, replay, raw-i128 overspend, zero/negative, wrong merchant, direct `transfer_from` | every attempt rejected; post-attack contract state intact |
| `a4-ap2-adversarial.mjs` | tampered signature, mutated payload, forged issuer, wrong session user, replay, unsupported semantics | validator fails closed on every mutation |
| `a5-custody-and-landed-revert.mjs` | measure the real allowances | allowance user→contract = full budget, user→**agent = 0** |
| `a6-landed-revert-race.mjs` | force a rejected payment to be included in a ledger | a `BadSequence` revert lands on-chain as a failed transaction with a real hash |

The core invariant these defend: the SEP-41 allowance is granted to the
contract, never the agent or SDK, and every spend is validated-and-consumed by
the contract atomically before any transfer. A compromised agent or SDK cannot
exceed the mandate.
