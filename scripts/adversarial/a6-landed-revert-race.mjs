// Gate A6 — land a genuinely INCLUDED-AND-REVERTED negative tx on-chain, so
// "the contract rejects on-chain" is demonstrable with a real failed tx hash on
// Horizon, not only a pre-inclusion simulation refusal.
//
// Method (account-sequence race): build TWO execute_payment txs from the agent's
// account at consecutive account sequences S and S+1, BOTH declaring mandate
// expected_seq=0, while the mandate seq is still 0 (so both preflight clean).
// Submit both. The network runs S first: it settles and advances mandate seq
// 0->1. Then S+1 runs: the contract replay guard sees expected_seq 0 != current
// 1 and REVERTS -> that tx is INCLUDED in a ledger as FAILED with its own hash.
import { reapp, toStroops } from "@reapp-sdk/core";
import { TESTNET } from "@reapp-sdk/stellar";
import { Keypair, Contract, Address, nativeToScVal, TransactionBuilder, BASE_FEE, rpc } from "@stellar/stellar-sdk";

const server = new rpc.Server(TESTNET.rpcUrl);
const CONTRACT = TESTNET.mandateRegistryId;
const results = [];
let failures = 0;
const rec = (n, ok, d) => { results.push({ n, ok, d }); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failures++; };
async function fund(kp) { const r = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`); if (!r.ok) throw new Error("friendbot"); }

const user = Keypair.random(), agent = Keypair.random(), merchant = Keypair.random();
await fund(user); await fund(agent); await fund(merchant);

const mandate = reapp.createIntentMandate({
  user: user.publicKey(), agent: agent.publicKey(), merchant: merchant.publicKey(),
  asset: TESTNET.nativeSac, maxAmount: "2.00", expiry: Math.floor(Date.now() / 1000) + 3600,
});
await reapp.registerMandate(mandate, { signer: user });
await reapp.approveBudget(mandate, { signer: user });
console.log(`mandate ${mandate.id} live; budget 2.00 XLM`);

function execOp() {
  return new Contract(CONTRACT).call(
    "execute_payment",
    nativeToScVal(mandate.idBuffer, { type: "bytes" }),
    nativeToScVal(toStroops("0.10"), { type: "i128" }),
    nativeToScVal(0, { type: "u32" }), // expected_seq = 0 for BOTH
  );
}

// One Account object; each .build() consumes the next account sequence (S, S+1).
const src = await server.getAccount(agent.publicKey());
const tx1raw = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: TESTNET.networkPassphrase }).addOperation(execOp()).setTimeout(120).build();
const tx2raw = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: TESTNET.networkPassphrase }).addOperation(execOp()).setTimeout(120).build();

// Preflight BOTH now, while mandate seq is still 0 -> both assemble cleanly.
const p1 = await server.prepareTransaction(tx1raw);
const p2 = await server.prepareTransaction(tx2raw);
p1.sign(agent); p2.sign(agent);
rec("both stale-seq txs preflight clean while mandate seq==0", true, "assembled S and S+1");

// Submit tx1 (account seq S) and wait until it lands (advances mandate seq).
const s1 = await server.sendTransaction(p1);
let f1 = s1, st1 = s1.status;
for (let i = 0; i < 20 && (st1 === "PENDING" || st1 === "NOT_FOUND"); i++) { await new Promise(r => setTimeout(r, 2000)); f1 = await server.getTransaction(s1.hash); st1 = f1.status; }
rec("tx1 (account seq S) settled on-chain", st1 === "SUCCESS", `tx=${s1.hash} status=${st1}`);

// Now submit tx2 (account seq S+1) — mandate seq is now 1, its expected_seq 0 is stale.
const s2 = await server.sendTransaction(p2);
let f2 = s2, st2 = s2.status;
for (let i = 0; i < 20 && (st2 === "PENDING" || st2 === "NOT_FOUND"); i++) { await new Promise(r => setTimeout(r, 2000)); f2 = await server.getTransaction(s2.hash); st2 = f2.status; }
rec("tx2 (stale expected_seq) was INCLUDED and REVERTED on-chain", st2 === "FAILED", `tx=${s2.hash} status=${st2}`);
console.log(`LANDED_REVERT_HASH ${s2.hash}`);

console.log(`\nA6 SUMMARY: ${results.filter(r => r.ok).length}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
