# security/

Security artifacts live here **from day one**. They are release gates,
not closing artifacts. No immutable mainnet deploy until the threat model, data-flow
diagrams, and full negative suite are merged and reviewed.

- `threat-model.md`: attack surfaces + mitigations across the mandate
  lifecycle. _(Mainnet hardening.)_
- `data-flow.md`: trust boundaries and data entities. _(Mainnet hardening.)_
- `key-management.md`: 2-of-3 multisig holders, rotation, lost-key recovery.
  _(Authored during mainnet hardening, since no key holders exist at MVP. The skill's
  testnet hot-key discipline is the dress rehearsal.)_
- `scan-results/`: dependency gatecheck + Soroban/WASM-aware contract scanner
  output, published with all findings remediated. _(Mainnet hardening.)_

The enforcement half of mandate validation (scope / amount / expiry / replay)
ships as the contract negative suite in
`contracts/mandate-registry/src/test.rs`, running in CI from commit one.
