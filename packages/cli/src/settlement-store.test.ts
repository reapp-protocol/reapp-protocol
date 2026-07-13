import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { TESTNET } from "@reapp-sdk/stellar";
import type { PendingSettlement } from "@reapp-sdk/core";
import {
  acknowledgeCompletedSettlement,
  assertNoPendingSettlement,
  claimPendingSettlement,
  classifyMissingSettlement,
  clearPendingSettlement,
  loadPendingSettlement,
  markSettlementCompleted,
  settlementDirectory,
} from "./settlement-store.js";

const roots: string[] = [];
const previousHome = process.env.REAPP_HOME;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.REAPP_HOME;
  else process.env.REAPP_HOME = previousHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reapp-cli-settlement-"));
  roots.push(root);
  process.env.REAPP_HOME = root;
  return root;
}

function pending(digit = "a"): PendingSettlement {
  return {
    txHash: digit.repeat(64),
    mandateId: "b".repeat(64),
    amount: "1.00",
    expectedSeq: "0",
    submittedAt: 1_700_000_000,
    validUntil: 1_700_000_060,
  };
}

test("two concurrent prepared payments produce exactly one durable cross-process claim", async () => {
  await home();
  const results = await Promise.allSettled([
    claimPendingSettlement("pay", TESTNET.mandateRegistryId, pending("a")),
    claimPendingSettlement("pay", TESTNET.mandateRegistryId, pending("c")),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const loaded = await loadPendingSettlement();
  assert.equal(loaded.kind, "pending");
  if (loaded.kind !== "pending") assert.fail("expected pending journal");
  assert.ok(["a".repeat(64), "c".repeat(64)].includes(loaded.record.pending.txHash));
  assert.equal((await stat(settlementDirectory())).mode & 0o777, 0o700);
  assert.equal((await stat(join(settlementDirectory(), "state.json"))).mode & 0o777, 0o600);
});

test("two separate CLI processes cannot both acquire the payment journal", async () => {
  const root = await home();
  const moduleUrl = new URL("./settlement-store.ts", import.meta.url).href;
  const code = `
    import { claimPendingSettlement } from ${JSON.stringify(moduleUrl)};
    const pending = JSON.parse(process.env.REAPP_TEST_PENDING);
    await claimPendingSettlement("pay", ${JSON.stringify(TESTNET.mandateRegistryId)}, pending);
  `;
  const run = (value: PendingSettlement) => new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
      env: {
        ...process.env,
        REAPP_HOME: root,
        REAPP_TEST_PENDING: JSON.stringify(value),
      },
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", resolve);
  });
  const statuses = await Promise.all([run(pending("a")), run(pending("c"))]);
  assert.deepEqual(statuses.sort(), [0, 1]);
});

test("hash-specific clear cannot delete another payment", async () => {
  await home();
  await claimPendingSettlement("demo", TESTNET.mandateRegistryId, pending());
  await assert.rejects(() => clearPendingSettlement("c".repeat(64)), /different pending/);
  assert.equal((await loadPendingSettlement()).kind, "pending");
  await clearPendingSettlement("a".repeat(64));
  assert.equal((await loadPendingSettlement()).kind, "none");
});

test("successful settlement remains locked across restart until exact acknowledgment", async () => {
  await home();
  const hash = "a".repeat(64);
  await claimPendingSettlement("pay", TESTNET.mandateRegistryId, pending());
  await markSettlementCompleted(hash);

  const loaded = await loadPendingSettlement();
  assert.equal(loaded.kind, "completed");
  if (loaded.kind !== "completed") assert.fail("expected completed journal");
  assert.equal(loaded.record.pending.txHash, hash);
  await assert.rejects(() => assertNoPendingSettlement(), /unresolved or unacknowledged/);
  await assert.rejects(() => clearPendingSettlement(hash), /explicit acknowledgment/);
  await assert.rejects(() => acknowledgeCompletedSettlement("c".repeat(64)), /different completed/);
  assert.equal((await loadPendingSettlement()).kind, "completed");

  await acknowledgeCompletedSettlement(hash);
  assert.equal((await loadPendingSettlement()).kind, "none");
  await assert.doesNotReject(() => assertNoPendingSettlement());
});

test("completed transition is idempotent for only the exact transaction hash", async () => {
  await home();
  await claimPendingSettlement("demo", TESTNET.mandateRegistryId, pending());
  await markSettlementCompleted("a".repeat(64));
  await assert.doesNotReject(() => markSettlementCompleted("a".repeat(64)));
  await assert.rejects(() => markSettlementCompleted("c".repeat(64)), /different settlement/);
  assert.equal((await loadPendingSettlement()).kind, "completed");
});

test("an empty interrupted pre-broadcast claim is distinguishable and safely clearable", async () => {
  await home();
  await mkdir(settlementDirectory(), { mode: 0o700 });
  assert.equal((await loadPendingSettlement()).kind, "empty");
  await assert.rejects(() => clearPendingSettlement("a".repeat(64)), /empty pre-broadcast/);
  await clearPendingSettlement();
  assert.equal((await loadPendingSettlement()).kind, "none");
});

test("malformed or widened-permission journal state fails closed", async () => {
  await home();
  await mkdir(settlementDirectory(), { mode: 0o700 });
  await writeFile(join(settlementDirectory(), "state.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(() => loadPendingSettlement(), /schema/);
});

test("NOT_FOUND clears only after expiry with the complete history window retained", () => {
  const record = pending();
  assert.equal(classifyMissingSettlement(record, {
    latestLedgerCloseTime: record.validUntil,
    oldestLedgerCloseTime: record.submittedAt - 100,
  }), "pending");
  assert.equal(classifyMissingSettlement(record, {
    latestLedgerCloseTime: record.validUntil + 1,
    oldestLedgerCloseTime: record.submittedAt - 100,
  }), "expired");
  assert.equal(classifyMissingSettlement(record, {
    latestLedgerCloseTime: record.validUntil + 1,
    oldestLedgerCloseTime: record.submittedAt + 1,
  }), "history-pruned");
});
