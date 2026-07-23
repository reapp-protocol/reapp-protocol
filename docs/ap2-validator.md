# AP2 compliance validator

`@reapp-sdk/ap2` verifies the Stellar Ed25519 signature, separately trusted user,
single-merchant scope, amount, expiry, binding hash, strict schema, and atomic
admission replay state. AP2 and x402 adapters are isolated from the MandateRegistry,
so their profile/wire logic can evolve without touching the contract.

## Evidence

```bash
npm test -w @reapp-sdk/ap2
```

The package has 59 passing tests, including valid mandates, altered signatures, wrong
merchants, overspend, expiry, replay, schema mutation, and store failure.
