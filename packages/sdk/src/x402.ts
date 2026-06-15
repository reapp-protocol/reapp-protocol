/**
 * x402 wire-format adapter for REAPP.
 *
 * This module is the ONLY place that knows the HTTP shape of the 402 challenge and
 * the settlement-proof header. It is deliberately separate from the mandate and the
 * contract logic so the protocol can track x402 v0.2 / v0.3 (which are still moving)
 * without touching MandateRegistry or the agent. If the wire format changes, only
 * this file changes; `Agent.pay` and the contract do not.
 *
 * Shape (aligned with the x402 `accepts` model):
 *   402 body:  { x402Version, accepts: [ { scheme, network, maxAmountRequired, asset, payTo, resource, extra } ] }
 *   proof:     header `X-PAYMENT` = base64( JSON({ scheme, network, txHash, mandateId, amount }) )
 *
 * The proof is a SETTLEMENT proof, not an authorization: the payment has already
 * happened on-chain (MandateRegistry.execute_payment). The server verifies the
 * txHash against the chain. The header is not trusted on its own.
 */
import { Buffer } from "buffer";

/** Header carrying the settlement proof on the paid retry. */
export const X_PAYMENT_HEADER = "x-payment";

/** One payment requirement, parsed from a 402 `accepts` entry. */
export interface PaymentRequired {
  /** Settlement scheme, e.g. "reapp-soroban". */
  scheme: string;
  /** Network id, e.g. "stellar-testnet". */
  network: string;
  /** Price as a human decimal string, e.g. "1.00" (from `maxAmountRequired`). */
  amount: string;
  /** SEP-41 / SAC contract id of the asset to pay in. */
  asset: string;
  /** The merchant address that must be paid (`payTo`). */
  payTo: string;
  /** The gated resource this requirement is for. */
  resource: string;
  /** The MandateRegistry contract id (informational). */
  contract?: string;
}

/** The settlement proof the agent presents after paying on-chain. */
export interface PaymentProof {
  scheme: string;
  network: string;
  /** The on-chain `execute_payment` transaction hash. */
  txHash: string;
  /** The mandate the payment consumed, for the server to cross-check. */
  mandateId: string;
  /** The amount paid, as a human decimal string. */
  amount: string;
}

/** Parse a 402 response body into its first payment requirement. Throws if the
 *  body is not a well-formed x402 challenge. */
export async function parse402(res: Response): Promise<PaymentRequired> {
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    throw new Error("x402: the 402 response body was not valid JSON");
  }
  const accepts = (body as { accepts?: unknown[] })?.accepts;
  const a = Array.isArray(accepts) ? (accepts[0] as Record<string, unknown>) : undefined;
  if (!a) throw new Error("x402: the 402 response carried no `accepts` payment requirement");
  const amount = String(a.maxAmountRequired ?? a.amount ?? "");
  const payTo = String(a.payTo ?? "");
  if (!amount) throw new Error("x402: the payment requirement is missing an amount");
  if (!payTo) throw new Error("x402: the payment requirement is missing `payTo` (the merchant)");
  const extra = (a.extra ?? {}) as Record<string, unknown>;
  return {
    scheme: String(a.scheme ?? "reapp-soroban"),
    network: String(a.network ?? "stellar-testnet"),
    amount,
    asset: String(a.asset ?? ""),
    payTo,
    resource: String(a.resource ?? ""),
    contract: extra.contract ? String(extra.contract) : undefined,
  };
}

/** Encode a settlement proof for the `X-PAYMENT` header. */
export function encodePaymentProof(p: PaymentProof): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64");
}

/** The five string fields every settlement proof must carry. */
const PROOF_FIELDS = ["scheme", "network", "txHash", "mandateId", "amount"] as const;

/** Decode an `X-PAYMENT` header value back into a settlement proof. Throws if the
 *  payload is not valid JSON, or is valid JSON of the wrong shape (anything other
 *  than an object carrying the required non-empty string fields). Like `parse402`,
 *  this is a strict wire-format guard: callers get a `PaymentProof` or a clear
 *  error, never a half-formed object whose `.txHash` is `undefined` (or whose
 *  property access throws on `null`). The on-chain check remains the real boundary;
 *  this just keeps a malformed header from reaching it as garbage. */
export function decodePaymentProof(header: string): PaymentProof {
  const json = Buffer.from(header, "base64").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("x402: the X-PAYMENT header was not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("x402: the X-PAYMENT proof was not a JSON object");
  }
  const p = parsed as Record<string, unknown>;
  for (const field of PROOF_FIELDS) {
    const v = p[field];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`x402: the X-PAYMENT proof is missing or has a non-string \`${field}\``);
    }
  }
  return {
    scheme: p.scheme as string,
    network: p.network as string,
    txHash: p.txHash as string,
    mandateId: p.mandateId as string,
    amount: p.amount as string,
  };
}
