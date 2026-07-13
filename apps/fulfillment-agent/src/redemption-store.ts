import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  BoundDeliveryRecord,
  BoundRedemptionClaim,
  BoundRedemptionComplete,
  BoundRedemptionCompletion,
  BoundRedemptionLookup,
  BoundRedemptionRecord,
  BoundRedemptionStore,
  StoredBoundJsonResponse,
  VerifiedPayment,
} from "@reapp-sdk/express-middleware";

interface SerializedPayment extends Omit<VerifiedPayment, "amountStroops"> {
  amountStroops: string;
}

interface SerializedRecord {
  key: string;
  proofDigest: string;
  payment: SerializedPayment;
  executionId: string;
  startedAt: number;
  state: "executing" | "completed";
  response?: StoredBoundJsonResponse;
}

interface RedemptionFile {
  version: 2;
  records: Record<string, SerializedRecord>;
}

const pathQueues = new Map<string, Promise<unknown>>();

function validateResponse(value: unknown): Readonly<StoredBoundJsonResponse> {
  if (!value || typeof value !== "object") throw new Error("redemption response is not an object");
  const response = value as StoredBoundJsonResponse;
  if (
    !Number.isInteger(response.status)
    || response.status < 200
    || response.status > 299
    || response.contentType !== "application/json; charset=utf-8"
    || typeof response.bodyBase64 !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.bodyBase64)
    || typeof response.bodySha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(response.bodySha256)
  ) {
    throw new Error("redemption response schema is invalid");
  }
  const body = Buffer.from(response.bodyBase64, "base64");
  if (
    body.toString("base64") !== response.bodyBase64
    || createHash("sha256").update(body).digest("hex") !== response.bodySha256
  ) {
    throw new Error("redemption response integrity check failed");
  }
  return Object.freeze({ ...response });
}

function serialize(record: Readonly<BoundDeliveryRecord>): SerializedRecord {
  return {
    ...record,
    payment: { ...record.payment, amountStroops: record.payment.amountStroops.toString() },
  };
}

function deserialize(value: unknown): Readonly<BoundDeliveryRecord> {
  if (!value || typeof value !== "object") throw new Error("redemption store contains a non-object record");
  const record = value as SerializedRecord;
  if (
    typeof record.key !== "string"
    || typeof record.proofDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(record.proofDigest)
    || typeof record.executionId !== "string"
    || record.executionId.length === 0
    || !Number.isSafeInteger(record.startedAt)
    || record.startedAt <= 0
    || (record.state !== "executing" && record.state !== "completed")
    || !record.payment
    || typeof record.payment !== "object"
    || typeof record.payment.amountStroops !== "string"
    || !/^[1-9]\d*$/.test(record.payment.amountStroops)
    || typeof record.payment.txHash !== "string"
    || typeof record.payment.mandateId !== "string"
    || typeof record.payment.agent !== "string"
  ) {
    throw new Error("redemption store record schema is invalid");
  }
  const payment = Object.freeze({
    ...record.payment,
    amountStroops: BigInt(record.payment.amountStroops),
  });
  if (record.state === "executing") {
    if ("response" in record && record.response !== undefined) {
      throw new Error("executing redemption record cannot contain a response");
    }
    return Object.freeze({
      key: record.key,
      proofDigest: record.proofDigest,
      payment,
      executionId: record.executionId,
      startedAt: record.startedAt,
      state: "executing" as const,
    });
  }
  return Object.freeze({
    key: record.key,
    proofDigest: record.proofDigest,
    payment,
    executionId: record.executionId,
    startedAt: record.startedAt,
    state: "completed" as const,
    response: validateResponse(record.response),
  });
}

function responsesEqual(a: Readonly<StoredBoundJsonResponse>, b: Readonly<StoredBoundJsonResponse>): boolean {
  return a.status === b.status
    && a.contentType === b.contentType
    && a.bodyBase64 === b.bodyBase64
    && a.bodySha256 === b.bodySha256;
}

/**
 * Restart-safe single-process reference store. All instances targeting the same
 * normalized path share one in-process queue. Multi-process or multi-host
 * deployments must use a shared linearizable database implementation.
 */
export class FileBoundRedemptionStore implements BoundRedemptionStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    if (!filePath || filePath.trim() !== filePath) {
      throw new Error("redemption file path must be a non-empty exact string");
    }
    this.filePath = resolve(filePath);
  }

  async lookup(key: string, proofDigest: string): Promise<BoundRedemptionLookup> {
    return this.serial(async () => {
      const stored = (await this.load()).records[key];
      if (!stored) return { kind: "missing" };
      const record = deserialize(stored);
      if (record.proofDigest !== proofDigest) return { kind: "conflict" };
      return { kind: record.state, record };
    });
  }

  async claim(
    record: Readonly<BoundRedemptionRecord>,
    executionId: string,
    startedAt: number,
  ): Promise<BoundRedemptionClaim> {
    return this.serial(async () => {
      const file = await this.load();
      const existing = file.records[record.key];
      if (existing) {
        const restored = deserialize(existing);
        if (restored.proofDigest !== record.proofDigest) return { kind: "conflict" };
        return { kind: restored.state, record: restored };
      }
      const checked = deserialize({
        key: record.key,
        proofDigest: record.proofDigest,
        payment: { ...record.payment, amountStroops: record.payment.amountStroops.toString() },
        executionId,
        startedAt,
        state: "executing",
      });
      file.records[record.key] = serialize(checked);
      await this.write(file);
      return { kind: "claimed", record: checked };
    });
  }

  async complete(
    completion: Readonly<BoundRedemptionCompletion>,
  ): Promise<BoundRedemptionComplete> {
    return this.serial(async () => {
      const file = await this.load();
      const serialized = file.records[completion.key];
      if (!serialized) return { kind: "conflict" };
      const existing = deserialize(serialized);
      if (
        existing.proofDigest !== completion.proofDigest
        || existing.executionId !== completion.executionId
      ) {
        return { kind: "conflict" };
      }
      const response = validateResponse(completion.response);
      if (existing.state === "completed") {
        return responsesEqual(existing.response, response)
          ? { kind: "completed", record: existing }
          : { kind: "conflict" };
      }
      const completed: Readonly<BoundDeliveryRecord> = Object.freeze({
        ...existing,
        state: "completed" as const,
        response,
      });
      file.records[completion.key] = serialize(completed);
      await this.write(file);
      return { kind: "completed", record: completed };
    });
  }

  /**
   * Administrative restart hook for this single-process reference store.
   * Callers may resolve these claims to one immutable terminal result after
   * confirming the prior process is no longer running; never execute the paid
   * callback again.
   */
  async listExecuting(): Promise<ReadonlyArray<Readonly<BoundDeliveryRecord>>> {
    return this.serial(async () => Object.values((await this.load()).records)
      .map(deserialize)
      .filter((record) => record.state === "executing"));
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

  private async load(): Promise<RedemptionFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, records: {} };
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<RedemptionFile>;
    if (parsed.version !== 2 || !parsed.records || typeof parsed.records !== "object") {
      throw new Error("redemption store schema is invalid");
    }
    for (const [key, value] of Object.entries(parsed.records)) {
      const record = deserialize(value);
      if (record.key !== key) throw new Error("redemption store key does not match record key");
    }
    return { version: 2, records: { ...parsed.records } };
  }

  private async write(file: RedemptionFile): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
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
