# security/

Security artifacts live here **from day one**. They are release gates,
not closing artifacts. No immutable mainnet deploy until the threat model, data-flow
diagrams, and full negative suite are merged and reviewed.

- [`threat-model.md`](threat-model.md): protected assets, invariants, trust
  boundaries, threat controls, residual risks, and release gates.
- [`data-flow.md`](data-flow.md): mandate, payment, fulfillment, delivery
  recovery, and upgrade flows with data classification.
- [`upgrade-authority.md`](upgrade-authority.md): current testnet authority,
  mandatory 2-of-3 custody, rotation, lost-key recovery, delayed upgrade, and
  final immutable-mainnet boundary.
- `scan-results/`: dependency gatecheck + Soroban/WASM-aware contract scanner
  output, published with all findings remediated. _(Mainnet hardening.)_

Signed AP2 admission validation ships in `packages/ap2` with 59 tests covering
signature, binding, trusted signer, merchant scope, amount, expiry, and atomic
admission replay. Payment enforcement remains in the contract negative suite
at `contracts/mandate-registry/src/test.rs`, running in CI from commit one.
