import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
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
  },
} as const;
export interface PendingUpgrade {
  execute_after: u64;
  wasm_hash: Buffer;
}

export const Errors = {
  1: {message:"AlreadyExists"},
  2: {message:"NotFound"},
  4: {message:"MandateExpired"},
  5: {message:"MandateRevoked"},
  6: {message:"BudgetExceeded"},
  7: {message:"MerchantOutOfScope"},
  8: {message:"BadSequence"},
  9: {message:"InvalidAmount"},
  10: {message:"Paused"},
  11: {message:"UpgradeNotScheduled"},
  12: {message:"UpgradeNotReady"},
  13: {message:"UpgradeAlreadyScheduled"},
  14: {message:"UpgradeRequiresPause"}
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
 * MVP: single allowed payee (scope). Future: `Vec<Address>` or scope-hash.
 */
merchant: string;
  /**
 * Monotonic payment counter (mandate-level trace / replay guard).
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

export type DataKey = {tag: "Admin", values: void} | {tag: "Paused", values: void} | {tag: "PendingUpgrade", values: void} | {tag: "Mandate", values: readonly [Buffer]};

export interface Client {
  /**
   * Construct and simulate a pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Emergency stop for the sole money-moving path.
   */
  pause: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a unpause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Restore the money-moving path after an emergency stop.
   */
  unpause: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Current operational administrator.
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a is_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read the emergency-stop state without authorization.
   */
  is_paused: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a set_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Rotate operational authority. Authorized by the current administrator.
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_mandate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only accessor for the stored mandate (inspection / preflight).
   */
  get_mandate: ({mandate_id}: {mandate_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Mandate>>>

  /**
   * Construct and simulate a cancel_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancel the currently scheduled upgrade.
   */
  cancel_upgrade: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a revoke_mandate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * User withdraws consent; marks the mandate Revoked. Authorized by the user.
   */
  revoke_mandate: ({mandate_id}: {mandate_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_payment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The only money path. Atomic: require_auth(agent) → replay guard
   * (`expected_seq` == current `seq`, else `BadSequence`) → re-validate →
   * advance spent+seq → SEP-41 transfer_from(user → merchant). Reverts on any
   * failure. `expected_seq` is the mandate's current sequence (read from
   * `get_mandate`), preventing duplicate/out-of-order consumption.
   */
  execute_payment: ({mandate_id, amount, expected_seq}: {mandate_id: Buffer, amount: i128, expected_seq: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Execute the scheduled upgrade after the delay while the contract is paused.
   */
  execute_upgrade: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_mandate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Store a user-signed mandate from its authorized parameters. The contract
   * sets `spent=0, seq=0, status=Active` itself. Authorized by `user`.
   * Returns the mandate id (= `vc_hash`, the storage key).
   */
  register_mandate: ({user, agent, merchant, asset, max_amount, expiry, vc_hash}: {user: string, agent: string, merchant: string, asset: string, max_amount: i128, expiry: u64, vc_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Buffer>>>

  /**
   * Construct and simulate a schedule_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Schedule a same-address WASM upgrade after the fixed one-hour delay.
   */
  schedule_upgrade: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a validate_mandate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only preflight — would this spend be permitted right now? Mutates
   * nothing and requires no auth; the authoritative consume happens only in
   * `execute_payment`. (It is a dry-run; it consumes nothing.)
   */
  validate_mandate: ({mandate_id, amount, merchant}: {mandate_id: Buffer, amount: i128, merchant: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_upgrade_delay transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Fixed timelock duration in seconds.
   */
  get_upgrade_delay: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a get_pending_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read the pending upgrade, including hash and earliest execution time.
   */
  get_pending_upgrade: (options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingUpgrade>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin}: {admin: string},
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
    return ContractClient.deploy({admin}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAAC5FbWVyZ2VuY3kgc3RvcCBmb3IgdGhlIHNvbGUgbW9uZXktbW92aW5nIHBhdGguAAAAAAAFcGF1c2UAAAAAAAAAAAAAAA==",
        "AAAAAAAAADZSZXN0b3JlIHRoZSBtb25leS1tb3ZpbmcgcGF0aCBhZnRlciBhbiBlbWVyZ2VuY3kgc3RvcC4AAAAAAAd1bnBhdXNlAAAAAAAAAAAA",
        "AAAAAAAAACJDdXJyZW50IG9wZXJhdGlvbmFsIGFkbWluaXN0cmF0b3IuAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAADRSZWFkIHRoZSBlbWVyZ2VuY3ktc3RvcCBzdGF0ZSB3aXRob3V0IGF1dGhvcml6YXRpb24uAAAACWlzX3BhdXNlZAAAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAEZSb3RhdGUgb3BlcmF0aW9uYWwgYXV0aG9yaXR5LiBBdXRob3JpemVkIGJ5IHRoZSBjdXJyZW50IGFkbWluaXN0cmF0b3IuAAAAAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAENSZWFkLW9ubHkgYWNjZXNzb3IgZm9yIHRoZSBzdG9yZWQgbWFuZGF0ZSAoaW5zcGVjdGlvbiAvIHByZWZsaWdodCkuAAAAAAtnZXRfbWFuZGF0ZQAAAAABAAAAAAAAAAptYW5kYXRlX2lkAAAAAAPuAAAAIAAAAAEAAAPpAAAH0AAAAAdNYW5kYXRlAAAAAAM=",
        "AAAAAAAAAIRBdG9taWNhbGx5IGVzdGFibGlzaGVzIHRoZSBpbml0aWFsIGFkbWluaXN0cmF0b3IgZHVyaW5nIGRlcGxveW1lbnQuCkNvbnN0cnVjdG9ycyBydW4gb25seSBvbmNlOyBXQVNNIHVwZ3JhZGVzIGRvIG5vdCBydW4gdGhlbSBhZ2Fpbi4AAAANX19jb25zdHJ1Y3RvcgAAAAAAAAEAAAAAAAAABWFkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAACdDYW5jZWwgdGhlIGN1cnJlbnRseSBzY2hlZHVsZWQgdXBncmFkZS4AAAAADmNhbmNlbF91cGdyYWRlAAAAAAAAAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAEpVc2VyIHdpdGhkcmF3cyBjb25zZW50OyBtYXJrcyB0aGUgbWFuZGF0ZSBSZXZva2VkLiBBdXRob3JpemVkIGJ5IHRoZSB1c2VyLgAAAAAADnJldm9rZV9tYW5kYXRlAAAAAAABAAAAAAAAAAptYW5kYXRlX2lkAAAAAAPuAAAAIAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAV1UaGUgb25seSBtb25leSBwYXRoLiBBdG9taWM6IHJlcXVpcmVfYXV0aChhZ2VudCkg4oaSIHJlcGxheSBndWFyZAooYGV4cGVjdGVkX3NlcWAgPT0gY3VycmVudCBgc2VxYCwgZWxzZSBgQmFkU2VxdWVuY2VgKSDihpIgcmUtdmFsaWRhdGUg4oaSCmFkdmFuY2Ugc3BlbnQrc2VxIOKGkiBTRVAtNDEgdHJhbnNmZXJfZnJvbSh1c2VyIOKGkiBtZXJjaGFudCkuIFJldmVydHMgb24gYW55CmZhaWx1cmUuIGBleHBlY3RlZF9zZXFgIGlzIHRoZSBtYW5kYXRlJ3MgY3VycmVudCBzZXF1ZW5jZSAocmVhZCBmcm9tCmBnZXRfbWFuZGF0ZWApLCBwcmV2ZW50aW5nIGR1cGxpY2F0ZS9vdXQtb2Ytb3JkZXIgY29uc3VtcHRpb24uAAAAAAAAD2V4ZWN1dGVfcGF5bWVudAAAAAADAAAAAAAAAAptYW5kYXRlX2lkAAAAAAPuAAAAIAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAxleHBlY3RlZF9zZXEAAAAEAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAEtFeGVjdXRlIHRoZSBzY2hlZHVsZWQgdXBncmFkZSBhZnRlciB0aGUgZGVsYXkgd2hpbGUgdGhlIGNvbnRyYWN0IGlzIHBhdXNlZC4AAAAAD2V4ZWN1dGVfdXBncmFkZQAAAAAAAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAMJTdG9yZSBhIHVzZXItc2lnbmVkIG1hbmRhdGUgZnJvbSBpdHMgYXV0aG9yaXplZCBwYXJhbWV0ZXJzLiBUaGUgY29udHJhY3QKc2V0cyBgc3BlbnQ9MCwgc2VxPTAsIHN0YXR1cz1BY3RpdmVgIGl0c2VsZi4gQXV0aG9yaXplZCBieSBgdXNlcmAuClJldHVybnMgdGhlIG1hbmRhdGUgaWQgKD0gYHZjX2hhc2hgLCB0aGUgc3RvcmFnZSBrZXkpLgAAAAAAEHJlZ2lzdGVyX21hbmRhdGUAAAAHAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAhtZXJjaGFudAAAABMAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAKbWF4X2Ftb3VudAAAAAAACwAAAAAAAAAGZXhwaXJ5AAAAAAAGAAAAAAAAAAd2Y19oYXNoAAAAA+4AAAAgAAAAAQAAA+kAAAPuAAAAIAAAAAM=",
        "AAAAAAAAAERTY2hlZHVsZSBhIHNhbWUtYWRkcmVzcyBXQVNNIHVwZ3JhZGUgYWZ0ZXIgdGhlIGZpeGVkIG9uZS1ob3VyIGRlbGF5LgAAABBzY2hlZHVsZV91cGdyYWRlAAAAAQAAAAAAAAANbmV3X3dhc21faGFzaAAAAAAAA+4AAAAgAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAMtSZWFkLW9ubHkgcHJlZmxpZ2h0IOKAlCB3b3VsZCB0aGlzIHNwZW5kIGJlIHBlcm1pdHRlZCByaWdodCBub3c/IE11dGF0ZXMKbm90aGluZyBhbmQgcmVxdWlyZXMgbm8gYXV0aDsgdGhlIGF1dGhvcml0YXRpdmUgY29uc3VtZSBoYXBwZW5zIG9ubHkgaW4KYGV4ZWN1dGVfcGF5bWVudGAuIChJdCBpcyBhIGRyeS1ydW47IGl0IGNvbnN1bWVzIG5vdGhpbmcuKQAAAAAQdmFsaWRhdGVfbWFuZGF0ZQAAAAMAAAAAAAAACm1hbmRhdGVfaWQAAAAAA+4AAAAgAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAACG1lcmNoYW50AAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAACNGaXhlZCB0aW1lbG9jayBkdXJhdGlvbiBpbiBzZWNvbmRzLgAAAAARZ2V0X3VwZ3JhZGVfZGVsYXkAAAAAAAAAAAAAAQAAAAY=",
        "AAAAAAAAAEVSZWFkIHRoZSBwZW5kaW5nIHVwZ3JhZGUsIGluY2x1ZGluZyBoYXNoIGFuZCBlYXJsaWVzdCBleGVjdXRpb24gdGltZS4AAAAAAAATZ2V0X3BlbmRpbmdfdXBncmFkZQAAAAAAAAAAAQAAA+gAAAfQAAAADlBlbmRpbmdVcGdyYWRlAAA=",
        "AAAAAQAAAAAAAAAAAAAADlBlbmRpbmdVcGdyYWRlAAAAAAACAAAAAAAAAA1leGVjdXRlX2FmdGVyAAAAAAAABgAAAAAAAAAJd2FzbV9oYXNoAAAAAAAD7gAAACA=",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAADQAAAAAAAAANQWxyZWFkeUV4aXN0cwAAAAAAAAEAAAAAAAAACE5vdEZvdW5kAAAAAgAAAAAAAAAOTWFuZGF0ZUV4cGlyZWQAAAAAAAQAAAAAAAAADk1hbmRhdGVSZXZva2VkAAAAAAAFAAAAAAAAAA5CdWRnZXRFeGNlZWRlZAAAAAAABgAAAAAAAAASTWVyY2hhbnRPdXRPZlNjb3BlAAAAAAAHAAAAAAAAAAtCYWRTZXF1ZW5jZQAAAAAIAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAACQAAAAAAAAAGUGF1c2VkAAAAAAAKAAAAAAAAABNVcGdyYWRlTm90U2NoZWR1bGVkAAAAAAsAAAAAAAAAD1VwZ3JhZGVOb3RSZWFkeQAAAAAMAAAAAAAAABdVcGdyYWRlQWxyZWFkeVNjaGVkdWxlZAAAAAANAAAAAAAAABRVcGdyYWRlUmVxdWlyZXNQYXVzZQAAAA4=",
        "AAAAAgAAAAAAAAAAAAAABlN0YXR1cwAAAAAAAwAAAAAAAAAAAAAABkFjdGl2ZQAAAAAAAAAAAAAAAAAHUmV2b2tlZAAAAAAAAAAAAAAAAAlFeGhhdXN0ZWQAAAA=",
        "AAAAAQAAAAAAAAAAAAAAB01hbmRhdGUAAAAACgAAADdUaGUgT05MWSBwcmluY2lwYWwgcGVybWl0dGVkIHRvIGNhbGwgYGV4ZWN1dGVfcGF5bWVudGAuAAAAAAVhZ2VudAAAAAAAABMAAAArU0VQLTQxIC8gU0FDIGNvbnRyYWN0IGlkIChVU0RDIG9uIHRlc3RuZXQpLgAAAAAFYXNzZXQAAAAAAAATAAAAQUxlZGdlciBjbG9zZSB0aW1lc3RhbXAgKHNlY29uZHMpIGFmdGVyIHdoaWNoIHRoZSBtYW5kYXRlIGlzIGRlYWQuAAAAAAAABmV4cGlyeQAAAAAABgAAACdUb3RhbCBidWRnZXQgYXV0aG9yaXplZCBieSB0aGUgbWFuZGF0ZS4AAAAACm1heF9hbW91bnQAAAAAAAsAAABETVZQOiBzaW5nbGUgYWxsb3dlZCBwYXllZSAoc2NvcGUpLiBUMTogYFZlYzxBZGRyZXNzPmAgb3Igc2NvcGUtaGFzaC4AAAAIbWVyY2hhbnQAAAATAAAAP01vbm90b25pYyBwYXltZW50IGNvdW50ZXIgKG1hbmRhdGUtbGV2ZWwgdHJhY2UgLyByZXBsYXkgZ3VhcmQpLgAAAAADc2VxAAAAAAQAAAA7Q3VtdWxhdGl2ZSBjb25zdW1lZDsgaW52YXJpYW50OiBgMCA8PSBzcGVudCA8PSBtYXhfYW1vdW50YC4AAAAABXNwZW50AAAAAAAACwAAAAAAAAAGc3RhdHVzAAAAAAfQAAAABlN0YXR1cwAAAAAAPVNpZ25lciBvZiB0aGUgQVAyIEludGVudE1hbmRhdGU7IGdyYW50cyB0aGUgU0VQLTQxIGFsbG93YW5jZS4AAAAAAAAEdXNlcgAAABMAAABJSGFzaCBiaW5kaW5nIHRvIHRoZSBvZmYtY2hhaW4gQVAyIEludGVudE1hbmRhdGUgVkM7IGFsc28gdGhlIHN0b3JhZ2Uga2V5LgAAAAAAAAd2Y19oYXNoAAAAA+4AAAAg",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAABAAAAAAAAAAAAAAABUFkbWluAAAAAAAAAAAAAAAAAAAGUGF1c2VkAAAAAAAAAAAAAAAAAA5QZW5kaW5nVXBncmFkZQAAAAAAAQAAAAAAAAAHTWFuZGF0ZQAAAAABAAAD7gAAACA=" ]),
      options
    )
  }
  public readonly fromJSON = {
    pause: this.txFromJSON<null>,
        unpause: this.txFromJSON<null>,
        get_admin: this.txFromJSON<string>,
        is_paused: this.txFromJSON<boolean>,
        set_admin: this.txFromJSON<null>,
        get_mandate: this.txFromJSON<Result<Mandate>>,
        cancel_upgrade: this.txFromJSON<Result<void>>,
        revoke_mandate: this.txFromJSON<Result<void>>,
        execute_payment: this.txFromJSON<Result<void>>,
        execute_upgrade: this.txFromJSON<Result<void>>,
        register_mandate: this.txFromJSON<Result<Buffer>>,
        schedule_upgrade: this.txFromJSON<Result<u64>>,
        validate_mandate: this.txFromJSON<Result<void>>,
        get_upgrade_delay: this.txFromJSON<u64>,
        get_pending_upgrade: this.txFromJSON<Option<PendingUpgrade>>
  }
}
