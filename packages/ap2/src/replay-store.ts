export interface Ap2ReplayRecord {
  key: string;
  namespace: string;
  mandateHash: string;
  user: string;
  acceptedAt: number;
}

export type Ap2ReplayResult = "consumed" | "duplicate";

export interface Ap2ReplayStore {
  consumeOnce(
    record: Readonly<Ap2ReplayRecord>,
  ): Ap2ReplayResult | Promise<Ap2ReplayResult>;
}

/** Single-process test/development store. Production must use durable atomic storage. */
export class InMemoryAp2ReplayStore implements Ap2ReplayStore {
  readonly #consumed = new Set<string>();

  consumeOnce(record: Readonly<Ap2ReplayRecord>): Ap2ReplayResult {
    if (this.#consumed.has(record.key)) return "duplicate";
    this.#consumed.add(record.key);
    return "consumed";
  }

  get size(): number {
    return this.#consumed.size;
  }
}
