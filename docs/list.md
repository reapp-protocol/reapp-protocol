# REAPP Documentation Index

A quick-reference guide to every document in this submission: what each one is, who it is for, and where it sits. Use it as the cover page for the bundle.

**Status:** Tranche 1 (Steps 1, 2, 3) is complete on Stellar **testnet**. The `MandateRegistry` contract is live, `@reapp-sdk/core` and `@reapp-sdk/stellar` are published to npm, and the full x402 round-trip runs end to end on testnet. Mainnet is future work; it is what this round funds.

**Canonical contract:** [`CB4KOTLGMM5JEPFPU6QBJLADIBP3RSGUX44FOYTFRICNXKKFPYIW7ZOA`](https://stellar.expert/explorer/testnet/contract/CB4KOTLGMM5JEPFPU6QBJLADIBP3RSGUX44FOYTFRICNXKKFPYIW7ZOA) on testnet, its source verified on StellarExpert. Every on-chain claim in the deliverable docs links to its transaction on StellarExpert and was re-checked against Horizon, Stellar's canonical API. (Earlier testnet iterations are listed under **Deployment history** in [`mandate-registry-contract.md`](mandate-registry-contract.md).)

**The one idea behind all of it:** an AI agent cannot be trusted to police its own spending, so the spending limit lives inside a Soroban contract in the money path, not in the app or the SDK. Money moves only through `MandateRegistry.execute_payment`, which validates and consumes a mandate before it transfers. The user grants the token allowance to the contract, never to the agent or SDK. The SDK is untrusted; the contract is the source of truth.

---

## Recommended reading order

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontSize':'14px','lineColor':'#94a3b8','primaryColor':'#1e293b','primaryTextColor':'#ffffff','primaryBorderColor':'#475569'}}}%%
flowchart LR
  A[README.md<br/>orientation] --> B[Deliverable docs<br/>contract · SDK · x402, with on-chain proof]
  B --> D[Security audits<br/>adversarial review]
  D --> E[Code reviews<br/>line-by-line depth]
  E --> F[playbook-testnet.md<br/>reproduce it yourself]
```

1. **[README.md](../README.md)** to orient.
2. The three **deliverable docs** (contract, SDK, x402) — each carries its own live on-chain proof, with every call linked to its transaction on StellarExpert.
3. The three **security audits** for the adversarial review.
4. **`code-review.md`** or **`code_review_full.md`** for line-by-line depth.
5. **[playbook-testnet.md](playbook-testnet.md)** to reproduce any of it. The mainnet counterpart, `playbook-mainnet.md`, ships with the mainnet tranche.

---

## Start here

| Document | What it is |
| --- | --- |
| [`README.md`](../README.md) | The front door. Project overview, the core invariant, and current Tranche 1 status with links into each step. |
| [`playbook-testnet.md`](playbook-testnet.md) | The operating manual for working against **Stellar testnet**: how to change the contract, build and publish the SDK, run the reference apps, prove the flow on testnet, run the security audit, and push work that stays green. Every contract id, account, RPC, passphrase, and explorer link in it is testnet. |
| `playbook-mainnet.md` *(forthcoming)* | The mainnet counterpart, shipping with the mainnet tranche. The same recipes against a separate `MAINNET` config: no friendbot funding, real value at risk, hardware-backed keys, and the deferred hardening items from the audits. Not in the repo yet. |

## Tranche 1 deliverable reports

The plain-English writeup of each milestone: what shipped, the full API or method list, and the evidence.

| Document | What it is |
| --- | --- |
| [`mandate-registry-contract.md`](mandate-registry-contract.md) | **The contract (Step 1).** MandateRegistry explained in plain English, every method documented, every transaction it has handled on-chain, and the deployment history. Deployed, source-verified, and live on testnet. |
| [`reapp-sdk-npm.md`](reapp-sdk-npm.md) | **The SDK (Step 2).** `@reapp-sdk/core` and `@reapp-sdk/stellar` on npm, the under-10-line payment flow running live on testnet, the full API, an on-chain audit tool built on the SDK, and the SDK's own security audit. |
| [`x402-roundtrip.md`](x402-roundtrip.md) | **x402 (Step 3).** The `Agent.fetch(url)` round-trip (receive a 402, pay on-chain, get the resource), the reference 402-gated merchant, the ResearchAgent, all live on testnet with the budget enforced through the HTTP layer. |

## Code reviews

| Document | What it is |
| --- | --- |
| [`code-review.md`](code-review.md) | A focused review up front (verdict, architecture, what stops each attack, findings) followed by an exhaustive method-by-method reference. Scope: the contract, the SDK, and the reference apps. |
| [`code_review_full.md`](code_review_full.md) | The full annotated source listing. Every meaningful file with its role, an explanation of what the code does function by function, and the verbatim source inlined, preceded by five architecture Mermaid diagrams. The complete read-the-whole-thing reference. |

## Security audits

Adversarial, multi-agent reviews. Each candidate finding was independently re-verified against the source before it counted.

| Document | What it is |
| --- | --- |
| [`security/README.md`](../security/README.md) | What lives in `security/` and why. Security artifacts are gating deliverables (Stellar feedback), not closing ones; this notes the threat-model, data-flow, and key-management work scheduled for Tranche 3. |
| [`security/audit-2026-06-10.md`](../security/audit-2026-06-10.md) | **Contract audit.** 12-agent sweep across 6 attack surfaces (arithmetic, authorization, replay, reentrancy, state machine, economic logic). Verdict: airtight-ship, 0 confirmed defects. Notes the dead-code replay guard found and fixed during the pass. |
| [`security/sdk-audit-2026-06-15.md`](../security/sdk-audit-2026-06-15.md) | **SDK audit.** 31 agents across 8 surfaces against `@reapp-sdk/core` and `@reapp-sdk/stellar`. Verdict: airtight for testnet, 0 confirmed defects; two low-severity input gaps fixed in 0.1.2 during the pass. |
| [`security/x402-audit-2026-06-16.md`](../security/x402-audit-2026-06-16.md) | **x402 audit.** 23 agents across 6 surfaces against `Agent.fetch`, the merchant, and the ResearchAgent. Found and fixed a critical forged-`payment`-event access-control bypass and a medium replay TOCTOU; the critical fix is verified on-chain. |

## On-chain proof

The on-chain proof lives **inside the three deliverable docs above**, not in a
separate bundle: each one links every call to its transaction on StellarExpert and
re-checks it against Horizon. The contract's full deploy lineage is recorded under
**Deployment history** in [`mandate-registry-contract.md`](mandate-registry-contract.md).

> An earlier standalone `example-output/` proof bundle (per-step `*-verified.md`,
> `*-signoff.md`, an e2e log, and screenshots) was removed. It duplicated the
> deliverable docs, and its captured transactions were from **superseded
> pre-canonical testnet deploys** (`CB2LY7XI`, `CA3X…`) rather than the canonical
> `CB4KOTLG` contract — so it is reproduced freshly via `npm run e2e:testnet` rather
> than kept as stale artifacts. See `playbook-testnet.md` to regenerate it on demand.
> The two genuine logs/dumps were retained under [`history/`](history/) for
> provenance, clearly labelled as superseded.

## Package READMEs

Shipped with the published npm packages.

| Document | What it is |
| --- | --- |
| [`packages/sdk/README.md`](../packages/sdk/README.md) | `@reapp-sdk/core` usage: install, create an agent, approve a budget, run a mandate-validated payment, and use the `Agent.fetch` x402 client. |
| [`packages/stellar/README.md`](../packages/stellar/README.md) | `@reapp-sdk/stellar` usage: the low-level Soroban layer with typed bindings, network config, the keypair signer, and minimal SEP-41 token helpers. |

## Internal reference

| Document | What it is |
| --- | --- |
| [`repo-inventory.md`](repo-inventory.md) | *Internal, optional for the external bundle.* A per-file map of the whole repository: a one-line brief and a keep / cut / decide status for every file. Built for the team to find the right file fast and to decide what is safe to remove. |

---

*This index lives at `docs/list.md`. Paths are relative to it: same-folder links point inside `docs/`, and `../` links reach the repo root, `security/`, and `packages/`.*
