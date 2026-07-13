/**
 * Isolated x402 wire adapter for REAPP.
 *
 * Legacy v1 remains decodable for one compatibility window. New public
 * fulfillment uses the bound-v2 scheme: the merchant authenticates a challenge
 * for one audience/request, and the on-chain mandate's agent signs that exact
 * challenge together with the settlement transaction. Public chain data alone
 * is therefore insufficient to unlock a resource.
 */
import { Buffer } from "buffer";
import { Keypair, hash } from "@stellar/stellar-sdk";

export const X_PAYMENT_HEADER = "x-payment";
export const REAPP_PAYMENT_CAPABILITIES_HEADER = "reapp-payment-capabilities";
export const BOUND_PAYMENT_CAPABILITY = "reapp-bound-v2";
export const BOUND_PAYMENT_SCHEME = "reapp-soroban-bound";

export interface BoundPaymentChallengeV2 {
  proofVersion: 2;
  challengeId: string;
  audience: string;
  scheme: string;
  method: string;
  resource: string;
  bodySha256: string | null;
  network: string;
  networkId: string;
  registryId: string;
  merchant: string;
  asset: string;
  amountStroops: string;
  decimals: number;
  issuedAt: number;
  expiresAt: number;
  authorization: {
    algorithm: "hmac-sha256";
    mac: string;
  };
}

export type UnsignedBoundPaymentChallengeV2 = Omit<BoundPaymentChallengeV2, "authorization">;

export interface PaymentRequired {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  resource: string;
  contract?: string;
  proofVersion?: 1 | 2;
  challenge?: BoundPaymentChallengeV2;
}

export interface LegacyPaymentProof {
  scheme: string;
  network: string;
  txHash: string;
  mandateId: string;
  amount: string;
}

export interface BoundPaymentProofV2 {
  proofVersion: 2;
  scheme: string;
  network: string;
  txHash: string;
  mandateId: string;
  challenge: BoundPaymentChallengeV2;
  authorization: {
    algorithm: "stellar-ed25519-sha256";
    signature: string;
  };
}

export type PaymentProof = LegacyPaymentProof | BoundPaymentProofV2;

const CHALLENGE_DOMAIN = Buffer.from("REAPP\0X402\0CHALLENGE\0V2\0", "utf8");
const PROOF_DOMAIN = Buffer.from("REAPP\0X402\0BOUND-PROOF\0V2\0", "utf8");
const HEX_32 = /^[0-9a-f]{64}$/;

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`x402: ${label} contains missing or unknown fields`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`x402: ${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`x402: ${label} must be a non-empty exact string`);
  }
  return value;
}

/** Exact public origin used as the cryptographic service audience. */
export function canonicalPaymentOrigin(value: unknown, label = "challenge audience"): string {
  const origin = text(value, label);
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`x402: ${label} must be an absolute HTTP(S) origin`);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    || parsed.origin !== origin
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error(`x402: ${label} must be an exact HTTP(S) origin without path, query, credentials, or fragment`);
  }
  return origin;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`x402: ${label} must be a safe integer`);
  return value as number;
}

function canonicalBase64(value: unknown, decodedLength: number, label: string): string {
  const encoded = text(value, label);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`x402: ${label} must be canonical base64`);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== decodedLength || decoded.toString("base64") !== encoded) {
    throw new Error(`x402: ${label} has the wrong decoded length or encoding`);
  }
  return encoded;
}

function canonicalBase64Url32(value: unknown, label: string): string {
  const encoded = text(value, label);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new Error(`x402: ${label} must be canonical unpadded base64url`);
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== encoded) {
    throw new Error(`x402: ${label} must encode exactly 32 bytes`);
  }
  return encoded;
}

export function parseBoundPaymentChallenge(value: unknown): BoundPaymentChallengeV2 {
  const challenge = object(value, "bound challenge");
  exactKeys(challenge, [
    "proofVersion", "challengeId", "audience", "scheme", "method", "resource",
    "bodySha256", "network", "networkId", "registryId", "merchant", "asset",
    "amountStroops", "decimals", "issuedAt", "expiresAt", "authorization",
  ], "bound challenge");
  if (challenge.proofVersion !== 2) throw new Error("x402: unsupported bound challenge version");
  const challengeId = canonicalBase64Url32(challenge.challengeId, "challengeId");
  const method = text(challenge.method, "challenge method");
  if (method !== method.toUpperCase()) throw new Error("x402: challenge method must be uppercase");
  const bodySha256 = challenge.bodySha256 === null
    ? null
    : text(challenge.bodySha256, "challenge bodySha256");
  if (bodySha256 !== null && !HEX_32.test(bodySha256)) {
    throw new Error("x402: bodySha256 must be null or 32-byte lowercase hex");
  }
  const networkId = text(challenge.networkId, "networkId");
  if (!HEX_32.test(networkId)) throw new Error("x402: networkId must be 32-byte lowercase hex");
  const amountStroops = text(challenge.amountStroops, "amountStroops");
  if (!/^[1-9]\d*$/.test(amountStroops)) throw new Error("x402: amountStroops must be a positive canonical integer");
  const decimals = safeInteger(challenge.decimals, "challenge decimals");
  if (decimals < 0 || decimals > 38) throw new Error("x402: challenge decimals are out of range");
  const issuedAt = safeInteger(challenge.issuedAt, "challenge issuedAt");
  const expiresAt = safeInteger(challenge.expiresAt, "challenge expiresAt");
  if (issuedAt <= 0 || expiresAt <= issuedAt) throw new Error("x402: challenge time window is invalid");
  const authorization = object(challenge.authorization, "challenge authorization");
  exactKeys(authorization, ["algorithm", "mac"], "challenge authorization");
  if (authorization.algorithm !== "hmac-sha256") throw new Error("x402: unsupported challenge authorization");
  return {
    proofVersion: 2,
    challengeId,
    audience: canonicalPaymentOrigin(challenge.audience),
    scheme: text(challenge.scheme, "challenge scheme"),
    method,
    resource: text(challenge.resource, "challenge resource"),
    bodySha256,
    network: text(challenge.network, "challenge network"),
    networkId,
    registryId: text(challenge.registryId, "challenge registryId"),
    merchant: text(challenge.merchant, "challenge merchant"),
    asset: text(challenge.asset, "challenge asset"),
    amountStroops,
    decimals,
    issuedAt,
    expiresAt,
    authorization: {
      algorithm: "hmac-sha256",
      mac: canonicalBase64(authorization.mac, 32, "challenge mac"),
    },
  };
}

export function boundChallengeAuthorizationBytes(
  challenge: UnsignedBoundPaymentChallengeV2 | BoundPaymentChallengeV2,
): Buffer {
  const canonical = JSON.stringify({
    proofVersion: challenge.proofVersion,
    challengeId: challenge.challengeId,
    audience: challenge.audience,
    scheme: challenge.scheme,
    method: challenge.method,
    resource: challenge.resource,
    bodySha256: challenge.bodySha256,
    network: challenge.network,
    networkId: challenge.networkId,
    registryId: challenge.registryId,
    merchant: challenge.merchant,
    asset: challenge.asset,
    amountStroops: challenge.amountStroops,
    decimals: challenge.decimals,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  });
  return Buffer.concat([CHALLENGE_DOMAIN, Buffer.from(canonical, "utf8")]);
}

export function hashBoundPaymentChallenge(challenge: BoundPaymentChallengeV2): string {
  return hash(boundChallengeAuthorizationBytes(challenge)).toString("hex");
}

function boundProofDigest(input: {
  challenge: BoundPaymentChallengeV2;
  txHash: string;
  mandateId: string;
}): Buffer {
  const txHash = input.txHash.toLowerCase();
  const mandateId = input.mandateId.toLowerCase();
  if (!HEX_32.test(txHash)) throw new Error("x402: transaction hash must be 32-byte lowercase hex");
  if (!HEX_32.test(mandateId)) throw new Error("x402: mandate id must be 32-byte lowercase hex");
  const challengeHash = hashBoundPaymentChallenge(input.challenge);
  const canonical = JSON.stringify({
    proofVersion: 2,
    scheme: input.challenge.scheme,
    network: input.challenge.network,
    networkId: input.challenge.networkId,
    registryId: input.challenge.registryId,
    challengeId: input.challenge.challengeId,
    challengeHash,
    txHash,
    mandateId,
  });
  return hash(Buffer.concat([PROOF_DOMAIN, Buffer.from(canonical, "utf8")]));
}

export function createBoundPaymentProof(input: {
  challenge: BoundPaymentChallengeV2;
  txHash: string;
  mandateId: string;
  signer: Keypair;
}): BoundPaymentProofV2 {
  const challenge = parseBoundPaymentChallenge(input.challenge);
  Object.freeze(challenge.authorization);
  Object.freeze(challenge);
  const txHash = input.txHash.toLowerCase();
  const mandateId = input.mandateId.toLowerCase();
  const signature = input.signer.sign(boundProofDigest({ challenge, txHash, mandateId })).toString("base64");
  const authorization = Object.freeze({
    algorithm: "stellar-ed25519-sha256" as const,
    signature,
  });
  return Object.freeze({
    proofVersion: 2,
    scheme: challenge.scheme,
    network: challenge.network,
    txHash,
    mandateId,
    challenge,
    authorization,
  });
}

export function verifyBoundPaymentProofSignature(proof: BoundPaymentProofV2, agent: string): boolean {
  try {
    if (proof.authorization.algorithm !== "stellar-ed25519-sha256") return false;
    const signature = Buffer.from(canonicalBase64(proof.authorization.signature, 64, "proof signature"), "base64");
    return Keypair.fromPublicKey(agent).verify(
      boundProofDigest({ challenge: proof.challenge, txHash: proof.txHash, mandateId: proof.mandateId }),
      signature,
    );
  } catch {
    return false;
  }
}

export async function parse402(response: Response): Promise<PaymentRequired> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    throw new Error("x402: the 402 response body was not valid JSON");
  }
  const accepts = (body as { accepts?: unknown[] })?.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new Error("x402: the 402 response carried no `accepts` payment requirement");
  }
  const accepted = object(accepts[0], "payment requirement");
  const amount = String(accepted.maxAmountRequired ?? accepted.amount ?? "");
  const payTo = String(accepted.payTo ?? "");
  if (!amount) throw new Error("x402: the payment requirement is missing an amount");
  if (!payTo) throw new Error("x402: the payment requirement is missing `payTo` (the merchant)");
  const extra = object(accepted.extra ?? {}, "payment requirement extra");
  if ("reappProofVersion" in extra && extra.reappProofVersion !== 2) {
    throw new Error("x402: unsupported REAPP payment proof version");
  }
  const proofVersion = extra.reappProofVersion === 2 ? 2 : 1;
  const challenge = proofVersion === 2 ? parseBoundPaymentChallenge(extra.challenge) : undefined;
  return {
    scheme: String(accepted.scheme ?? "reapp-soroban"),
    network: String(accepted.network ?? "stellar-testnet"),
    amount,
    asset: String(accepted.asset ?? ""),
    payTo,
    resource: String(accepted.resource ?? ""),
    contract: extra.contract ? String(extra.contract) : undefined,
    ...(proofVersion === 2 ? { proofVersion: 2 as const, challenge } : {}),
  };
}

export function encodePaymentProof(proof: PaymentProof): string {
  return Buffer.from(JSON.stringify(proof), "utf8").toString("base64");
}

function parseBoundPaymentProof(value: Record<string, unknown>): BoundPaymentProofV2 {
  exactKeys(value, [
    "proofVersion", "scheme", "network", "txHash", "mandateId", "challenge", "authorization",
  ], "bound payment proof");
  if (value.proofVersion !== 2) throw new Error("x402: unsupported bound proof version");
  const challenge = parseBoundPaymentChallenge(value.challenge);
  const txHash = text(value.txHash, "proof txHash");
  const mandateId = text(value.mandateId, "proof mandateId");
  if (!HEX_32.test(txHash)) throw new Error("x402: proof txHash must be 32-byte hex");
  if (!HEX_32.test(mandateId)) throw new Error("x402: proof mandateId must be 32-byte hex");
  const authorization = object(value.authorization, "proof authorization");
  exactKeys(authorization, ["algorithm", "signature"], "proof authorization");
  if (authorization.algorithm !== "stellar-ed25519-sha256") {
    throw new Error("x402: unsupported proof signature algorithm");
  }
  const scheme = text(value.scheme, "proof scheme");
  const network = text(value.network, "proof network");
  if (scheme !== challenge.scheme || network !== challenge.network) {
    throw new Error("x402: proof scheme/network do not match the signed challenge");
  }
  return {
    proofVersion: 2,
    scheme,
    network,
    txHash,
    mandateId,
    challenge,
    authorization: {
      algorithm: "stellar-ed25519-sha256",
      signature: canonicalBase64(authorization.signature, 64, "proof signature"),
    },
  };
}

export function decodePaymentProof(header: string): PaymentProof {
  if (typeof header !== "string" || header.length === 0 || header.trim() !== header) {
    throw new Error("x402: the X-PAYMENT header must be canonical base64");
  }
  const encoded = header;
  if (
    encoded.length > 65_536
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error("x402: the X-PAYMENT header must be canonical base64");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    throw new Error("x402: the X-PAYMENT header must be canonical base64");
  }
  const json = decoded.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("x402: the X-PAYMENT header was not valid JSON");
  }
  const proof = object(parsed, "X-PAYMENT proof");
  if ("proofVersion" in proof) {
    if (proof.proofVersion === 2) return parseBoundPaymentProof(proof);
    throw new Error("x402: unsupported payment proof version");
  }
  for (const field of ["scheme", "network", "txHash", "mandateId", "amount"] as const) {
    if (typeof proof[field] !== "string") {
      throw new Error(`x402: non-string \`${field}\` in X-PAYMENT proof`);
    }
    if (proof[field].length === 0 || proof[field].trim() !== proof[field]) {
      throw new Error(`x402: invalid \`${field}\` in X-PAYMENT proof`);
    }
  }
  exactKeys(proof, ["scheme", "network", "txHash", "mandateId", "amount"], "legacy payment proof");
  return {
    scheme: proof.scheme as string,
    network: proof.network as string,
    txHash: proof.txHash as string,
    mandateId: proof.mandateId as string,
    amount: proof.amount as string,
  };
}

export function isBoundPaymentProof(
  proof: Readonly<PaymentProof>,
): proof is Readonly<BoundPaymentProofV2> {
  return "proofVersion" in proof && proof.proofVersion === 2;
}
