import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createSettlementReceiptId, type SettlementReceipt } from "@reapp-sdk/core";
import { FileSettlementReceiptStore } from "./receipt-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function receipt(txDigit = "a", resource = "market"): SettlementReceipt {
  const proof = {
    scheme: "reapp-soroban",
    network: "stellar-testnet",
    txHash: txDigit.repeat(64),
    mandateId: "b".repeat(64),
    amount: "1.00",
  };
  const withoutId = {
    proofVersion: 1,
    url: `https://merchant.example/source/${resource}`,
    method: "GET",
    txHash: proof.txHash,
    mandateId: proof.mandateId,
    amount: proof.amount,
    submittedAt: 1_700_000_000,
    validUntil: 1_700_000_060,
    proof,
  };
  return { receiptId: createSettlementReceiptId(withoutId), ...withoutId };
}

test("reference receipt store durably saves then removes an exact receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "reapp-receipts-"));
  roots.push(root);
  const file = join(root, "private", "receipts.json");
  const store = new FileSettlementReceiptStore(file);
  const expected = receipt();

  await store.savePending(expected);
  assert.deepEqual(await store.listPending(), [expected]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.match(await readFile(file, "utf8"), new RegExp(expected.receiptId));

  const reopened = new FileSettlementReceiptStore(file);
  assert.deepEqual(await reopened.listPending(), [expected]);
  await reopened.clearPending(expected.receiptId);
  assert.deepEqual(await reopened.listPending(), []);
});

test("reference receipt store fails closed on corrupted or mismatched data", async () => {
  const root = await mkdtemp(join(tmpdir(), "reapp-receipts-"));
  roots.push(root);
  const file = join(root, "receipts.json");
  const expected = receipt();
  await writeFile(file, JSON.stringify({ version: 2, pending: { wrong: expected } }), "utf8");
  const store = new FileSettlementReceiptStore(file);
  await assert.rejects(() => store.listPending(), /key does not match/);
});

test("reference receipt store rejects a retargeted recovery envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "reapp-receipts-"));
  roots.push(root);
  const file = join(root, "receipts.json");
  const expected = receipt();
  const retargeted = { ...expected, url: "https://collector.example/source/market" };
  await writeFile(file, JSON.stringify({
    version: 2,
    pending: { [expected.receiptId]: retargeted },
  }), "utf8");
  const store = new FileSettlementReceiptStore(file);
  await assert.rejects(() => store.listPending(), /invalid integrity id/);
});

test("two store objects targeting one file cannot lose concurrent receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "reapp-receipts-"));
  roots.push(root);
  const file = join(root, "receipts.json");
  const first = receipt("a", "market");
  const second = receipt("c", "weather");
  const storeA = new FileSettlementReceiptStore(file);
  const storeB = new FileSettlementReceiptStore(file);

  await Promise.all([storeA.savePending(first), storeB.savePending(second)]);
  assert.deepEqual(
    (await storeA.listPending()).map((entry) => entry.receiptId).sort(),
    [first.receiptId, second.receiptId].sort(),
  );
});
