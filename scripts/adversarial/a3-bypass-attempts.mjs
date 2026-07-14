// Gate A3 — "the SDK is untrusted": act as a MALICIOUS SDK using the published
// low-level typed client (@reapp-sdk/stellar) and try to get money out of a
// mandate in every way the wire permits. The contract must reject each attempt.
//
// Also proves the custody boundary: the SEP-41 allowance belongs to the
// CONTRACT, so neither the agent key nor any SDK code can transfer_from the
// user directly.
import { reapp, toStroops } from "@reapp-sdk/core";
import { registryClient, keypairSigner, TESTNET } from "@reapp-sdk/stellar";
import { Keypair, Contract, TransactionBuilder, BASE_FEE, nativeToScVal, Address, rpc } from "@stellar/stellar-sdk";

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
const agent = Keypair.random();
const merchant = Keypair.random();
const rogue = Keypair.random();
await fund(user, "user");
await fund(agent, "agent");
await fund(merchant, "merchant");
await fund(rogue, "rogue");

// Register a real, funded 2.00 XLM mandate through the blessed path.
const mandate = reapp.createIntentMandate({
  user: user.publicKey(),
  agent: agent.publicKey(),
  merchant: merchant.publicKey(),
  asset: reapp.testnet.nativeSac,
  maxAmount: "2.00",
  expiry: Math.floor(Date.now() / 1000) + 3600,
});
await reapp.registerMandate(mandate, { signer: user });
await reapp.approveBudget(mandate, { signer: user });
console.log(`mandate ${mandate.id} live with 2.00 XLM allowance to the contract`);

const asAgent = registryClient(TESTNET, keypairSigner(agent.secret(), TESTNET.networkPassphrase));
const asRogue = registryClient(TESTNET, keypairSigner(rogue.secret(), TESTNET.networkPassphrase));

async function attempt(name, fn, expectPattern) {
  try {
    await fn();
    record(name, false, "attempt unexpectedly SUCCEEDED — money path breached");
  } catch (err) {
    const msg = String(err?.message ?? err);
    record(name, expectPattern.test(msg), msg.replace(/\n[\s\S]*/, "").slice(0, 130));
  }
}

async function sendPayment(client, { amount, seq }) {
  const tx = await client.execute_payment({
    mandate_id: mandate.idBuffer,
    amount,
    expected_seq: seq,
  });
  const sent = await tx.signAndSend();
  const r = sent.result;
  if (r && typeof r.unwrap === "function") r.unwrap();
  return sent;
}

// 0. sanity: the mandate genuinely pays for its rightful agent (1.00 of 2.00)
const legit = await sendPayment(asAgent, { amount: toStroops("1.00"), seq: 0 });
record("control: legitimate execute_payment settles", !!legit.getTransactionResponse, "seq 0 consumed, 1.00 spent");

// 1. rogue signer calls execute_payment on someone else's mandate
await attempt(
  "rogue key cannot execute_payment on another agent's mandate",
  () => sendPayment(asRogue, { amount: toStroops("0.10"), seq: 1 }),
  /auth|Auth|#|require/i,
);

// 2. replay: rightful agent re-submits an already-consumed sequence
await attempt(
  "replayed sequence rejected even for the rightful agent (BadSequence #8)",
  () => sendPayment(asAgent, { amount: toStroops("0.10"), seq: 0 }),
  /#8|BadSequence|sequence/i,
);

// 3. overspend via raw i128 (skipping every SDK-side amount check)
await attempt(
  "raw i128 overspend rejected on-chain (BudgetExceeded #6)",
  () => sendPayment(asAgent, { amount: toStroops("5.00"), seq: 1 }),
  /#6|Budget/i,
);

// 4. zero / negative raw amounts (InvalidAmount #9)
await attempt(
  "raw zero amount rejected on-chain (InvalidAmount #9)",
  () => sendPayment(asAgent, { amount: 0n, seq: 1 }),
  /#9|Invalid/i,
);
await attempt(
  "raw negative amount rejected on-chain (InvalidAmount #9)",
  () => sendPayment(asAgent, { amount: -10_000_000n, seq: 1 }),
  /#9|Invalid|negative/i,
);

// 5. merchant scope: validate_mandate preflight with a rogue payee.
//    (execute_payment itself takes NO merchant arg — it uses the stored one, so
//    scope is structurally enforced; validate_mandate is the read-only preflight.)
//    The typed client returns a Result; a rejected merchant is Result.isErr()===true.
{
  const good = await asAgent.validate_mandate({ mandate_id: mandate.idBuffer, amount: toStroops("0.10"), merchant: merchant.publicKey() });
  const bad = await asAgent.validate_mandate({ mandate_id: mandate.idBuffer, amount: toStroops("0.10"), merchant: rogue.publicKey() });
  const goodOk = good.result?.isOk?.() === true || good.result?.isErr?.() === false;
  const badRejected = bad.result?.isErr?.() === true;
  record("validate_mandate ACCEPTS the correct merchant", goodOk, `isErr=${good.result?.isErr?.()}`);
  record("rogue payee rejected by merchant scope (validate_mandate Result.isErr)", badRejected, `isErr=${bad.result?.isErr?.()}`);
}

// 6. custody boundary: agent tries the native SAC transfer_from(user -> rogue)
//    directly, as spender. The allowance was approved for the CONTRACT, never
//    the agent, so simulation must fail. Built on raw @stellar/stellar-sdk so no
//    REAPP code mediates the attempt.
await attempt(
  "agent cannot transfer_from the user directly — allowance belongs to the contract",
  async () => {
    const server = new rpc.Server(TESTNET.rpcUrl ?? "https://soroban-testnet.stellar.org");
    const src = await server.getAccount(agent.publicKey());
    const sac = new Contract(reapp.testnet.nativeSac);
    const tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: TESTNET.networkPassphrase })
      .addOperation(sac.call(
        "transfer_from",
        nativeToScVal(new Address(agent.publicKey()), { type: "address" }),
        nativeToScVal(new Address(user.publicKey()), { type: "address" }),
        nativeToScVal(new Address(rogue.publicKey()), { type: "address" }),
        nativeToScVal(toStroops("0.50"), { type: "i128" }),
      ))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
    // If simulation somehow succeeded, the boundary is breached.
  },
  /allowance|Insufficient|#|auth|Error/i,
);

// 7. state unchanged after all attacks: only the control payment consumed budget
const readback = await asAgent.get_mandate({ mandate_id: mandate.idBuffer });
const m = readback.result?.unwrap ? readback.result.unwrap() : readback.result;
record("post-attack state intact: spent == 1.00, seq == 1", m.spent === toStroops("1.00") && m.seq === 1, `spent=${m.spent} seq=${m.seq}`);

console.log(`\nA3 SUMMARY: ${results.filter(r => r.ok).length}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
