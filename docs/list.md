# REAPP documentation index

Current testnet facts:

- Default simple contract: [`CCHQ5G4Y…CZRM`](https://stellar.expert/explorer/testnet/contract/CCHQ5G4Y4YBMY6D3TYYJSVJVCKUM22Q6TMKCCHVAHY4X7K6QELQACZRM), release `simple-v0.2.3`, WASM `ba370a80…76e87`, source verified.
- Composite contract: [`CCYRF7FK…HEYW`](https://stellar.expert/explorer/testnet/contract/CCYRF7FKYGSNWX5I7WLYXZ6LNUNVCSPE4BOTQFVWVTABOHAP52DYHEYW), release `composites-v0.3.0`, WASM `b3368d7f…f0a1`.
- Historical deployments remain explorer-visible but are not SDK defaults.

## Start here

| Document | Purpose |
|---|---|
| [`hackathon-quickstart.md`](hackathon-quickstart.md) | Clean-clone, CLI, SDK, and reference-agent testnet setup. |
| [`express-vscode-quickstart.md`](express-vscode-quickstart.md) | Build a clean VS Code consumer against the `/express` companion. |
| [`playbook-testnet.md`](playbook-testnet.md) | Linear contract-to-SDK release and operating procedure. |

## Protocol and implementation

| Document | Purpose |
|---|---|
| [`mandate-registry-contract.md`](mandate-registry-contract.md) | Current contracts, controls, methods, errors, releases, and verification. |
| [`x402-roundtrip.md`](x402-roundtrip.md) | Bound-v2 challenge, proof, chain verification, recovery, and stores. |
| [`ap2-merchant-extension.md`](ap2-merchant-extension.md) | Implemented AP2 v0.2 open/closed-chain boundary, separate authorization contract, Simple/Composite routes, and deployment status. |
| [`reapp-sdk-npm.md`](reapp-sdk-npm.md) | Package/version map, typed APIs, publication, and clean-install checks. |
| [`repo-inventory.md`](repo-inventory.md) | Current repository surfaces and ownership boundaries. |
| [`live-failure-drills.md`](live-failure-drills.md) | Fresh testnet revocation, downtime recovery, and expiry evidence. |

## Package and app READMEs

| Surface | README |
|---|---|
| Agent SDK | [`packages/sdk/README.md`](../packages/sdk/README.md) |
| Stellar bindings | [`packages/stellar/README.md`](../packages/stellar/README.md) |
| Express middleware | [`packages/express-middleware/README.md`](../packages/express-middleware/README.md) |
| AP2 validator | [`packages/ap2/README.md`](../packages/ap2/README.md) |
| CLI | [`packages/cli/README.md`](../packages/cli/README.md) |
| Consumer agent | [`apps/consumer-agent/README.md`](../apps/consumer-agent/README.md) |
| Fulfillment agent | [`apps/fulfillment-agent/README.md`](../apps/fulfillment-agent/README.md) |

## Security

| Document | Scope |
|---|---|
| [`security/threat-model.md`](../security/threat-model.md) | Current bound-v2 T2 threat model and named production gates. |
| [`security/data-flow.md`](../security/data-flow.md) | Current first-delivery and exact-recovery sequences. |
| [`security/README.md`](../security/README.md) | Current evidence index and historical-scope labels. |

The dated 2026-06 security reports are historical snapshots with exact old
versions. They are retained for traceability and are not current release proof.

## Historical design material

`docs/history/` and the composite design/work-log documents record earlier
decisions and deployments. If a historical status conflicts with this index,
the current package manifests, contract release READMEs, and T2 submission map
are authoritative.
