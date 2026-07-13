# REAPP npm packages

REAPP publishes typed ESM packages with packed API documentation and examples.
The SDK is untrusted infrastructure: it never receives the user allowance and
cannot replace the contract's `execute_payment` checks.

## Release matrix

| Package | Version | Purpose |
|---|---:|---|
| `@reapp-sdk/core` | 0.3.0 | Mandates, payments, bound-v2 `agent.fetch`, receipts, recovery. |
| `@reapp-sdk/stellar` | 0.2.1 | Typed contract bindings, network config, signing and token helpers. |
| `@reapp-sdk/ap2` | 0.2.1 | Signed AP2 profile validation and replay admission. |
| `@reapp-sdk/express-middleware` | 0.2.0 | Bound-v2 Express payment boundary and chain verifier. |
| `reapp-protocol-cli` | 0.1.4 | `init`, `setup`, mandate, crash-safe pay/reconcile/acknowledge, and demo commands. |
| `@reapp/stellar` | 0.2.1 | Exact-pin compatibility re-export. |
| `@reapp/ap2` | 0.2.1 | Exact-pin compatibility re-export. |
| `@reapp/express-middleware` | 0.2.0 | Exact-pin compatibility re-export. |

The compatibility packages contain no forked security logic. Each pins and
re-exports its canonical package at the same version.

The unrelated npm package `reapp-cli` is owned by another publisher. Use the
project's unambiguous public CLI name:

```bash
npx reapp-protocol-cli@0.1.4 demo research-agent
```

## Install

Application client:

```bash
npm install @reapp-sdk/core@0.3.0 @stellar/stellar-sdk
```

Exact T2 compatibility packages:

```bash
npm install @reapp/stellar@0.2.1 @reapp/ap2@0.2.1 @reapp/express-middleware@0.2.0
```

## Bound-v2 client API

```ts
const agent = reapp.agent({
  mandate,
  signer: agentKey,
  proofPolicy: "bound-v2-only",
  receiptStore,
});

const response = await agent.fetch(url);
const receipt = getSettlementReceipt(response);
const result = await response.json();
await persistAcceptedResult(result, receipt);
await agent.acknowledgeDelivery(receipt!);
```

Important exports:

| Export | Purpose |
|---|---|
| `reapp.createIntentMandate` | Canonical local mandate construction. |
| `registerMandate` / `approveBudget` | User-authorized on-chain setup. |
| `Agent.pay` | Agent-authorized `execute_payment`. |
| `Agent.fetch` | Bound-v2 capability, challenge validation, payment, signed proof, and delivery. |
| `SettlementReceiptStore` | Durable pre-broadcast save, restart enumeration, and explicit clear interface. |
| `getSettlementReceipt` | Exact receipt from a successful paid response. |
| `DeliveryPendingError` | Typed post-submission settlement/delivery uncertainty. |
| `SettlementUncertainError` | Direct-pay hash was prepared and broadcast was attempted, but final state is unknown. |
| `PendingSettlement` / `SettlementReconciliation` | Exact hash, validity window, and reconciliation result. |
| `Agent.getPendingSettlement` / `reconcilePendingSettlement` | Restore/query one hash without submitting another transaction. |
| `Agent.retryDelivery` | Exact-proof delivery retry with no payment or signature. |
| `Agent.acknowledgeDelivery` | Clears the durable receipt only after application commit. |

`proofPolicy: "bound-v2-only"` is required for new paid endpoints. The
`"legacy-compatible"` default exists only for migration. Paid fetch requires a
receipt store with `savePending`, `listPending`, and `clearPending`; the signed
hash is durable before broadcast, and restart blocks every new payment until the
same receipt is reconciled/recovered and explicitly acknowledged.

Direct `Agent.pay` also fails before network unless its required `onPrepared`
hook durably journals the signed hash and validity window. The CLI demonstrates
that contract with `reapp settlement reconcile` plus explicit exact-hash
`reapp settlement acknowledge <TX_HASH>` for a successful result.

## Express API

Use `createBoundReappPaidJsonRoute`, a stable private challenge secret, an exact
configured public HTTP(S) origin, and a required `BoundRedemptionStore`. GET is
the only paid method. The route verifies the exact challenge, chain-derived
agent signature, MandateRegistry event, current identities, and matching SEP-41
transfer; then it atomically claims fulfillment once and commits bounded JSON
bytes before sending them.

The exact completed proof replays those stored bytes without verifier or
callback execution. The same transaction with another proof returns `409`; an
executing claim or infrastructure outage returns `503`. In-memory state is
demo-only; multi-worker production requires a shared durable linearizable
claim/result store and a transactional outbox for external side effects. Only a
trusted operator/outbox, after proving the execution owner is dead, may call
`resolveBoundReappInterruptedDelivery` to commit one terminal result.

## AP2 API

`createAp2ComplianceValidator` checks strict schema and versions, Stellar
Ed25519 signature, separately trusted user, merchant scope, amount, expiry,
binding hash, and atomic replay admission. Its 59-test suite covers valid and
adversarial cases. Cumulative spending and payment replay remain contract checks.

## Clean-package gate check

```bash
npm ci
npm run gatecheck:t2
```

The gate check:

- cleans generated output;
- builds and typechecks the workspace;
- runs all package and app tests;
- dry-inspects and builds real tarballs for every canonical and compatibility package;
- checks exact name/version, README, JavaScript, and declaration files;
- rejects install lifecycle scripts, source/test leakage, env files, and secret-like paths;
- installs all eight tarballs into an empty project, strict-typechecks public
  imports, executes ESM imports and the CLI binary;
- verifies private internal documents are not tracked; and
- checks public terminology.

Registry proof is a separate external check:

```bash
npm view @reapp-sdk/core@0.3.0 version dist.integrity
npm view @reapp-sdk/stellar@0.2.1 version dist.integrity
npm view @reapp-sdk/ap2@0.2.1 version dist.integrity
npm view @reapp-sdk/express-middleware@0.2.0 version dist.integrity
npm view reapp-protocol-cli@0.1.4 version dist.integrity
npm view @reapp/stellar@0.2.1 version dist.integrity
npm view @reapp/ap2@0.2.1 version dist.integrity
npm view @reapp/express-middleware@0.2.0 version dist.integrity
```

Then install into an empty temporary project, compile strict TypeScript imports,
and run a runtime ESM import. Local workspace success is not substituted for
public registry evidence.

## Testnet contract

All current packages default to the upgradeable simple MandateRegistry
[`CC6JMPDH…CRWE`](https://stellar.expert/explorer/testnet/contract/CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE),
WASM `13f7023d4a361b6e49d3d39f61f55c5eeece51a602013a3cddae420d2ce8552b`.
