# ⚡ reapp-protocol

**Protocol, SDK, CLI, and reference agents for mandate-enforced agent payments on Stellar. The SDK prepares requests; the contract decides whether money moves.**

[![Stellar](https://img.shields.io/badge/Stellar-Testnet-7B73FF?logo=stellar&logoColor=white)](https://stellar.expert/explorer/testnet/contract/CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE)
[![CI](https://github.com/reapp-protocol/reapp-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/reapp-protocol/reapp-protocol/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-SDK-3178C6?logo=typescript&logoColor=white)](packages/sdk)
[![npm](https://img.shields.io/badge/npm-%40reapp--sdk%2Fcore-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/@reapp-sdk/core)
[![x402](https://img.shields.io/badge/x402-Reference%20Flow-00A67E)](docs/x402-roundtrip.md)

---

## 🔒 One Enforced Payment Path

A user defines the budget and scope. An agent can request payment, but only the MandateRegistry can validate, consume, and transfer against that authorization.

```mermaid
flowchart LR
    U["User\nsigns IntentMandate"] --> R["Register mandate\napprove contract allowance"]
    R --> C["MandateRegistry\nauthoritative boundary"]

    A["Agent"] --> F["agent.fetch()"]
    F --> M["Fulfillment API"]
    M -->|"402 requirement"| F
    F --> P["execute_payment"]
    P --> C

    C --> V["Re-check\nauth · scope · budget\nexpiry · sequence"]
    V --> X["Consume mandate\nspent + sequence"]
    X --> T["SEP-41 transfer_from"]
    T --> M
    M -->|"verify transaction + contract event"| D["Serve resource"]
    D --> A

    SDK["SDK / CLI\nuntrusted convenience layer"] -.-> A
    SDK -.-> U

    style C fill:#1a1a2e,stroke:#7B73FF,color:#fff
    style V fill:#16213e,stroke:#00d9a5,color:#fff
    style X fill:#16213e,stroke:#00d9a5,color:#fff
    style T fill:#16213e,stroke:#e94560,color:#fff
```

> **Core invariant:** money moves only through `MandateRegistry.execute_payment`, which validates and consumes the mandate before transfer. The user approves the SEP-41 allowance for the **contract**, never for the agent, SDK, or CLI.

---

## Why REAPP Is Different

| Property | Protocol guarantee |
|---|---|
| Contract-authoritative limits | Budget, merchant scope, asset, expiry, caller authorization, and sequence are re-checked on every payment. |
| Atomic enforcement | Mandate consumption and token transfer happen in one transaction; a failed transfer reverts the state change. |
| SDK cannot bypass policy | The SDK and CLI hold no spending authority. They submit requests to the same contract boundary as any other caller. |
| Replay resistance | Every spend supplies the current mandate sequence; stale and out-of-order calls are rejected. |
| Adaptable HTTP layer | x402 request and response parsing is isolated from the mandate model and contract interface. |
| Controlled evolution | Testnet contracts support admin pause and 24-hour timelocked same-address upgrades while preserving storage and contract ID. |

---

## 🌐 Current Testnet Surfaces

| Surface | Current source or deployment |
|---|---|
| Default simple MandateRegistry | [`CC6JMPDH…CRWE`](https://stellar.expert/explorer/testnet/contract/CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE) — [`simple-v0.2.0`](https://github.com/reapp-protocol/reapp-protocol-contracts/releases/tag/simple-v0.2.0_contracts_simple_mandate_registry_mandate-registry_pkg0.2.0_cli25.1.0), WASM `13f7023d…8552b`, pause, authority rotation, and 24-hour same-address upgrades |
| Composite MandateRegistry | [`CCYRF7FK…HEYW`](https://stellar.expert/explorer/testnet/contract/CCYRF7FKYGSNWX5I7WLYXZ6LNUNVCSPE4BOTQFVWVTABOHAP52DYHEYW) — deterministic clearing pools with the same operational controls |
| Contract releases and hashes | [`reapp-protocol-contracts`](https://github.com/reapp-protocol/reapp-protocol-contracts) |
| High-level SDK | [`@reapp-sdk/core`](https://www.npmjs.com/package/@reapp-sdk/core) — mandates, payments, and `agent.fetch()` |
| Stellar binding | [`@reapp-sdk/stellar`](https://www.npmjs.com/package/@reapp-sdk/stellar) — typed contract client, network config, signers, and SEP-41 helpers |
| AP2 profile | [`@reapp-sdk/ap2`](https://www.npmjs.com/package/@reapp-sdk/ap2) — signed, version-pinned AP2 v0.2 validation plus fail-closed binding into the contract mandate |
| Express middleware | [`@reapp-sdk/express-middleware`](https://www.npmjs.com/package/@reapp-sdk/express-middleware) — independent settlement verification and atomic redemption before fulfillment |
| CLI | [`reapp-protocol-cli`](https://www.npmjs.com/package/reapp-protocol-cli) — setup, mandate creation, payment, and demo flow |

The contract is authoritative. SDK-side checks only fail fast; they never replace on-chain validation.

---

## 📁 Repository Map

| Path | Purpose |
|---|---|
| [`packages/sdk`](packages/sdk) | `@reapp-sdk/core`: thin client plus the isolated x402 adapter |
| [`packages/stellar`](packages/stellar) | `@reapp-sdk/stellar`: generated binding, network config, signer, and token helpers |
| [`packages/ap2`](packages/ap2) | `@reapp-sdk/ap2`: signed AP2 v0.2 REAPP profile validator with deterministic binding evidence and 59 tests |
| [`packages/express-middleware`](packages/express-middleware) | `@reapp-sdk/express-middleware`: fail-closed Express 4/5 settlement verification |
| [`packages/cli`](packages/cli) | `reapp-protocol-cli`: terminal workflow and project setup |
| [`apps/consumer-agent`](apps/consumer-agent) | Reference ResearchAgent that buys data through `agent.fetch()` |
| [`apps/fulfillment-agent`](apps/fulfillment-agent) | Reference 402-gated API that verifies settlement before serving |
| [`scripts`](scripts) | Testnet demos, live flows, deployment, and gate check tooling |
| [`security`](security) | Threat model, data flows, upgrade custody, and contract/SDK/x402 gate check records |

---

## 🚀 Run the Flow

```bash
npm ci
npm run verify
```

Run the reviewer CLI from any clean directory:

```bash
npx reapp-protocol-cli demo research-agent
```

Run both reference agents from this repository with one command:

```bash
npm run agents:testnet
```

That command creates and funds fresh testnet actors, starts the Express
fulfillment agent, and drives the consumer through real `agent.fetch()`
purchases. Three resources settle and are independently verified; the fourth is
rejected by the contract-enforced budget. No local key or environment file is
required.

Run the three named SDK failure drills separately:

```bash
npm run drills:testnet
```

Use the public browser companion at [reapp.live/express](https://reapp.live/express),
or follow the verified [clean VS Code project guide](docs/express-vscode-quickstart.md).
Operational evidence and boundaries are in the [live drill record](docs/live-failure-drills.md),
[threat model](security/threat-model.md), [data flow](security/data-flow.md), and
[upgrade authority runbook](security/upgrade-authority.md).

*The SDK is untrusted. The contract enforces the limit.*
