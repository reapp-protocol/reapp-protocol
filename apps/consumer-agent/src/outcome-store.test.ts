import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  FilePurchaseOutcomeStore,
  createPurchaseIdentity,
  createStoredPurchaseOutcome,
} from "./outcome-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reapp-consumer-outcome-"));
  roots.push(root);
  const file = join(root, "private", "outcomes.json");
  const identity = createPurchaseIdentity({
    mandateId: "a".repeat(64),
    url: "https://merchant.test/source/market",
    sourceId: "market",
  });
  return { root, file, identity };
}

test("outcome store persists one immutable application result with private modes", async () => {
  const { file, identity } = await fixture();
  const store = new FilePurchaseOutcomeStore(file);
  const executionId = randomUUID();
  assert.deepEqual(await store.claim(identity, executionId, 1_700_000_000), { kind: "claimed" });
  const outcome = createStoredPurchaseOutcome({
    identity,
    kind: "delivered",
    receiptId: "b".repeat(64),
    txHash: "c".repeat(64),
    name: "Market",
    data: "accepted",
    completedAt: 1_700_000_010,
  });
  assert.deepEqual(await store.complete(identity, executionId, outcome), outcome);
  assert.deepEqual(await store.complete(identity, executionId, outcome), outcome);

  const reopened = new FilePurchaseOutcomeStore(file);
  assert.deepEqual(await reopened.lookup(identity), { kind: "completed", outcome });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(file, ".."))).mode & 0o777, 0o700);

  const conflicting = createStoredPurchaseOutcome({
    identity,
    kind: "delivered",
    receiptId: "b".repeat(64),
    txHash: "c".repeat(64),
    name: "Market",
    data: "different",
    completedAt: 1_700_000_010,
  });
  await assert.rejects(() => reopened.complete(identity, executionId, conflicting), /immutable/);
});

test("100 concurrent claims across two objects yield exactly one execution owner", async () => {
  const { file, identity } = await fixture();
  const first = new FilePurchaseOutcomeStore(file);
  const second = new FilePurchaseOutcomeStore(file);
  const ids = Array.from({ length: 100 }, () => randomUUID());
  const results = await Promise.all(ids.map((id, index) =>
    (index % 2 === 0 ? first : second).claim(identity, id, 1_700_000_000 + index)
  ));
  assert.equal(results.filter((result) => result.kind === "claimed").length, 1);
  const ownerIndex = results.findIndex((result) => result.kind === "claimed");
  assert.ok(ownerIndex >= 0);
  const owner = ids[ownerIndex] as string;
  const outcome = createStoredPurchaseOutcome({ identity, kind: "rejected", reason: "budget exceeded" });
  await first.complete(identity, owner, outcome);
  assert.deepEqual(await second.lookup(identity), { kind: "completed", outcome });
});

test("identity binds exact mandate, URL, method, and source", async () => {
  const { identity } = await fixture();
  const changedUrl = createPurchaseIdentity({
    mandateId: identity.mandateId,
    url: "https://merchant.test/source/market?fresh=1",
    sourceId: identity.sourceId,
  });
  const changedMandate = createPurchaseIdentity({
    mandateId: "d".repeat(64),
    url: identity.url,
    sourceId: identity.sourceId,
  });
  assert.notEqual(identity.key, changedUrl.key);
  assert.notEqual(identity.key, changedMandate.key);
});

test("unknown fields and cross-key tampering fail closed", async () => {
  const { file, identity } = await fixture();
  const store = new FilePurchaseOutcomeStore(file);
  await store.claim(identity, randomUUID(), 1_700_000_000);
  const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  parsed.extra = true;
  await writeFile(file, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  await assert.rejects(() => store.lookup(identity), /schema/);
});
