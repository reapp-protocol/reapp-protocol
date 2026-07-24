/**
 * Verification for the REAPP AP2 v0.2 pool-participation extension.
 *
 * This is intentionally named as a REAPP extension, not a standard AP2
 * Payment Mandate. It preserves Composite's pre-deadline, permissionless
 * clearing by binding a user/agent chain to the exact demand schedule.
 */
import { Address } from "@stellar/stellar-sdk";
import {
  verifyDelegateSdJwtChain,
  type Ap2RootKeyResolver,
  type VerifiedDelegateSdJwtChain,
} from "./sd-jwt.js";

export const REAPP_OPEN_POOL_PARTICIPATION_VCT =
  "https://reapp.live/ap2/mandate/pool-participation.open/1" as const;
export const REAPP_CLOSED_POOL_PARTICIPATION_VCT =
  "https://reapp.live/ap2/mandate/pool-participation/1" as const;

export interface ReappPoolParticipationTerms {
  registry: string;
  poolId: string;
  mandateId: string;
  agent: string;
  merchant: string;
  asset: string;
  maxAmount: bigint;
  scheduleHash: string;
  captureWindowEnd: number;
}

export interface VerifyReappPoolParticipationInput {
  participationMandateChain: string;
  resolveRootKey: Ap2RootKeyResolver;
  expectedAudience: string;
  expectedNonce: string;
  expected: ReappPoolParticipationTerms;
  currentTime?: number;
  clockSkewSeconds?: number;
}

export interface VerifiedReappPoolParticipationAuthorization {
  participationChain: VerifiedDelegateSdJwtChain;
  terms: Readonly<ReappPoolParticipationTerms>;
  evidenceExpiresAt: number;
  openParticipationHash: string;
  closedParticipationHash: string;
}

function fail(message: string): never {
  throw new Error(`REAPP AP2 pool participation: ${message}`);
}

function record(label: string, value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function text(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(`${label} must be a non-empty exact string`);
  }
  return value;
}

function hex32(label: string, value: unknown): string {
  const parsed = text(label, value);
  if (!/^[0-9a-f]{64}$/.test(parsed)) fail(`${label} must be lowercase 32-byte hex`);
  return parsed;
}

function address(label: string, value: unknown): string {
  const parsed = text(label, value);
  try {
    return Address.fromString(parsed).toString();
  } catch {
    fail(`${label} must be a valid Stellar address`);
  }
}

function positiveI128(label: string, value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    fail(`${label} must be a canonical positive decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed >= (1n << 127n)) fail(`${label} must fit Soroban i128`);
  return parsed;
}

function u64(label: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function parseTerms(label: string, value: unknown): ReappPoolParticipationTerms {
  const candidate = record(label, value);
  return {
    registry: address(`${label}.registry`, candidate.registry),
    poolId: hex32(`${label}.pool_id`, candidate.pool_id),
    mandateId: hex32(`${label}.mandate_id`, candidate.mandate_id),
    agent: address(`${label}.agent`, candidate.agent),
    merchant: address(`${label}.merchant`, candidate.merchant),
    asset: address(`${label}.asset`, candidate.asset),
    maxAmount: positiveI128(`${label}.max_amount`, candidate.max_amount),
    scheduleHash: hex32(`${label}.schedule_hash`, candidate.schedule_hash),
    captureWindowEnd: u64(`${label}.capture_window_end`, candidate.capture_window_end),
  };
}

function termsEqual(
  actual: ReappPoolParticipationTerms,
  expected: ReappPoolParticipationTerms,
): boolean {
  return actual.registry === expected.registry &&
    actual.poolId === expected.poolId &&
    actual.mandateId === expected.mandateId &&
    actual.agent === expected.agent &&
    actual.merchant === expected.merchant &&
    actual.asset === expected.asset &&
    actual.maxAmount === expected.maxAmount &&
    actual.scheduleHash === expected.scheduleHash &&
    actual.captureWindowEnd === expected.captureWindowEnd;
}

function normalizedExpected(value: ReappPoolParticipationTerms): ReappPoolParticipationTerms {
  return parseTerms("expected", {
    registry: value.registry,
    pool_id: value.poolId,
    mandate_id: value.mandateId,
    agent: value.agent,
    merchant: value.merchant,
    asset: value.asset,
    max_amount: value.maxAmount.toString(),
    schedule_hash: value.scheduleHash,
    capture_window_end: value.captureWindowEnd,
  });
}

export async function verifyReappPoolParticipation(
  input: VerifyReappPoolParticipationInput,
): Promise<Readonly<VerifiedReappPoolParticipationAuthorization>> {
  const expected = normalizedExpected(input.expected);
  let participationChain: VerifiedDelegateSdJwtChain;
  try {
    participationChain = await verifyDelegateSdJwtChain(input.participationMandateChain, {
      resolveRootKey: input.resolveRootKey,
      expectedAudience: text("expectedAudience", input.expectedAudience),
      expectedNonce: text("expectedNonce", input.expectedNonce),
      currentTime: input.currentTime,
      clockSkewSeconds: input.clockSkewSeconds,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : "chain verification failed");
  }
  if (participationChain.payloads.length < 2) {
    fail("chain must contain at least one open mandate and one closed mandate");
  }

  const openPayloads = participationChain.payloads.slice(0, -1);
  let evidenceExpiresAt = Number.MAX_SAFE_INTEGER;
  for (const [index, raw] of openPayloads.entries()) {
    const open = record(`open mandate ${index}`, raw);
    if (open.vct !== REAPP_OPEN_POOL_PARTICIPATION_VCT) {
      fail(`open mandate ${index} uses an unsupported vct`);
    }
    if (typeof open.cnf !== "object" || open.cnf === null || Array.isArray(open.cnf)) {
      fail(`open mandate ${index} must disclose cnf`);
    }
    if (open.constraints !== undefined) {
      if (!Array.isArray(open.constraints)) fail(`open mandate ${index}.constraints must be an array`);
      if (open.constraints.length !== 0) fail("unknown pool-participation constraints fail closed");
    }
    if (!termsEqual(parseTerms(`open mandate ${index}`, open), expected)) {
      fail(`open mandate ${index} changes the expected pool terms`);
    }
    const expiresAt = u64(`open mandate ${index}.exp`, open.exp);
    if (expiresAt <= expected.captureWindowEnd) {
      fail(`open mandate ${index} expires before the inclusive capture window ends`);
    }
    evidenceExpiresAt = Math.min(evidenceExpiresAt, expiresAt);
  }

  const closed = record("closed mandate", participationChain.payloads.at(-1));
  if (closed.vct !== REAPP_CLOSED_POOL_PARTICIPATION_VCT) {
    fail("chain must end in the REAPP closed pool-participation vct");
  }
  if (!termsEqual(parseTerms("closed mandate", closed), expected)) {
    fail("closed mandate changes the expected pool terms");
  }
  const now = input.currentTime ?? Math.floor(Date.now() / 1_000);
  if (expected.captureWindowEnd <= now) {
    fail("capture window has ended");
  }

  return Object.freeze({
    participationChain,
    terms: Object.freeze(expected),
    evidenceExpiresAt,
    openParticipationHash: participationChain.rootSdHash,
    closedParticipationHash: participationChain.leafSdHash,
  });
}
