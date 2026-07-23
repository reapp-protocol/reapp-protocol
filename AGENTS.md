# AGENTS.md

This file guides coding agents (Claude Code and compatible tools) working in this
repository. It is also surfaced as `CLAUDE.md` via a symlink, so both names resolve
to this single source.

## What this is

Agent-driven payments on Stellar. A user signs an AP2 **IntentMandate**; an AI
agent pays for a 402-gated resource via **x402**; the Soroban **MandateRegistry**
contract enforces scope, budget, expiry, and replay at consume time. A compromised
agent or SDK cannot exceed the mandate.

**The core invariant:** money moves only through `MandateRegistry.execute_payment`
(solo payments) and `clear_pool` (composite capture of a pooled schedule each member
pre-authorized at registration), each of which validates-and-consumes the mandate
atomically *before* it transfers. The user approves the SEP-41 allowance for the
**contract**, never for the agent or SDK. The SDK is untrusted; the contract is the
source of truth. When changing anything, preserve this: never let a spend path bypass
the two validated capture points, and never move the allowance or enforcement into
TypeScript.

## Commands

This is an npm workspaces monorepo (`packages/*`, `apps/*`) plus a Rust/Soroban
contract that is **not** part of the npm workspace.

- `npm run verify` — the local CI-equivalent gate; **run this before every push.**
  Runs rustfmt, clippy (`-D warnings`), `cargo test`, then a *clean* workspace
  build + `npm test`. Mirrors `.github/workflows/ci.yml`. Wired as a git pre-push
  hook via `git config core.hooksPath .githooks` (one-time, per clone).
- `npm run build` — builds `@reapp-sdk/stellar` first (the others depend on it),
  then all workspaces.
- `npm test` — runs every workspace's tests.
- `npm run typecheck` — root `tsc` (project references).

Contract (run inside `contracts/mandate-registry/`):
- `cargo test` — full suite: the §10 negative suite (18 tests in `test.rs` + snapshots),
  the pool suite (34 in `pool_test.rs`), and a reentrancy probe.
- `cargo test <name>` — a single test, e.g. `cargo test overspend_cumulative_rejected`.
- `cargo fmt --all -- --check` and `cargo clippy --all-targets -- -D warnings`.

SDK / app tests use the Node test runner via tsx, e.g.
`node --import tsx --test packages/sdk/src/x402.test.ts`.

On-chain scripts (need a funded testnet burner in `.env` — copy `.env.example`):
- `npm run demo` — the "aha": happy path + rogue rejections (overspend, replay,
  pay-after-revoke) on testnet.
- `npm run e2e:x402` — full x402 round-trip: ResearchAgent buys from the 402-gated
  merchant via `agent.fetch`; three settle on-chain, the fourth is budget-rejected.
- `npm run e2e:testnet`, `npm run e2e:sdk` — lower-level on-chain e2e.
- `npm run gatecheck` — independent on-chain mandate gatecheck tool.
- `npm run deploy:testnet` — deploy the contract; fill the resulting ids into `.env`.
- `npm run keys:derive-freighter` — scan BIP39 indexes to match a Freighter pubkey
  (seed typed at runtime, never stored).

## Architecture

Data/trust flow: **user** signs a mandate → SDK registers it + approves the
allowance *for the contract* → **agent** calls `execute_payment` → contract
validates+consumes, then does the SEP-41 `transfer_from(user → merchant)`.

### `contracts/mandate-registry/` — Rust / soroban-sdk (the enforcement layer)
The entire protocol; small by design (small interface = reviewable). Modules have a
strictly one-way dependency graph (no cycles), documented at the top of `src/lib.rs`:
`lib → {registry, payment, pool} → storage → {mandate, pooltypes, error}`, with
`pool → clearing → {mandate, pooltypes}` (pure) and `events` as a leaf.
- `lib.rs` — contract entry points only (thin dispatch, no logic).
- `storage.rs` — the **only** module that touches `env.storage`; `DataKey` + TTL.
- `registry.rs` — `register_mandate` / `revoke_mandate` (allowance funding model).
- `payment.rs` — `validate_mandate` (read-only preflight) + `execute_payment` (the
  solo money path: `require_auth(agent)` → replay guard on `expected_seq` → re-validate
  → advance `spent`+`seq` → transfer; reverts on any failure).
- `pool.rs` — pool lifecycle: register / commit / evict / simulate + `clear_pool`
  (the composite money path: permissionless deadline-auction capture of a pooled
  schedule each member pre-authorized at registration; re-checks pause, budget,
  and eligibility per member before its `transfer_from`).
- `clearing.rs` (pure clearing math), `pooltypes.rs` (pure pool data).
- `mandate.rs` (pure data), `error.rs` (typed errors), `events.rs`.
- `test.rs` + `pool_test.rs` + `test_snapshots/` — the negative suite (§10), which
  CI runs from commit one. `reentry_probe.rs` is a reentrancy guard test.

### `packages/stellar/` — `@reapp-sdk/stellar` (typed Soroban layer)
Network config (`TESTNET`), the generated/typed `registryClient` contract bindings,
SEP-41 `token` helpers, and `keypairSigner`. Built first; everything else depends on it.

### `packages/sdk/` — `@reapp-sdk/core` (thin, untrusted client)
The under-10-line flow (`reapp.createIntentMandate` → `registerMandate` →
`approveBudget` → `agent()` → `agent.pay`/`agent.fetch`). Key files:
- `index.ts` — `reapp` facade + the `Agent` class. `createIntentMandate` defines the
  **canonical hash** (mandate id) by a fixed JSON field order — *changing that order
  changes every id*; keep it stable. `toStroops` is strict-by-design money parsing
  (rejects anything that could wrap to a wrong on-chain i128).
- `x402.ts` — the **only** place that knows the HTTP shape of the 402 challenge and
  the `X-PAYMENT` settlement-proof header. Isolated so the moving x402 v0.2/v0.3 wire
  format can change without touching the contract or `Agent.pay`. The proof is a
  *settlement* proof (payment already happened on-chain); the merchant re-verifies
  the txHash on-chain — the header is never trusted on its own.

### `packages/ap2/` — `@reapp-sdk/ap2` (version-pinned bridge)
Maps the supported AP2 v0.1.0 human-not-present IntentMandate subset into the
existing core mandate without changing core's canonical hash. Unsupported SKU,
refundability, multi-merchant, and cart-confirmation semantics fail closed. AP2
normalization and evidence stay separate from x402, and the contract remains the
only enforcement boundary.

### `apps/`
- `fulfillment-agent/` — reference 402-gated merchant; verifies payment on-chain
  before serving.
- `consumer-agent/` — reference ResearchAgent; buys sources via `agent.fetch`, budget
  enforced on-chain.

## Conventions

- **Security boundary discipline:** SDK-side checks (e.g. `Agent.fetch` comparing the
  402's `payTo` to the mandate merchant) are fail-fast convenience only. The real
  boundary is always the contract + the merchant's on-chain verification. Don't
  present an SDK check as the enforcement.
- **Terminology:** use “gate check” in reports, documentation, and commit messages;
  never reintroduce the prohibited T1 review term.
- The contract is gatechecked and live on testnet; treat its interface as a published
  contract. The negative/§10 suite is not optional and must stay green from commit one.
- `security/` holds the contract, SDK, and x402 gatecheck records; the release docs
  `docs/mandate-registry-contract.md`, `docs/reapp-sdk-npm.md`, and `docs/x402-roundtrip.md`
  document each shipped step. Update them when the matching surface changes.
- Testnet only in this repo: hot burner keys, never reused on mainnet, never committed.
