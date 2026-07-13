import {
  createHash,
  createHmac,
  randomBytes as secureRandomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Buffer } from "buffer";
import { Address, StrKey } from "@stellar/stellar-sdk";
import {
  BOUND_PAYMENT_CAPABILITY,
  BOUND_PAYMENT_SCHEME,
  REAPP_PAYMENT_CAPABILITIES_HEADER,
  X_PAYMENT_HEADER,
  boundChallengeAuthorizationBytes,
  canonicalPaymentOrigin,
  decodePaymentProof,
  isBoundPaymentProof,
  toStroops,
  verifyBoundPaymentProofSignature,
  type BoundPaymentChallengeV2,
  type UnsignedBoundPaymentChallengeV2,
} from "@reapp-sdk/core";
import { TESTNET, type NetworkConfig } from "@reapp-sdk/stellar";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createStellarPaymentVerifier } from "./verification.js";
import {
  REAPP_PAYMENT_LOCALS_KEY,
  createRedemptionKey,
} from "./middleware.js";
import type {
  BoundDeliveryRecord,
  BoundRedemptionClaim,
  BoundRedemptionLookup,
  BoundRedemptionRecord,
  BoundRedemptionStore,
} from "./bound-store.js";
import type {
  PaymentRequirement,
  PaymentVerifier,
  RequestValue,
  VerifiedPayment,
} from "./types.js";

export interface BoundReappPaymentMiddlewareOptions {
  /** Merchant address that must receive the contract-authorized transfer. */
  merchant: string;
  /** Price as a human decimal string, or a request-specific resolver. */
  amount: RequestValue;
  /** Exact public HTTP(S) origin configured by the merchant; never Host-derived. */
  audience: RequestValue;
  /** At least 32 bytes. Keep stable across restarts and never expose it to clients. */
  challengeSecret: string | Uint8Array;
  /** Atomic transaction-to-proof binding. Must be durable and shared in production. */
  redemptionStore: BoundRedemptionStore;
  /** Exact path + query resolver. Defaults to request.originalUrl. */
  resource?: RequestValue;
  /** SEP-41 asset contract. Defaults to networkConfig.nativeSac. */
  asset?: string;
  /** Contract/RPC configuration. Defaults to REAPP testnet. */
  networkConfig?: NetworkConfig;
  /** x402 network label. Defaults to stellar-testnet. */
  network?: string;
  /** Asset decimals. Defaults to 7. */
  decimals?: number;
  /** Funded G-address used only for read-only contract simulations. */
  sourceAccount?: string;
  /** Optional verifier injection for tests or alternate trusted RPC infrastructure. */
  verifier?: PaymentVerifier;
  pollAttempts?: number;
  pollIntervalMs?: number;
  maxProofAgeLedgers?: number;
  maxHeaderBytes?: number;
  allowHttpRpc?: boolean;
  /** Bound challenge lifetime in seconds. Defaults to 900. */
  challengeTtlSeconds?: number;
  /** Deterministic test hook. Must return safe whole Unix seconds. */
  now?: () => number;
  /** Deterministic test hook. Production uses node:crypto randomBytes. */
  randomBytes?: (size: number) => Uint8Array;
}

export interface BoundX402Challenge {
  x402Version: 1;
  accepts: Array<{
    scheme: typeof BOUND_PAYMENT_SCHEME;
    network: string;
    maxAmountRequired: string;
    asset: string;
    payTo: string;
    resource: string;
    extra: {
      contract: string;
      reappProofVersion: 2;
      challenge: BoundPaymentChallengeV2;
    };
  }>;
}

export const REAPP_BOUND_DELIVERY_LOCALS_KEY = "reappBoundDelivery";

export interface BoundDeliveryContext {
  kind: "claimed" | "completed";
  record: Readonly<BoundDeliveryRecord>;
}

export function getBoundDeliveryContext(response: Response): BoundDeliveryContext | undefined {
  return response.locals[REAPP_BOUND_DELIVERY_LOCALS_KEY] as BoundDeliveryContext | undefined;
}

const DEFAULT_MAX_HEADER_BYTES = 8_192;
const DEFAULT_MAX_PROOF_AGE_LEDGERS = 120;
const DEFAULT_CHALLENGE_TTL_SECONDS = 900;

function exactText(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty exact string.`);
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
  response.vary("REAPP-PAYMENT-CAPABILITIES");
}

function json(response: Response, status: number, body: unknown, retryAfter?: string): void {
  setPrivateResponseHeaders(response);
  response.status(status);
  if (retryAfter) response.set("retry-after", retryAfter);
  response.json(body);
}

function oneRawHeader(request: Request, name: string, maxBytes: number): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const headerName = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (headerName?.toLowerCase() === name && value !== undefined) values.push(value);
  }
  if (values.length === 0) return undefined;
  if (values.length !== 1) throw new Error(`multiple ${name} headers are not allowed`);
  const header = values[0] as string;
  if (Buffer.byteLength(header, "utf8") > maxBytes) {
    throw new Error(`${name} header exceeds the configured size limit`);
  }
  return header;
}

function canonicalPaymentHeader(request: Request, maxBytes: number): string | undefined {
  const header = oneRawHeader(request, X_PAYMENT_HEADER, maxBytes);
  if (header === undefined) return undefined;
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

function captureNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("payment middleware clock must return safe whole Unix seconds");
  }
  return value;
}

function authenticateChallenge(
  unsigned: UnsignedBoundPaymentChallengeV2,
  secret: Buffer,
): BoundPaymentChallengeV2 {
  const mac = createHmac("sha256", secret)
    .update(boundChallengeAuthorizationBytes(unsigned))
    .digest("base64");
  return Object.freeze({
    ...unsigned,
    authorization: Object.freeze({ algorithm: "hmac-sha256" as const, mac }),
  });
}

function challengeMacIsValid(challenge: BoundPaymentChallengeV2, secret: Buffer): boolean {
  const expected = createHmac("sha256", secret)
    .update(boundChallengeAuthorizationBytes(challenge))
    .digest();
  const actual = Buffer.from(challenge.authorization.mac, "base64");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createBoundReappPaymentMiddleware(
  options: BoundReappPaymentMiddlewareOptions,
): RequestHandler {
  if (!options || typeof options !== "object") {
    throw new Error("REAPP bound payment middleware options are required.");
  }
  if (
    !options.redemptionStore
    || typeof options.redemptionStore.lookup !== "function"
    || typeof options.redemptionStore.claim !== "function"
    || typeof options.redemptionStore.complete !== "function"
  ) {
    throw new Error("redemptionStore with atomic lookup, claim, and complete operations is required.");
  }
  const networkConfig = options.networkConfig ?? TESTNET;
  const merchant = stellarAddress("merchant", options.merchant);
  const registryId = exactText("networkConfig.mandateRegistryId", networkConfig.mandateRegistryId);
  if (!StrKey.isValidContract(registryId)) {
    throw new Error("networkConfig.mandateRegistryId must be a valid Stellar contract address.");
  }
  const asset = exactText("asset", options.asset ?? networkConfig.nativeSac);
  if (!StrKey.isValidContract(asset)) throw new Error("asset must be a valid Stellar contract address.");
  if (typeof options.audience === "string") canonicalPaymentOrigin(options.audience, "audience");
  const network = exactText("network", options.network ?? "stellar-testnet");
  const decimals = options.decimals ?? 7;
  const maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
  const maxProofAgeLedgers = options.maxProofAgeLedgers ?? DEFAULT_MAX_PROOF_AGE_LEDGERS;
  const challengeTtlSeconds = options.challengeTtlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS;
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  const randomBytes = options.randomBytes ?? secureRandomBytes;
  const challengeSecret = Buffer.from(
    typeof options.challengeSecret === "string"
      ? Buffer.from(options.challengeSecret, "utf8")
      : options.challengeSecret,
  );
  if (challengeSecret.length < 32 || challengeSecret.length > 4_096) {
    throw new Error("challengeSecret must contain 32 through 4096 bytes.");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new Error("decimals must be an integer from 0 through 38.");
  }
  if (!Number.isInteger(maxHeaderBytes) || maxHeaderBytes < 256 || maxHeaderBytes > 65_536) {
    throw new Error("maxHeaderBytes must be an integer from 256 through 65536.");
  }
  if (!Number.isInteger(maxProofAgeLedgers) || maxProofAgeLedgers < 0 || maxProofAgeLedgers > 1_000_000) {
    throw new Error("maxProofAgeLedgers must be an integer from 0 through 1000000.");
  }
  if (!Number.isInteger(challengeTtlSeconds) || challengeTtlSeconds < 30 || challengeTtlSeconds > 3_600) {
    throw new Error("challengeTtlSeconds must be an integer from 30 through 3600.");
  }
  if (typeof options.amount === "string") {
    const staticAmount = toStroops(exactText("amount", options.amount), decimals);
    if (staticAmount <= 0n) throw new Error("amount must be greater than zero.");
  }
  if (typeof options.resource === "string") exactText("resource", options.resource);

  const networkId = createHash("sha256")
    .update(networkConfig.networkPassphrase, "utf8")
    .digest("hex");
  const verifier = options.verifier ?? createStellarPaymentVerifier({
    networkConfig,
    sourceAccount: options.sourceAccount ?? merchant,
    pollAttempts: options.pollAttempts,
    pollIntervalMs: options.pollIntervalMs,
    maxProofAgeLedgers,
    allowHttpRpc: options.allowHttpRpc,
  });

  function requirementFor(request: Request): PaymentRequirement {
    const amount = resolveRequestValue("amount", options.amount, request);
    const amountStroops = toStroops(amount, decimals);
    if (amountStroops <= 0n) throw new Error("amount must be greater than zero.");
    const resource = options.resource === undefined
      ? exactText("resource", request.originalUrl || request.url)
      : resolveRequestValue("resource", options.resource, request);
    return Object.freeze({
      scheme: BOUND_PAYMENT_SCHEME,
      network,
      resource,
      merchant,
      asset,
      amount,
      amountStroops,
      registryId,
      decimals,
    });
  }

  function challengeFor(
    request: Request,
    requirement: PaymentRequirement,
    capturedNow: number,
    audience: string,
  ): BoundX402Challenge {
    const entropy = Buffer.from(randomBytes(32));
    if (entropy.length !== 32) throw new Error("randomBytes must return exactly the requested bytes");
    const unsigned: UnsignedBoundPaymentChallengeV2 = {
      proofVersion: 2,
      challengeId: entropy.toString("base64url"),
      audience,
      scheme: BOUND_PAYMENT_SCHEME,
      method: request.method.toUpperCase(),
      resource: requirement.resource,
      bodySha256: null,
      network,
      networkId,
      registryId,
      merchant,
      asset,
      amountStroops: requirement.amountStroops.toString(),
      decimals,
      issuedAt: capturedNow,
      expiresAt: capturedNow + challengeTtlSeconds,
    };
    const challenge = authenticateChallenge(unsigned, challengeSecret);
    return {
      x402Version: 1,
      accepts: [{
        scheme: BOUND_PAYMENT_SCHEME,
        network,
        maxAmountRequired: requirement.amount,
        asset,
        payTo: merchant,
        resource: requirement.resource,
        extra: { contract: registryId, reappProofVersion: 2, challenge },
      }],
    };
  }

  const handle = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const method = request.method.toUpperCase();
    if (method !== "GET") {
      response.set("allow", "GET");
      json(response, 405, { error: "bound payment routes permit only GET requests" });
      return;
    }

    let requirement: PaymentRequirement;
    let audience: string;
    let capturedNow: number;
    try {
      requirement = requirementFor(request);
      audience = canonicalPaymentOrigin(
        resolveRequestValue("audience", options.audience, request),
        "audience",
      );
      capturedNow = captureNow(now);
    } catch {
      json(response, 500, { error: "payment middleware configuration failed closed" });
      return;
    }

    let capability: string | undefined;
    try {
      capability = oneRawHeader(request, REAPP_PAYMENT_CAPABILITIES_HEADER, 256);
    } catch {
      json(response, 426, {
        error: "a single canonical REAPP payment capability is required",
        requiredCapability: BOUND_PAYMENT_CAPABILITY,
      });
      return;
    }
    if (capability !== BOUND_PAYMENT_CAPABILITY) {
      response.set("upgrade", BOUND_PAYMENT_CAPABILITY);
      json(response, 426, {
        error: "this route requires an agent-bound payment proof",
        requiredCapability: BOUND_PAYMENT_CAPABILITY,
      });
      return;
    }

    let challengeBody: BoundX402Challenge;
    try {
      challengeBody = challengeFor(request, requirement, capturedNow, audience);
    } catch {
      json(response, 500, { error: "payment challenge generation failed closed" });
      return;
    }

    let header: string | undefined;
    try {
      header = canonicalPaymentHeader(request, maxHeaderBytes);
    } catch {
      json(response, 402, { error: "malformed X-PAYMENT proof", ...challengeBody });
      return;
    }
    if (!header) {
      json(response, 402, challengeBody);
      return;
    }

    let proof;
    try {
      proof = decodePaymentProof(header);
    } catch {
      json(response, 402, { error: "malformed X-PAYMENT proof", ...challengeBody });
      return;
    }
    if (!isBoundPaymentProof(proof)) {
      json(response, 402, { error: "a bound-v2 proof is required", ...challengeBody });
      return;
    }
    const challenge = proof.challenge;
    const exactChallenge =
      challenge.proofVersion === 2
      && challenge.audience === audience
      && challenge.scheme === BOUND_PAYMENT_SCHEME
      && challenge.method === method
      && challenge.resource === requirement.resource
      && challenge.bodySha256 === null
      && challenge.network === network
      && challenge.networkId === networkId
      && challenge.registryId === registryId
      && challenge.merchant === merchant
      && challenge.asset === asset
      && challenge.amountStroops === requirement.amountStroops.toString()
      && challenge.decimals === decimals
      && challenge.expiresAt - challenge.issuedAt === challengeTtlSeconds
      && challenge.authorization.algorithm === "hmac-sha256"
      && challengeMacIsValid(challenge, challengeSecret)
      && proof.scheme === BOUND_PAYMENT_SCHEME
      && proof.network === network;
    if (!exactChallenge) {
      json(response, 402, { error: "payment proof is not bound to this exact request", ...challengeBody });
      return;
    }

    const proofDigest = createHash("sha256")
      .update(JSON.stringify(proof), "utf8")
      .digest("hex");
    const redemptionKey = createRedemptionKey(
      networkConfig.networkPassphrase,
      registryId,
      proof.txHash,
    );
    const paymentMatchesProof = (payment: Readonly<VerifiedPayment>): boolean =>
      payment.txHash === proof.txHash
      && payment.mandateId === proof.mandateId
      && payment.amountStroops === requirement.amountStroops
      && payment.merchant === merchant
      && payment.asset === asset
      && payment.registryId === registryId
      && payment.scheme === BOUND_PAYMENT_SCHEME
      && payment.network === network
      && verifyBoundPaymentProofSignature(proof, payment.agent);

    let existing: BoundRedemptionLookup;
    try {
      existing = await options.redemptionStore.lookup(redemptionKey, proofDigest);
      if (!existing || !["missing", "executing", "completed", "conflict"].includes(existing.kind)) {
        throw new Error("redemption store returned an unsupported lookup result");
      }
    } catch {
      json(response, 503, {
        error: "payment redemption store is unavailable; retry with the same proof",
        retryable: true,
      }, "1");
      return;
    }
    if (existing.kind === "conflict") {
      json(response, 409, { error: "this settlement transaction is already bound to another request" });
      return;
    }
    if (existing.kind === "executing") {
      json(response, 503, {
        error: "paid fulfillment is still pending; retry the same proof",
        retryable: true,
      }, "1");
      return;
    }
    if (existing.kind === "completed") {
      if (
        existing.record.key !== redemptionKey
        || existing.record.proofDigest !== proofDigest
        || !paymentMatchesProof(existing.record.payment)
      ) {
        json(response, 503, { error: "stored payment recovery evidence failed closed" }, "1");
        return;
      }
      response.locals[REAPP_PAYMENT_LOCALS_KEY] = existing.record.payment;
      response.locals[REAPP_BOUND_DELIVERY_LOCALS_KEY] = Object.freeze({
        kind: "completed" as const,
        record: existing.record,
      });
      setPrivateResponseHeaders(response);
      next();
      return;
    }

    if (challenge.issuedAt > capturedNow + 60 || challenge.expiresAt <= capturedNow) {
      json(response, 402, { error: "payment challenge is expired or not yet valid", ...challengeBody });
      return;
    }

    let verdict;
    try {
      verdict = await verifier.verify(proof.txHash, requirement);
    } catch {
      json(response, 503, {
        error: "payment verification is temporarily unavailable; retry with the same proof",
        retryable: true,
      }, "1");
      return;
    }
    if (!verdict.ok) {
      if (verdict.kind === "unavailable") {
        json(response, 503, {
          error: `payment verification unavailable: ${verdict.reason}`,
          retryable: true,
        }, "1");
      } else {
        json(response, 402, { error: `payment not verified on-chain: ${verdict.reason}`, ...challengeBody });
      }
      return;
    }
    const payment = verdict.payment;
    if (!paymentMatchesProof(payment)) {
      json(response, 402, { error: "payment authorization did not match verified chain evidence", ...challengeBody });
      return;
    }

    const record: Readonly<BoundRedemptionRecord> = Object.freeze({
      key: redemptionKey,
      proofDigest,
      payment: Object.freeze({ ...payment }),
    });
    let claimed: BoundRedemptionClaim;
    try {
      claimed = await options.redemptionStore.claim(
        record,
        randomUUID(),
        capturedNow,
      );
      if (
        !claimed
        || !["claimed", "executing", "completed", "conflict"].includes(claimed.kind)
      ) {
        throw new Error("redemption store returned an unsupported claim result");
      }
    } catch {
      json(response, 503, {
        error: "payment redemption store is unavailable; retry with the same proof",
        retryable: true,
      }, "1");
      return;
    }
    if (claimed.kind === "conflict") {
      json(response, 409, { error: "this settlement transaction is already bound to another request" });
      return;
    }
    if (claimed.kind === "executing") {
      json(response, 503, {
        error: "paid fulfillment is still pending; retry the same proof",
        retryable: true,
      }, "1");
      return;
    }
    if (
      claimed.record.key !== redemptionKey
      || claimed.record.proofDigest !== proofDigest
      || !paymentMatchesProof(claimed.record.payment)
    ) {
      json(response, 503, { error: "stored payment redemption evidence failed closed" }, "1");
      return;
    }

    response.locals[REAPP_PAYMENT_LOCALS_KEY] = claimed.record.payment;
    response.locals[REAPP_BOUND_DELIVERY_LOCALS_KEY] = Object.freeze({
      kind: claimed.kind,
      record: claimed.record,
    });
    setPrivateResponseHeaders(response);
    next();
  };

  return (request, response, next): void => {
    void handle(request, response, next).catch(next);
  };
}
