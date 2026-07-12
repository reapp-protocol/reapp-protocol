import type { RedemptionRecord, RedemptionStore } from "./types.js";

/**
 * Atomic inside one JavaScript process only. It intentionally never expires or
 * releases a consumed payment. Multi-worker and production deployments must use
 * a durable shared store implementing the same atomic consume-once contract.
 */
export class InMemoryRedemptionStore implements RedemptionStore {
  private readonly records = new Map<string, Readonly<RedemptionRecord>>();

  consumeOnce(record: Readonly<RedemptionRecord>): "consumed" | "duplicate" {
    if (this.records.has(record.key)) return "duplicate";
    this.records.set(record.key, Object.freeze({ ...record }));
    return "consumed";
  }

  has(key: string): boolean {
    return this.records.has(key);
  }

  get(key: string): Readonly<RedemptionRecord> | undefined {
    return this.records.get(key);
  }
}
