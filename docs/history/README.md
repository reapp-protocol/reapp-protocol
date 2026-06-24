# History

Archived material kept for provenance. **None of this is the canonical record** —
the current, maintained docs live one level up in [`../`](../). The files here are
either superseded or point-in-time snapshots, and may reference earlier contracts or
stale paths.

## Superseded testnet run artifacts

The deploy lineage was `CB2LY7XI` → `CA3X…` → **`CB4KOTLG`** (the canonical,
source-verified contract). See
[Deployment history](../mandate-registry-contract.md#deployment-history) for the full
table. The files below describe runs against the earlier, now-superseded deploys, so
their contract ids, transaction hashes, and test counts do **not** match the live
contract.

| File | Created | What it is |
|---|---|---|
| `testnet-e2e-run.md` | 2026-06-10 | The first Step 1 milestone summary, run against the early `CB2LY7XI` deploy (18/18 tests, before the reentrancy regression test). Internally consistent on that contract. |
| `e2e-testnet-run.log` | 2026-06-11 | Raw console log of an end-to-end testnet run. |

For current, chain-accurate proof, read the deliverable docs in [`../`](../), and
regenerate a fresh live run with `npm run e2e:testnet` (see
[`../playbook-testnet.md`](../playbook-testnet.md)).

## Archived code reviews

Large, generated, point-in-time code-review dumps. They are snapshots of the tree at
the time they were produced, so they describe paths that have since moved (for
example the removed `example-output/` folder). Kept for reference; not maintained.
For a current read, see the source itself and the `security/` audit records.

| File | Created | What it is |
|---|---|---|
| `code-review.md` | 2026-06-16 | A focused review (verdict, architecture, what stops each attack, findings) plus a method-by-method reference. ~168 KB. |
| `code_review_full.md` | 2026-06-17 | The full annotated source listing: every meaningful file with its role and verbatim source inlined, preceded by architecture diagrams. ~383 KB. |
