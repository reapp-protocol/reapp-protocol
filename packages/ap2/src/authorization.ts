/**
 * Byte-exact authorization messages consumed by the Soroban
 * `Ap2AuthorizationExtension`.
 */
import { randomBytes } from "node:crypto";
import {
  Address,
  Keypair,
  hash,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  VerifiedAp2CheckoutAuthorization,
  VerifiedAp2MerchantAuthorization,
} from "./merchant.js";
import type { VerifiedReappPoolParticipationAuthorization } from "./pool.js";

export const AP2_AUTHORIZATION_VERSION = 1 as const;
export const AP2_CAPTURE_DOMAIN = "REAPP\0AP2\0CAPTURE\0V1\0" as const;
export const AP2_POOL_PARTICIPATION_DOMAIN =
  "REAPP\0AP2\0POOL-PARTICIPATION\0V1\0" as const;
export const AP2_POOL_SCHEDULE_DOMAIN = "REAPP\0AP2\0SCHEDULE\0V1\0" as const;

export type Ap2CaptureKind = "Simple" | "CompositeSolo";

export interface Ap2CaptureAuthorization {
  version: typeof AP2_AUTHORIZATION_VERSION;
  networkId: string;
  registry: string;
  kind: Ap2CaptureKind;
  mandateId: string;
  agent: string;
  merchant: string;
  asset: string;
  amount: bigint;
  expectedSeq: number;
  openCheckoutEvidence: string;
  closedCheckoutEvidence: string;
  openPaymentEvidence: string;
  closedPaymentEvidence: string;
  nonce: string;
  verifierKey: string;
  notBefore: number;
  expiresAt: number;
}

export interface Ap2PoolParticipationAuthorization {
  version: typeof AP2_AUTHORIZATION_VERSION;
  networkId: string;
  registry: string;
  poolId: string;
  mandateId: string;
  agent: string;
  merchant: string;
  asset: string;
  maxAmount: bigint;
  scheduleHash: string;
  openCheckoutEvidence: string;
  closedCheckoutEvidence: string;
  openParticipationEvidence: string;
  closedParticipationEvidence: string;
  nonce: string;
  verifierKey: string;
  notBefore: number;
  expiresAt: number;
}

export interface SignedAp2ContractAuthorization<T> {
  authorization: Readonly<T>;
  authorizationId: string;
  signature: string;
}

export interface CreateCaptureAuthorizationInput {
  verified: VerifiedAp2MerchantAuthorization;
  networkPassphrase: string;
  registry: string;
  kind?: Ap2CaptureKind;
  mandateId: string;
  agent: string;
  merchant: string;
  asset: string;
  amount: bigint;
  expectedSeq: number;
  verifier: Keypair;
  notBefore: number;
  expiresAt: number;
  nonce?: string;
}

export interface Ap2PriceSchedulePoint {
  unitPrice: bigint;
  maxQty: bigint;
}

export interface CreatePoolParticipationAuthorizationInput {
  checkout: VerifiedAp2CheckoutAuthorization;
  participation: VerifiedReappPoolParticipationAuthorization;
  networkPassphrase: string;
  verifier: Keypair;
  notBefore: number;
  expiresAt: number;
  nonce?: string;
}

const HEX_32 = /^[0-9a-f]{64}$/;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;

function bytes32(label: string, value: string): Buffer {
  if (typeof value !== "string" || !HEX_32.test(value)) {
    throw new Error(`${label} must be lowercase 32-byte hex.`);
  }
  return Buffer.from(value, "hex");
}

function address(label: string, value: string): Address {
  try {
    return Address.fromString(value);
  } catch {
    throw new Error(`${label} must be a valid Stellar address.`);
  }
}

function u32(label: string, value: number): xdr.ScVal {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${label} must be an unsigned 32-bit integer.`);
  }
  return xdr.ScVal.scvU32(value);
}

function u64(label: string, value: number): xdr.ScVal {
  if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) > U64_MAX) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return nativeToScVal(BigInt(value), { type: "u64" });
}

function i128(label: string, value: bigint): xdr.ScVal {
  if (typeof value !== "bigint" || value < I128_MIN || value > I128_MAX) {
    throw new Error(`${label} must fit Soroban i128.`);
  }
  return nativeToScVal(value, { type: "i128" });
}

function u128(label: string, value: bigint): xdr.ScVal {
  if (typeof value !== "bigint" || value < 0n || value > U128_MAX) {
    throw new Error(`${label} must fit Soroban u128.`);
  }
  return nativeToScVal(value, { type: "u128" });
}

function symbol(value: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(value);
}

function bytes(value: Buffer): xdr.ScVal {
  return xdr.ScVal.scvBytes(value);
}

function contractEnum(value: string): xdr.ScVal {
  return xdr.ScVal.scvVec([symbol(value)]);
}

function contractStruct(fields: Readonly<Record<string, xdr.ScVal>>): xdr.ScVal {
  return xdr.ScVal.scvMap(Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => new xdr.ScMapEntry({
      key: symbol(key),
      val: value,
    })));
}

function sha256Hex(value: string | Buffer): string {
  return hash(typeof value === "string" ? Buffer.from(value, "ascii") : value).toString("hex");
}

function evidence(issuerJwt: string): string {
  return sha256Hex(issuerJwt);
}

function requireWindow(notBefore: number, expiresAt: number): void {
  u64("notBefore", notBefore);
  u64("expiresAt", expiresAt);
  if (notBefore >= expiresAt) throw new Error("notBefore must be earlier than expiresAt.");
}

function requireVerifierMatches(authorizationKey: string, verifier: Keypair): void {
  if (!verifier.canSign()) throw new Error("verifier must contain an Ed25519 secret key.");
  if (verifier.rawPublicKey().toString("hex") !== authorizationKey) {
    throw new Error("verifier key does not match authorization.verifierKey.");
  }
}

function openEvidenceExpiry(
  label: string,
  payloads: readonly Readonly<Record<string, unknown>>[],
): number {
  const opens = payloads.slice(0, -1);
  if (opens.length === 0) throw new Error(`${label} must contain an open mandate.`);
  let minimum = Number.MAX_SAFE_INTEGER;
  for (const [index, payload] of opens.entries()) {
    const expiresAt = payload.exp;
    if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) < 0) {
      throw new Error(`${label} open mandate ${index} must contain a valid exp.`);
    }
    minimum = Math.min(minimum, expiresAt as number);
  }
  return minimum;
}

export function stellarNetworkId(networkPassphrase: string): string {
  if (
    typeof networkPassphrase !== "string" ||
    networkPassphrase.length === 0 ||
    networkPassphrase.trim() !== networkPassphrase
  ) {
    throw new Error("networkPassphrase must be a non-empty exact string.");
  }
  return hash(Buffer.from(networkPassphrase, "utf8")).toString("hex");
}

export function createAp2CaptureAuthorization(
  input: CreateCaptureAuthorizationInput,
): Readonly<Ap2CaptureAuthorization> {
  if (input.amount <= 0n) throw new Error("amount must be positive.");
  requireWindow(input.notBefore, input.expiresAt);
  const evidenceExpiresAt = Math.min(
    openEvidenceExpiry("Checkout chain", input.verified.checkoutChain.payloads),
    openEvidenceExpiry("Payment chain", input.verified.paymentChain.payloads),
  );
  if (input.expiresAt > evidenceExpiresAt) {
    throw new Error("expiresAt cannot outlive the verified AP2 evidence.");
  }
  const authorization: Ap2CaptureAuthorization = {
    version: AP2_AUTHORIZATION_VERSION,
    networkId: stellarNetworkId(input.networkPassphrase),
    registry: address("registry", input.registry).toString(),
    kind: input.kind ?? "Simple",
    mandateId: bytes32("mandateId", input.mandateId).toString("hex"),
    agent: address("agent", input.agent).toString(),
    merchant: address("merchant", input.merchant).toString(),
    asset: address("asset", input.asset).toString(),
    amount: input.amount,
    expectedSeq: input.expectedSeq,
    openCheckoutEvidence: evidence(input.verified.checkoutChain.hops[0]!.token.issuerJwt),
    closedCheckoutEvidence: evidence(input.verified.checkoutChain.hops.at(-1)!.token.issuerJwt),
    openPaymentEvidence: evidence(input.verified.paymentChain.hops[0]!.token.issuerJwt),
    closedPaymentEvidence: evidence(input.verified.paymentChain.hops.at(-1)!.token.issuerJwt),
    nonce: input.nonce ?? randomBytes(32).toString("hex"),
    verifierKey: input.verifier.rawPublicKey().toString("hex"),
    notBefore: input.notBefore,
    expiresAt: input.expiresAt,
  };
  captureAuthorizationScVal(authorization);
  return Object.freeze(authorization);
}

export function ap2ScheduleScVal(
  schedule: readonly Ap2PriceSchedulePoint[],
): xdr.ScVal {
  if (!Array.isArray(schedule) || schedule.length === 0 || schedule.length > 8) {
    throw new Error("schedule must contain 1 through 8 points.");
  }
  let previousPrice = 0n;
  let previousQuantity: bigint | undefined;
  return xdr.ScVal.scvVec(schedule.map((point, index) => {
    if (typeof point !== "object" || point === null) {
      throw new Error(`schedule[${index}] must be an object.`);
    }
    if (typeof point.unitPrice !== "bigint" || typeof point.maxQty !== "bigint") {
      throw new Error(`schedule[${index}] values must be bigint.`);
    }
    if (point.unitPrice <= previousPrice) {
      throw new Error("schedule unit prices must be positive and strictly increasing.");
    }
    if (point.maxQty <= 0n || (previousQuantity !== undefined && point.maxQty >= previousQuantity)) {
      throw new Error("schedule quantities must be positive and strictly decreasing.");
    }
    previousPrice = point.unitPrice;
    previousQuantity = point.maxQty;
    return contractStruct({
      max_qty: u128(`schedule[${index}].maxQty`, point.maxQty),
      unit_price: i128(`schedule[${index}].unitPrice`, point.unitPrice),
    });
  }));
}

export function ap2ScheduleHash(schedule: readonly Ap2PriceSchedulePoint[]): string {
  return hash(Buffer.concat([
    Buffer.from(AP2_POOL_SCHEDULE_DOMAIN, "utf8"),
    ap2ScheduleScVal(schedule).toXDR(),
  ])).toString("hex");
}

export function createAp2PoolParticipationAuthorization(
  input: CreatePoolParticipationAuthorizationInput,
): Readonly<Ap2PoolParticipationAuthorization> {
  requireWindow(input.notBefore, input.expiresAt);
  const terms = input.participation.terms;
  if (input.expiresAt <= terms.captureWindowEnd) {
    throw new Error("expiresAt must be later than the Composite capture window.");
  }
  const evidenceExpiresAt = Math.min(
    openEvidenceExpiry("Checkout chain", input.checkout.checkoutChain.payloads),
    input.participation.evidenceExpiresAt,
  );
  if (input.expiresAt > evidenceExpiresAt) {
    throw new Error("expiresAt cannot outlive the verified AP2 evidence.");
  }
  const authorization: Ap2PoolParticipationAuthorization = {
    version: AP2_AUTHORIZATION_VERSION,
    networkId: stellarNetworkId(input.networkPassphrase),
    registry: address("registry", terms.registry).toString(),
    poolId: bytes32("poolId", terms.poolId).toString("hex"),
    mandateId: bytes32("mandateId", terms.mandateId).toString("hex"),
    agent: address("agent", terms.agent).toString(),
    merchant: address("merchant", terms.merchant).toString(),
    asset: address("asset", terms.asset).toString(),
    maxAmount: terms.maxAmount,
    scheduleHash: bytes32("scheduleHash", terms.scheduleHash).toString("hex"),
    openCheckoutEvidence: evidence(input.checkout.checkoutChain.hops[0]!.token.issuerJwt),
    closedCheckoutEvidence: evidence(input.checkout.checkoutChain.hops.at(-1)!.token.issuerJwt),
    openParticipationEvidence: evidence(
      input.participation.participationChain.hops[0]!.token.issuerJwt,
    ),
    closedParticipationEvidence: evidence(
      input.participation.participationChain.hops.at(-1)!.token.issuerJwt,
    ),
    nonce: input.nonce ?? randomBytes(32).toString("hex"),
    verifierKey: input.verifier.rawPublicKey().toString("hex"),
    notBefore: input.notBefore,
    expiresAt: input.expiresAt,
  };
  poolParticipationAuthorizationScVal(authorization);
  return Object.freeze(authorization);
}

export function captureAuthorizationScVal(
  authorization: Ap2CaptureAuthorization,
): xdr.ScVal {
  requireWindow(authorization.notBefore, authorization.expiresAt);
  return contractStruct({
    agent: address("agent", authorization.agent).toScVal(),
    amount: i128("amount", authorization.amount),
    asset: address("asset", authorization.asset).toScVal(),
    closed_checkout_evidence: bytes(bytes32(
      "closedCheckoutEvidence",
      authorization.closedCheckoutEvidence,
    )),
    closed_payment_evidence: bytes(bytes32(
      "closedPaymentEvidence",
      authorization.closedPaymentEvidence,
    )),
    expected_seq: u32("expectedSeq", authorization.expectedSeq),
    expires_at: u64("expiresAt", authorization.expiresAt),
    kind: contractEnum(authorization.kind),
    mandate_id: bytes(bytes32("mandateId", authorization.mandateId)),
    merchant: address("merchant", authorization.merchant).toScVal(),
    network_id: bytes(bytes32("networkId", authorization.networkId)),
    nonce: bytes(bytes32("nonce", authorization.nonce)),
    not_before: u64("notBefore", authorization.notBefore),
    open_checkout_evidence: bytes(bytes32(
      "openCheckoutEvidence",
      authorization.openCheckoutEvidence,
    )),
    open_payment_evidence: bytes(bytes32(
      "openPaymentEvidence",
      authorization.openPaymentEvidence,
    )),
    registry: address("registry", authorization.registry).toScVal(),
    verifier_key: bytes(bytes32("verifierKey", authorization.verifierKey)),
    version: u32("version", authorization.version),
  });
}

export function captureAuthorizationId(authorization: Ap2CaptureAuthorization): string {
  return hash(Buffer.concat([
    Buffer.from(AP2_CAPTURE_DOMAIN, "utf8"),
    captureAuthorizationScVal(authorization).toXDR(),
  ])).toString("hex");
}

export function signAp2CaptureAuthorization(
  authorization: Ap2CaptureAuthorization,
  verifier: Keypair,
): Readonly<SignedAp2ContractAuthorization<Ap2CaptureAuthorization>> {
  requireVerifierMatches(authorization.verifierKey, verifier);
  const authorizationId = captureAuthorizationId(authorization);
  return Object.freeze({
    authorization: Object.freeze({ ...authorization }),
    authorizationId,
    signature: verifier.sign(Buffer.from(authorizationId, "hex")).toString("hex"),
  });
}

export function poolParticipationAuthorizationScVal(
  authorization: Ap2PoolParticipationAuthorization,
): xdr.ScVal {
  requireWindow(authorization.notBefore, authorization.expiresAt);
  return contractStruct({
    agent: address("agent", authorization.agent).toScVal(),
    asset: address("asset", authorization.asset).toScVal(),
    closed_checkout_evidence: bytes(bytes32(
      "closedCheckoutEvidence",
      authorization.closedCheckoutEvidence,
    )),
    closed_participation_evidence: bytes(bytes32(
      "closedParticipationEvidence",
      authorization.closedParticipationEvidence,
    )),
    expires_at: u64("expiresAt", authorization.expiresAt),
    mandate_id: bytes(bytes32("mandateId", authorization.mandateId)),
    max_amount: i128("maxAmount", authorization.maxAmount),
    merchant: address("merchant", authorization.merchant).toScVal(),
    network_id: bytes(bytes32("networkId", authorization.networkId)),
    nonce: bytes(bytes32("nonce", authorization.nonce)),
    not_before: u64("notBefore", authorization.notBefore),
    open_checkout_evidence: bytes(bytes32(
      "openCheckoutEvidence",
      authorization.openCheckoutEvidence,
    )),
    open_participation_evidence: bytes(bytes32(
      "openParticipationEvidence",
      authorization.openParticipationEvidence,
    )),
    pool_id: bytes(bytes32("poolId", authorization.poolId)),
    registry: address("registry", authorization.registry).toScVal(),
    schedule_hash: bytes(bytes32("scheduleHash", authorization.scheduleHash)),
    verifier_key: bytes(bytes32("verifierKey", authorization.verifierKey)),
    version: u32("version", authorization.version),
  });
}

export function poolParticipationAuthorizationId(
  authorization: Ap2PoolParticipationAuthorization,
): string {
  return hash(Buffer.concat([
    Buffer.from(AP2_POOL_PARTICIPATION_DOMAIN, "utf8"),
    poolParticipationAuthorizationScVal(authorization).toXDR(),
  ])).toString("hex");
}

export function signAp2PoolParticipationAuthorization(
  authorization: Ap2PoolParticipationAuthorization,
  verifier: Keypair,
): Readonly<SignedAp2ContractAuthorization<Ap2PoolParticipationAuthorization>> {
  requireVerifierMatches(authorization.verifierKey, verifier);
  const authorizationId = poolParticipationAuthorizationId(authorization);
  return Object.freeze({
    authorization: Object.freeze({ ...authorization }),
    authorizationId,
    signature: verifier.sign(Buffer.from(authorizationId, "hex")).toString("hex"),
  });
}
