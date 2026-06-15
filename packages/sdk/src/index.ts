/**
 * @reapp-sdk/core — create an agent, connect to the testnet MandateRegistry, and
 * execute a mandate-validated payment in under 10 lines.
 *
 * The SDK is UNTRUSTED infrastructure: it never holds the allowance (only the
 * contract does), and every spend is validated + consumed on-chain by
 * `execute_payment`. A buggy or malicious SDK cannot exceed the mandate.
 *
 *   const m = reapp.createIntentMandate({ user, agent, merchant, asset, maxAmount: "5.00", expiry });
 *   await reapp.registerMandate(m, { signer: userKey });
 *   await reapp.approveBudget(m,   { signer: userKey });
 *   const agent = reapp.agent({ mandate: m, signer: agentKey });
 *   await agent.pay("1.00");
 */
import { Buffer } from "buffer";
import { Keypair, hash } from "@stellar/stellar-sdk";
import { TESTNET, keypairSigner, registryClient, token, type NetworkConfig } from "@reapp-sdk/stellar";
import { X_PAYMENT_HEADER, parse402, encodePaymentProof } from "./x402.js";

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

const DEFAULT_DECIMALS = 7;
/** The contract stores amounts as i128. Anything larger cannot fit. */
const I128_MAX = 2n ** 127n - 1n;
/** expiry is Unix seconds (a JS number). Bound it to the largest integer a
 *  number represents exactly, which is astronomically beyond any real timestamp
 *  yet well under u64 — so the value the SDK hashes and sends is never lossy. */
const MAX_EXPIRY = Number.MAX_SAFE_INTEGER;

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
  constructor(
    private readonly net: NetworkConfig,
    private readonly mandate: IntentMandate,
    private readonly agentKeypair: Keypair,
  ) {}

  /** Execute a mandate-validated payment of `amount` (human, e.g. "1.00").
   *  Reads the current sequence, then calls the contract's `execute_payment`
   *  (agent-signed). Throws if the contract rejects it. Returns the tx hash. */
  async pay(amount: string): Promise<string> {
    const signer = keypairSigner(this.agentKeypair, this.net.networkPassphrase);
    const client = registryClient(this.net, signer);
    const current = (await client.get_mandate({ mandate_id: this.mandate.idBuffer })).result.unwrap();
    const at = await client.execute_payment({
      mandate_id: this.mandate.idBuffer,
      amount: toStroops(amount, this.mandate.decimals),
      expected_seq: current.seq,
    });
    const sent = await at.signAndSend();
    try {
      sent.result.unwrap();
    } catch (e) {
      throw new Error(
        `payment rejected by contract for mandate ${this.mandate.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return sent.sendTransactionResponse?.hash ?? "";
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
    const first = await fetch(url, init);
    if (first.status !== 402) return first;

    const required = await parse402(first);
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

    // Settle on-chain. Throws if the contract rejects (budget, expiry, revoke, scope).
    const txHash = await this.pay(required.amount);

    const headers = new Headers(init?.headers);
    headers.set(
      X_PAYMENT_HEADER,
      encodePaymentProof({
        scheme: required.scheme,
        network: required.network,
        txHash,
        mandateId: this.mandate.id,
        amount: required.amount,
      }),
    );
    return fetch(url, { ...init, method: init?.method ?? "GET", headers });
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

  /** Grant the contract a SEP-41 allowance up to the mandate budget (user-signed). */
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
    opts: { mandate: IntentMandate; signer: Keypair | string },
    net: NetworkConfig = TESTNET,
  ): Agent {
    return new Agent(net, opts.mandate, asKeypair(opts.signer));
  },
};
