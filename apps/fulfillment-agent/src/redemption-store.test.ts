import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import type {
  BoundRedemptionRecord,
  StoredBoundJsonResponse,
} from "@reapp-sdk/express-middleware";
import { resolveBoundReappInterruptedDelivery } from "@reapp-sdk/express-middleware";
import { TESTNET } from "@reapp-sdk/stellar";
import { FileBoundRedemptionStore } from "./redemption-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function record(proofDigest = "b".repeat(64)): BoundRedemptionRecord {
  return {
    key: `${"a".repeat(64)}:${TESTNET.mandateRegistryId.toLowerCase()}:${"c".repeat(64)}`,
    proofDigest,
    payment: {
      txHash: "c".repeat(64),
      ledger: 100,
      mandateId: "d".repeat(64),
      user: "GCREL554SPELMSCEIQQVYS2TPDWONZ6AVQXMUNBEGGZ2X5FNYHDC2RZG",
      agent: "GBE3PH4ZYVYUXZWZL4YJP22H5J46U6VQVF6SYNJ3GGU3RHBN4M77VNBG",
      amount: "1",
      amountStroops: 10_000_000n,
      merchant: "GAHGD3Q6ZKKJFM4FM5M6DSDNTT6KGCEZRZ2NLBBGILZFSKNUFT7VTORQ",
      asset: TESTNET.nativeSac,
      registryId: TESTNET.mandateRegistryId,
      scheme: "reapp-soroban-bound",
      network: "stellar-testnet",
    },
  };
}

function response(body = { source: "data" }): StoredBoundJsonResponse {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  return {
    status: 200,
    contentType: "application/json; charset=utf-8",
    bodyBase64: bytes.toString("base64"),
    bodySha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

test("file store persists one immutable completed response across reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "reapp-redemptions-"));
  roots.push(root);
  const file = join(root, "private", "redemptions.json");
  const first = new FileBoundRedemptionStore(file);
  const expected = record();

  const claimed = await first.claim(expected, "execution-1", 1_700_000_000);
  assert.equal(claimed.kind, "claimed");
  const completed = await first.complete({
    key: expected.key,
    proofDigest: expected.proofDigest,
    executionId: "execution-1",
    response: response(),
  });
  assert.equal(completed.kind, "completed");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(file))).mode & 0o777, 0o700);

  const reopened = new FileBoundRedemptionStore(file);
  const recovery = await reopened.lookup(expected.key, expected.proofDigest);
  assert.equal(recovery.kind, "completed");
  if (recovery.kind === "completed") {
    assert.equal(recovery.record.payment.amountStroops, 10_000_000n);
    assert.deepEqual(
      JSON.parse(Buffer.from(recovery.record.response.bodyBase64, "base64").toString("utf8")),
      { source: "data" },
    );
  }
  assert.equal((await reopened.lookup(expected.key, "e".repeat(64))).kind, "conflict");
  assert.equal((await reopened.complete({
    key: expected.key,
    proofDigest: expected.proofDigest,
    executionId: "execution-1",
    response: response({ source: "changed" }),
  })).kind, "conflict", "completed bytes are immutable");
});

test("two store instances for one path atomically yield one claim and one conflict", async () => {
  const root = await mkdtemp(join(tmpdir(), "reapp-redemptions-"));
  roots.push(root);
  const file = join(root, "redemptions.json");
  const first = new FileBoundRedemptionStore(file);
  const second = new FileBoundRedemptionStore(join(root, ".", "redemptions.json"));
  const results = await Promise.all([
    first.claim(record("b".repeat(64)), "execution-1", 1_700_000_000),
    second.claim(record("e".repeat(64)), "execution-2", 1_700_000_000),
  ]);
  assert.equal(results.filter((result) => result.kind === "claimed").length, 1);
  assert.equal(results.filter((result) => result.kind === "conflict").length, 1);
});

test("an executing claim survives restart, cannot rerun, and resolves to one terminal result", async () => {
  const root = await mkdtemp(join(tmpdir(), "reapp-redemptions-"));
  roots.push(root);
  const file = join(root, "redemptions.json");
  const expected = record();
  const first = new FileBoundRedemptionStore(file);
  assert.equal((await first.claim(expected, "execution-1", 1_700_000_000)).kind, "claimed");
  const reopened = new FileBoundRedemptionStore(file);
  assert.equal((await reopened.lookup(expected.key, expected.proofDigest)).kind, "executing");
  assert.equal((await reopened.claim(expected, "execution-2", 1_700_000_001)).kind, "executing");
  const interrupted = await reopened.listExecuting();
  assert.equal(interrupted.length, 1);
  await resolveBoundReappInterruptedDelivery({
    redemptionStore: reopened,
    record: interrupted[0]!,
  });
  const resolved = await reopened.lookup(expected.key, expected.proofDigest);
  assert.equal(resolved.kind, "completed");
  if (resolved.kind === "completed") {
    assert.deepEqual(
      JSON.parse(Buffer.from(resolved.record.response.bodyBase64, "base64").toString("utf8")),
      {
        ok: false,
        error: "paid fulfillment failed after settlement",
        deliveryState: "terminal",
      },
    );
  }
});

test("corrupted file store fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "reapp-redemptions-"));
  roots.push(root);
  const file = join(root, "redemptions.json");
  await writeFile(file, JSON.stringify({ version: 2, records: { wrong: {
    ...record(),
    payment: { ...record().payment, amountStroops: "10000000" },
    executionId: "execution-1",
    startedAt: 1_700_000_000,
    state: "executing",
  } } }), "utf8");
  const store = new FileBoundRedemptionStore(file);
  await assert.rejects(() => store.lookup("wrong", "b".repeat(64)), /key does not match/);
});
