# History

Retained historical artifacts from REAPP's testnet iteration. **None of this is the
canonical record** — it predates the source-verified contract and is kept only for
provenance.

The deploy lineage was `CB2LY7XI` → `CA3X…` → **`CB4KOTLG`** (the canonical,
source-verified contract). See
[Deployment history](../mandate-registry-contract.md#deployment-history) for the full
table. The files here describe runs against the earlier, now-superseded deploys, so
their contract ids, transaction hashes, and test counts do **not** match the live
contract.

| File | What it is |
|---|---|
| `testnet-e2e-run.md` | The first Step 1 milestone summary, run against the early `CB2LY7XI` deploy (18/18 tests, before the reentrancy regression test). Internally consistent on that contract. |
| `e2e-testnet-run.log` | Raw console log of an end-to-end testnet run. |

For current, chain-accurate proof, read the deliverable docs in [`../`](../), and
regenerate a fresh live run with `npm run e2e:testnet` (see
[`../playbook-testnet.md`](../playbook-testnet.md)).
