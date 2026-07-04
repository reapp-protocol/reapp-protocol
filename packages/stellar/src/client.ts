import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
// Deployed addresses come from the single source of truth, deployments.ts.
// (This is the generated binding; if you regenerate it, re-apply this import and
// the `contractId` reference below.)
import { DEPLOYMENTS } from "./deployments.js";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}




export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: DEPLOYMENTS.testnet.mandateRegistryId,
  }
} as const

export const Errors = {
  1: {message:"AlreadyExists"},
  2: {message:"NotFound"},
  4: {message:"MandateExpired"},
  5: {message:"MandateRevoked"},
  6: {message:"BudgetExceeded"},
  7: {message:"MerchantOutOfScope"},
  8: {message:"BadSequence"},
  9: {message:"InvalidAmount"},
  11: {message:"PoolNotFound"},
  12: {message:"PoolNotOpen"},
  13: {message:"ScheduleInvalid"},
  14: {message:"PoolMerchantMismatch"},
  15: {message:"PoolAssetMismatch"},
  16: {message:"DeadlinePassed"},
  /**
   * Reserved for outcome-style reporting; the abort branch is a success
   * (state flip + event), not an error.
   */
  17: {message:"ThresholdNotMet"},
  18: {message:"PoolFull"},
  19: {message:"BadPoolState"},
  20: {message:"MandatePooled"},
  21: {message:"InsufficientFunds"},
  22: {message:"KindNotSupported"},
  25: {message:"NotPooled"},
  26: {message:"ExpiryBeforeDeadline"},
  27: {message:"BelowMinChild"},
  28: {message:"DuplicateMember"},
  29: {message:"DeadlineNotReached"},
  30: {message:"DeadlineTooFar"},
  31: {message:"MemberStillEligible"}
}

export type Status = {tag: "Active", values: void} | {tag: "Revoked", values: void} | {tag: "Exhausted", values: void};


export interface Mandate {
  /**
 * The ONLY principal permitted to call `execute_payment`.
 */
agent: string;
  /**
 * SEP-41 / SAC contract id (USDC on testnet).
 */
asset: string;
  /**
 * Ledger close timestamp (seconds) after which the mandate is dead.
 */
expiry: u64;
  /**
 * Total budget authorized by the mandate.
 */
max_amount: i128;
  /**
 * MVP: single allowed payee (scope). T1: `Vec<Address>` or scope-hash.
 */
merchant: string;
  /**
 * `None` == standalone: exactly the pre-composite behavior.
 */
pool_id: Option<Buffer>;
  pool_state: PoolState;
  /**
 * The demand curve; empty when standalone.
 */
price_schedule: Array<SchedulePoint>;
  /**
 * Monotonic payment counter (mandate-level audit / replay guard).
 */
seq: u32;
  /**
 * Cumulative consumed; invariant: `0 <= spent <= max_amount`.
 */
spent: i128;
  status: Status;
  /**
 * Signer of the AP2 IntentMandate; grants the SEP-41 allowance.
 */
user: string;
  /**
 * Hash binding to the off-chain AP2 IntentMandate VC; also the storage key.
 */
vc_hash: Buffer;
}

/**
 * Pool linkage lifecycle, orthogonal to `Status`. `Unlinked` and `Released`
 * children may spend on the solo path (their own limits still apply);
 * `Committed` and `Captured` may not (`MandatePooled`).
 */
export type PoolState = {tag: "Unlinked", values: void} | {tag: "Committed", values: void} | {tag: "Captured", values: void} | {tag: "Released", values: void};


export interface SchedulePoint {
  /**
 * Strictly descending across the schedule; each in (0, MAX_QTY].
 */
max_qty: u128;
  /**
 * Strictly ascending across the schedule; each in (0, MAX_UNIT_PRICE].
 */
unit_price: i128;
}

export type DataKey = {tag: "Mandate", values: readonly [Buffer]} | {tag: "Pool", values: readonly [Buffer]} | {tag: "PoolMembers", values: readonly [Buffer]};


/**
 * The row `pool.rs` builds per committed child and feeds to `clearing::clear`.
 * Feeding plain values (not storage handles) is what keeps the clearing
 * function pure and makes simulate == capture a provable equality.
 */
export interface ChildView {
  /**
 * Decided once, before any price exists — see pool.rs eligibility.
 */
eligible: boolean;
  mandate_id: Buffer;
  schedule: Array<SchedulePoint>;
  worst_case: i128;
}


export interface Allocation {
  mandate_id: Buffer;
  qty: u128;
}

export type PoolStatus = {tag: "Open", values: void} | {tag: "Cleared", values: void} | {tag: "Aborted", values: void};

export type ClearingKind = {tag: "ThresholdFloor", values: void} | {tag: "SpendCeiling", values: void} | {tag: "CapacityCeiling", values: void};


export interface ClearingPool {
  asset: string;
  /**
 * Unix seconds. Capture is a deadline auction: never before this instant.
 */
clearing_deadline: u64;
  /**
 * Fee rate captured at `register_pool`; capture never reads a live rate.
 * Always 0 in this deploy (the fee knob ships in its own pass); the field
 * exists so that pass is not another ABI break.
 */
fee_bps_pinned: u32;
  kind: ClearingKind;
  /**
 * Live Committed members while Open; frozen at terminal status.
 */
member_count: u32;
  merchant: string;
  /**
 * Floor on each committing child's worst_case (anti-dust squatting).
 */
min_child_value: u128;
  /**
 * Signs `register_pool`; holds NO later power — clearing is permissionless
 * and deterministic, which is the whole no-skim guarantee.
 */
originator: string;
  status: PoolStatus;
  /**
 * Vendor minimum units; the pool fires only if aggregate qty reaches it.
 */
threshold_qty: u128;
  /**
 * Vendor minimum order value, compared NET of fee to the merchant.
 */
threshold_value: u128;
}


export interface ClearOutcome {
  /**
 * mandate_id order, qty > 0 only.
 */
allocations: Array<Allocation>;
  /**
 * The single uniform price p*; 0 when `!fires`.
 */
clearing_price: i128;
  fires: boolean;
  gross_value: i128;
  /**
 * `gross_value - total_fee`; the number compared to `threshold_value`.
 */
net_value: i128;
  total_fee: i128;
  total_qty: u128;
}

export interface Client {
  /**
   * Construct and simulate a get_pool transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only accessor for a stored pool.
   */
  get_pool: ({pool_id}: {pool_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<ClearingPool>>>

  /**
   * Construct and simulate a clear_pool transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Close the deadline auction: capture (all legs in this one transaction)
   * if the threshold predicate holds within the capture window, else abort
   * and release every committed child. Callable by anyone, never before
   * the deadline.
   */
  clear_pool: ({pool_id}: {pool_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a evict_child transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Remove an objectively-ineligible member and free its slot.
   * Permissionless; can never evict a still-eligible member.
   */
  evict_child: ({pool_id, mandate_id}: {pool_id: Buffer, mandate_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_mandate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only accessor for the stored mandate (audit / preflight).
   */
  get_mandate: ({mandate_id}: {mandate_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Mandate>>>

  /**
   * Construct and simulate a commit_child transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Link a pooled mandate into its pool as a Committed member.
   * Permissionless (objective checks only); revocable until the deadline.
   */
  commit_child: ({mandate_id}: {mandate_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_pool transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Register a clearing pool. The returned pool id is derived from the
   * terms (sha256 of their XDR), so the id commits to the terms.
   * Authorized by `originator` — the last special signature the pool ever
   * requires: everything after this is permissionless and deterministic.
   */
  register_pool: ({originator, merchant, asset, kind, threshold_qty, threshold_value, min_child_value, clearing_deadline, nonce}: {originator: string, merchant: string, asset: string, kind: ClearingKind, threshold_qty: u128, threshold_value: u128, min_child_value: u128, clearing_deadline: u64, nonce: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Buffer>>>

  /**
   * Construct and simulate a revoke_mandate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * User withdraws consent; marks the mandate Revoked. Authorized by the
   * user. Also frees the pool slot of a Committed child (its one
   * pre-deadline exit).
   */
  revoke_mandate: ({mandate_id}: {mandate_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a simulate_clear transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only: the exact outcome `clear_pool` would execute against current
   * ledger state. Same builder, same clearing function — recompute this to
   * verify the originator had no discretion over the allocation.
   */
  simulate_clear: ({pool_id}: {pool_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<ClearOutcome>>>

  /**
   * Construct and simulate a execute_payment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The solo money path. Atomic: require_auth(agent) → replay guard
   * (`expected_seq` == current `seq`, else `BadSequence`) → re-validate →
   * advance spent+seq → SEP-41 transfer_from(user → merchant). Reverts on any
   * failure. `expected_seq` is the mandate's current sequence (read from
   * `get_mandate`), preventing duplicate/out-of-order consumption.
   */
  execute_payment: ({mandate_id, amount, expected_seq}: {mandate_id: Buffer, amount: i128, expected_seq: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_pool_members transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only: current member mandate ids (commit order; frozen once the
   * pool is terminal).
   */
  get_pool_members: ({pool_id}: {pool_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<Buffer>>>>

  /**
   * Construct and simulate a register_mandate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Store a user-signed mandate from its authorized parameters. The contract
   * sets `spent=0, seq=0, status=Active` itself. Authorized by `user`.
   * Returns the mandate id (= `vc_hash`, the storage key).
   * 
   * `pool_id = None` + empty `price_schedule` == a standalone mandate
   * (the pre-composite behavior, unchanged). `pool_id = Some(id)` binds the
   * mandate to a clearing pool; the schedule is the user's authorization
   * for the pool path (see `registry`).
   */
  register_mandate: ({user, agent, merchant, asset, max_amount, expiry, vc_hash, pool_id, price_schedule}: {user: string, agent: string, merchant: string, asset: string, max_amount: i128, expiry: u64, vc_hash: Buffer, pool_id: Option<Buffer>, price_schedule: Array<SchedulePoint>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Buffer>>>

  /**
   * Construct and simulate a validate_mandate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only preflight — would this spend be permitted right now? Mutates
   * nothing and requires no auth; the authoritative consume happens only in
   * `execute_payment`. (It is a dry-run; it consumes nothing.) Reflects
   * pool state too: a Committed/Captured child preflights `MandatePooled`,
   * exactly what `execute_payment` would do.
   */
  validate_mandate: ({mandate_id, amount, merchant}: {mandate_id: Buffer, amount: i128, merchant: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAACVSZWFkLW9ubHkgYWNjZXNzb3IgZm9yIGEgc3RvcmVkIHBvb2wuAAAAAAAACGdldF9wb29sAAAAAQAAAAAAAAAHcG9vbF9pZAAAAAPuAAAAIAAAAAEAAAPpAAAH0AAAAAxDbGVhcmluZ1Bvb2wAAAAD",
        "AAAAAAAAAN9DbG9zZSB0aGUgZGVhZGxpbmUgYXVjdGlvbjogY2FwdHVyZSAoYWxsIGxlZ3MgaW4gdGhpcyBvbmUgdHJhbnNhY3Rpb24pCmlmIHRoZSB0aHJlc2hvbGQgcHJlZGljYXRlIGhvbGRzIHdpdGhpbiB0aGUgY2FwdHVyZSB3aW5kb3csIGVsc2UgYWJvcnQKYW5kIHJlbGVhc2UgZXZlcnkgY29tbWl0dGVkIGNoaWxkLiBDYWxsYWJsZSBieSBhbnlvbmUsIG5ldmVyIGJlZm9yZQp0aGUgZGVhZGxpbmUuAAAAAApjbGVhcl9wb29sAAAAAAABAAAAAAAAAAdwb29sX2lkAAAAA+4AAAAgAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAHNSZW1vdmUgYW4gb2JqZWN0aXZlbHktaW5lbGlnaWJsZSBtZW1iZXIgYW5kIGZyZWUgaXRzIHNsb3QuClBlcm1pc3Npb25sZXNzOyBjYW4gbmV2ZXIgZXZpY3QgYSBzdGlsbC1lbGlnaWJsZSBtZW1iZXIuAAAAAAtldmljdF9jaGlsZAAAAAACAAAAAAAAAAdwb29sX2lkAAAAA+4AAAAgAAAAAAAAAAptYW5kYXRlX2lkAAAAAAPuAAAAIAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAD5SZWFkLW9ubHkgYWNjZXNzb3IgZm9yIHRoZSBzdG9yZWQgbWFuZGF0ZSAoYXVkaXQgLyBwcmVmbGlnaHQpLgAAAAAAC2dldF9tYW5kYXRlAAAAAAEAAAAAAAAACm1hbmRhdGVfaWQAAAAAA+4AAAAgAAAAAQAAA+kAAAfQAAAAB01hbmRhdGUAAAAAAw==",
        "AAAAAAAAAIBMaW5rIGEgcG9vbGVkIG1hbmRhdGUgaW50byBpdHMgcG9vbCBhcyBhIENvbW1pdHRlZCBtZW1iZXIuClBlcm1pc3Npb25sZXNzIChvYmplY3RpdmUgY2hlY2tzIG9ubHkpOyByZXZvY2FibGUgdW50aWwgdGhlIGRlYWRsaW5lLgAAAAxjb21taXRfY2hpbGQAAAABAAAAAAAAAAptYW5kYXRlX2lkAAAAAAPuAAAAIAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAQxSZWdpc3RlciBhIGNsZWFyaW5nIHBvb2wuIFRoZSByZXR1cm5lZCBwb29sIGlkIGlzIGRlcml2ZWQgZnJvbSB0aGUKdGVybXMgKHNoYTI1NiBvZiB0aGVpciBYRFIpLCBzbyB0aGUgaWQgY29tbWl0cyB0byB0aGUgdGVybXMuCkF1dGhvcml6ZWQgYnkgYG9yaWdpbmF0b3JgIOKAlCB0aGUgbGFzdCBzcGVjaWFsIHNpZ25hdHVyZSB0aGUgcG9vbCBldmVyCnJlcXVpcmVzOiBldmVyeXRoaW5nIGFmdGVyIHRoaXMgaXMgcGVybWlzc2lvbmxlc3MgYW5kIGRldGVybWluaXN0aWMuAAAADXJlZ2lzdGVyX3Bvb2wAAAAAAAAJAAAAAAAAAApvcmlnaW5hdG9yAAAAAAATAAAAAAAAAAhtZXJjaGFudAAAABMAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAEa2luZAAAB9AAAAAMQ2xlYXJpbmdLaW5kAAAAAAAAAA10aHJlc2hvbGRfcXR5AAAAAAAACgAAAAAAAAAPdGhyZXNob2xkX3ZhbHVlAAAAAAoAAAAAAAAAD21pbl9jaGlsZF92YWx1ZQAAAAAKAAAAAAAAABFjbGVhcmluZ19kZWFkbGluZQAAAAAAAAYAAAAAAAAABW5vbmNlAAAAAAAD7gAAACAAAAABAAAD6QAAA+4AAAAgAAAAAw==",
        "AAAAAAAAAJVVc2VyIHdpdGhkcmF3cyBjb25zZW50OyBtYXJrcyB0aGUgbWFuZGF0ZSBSZXZva2VkLiBBdXRob3JpemVkIGJ5IHRoZQp1c2VyLiBBbHNvIGZyZWVzIHRoZSBwb29sIHNsb3Qgb2YgYSBDb21taXR0ZWQgY2hpbGQgKGl0cyBvbmUKcHJlLWRlYWRsaW5lIGV4aXQpLgAAAAAAAA5yZXZva2VfbWFuZGF0ZQAAAAAAAQAAAAAAAAAKbWFuZGF0ZV9pZAAAAAAD7gAAACAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAM1SZWFkLW9ubHk6IHRoZSBleGFjdCBvdXRjb21lIGBjbGVhcl9wb29sYCB3b3VsZCBleGVjdXRlIGFnYWluc3QgY3VycmVudApsZWRnZXIgc3RhdGUuIFNhbWUgYnVpbGRlciwgc2FtZSBjbGVhcmluZyBmdW5jdGlvbiDigJQgcmVjb21wdXRlIHRoaXMgdG8KdmVyaWZ5IHRoZSBvcmlnaW5hdG9yIGhhZCBubyBkaXNjcmV0aW9uIG92ZXIgdGhlIGFsbG9jYXRpb24uAAAAAAAADnNpbXVsYXRlX2NsZWFyAAAAAAABAAAAAAAAAAdwb29sX2lkAAAAA+4AAAAgAAAAAQAAA+kAAAfQAAAADENsZWFyT3V0Y29tZQAAAAM=",
        "AAAAAAAAAV1UaGUgc29sbyBtb25leSBwYXRoLiBBdG9taWM6IHJlcXVpcmVfYXV0aChhZ2VudCkg4oaSIHJlcGxheSBndWFyZAooYGV4cGVjdGVkX3NlcWAgPT0gY3VycmVudCBgc2VxYCwgZWxzZSBgQmFkU2VxdWVuY2VgKSDihpIgcmUtdmFsaWRhdGUg4oaSCmFkdmFuY2Ugc3BlbnQrc2VxIOKGkiBTRVAtNDEgdHJhbnNmZXJfZnJvbSh1c2VyIOKGkiBtZXJjaGFudCkuIFJldmVydHMgb24gYW55CmZhaWx1cmUuIGBleHBlY3RlZF9zZXFgIGlzIHRoZSBtYW5kYXRlJ3MgY3VycmVudCBzZXF1ZW5jZSAocmVhZCBmcm9tCmBnZXRfbWFuZGF0ZWApLCBwcmV2ZW50aW5nIGR1cGxpY2F0ZS9vdXQtb2Ytb3JkZXIgY29uc3VtcHRpb24uAAAAAAAAD2V4ZWN1dGVfcGF5bWVudAAAAAADAAAAAAAAAAptYW5kYXRlX2lkAAAAAAPuAAAAIAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAxleHBlY3RlZF9zZXEAAAAEAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAFdSZWFkLW9ubHk6IGN1cnJlbnQgbWVtYmVyIG1hbmRhdGUgaWRzIChjb21taXQgb3JkZXI7IGZyb3plbiBvbmNlIHRoZQpwb29sIGlzIHRlcm1pbmFsKS4AAAAAEGdldF9wb29sX21lbWJlcnMAAAABAAAAAAAAAAdwb29sX2lkAAAAA+4AAAAgAAAAAQAAA+kAAAPqAAAD7gAAACAAAAAD",
        "AAAAAAAAAbZTdG9yZSBhIHVzZXItc2lnbmVkIG1hbmRhdGUgZnJvbSBpdHMgYXV0aG9yaXplZCBwYXJhbWV0ZXJzLiBUaGUgY29udHJhY3QKc2V0cyBgc3BlbnQ9MCwgc2VxPTAsIHN0YXR1cz1BY3RpdmVgIGl0c2VsZi4gQXV0aG9yaXplZCBieSBgdXNlcmAuClJldHVybnMgdGhlIG1hbmRhdGUgaWQgKD0gYHZjX2hhc2hgLCB0aGUgc3RvcmFnZSBrZXkpLgoKYHBvb2xfaWQgPSBOb25lYCArIGVtcHR5IGBwcmljZV9zY2hlZHVsZWAgPT0gYSBzdGFuZGFsb25lIG1hbmRhdGUKKHRoZSBwcmUtY29tcG9zaXRlIGJlaGF2aW9yLCB1bmNoYW5nZWQpLiBgcG9vbF9pZCA9IFNvbWUoaWQpYCBiaW5kcyB0aGUKbWFuZGF0ZSB0byBhIGNsZWFyaW5nIHBvb2w7IHRoZSBzY2hlZHVsZSBpcyB0aGUgdXNlcidzIGF1dGhvcml6YXRpb24KZm9yIHRoZSBwb29sIHBhdGggKHNlZSBgcmVnaXN0cnlgKS4AAAAAABByZWdpc3Rlcl9tYW5kYXRlAAAACQAAAAAAAAAEdXNlcgAAABMAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAIbWVyY2hhbnQAAAATAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAACm1heF9hbW91bnQAAAAAAAsAAAAAAAAABmV4cGlyeQAAAAAABgAAAAAAAAAHdmNfaGFzaAAAAAPuAAAAIAAAAAAAAAAHcG9vbF9pZAAAAAPoAAAD7gAAACAAAAAAAAAADnByaWNlX3NjaGVkdWxlAAAAAAPqAAAH0AAAAA1TY2hlZHVsZVBvaW50AAAAAAAAAQAAA+kAAAPuAAAAIAAAAAM=",
        "AAAAAAAAAURSZWFkLW9ubHkgcHJlZmxpZ2h0IOKAlCB3b3VsZCB0aGlzIHNwZW5kIGJlIHBlcm1pdHRlZCByaWdodCBub3c/IE11dGF0ZXMKbm90aGluZyBhbmQgcmVxdWlyZXMgbm8gYXV0aDsgdGhlIGF1dGhvcml0YXRpdmUgY29uc3VtZSBoYXBwZW5zIG9ubHkgaW4KYGV4ZWN1dGVfcGF5bWVudGAuIChJdCBpcyBhIGRyeS1ydW47IGl0IGNvbnN1bWVzIG5vdGhpbmcuKSBSZWZsZWN0cwpwb29sIHN0YXRlIHRvbzogYSBDb21taXR0ZWQvQ2FwdHVyZWQgY2hpbGQgcHJlZmxpZ2h0cyBgTWFuZGF0ZVBvb2xlZGAsCmV4YWN0bHkgd2hhdCBgZXhlY3V0ZV9wYXltZW50YCB3b3VsZCBkby4AAAAQdmFsaWRhdGVfbWFuZGF0ZQAAAAMAAAAAAAAACm1hbmRhdGVfaWQAAAAAA+4AAAAgAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAACG1lcmNoYW50AAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAGwAAAAAAAAANQWxyZWFkeUV4aXN0cwAAAAAAAAEAAAAAAAAACE5vdEZvdW5kAAAAAgAAAAAAAAAOTWFuZGF0ZUV4cGlyZWQAAAAAAAQAAAAAAAAADk1hbmRhdGVSZXZva2VkAAAAAAAFAAAAAAAAAA5CdWRnZXRFeGNlZWRlZAAAAAAABgAAAAAAAAASTWVyY2hhbnRPdXRPZlNjb3BlAAAAAAAHAAAAAAAAAAtCYWRTZXF1ZW5jZQAAAAAIAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAACQAAAAAAAAAMUG9vbE5vdEZvdW5kAAAACwAAAAAAAAALUG9vbE5vdE9wZW4AAAAADAAAAAAAAAAPU2NoZWR1bGVJbnZhbGlkAAAAAA0AAAAAAAAAFFBvb2xNZXJjaGFudE1pc21hdGNoAAAADgAAAAAAAAARUG9vbEFzc2V0TWlzbWF0Y2gAAAAAAAAPAAAAAAAAAA5EZWFkbGluZVBhc3NlZAAAAAAAEAAAAGdSZXNlcnZlZCBmb3Igb3V0Y29tZS1zdHlsZSByZXBvcnRpbmc7IHRoZSBhYm9ydCBicmFuY2ggaXMgYSBzdWNjZXNzCihzdGF0ZSBmbGlwICsgZXZlbnQpLCBub3QgYW4gZXJyb3IuAAAAAA9UaHJlc2hvbGROb3RNZXQAAAAAEQAAAAAAAAAIUG9vbEZ1bGwAAAASAAAAAAAAAAxCYWRQb29sU3RhdGUAAAATAAAAAAAAAA1NYW5kYXRlUG9vbGVkAAAAAAAAFAAAAAAAAAARSW5zdWZmaWNpZW50RnVuZHMAAAAAAAAVAAAAAAAAABBLaW5kTm90U3VwcG9ydGVkAAAAFgAAAAAAAAAJTm90UG9vbGVkAAAAAAAAGQAAAAAAAAAURXhwaXJ5QmVmb3JlRGVhZGxpbmUAAAAaAAAAAAAAAA1CZWxvd01pbkNoaWxkAAAAAAAAGwAAAAAAAAAPRHVwbGljYXRlTWVtYmVyAAAAABwAAAAAAAAAEkRlYWRsaW5lTm90UmVhY2hlZAAAAAAAHQAAAAAAAAAORGVhZGxpbmVUb29GYXIAAAAAAB4AAAAAAAAAE01lbWJlclN0aWxsRWxpZ2libGUAAAAAHw==",
        "AAAAAgAAAAAAAAAAAAAABlN0YXR1cwAAAAAAAwAAAAAAAAAAAAAABkFjdGl2ZQAAAAAAAAAAAAAAAAAHUmV2b2tlZAAAAAAAAAAAAAAAAAlFeGhhdXN0ZWQAAAA=",
        "AAAAAQAAAAAAAAAAAAAAB01hbmRhdGUAAAAADQAAADdUaGUgT05MWSBwcmluY2lwYWwgcGVybWl0dGVkIHRvIGNhbGwgYGV4ZWN1dGVfcGF5bWVudGAuAAAAAAVhZ2VudAAAAAAAABMAAAArU0VQLTQxIC8gU0FDIGNvbnRyYWN0IGlkIChVU0RDIG9uIHRlc3RuZXQpLgAAAAAFYXNzZXQAAAAAAAATAAAAQUxlZGdlciBjbG9zZSB0aW1lc3RhbXAgKHNlY29uZHMpIGFmdGVyIHdoaWNoIHRoZSBtYW5kYXRlIGlzIGRlYWQuAAAAAAAABmV4cGlyeQAAAAAABgAAACdUb3RhbCBidWRnZXQgYXV0aG9yaXplZCBieSB0aGUgbWFuZGF0ZS4AAAAACm1heF9hbW91bnQAAAAAAAsAAABETVZQOiBzaW5nbGUgYWxsb3dlZCBwYXllZSAoc2NvcGUpLiBUMTogYFZlYzxBZGRyZXNzPmAgb3Igc2NvcGUtaGFzaC4AAAAIbWVyY2hhbnQAAAATAAAAOWBOb25lYCA9PSBzdGFuZGFsb25lOiBleGFjdGx5IHRoZSBwcmUtY29tcG9zaXRlIGJlaGF2aW9yLgAAAAAAAAdwb29sX2lkAAAAA+gAAAPuAAAAIAAAAAAAAAAKcG9vbF9zdGF0ZQAAAAAH0AAAAAlQb29sU3RhdGUAAAAAAAAoVGhlIGRlbWFuZCBjdXJ2ZTsgZW1wdHkgd2hlbiBzdGFuZGFsb25lLgAAAA5wcmljZV9zY2hlZHVsZQAAAAAD6gAAB9AAAAANU2NoZWR1bGVQb2ludAAAAAAAAD9Nb25vdG9uaWMgcGF5bWVudCBjb3VudGVyIChtYW5kYXRlLWxldmVsIGF1ZGl0IC8gcmVwbGF5IGd1YXJkKS4AAAAAA3NlcQAAAAAEAAAAO0N1bXVsYXRpdmUgY29uc3VtZWQ7IGludmFyaWFudDogYDAgPD0gc3BlbnQgPD0gbWF4X2Ftb3VudGAuAAAAAAVzcGVudAAAAAAAAAsAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAZTdGF0dXMAAAAAAD1TaWduZXIgb2YgdGhlIEFQMiBJbnRlbnRNYW5kYXRlOyBncmFudHMgdGhlIFNFUC00MSBhbGxvd2FuY2UuAAAAAAAABHVzZXIAAAATAAAASUhhc2ggYmluZGluZyB0byB0aGUgb2ZmLWNoYWluIEFQMiBJbnRlbnRNYW5kYXRlIFZDOyBhbHNvIHRoZSBzdG9yYWdlIGtleS4AAAAAAAAHdmNfaGFzaAAAAAPuAAAAIA==",
        "AAAAAgAAAMNQb29sIGxpbmthZ2UgbGlmZWN5Y2xlLCBvcnRob2dvbmFsIHRvIGBTdGF0dXNgLiBgVW5saW5rZWRgIGFuZCBgUmVsZWFzZWRgCmNoaWxkcmVuIG1heSBzcGVuZCBvbiB0aGUgc29sbyBwYXRoICh0aGVpciBvd24gbGltaXRzIHN0aWxsIGFwcGx5KTsKYENvbW1pdHRlZGAgYW5kIGBDYXB0dXJlZGAgbWF5IG5vdCAoYE1hbmRhdGVQb29sZWRgKS4AAAAAAAAAAAlQb29sU3RhdGUAAAAAAAAEAAAAAAAAAAAAAAAIVW5saW5rZWQAAAAAAAAAAAAAAAlDb21taXR0ZWQAAAAAAAAAAAAAAAAAAAhDYXB0dXJlZAAAAAAAAAAAAAAACFJlbGVhc2Vk",
        "AAAAAQAAAAAAAAAAAAAADVNjaGVkdWxlUG9pbnQAAAAAAAACAAAAPlN0cmljdGx5IGRlc2NlbmRpbmcgYWNyb3NzIHRoZSBzY2hlZHVsZTsgZWFjaCBpbiAoMCwgTUFYX1FUWV0uAAAAAAAHbWF4X3F0eQAAAAAKAAAARFN0cmljdGx5IGFzY2VuZGluZyBhY3Jvc3MgdGhlIHNjaGVkdWxlOyBlYWNoIGluICgwLCBNQVhfVU5JVF9QUklDRV0uAAAACnVuaXRfcHJpY2UAAAAAAAs=",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAAwAAAAEAAAAAAAAAB01hbmRhdGUAAAAAAQAAA+4AAAAgAAAAAQAAAAAAAAAEUG9vbAAAAAEAAAPuAAAAIAAAAAEAAAAAAAAAC1Bvb2xNZW1iZXJzAAAAAAEAAAPuAAAAIA==",
        "AAAAAQAAANNUaGUgcm93IGBwb29sLnJzYCBidWlsZHMgcGVyIGNvbW1pdHRlZCBjaGlsZCBhbmQgZmVlZHMgdG8gYGNsZWFyaW5nOjpjbGVhcmAuCkZlZWRpbmcgcGxhaW4gdmFsdWVzIChub3Qgc3RvcmFnZSBoYW5kbGVzKSBpcyB3aGF0IGtlZXBzIHRoZSBjbGVhcmluZwpmdW5jdGlvbiBwdXJlIGFuZCBtYWtlcyBzaW11bGF0ZSA9PSBjYXB0dXJlIGEgcHJvdmFibGUgZXF1YWxpdHkuAAAAAAAAAAAJQ2hpbGRWaWV3AAAAAAAABAAAAEJEZWNpZGVkIG9uY2UsIGJlZm9yZSBhbnkgcHJpY2UgZXhpc3RzIOKAlCBzZWUgcG9vbC5ycyBlbGlnaWJpbGl0eS4AAAAAAAhlbGlnaWJsZQAAAAEAAAAAAAAACm1hbmRhdGVfaWQAAAAAA+4AAAAgAAAAAAAAAAhzY2hlZHVsZQAAA+oAAAfQAAAADVNjaGVkdWxlUG9pbnQAAAAAAAAAAAAACndvcnN0X2Nhc2UAAAAAAAs=",
        "AAAAAQAAAAAAAAAAAAAACkFsbG9jYXRpb24AAAAAAAIAAAAAAAAACm1hbmRhdGVfaWQAAAAAA+4AAAAgAAAAAAAAAANxdHkAAAAACg==",
        "AAAAAgAAAAAAAAAAAAAAClBvb2xTdGF0dXMAAAAAAAMAAAAAAAAAAAAAAARPcGVuAAAAAAAAAAAAAAAHQ2xlYXJlZAAAAAAAAAAAAAAAAAdBYm9ydGVkAA==",
        "AAAAAgAAAAAAAAAAAAAADENsZWFyaW5nS2luZAAAAAMAAAAAAAAAAAAAAA5UaHJlc2hvbGRGbG9vcgAAAAAAAAAAAEZSZXNlcnZlZCBmb3IgU3RhZ2UgMjsgYHJlZ2lzdGVyX3Bvb2xgIHJlamVjdHMgd2l0aCBgS2luZE5vdFN1cHBvcnRlZGAuAAAAAAAMU3BlbmRDZWlsaW5nAAAAAAAAAEZSZXNlcnZlZCBmb3IgU3RhZ2UgMjsgYHJlZ2lzdGVyX3Bvb2xgIHJlamVjdHMgd2l0aCBgS2luZE5vdFN1cHBvcnRlZGAuAAAAAAAPQ2FwYWNpdHlDZWlsaW5nAA==",
        "AAAAAQAAAAAAAAAAAAAADENsZWFyaW5nUG9vbAAAAAsAAAAAAAAABWFzc2V0AAAAAAAAEwAAAEdVbml4IHNlY29uZHMuIENhcHR1cmUgaXMgYSBkZWFkbGluZSBhdWN0aW9uOiBuZXZlciBiZWZvcmUgdGhpcyBpbnN0YW50LgAAAAARY2xlYXJpbmdfZGVhZGxpbmUAAAAAAAAGAAAAvEZlZSByYXRlIGNhcHR1cmVkIGF0IGByZWdpc3Rlcl9wb29sYDsgY2FwdHVyZSBuZXZlciByZWFkcyBhIGxpdmUgcmF0ZS4KQWx3YXlzIDAgaW4gdGhpcyBkZXBsb3kgKHRoZSBmZWUga25vYiBzaGlwcyBpbiBpdHMgb3duIHBhc3MpOyB0aGUgZmllbGQKZXhpc3RzIHNvIHRoYXQgcGFzcyBpcyBub3QgYW5vdGhlciBBQkkgYnJlYWsuAAAADmZlZV9icHNfcGlubmVkAAAAAAAEAAAAAAAAAARraW5kAAAH0AAAAAxDbGVhcmluZ0tpbmQAAAA9TGl2ZSBDb21taXR0ZWQgbWVtYmVycyB3aGlsZSBPcGVuOyBmcm96ZW4gYXQgdGVybWluYWwgc3RhdHVzLgAAAAAAAAxtZW1iZXJfY291bnQAAAAEAAAAAAAAAAhtZXJjaGFudAAAABMAAABCRmxvb3Igb24gZWFjaCBjb21taXR0aW5nIGNoaWxkJ3Mgd29yc3RfY2FzZSAoYW50aS1kdXN0IHNxdWF0dGluZykuAAAAAAAPbWluX2NoaWxkX3ZhbHVlAAAAAAoAAACDU2lnbnMgYHJlZ2lzdGVyX3Bvb2xgOyBob2xkcyBOTyBsYXRlciBwb3dlciDigJQgY2xlYXJpbmcgaXMgcGVybWlzc2lvbmxlc3MKYW5kIGRldGVybWluaXN0aWMsIHdoaWNoIGlzIHRoZSB3aG9sZSBuby1za2ltIGd1YXJhbnRlZS4AAAAACm9yaWdpbmF0b3IAAAAAABMAAAAAAAAABnN0YXR1cwAAAAAH0AAAAApQb29sU3RhdHVzAAAAAABGVmVuZG9yIG1pbmltdW0gdW5pdHM7IHRoZSBwb29sIGZpcmVzIG9ubHkgaWYgYWdncmVnYXRlIHF0eSByZWFjaGVzIGl0LgAAAAAADXRocmVzaG9sZF9xdHkAAAAAAAAKAAAAQFZlbmRvciBtaW5pbXVtIG9yZGVyIHZhbHVlLCBjb21wYXJlZCBORVQgb2YgZmVlIHRvIHRoZSBtZXJjaGFudC4AAAAPdGhyZXNob2xkX3ZhbHVlAAAAAAo=",
        "AAAAAQAAAAAAAAAAAAAADENsZWFyT3V0Y29tZQAAAAcAAAAfbWFuZGF0ZV9pZCBvcmRlciwgcXR5ID4gMCBvbmx5LgAAAAALYWxsb2NhdGlvbnMAAAAD6gAAB9AAAAAKQWxsb2NhdGlvbgAAAAAALVRoZSBzaW5nbGUgdW5pZm9ybSBwcmljZSBwKjsgMCB3aGVuIGAhZmlyZXNgLgAAAAAAAA5jbGVhcmluZ19wcmljZQAAAAAACwAAAAAAAAAFZmlyZXMAAAAAAAABAAAAAAAAAAtncm9zc192YWx1ZQAAAAALAAAARGBncm9zc192YWx1ZSAtIHRvdGFsX2ZlZWA7IHRoZSBudW1iZXIgY29tcGFyZWQgdG8gYHRocmVzaG9sZF92YWx1ZWAuAAAACW5ldF92YWx1ZQAAAAAAAAsAAAAAAAAACXRvdGFsX2ZlZQAAAAAAAAsAAAAAAAAACXRvdGFsX3F0eQAAAAAAAAo=" ]),
      options
    )
  }
  public readonly fromJSON = {
    get_pool: this.txFromJSON<Result<ClearingPool>>,
        clear_pool: this.txFromJSON<Result<void>>,
        evict_child: this.txFromJSON<Result<void>>,
        get_mandate: this.txFromJSON<Result<Mandate>>,
        commit_child: this.txFromJSON<Result<void>>,
        register_pool: this.txFromJSON<Result<Buffer>>,
        revoke_mandate: this.txFromJSON<Result<void>>,
        simulate_clear: this.txFromJSON<Result<ClearOutcome>>,
        execute_payment: this.txFromJSON<Result<void>>,
        get_pool_members: this.txFromJSON<Result<Array<Buffer>>>,
        register_mandate: this.txFromJSON<Result<Buffer>>,
        validate_mandate: this.txFromJSON<Result<void>>
  }
}