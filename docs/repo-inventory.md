# Repository inventory — 2026-07-23

## Packages

| Path | Public surface | Ownership |
|---|---|---|
| `packages/sdk` | `@reapp-sdk/core@0.3.1` | High-level mandates, contract payments, bound-v2 client, receipts and recovery. |
| `packages/stellar` | `@reapp-sdk/stellar@0.2.2` | Generated typed bindings, permanent testnet contract config, signer and SEP-41 helpers. |
| `packages/ap2` | `@reapp-sdk/ap2@0.4.0` | v0.1-compatible/v0.2 admission, supported open/closed merchant verification, receipts, and typed extension authorizations. |
| `packages/express-middleware` | `@reapp-sdk/express-middleware@0.2.2` | Exact-origin GET proof, Stellar verifier, and atomic claim/immutable-result route. |
| `packages/cli` | `reapp-protocol-cli@0.1.7` | `init`, `setup`, mandate, crash-safe pay/reconcile/acknowledge, and demo flow. |

## Reference applications

| Path | Role |
|---|---|
| `apps/consumer-agent` | Bound-only ResearchAgent, pre-broadcast `FileSettlementReceiptStore`, immutable `FilePurchaseOutcomeStore`, restart recovery, explicit app acknowledgment. |
| `apps/fulfillment-agent` | Safe paid JSON API, `FileBoundRedemptionStore`, independent chain verification, immutable replay. |

The file stores are durable single-process references. Multi-worker production
requires shared linearizable storage.

## Contracts

The protocol repository includes a compatible contract workspace for development
and tests. The authoritative source-verification releases and deployment gate
live in `reapp-protocol-contracts`:

- simple/default `CCHQ5G4Y…CZRM`, release 0.2.3;
- composite `CCYRF7FK…HEYW`, release 0.3.0.

The contracts repository's `ap2v0.2` source also contains a separate AP2
authorization extension and an opt-in Composite pool hook. They are not part
of the deployments above until tagged, deployed, upgraded, and gate checked.

The contract gate covers unauthorized callers, expiry, overspend, replay,
pause, upgrade authorization/timing, and real same-address replacement.

## Release and evidence scripts

| Script | Purpose |
|---|---|
| `scripts/verify.mjs` | Clean build, formatting, lint/type, tests, and workspace contract checks. |
| `scripts/gatecheck-t2.mjs` | Full T2 gate, eight real tarballs, empty-project strict types/imports/CLI, and public/private boundaries. |
| `scripts/e2e-x402.ts` | Three bound-v2 testnet purchases, fourth budget rejection, replay conflict. |
| `scripts/failure-drills-testnet.ts` | Revocation, merchant downtime recovery, and expiry drills. |
| `scripts/e2e-sdk.mjs` | Direct SDK testnet contract flow. |
| `scripts/gatecheck-mandate.mjs` | Read-only inspection of a live testnet mandate. |

## Documentation

- Deliverable evidence: `docs/cli.md`, `docs/sdk-packages.md`, `docs/reference-agents.md`, `docs/ap2-validator.md`, `docs/enforcement-evidence.md`.
- `docs/hackathon-quickstart.md`: external developer path.
- `docs/express-vscode-quickstart.md`: hosted Express companion path.
- `docs/playbook-testnet.md`: contract-to-SDK release procedure.
- `security/threat-model.md` and `security/data-flow.md`: current security model.

Dated June security reports and composite work logs are historical snapshots.
They are not current version or deployment sources.

## Private-file boundary

`REAPP_PROGRESS_LOG.md` and `CONTRACT_UPGRADE_PLAYBOOK.md` are private operator
documents outside this repository. The T2 gate fails if either filename becomes
tracked. Credentials, testnet secrets, receipt files, and redemption files also
remain untracked.
