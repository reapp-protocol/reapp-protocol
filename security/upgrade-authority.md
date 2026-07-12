# Upgrade authority and key recovery

This document records the operational boundary for the upgradeable REAPP
MandateRegistry contracts. It contains public addresses and custody roles only.
Private keys, seed phrases, device locations, recovery shares, and personal
contact details belong in the private custody register and must never enter this
repository.

## Current testnet authority

Both current testnet contracts report the same administrator:

`GA2B3YY27OY6AWT2VXMXUDBSAHVOLU2ST6QWJJJLOIGDQHJDXO4RL4XH`

| Contract | Address | Control state |
|---|---|---|
| [Simple 0.2.0](https://stellar.expert/explorer/testnet/contract/CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE) | `CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE` | 24-hour delayed same-address upgrade; money path currently unpaused |
| [Composite 0.3.0](https://stellar.expert/explorer/testnet/contract/CCYRF7FKYGSNWX5I7WLYXZ6LNUNVCSPE4BOTQFVWVTABOHAP52DYHEYW) | `CCYRF7FKYGSNWX5I7WLYXZ6LNUNVCSPE4BOTQFVWVTABOHAP52DYHEYW` | 24-hour delayed same-address upgrade; money paths currently unpaused |

The administrator is currently a single-signer testnet account. Its public
Horizon record has one signer. The signer is held by the REAPP founder/operator
and is accessed through the local Stellar identity named `reapp-agent` on the
authorized operator workstation. This is acceptable only for the current
testnet window. It is not the intended early-mainnet custody model.

## Required 2-of-3 custody before early mainnet

The target administrator is a dedicated Stellar account or contract account
that requires two independent approvals. The final mechanism must be exercised
on testnet before either MandateRegistry calls `set_admin`.

| Key | Holder | Storage boundary | Status |
|---|---|---|---|
| A — operating signer | REAPP founder/operator | Dedicated hardware signer; encrypted offline recovery | Assigned by role; device and recovery details stay in the private custody register |
| B — technical co-signer | Independent REAPP technical custodian | Separate hardware signer on a different device and physical site | Must be named and acknowledged in the private custody register before activation |
| C — recovery signer | Independent recovery custodian | Normally offline hardware signer; sealed recovery stored separately from A and B | Must be named and acknowledged in the private custody register before activation |

Keys A, B, and C each carry one unit of authority; any two are required. No one
person may control two keys or both a device and its recovery material. The
private custody register must record the legal holder, public signer address,
device identifier, recovery location, last access test, and emergency contact.

[Stellar account signer weights and thresholds](https://developers.stellar.org/docs/learn/fundamentals/transactions/signatures-multisig)
support an m-of-n policy. Signer or threshold changes are high-threshold account
operations, so the setup order must be rehearsed and reviewed carefully. A
contract-account implementation is also acceptable if its `__check_auth` policy
and recovery behavior are tested.

The following conditions block mainnet activation:

- Key B or Key C remains unnamed in the private custody register.
- Two signers or recovery materials share one person, device, password manager,
  cloud account, or physical location.
- A 2-of-3 pause, unpause, rotation, schedule, cancel, and execution rehearsal
  has not passed on testnet.
- The public administrator address does not match the value returned by
  `get_admin()` on every deployed contract.

## Authority rotation procedure

1. Create and fund the proposed administrator address without changing either
   contract.
2. Configure the three signers and 2-of-3 policy. Verify the on-chain signer and
   threshold record independently from two workstations.
3. Submit a harmless testnet transaction requiring A+B, then a second requiring
   B+C. Confirm one signer alone cannot authorize it.
4. Exercise the full contract control sequence on a disposable contract:
   `pause`, read `is_paused`, `unpause`, schedule a known test WASM hash, cancel
   it, schedule again, wait for the fixed delay, pause, and execute.
5. From the current MandateRegistry administrator, call
   `set_admin(new_admin)`.
6. Read `get_admin()` from a separate, unsigned client and require an exact
   match with `new_admin`.
7. Prove the old administrator can no longer pause, unpause, rotate, schedule,
   cancel, or execute. Prove two new signers can pause and unpause.
8. Record the transaction links, signer set, thresholds, date, and approvers in
   the private custody register. Publish only the public addresses and
   transaction links.

Never rotate both deployed contracts in one unverified transaction batch. Move
the simple contract first, complete every read and negative check, then move the
composite contract.

## Lost-key and compromised-key recovery

### One key lost, unavailable, or suspected compromised

The remaining two custodians still meet the threshold. They must:

1. Pause the affected contract only when active exploitation or unsafe release
   behavior makes the money path dangerous.
2. Create a replacement signer on a new device with new recovery material.
3. Remove the lost signer and add the replacement through the administrator's
   signer-management policy.
4. Recheck that every one-key combination fails and each approved two-key
   combination succeeds.
5. Rotate any service credentials that could have shared the compromised
   device, record the event privately, and unpause only after live checks pass.

### Two keys lost

Two lost keys fall below the intended threshold. The contracts deliberately
contain no secret guardian, bypass, or emergency backdoor. Same-address pause,
rotation, and upgrade are unavailable until two valid signers can authorize the
administrator.

If the private recovery process cannot restore two signers, the response is a
new contract deployment followed by user-authorized mandate recreation. No
operator may claim that an inaccessible administrator can be recovered in
place.

### Active compromise with two keys

Treat this as full administrator compromise. Publish an incident notice, pause
if the honest custodians can still satisfy authorization, stop new mandate
creation through official clients, preserve chain evidence, and prepare a new
deployment. The 24-hour contract delay prevents an immediate WASM replacement,
but a compromised administrator can still schedule one; monitoring must alert
on every upgrade event and pending hash.

## Same-address upgrade runbook

1. Build from a tagged source commit with the repository gate check passing.
2. Verify the release WASM hash, interface, and provenance record independently.
3. Upload the exact WASM and record its on-chain hash.
4. With two administrator approvals, call `schedule_upgrade(new_wasm_hash)`.
5. Read `get_pending_upgrade()` from an unsigned client. Confirm the exact hash
   and an execution time at least 86,400 seconds after scheduling.
6. During the delay, publish the hash and change record; monitor for cancellation
   or replacement attempts.
7. After the delay, call `pause()` and prove every money-moving method fails
   before changing funds or mandate state.
8. With two approvals, call `execute_upgrade()`.
9. At the same contract ID, verify the executable hash, full interface, admin,
   pause state, and representative pre-upgrade storage records.
10. Run live negative and happy-path checks. Call `unpause()` only when all pass.

Any hash mismatch, missing interface method, unexpected storage result, signer
disagreement, or incomplete monitoring window stops the upgrade.

## Final immutable mainnet boundary

Immutability is a separate release decision, not a marketing label for the
current upgradeable testnet deployment. A final immutable release requires:

- a complete threat model and data-flow review;
- continuously passing negative and invariant tests;
- reproduced release bytecode and interface evidence;
- a mainnet incident and migration plan;
- a contract build with no reachable upgrade or administrator mutation path,
  or a formally verified terminal upgrade that removes those paths;
- public verification that the deployed executable is the immutable build.

Once the immutable boundary is crossed, no key-recovery process can repair a
contract defect. Unknown behavior becomes permanent. The decision therefore
requires explicit written approval from all three custody roles and cannot be
combined with an ordinary release.
