# MandateRegistry contracts — current testnet evidence

The MandateRegistry is the protocol enforcement layer. Applications and SDKs
may prepare inputs, but only the contract can validate and consume a mandate and
move funds.

## Current deployments

| Contract | Testnet id | Release | WASM SHA-256 |
|---|---|---|---|
| Simple/default | [`CC6JMPDH…CRWE`](https://stellar.expert/explorer/testnet/contract/CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE) | [`simple-v0.2.0`](https://github.com/reapp-protocol/reapp-protocol-contracts/releases/tag/simple-v0.2.0_contracts_simple_mandate_registry_mandate-registry_pkg0.2.0_cli25.1.0) | `13f7023d4a361b6e49d3d39f61f55c5eeece51a602013a3cddae420d2ce8552b` |
| Composite | [`CCYRF7FK…HEYW`](https://stellar.expert/explorer/testnet/contract/CCYRF7FKYGSNWX5I7WLYXZ6LNUNVCSPE4BOTQFVWVTABOHAP52DYHEYW) | [`composites-v0.3.0`](https://github.com/reapp-protocol/reapp-protocol-contracts/releases/tag/composites-v0.3.0_contracts_composites_mandate_registry_mandate-registry_pkg0.3.0_cli25.1.0) | `b3368d7fb68017d078792b125dff0389d4c4c893c86fb075baeb9100f0e0f0a1` |

`@reapp-sdk/stellar` defaults to the simple contract. The composite contract is
a separate compatible deployment with pool capabilities.

## Mandate money path

1. User registers a mandate naming user, agent, merchant, asset, budget, expiry,
   and unique 32-byte id.
2. User grants the token allowance to the contract, never to the SDK or agent.
3. Agent calls `execute_payment(mandate_id, amount, expected_seq)`.
4. Contract authenticates the stored agent and checks active status, expiry,
   positive amount, cumulative budget, merchant scope, and exact sequence.
5. Contract advances `spent` and `seq` and transfers user-to-merchant atomically.

Any failure reverts the entire invocation. A direct token transfer is not a
MandateRegistry payment because it does not validate or consume contract state.

## Typed interface

| Method | Behavior |
|---|---|
| `__constructor(admin)` | Sets initial operational authority and unpaused state. |
| `register_mandate` | User-authorized mandate creation; contract initializes mutable state. |
| `get_mandate` | Read current stored mandate. |
| `validate_mandate` | Read-only validation for merchant/amount/sequence. |
| `execute_payment` | Agent-authorized atomic validation, consumption, and transfer. |
| `revoke_mandate` | User-authorized permanent revocation. |
| `get_admin` / `set_admin` | Read or rotate operational authority. |
| `pause` / `unpause` / `is_paused` | Emergency control of money-moving entry points. |
| `schedule_upgrade(hash)` | Admin schedules a replacement and returns earliest execution time. |
| `get_pending_upgrade` | Read proposed hash and earliest execution time. |
| `cancel_upgrade` | Admin removes the proposal. |
| `get_upgrade_delay` | Returns fixed `86,400` seconds. |
| `execute_upgrade` | Admin replaces WASM after delay while paused, preserving id/storage. |

The composite contract applies pause to solo payment and firing pool capture.
Non-firing abort, revocation, registration, reads, validation, commitment,
eviction, and simulation remain available.

## Errors

| Code | Meaning |
|---:|---|
| 1 | Already exists |
| 2 | Not found |
| 3 | Unauthorized caller |
| 4 | Mandate expired |
| 5 | Mandate revoked |
| 6 | Budget exceeded |
| 7 | Merchant out of scope |
| 8 | Bad sequence / replay |
| 9 | Invalid amount |
| 10 | Paused |
| 11 | Upgrade not scheduled |
| 12 | Upgrade not ready |
| 13 | Upgrade already scheduled |
| 14 | Upgrade requires pause |

## Upgrade invariants

Upgrade execution requires all three controls:

1. current-admin authorization;
2. elapsed 24-hour delay; and
3. paused state.

The positive lifecycle test uploads a real replacement WASM, schedules it,
proves early execution fails, proves unpaused execution fails at the deadline,
pauses, executes, invokes a new method at the original contract id, and verifies
preserved admin, pause state, mandate storage, and cleared pending state.

This is testnet operational control. Mainnet governance additionally requires
documented 2-of-3 key holders, rotation, lost-key recovery, monitoring, and an
explicit decision before any fully immutable release.

## Gate check

In the dedicated contract repository:

```bash
./scripts/gatecheck-contracts.sh
```

The current gate checks formatting, warnings, unit and adversarial tests, both
release builds, pause/upgrade behavior, and positive same-address replacement.
Release artifacts are built by the pinned source-verification workflow; local
unoptimized hashes are not substituted for hosted release and on-chain hashes.

## Historical anchors

Simple `CB4KOTLG…7ZOA` (`v0.1.0`) and composite `CBALARHT…WOQX`
(`v0.2.0`) remain visible as immutable historical source anchors. They are not
current SDK defaults and their old method/test counts must not be used as current
release evidence.
