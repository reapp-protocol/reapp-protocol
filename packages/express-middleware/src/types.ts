import type { Request } from "express";
import type { NetworkConfig } from "@reapp-sdk/stellar";

/** A request-specific price and the immutable deployment it must settle through. */
export interface PaymentRequirement {
  scheme: string;
  network: string;
  resource: string;
  merchant: string;
  asset: string;
  amount: string;
  amountStroops: bigint;
  registryId: string;
  decimals: number;
}

/** Settlement evidence derived from Stellar, never from caller-supplied proof fields. */
export interface VerifiedPayment {
  txHash: string;
  ledger: number;
  mandateId: string;
  user: string;
  agent: string;
  amount: string;
  amountStroops: bigint;
  merchant: string;
  asset: string;
  registryId: string;
  scheme: string;
  network: string;
}

export type VerificationResult =
  | { ok: true; payment: VerifiedPayment }
  | { ok: false; kind: "invalid" | "unavailable"; reason: string };

/**
 * A verifier receives only a transaction hash. Header claims such as amount and
 * mandate id are deliberately absent so they cannot become authorization data.
 */
export interface PaymentVerifier {
  verify(txHash: string, requirement: PaymentRequirement): Promise<VerificationResult>;
}

export type RequestValue = string | ((request: Request) => string);

export interface RedemptionRecord {
  /** Network-passphrase hash, registry id, and normalized transaction hash. */
  key: string;
  payment: Readonly<VerifiedPayment>;
  /** The proof was accepted only inside this verifier freshness window. */
  acceptedThroughLedger: number;
}

/**
 * Production implementations must make consumeOnce linearizable across every
 * process and host. Only the caller receiving `consumed` may serve the resource.
 */
export interface RedemptionStore {
  consumeOnce(
    record: Readonly<RedemptionRecord>,
  ): "consumed" | "duplicate" | Promise<"consumed" | "duplicate">;
}

export interface ReappPaymentMiddlewareOptions {
  /** Merchant address that must receive the contract-authorized transfer. */
  merchant: string;
  /** Price as a human decimal string, or a request-specific resolver. */
  amount: RequestValue;
  /** Resource identifier placed in the 402 challenge. Defaults to originalUrl. */
  resource?: RequestValue;
  /** SEP-41 asset contract. Defaults to networkConfig.nativeSac. */
  asset?: string;
  /** Contract/RPC configuration. Defaults to REAPP testnet. */
  networkConfig?: NetworkConfig;
  /** x402 network label. Defaults to stellar-testnet. */
  network?: string;
  /** Settlement scheme. Defaults to reapp-soroban. */
  scheme?: string;
  /** Asset decimals. Defaults to 7. */
  decimals?: number;
  /** Funded G-address used only for read-only contract simulations. */
  sourceAccount?: string;
  /** Required atomic redemption store. */
  redemptionStore: RedemptionStore;
  /** Optional verifier injection for tests or alternate trusted RPC infrastructure. */
  verifier?: PaymentVerifier;
  /** Transaction NOT_FOUND retries for the default verifier. Defaults to 15. */
  pollAttempts?: number;
  /** Delay between transaction reads for the default verifier. Defaults to 1000ms. */
  pollIntervalMs?: number;
  /** Maximum accepted age in ledgers. Defaults to 120. */
  maxProofAgeLedgers?: number;
  /** Maximum X-PAYMENT header bytes. Defaults to 8192. */
  maxHeaderBytes?: number;
  /** Explicit development escape hatch for an http:// RPC URL. Defaults to false. */
  allowHttpRpc?: boolean;
}

export interface X402Challenge {
  x402Version: 1;
  accepts: Array<{
    scheme: string;
    network: string;
    maxAmountRequired: string;
    asset: string;
    payTo: string;
    resource: string;
    extra: { contract: string };
  }>;
}
