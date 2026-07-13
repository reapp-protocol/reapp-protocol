import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface PurchaseIdentity {
  key: string;
  mandateId: string;
  method: "GET";
  url: string;
  sourceId: string;
}

interface OutcomeBase {
  version: 1;
  outcomeId: string;
  identity: Readonly<PurchaseIdentity>;
  completedAt: number;
}

export type StoredPurchaseOutcome = Readonly<
  | (OutcomeBase & {
      kind: "delivered";
      receiptId: string;
      txHash: string;
      name: string;
      data: string;
    })
  | (OutcomeBase & {
      kind: "terminal";
      receiptId: string;
      txHash: string;
      reason: string;
    })
  | (OutcomeBase & {
      kind: "rejected";
      reason: string;
    })
>;

interface ExecutingRecord {
  kind: "executing";
  identity: Readonly<PurchaseIdentity>;
  executionId: string;
  startedAt: number;
}

interface CompletedRecord {
  kind: "completed";
  identity: Readonly<PurchaseIdentity>;
  outcome: StoredPurchaseOutcome;
}

type PurchaseRecord = ExecutingRecord | CompletedRecord;

interface OutcomeFile {
  version: 1;
  records: Record<string, PurchaseRecord>;
}

export type OutcomeLookup =
  | { kind: "missing" }
  | { kind: "executing"; executionId: string }
  | { kind: "completed"; outcome: StoredPurchaseOutcome };

export type ClaimOutcome =
  | { kind: "claimed" }
  | { kind: "executing"; executionId: string }
  | { kind: "completed"; outcome: StoredPurchaseOutcome };

export interface PurchaseOutcomeStore {
  lookup(identity: Readonly<PurchaseIdentity>): Promise<OutcomeLookup>;
  claim(
    identity: Readonly<PurchaseIdentity>,
    executionId: string,
    startedAt: number,
  ): Promise<ClaimOutcome>;
  complete(
    identity: Readonly<PurchaseIdentity>,
    executionId: string,
    outcome: Readonly<StoredPurchaseOutcome>,
  ): Promise<StoredPurchaseOutcome>;
}

const EMPTY: OutcomeFile = { version: 1, records: {} };
const pathQueues = new Map<string, Promise<unknown>>();
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function hashParts(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

export function createPurchaseIdentity(input: {
  mandateId: string;
  url: string;
  sourceId: string;
}): Readonly<PurchaseIdentity> {
  if (!/^[0-9a-f]{64}$/.test(input.mandateId)) throw new Error("purchase identity mandate id is invalid");
  if (!input.sourceId || input.sourceId.trim() !== input.sourceId) throw new Error("purchase source id is invalid");
  const parsed = new URL(input.url);
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.toString() !== input.url) {
    throw new Error("purchase identity URL must be an exact absolute HTTP(S) URL");
  }
  const identity = {
    key: hashParts(["reapp-consumer-request-v1", input.mandateId, "GET", input.url, input.sourceId]),
    mandateId: input.mandateId,
    method: "GET" as const,
    url: input.url,
    sourceId: input.sourceId,
  };
  return Object.freeze(identity);
}

function validateIdentity(value: unknown): Readonly<PurchaseIdentity> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("purchase identity is not an object");
  }
  const identity = value as PurchaseIdentity;
  if (
    !exactKeys(identity, ["key", "mandateId", "method", "url", "sourceId"])
    || identity.method !== "GET"
  ) {
    throw new Error("purchase identity schema is invalid");
  }
  const expected = createPurchaseIdentity(identity);
  if (expected.key !== identity.key) throw new Error("purchase identity key is invalid");
  return expected;
}

type OutcomeWithoutId<T = StoredPurchaseOutcome> = T extends StoredPurchaseOutcome
  ? Omit<T, "outcomeId">
  : never;

function outcomeDigest(outcome: OutcomeWithoutId): string {
  const detail = outcome.kind === "delivered"
    ? [outcome.receiptId, outcome.txHash, outcome.name, outcome.data]
    : outcome.kind === "terminal"
      ? [outcome.receiptId, outcome.txHash, outcome.reason]
      : [outcome.reason];
  return hashParts([
    "reapp-consumer-outcome-v1",
    outcome.version,
    outcome.identity.key,
    outcome.completedAt,
    outcome.kind,
    ...detail,
  ]);
}

export function createStoredPurchaseOutcome(input:
  | { identity: Readonly<PurchaseIdentity>; kind: "delivered"; receiptId: string; txHash: string; name: string; data: string; completedAt?: number }
  | { identity: Readonly<PurchaseIdentity>; kind: "terminal"; receiptId: string; txHash: string; reason: string; completedAt?: number }
  | { identity: Readonly<PurchaseIdentity>; kind: "rejected"; reason: string; completedAt?: number }
): StoredPurchaseOutcome {
  const identity = validateIdentity(input.identity);
  const completedAt = input.completedAt ?? Math.floor(Date.now() / 1_000);
  const withoutId = Object.freeze({ version: 1 as const, ...input, identity, completedAt });
  return Object.freeze({ ...withoutId, outcomeId: outcomeDigest(withoutId) } as StoredPurchaseOutcome);
}

function validateOutcome(value: unknown): StoredPurchaseOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("purchase outcome is not an object");
  }
  const outcome = value as StoredPurchaseOutcome;
  const expectedKeys = outcome.kind === "delivered"
    ? ["version", "outcomeId", "identity", "completedAt", "kind", "receiptId", "txHash", "name", "data"]
    : outcome.kind === "terminal"
      ? ["version", "outcomeId", "identity", "completedAt", "kind", "receiptId", "txHash", "reason"]
      : ["version", "outcomeId", "identity", "completedAt", "kind", "reason"];
  if (
    !exactKeys(outcome, expectedKeys)
    || outcome.version !== 1
    || (outcome.kind !== "delivered" && outcome.kind !== "terminal" && outcome.kind !== "rejected")
    || !Number.isSafeInteger(outcome.completedAt)
    || outcome.completedAt <= 0
  ) {
    throw new Error("purchase outcome schema is invalid");
  }
  if (outcome.kind === "delivered") {
    if (
      !/^[0-9a-f]{64}$/.test(outcome.receiptId)
      || !/^[0-9a-f]{64}$/.test(outcome.txHash)
      || typeof outcome.name !== "string"
      || typeof outcome.data !== "string"
    ) throw new Error("delivered purchase outcome is invalid");
  } else if (outcome.kind === "terminal") {
    if (
      !/^[0-9a-f]{64}$/.test(outcome.receiptId)
      || !/^[0-9a-f]{64}$/.test(outcome.txHash)
      || typeof outcome.reason !== "string"
    ) throw new Error("terminal purchase outcome is invalid");
  } else if (typeof outcome.reason !== "string") {
    throw new Error("rejected purchase outcome is invalid");
  }
  const identity = validateIdentity(outcome.identity);
  const normalized = Object.freeze({ ...outcome, identity }) as StoredPurchaseOutcome;
  const { outcomeId: _outcomeId, ...withoutId } = normalized;
  if (outcome.outcomeId !== outcomeDigest(withoutId)) throw new Error("purchase outcome integrity id is invalid");
  return normalized;
}

function validateRecord(key: string, value: unknown): PurchaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("purchase record is invalid");
  const record = value as PurchaseRecord;
  const identity = validateIdentity(record.identity);
  if (identity.key !== key) throw new Error("purchase record key does not match its identity");
  if (record.kind === "executing") {
    if (
      !exactKeys(record, ["kind", "identity", "executionId", "startedAt"])
      || !/^[0-9a-f-]{36}$/.test(record.executionId)
      || !Number.isSafeInteger(record.startedAt)
      || record.startedAt <= 0
    ) throw new Error("executing purchase record is invalid");
    return Object.freeze({ ...record, identity });
  }
  if (record.kind === "completed" && exactKeys(record, ["kind", "identity", "outcome"])) {
    const outcome = validateOutcome(record.outcome);
    if (outcome.identity.key !== identity.key) throw new Error("completed outcome identity mismatch");
    return Object.freeze({ ...record, identity, outcome });
  }
  throw new Error("purchase record schema is invalid");
}

export class FilePurchaseOutcomeStore implements PurchaseOutcomeStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    if (!filePath || filePath.trim() !== filePath) throw new Error("outcome file path must be a non-empty exact string");
    this.filePath = resolve(filePath);
  }

  async lookup(identity: Readonly<PurchaseIdentity>): Promise<OutcomeLookup> {
    const checked = validateIdentity(identity);
    return this.serial(async () => {
      const record = (await this.load()).records[checked.key];
      if (!record) return { kind: "missing" };
      return record.kind === "completed"
        ? { kind: "completed", outcome: record.outcome }
        : { kind: "executing", executionId: record.executionId };
    });
  }

  async claim(
    identity: Readonly<PurchaseIdentity>,
    executionId: string,
    startedAt: number,
  ): Promise<ClaimOutcome> {
    const checked = validateIdentity(identity);
    if (!/^[0-9a-f-]{36}$/.test(executionId) || !Number.isSafeInteger(startedAt) || startedAt <= 0) {
      throw new Error("purchase execution claim is invalid");
    }
    return this.serial(async () => {
      const file = await this.load();
      const existing = file.records[checked.key];
      if (existing?.kind === "completed") return { kind: "completed", outcome: existing.outcome };
      if (existing?.kind === "executing") return { kind: "executing", executionId: existing.executionId };
      file.records[checked.key] = Object.freeze({ kind: "executing", identity: checked, executionId, startedAt });
      await this.write(file);
      return { kind: "claimed" };
    });
  }

  async complete(
    identity: Readonly<PurchaseIdentity>,
    executionId: string,
    outcome: Readonly<StoredPurchaseOutcome>,
  ): Promise<StoredPurchaseOutcome> {
    const checked = validateIdentity(identity);
    const accepted = validateOutcome(outcome);
    if (accepted.identity.key !== checked.key) throw new Error("purchase completion identity mismatch");
    return this.serial(async () => {
      const file = await this.load();
      const existing = file.records[checked.key];
      if (!existing) throw new Error("purchase completion has no execution claim");
      if (existing.kind === "completed") {
        if (existing.outcome.outcomeId !== accepted.outcomeId) throw new Error("purchase outcome is already immutable");
        return existing.outcome;
      }
      if (existing.executionId !== executionId) throw new Error("purchase completion belongs to another execution");
      file.records[checked.key] = Object.freeze({ kind: "completed", identity: checked, outcome: accepted });
      await this.write(file);
      return accepted;
    });
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = pathQueues.get(this.filePath) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const tail = current.then(() => undefined, () => undefined);
    pathQueues.set(this.filePath, tail);
    try {
      return await current;
    } finally {
      if (pathQueues.get(this.filePath) === tail) pathQueues.delete(this.filePath);
    }
  }

  private async load(): Promise<OutcomeFile> {
    let raw: string;
    try {
      const info = await lstat(this.filePath);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > MAX_FILE_BYTES) {
        throw new Error("outcome store file is not a bounded private regular file");
      }
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: EMPTY.version, records: {} };
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<OutcomeFile>;
    if (
      !exactKeys(parsed, ["version", "records"])
      || parsed.version !== 1
      || !parsed.records
      || typeof parsed.records !== "object"
      || Array.isArray(parsed.records)
    ) throw new Error("outcome store schema is invalid");
    const records: Record<string, PurchaseRecord> = {};
    for (const [key, value] of Object.entries(parsed.records)) records[key] = validateRecord(key, value);
    return { version: 1, records };
  }

  private async write(file: OutcomeFile): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
