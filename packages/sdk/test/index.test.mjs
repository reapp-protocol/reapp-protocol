// Unit tests for the money-parsing and mandate-construction guards in
// @reapp-sdk/core. Runs on the built package (CI builds before testing) with
// Node's built-in test runner — no extra dependencies.
//
//   npm test   (from packages/sdk, or via the workspace)
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { toStroops, reapp } from "@reapp-sdk/core";

const now = Math.floor(Date.now() / 1000);
const baseMandate = { user: "U", agent: "A", merchant: "M", asset: "S", maxAmount: "5.00" };

test("toStroops converts valid decimals exactly", () => {
  assert.equal(toStroops("5.00"), 50000000n);
  assert.equal(toStroops("0.01"), 100000n);
  assert.equal(toStroops("100"), 1000000000n);
  assert.equal(toStroops("0"), 0n);
  assert.equal(toStroops("007.5"), 75000000n); // leading zeros are fine
});

test("toStroops respects a custom decimals", () => {
  assert.equal(toStroops("1.23", 2), 123n);
  assert.throws(() => toStroops("1.234", 2), /more than 2 decimal places/);
});

test("toStroops rejects every ambiguous or malformed amount", () => {
  for (const bad of ["-5.00", "+5.00", "5e2", "5E2", "0x10", "5.", ".5", "", "   ", "5 .0", "5,00", "5.0.0", "５", "٥", "१", "NaN", "abc"]) {
    assert.throws(() => toStroops(bad), undefined, `expected throw for ${JSON.stringify(bad)}`);
  }
});

test("toStroops rejects amounts that do not fit i128 (no silent wrap)", () => {
  assert.throws(() => toStroops("9".repeat(40)), /too large to fit/);
  // A whole number one past i128 max in stroops also throws.
  const overMax = (2n ** 127n).toString();
  assert.throws(() => toStroops(overMax, 0), /too large to fit/);
});

test("createIntentMandate builds a 32-byte hex id with no chain call", () => {
  const m = reapp.createIntentMandate({ ...baseMandate, expiry: now + 3600 });
  assert.match(m.id, /^[0-9a-f]{64}$/);
  assert.equal(m.maxAmount, 50000000n);
  assert.equal(m.idBuffer.length, 32);
});

test("createIntentMandate validates expiry against the u64 range", () => {
  assert.throws(() => reapp.createIntentMandate({ ...baseMandate, expiry: Number.NaN }), /expiry must be/);
  assert.throws(() => reapp.createIntentMandate({ ...baseMandate, expiry: now + 0.5 }), /expiry must be/);
  assert.throws(() => reapp.createIntentMandate({ ...baseMandate, expiry: 0 }), /expiry must be/);
  assert.throws(() => reapp.createIntentMandate({ ...baseMandate, expiry: -1 }), /expiry must be/);
  assert.throws(() => reapp.createIntentMandate({ ...baseMandate, expiry: 1e20 }), /expiry must be/);
});

test("a unique nonce keeps ids distinct for identical fields", () => {
  const a = reapp.createIntentMandate({ ...baseMandate, expiry: now + 3600 });
  const b = reapp.createIntentMandate({ ...baseMandate, expiry: now + 3600 });
  assert.notEqual(a.id, b.id);
});

test("direct pay refuses to touch the network without a pre-broadcast durable journal", async () => {
  const signer = Keypair.random();
  const mandate = reapp.createIntentMandate({
    user: signer.publicKey(),
    agent: signer.publicKey(),
    merchant: Keypair.random().publicKey(),
    asset: reapp.testnet.nativeSac,
    maxAmount: "1.00",
    expiry: now + 3600,
  });
  const agent = reapp.agent({ mandate, signer });
  await assert.rejects(() => agent.pay("1.00"), /onPrepared durable settlement journal/);
  await assert.rejects(() => agent.reconcilePendingSettlement({
    txHash: "a".repeat(64),
    mandateId: "b".repeat(64),
    amount: "1.00",
    expectedSeq: "0",
    submittedAt: now,
    validUntil: now + 60,
  }), /invalid or belongs to another mandate/);
});
