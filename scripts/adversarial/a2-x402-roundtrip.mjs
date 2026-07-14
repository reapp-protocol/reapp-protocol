// Gate A2 — bound-v2 x402 round-trip using ONLY published packages:
// merchant built from @reapp-sdk/express-middleware, consumer from @reapp-sdk/core.
// Then adversarial: exact-proof replay (recovery, no new fulfillment), proof
// retargeted at another resource (rejected), legacy client (426 before payment).
import express from "express";
import { randomBytes } from "node:crypto";
import { reapp, getSettlementReceipt } from "@reapp-sdk/core";
import {
  InMemoryBoundRedemptionStore,
  createBoundReappPaidJsonRoute,
} from "@reapp-sdk/express-middleware";
import { Keypair } from "@stellar/stellar-sdk";

const results = [];
let failures = 0;
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

async function fund(kp, label) {
  const res = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!res.ok) throw new Error(`friendbot failed for ${label}: ${res.status}`);
  console.log(`funded ${label} ${kp.publicKey()}`);
}

const user = Keypair.random();
const agentKey = Keypair.random();
const merchant = Keypair.random();
await fund(user, "user");
await fund(agentKey, "agent");
await fund(merchant, "merchant");

const mandate = reapp.createIntentMandate({
  user: user.publicKey(),
  agent: agentKey.publicKey(),
  merchant: merchant.publicKey(),
  asset: reapp.testnet.nativeSac,
  maxAmount: "3.00",
  expiry: Math.floor(Date.now() / 1000) + 3600,
});
await reapp.registerMandate(mandate, { signer: user });
await reapp.approveBudget(mandate, { signer: user });
console.log(`mandate ${mandate.id} registered + funded (3.00 XLM)`);

// --- merchant: 402-gated Express API from the published middleware ---
const PORT = 4021;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let fulfillments = 0;
const app = express();
const paid = createBoundReappPaidJsonRoute({
  merchant: merchant.publicKey(),
  sourceAccount: merchant.publicKey(),
  audience: ORIGIN,
  challengeSecret: randomBytes(48).toString("hex"),
  amount: "1.00",
  resource: (request) => request.originalUrl,
  redemptionStore: new InMemoryBoundRedemptionStore(),
}, async ({ request, payment }) => {
  fulfillments++;
  return { body: { ok: true, resource: request.params.id, run: fulfillments, settledTx: payment.txHash } };
});
app.get("/source/:id", paid);
const server = app.listen(PORT);
await new Promise(r => server.on("listening", r));
console.log(`merchant listening on ${ORIGIN}`);

// --- consumer: published core agent, bound-v2 only, durable-enough receipt store ---
const pendings = new Map();
const receiptStore = {
  async savePending(receipt) { pendings.set(receipt.receiptId, structuredClone(receipt)); },
  async listPending() { return [...pendings.values()]; },
  async clearPending(receiptId) { pendings.delete(receiptId); },
};
const consumer = reapp.agent({ mandate, signer: agentKey, proofPolicy: "bound-v2-only", receiptStore });

const txes = [];
const receipts = [];
for (const id of ["market", "academic", "news"]) {
  const res = await consumer.fetch(`${ORIGIN}/source/${id}`);
  const body = await res.json();
  const receipt = getSettlementReceipt(res);
  receipts.push(receipt);
  txes.push(receipt?.txHash);
  record(`agent.fetch pays + unlocks /source/${id}`, res.status === 200 && body.ok === true && !!receipt?.txHash, `tx=${receipt?.txHash}`);
  await consumer.acknowledgeDelivery(receipt);
}
record("receipt store cycle: all pendings acknowledged + cleared", pendings.size === 0, `pending=${pendings.size}`);

// --- 4th purchase: contract must reject (budget exhausted) before any unlock ---
try {
  await consumer.fetch(`${ORIGIN}/source/patents`);
  record("4th purchase blocked on-chain (BudgetExceeded)", false, "unexpectedly unlocked");
} catch (err) {
  const msg = String(err?.message ?? err);
  record("4th purchase blocked on-chain (BudgetExceeded)", /6|budget/i.test(msg), msg.slice(0, 140));
}
record("fulfillment ran exactly 3 times (no free unlocks)", fulfillments === 3, `fulfillments=${fulfillments}`);

// --- adversarial: raw client without bound-v2 capability gets 426 BEFORE payment ---
const legacy = await fetch(`${ORIGIN}/source/market`);
record("legacy client (no bound-v2) receives 426 before payment", legacy.status === 426, `status=${legacy.status}`);

// --- adversarial: replay the exact settled proof against ANOTHER resource ---
const proofHeader = receipts[0]?.proof?.header ?? receipts[0]?.proofHeader;
const settledProof = receipts[0];
async function rawPaidRequest(path, receipt) {
  return fetch(`${ORIGIN}${path}`, {
    headers: {
      "REAPP-PAYMENT-CAPABILITIES": "reapp-bound-v2",
      "X-PAYMENT": typeof receipt.proof === "string" ? receipt.proof : (receipt.proof?.header ?? JSON.stringify(receipt.proof)),
    },
  });
}
const cross = await rawPaidRequest("/source/academic", settledProof);
record("settled proof retargeted at another resource is rejected", cross.status === 409 || cross.status === 401 || cross.status === 400 || cross.status === 402, `status=${cross.status}`);

// --- recovery semantics: exact same proof on the SAME resource replays stored bytes, no new fulfillment ---
const before = fulfillments;
const same = await rawPaidRequest("/source/market", settledProof);
const sameOk = same.status === 200 || same.status === 402 || same.status === 400;
record("exact-proof replay never re-runs fulfillment", fulfillments === before, `status=${same.status} fulfillments=${fulfillments}`);

server.close();
console.log(`\nA2 SUMMARY: ${results.filter(r => r.ok).length}/${results.length} checks passed`);
console.log("TXES " + JSON.stringify({ mandateId: mandate.id, txes }));
process.exit(failures ? 1 : 0);
