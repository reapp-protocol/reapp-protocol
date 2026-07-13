import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  decodePaymentProof,
  encodePaymentProof,
  createSettlementReceiptId,
  type SettlementReceipt,
  type SettlementReceiptStore,
} from "@reapp-sdk/core";

interface ReceiptFile {
  version: 2;
  pending: Record<string, SettlementReceipt>;
}

const EMPTY: ReceiptFile = { version: 2, pending: {} };
const pathQueues = new Map<string, Promise<unknown>>();

export function validateSettlementReceipt(value: unknown): SettlementReceipt {
  if (!value || typeof value !== "object") throw new Error("receipt store contains a non-object receipt");
  const receipt = value as SettlementReceipt;
  const keys = Object.keys(receipt).sort();
  const expectedKeys = [
    "amount", "mandateId", "method", "proof", "proofVersion", "receiptId", "submittedAt",
    "txHash", "url", "validUntil",
  ];
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || typeof receipt.receiptId !== "string"
    || !/^[0-9a-f]{64}$/.test(receipt.receiptId)
    || (receipt.proofVersion !== 1 && receipt.proofVersion !== 2)
    || typeof receipt.url !== "string"
    || typeof receipt.method !== "string"
    || typeof receipt.txHash !== "string"
    || typeof receipt.mandateId !== "string"
    || typeof receipt.amount !== "string"
    || !Number.isSafeInteger(receipt.submittedAt)
    || !Number.isSafeInteger(receipt.validUntil)
    || receipt.submittedAt <= 0
    || receipt.validUntil <= receipt.submittedAt
  ) {
    throw new Error("receipt store contains an invalid receipt envelope");
  }
  const proof = decodePaymentProof(encodePaymentProof(receipt.proof));
  if (proof.txHash !== receipt.txHash || proof.mandateId !== receipt.mandateId) {
    throw new Error("receipt store contains mismatched settlement evidence");
  }
  const expectedId = createSettlementReceiptId({
    proofVersion: receipt.proofVersion,
    url: receipt.url,
    method: receipt.method,
    txHash: receipt.txHash,
    mandateId: receipt.mandateId,
    amount: receipt.amount,
    submittedAt: receipt.submittedAt,
    validUntil: receipt.validUntil,
    proof,
  });
  if (receipt.receiptId !== expectedId) {
    throw new Error("receipt store contains a receipt with an invalid integrity id");
  }
  return Object.freeze({ ...receipt, proof: Object.freeze(proof) });
}

/**
 * Durable single-process reference store. The file is written atomically with
 * owner-only permissions. Production key custody may substitute an encrypted
 * secret store implementing the same two-method SDK interface.
 */
export class FileSettlementReceiptStore implements SettlementReceiptStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    if (!filePath || filePath.trim() !== filePath) {
      throw new Error("receipt file path must be a non-empty exact string");
    }
    this.filePath = resolve(filePath);
  }

  async savePending(receipt: Readonly<SettlementReceipt>): Promise<void> {
    await this.serial(async () => {
      const file = await this.load();
      file.pending[receipt.receiptId] = validateSettlementReceipt(receipt);
      await this.write(file);
    });
  }

  async clearPending(receiptId: string): Promise<void> {
    await this.serial(async () => {
      const file = await this.load();
      delete file.pending[receiptId];
      await this.write(file);
    });
  }

  async listPending(): Promise<ReadonlyArray<Readonly<SettlementReceipt>>> {
    return this.serial(async () => Object.values((await this.load()).pending).map(validateSettlementReceipt));
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

  private async load(): Promise<ReceiptFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: EMPTY.version, pending: {} };
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<ReceiptFile>;
    if (
      Object.keys(parsed).sort().join(",") !== "pending,version"
      || parsed.version !== 2
      || !parsed.pending
      || typeof parsed.pending !== "object"
      || Array.isArray(parsed.pending)
    ) {
      throw new Error("receipt store schema is invalid");
    }
    const pending: Record<string, SettlementReceipt> = {};
    for (const [id, receipt] of Object.entries(parsed.pending)) {
      const checked = validateSettlementReceipt(receipt);
      if (id !== checked.receiptId) throw new Error("receipt store key does not match receipt id");
      pending[id] = checked;
    }
    return { version: 2, pending };
  }

  private async write(file: ReceiptFile): Promise<void> {
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
