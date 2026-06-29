# Tranche 2 — Work Log

Running log of everything done on the `tranche-2` branch. Newest session at the
top. T1 stays frozen on `main` during the Stellar Foundation review; the live,
source-verified contract is `CB4KOTLGMM5JEPFPU6QBJLADIBP3RSGUX44FOYTFRICNXKKFPYIW7ZOA`.

Commit SHAs are the source of truth for dates; the session headings are
approximate.

---

## Open / critical issues

### C1 — `reapp pay` settlement false-negative risk (REAPP-45) — RESOLVED

**Resolution.** Re-applied only the targeted `@reapp-sdk/core` change: `Agent.pay`
now calls `execute_payment` with `{ timeoutInSeconds: PAYMENT_TIMEOUT_SECONDS }`
(60s) — the network-enforced transaction validity window, the correct lever (the
disliked `token.ts` fixed-`sleep` loop was NOT re-applied). Verified on testnet:
three spaced 1.00 payments settle cleanly (no more 'switch' crash), the 4th
over-cap attempt is rejected on-chain, and on-chain truth matches exactly —
merchant `+3.00` (10003.00 via RPC and Horizon) against mandate `spent 3.00 /
seq 3 / max 3.00`, so no money moved silently and the invariant holds.

See **C2** for the residual rapid-fire caveat. Original write-up retained below.

---

### C1 (original) — `reapp pay` settlement false-negative risk (REAPP-45)

**Symptom.** `reapp pay` intermittently throws
`Cannot read properties of undefined (reading 'switch')` on a slow testnet,
*after* the transaction has been signed and submitted.

**Root cause.** This is a client-side XDR-parsing crash in the SDK, **not** a
contract rejection. `@reapp-sdk/core`'s `Agent.pay` calls `execute_payment`
with the SDK's short default transaction validity window (`DEFAULT_TIMEOUT`).
On a congested/slow testnet, `signAndSend` returns before the result XDR is
available, so reading `sent.result` dereferences `undefined.switch()`.

**Why this is serious.** The crash happens *after* `signAndSend`, so the thrown
exception alone does **not** tell you the on-chain outcome. In the general case a
transaction could land on-chain while the CLI reports failure — a false-negative
where a caller that trusts the error (without reconciling against chain state)
mis-reports a payment.

**This instance: verified safe (no false-negative).** After a failed pay #2 we
read on-chain ground truth directly:
- merchant balance: `10001.00 XLM` (started 10000, so only **one** payment landed)
- mandate state: `spent 1.00 / seq 1 / max 3.00`

So only pay #1 moved money; pay #2 genuinely did not apply. No silent money
movement occurred here. The contract's `expected_seq` replay guard also means a
blind retry of the same payment is rejected as `BadSequence` (#8), so the
contract itself cannot be tricked into a double-spend — the risk is purely in how
a *client* interprets the ambiguous error.

**Relationship to the reverted Jun-27 edits.** The `core/index.ts` half of those
edits (passing `timeoutInSeconds` to the contract writes) was actually the
*correct* lever — it sets the network-enforced transaction validity window. The
part that was rightly disliked was the `token.ts` fixed `for i < 180: sleep(1s)`
loop, which only affects token ops (approve/transfer), not `pay`. See the full
reverted diff under "Housekeeping" below.

**Recommended fix.**
- Minimal: re-apply only the core change — call `execute_payment` with a sane
  `timeoutInSeconds` (e.g. 60, not the arbitrary 180). Makes `pay` reliable.
- Proper (T3 settlement refactor): replace hand-rolled waits with the SDK's
  `rpc.Server.pollTransaction` + a backoff `sleepStrategy`, wrap in an
  `AbortController` deadline, classify outcomes explicitly (SUCCESS / FAILED /
  EXPIRED), and on any ambiguous error **reconcile against chain state**
  (`get_mandate` / `getTransaction`) before reporting success or failure.

**Constraint.** The fix touches `@reapp-sdk/core`, which is frozen for the T1
review — do not change it without explicit sign-off (and a heads-up to Alex).

**Decision (resolved):** re-applied the targeted core `timeoutInSeconds` fix — see
the RESOLVED note at the top of C1.

### C2 — rapid-fire payments hit `BadSequence` from RPC read-lag (REAPP-45) — OPEN, minor

`Agent.pay` reads the current mandate `seq` via `get_mandate`, then submits it as
`expected_seq`. When payments fire within seconds of each other, that read can
return a stale `seq` (RPC read-after-write lag), so the contract rejects the next
payment with `Error(Contract, #8) BadSequence` — the replay guard working
correctly against a stale read. Realistic CLI usage (one `reapp pay` per command,
human-paced) is unaffected; the demo avoids it the same way. For the same reason a
just-over-budget attempt can surface as `#8 BadSequence` instead of `#6
BudgetExceeded` — overspend is still blocked either way.

Fix (folds into the T3 settlement refactor): on `BadSequence`, re-read `seq` and
retry once; and have `pay` classify outcomes (contract rejection vs tx/RPC error)
so the CLI message isn't "rejected by the contract" for a tx-level failure.

---

## Findings & fixes (timestamped)

Every notable finding, fix, or "X fixes needed" moment gets logged here as it
happens, with a timestamp.

- **2026-06-30 01:49 +07** — REAPP-46 demo, two fixes needed on the first live run:
  1. `TS2532` — `msg.split("\n")[0]` is possibly `undefined` under
     `noUncheckedIndexedAccess`; guarded with `?? msg`. (`tsc` emits JS even on
     type errors, so the demo ran but the build gate would fail.)
  2. `waitFunded` polled Horizon, but `registerMandate` uses the soroban RPC,
     which lags behind Horizon → "Account not found". Switched the funding poll to
     the soroban RPC (`TESTNET.rpcUrl`), the same source the contract calls use.
- **2026-06-30 01:49 +07** — REAPP-46 demo, funding still failed: firing 3
  friendbot requests in parallel got rate-limited and the poll gave up silently,
  so a later call hit "Account not found". Replaced with a robust `fund()`:
  friendbot → RPC-poll → retry the friendbot hit, and throw loudly if it truly
  can't fund. Live run then passed (3 sources bought, 4th blocked).
- **2026-06-30 01:56 +07** — reapp.live `/demo` page built (reapp-protocol-demo,
  `main` branch, per REAPP-65 / REAPP-52). New `lib/cli-demo.ts` (no-LLM flow,
  mirrors the CLI with friendbot-retry + seq-polling), `app/api/demo/route.ts`
  (NDJSON stream, no key required), `app/demo/page.tsx` (Run button + terminal UI),
  Nav + AGENTS.md updated. `next build` clean; verified live by streaming
  `POST /api/demo` (3 sources bought on-chain, 4th blocked, result purchased=3).
  NOTE: it's on `main`, which Railway auto-deploys to reapp.live, so the push is a
  production deploy — held for explicit okay. Published `@reapp-sdk/core` lacks the
  C1 fix, which is why the flow carries its own seq-polling reliability layer.

- **2026-06-30 02:02 +07** — T2 isolation decision + deploy. To avoid confusing the
  Stellar Foundation during the T1 review, all Tranche 2 surfaces on reapp.live are
  cordoned under a single `T2` nav button → `/t2` hub (T1 pages Docs · Research ·
  Video untouched). Key framing: the FREEZE is on the `reapp-protocol` repo
  (contract/SDK the Foundation reviews); `reapp-protocol-demo` (reapp.live) is the
  demo site and can carry T2. Restructured `/demo` → `/t2` + `/t2/demo`, updated
  Nav + AGENTS.md, `next build` clean. Committed + pushed `reapp-protocol-demo`
  `main` (`cdd6235..b5e9e70`) → Railway auto-deploy to reapp.live in progress
  (root 200, `/t2` 404 until the build lands).

- **2026-06-30 02:09 +07** — Boot banner garbled on reapp.live (Railway logs).
  Root cause: the multi-line ANSI-Shadow figlet banner (added in demo commits
  `024e6b7` / `6c34ca6`, NOT this session) is not reorder-proof in Railway's log
  viewer — the 6 figlet rows fragment and interleave with the boot INFO lines. The
  original design (`138d6b9`) was a deliberate one-liner for exactly this reason;
  it had regressed. Fix: restored a single-line neon REAPP wordmark in
  `reapp-protocol-demo/lib/banner.ts` (deployed `b5e9e70..797e35d`). The reapp CLI
  figlet banner is unchanged — it runs in a real terminal where multi-line is fine.

- **2026-06-30 02:18 +07** — reapp.live `/t2/demo` failed live (`Error(Contract,
  #9)` on first buy in one run; `NOT_FOUND` on register when reproduced). Root
  cause: the page uses the PUBLISHED `@reapp-sdk/core@0.2.0`, which has no
  settlement fix (the C1 fix is only on tranche-2, unpublished), so its register/
  approve/pay writes intermittently return before settling — surfacing as
  NOT_FOUND, BadSequence, or a transient `#9`. Ruled out a real zero-amount bug:
  `toStroops("1.00",7)=10000000` always. Fix: added an application-layer
  reconciliation layer to `reapp-protocol-demo/lib/cli-demo.ts` — every write
  reconciles against on-chain state (register confirms via `get_mandate`; pay
  treats "seq advanced" as success even if the client threw; `#6` = budget block;
  transient errors retry). Verified locally (3 bought, 4th blocked); deployed
  `797e35d..74d6297`. The proper SDK-level fix is still the T3 settlement refactor.

- **2026-06-30 04:20 +07** — Reworked the reapp.live T2 demo into a **live terminal
  that runs the REAL CLI**, after the in-app reimplementation kept failing. Root
  cause recap: the page used the published `@reapp-sdk/core@0.2.0` (no settlement
  fix), so writes were flaky (NOT_FOUND/#8/#9), and my reconcile-by-seq had a bug
  that counted 4 buys against a 3 XLM budget (late tx from a prior source advanced
  seq, misattributed). Decision: stop reimplementing; run the actual CLI, which
  uses the fixed workspace core. Added `npm run cli:bundle` (esbuild: fixed core
  inlined, `@stellar/stellar-sdk` external, `createRequire` banner) → vendored to
  `reapp-protocol-demo/vendor/reapp-cli.mjs`. New `/api/cli` spawns it per session
  (cwd + REAPP_HOME, allow-listed subcommands) and streams raw stdout; `/t2/demo`
  is now an xterm.js terminal (quick-commands + input). Removed the old
  `lib/cli-demo` + `/api/demo`. Verified end-to-end: `demo research-agent` = 3 buys
  + budget block, exit 0, ~57s. Deployed demo `main` `74d6297..12ec72f`.

## CI / security notes

- `secret-scan.yml` (gitleaks) is currently **disabled** — it only runs on manual
  `workflow_dispatch` (push/PR/weekly triggers commented out) because
  `gitleaks/gitleaks-action@v2` needs a paid `GITLEAKS_LICENSE` for org repos.
  Flagged to Alex; recommended swap to the license-free gitleaks CLI step (or
  TruffleHog) so secret scanning runs on every push again before mainnet.
- `release.yml` pins `stellar-expert/soroban-build-workflow@main` (a moving
  branch, not a SHA) — supply-chain risk; recommended to pin to a commit SHA.

---

## Session: 2026-06-30

### Branch & repo setup
- `reapp-protocol` confirmed on `tranche-2` (cut from frozen `main`).
- `reapp-protocol-demo` git remote repointed from the old `…/reapp-protocol-live.git`
  to `…/reapp-protocol-demo.git` (repo renamed live → demo). Local-only config change.

### P0 — CLI (`packages/cli`, published as `reapp-protocol-cli`, bin `reapp`)
- **REAPP-42** scaffold + `init` — commit `a432737`. `reapp init` writes a
  committable `reapp.config.json` (network, live contract id from
  `@reapp-sdk/stellar`, explorer, demo price/budget); no secrets. Ported the
  demo's dependency-free ANSI UI helper.
- **REAPP-43** `setup` — commit `a05788f`. Generates 3 testnet burners
  (user/agent/merchant), funds via friendbot, persists secrets to
  `~/.reapp/credentials.json` (dir 0700, file 0600, outside any repo). Verified
  on-chain: user account funded with 10000 XLM via Horizon.
- **REAPP-44** `mandate create` — commit `42b07b1`. Builds the AP2 IntentMandate
  from stored keys, registers it on-chain, grants the SEP-41 allowance to the
  contract (both user-signed), persists inputs to `~/.reapp/mandate.json` so `pay`
  rebuilds the identical id. Verified end-to-end on testnet (register + approve
  tx hashes confirmed). Also fixed the root `build` script to pre-build
  `@reapp-sdk/core` before the workspace sweep, so the CLI compiles against fresh
  `core/dist` in a clean build (the clean-build gate caught this).
- **REAPP-47 (partial)** full "ANSI Shadow" banner — commit `4671a66`. Replaced
  the compact wordmark with the figlet REAPP banner (per-letter neon gradient),
  ported verbatim from `reapp-protocol-demo/lib/banner.ts`. REAPP-47 left open
  (rest depends on the `demo` command, REAPP-46).
- **REAPP-45** `pay` — agent-signed `execute_payment`, budget enforced on-chain.
  Verified end-to-end on testnet (3 spaced payments land, 4th over-cap rejected,
  merchant +3.00 matches mandate spent 3.00). Depended on the core settlement fix
  (C1 RESOLVED). Residual rapid-fire caveat tracked as **C2**.
- **Core settlement fix** — `@reapp-sdk/core` `Agent.pay` now passes
  `timeoutInSeconds: 60` (a named `PAYMENT_TIMEOUT_SECONDS`) to `execute_payment`.
  Touches the frozen package by explicit sign-off; heads-up to Alex pending.
  Resolves C1; the `token.ts` fixed-`sleep` loop was deliberately NOT re-applied.
- **REAPP-46** `demo research-agent` — self-contained, runs-cold demo. Spins up 3
  ephemeral accounts (robust friendbot funding: retry + RPC-poll, throws if it
  can't fund), registers an on-chain mandate, and the agent buys research sources
  one by one until the contract caps the budget. No LLM dependency — the on-chain
  enforcement is the story; payments are real, the research framing is scripted.
  Verified live on testnet: 3 sources purchased, 4th blocked by the contract.
  Mitigates **C2** in-command by polling the mandate `seq` between purchases
  (`waitForSeq`) so a slow testnet doesn't cause the stale-read BadSequence race —
  the general SDK-level fix is still the T3 settlement refactor.

### Housekeeping
- Reverted two **uncommitted** Jun-27 working-tree edits in the frozen packages
  (`@reapp-sdk/stellar`'s `token.ts` and `@reapp-sdk/core`'s `index.ts`). They
  were local-only (never committed on any branch), made on this machine, not
  Alex's remote work. Backed up to a scratch patch; full diff preserved here:

  ```diff
  # packages/stellar/src/token.ts
  +const SETTLE_ATTEMPTS = 180;
  -  for (let i = 0; res.status === "NOT_FOUND" && i < 30; i += 1) {
  +  for (let i = 0; res.status === "NOT_FOUND" && i < SETTLE_ATTEMPTS; i += 1) {

  # packages/sdk/src/index.ts (@reapp-sdk/core)
  +const WRITE_TIMEOUT_SECONDS = 180;
  # execute_payment, register_mandate, revoke_mandate calls each gained:
  -    });
  +    }, { timeoutInSeconds: WRITE_TIMEOUT_SECONDS });
  ```
- Removed `probe_contract_tmp.mjs` (untracked one-off debug script from Jun 19;
  printed a base64 XDR ledger key — not used by build/tests/CLI).

### Linear
- REAPP-42, REAPP-43, REAPP-44 → **Done**.
- Created **REAPP-65** (Todo, due 2026-07-31): "reapp.live CLI walkthrough page" —
  copy-paste CLI commands + a real recorded asciinema cast + the live
  research-agent demo; sequenced after the CLI `demo` command (REAPP-46/47) and to
  land on the `ui-2026` redesign branch.
