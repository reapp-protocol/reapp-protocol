/**
 * `reapp demo research-agent` — the "aha" walkthrough.
 *
 * Self-contained and runs cold: spins up three ephemeral testnet accounts,
 * registers a real on-chain mandate, then has the agent buy research sources one
 * by one — each a real `execute_payment`. The mandate budget covers three; the
 * contract rejects the fourth. The point is the on-chain enforcement, so there's
 * no LLM dependency: the payments are real, the "research" framing is scripted.
 *
 * Reliability: instead of arbitrary sleeps, we poll for the state we just wrote
 * (account funded, mandate seq advanced) so a slow testnet doesn't cause a stale
 * read (the C2 BadSequence race). The contract is the source of truth throughout.
 */
import { SettlementUncertainError, reapp, type Agent } from "@reapp-sdk/core";
import { TESTNET, registryClient, keypairSigner, token } from "@reapp-sdk/stellar";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { log, c, banner } from "../ui.js";
import {
  acknowledgeCompletedSettlement,
  assertNoPendingSettlement,
  claimPendingSettlement,
  clearPendingSettlement,
  markSettlementCompleted,
} from "../settlement-store.js";
import { isFinalPaymentRejection } from "../payment-failure.js";

const SOURCES = [
  { name: "Market Data API", icon: "📈" },
  { name: "Academic Papers", icon: "📚" },
  { name: "News Archive", icon: "📰" },
  { name: "Patent Database", icon: "⚗️" },
  { name: "Analyst Reports", icon: "🏦" },
];
const SOURCE_PRICE = "1.00";
const BUDGET = "3.00"; // three sources fit; the contract blocks the fourth

const short = (s: string) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fund an account and confirm it on the soroban RPC (the same source the
 *  contract calls use). Friendbot can rate-limit or drop a request, so retry the
 *  friendbot hit if the account hasn't appeared, and throw loudly if it never
 *  does rather than letting a later call fail with a confusing "not found". */
async function fund(pub: string): Promise<void> {
  const server = new rpc.Server(TESTNET.rpcUrl);
  for (let round = 0; round < 4; round += 1) {
    await fetch(`https://friendbot.stellar.org/?addr=${pub}`).catch(() => undefined);
    for (let i = 0; i < 8; i += 1) {
      try {
        await server.getAccount(pub);
        return;
      } catch {
        // not visible on the RPC yet — keep polling before re-friendbotting
      }
      await sleep(1000);
    }
  }
  throw new Error(`friendbot could not fund ${pub} after several attempts`);
}

/** Poll the contract until the mandate's seq reaches `target` (write propagated). */
async function waitForSeq(
  client: ReturnType<typeof registryClient>,
  idBuffer: Buffer,
  target: number,
  tries = 20,
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const md = (await client.get_mandate({ mandate_id: idBuffer })).result.unwrap();
      if (Number(md.seq) >= target) return;
    } catch {
      // transient read error — keep polling
    }
    await sleep(1000);
  }
  throw new Error(`mandate sequence did not reach ${target} before the testnet read deadline`);
}

type Attempt = { kind: "ok"; hash: string } | { kind: "blocked" } | { kind: "retry" } | { kind: "error"; msg: string } | { kind: "uncertain"; msg: string };

async function attemptPurchase(agent: Agent): Promise<Attempt> {
  let preparedHash: string | undefined;
  try {
    const hash = await agent.pay(SOURCE_PRICE, {
      onPrepared: async (pending) => {
        await claimPendingSettlement("demo", TESTNET.mandateRegistryId, pending);
        preparedHash = pending.txHash;
      },
    });
    await markSettlementCompleted(hash);
    return { kind: "ok", hash };
  } catch (e) {
    if (e instanceof SettlementUncertainError) {
      return {
        kind: "uncertain",
        msg: `transaction ${e.settlement.txHash} is unresolved; run reapp settlement reconcile`,
      };
    }
    if (isFinalPaymentRejection(e) && preparedHash) {
      try {
        await clearPendingSettlement(preparedHash);
      } catch (clearError) {
        return {
          kind: "uncertain",
          msg: `journal clear failed: ${clearError instanceof Error ? clearError.message : String(clearError)}`,
        };
      }
    }
    if (preparedHash && !isFinalPaymentRejection(e)) {
      return {
        kind: "uncertain",
        msg: `transaction ${preparedHash} has an unknown post-prepare result; run reapp settlement reconcile`,
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    const code = (msg.match(/Error\(Contract,\s*#(\d+)\)/) ?? [])[1];
    if (code === "6") return { kind: "blocked" }; // BudgetExceeded — the aha
    if (code === "8") return { kind: "retry" }; // BadSequence — stale read, wait & retry
    return { kind: "error", msg: (msg.split("\n")[0] ?? msg).slice(0, 90) };
  }
}

export async function runDemo(target = "research-agent"): Promise<void> {
  if (target !== "research-agent") {
    log.warn(`unknown demo "${target}"`);
    log.info("available demos", { run: "reapp demo research-agent" });
    return;
  }

  try {
    await assertNoPendingSettlement();
  } catch (error) {
    log.err("demo blocked by unresolved payment journal", {
      reason: error instanceof Error ? error.message : String(error),
    });
    log.info("run `reapp settlement reconcile` before starting another demo");
    process.exitCode = 1;
    return;
  }

  console.log("\n" + banner() + "\n");
  log.info("research agent demo — the agent pays on-chain per source; the contract caps the budget");

  const user = Keypair.random();
  const agent = Keypair.random();
  const merchant = Keypair.random();
  log.step("funding 3 ephemeral testnet accounts via friendbot");
  await Promise.all([fund(user.publicKey()), fund(agent.publicKey()), fund(merchant.publicKey())]);
  log.chain("accounts funded", {
    user: short(user.publicKey()),
    agent: short(agent.publicKey()),
    merchant: short(merchant.publicKey()),
  });
  const merchantBefore = await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey());

  const inputs = {
    user: user.publicKey(),
    agent: agent.publicKey(),
    merchant: merchant.publicKey(),
    asset: reapp.testnet.nativeSac,
    maxAmount: BUDGET,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    nonce: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
  };
  const mandate = reapp.createIntentMandate(inputs);
  await reapp.registerMandate(mandate, { signer: user.secret() });
  await reapp.approveBudget(mandate, { signer: user.secret() });
  log.chain("mandate registered + allowance approved for contract", { budget: `${BUDGET} XLM`, id: short(mandate.id) });

  const rclient = registryClient(TESTNET, keypairSigner(agent, TESTNET.networkPassphrase));
  const paymentAgent = reapp.agent({ mandate, signer: agent });

  let purchased = 0;
  let seq = 0;
  let budgetBlocked = false;
  outer: for (const s of SOURCES) {
    log.step(`agent buys ${s.icon} ${s.name}`, { price: `${SOURCE_PRICE} XLM` });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const r = await attemptPurchase(paymentAgent);
      if (r.kind === "ok") {
        seq += 1;
        await waitForSeq(rclient, mandate.idBuffer, seq);
        purchased += 1;
        log.ok("purchased on-chain", { tx: short(r.hash) });
        // The demo has accepted and rendered this exact result. Only now may its
        // completed journal be acknowledged so the next source can be prepared.
        await acknowledgeCompletedSettlement(r.hash);
        break;
      }
      if (r.kind === "blocked") {
        budgetBlocked = true;
        log.warn(`contract blocked the purchase — ${BUDGET} XLM budget exhausted`);
        break outer;
      }
      if (r.kind === "retry") {
        await waitForSeq(rclient, mandate.idBuffer, seq);
        continue;
      }
      if (r.kind === "uncertain") {
        throw new Error(`${r.msg}. Do not restart the demo until reconciliation completes.`);
      }
      log.err("purchase failed", { reason: r.msg });
      break outer;
    }
  }

  const finalMandate = (await rclient.get_mandate({ mandate_id: mandate.idBuffer })).result.unwrap();
  const merchantAfter = await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey());
  const transferred = merchantAfter - merchantBefore;
  const passed =
    purchased === 3
    && budgetBlocked
    && finalMandate.spent === 30_000_000n
    && Number(finalMandate.seq) === 3
    && transferred === 30_000_000n;

  console.log(
    "\n" +
      c.bold("Result") +
      "\n" +
      c.gray("  purchased  ") + c.white(`${purchased} sources`) + c.gray("  for ") + c.white(`${purchased}.00 XLM`) + c.gray(" settled on-chain") +
      "\n" +
      c.gray("  enforced   ") + c.white(`${BUDGET} XLM`) + c.gray(` budget cap — ${budgetBlocked ? "the contract rejected purchase four" : "expected rejection was not observed"}`) +
      "\n" +
      c.gray("  verified   ") + c.white(`${Number(finalMandate.seq)} payments`) + c.gray(` · ${(Number(transferred) / 1e7).toFixed(2)} XLM merchant delta`) +
      "\n" +
      c.gray("  the agent answers from what it could afford; a compromised agent or SDK cannot exceed the mandate.") +
      "\n",
  );

  if (!passed) {
    throw new Error(
      `demo evidence mismatch: purchased=${purchased}, blocked=${budgetBlocked}, seq=${Number(finalMandate.seq)}, spent=${finalMandate.spent}, transferred=${transferred}`,
    );
  }
}
