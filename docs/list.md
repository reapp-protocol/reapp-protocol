# REAPP Documentation Index

A quick-reference guide to every document in this submission: what each one is, who it is for, and where it sits. Use it as the cover page for the bundle.

**Status:** Tranche 1 (Steps 1, 2, 3) is complete on Stellar **testnet**. The `MandateRegistry` contract is live, `@reapp-sdk/core` and `@reapp-sdk/stellar` are published to npm, and the full x402 round-trip runs end to end on testnet. Mainnet is future work; it is what this round funds.

**Canonical contract:** [`CA3X76MRIEHP7LVY6H4FIAOTRQYLSMD6NXUMVM5ZR56EOCCWMT6SBQCL`](https://stellar.expert/explorer/testnet/contract/CA3X76MRIEHP7LVY6H4FIAOTRQYLSMD6NXUMVM5ZR56EOCCWMT6SBQCL) on testnet. Every on-chain claim in the verification docs links to its transaction and was re-checked against Horizon, Stellar's canonical API.

**The one idea behind all of it:** an AI agent cannot be trusted to police its own spending, so the spending limit lives inside a Soroban contract in the money path, not in the app or the SDK. Money moves only through `MandateRegistry.execute_payment`, which validates and consumes a mandate before it transfers. The user grants the token allowance to the contract, never to the agent or SDK. The SDK is untrusted; the contract is the source of truth.

---

## Recommended reading order

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontSize':'14px','lineColor':'#94a3b8','primaryColor':'#1e293b','primaryTextColor':'#ffffff','primaryBorderColor':'#475569'}}}%%
flowchart LR
  A[README.md<br/>orientation] --> B[Tranche 1 step docs<br/>the deliverables]
  B --> C[Verified docs<br/>on-chain proof]
  C --> D[Security audits<br/>adversarial review]
  D --> E[Code reviews<br/>line-by-line depth]
  E --> F[PLAYBOOK.md<br/>reproduce it yourself]
```

1. **[README.md](../README.md)** to orient.
2. The three **Tranche 1 step** docs for the deliverables.
3. The matching **`*-verified.md`** docs for the live on-chain proof.
4. The three **security audits** for the adversarial review.
5. **`code-review.md`** or **`code_review_full.md`** for line-by-line depth.
6. **[PLAYBOOK.md](../PLAYBOOK.md)** to reproduce any of it.

---

## Start here

| Document | What it is |
| --- | --- |
| [`README.md`](../README.md) | The front door. Project overview, the core invariant, and current Tranche 1 status with links into each step. |
| [`PLAYBOOK.md`](../PLAYBOOK.md) | The operating manual for the repo: how to change the contract, build and publish the SDK, run the reference apps, prove the flow on testnet, run the security audit, and push work that stays green. |

## Tranche 1 deliverable reports

The plain-English writeup of each milestone: what shipped, the full API or method list, and the evidence.

| Document | What it is |
| --- | --- |
| [`tranche-1-step-1.md`](tranche-1-step-1.md) | **Step 1: the contract.** MandateRegistry explained in plain English, every method documented, and every transaction it has handled on-chain. Deployed, audited, and live on testnet. |
| [`tranche-1-step-2.md`](tranche-1-step-2.md) | **Step 2: the SDK.** `@reapp-sdk/core` and `@reapp-sdk/stellar` on npm, the under-10-line payment flow running live on testnet, the full API, an on-chain audit tool built on the SDK, and the SDK's own security audit. |
| [`tranche-1-step-3.md`](tranche-1-step-3.md) | **Step 3: x402.** The `Agent.fetch(url)` round-trip (receive a 402, pay on-chain, get the resource), the reference 402-gated merchant, the ResearchAgent, all live on testnet with the budget enforced through the HTTP layer. |

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

## On-chain verification and sign-offs

The proof bundle. The `*-verified.md` docs prove each deliverable clause by clause against live testnet transactions; the `*-signoff.md` docs are the close-out summaries.

| Document | What it is |
| --- | --- |
| [`example-output/tranche-1-step-1-verified.md`](../example-output/tranche-1-step-1-verified.md) | Clause-by-clause on-chain proof for Step 1, with seven live transactions re-checked against Horizon, including a bit-for-bit match of the deployed WASM hash to this repo's source. |
| [`example-output/tranche-1-step-2-verified.md`](../example-output/tranche-1-step-2-verified.md) | Clause-by-clause on-chain proof for Step 2: the packages live on npm and the under-10-line flow run on testnet through the published SDK surface. |
| [`example-output/tranche-1-step-3-verified.md`](../example-output/tranche-1-step-3-verified.md) | Clause-by-clause on-chain proof for Step 3: a ResearchAgent buying real resources from the 402-gated merchant, each unlock settled by a real `execute_payment`, the over-budget request rejected on the real network. |
| [`example-output/step-1-contract-signoff.md`](../example-output/step-1-contract-signoff.md) | Step 1 close-out. Includes the honest record that the first pass did not clear (dead replay code, failing fmt) and the table of what was fixed to make it airtight. |
| [`example-output/step-2-sdk-signoff.md`](../example-output/step-2-sdk-signoff.md) | Step 2 close-out. What shipped to npm, both packages, audited and verified on testnet. |
| [`example-output/step-3-x402-signoff.md`](../example-output/step-3-x402-signoff.md) | Step 3 close-out. The x402 pieces (`Agent.fetch`, the wire-format adapter, the merchant, the ResearchAgent), audited and verified on testnet. |
| [`example-output/tranche-1-step-1-e2e-log.txt`](../example-output/tranche-1-step-1-e2e-log.txt) | The raw end-to-end run log behind the Step 1 verification. |
| [`example-output/testnet-e2e-run.md`](../example-output/testnet-e2e-run.md) | Historical. An earlier Step 1 milestone-complete summary against a now-superseded contract id (`CB2LY7XI…`, 18/18 tests). Superseded by `tranche-1-step-1-verified.md` on the canonical contract (`CA3X76MR…`, 19/19). Kept for the record. |
| [`example-output/screenshots/`](../example-output/screenshots/) | Seven proof screenshots of the flow: approve, register mandate, validate and consume, execute payment, revoke mandate, an unauthorized attempt failing, and the contract overview. |

## Package READMEs

Shipped with the published npm packages.

| Document | What it is |
| --- | --- |
| [`packages/sdk/README.md`](../packages/sdk/README.md) | `@reapp-sdk/core` usage: install, create an agent, approve a budget, run a mandate-validated payment, and use the `Agent.fetch` x402 client. |
| [`packages/stellar/README.md`](../packages/stellar/README.md) | `@reapp-sdk/stellar` usage: the low-level Soroban layer with typed bindings, network config, the keypair signer, and minimal SEP-41 token helpers. |

---

*This index lives at `docs/list.md`. Paths are relative to it: same-folder links point inside `docs/`, and `../` links reach the repo root, `security/`, `example-output/`, and `packages/`.*
