/**
 * @reapp-sdk/core — create an agent, connect to the testnet MandateRegistry, and
 * execute a crash-safe mandate-validated payment through a small typed surface.
 *
 * The SDK is UNTRUSTED infrastructure: it never holds the allowance (only the
 * contract does), and every spend is validated + consumed on-chain by
 * `execute_payment`. A buggy or malicious SDK cannot exceed the mandate.
 *
 *   const m = reapp.createIntentMandate({ user, agent, merchant, asset, maxAmount: "5.00", expiry });
 *   await reapp.registerMandate(m, { signer: userKey });
 *   await reapp.approveBudget(m,   { signer: userKey });
 *   const agent = reapp.agent({ mandate: m, signer: agentKey });
 *   await agent.pay("1.00", { onPrepared: (pending) => paymentJournal.save(pending) });
 */
import { Buffer } from "buffer";
import { Keypair, hash, rpc } from "@stellar/stellar-sdk";
import { TESTNET, keypairSigner, registryClient, token, type NetworkConfig } from "@reapp-sdk/stellar";
import {
  BOUND_PAYMENT_CAPABILITY,
  BOUND_PAYMENT_SCHEME,
  REAPP_PAYMENT_CAPABILITIES_HEADER,
  X_PAYMENT_HEADER,
  createBoundPaymentProof,
  parse402,
  encodePaymentProof,
  isBoundPaymentProof,
  type PaymentProof,
} from "./x402.js";
import { resolveExpectedPaymentSequence } from "./payment-sequence.js";

// Re-export the typed contract errors so apps can branch on them (e.g. Errors[6] is BudgetExceeded).
export { Errors } from "@reapp-sdk/stellar";
// Re-export the x402 wire-format adapter (parse402, proof encode/decode, header, types).
export * from "./x402.js";

export interface CreateIntentMandateInput {
  user: string;
  agent: string;
  merchant: string;
  asset: string;
  /** Human amount, e.g. "5.00". */
  maxAmount: string;
  /** Unix seconds after which the mandate is dead. */
  expiry: number;
  /** Token decimals (default 7, matching Stellar assets). */
  decimals?: number;
  /** Optional explicit nonce; defaults to a unique value so ids don't collide. */
  nonce?: string;
}

export interface IntentMandate {
  /** Canonical hash hex — the on-chain mandate id (`vc_hash`). */
  id: string;
  idBuffer: Buffer;
  user: string;
  agent: string;
  merchant: string;
  asset: string;
  /** Budget in stroops. */
  maxAmount: bigint;
  expiry: number;
  decimals: number;
}

export interface SignerInput {
  signer: Keypair | string;
}

export type PaymentProofPolicy = "legacy-compatible" | "bound-v2-only";

/**
 * Chain settlement evidence retained when HTTP delivery becomes uncertain.
 * Treat `proof` as sensitive bearer data. Bound proofs authorize only the
 * exact signed request, but anyone holding one may repeat that same request.
 */
export interface SettlementReceipt {
  receiptId: string;
  proofVersion: 1 | 2;
  url: string;
  method: string;
  txHash: string;
  mandateId: string;
  amount: string;
  submittedAt: number;
  validUntil: number;
  proof: Readonly<PaymentProof>;
}

/**
 * Durable receipt storage required by paid `fetch`. Implementations must
 * protect receipts as sensitive bearer material, make `savePending` durable
 * before broadcast, enumerate them across restarts, and clear only after
 * explicit application acknowledgment.
 */
export interface SettlementReceiptStore {
  savePending(receipt: Readonly<SettlementReceipt>): Promise<void>;
  clearPending(receiptId: string): Promise<void>;
  listPending(): Promise<ReadonlyArray<Readonly<SettlementReceipt>>>;
}

/**
 * Domain-separated integrity id for the complete recovery envelope. This is
 * not an authentication secret: the proof remains sensitive bearer material.
 * Covering the URL and method makes accidental or stale envelope mutation fail
 * before any HTTP request is attempted.
 */
export function createSettlementReceiptId(
  receipt: Omit<Readonly<SettlementReceipt>, "receiptId">,
): string {
  return hash(Buffer.from(JSON.stringify([
    "reapp-settlement-receipt-v2",
    receipt.proofVersion,
    receipt.url,
    receipt.method,
    receipt.txHash,
    receipt.mandateId,
    receipt.amount,
    receipt.submittedAt,
    receipt.validUntil,
    encodePaymentProof(receipt.proof),
  ]), "utf8")).toString("hex");
}

const deliveredReceipts = new WeakMap<Response, Readonly<SettlementReceipt>>();

/** Return the exact settlement receipt associated with a successful paid response. */
export function getSettlementReceipt(response: Response): Readonly<SettlementReceipt> | undefined {
  return deliveredReceipts.get(response);
}

/**
 * A canonical signed payment hash exists and broadcast may have been attempted,
 * but final settlement or paid HTTP delivery is not confirmed. Do not pay
 * again. Reconcile and retry the exact included receipt.
 */
export class DeliveryPendingError extends Error {
  readonly receipt: Readonly<SettlementReceipt>;

  constructor(receipt: Readonly<SettlementReceipt>, cause: unknown) {
    super(
      `payment transaction ${receipt.txHash} was prepared and broadcast may have been attempted, but settlement or delivery is pending; reconcile and retry the same receipt and do not pay again`,
      { cause },
    );
    this.name = "DeliveryPendingError";
    this.receipt = receipt;
  }
}

export interface PendingSettlement {
  txHash: string;
  mandateId: string;
  amount: string;
  expectedSeq: string;
  submittedAt: number;
  /** Exact signed transaction max-time. A missing ledger result is not safely
   *  final until this time has elapsed and RPC history still covers it. */
  validUntil: number;
  receiptId?: string;
}

export type SettlementReconciliation =
  | { kind: "none" }
  | { kind: "pending"; settlement: Readonly<PendingSettlement> }
  | { kind: "succeeded"; settlement: Readonly<PendingSettlement>; deliveryPending: boolean }
  | { kind: "failed"; settlement: Readonly<PendingSettlement> }
  | { kind: "expired"; settlement: Readonly<PendingSettlement> };

/** Broadcast was attempted for a signed transaction whose final result is unknown. */
export class SettlementUncertainError extends Error {
  readonly settlement: Readonly<PendingSettlement>;

  constructor(settlement: Readonly<PendingSettlement>, cause: unknown) {
    super(
      `payment transaction ${settlement.txHash} was prepared and broadcast was attempted, but its final result is uncertain; reconcile this hash before any new payment`,
      { cause },
    );
    this.name = "SettlementUncertainError";
    this.settlement = settlement;
  }
}

/** A finalized transaction returned a typed MandateRegistry contract rejection. */
export class PaymentRejectedError extends Error {
  readonly mandateId: string;

  constructor(mandateId: string, cause: unknown) {
    super(
      `payment rejected by contract for mandate ${mandateId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "PaymentRejectedError";
    this.mandateId = mandateId;
  }
}

export interface PaymentSubmissionLifecycle {
  holdUntilDelivery?: boolean;
  /** Optional immutable operation sequence. When supplied, the SDK refuses to
   *  prepare if current contract state has already advanced, making a lost-
   *  response retry fail before another transaction can be created. */
  expectedSeq?: string | number | bigint;
  /** Runs after signing and hash derivation but before broadcast. Throwing
   *  aborts without submitting, so callers can make the hash durable first. */
  onPrepared: (
    settlement: Readonly<PendingSettlement>,
  ) => void | string | Promise<void | string | undefined>;
  onSubmitted?: (txHash: string) => string | undefined;
}

const DEFAULT_DECIMALS = 7;
/** Transaction validity window (seconds) for the agent's execute_payment write.
 *  This is the network-enforced bound: the tx either lands within the window or
 *  is rejected as expired (never silently applied later). The SDK's default is
 *  short, so on a slow/congested testnet signAndSend can return before the result
 *  XDR exists; a wider window lets settlement resolve cleanly. */
const PAYMENT_TIMEOUT_SECONDS = 60;
/** The contract stores amounts as i128. Anything larger cannot fit. */
const I128_MAX = 2n ** 127n - 1n;
/** expiry is Unix seconds (a JS number). Bound it to the largest integer a
 *  number represents exactly, which is astronomically beyond any real timestamp
 *  yet well under u64 — so the value the SDK hashes and sends is never lossy. */
const MAX_EXPIRY = Number.MAX_SAFE_INTEGER;
const activeMandatePaymentClaims = new Map<string, symbol>();
const FINALIZED_CONTRACT_ERROR_CODES = new Set([
  1, 2, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
  25, 26, 27, 28, 29, 30, 31,
]);

/**
 * Convert a human amount to stroops (i128). Strict by design — this is money:
 * only a non-negative decimal like "5" or "5.00" is accepted. Negatives,
 * multiple dots, scientific notation, garbage, more than `decimals` fraction
 * digits, or a value too large for i128 all throw rather than silently produce a
 * wrong on-chain value.
 */
export function toStroops(human: string, decimals = DEFAULT_DECIMALS): bigint {
  const s = String(human).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid amount ${JSON.stringify(human)}: expected a non-negative decimal like "5.00".`);
  }
  const dot = s.indexOf(".");
  const whole = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? "" : s.slice(dot + 1);
  if (frac.length > decimals) {
    throw new Error(`Amount ${JSON.stringify(human)} has more than ${decimals} decimal places.`);
  }
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const stroops = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
  // The ScVal i128 encoder does NOT range-check — an over-large value would
  // silently two's-complement wrap into a wrong (even negative) on-chain amount.
  // Reject it here so the SDK fails loudly instead.
  if (stroops > I128_MAX) {
    throw new Error(`Amount ${JSON.stringify(human)} is too large to fit the contract's i128 amount field.`);
  }
  return stroops;
}

const asKeypair = (s: Keypair | string): Keypair =>
  typeof s === "string" ? Keypair.fromSecret(s) : s;

/** An agent bound to a registered mandate. Its only power is `pay`, and every
 *  payment is enforced on-chain against the mandate. */
export class Agent {
  private pendingSettlement?: Readonly<PendingSettlement>;
  private readonly paymentClaimOwner = Symbol("reapp-payment-claim");
  private paymentClaimKey?: string;

  constructor(
    private readonly net: NetworkConfig,
    private readonly mandate: IntentMandate,
    private readonly agentKeypair: Keypair,
    private readonly proofPolicy: PaymentProofPolicy = "legacy-compatible",
    private readonly receiptStore?: SettlementReceiptStore,
  ) {}

  private claimPaymentOperation(): void {
    if (this.paymentClaimKey) throw new Error("another payment operation is already active on this agent");
    const key = `${this.net.networkPassphrase}\n${this.net.mandateRegistryId}\n${this.mandate.id}`;
    if (activeMandatePaymentClaims.has(key)) {
      throw new Error("another payment operation for this mandate is already active");
    }
    activeMandatePaymentClaims.set(key, this.paymentClaimOwner);
    this.paymentClaimKey = key;
  }

  private releasePaymentOperation(): void {
    const key = this.paymentClaimKey;
    if (!key) return;
    if (activeMandatePaymentClaims.get(key) === this.paymentClaimOwner) {
      activeMandatePaymentClaims.delete(key);
    }
    this.paymentClaimKey = undefined;
  }

  private async hydratePendingReceipt(): Promise<Readonly<SettlementReceipt> | undefined> {
    if (this.pendingSettlement || !this.receiptStore) return undefined;
    const receipts = await this.receiptStore.listPending();
    const receipt = [...receipts]
      .filter((candidate) => candidate.mandateId === this.mandate.id)
      .sort((a, b) => a.receiptId.localeCompare(b.receiptId))[0];
    if (!receipt) return undefined;
    const expectedId = createSettlementReceiptId({
      proofVersion: receipt.proofVersion,
      url: receipt.url,
      method: receipt.method,
      txHash: receipt.txHash,
      mandateId: receipt.mandateId,
      amount: receipt.amount,
      submittedAt: receipt.submittedAt,
      validUntil: receipt.validUntil,
      proof: receipt.proof,
    });
    if (
      receipt.receiptId !== expectedId
      || receipt.txHash !== receipt.proof.txHash
      || receipt.mandateId !== receipt.proof.mandateId
      || !Number.isSafeInteger(receipt.submittedAt)
      || !Number.isSafeInteger(receipt.validUntil)
      || receipt.submittedAt <= 0
      || receipt.validUntil <= receipt.submittedAt
    ) {
      throw new Error("settlement receipt store returned invalid recovery evidence");
    }
    if (!this.paymentClaimKey) this.claimPaymentOperation();
    this.pendingSettlement = Object.freeze({
      txHash: receipt.txHash,
      mandateId: receipt.mandateId,
      amount: receipt.amount,
      expectedSeq: "unknown",
      submittedAt: receipt.submittedAt,
      validUntil: receipt.validUntil,
      receiptId: receipt.receiptId,
    });
    return receipt;
  }

  /** Execute a mandate-validated payment of `amount` (human, e.g. "1.00").
   *  Reads the current sequence, then calls the contract's `execute_payment`
   *  (agent-signed). Throws if the contract rejects it. Returns the tx hash. */
  async pay(amount: string, lifecycle: PaymentSubmissionLifecycle): Promise<string> {
    if (!lifecycle || typeof lifecycle.onPrepared !== "function") {
      throw new Error("pay requires an onPrepared durable settlement journal before any network call");
    }
    this.claimPaymentOperation();
    let retainClaim = false;
    try {
      const outstandingReceipt = await this.hydratePendingReceipt();
      if (outstandingReceipt) {
        retainClaim = true;
        throw new DeliveryPendingError(
          outstandingReceipt,
          new Error("an unresolved receipt from a prior process must be reconciled or delivered first"),
        );
      }
      if (this.pendingSettlement) {
        retainClaim = true;
        throw new SettlementUncertainError(
          this.pendingSettlement,
          new Error("a prior prepared payment has not been reconciled or delivered"),
        );
      }
      const signer = keypairSigner(this.agentKeypair, this.net.networkPassphrase);
      const client = registryClient(this.net, signer);
      const current = (await client.get_mandate({ mandate_id: this.mandate.idBuffer })).result.unwrap();
      const expectedSeq = resolveExpectedPaymentSequence(current.seq, lifecycle.expectedSeq);
      const at = await client.execute_payment(
        {
          mandate_id: this.mandate.idBuffer,
          amount: toStroops(amount, this.mandate.decimals),
          expected_seq: expectedSeq,
        },
        { timeoutInSeconds: PAYMENT_TIMEOUT_SECONDS },
      );
      await at.sign();
      const signed = at.signed;
      const txHash = signed?.hash().toString("hex").toLowerCase();
      const validUntil = Number(signed?.timeBounds?.maxTime);
      if (
        !txHash
        || !/^[0-9a-f]{64}$/.test(txHash)
        || !Number.isSafeInteger(validUntil)
        || validUntil <= 0
      ) {
        this.pendingSettlement = undefined;
        throw new Error("payment signing did not produce a canonical hash and finite validity window");
      }
      this.pendingSettlement = Object.freeze({
        txHash,
        mandateId: this.mandate.id,
        amount,
        expectedSeq: expectedSeq.toString(),
        submittedAt: Math.floor(Date.now() / 1_000),
        validUntil,
      });
      try {
        const receiptId = await lifecycle.onPrepared(this.pendingSettlement);
        if (receiptId) this.pendingSettlement = Object.freeze({ ...this.pendingSettlement, receiptId });
      } catch (cause) {
        this.pendingSettlement = undefined;
        throw cause;
      }
      let sent;
      try {
        sent = await at.send({
          onSubmitted: (response) => {
            const submittedHash = response?.hash?.toLowerCase();
            if (submittedHash !== txHash) {
              throw new Error("payment RPC returned a different transaction hash than the signed envelope");
            }
            const receiptId = lifecycle.onSubmitted?.(submittedHash);
            if (receiptId) this.pendingSettlement = Object.freeze({ ...this.pendingSettlement!, receiptId });
          },
        });
      } catch (cause) {
        retainClaim = true;
        throw new SettlementUncertainError(this.pendingSettlement, cause);
      }
      try {
        sent.result.unwrap();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const code = Number((message.match(/Error\(Contract,\s*#(\d+)\)/) ?? [])[1]);
        if (Number.isInteger(code) && FINALIZED_CONTRACT_ERROR_CODES.has(code)) {
          this.pendingSettlement = undefined;
          throw new PaymentRejectedError(this.mandate.id, cause);
        }
        retainClaim = true;
        throw new SettlementUncertainError(this.pendingSettlement, cause);
      }
      const submittedHash = sent.sendTransactionResponse?.hash?.toLowerCase();
      if (submittedHash && submittedHash !== txHash) {
        retainClaim = true;
        throw new SettlementUncertainError(
          this.pendingSettlement,
          new Error("payment RPC returned a different hash than the signed transaction"),
        );
      }
      if (lifecycle.holdUntilDelivery) {
        retainClaim = true;
      } else {
        this.pendingSettlement = undefined;
      }
      return txHash;
    } finally {
      if (!retainClaim) this.releasePaymentOperation();
    }
  }

  getPendingSettlement(): Readonly<PendingSettlement> | undefined {
    return this.pendingSettlement;
  }

  /** Query RPC for a previously prepared/submitted transaction without creating
   *  a new one. Pass a durable journal record after process restart. */
  async reconcilePendingSettlement(
    restored?: Readonly<PendingSettlement>,
  ): Promise<SettlementReconciliation> {
    if (restored) {
      if (
        restored.mandateId !== this.mandate.id
        || !/^[0-9a-f]{64}$/.test(restored.txHash)
        || !/^(?:unknown|\d+)$/.test(restored.expectedSeq)
        || !Number.isSafeInteger(restored.submittedAt)
        || !Number.isSafeInteger(restored.validUntil)
        || restored.submittedAt <= 0
        || restored.validUntil <= restored.submittedAt
        || (restored.receiptId !== undefined && !/^[0-9a-f]{64}$/.test(restored.receiptId))
      ) {
        throw new Error("pending settlement journal record is invalid or belongs to another mandate");
      }
      if (toStroops(restored.amount, this.mandate.decimals) <= 0n) {
        throw new Error("pending settlement journal amount must be positive");
      }
      if (this.pendingSettlement && this.pendingSettlement.txHash !== restored.txHash) {
        throw new Error("a different pending settlement is already locked on this agent");
      }
      this.pendingSettlement = Object.freeze({ ...restored });
    }
    if (!this.paymentClaimKey) this.claimPaymentOperation();
    try {
      await this.hydratePendingReceipt();
    } catch (error) {
      if (!this.pendingSettlement) this.releasePaymentOperation();
      throw error;
    }
    const settlement = this.pendingSettlement;
    if (!settlement) {
      this.releasePaymentOperation();
      return { kind: "none" };
    }
    const server = new rpc.Server(this.net.rpcUrl, { allowHttp: this.net.rpcUrl.startsWith("http://") });
    const response = await server.getTransaction(settlement.txHash);
    if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (
        settlement.submittedAt > 0
        && settlement.validUntil > 0
        && response.latestLedgerCloseTime > settlement.validUntil
        && response.oldestLedgerCloseTime <= settlement.submittedAt
      ) {
        this.pendingSettlement = undefined;
        if (settlement.receiptId) await this.receiptStore?.clearPending(settlement.receiptId);
        this.releasePaymentOperation();
        return { kind: "expired", settlement };
      }
      return { kind: "pending", settlement };
    }
    if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
      this.pendingSettlement = undefined;
      if (settlement.receiptId) await this.receiptStore?.clearPending(settlement.receiptId);
      this.releasePaymentOperation();
      return { kind: "failed", settlement };
    }
    if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      if (!settlement.receiptId) {
        this.pendingSettlement = undefined;
        this.releasePaymentOperation();
      }
      return { kind: "succeeded", settlement, deliveryPending: Boolean(settlement.receiptId) };
    }
    return { kind: "pending", settlement };
  }

  /**
   * Retry delivery with an already-settled proof. This method never calls
   * `pay`, never signs, and never creates another on-chain transaction.
   */
  async retryDelivery(receipt: Readonly<SettlementReceipt>, init?: RequestInit): Promise<Response> {
    if (!this.receiptStore) throw new Error("a SettlementReceiptStore is required to retry delivery safely");
    if (receipt.mandateId !== this.mandate.id || receipt.proof.mandateId !== this.mandate.id) {
      throw new Error("x402: settlement receipt belongs to a different mandate");
    }
    if (receipt.txHash !== receipt.proof.txHash) {
      throw new Error("x402: settlement receipt fields do not match its proof");
    }
    if (
      !Number.isSafeInteger(receipt.submittedAt)
      || !Number.isSafeInteger(receipt.validUntil)
      || receipt.submittedAt <= 0
      || receipt.validUntil <= receipt.submittedAt
    ) {
      throw new Error("x402: settlement receipt has an invalid transaction validity window");
    }
    const proof = receipt.proof;
    const bound = isBoundPaymentProof(proof);
    if ((receipt.proofVersion === 2) !== bound) {
      throw new Error("x402: settlement receipt proof version is inconsistent");
    }
    const expectedReceiptId = createSettlementReceiptId({
      proofVersion: receipt.proofVersion,
      url: receipt.url,
      method: receipt.method,
      txHash: receipt.txHash,
      mandateId: receipt.mandateId,
      amount: receipt.amount,
      submittedAt: receipt.submittedAt,
      validUntil: receipt.validUntil,
      proof,
    });
    if (receipt.receiptId !== expectedReceiptId) {
      throw new Error("x402: settlement receipt integrity check failed");
    }
    if (!isBoundPaymentProof(proof) && receipt.amount !== proof.amount) {
      throw new Error("x402: settlement receipt amount does not match its proof");
    }
    const method = (init?.method ?? receipt.method).toUpperCase();
    if (method !== receipt.method.toUpperCase()) {
      throw new Error("x402: delivery retry method does not match its settlement receipt");
    }
    if (bound) {
      const target = new URL(receipt.url);
      const resource = `${target.pathname}${target.search}`;
      if (
        proof.challenge.method !== method
        || proof.challenge.resource !== resource
        || proof.challenge.audience !== target.origin
      ) {
        throw new Error("x402: bound receipt does not match its delivery target");
      }
    }
    if (!this.paymentClaimKey) this.claimPaymentOperation();
    const headers = new Headers(init?.headers);
    headers.set(X_PAYMENT_HEADER, encodePaymentProof(proof));
    if (receipt.proofVersion === 2) {
      headers.set(REAPP_PAYMENT_CAPABILITIES_HEADER, BOUND_PAYMENT_CAPABILITY);
    }
    let delivered: Response;
    try {
      delivered = await fetch(receipt.url, {
        ...init,
        method,
        // Settlement proofs are bearer material. Never forward one across a
        // redirect; the caller may explicitly start a new request to a new URL.
        redirect: "manual",
        headers,
      });
      if (!delivered.ok) {
        throw new Error(`merchant returned HTTP ${delivered.status} after settlement`);
      }
      // A 2xx status is not complete delivery while the response body can still
      // fail. Drain a clone before returning; durable recovery evidence remains
      // locked until the caller explicitly acknowledges its application commit.
      await delivered.clone().arrayBuffer();
      deliveredReceipts.set(delivered, receipt);
      return delivered;
    } catch (cause) {
      throw cause instanceof DeliveryPendingError ? cause : new DeliveryPendingError(receipt, cause);
    }
  }

  /**
   * Application-level delivery commit. Call only after the complete response
   * has been validated and any business result is durably recorded. Until this
   * succeeds, the retained receipt keeps every new payment fail-closed.
   */
  async acknowledgeDelivery(receipt: Readonly<SettlementReceipt>): Promise<void> {
    if (!this.receiptStore) throw new Error("a SettlementReceiptStore is required to acknowledge delivery");
    if (receipt.mandateId !== this.mandate.id || receipt.proof.mandateId !== this.mandate.id) {
      throw new Error("x402: cannot acknowledge a receipt for another mandate");
    }
    if (
      receipt.txHash !== receipt.proof.txHash
      || !Number.isSafeInteger(receipt.submittedAt)
      || !Number.isSafeInteger(receipt.validUntil)
      || receipt.submittedAt <= 0
      || receipt.validUntil <= receipt.submittedAt
    ) {
      throw new Error("x402: cannot acknowledge invalid settlement evidence");
    }
    const expectedId = createSettlementReceiptId({
      proofVersion: receipt.proofVersion,
      url: receipt.url,
      method: receipt.method,
      txHash: receipt.txHash,
      mandateId: receipt.mandateId,
      amount: receipt.amount,
      submittedAt: receipt.submittedAt,
      validUntil: receipt.validUntil,
      proof: receipt.proof,
    });
    if (receipt.receiptId !== expectedId) {
      throw new Error("x402: cannot acknowledge a receipt with an invalid integrity id");
    }
    try {
      await this.receiptStore.clearPending(receipt.receiptId);
    } catch (cause) {
      throw new DeliveryPendingError(receipt, cause);
    }
    if (this.pendingSettlement?.txHash === receipt.txHash) this.pendingSettlement = undefined;
    this.releasePaymentOperation();
  }

  /**
   * x402 round-trip. GET `url`; if the server answers 402 Payment Required, read
   * the payment requirement, settle it on-chain via `execute_payment` (the same
   * path as `pay`), and retry the request with an `X-PAYMENT` settlement proof.
   * Returns the final `Response`.
   *
   * The contract is the enforcer; `fetch` never bypasses it. The payment always
   * goes through `pay` -> `execute_payment`, so a revoked, expired, out-of-scope,
   * or over-budget request is rejected on-chain and `fetch` throws. The 402 body
   * is only a hint: the merchant independently verifies the on-chain payment
   * before serving the resource.
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const outstandingReceipt = await this.hydratePendingReceipt();
    if (outstandingReceipt) {
      throw new DeliveryPendingError(
        outstandingReceipt,
        new Error("recover the durable receipt from the prior process before starting another fetch"),
      );
    }
    if (this.pendingSettlement) {
      throw new SettlementUncertainError(
        this.pendingSettlement,
        new Error("reconcile or recover the prior payment before starting another fetch"),
      );
    }
    const firstHeaders = new Headers(init?.headers);
    firstHeaders.set(REAPP_PAYMENT_CAPABILITIES_HEADER, BOUND_PAYMENT_CAPABILITY);
    const first = await fetch(url, {
      ...init,
      // Refuse automatic redirects before payment so a challenge cannot move
      // the payment flow onto a different origin behind the SDK's back.
      redirect: "manual",
      headers: firstHeaders,
    });
    if (first.status === 426) {
      throw new Error("x402: merchant requires a payment proof capability this SDK cannot negotiate");
    }
    if (first.status !== 402) return first;

    const required = await parse402(first);
    const receiptStore = this.receiptStore;
    if (!receiptStore) {
      throw new Error("x402: a SettlementReceiptStore is required before submitting a paid request");
    }
    // Fail fast on an obviously-wrong challenge before spending. This is a
    // convenience check, NOT the security boundary: the contract re-validates
    // merchant scope and budget on-chain, and the merchant re-verifies the payment.
    if (required.payTo !== this.mandate.merchant) {
      throw new Error(
        `x402: the 402 names merchant ${required.payTo}, not this mandate's merchant ${this.mandate.merchant}`,
      );
    }
    if (required.asset && required.asset !== this.mandate.asset) {
      throw new Error(`x402: the 402 names a different asset than this mandate's`);
    }
    if (this.proofPolicy === "bound-v2-only" && (!required.challenge || required.proofVersion !== 2)) {
      throw new Error("x402: bound-v2-only agent refused a legacy payment challenge before paying");
    }
    if (required.challenge) {
      const method = (init?.method ?? "GET").toUpperCase();
      const target = new URL(url);
      const resource = `${target.pathname}${target.search}`;
      const now = Math.floor(Date.now() / 1000);
      const expectedNetworkId = hash(Buffer.from(this.net.networkPassphrase, "utf8")).toString("hex");
      if (required.scheme !== BOUND_PAYMENT_SCHEME || required.challenge.scheme !== BOUND_PAYMENT_SCHEME) {
        throw new Error("x402: bound challenge uses an unsupported payment scheme");
      }
      if (method !== "GET") {
        throw new Error("x402: bound-v2 currently permits only GET requests");
      }
      if (
        required.challenge.audience !== target.origin
        || required.challenge.method !== method
        || required.challenge.resource !== resource
        || required.resource !== resource
        || required.challenge.bodySha256 !== null
      ) {
        throw new Error("x402: bound challenge does not match this exact request");
      }
      if (
        required.challenge.registryId !== this.net.mandateRegistryId
        || required.contract !== this.net.mandateRegistryId
        || required.challenge.networkId !== expectedNetworkId
      ) {
        throw new Error("x402: bound challenge names a different MandateRegistry");
      }
      if (
        required.challenge.merchant !== this.mandate.merchant
        || required.challenge.asset !== this.mandate.asset
        || required.challenge.network !== required.network
        || required.challenge.amountStroops !== toStroops(required.amount, required.challenge.decimals).toString()
        || required.challenge.decimals !== this.mandate.decimals
      ) {
        throw new Error("x402: bound challenge does not match this mandate or network");
      }
      if (required.challenge.expiresAt <= now || required.challenge.issuedAt > now + 60) {
        throw new Error("x402: bound challenge is expired or not yet valid");
      }
    }

    let receipt: Readonly<SettlementReceipt> | undefined;
    const makeReceipt = (
      txHash: string,
      timing: Pick<PendingSettlement, "submittedAt" | "validUntil"> = {
        submittedAt: Math.floor(Date.now() / 1_000),
        validUntil: Math.floor(Date.now() / 1_000) + PAYMENT_TIMEOUT_SECONDS,
      },
    ): Readonly<SettlementReceipt> => {
      const proof: Readonly<PaymentProof> = Object.freeze(required.challenge
        ? createBoundPaymentProof({
          challenge: required.challenge,
          txHash,
          mandateId: this.mandate.id,
          signer: this.agentKeypair,
        })
        : {
          scheme: required.scheme,
          network: required.network,
          txHash,
          mandateId: this.mandate.id,
          amount: required.amount,
        });
      const receiptWithoutId = Object.freeze({
        proofVersion: isBoundPaymentProof(proof) ? 2 as const : 1 as const,
        url,
        method: (init?.method ?? "GET").toUpperCase(),
        txHash,
        mandateId: this.mandate.id,
        amount: required.amount,
        submittedAt: timing.submittedAt,
        validUntil: timing.validUntil,
        proof,
      });
      return Object.freeze({
        receiptId: createSettlementReceiptId(receiptWithoutId),
        ...receiptWithoutId,
      });
    };

    let txHash: string;
    try {
      txHash = await this.pay(required.amount, {
        holdUntilDelivery: true,
        onPrepared: async (prepared) => {
          receipt = makeReceipt(prepared.txHash, prepared);
          await receiptStore.savePending(receipt);
          return receipt.receiptId;
        },
      });
    } catch (cause) {
      if (cause instanceof SettlementUncertainError) {
        this.pendingSettlement ??= cause.settlement;
        receipt ??= makeReceipt(cause.settlement.txHash, cause.settlement);
        throw new DeliveryPendingError(receipt, cause);
      }
      if (receipt) {
        await receiptStore.clearPending(receipt.receiptId).catch(() => undefined);
      }
      throw cause;
    }
    receipt ??= makeReceipt(txHash);
    if (!this.pendingSettlement) {
      this.pendingSettlement = Object.freeze({
        txHash,
        mandateId: this.mandate.id,
        amount: required.amount,
        expectedSeq: "confirmed",
        submittedAt: receipt.submittedAt,
        validUntil: receipt.validUntil,
        receiptId: receipt.receiptId,
      });
      try {
        await receiptStore.savePending(receipt);
      } catch (cause) {
        throw new DeliveryPendingError(receipt, cause);
      }
    }
    return this.retryDelivery(receipt, init);
  }
}

export const reapp = {
  testnet: TESTNET,

  /** Build an AP2-style IntentMandate and its canonical id (no chain calls). */
  createIntentMandate(input: CreateIntentMandateInput, net: NetworkConfig = TESTNET): IntentMandate {
    void net;
    // expiry is sent on-chain as u64. Validate it here so a NaN, fractional, or
    // out-of-range value fails loudly with a clear message instead of throwing
    // cryptically at BigInt() or silently wrapping at the u64 encoder.
    if (!Number.isInteger(input.expiry) || input.expiry <= 0 || input.expiry > MAX_EXPIRY) {
      throw new Error(`expiry must be a positive integer of Unix seconds (got ${input.expiry}).`);
    }
    const decimals = input.decimals ?? DEFAULT_DECIMALS;
    // Nonce keeps ids distinct in normal use; the CONTRACT (not the SDK) is the
    // real uniqueness authority (AlreadyExists), so timestamp+random suffices —
    // don't "upgrade" it expecting security from it.
    const nonce = input.nonce ?? `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const maxAmount = String(input.maxAmount).trim();
    // CRITICAL: this field order defines the canonical hash (the mandate id).
    // Changing order/values changes every id — keep it stable.
    const canonical = JSON.stringify({
      user: input.user,
      agent: input.agent,
      merchant: input.merchant,
      asset: input.asset,
      maxAmount,
      expiry: input.expiry,
      nonce,
    });
    const idBuffer = hash(Buffer.from(canonical, "utf8"));
    return {
      id: idBuffer.toString("hex"),
      idBuffer,
      user: input.user,
      agent: input.agent,
      merchant: input.merchant,
      asset: input.asset,
      maxAmount: toStroops(maxAmount, decimals),
      expiry: input.expiry,
      decimals,
    };
  },

  /** Register the mandate on-chain (user-signed). */
  async registerMandate(
    mandate: IntentMandate,
    opts: SignerInput,
    net: NetworkConfig = TESTNET,
  ): Promise<string> {
    const signer = keypairSigner(asKeypair(opts.signer), net.networkPassphrase);
    const client = registryClient(net, signer);
    const at = await client.register_mandate({
      user: mandate.user,
      agent: mandate.agent,
      merchant: mandate.merchant,
      asset: mandate.asset,
      max_amount: mandate.maxAmount,
      expiry: BigInt(mandate.expiry),
      vc_hash: mandate.idBuffer,
    });
    const sent = await at.signAndSend();
    sent.result.unwrap();
    return sent.sendTransactionResponse?.hash ?? "";
  },

  /** Approve the contract for a SEP-41 allowance up to the mandate budget (user-signed). */
  async approveBudget(
    mandate: IntentMandate,
    opts: SignerInput,
    net: NetworkConfig = TESTNET,
  ): Promise<string> {
    return token.approve(
      net,
      mandate.asset,
      asKeypair(opts.signer),
      net.mandateRegistryId,
      mandate.maxAmount,
    );
  },

  /** Revoke the mandate (user-signed). After this, `pay` is rejected on-chain. */
  async revokeMandate(
    mandate: IntentMandate,
    opts: SignerInput,
    net: NetworkConfig = TESTNET,
  ): Promise<string> {
    const signer = keypairSigner(asKeypair(opts.signer), net.networkPassphrase);
    const client = registryClient(net, signer);
    const at = await client.revoke_mandate({ mandate_id: mandate.idBuffer });
    const sent = await at.signAndSend();
    sent.result.unwrap();
    return sent.sendTransactionResponse?.hash ?? "";
  },

  /** Bind an agent to a registered mandate. */
  agent(
    opts: {
      mandate: IntentMandate;
      signer: Keypair | string;
      proofPolicy?: PaymentProofPolicy;
      receiptStore?: SettlementReceiptStore;
    },
    net: NetworkConfig = TESTNET,
  ): Agent {
    return new Agent(net, opts.mandate, asKeypair(opts.signer), opts.proofPolicy, opts.receiptStore);
  },
};
