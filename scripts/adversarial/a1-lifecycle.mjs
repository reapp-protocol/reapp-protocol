// Gate A1 — full mandate lifecycle through the published @reapp-sdk/core only.
// Reviewer-chair test: no repo code, registry packages only, live testnet.
import { reapp, Errors, toStroops } from "@reapp-sdk/core";
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

const journal = [];
const lifecycle = { onPrepared: (pending) => { journal.push(pending); } };

const user = Keypair.random();
const agent = Keypair.random();
const merchant = Keypair.random();
await fund(user, "user");
await fund(agent, "agent");
await fund(merchant, "merchant");

// --- mandate: 2.5 XLM budget, 1h expiry ---
const mandate = reapp.createIntentMandate({
  user: user.publicKey(),
  agent: agent.publicKey(),
  merchant: merchant.publicKey(),
  asset: reapp.testnet.nativeSac,
  maxAmount: "2.50",
  expiry: Math.floor(Date.now() / 1000) + 3600,
});
console.log(`mandate id ${mandate.id}`);

const regTx = await reapp.registerMandate(mandate, { signer: user });
record("registerMandate settles on-chain", typeof regTx === "string" && regTx.length === 64, `tx=${regTx}`);
const apprTx = await reapp.approveBudget(mandate, { signer: user });
record("approveBudget (allowance to CONTRACT) settles", typeof apprTx === "string" && apprTx.length === 64, `tx=${apprTx}`);

const payer = reapp.agent({ mandate, signer: agent });
const pay1 = await payer.pay("1.00", lifecycle);
record("pay #1 (1.00) settles", pay1.length === 64, `tx=${pay1}`);
const pay2 = await payer.pay("1.00", lifecycle);
record("pay #2 (1.00) settles", pay2.length === 64, `tx=${pay2}`);
record("onPrepared journal captured pre-broadcast hashes", journal.length === 2 && journal.every(p => p.hash || p.txHash), `entries=${journal.length}`);

// --- negative: overspend (0.50 remaining, ask 1.00) ---
try {
  await payer.pay("1.00", lifecycle);
  record("contract rejects overspend (BudgetExceeded)", false, "payment unexpectedly settled");
} catch (err) {
  const msg = String(err?.message ?? err);
  record("contract rejects overspend (BudgetExceeded)", /6|budget/i.test(msg), msg.slice(0, 140));
}

// --- exact remaining budget succeeds (proves rejection was the cap, not flake) ---
const pay3 = await payer.pay("0.50", lifecycle);
record("pay #3 exact remaining 0.50 settles", pay3.length === 64, `tx=${pay3}`);

// --- independent state readback via low-level typed client ---
const { registryClient, keypairSigner, TESTNET } = await import("@reapp-sdk/stellar");
const reader = registryClient(TESTNET, keypairSigner(agent.secret(), TESTNET.networkPassphrase));
const got = await reader.get_mandate({ mandate_id: mandate.idBuffer });
const m = got.result?.unwrap ? got.result.unwrap() : got.result;
record("on-chain spent == 2.50 (independent readback)", m.spent === toStroops("2.50"), `spent=${m.spent}`);
record("on-chain seq == 3 (one per payment)", m.seq === 3, `seq=${m.seq}`);

// --- negative: revoke, then pay ---
const revTx = await reapp.revokeMandate(mandate, { signer: user });
record("revokeMandate settles", revTx.length === 64, `tx=${revTx}`);
try {
  await payer.pay("0.01", lifecycle);
  record("contract rejects pay-after-revoke (MandateRevoked)", false, "payment unexpectedly settled");
} catch (err) {
  const msg = String(err?.message ?? err);
  record("contract rejects pay-after-revoke (MandateRevoked)", /5|revok/i.test(msg), msg.slice(0, 140));
}

// --- negative: expiry mid-flow (fresh short mandate) ---
const shortMandate = reapp.createIntentMandate({
  user: user.publicKey(),
  agent: agent.publicKey(),
  merchant: merchant.publicKey(),
  asset: reapp.testnet.nativeSac,
  maxAmount: "1.00",
  expiry: Math.floor(Date.now() / 1000) + 45,
});
await reapp.registerMandate(shortMandate, { signer: user });
await reapp.approveBudget(shortMandate, { signer: user });
console.log("waiting 75s for the short mandate to expire on-ledger…");
await new Promise(r => setTimeout(r, 75_000));
try {
  await reapp.agent({ mandate: shortMandate, signer: agent }).pay("0.10", lifecycle);
  record("contract rejects expired mandate (MandateExpired)", false, "payment unexpectedly settled");
} catch (err) {
  const msg = String(err?.message ?? err);
  record("contract rejects expired mandate (MandateExpired)", /4|expir/i.test(msg), msg.slice(0, 140));
}

// --- toStroops strictness (money safety) ---
let strict = 0;
for (const bad of ["-1.00", "1e7", "1.23456789", "abc"]) {
  try { toStroops(bad); } catch { strict++; }
}
record("toStroops rejects negative/scientific/overprecise/garbage", strict === 4, `${strict}/4 rejected`);

console.log(`\nA1 SUMMARY: ${results.filter(r => r.ok).length}/${results.length} checks passed`);
console.log("TXES " + JSON.stringify({ regTx, apprTx, pay1, pay2, pay3, revTx, mandateId: mandate.id }));
process.exit(failures ? 1 : 0);
