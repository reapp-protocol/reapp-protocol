# REAPP testnet release playbook — contract to SDK

This is the linear operating procedure for a contract, deployment, typed SDK,
npm, CLI, reference-agent, and hosted-demo release. Do not skip ahead: every
stage consumes the verified evidence from the prior stage.

## Current release baseline

| Surface | Baseline |
|---|---|
| Simple/default contract | `CCHQ5G4Y4YBMY6D3TYYJSVJVCKUM22Q6TMKCCHVAHY4X7K6QELQACZRM`, 0.2.3, hash `ba370a80…76e87`, source verified |
| Composite contract | `CCYRF7FKYGSNWX5I7WLYXZ6LNUNVCSPE4BOTQFVWVTABOHAP52DYHEYW`, 0.3.0, hash `b3368d7f…f0a1` |
| Core / Stellar | 0.3.1 / 0.2.2 |
| Express / AP2 | 0.2.2 / 0.3.0 |
| CLI | `reapp-protocol-cli@0.1.7` |

All commands use Stellar testnet. Never place secrets in command history,
documentation, commits, screenshots, or logs. Use a configured Stellar identity
or secure signer. Generated demo keys are disposable testnet keys only.

## 1. Contract source change

Work in the dedicated `reapp-protocol-contracts` repository.

1. Change one contract surface at a time.
2. Add positive and negative tests in the same change.
3. Preserve existing storage encodings unless a migration is explicit.
4. If the ABI changes, plan binding and package-version changes before release.
5. Do not update public ids or hashes until actual deployment evidence exists.

Required local gate:

```bash
./scripts/gatecheck-contracts.sh
```

The gate checks both simple and composite formatting, warnings, tests, and
release WASMs. Upgrade changes must prove unauthorized, early, unpaused, and
successful same-address paths, including preserved state.

## 2. Source-verification release

1. Commit the clean contract change.
2. Push `main`.
3. Create the contract-specific release tag.
4. Push the tag.
5. Wait for the pinned StellarExpert build workflow.
6. Download the exact hosted WASM and provenance.
7. Verify interface and SHA-256 before deployment.

```bash
shasum -a 256 release.wasm
stellar contract info interface --wasm release.wasm --output json-formatted
stellar contract info hash --wasm release.wasm
```

The hosted artifact is authoritative for deployment. Do not substitute a local
build whose optimizer or CLI version differs.

## 3. New testnet deployment

Configure a funded testnet identity in the Stellar CLI. Use environment
variables only for public values:

```bash
export RELEASE_WASM=/absolute/path/to/release.wasm
export ADMIN_ADDRESS=G...
```

Upload and deploy the exact artifact:

```bash
stellar contract upload \
  --wasm "$RELEASE_WASM" \
  --source reapp-agent \
  --network testnet \
  --no-cache
```

Use the returned hash:

```bash
stellar contract deploy \
  --wasm-hash <64-hex-wasm-hash> \
  --source reapp-agent \
  --network testnet \
  --no-cache \
  -- --admin "$ADMIN_ADDRESS"
```

Record the contract id and transaction hash. Then prove the deployed hash and
interface independently:

```bash
stellar contract info hash --id <contract-id> --network testnet --no-cache
stellar contract info interface --id <contract-id> --network testnet --output json-formatted --no-cache
```

## 4. Live operational checks

Read operations can use a configured funded source identity for simulation:

```bash
stellar contract invoke --id <contract-id> --source reapp-agent --network testnet --no-cache -- --get_admin
stellar contract invoke --id <contract-id> --source reapp-agent --network testnet --no-cache -- --is_paused
stellar contract invoke --id <contract-id> --source reapp-agent --network testnet --no-cache -- --get_upgrade_delay
```

Exercise pause and unpause with the admin signer, then return to the intended
operational state:

```bash
stellar contract invoke --id <contract-id> --source reapp-agent --network testnet --no-cache -- --pause
stellar contract invoke --id <contract-id> --source reapp-agent --network testnet --no-cache -- --is_paused
stellar contract invoke --id <contract-id> --source reapp-agent --network testnet --no-cache -- --unpause
stellar contract invoke --id <contract-id> --source reapp-agent --network testnet --no-cache -- --is_paused
```

Record explorer links. Never infer success from a command beginning; require the
final transaction result and a confirming read.

## 5. Same-address upgrade procedure

Use only a source-verified replacement hash. Uploading installs code but does not
change the live contract:

```bash
stellar contract upload --wasm replacement.wasm --source reapp-agent --network testnet --no-cache
```

Schedule the returned hash:

```bash
stellar contract invoke --id <contract-id> --source reapp-agent --network testnet --no-cache -- \
  schedule_upgrade --new_wasm_hash <64-hex-wasm-hash>
```

Confirm pending state and the contract-reported deadline. The current simple
testnet contract reports `3,600` seconds; the composite reports `86,400`:

```bash
stellar contract invoke --id <contract-id> --source reapp-agent --network testnet --no-cache -- --get_pending_upgrade
stellar contract invoke --id <contract-id> --source reapp-agent --network testnet --no-cache -- --get_upgrade_delay
```

After the deadline, pause and execute:

```bash
stellar contract invoke --id <contract-id> --source reapp-agent --network testnet --no-cache -- --pause
stellar contract invoke --id <contract-id> --source reapp-agent --network testnet --no-cache -- --execute_upgrade
```

Then verify the same id, new hash/interface, preserved admin and storage, cleared
pending state, and expected pause state. Unpause only after those checks.
`cancel_upgrade` is the pre-execution rollback path.

## 6. Typed binding and deployment config

Generate candidate TypeScript bindings from the exact release artifact into a
temporary directory, then review the diff before replacing checked-in code:

```bash
stellar contract bindings typescript \
  --wasm release.wasm \
  --output-dir /tmp/reapp-bindings \
  --overwrite
```

Update `packages/stellar`:

- generated contract spec/types;
- `TESTNET.mandateRegistryId`;
- release version and WASM hash in README;
- method/error documentation; and
- any dependent API version.

Never regenerate from an arbitrary live id when the source-verified WASM is
available; the artifact preserves the source-to-binding chain.

## 7. Protocol implementation gate

In the protocol repository:

```bash
npm ci
npm run gatecheck:t2
```

The gate cleans build output, builds/types/tests the workspace, validates the
contract workspace, inspects and builds real canonical/compatibility tarballs,
installs all eight into an empty project, strict-typechecks imports, executes ESM
imports and the CLI binary, rejects install scripts/private/source leakage, and
checks public terminology.

For paid HTTP changes, also require:

```bash
npm run agents:testnet
npm run drills:testnet
```

Expected agent evidence: three paid resources, fourth budget rejection, exact
bound-v2 receipts, and old-transaction/new-proof conflict. Expected drills:
revocation, merchant outage recovery with zero second payment, and expiry before
settlement.

## 8. Package packing and clean installation

Pack from each package directory only after the gate is green. Inspect tarball
contents and exact dependency pins. Then create an empty temporary project and:

1. install the tarballs;
2. run a strict TypeScript compilation importing public APIs;
3. run an ESM runtime import; and
4. verify no lifecycle scripts, env files, sources, tests, or credentials ship.

## 9. npm publication

First verify registry identity and scope access. Authentication may require one
browser/WebAuthn action by the operator; never paste an npm token into chat or a
repository.

Publish dependencies before consumers:

1. `@reapp-sdk/stellar`
2. `@reapp-sdk/core`
3. `@reapp-sdk/ap2`
4. `@reapp-sdk/express-middleware`
5. `reapp-protocol-cli`

Already-existing unchanged versions are verified, not republished. After each
new publish, query the exact version and integrity and install it from the public
registry in a clean project. Do not call a package released until this succeeds.

The unscoped `reapp-cli` name belongs to another publisher. Public examples use:

```bash
npx reapp-protocol-cli@0.1.7 demo research-agent
```

## 10. Source commits and pushes

Keep increments isolated:

1. contract tests/documentation;
2. protocol security implementation/tests;
3. package wrappers/documentation/evidence;
4. hosted site dependency and UI copy.

Run the relevant gate before every commit. Review `git diff --check`, changed
files, and tarballs. Push `main`, wait for GitHub CI, and require a green final
commit before proceeding.

Private operator documents remain outside all public repositories.

## 11. Hosted `/express` deployment

After public npm verification, update the hosted site's exact dependency and
lockfile versions. Keep internal imports on the canonical implementation; public
install links may use the exact T2 compatibility names. Build locally, commit,
push the Railway-mapped repository, and wait for the deployment.

Live verification must cover:

- home/navigation routes;
- `/express` responsive UI and endpoint creation;
- capability → challenge → purchase sequence;
- three explorer-linked settlements;
- fourth contract rejection;
- AP2 59-test visual matrix;
- no secret values in responses/logs; and
- no stale contract ids, versions, or package links.

## 12. Final evidence close

T2 becomes complete only when all of these are true:

- contract and protocol gates green;
- current-version adversarial review has zero unresolved release blockers;
- public package versions and clean imports verified;
- CLI demo verified under the correct package name;
- agent and failure-drill live runs pass;
- contracts/protocol/site commits pushed;
- GitHub CI and Railway deployment green;
- live `/express` proof matches the pushed source; and
- the deliverable evidence docs contain no pending or fabricated evidence.

Mainnet readiness is a separate decision. It requires production 2-of-3 key
governance, shared linearizable redemption storage, encrypted receipt custody,
durable result/outbox semantics, monitoring, independent review, and an explicit
immutability decision.

## Troubleshooting without weakening controls

| Symptom | Safe response |
|---|---|
| Stellar CLI cache permission error | Repeat with `--no-cache`; do not move or expose key material. |
| RPC or redemption-store outage | Preserve exact receipt; retry delivery, never repay. |
| 426 from merchant | Upgrade to a bound-v2 client before any payment. |
| 409 for a settled transaction | It is bound to another proof; do not generate a new payment automatically. |
| npm auth expired | Start a fresh CLI web login and complete it once in the operator browser. |
| Railway still shows old code | Wait for the pushed commit deployment and verify the deployment SHA before testing. |
