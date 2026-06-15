# security/

Security artifacts live here **from day one**. They are gating deliverables
(Stellar feedback), not closing ones. No immutable mainnet deploy until the
threat model, data-flow diagrams, and full negative suite are merged and
reviewed.

- `threat-model.md`: attack surfaces + mitigations across the mandate
  lifecycle. _(Tranche 3 gating; outline grows from T1.)_
- `data-flow.md`: trust boundaries and data entities. _(Tranche 3 gating.)_
- `key-management.md`: 2-of-3 multisig holders, rotation, lost-key recovery.
  _(Authored in Tranche 3, no key holders exist at MVP. The skill's testnet
  hot-key discipline is the dress rehearsal.)_
- `scan-results/`: dependency audit + Soroban/WASM-aware contract scanner
  output, published with all findings remediated. _(Tranche 3.)_

The enforcement half of mandate validation (scope / amount / expiry / replay)
ships as the contract negative suite in
`contracts/mandate-registry/src/test.rs`, running in CI from commit one.
