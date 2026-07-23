# Security evidence

Security is a release gate, not an end-of-project appendix.

Current artifacts:

- [`threat-model.md`](threat-model.md): assets, trust boundaries, invariants,
  abuse cases, and named production gates for the bound-v2 T2 surface.
- [`data-flow.md`](data-flow.md): contract, SDK, receipt, challenge, fulfillment,
  chain verification, and exact-proof recovery sequence.
- [`../docs/enforcement-evidence.md`](../docs/enforcement-evidence.md): per-deliverable implementation and evidence.

Historical point-in-time reviews:

| Record | Exact historical scope |
|---|---|
| [`gatecheck-2026-06-10.md`](gatecheck-2026-06-10.md) | Soroban SDK 22 simple contract and its then-current 19-test suite. |
| [`sdk-gatecheck-2026-06-15.md`](sdk-gatecheck-2026-06-15.md) | `@reapp-sdk/core@0.1.2` and `@reapp-sdk/stellar@0.1.1`. |
| [`x402-gatecheck-2026-06-16.md`](x402-gatecheck-2026-06-16.md) | Legacy proof-v1 middleware before bound-v2. |

Historical reports are retained for traceability but are not evidence for the
current core 0.3.1 or Express middleware 0.2.2.

Current repeatable checks:

```bash
npm run gatecheck:t2
npm run agents:testnet
npm run drills:testnet
```

The AP2 package has 59 total tests. Contract negative and positive upgrade tests
run in the dedicated contract repository gate check.
