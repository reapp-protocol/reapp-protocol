# REAPP Protocol: Repo Inventory (internal)

Internal reference for the team. A per-file map of the repository with a one-line
brief and a keep/cut note for each file. Use it to find the right file fast and
to decide what is safe to remove.

Last updated: 2026-06-17. Scope: tracked, non-ignored files in `reapp-protocol`.
Generated, vendored, and gitignored paths are out of scope by design and are not
listed here. Status legend:

- **Keep**: load-bearing source, test, config, or doc.
- **Keep (generated)**: produced by a tool; do not hand-edit.
- **Keep (test)**: test, fixture, or test harness.
- **Cut candidate**: safe to remove; see Cleanup notes.
- **Decide**: present but unsettled (often untracked); team call.

## Contract: `contracts/mandate-registry` (Rust, soroban-sdk)

The whole protocol. Small by design so it stays auditable. Money moves only
through `execute_payment`.

| Path | What it does | Status |
|---|---|---|
| `src/lib.rs` | Contract entry points: thin dispatch for the five methods (register, validate, execute, revoke, get). No logic. | Keep |
| `src/registry.rs` | `register_mandate` and `revoke_mandate`. The contract self-initializes spent/seq/status so a caller cannot seed a tampered balance. | Keep |
| `src/payment.rs` | The money path: `check()`, `validate_and_consume`, `execute_payment` (auth, replay guard, revalidate, advance, SEP-41 `transfer_from`). | Keep |
| `src/mandate.rs` | `Mandate` struct and `Status` enum. Pure data. | Keep |
| `src/storage.rs` | The only module touching `env.storage`: `DataKey`, get/set, TTL. | Keep |
| `src/error.rs` | The eight typed error codes. Slot 3 reserved (auth is host-enforced). | Keep |
| `src/events.rs` | `register` / `payment` / `revoke` event emitters. | Keep |
| `src/test.rs` | Integration plus negative suite (overspend, replay, auth, expiry, allowance ceiling). Runs in CI. | Keep (test) |
| `src/reentry_probe.rs` | Reentrancy regression: a malicious token reenters `execute_payment`; asserts no double-spend. | Keep (test) |
| `Cargo.toml` | Crate manifest and hardened release profile (overflow-checks, panic=abort, lto). | Keep |
| `Cargo.lock` | Pinned dependency lockfile. | Keep |

## Package: `packages/stellar` (`@reapp-sdk/stellar`)

Typed Soroban layer. Published to npm.

| Path | What it does | Status |
|---|---|---|
| `src/client.ts` | Generated MandateRegistry contract binding (embedded XDR spec). | Keep (generated) |
| `src/config.ts` | `TESTNET` network config: rpc, passphrase, live contract id, native SAC. | Keep |
| `src/registry.ts` | `registryClient()` factory wiring net plus signer. | Keep |
| `src/signer.ts` | `keypairSigner()` adapter (secret or Keypair to signer shape). | Keep |
| `src/token.ts` | Minimal SEP-41 `approve` and `balance` helpers (no CLI dependency). | Keep |
| `src/index.ts` | Barrel re-export. | Keep |
| `README.md`, `package.json`, `tsconfig.json`, `.gitignore` | Package metadata, docs, build config. | Keep |

## Package: `packages/sdk` (`@reapp-sdk/core`)

The untrusted client. Published to npm.

| Path | What it does | Status |
|---|---|---|
| `src/index.ts` | Public SDK: `toStroops`, `createIntentMandate`, register/approve/revoke, `Agent.pay`, `Agent.fetch` (x402). | Keep |
| `src/x402.ts` | The only module that knows the x402 wire format: `parse402`, encode/decode proof. | Keep |
| `src/x402.test.ts` | Exhaustive wire-format guard tests (malformed proofs, 402 parsing). | Keep (test) |
| `src/fetch.test.ts` | `Agent.fetch` orchestration tests with stubbed fetch and pay. | Keep (test) |
| `test/index.test.mjs` | `toStroops` and `createIntentMandate` unit tests. | Keep (test) |
| `README.md`, `package.json`, `tsconfig.json` | Package metadata, docs, build config. | Keep |

## Apps: reference implementations

| Path | What it does | Status |
|---|---|---|
| `apps/fulfillment-agent/src/server.ts` | Reference 402-gated merchant. Verifies payment on-chain (`selectPayment`) before serving; `ProofLedger` blocks replays and TOCTOU. | Keep |
| `apps/fulfillment-agent/src/server.test.ts` | Tests the merchant security decision against a real golden tx and forged events. | Keep (test) |
| `apps/fulfillment-agent/src/fixtures/payment-meta.json` | Golden fixture: a real testnet `execute_payment` meta XDR, so the decode path is tested against real Soroban output. | Keep (test) |
| `apps/consumer-agent/src/research-agent.ts` | Reference ResearchAgent: buys sources via `agent.fetch`, budget enforced on-chain. | Keep |
| `apps/*/package.json`, `apps/*/tsconfig.json` | Build config for both apps. | Keep |

## Scripts: `scripts/`

| Path | npm entry | What it does | Status |
|---|---|---|---|
| `deploy.mjs` | `deploy:testnet` | Builds the contract to WASM and deploys MandateRegistry, then records the deployed contract id in local config. | Keep |
| `e2e-testnet.mjs` | `e2e:testnet`, `demo` | Full on-chain proof via the `stellar` CLI, no mocks. The flagship e2e. | Keep |
| `e2e-sdk.mjs` | `e2e:sdk` | Same flow driven through the published `@reapp-sdk/core` surface. | Keep |
| `e2e-x402.ts` | `e2e:x402` | The x402 round-trip e2e: buy sources, the budget blocks the last one on-chain. | Keep |
| `audit-mandate.mjs` | `audit` | Independent read-only auditor: reads a mandate plus allowance and balance straight from chain. | Keep |
| `verify.mjs` | `verify` | Local CI gate (also the pre-push hook): rustfmt, clippy, cargo test, clean build, npm test. | Keep |
| `derive-freighter.mjs` | `keys:derive-freighter` | One-time setup: derives a Stellar secret key from a Freighter seed phrase. | Keep (setup) |
| `screenshot-proofs.mjs` | (none) | Playwright. Screenshots a fixed set of testnet tx hashes into `example-output/screenshots`. | Cut candidate |

## Other top-level

| Path | What it does | Status |
|---|---|---|
| `playbook/demo.ts` | `npm run demo`; thin wrapper that spawns `e2e-testnet.mjs`. | Cut candidate (alias) |
| `docs/tranche-1-step-1.md` … `-3.md` | Canonical tranche writeups (Steps 1, 2, 3). | Keep |
| `docs/code-review.md` | Code review export (tracked, ~168 KB). | Decide (older review) |
| `docs/code_review_full.md` | Full file-by-file review with verbatim source inlined (~383 KB). | Decide (untracked) |
| `docs/repo-inventory.md` | This file. | Keep |
| `security/README.md` | Index of audit records. | Keep |
| `security/audit-2026-06-10.md` | Contract audit (Step 1). | Keep |
| `security/sdk-audit-2026-06-15.md` | SDK audit (Step 2). | Keep |
| `security/x402-audit-2026-06-16.md` | x402 surface audit (Step 3). | Keep |
| `example-output/step-1/2/3-*-signoff.md` | Signoff posts per step. | Cut candidate |
| `example-output/tranche-1-step-1/2/3-verified.md` | Evidence writeups; overlap `docs/`. | Cut candidate |
| `example-output/testnet-e2e-run.md` | Milestone run summary. | Cut candidate |
| `example-output/tranche-1-step-1-e2e-log.txt` | Raw e2e console log. | Cut candidate |
| `example-output/screenshots/*.png` (7) | Images produced by `screenshot-proofs.mjs`. | Keep if referenced, else cut |
| `PLAYBOOK.md` | Team operating manual (untracked at repo root). | Decide (likely keep and commit) |

## Root and config

| Path | What it does | Status |
|---|---|---|
| `README.md` | Repo overview and core invariant. | Keep |
| `package.json`, `package-lock.json`, `tsconfig.base.json` | Workspace, scripts, and shared build config. | Keep |
| `.github/workflows/ci.yml` | CI: Rust (fmt plus negative suite) and TypeScript (build plus test). | Keep |
| `.githooks/pre-push` | Local pre-push gate (runs `npm run verify`). | Keep |
| `.gitignore`, `.env.example` | Ignore rules and the secret-free env template. | Keep |

## Cleanup notes

The source tree (contract, both packages, both apps, tests, CI, config) is all
load-bearing. The real cut candidates cluster in a few places:

1. **Dead code, removed.** `scripts/lib/env.ts` was an env bootstrap helper that
   nothing imported (every script loads `dotenv` inline). Removed 2026-06-17.
2. **`example-output/` evidence.** The markdown and log artifacts duplicate the
   canonical `docs/tranche-1-step-N.md` and `security/` records plus git history.
   Safe to remove if no grant submission links them directly.
3. **Frozen one-shots.** `scripts/screenshot-proofs.mjs` and its
   `example-output/screenshots/*.png`, and the thin `playbook/demo.ts` alias.
4. **Two code-review docs.** `docs/code-review.md` (tracked) and
   `docs/code_review_full.md` (untracked, newer, much larger). Keep one.

## Cleanup log

- 2026-06-17: Removed `scripts/lib/env.ts` and the now-empty `scripts/lib/`.
  Unused env bootstrap helper, imported by nothing.
