import { createHash } from "node:crypto";
import { Buffer } from "buffer";
import { Address, StrKey } from "@stellar/stellar-sdk";
import { X_PAYMENT_HEADER, decodePaymentProof, toStroops } from "@reapp-sdk/core";
import { TESTNET } from "@reapp-sdk/stellar";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createStellarPaymentVerifier } from "./verification.js";
import type {
  PaymentRequirement,
  ReappPaymentMiddlewareOptions,
  RequestValue,
  VerifiedPayment,
  X402Challenge,
} from "./types.js";

export const REAPP_PAYMENT_LOCALS_KEY = "reappPayment" as const;
const DEFAULT_MAX_HEADER_BYTES = 8_192;
const DEFAULT_MAX_PROOF_AGE_LEDGERS = 120;

function exactText(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace.`);
  }
  return value;
}

function stellarAddress(label: string, value: unknown): string {
  const address = exactText(label, value);
  try {
    Address.fromString(address);
  } catch {
    throw new Error(`${label} must be a valid Stellar address.`);
  }
  return address;
}

function resolveRequestValue(label: string, value: RequestValue, request: Request): string {
  return exactText(label, typeof value === "function" ? value(request) : value);
}

function setPrivateResponseHeaders(response: Response): void {
  response.set("cache-control", "private, no-store");
  response.vary("X-PAYMENT");
}

function json(response: Response, status: number, body: unknown, retryAfter?: string): void {
  setPrivateResponseHeaders(response);
  response.status(status);
  if (retryAfter) response.set("retry-after", retryAfter);
  response.json(body);
}

function canonicalPaymentHeader(request: Request, maxBytes: number): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name?.toLowerCase() === X_PAYMENT_HEADER && value !== undefined) values.push(value);
  }
  if (values.length === 0) return undefined;
  if (values.length !== 1) throw new Error("multiple X-PAYMENT headers are not allowed");
  const header = values[0] as string;
  if (Buffer.byteLength(header, "utf8") > maxBytes) {
    throw new Error("X-PAYMENT header exceeds the configured size limit");
  }
  if (
    header.length === 0
    || header.includes(",")
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)
    || Buffer.from(header, "base64").toString("base64") !== header
  ) {
    throw new Error("X-PAYMENT header is not canonical base64");
  }
  return header;
}

export function buildChallenge(requirement: PaymentRequirement): X402Challenge {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: requirement.scheme,
        network: requirement.network,
        maxAmountRequired: requirement.amount,
        asset: requirement.asset,
        payTo: requirement.merchant,
        resource: requirement.resource,
        extra: { contract: requirement.registryId },
      },
    ],
  };
}

export function getVerifiedPayment(response: Response): VerifiedPayment | undefined {
  return response.locals[REAPP_PAYMENT_LOCALS_KEY] as VerifiedPayment | undefined;
}

export function createRedemptionKey(
  networkPassphrase: string,
  registryId: string,
  txHash: string,
): string {
  const networkId = createHash("sha256").update(networkPassphrase, "utf8").digest("hex");
  return `${networkId}:${registryId.toLowerCase()}:${txHash.toLowerCase()}`;
}

export function createReappPaymentMiddleware(
  options: ReappPaymentMiddlewareOptions,
): RequestHandler {
  if (!options || typeof options !== "object") {
    throw new Error("REAPP payment middleware options are required.");
  }
  if (!options.redemptionStore || typeof options.redemptionStore.consumeOnce !== "function") {
    throw new Error("redemptionStore with an atomic consumeOnce(record) operation is required.");
  }

  const networkConfig = options.networkConfig ?? TESTNET;
  const merchant = stellarAddress("merchant", options.merchant);
  const registryId = exactText("networkConfig.mandateRegistryId", networkConfig.mandateRegistryId);
  if (!StrKey.isValidContract(registryId)) {
    throw new Error("networkConfig.mandateRegistryId must be a valid Stellar contract address.");
  }
  const asset = exactText("asset", options.asset ?? networkConfig.nativeSac);
  if (!StrKey.isValidContract(asset)) {
    throw new Error("asset must be a valid Stellar contract address.");
  }
  const scheme = exactText("scheme", options.scheme ?? "reapp-soroban");
  const network = exactText("network", options.network ?? "stellar-testnet");
  const decimals = options.decimals ?? 7;
  const maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
  const maxProofAgeLedgers = options.maxProofAgeLedgers ?? DEFAULT_MAX_PROOF_AGE_LEDGERS;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new Error("decimals must be an integer from 0 through 38.");
  }
  if (!Number.isInteger(maxHeaderBytes) || maxHeaderBytes < 256 || maxHeaderBytes > 65_536) {
    throw new Error("maxHeaderBytes must be an integer from 256 through 65536.");
  }
  if (!Number.isInteger(maxProofAgeLedgers) || maxProofAgeLedgers < 0 || maxProofAgeLedgers > 1_000_000) {
    throw new Error("maxProofAgeLedgers must be an integer from 0 through 1000000.");
  }
  if (typeof options.amount === "string") {
    const staticAmount = toStroops(exactText("amount", options.amount), decimals);
    if (staticAmount <= 0n) throw new Error("amount must be greater than zero.");
  }
  if (typeof options.resource === "string") exactText("resource", options.resource);

  const verifier = options.verifier ?? createStellarPaymentVerifier({
    networkConfig,
    sourceAccount: options.sourceAccount ?? merchant,
    pollAttempts: options.pollAttempts,
    pollIntervalMs: options.pollIntervalMs,
    maxProofAgeLedgers,
    allowHttpRpc: options.allowHttpRpc,
  });

  const handle = async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    let requirement: PaymentRequirement;
    try {
      const amount = resolveRequestValue("amount", options.amount, request);
      const amountStroops = toStroops(amount, decimals);
      if (amountStroops <= 0n) throw new Error("amount must be greater than zero.");
      const resource = options.resource === undefined
        ? exactText("resource", request.originalUrl || request.url)
        : resolveRequestValue("resource", options.resource, request);
      requirement = Object.freeze({
        scheme,
        network,
        resource,
        merchant,
        asset,
        amount,
        amountStroops,
        registryId,
        decimals,
      });
    } catch {
      json(response, 500, { error: "payment middleware configuration failed closed" });
      return;
    }

    const challenge = buildChallenge(requirement);
    let header: string | undefined;
    try {
      header = canonicalPaymentHeader(request, maxHeaderBytes);
    } catch (error) {
      json(response, 402, {
        error: error instanceof Error ? error.message : "malformed X-PAYMENT proof",
        ...challenge,
      });
      return;
    }
    if (!header) {
      json(response, 402, challenge);
      return;
    }

    let proof;
    try {
      proof = decodePaymentProof(header);
    } catch {
      json(response, 402, { error: "malformed X-PAYMENT proof", ...challenge });
      return;
    }
    if (proof.scheme !== requirement.scheme) {
      json(response, 402, { error: "payment proof scheme does not match this API", ...challenge });
      return;
    }
    if (proof.network !== requirement.network) {
      json(response, 402, { error: "payment proof network does not match this API", ...challenge });
      return;
    }
    if (!/^[0-9a-f]{64}$/i.test(proof.txHash)) {
      json(response, 402, { error: "payment proof transaction hash is invalid", ...challenge });
      return;
    }

    let verdict;
    try {
      // txHash is the only caller-supplied field allowed across this boundary.
      verdict = await verifier.verify(proof.txHash.toLowerCase(), requirement);
    } catch {
      json(
        response,
        503,
        { error: "payment verification is temporarily unavailable; retry with the same proof", retryable: true },
        "1",
      );
      return;
    }
    if (!verdict.ok) {
      if (verdict.kind === "unavailable") {
        json(
          response,
          503,
          { error: `payment verification unavailable: ${verdict.reason}`, retryable: true },
          "1",
        );
      } else {
        json(response, 402, { error: `payment not verified on-chain: ${verdict.reason}`, ...challenge });
      }
      return;
    }

    const redemptionKey = createRedemptionKey(
      networkConfig.networkPassphrase,
      requirement.registryId,
      verdict.payment.txHash,
    );
    let consumed: "consumed" | "duplicate";
    try {
      consumed = await options.redemptionStore.consumeOnce(Object.freeze({
        key: redemptionKey,
        payment: Object.freeze({ ...verdict.payment }),
        acceptedThroughLedger: verdict.payment.ledger + maxProofAgeLedgers,
      }));
      if (consumed !== "consumed" && consumed !== "duplicate") {
        throw new Error("redemption store returned an unsupported result");
      }
    } catch {
      json(
        response,
        503,
        { error: "payment redemption store is unavailable; retry with the same proof", retryable: true },
        "1",
      );
      return;
    }
    if (consumed === "duplicate") {
      json(response, 409, { error: "this payment was already redeemed" });
      return;
    }

    response.locals[REAPP_PAYMENT_LOCALS_KEY] = verdict.payment;
    setPrivateResponseHeaders(response);
    next();
  };

  // Express 4 does not forward rejected async middleware promises. Always end
  // the internal promise explicitly and hand unexpected faults to next(error).
  return (request, response, next): void => {
    void handle(request, response, next).catch(next);
  };
}
