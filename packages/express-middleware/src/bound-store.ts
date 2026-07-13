import type { VerifiedPayment } from "./types.js";

export interface BoundRedemptionRecord {
  /** Network-passphrase hash, registry id, and normalized transaction hash. */
  key: string;
  /** SHA-256 of the strict decoded bound proof. */
  proofDigest: string;
  /** Chain-derived evidence captured when this exact proof was first accepted. */
  payment: Readonly<VerifiedPayment>;
}

export interface StoredBoundJsonResponse {
  status: number;
  contentType: "application/json; charset=utf-8";
  bodyBase64: string;
  bodySha256: string;
}

export type BoundDeliveryRecord = Readonly<BoundRedemptionRecord> & Readonly<{
  executionId: string;
  startedAt: number;
}> & (
  | { state: "executing"; response?: never }
  | { state: "completed"; response: Readonly<StoredBoundJsonResponse> }
);

export type BoundRedemptionLookup =
  | { kind: "missing" }
  | { kind: "executing"; record: Readonly<BoundDeliveryRecord> }
  | { kind: "completed"; record: Readonly<BoundDeliveryRecord> }
  | { kind: "conflict" };

export type BoundRedemptionClaim =
  | { kind: "claimed"; record: Readonly<BoundDeliveryRecord> }
  | { kind: "executing"; record: Readonly<BoundDeliveryRecord> }
  | { kind: "completed"; record: Readonly<BoundDeliveryRecord> }
  | { kind: "conflict" };

export interface BoundRedemptionCompletion {
  key: string;
  proofDigest: string;
  executionId: string;
  response: Readonly<StoredBoundJsonResponse>;
}

export type BoundRedemptionComplete =
  | { kind: "completed"; record: Readonly<BoundDeliveryRecord> }
  | { kind: "conflict" };

/**
 * One linearizable store owns both settlement binding and immutable delivery
 * bytes. A proof is claimed at most once; recovery either waits for that claim
 * or replays its completed result without re-running fulfillment.
 */
export interface BoundRedemptionStore {
  lookup(key: string, proofDigest: string): BoundRedemptionLookup | Promise<BoundRedemptionLookup>;
  claim(
    record: Readonly<BoundRedemptionRecord>,
    executionId: string,
    startedAt: number,
  ): BoundRedemptionClaim | Promise<BoundRedemptionClaim>;
  complete(
    completion: Readonly<BoundRedemptionCompletion>,
  ): BoundRedemptionComplete | Promise<BoundRedemptionComplete>;
}

function freezeResponse(response: Readonly<StoredBoundJsonResponse>): Readonly<StoredBoundJsonResponse> {
  return Object.freeze({ ...response });
}

function freezeExecuting(
  record: Readonly<BoundRedemptionRecord>,
  executionId: string,
  startedAt: number,
): Readonly<BoundDeliveryRecord> {
  return Object.freeze({
    key: record.key,
    proofDigest: record.proofDigest,
    payment: Object.freeze({ ...record.payment }),
    executionId,
    startedAt,
    state: "executing" as const,
  });
}

/** Process-local reference store. Production and restart drills need a durable shared store. */
export class InMemoryBoundRedemptionStore implements BoundRedemptionStore {
  private readonly records = new Map<string, Readonly<BoundDeliveryRecord>>();

  lookup(key: string, proofDigest: string): BoundRedemptionLookup {
    const record = this.records.get(key);
    if (!record) return { kind: "missing" };
    if (record.proofDigest !== proofDigest) return { kind: "conflict" };
    return { kind: record.state, record };
  }

  claim(
    record: Readonly<BoundRedemptionRecord>,
    executionId: string,
    startedAt: number,
  ): BoundRedemptionClaim {
    const existing = this.records.get(record.key);
    if (existing) {
      if (existing.proofDigest !== record.proofDigest) return { kind: "conflict" };
      return { kind: existing.state, record: existing };
    }
    const claimed = freezeExecuting(record, executionId, startedAt);
    this.records.set(record.key, claimed);
    return { kind: "claimed", record: claimed };
  }

  complete(completion: Readonly<BoundRedemptionCompletion>): BoundRedemptionComplete {
    const existing = this.records.get(completion.key);
    if (
      !existing
      || existing.proofDigest !== completion.proofDigest
      || existing.executionId !== completion.executionId
    ) {
      return { kind: "conflict" };
    }
    if (existing.state === "completed") {
      const same = existing.response.status === completion.response.status
        && existing.response.contentType === completion.response.contentType
        && existing.response.bodyBase64 === completion.response.bodyBase64
        && existing.response.bodySha256 === completion.response.bodySha256;
      return same ? { kind: "completed", record: existing } : { kind: "conflict" };
    }
    const completed: Readonly<BoundDeliveryRecord> = Object.freeze({
      ...existing,
      state: "completed" as const,
      response: freezeResponse(completion.response),
    });
    this.records.set(completion.key, completed);
    return { kind: "completed", record: completed };
  }

  get(key: string): Readonly<BoundDeliveryRecord> | undefined {
    return this.records.get(key);
  }
}
