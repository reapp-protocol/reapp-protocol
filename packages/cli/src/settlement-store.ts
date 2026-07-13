import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import type { PendingSettlement } from "@reapp-sdk/core";
import { reappHome } from "./secrets.js";

export type SettlementSource = "pay" | "demo";

interface StoredSettlementBase {
  version: 2;
  source: SettlementSource;
  network: "testnet";
  contractId: string;
  pending: Readonly<PendingSettlement>;
}

export interface StoredPendingSettlement extends StoredSettlementBase {
  state: "pending";
}

export interface StoredCompletedSettlement extends StoredSettlementBase {
  state: "completed";
  completedAt: number;
}

export type StoredSettlement = StoredPendingSettlement | StoredCompletedSettlement;

export type LoadedSettlement =
  | { kind: "none" }
  | { kind: "empty" }
  | { kind: "pending"; record: Readonly<StoredPendingSettlement> }
  | { kind: "completed"; record: Readonly<StoredCompletedSettlement> };

const DIRECTORY = "pending-settlement";
const STATE = "state.json";

export function settlementDirectory(): string {
  return join(reappHome(), DIRECTORY);
}

function statePath(): string {
  return join(settlementDirectory(), STATE);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function validatePending(value: unknown): Readonly<PendingSettlement> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("pending settlement record is not an object");
  }
  const pending = value as PendingSettlement;
  const keys = ["txHash", "mandateId", "amount", "expectedSeq", "submittedAt", "validUntil"];
  if (pending.receiptId !== undefined) keys.push("receiptId");
  if (
    !exactKeys(pending, keys)
    || typeof pending.txHash !== "string"
    || !/^[0-9a-f]{64}$/.test(pending.txHash)
    || typeof pending.mandateId !== "string"
    || !/^[0-9a-f]{64}$/.test(pending.mandateId)
    || typeof pending.amount !== "string"
    || !/^\d+(?:\.\d+)?$/.test(pending.amount)
    || typeof pending.expectedSeq !== "string"
    || !/^\d+$/.test(pending.expectedSeq)
    || !Number.isSafeInteger(pending.submittedAt)
    || !Number.isSafeInteger(pending.validUntil)
    || pending.submittedAt <= 0
    || pending.validUntil <= pending.submittedAt
    || (pending.receiptId !== undefined && !/^[0-9a-f]{64}$/.test(pending.receiptId))
  ) {
    throw new Error("pending settlement record schema is invalid");
  }
  return Object.freeze({ ...pending });
}

function validateRecord(value: unknown): Readonly<StoredSettlement> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("settlement journal is not an object");
  }
  const record = value as StoredSettlement;
  const expectedKeys = record.state === "completed"
    ? ["version", "state", "source", "network", "contractId", "pending", "completedAt"]
    : ["version", "state", "source", "network", "contractId", "pending"];
  if (
    !exactKeys(record, expectedKeys)
    || record.version !== 2
    || (record.state !== "pending" && record.state !== "completed")
    || (record.source !== "pay" && record.source !== "demo")
    || record.network !== "testnet"
    || typeof record.contractId !== "string"
    || !/^C[A-Z2-7]{55}$/.test(record.contractId)
  ) {
    throw new Error("settlement journal schema is invalid");
  }
  const pending = validatePending(record.pending);
  if (record.state === "completed") {
    if (
      !Number.isSafeInteger(record.completedAt)
      || record.completedAt < pending.submittedAt
    ) {
      throw new Error("completed settlement journal schema is invalid");
    }
    return Object.freeze({ ...record, pending });
  }
  return Object.freeze({ ...record, pending });
}

async function assertDirectoryIsPrivate(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("settlement journal path is not a private directory");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error("settlement journal directory permissions are not private");
  }
}

export async function assertNoPendingSettlement(): Promise<void> {
  try {
    await lstat(settlementDirectory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("a payment is unresolved or unacknowledged; run `reapp settlement reconcile` before another payment");
}

async function writeState(record: Readonly<StoredSettlement>): Promise<void> {
  const directory = settlementDirectory();
  const temporary = join(directory, `${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, statePath());
    await chmod(statePath(), 0o600);
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

/** Atomic cross-process claim. It resolves only after the exact signed hash is fsynced. */
export async function claimPendingSettlement(
  source: SettlementSource,
  contractId: string,
  pending: Readonly<PendingSettlement>,
): Promise<void> {
  const home = reappHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const directory = settlementDirectory();
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("another prepared payment is unresolved; run `reapp settlement reconcile`");
    }
    throw error;
  }

  try {
    const record = validateRecord({
      version: 2,
      state: "pending",
      source,
      network: "testnet",
      contractId,
      pending,
    });
    await writeState(record);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function loadPendingSettlement(): Promise<LoadedSettlement> {
  const directory = settlementDirectory();
  try {
    await assertDirectoryIsPrivate(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    throw error;
  }
  let raw: string;
  try {
    raw = await readFile(statePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "empty" };
    throw error;
  }
  const info = await lstat(statePath());
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("settlement journal file is not a private regular file");
  }
  const record = validateRecord(JSON.parse(raw));
  return record.state === "completed"
    ? { kind: "completed", record }
    : { kind: "pending", record };
}

export async function clearPendingSettlement(expectedTxHash?: string): Promise<void> {
  const loaded = await loadPendingSettlement();
  if (loaded.kind === "none") return;
  if (loaded.kind === "completed") {
    throw new Error("refusing to clear a completed payment before explicit acknowledgment");
  }
  if (loaded.kind === "pending" && expectedTxHash !== undefined && loaded.record.pending.txHash !== expectedTxHash) {
    throw new Error("refusing to clear a different pending settlement hash");
  }
  if (loaded.kind === "empty" && expectedTxHash !== undefined) {
    throw new Error("refusing hash-specific clear of an empty pre-broadcast claim");
  }
  await rm(settlementDirectory(), { recursive: true, force: true });
}

/** Persist final success before any success is reported to the caller. */
export async function markSettlementCompleted(expectedTxHash: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(expectedTxHash)) {
    throw new Error("completed settlement hash must be canonical 64-character lowercase hex");
  }
  const loaded = await loadPendingSettlement();
  if (loaded.kind === "none" || loaded.kind === "empty") {
    throw new Error("cannot complete a settlement without its durable prepared record");
  }
  if (loaded.record.pending.txHash !== expectedTxHash) {
    throw new Error("refusing to complete a different settlement hash");
  }
  if (loaded.kind === "completed") return;
  const completed = validateRecord({
    ...loaded.record,
    state: "completed",
    completedAt: Math.max(Math.floor(Date.now() / 1_000), loaded.record.pending.submittedAt),
  });
  await writeState(completed);
}

/** Remove completed evidence only after the human/application accepts that exact success. */
export async function acknowledgeCompletedSettlement(expectedTxHash: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(expectedTxHash)) {
    throw new Error("acknowledgment hash must be canonical 64-character lowercase hex");
  }
  const loaded = await loadPendingSettlement();
  if (loaded.kind !== "completed") {
    throw new Error("no completed payment is awaiting acknowledgment");
  }
  if (loaded.record.pending.txHash !== expectedTxHash) {
    throw new Error("refusing to acknowledge a different completed settlement hash");
  }
  await rm(settlementDirectory(), { recursive: true, force: true });
}

export type MissingSettlementDecision = "pending" | "expired" | "history-pruned";

export function classifyMissingSettlement(
  pending: Readonly<PendingSettlement>,
  evidence: { latestLedgerCloseTime: number; oldestLedgerCloseTime: number },
): MissingSettlementDecision {
  if (evidence.latestLedgerCloseTime <= pending.validUntil) return "pending";
  if (evidence.oldestLedgerCloseTime > pending.submittedAt) return "history-pruned";
  return "expired";
}
