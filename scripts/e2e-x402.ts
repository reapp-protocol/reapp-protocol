#!/usr/bin/env tsx
/**
 * LIVE x402 round-trip end-to-end — NO MOCKS, Stellar testnet.
 *
 *   npm run agents:testnet
 *
 * Proves the x402 release path: Agent.fetch(url) receives a 402, settles the
 * payment on-chain through the SDK, and receives the resource — and that the
 * contract still enforces the budget through the HTTP layer.
 *
 * Scenario (the reproducible ResearchAgent): a user signs a 3 XLM mandate; the
 * agent buys 1-XLM "sources" from a real 402-gated merchant via agent.fetch.
 * Three settle; the fourth is REJECTED on-chain (budget exhausted) and the agent
 * gets no resource. Every actor is a fresh friendbot-funded testnet key — zero
 * setup, fully reproducible.
 */
import { exit } from "node:process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import {
  BOUND_PAYMENT_CAPABILITY,
  REAPP_PAYMENT_CAPABILITIES_HEADER,
  X_PAYMENT_HEADER,
  createBoundPaymentProof,
  encodePaymentProof,
  parse402,
  reapp,
} from "@reapp-sdk/core";
import { TESTNET, token } from "@reapp-sdk/stellar";
import { startServer } from "../apps/fulfillment-agent/src/server.ts";
import { FileBoundRedemptionStore } from "../apps/fulfillment-agent/src/redemption-store.ts";
import { buyResearch } from "../apps/consumer-agent/src/research-agent.ts";
import { FileSettlementReceiptStore } from "../apps/consumer-agent/src/receipt-store.ts";
import { FilePurchaseOutcomeStore } from "../apps/consumer-agent/src/outcome-store.ts";

const TTY = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const sgr = (n: number | string) => (s: unknown) => (TTY ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const c = { bold: sgr(1), dim: sgr(2), red: sgr(31), green: sgr(32), yellow: sgr(33), magenta: sgr(35), cyan: sgr(36), gray: sgr(90), link: sgr("4;36") };
const RULE = (p = c.gray) => p("─".repeat(64));
const log = (...a: unknown[]) => console.log(...a);
const field = (l: string, v: unknown) => log(`     ${c.gray("·")} ${c.dim(l.padEnd(13))} ${v}`);
const tx = (h: string) => c.link(`https://stellar.expert/explorer/testnet/tx/${h}`);
const die = (m: string) => { console.error(`\n${c.red("✖")} ${c.red(m)}`); exit(1); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const xlm = (stroops: bigint) => `${(Number(stroops) / 1e7).toFixed(2)} XLM`;

async function fund(pub: string): Promise<void> {
  let lastError = "friendbot request did not complete";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(`https://friendbot.stellar.org/?addr=${pub}`);
      if (response.ok) return;
      lastError = `friendbot returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(attempt * 1_000);
  }
  throw new Error(`could not fund ${pub}: ${lastError}`);
}

const BUDGET = "3.00";   // 3 sources, then the contract blocks the 4th
const SOURCES = ["market", "academic", "news", "patents"];

async function main() {
  const user = Keypair.random();
  const agent = Keypair.random();
  const merchant = Keypair.random();
  const asset = TESTNET.nativeSac;

  log("");
  log(RULE(c.magenta));
  log(`  ${c.bold(c.magenta("REAPP"))}  ${c.dim("·")}  ${c.bold("x402 round-trip e2e")} ${c.dim("— live testnet, no mocks")}`);
  log(RULE(c.magenta));
  field("contract", c.yellow(TESTNET.mandateRegistryId));
  field("user", c.yellow(user.publicKey()));
  field("agent", c.yellow(agent.publicKey()));
  field("merchant", c.yellow(merchant.publicKey()));

  log(`\n${c.cyan("▸")} ${c.bold("Fund actors (friendbot)")}`);
  await Promise.all([fund(user.publicKey()), fund(agent.publicKey()), fund(merchant.publicKey())]);
  await sleep(3000);
  log(`     ${c.green("✓")} funded`);

  log(`\n${c.cyan("▸")} ${c.bold("User signs a 3 XLM mandate (register + approve)")}`);
  const mandate = reapp.createIntentMandate({
    user: user.publicKey(), agent: agent.publicKey(), merchant: merchant.publicKey(),
    asset, maxAmount: BUDGET, expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  const reg = await reapp.registerMandate(mandate, { signer: user.secret() });
  const appr = await reapp.approveBudget(mandate, { signer: user.secret() });
  field("mandate", c.dim(mandate.id));
  field("register", tx(reg));
  field("approve", tx(appr));

  const receiptRoot = await mkdtemp(join(tmpdir(), "reapp-e2e-receipts-"));
  const receiptStore = new FileSettlementReceiptStore(join(receiptRoot, "pending.json"));
  const outcomeStore = new FilePurchaseOutcomeStore(join(receiptRoot, "outcomes.json"));
  const redemptionStore = new FileBoundRedemptionStore(join(receiptRoot, "redemptions.json"));

  log(`\n${c.cyan("▸")} ${c.bold("Start the 402-gated merchant")}`);
  const { server, url } = await startServer({
    merchant: merchant.publicKey(),
    redemptionStore,
    port: 0,
  });
  field("merchant API", c.link(url));
  field("price", "1.00 XLM / source");
  const merchBefore = await token.balance(TESTNET, asset, merchant.publicKey()).catch(() => 0n);

  log(`\n${c.cyan("▸")} ${c.bold("ResearchAgent buys sources via agent.fetch(url)")}`);
  log(`     ${c.dim("budget covers 3; the contract blocks the 4th")}\n`);

  const results = await buyResearch({
    serverUrl: url,
    sourceIds: SOURCES,
    mandate,
    agentSecret: agent.secret(),
    receiptStore,
    outcomeStore,
    onEvent: (e) => {
      if (e.type === "buying") log(`  ${c.cyan("→")} GET /source/${e.id}  ${c.dim("(402 Payment Required, pay 1 XLM)")}`);
      if (e.type === "paid") log(`     ${c.green("✓ paid + unlocked")}  ${tx(e.txHash!)}`);
      if (e.type === "blocked") log(`     ${c.red("✖ blocked on-chain:")} ${c.red(e.reason ?? "")}`);
    },
  });

  log(`\n${c.cyan("▸")} ${c.bold("Adversarial replay: re-sign the first tx for a fresh resource")}`);
  const replayQuote = await fetch(`${url}/source/expert`, {
    headers: { [REAPP_PAYMENT_CAPABILITIES_HEADER]: BOUND_PAYMENT_CAPABILITY },
  });
  const replayRequirement = await parse402(replayQuote);
  if (!replayRequirement.challenge || !results[0]?.receipt) {
    throw new Error("bound replay drill lacked a challenge or retained receipt");
  }
  const conflictingProof = createBoundPaymentProof({
    challenge: replayRequirement.challenge,
    txHash: results[0].receipt.txHash,
    mandateId: results[0].receipt.mandateId,
    signer: agent,
  });
  const replayAttack = await fetch(`${url}/source/expert`, {
    headers: {
      [REAPP_PAYMENT_CAPABILITIES_HEADER]: BOUND_PAYMENT_CAPABILITY,
      [X_PAYMENT_HEADER]: encodePaymentProof(conflictingProof),
    },
  });
  field("old-tx/new-proof", replayAttack.status === 409 ? c.green("409 blocked") : c.red(replayAttack.status));

  const merchAfter = await token.balance(TESTNET, asset, merchant.publicKey()).catch(() => 0n);
  const earned = merchAfter - merchBefore;
  const paid = results.filter((r) => r.ok);
  const blocked = results.filter((r) => !r.ok);
  const pendingReceipts = await receiptStore.listPending();

  log(`\n${RULE(c.magenta)}`);
  log(`  ${c.bold("Resources received")} ${c.dim(`(${paid.length}/${SOURCES.length})`)}`);
  for (const r of paid) log(`  ${c.green("•")} ${c.bold(r.name)}: ${c.dim(r.data ?? "")}`);
  for (const r of blocked) log(`  ${c.red("•")} ${r.id}: ${c.red("locked —")} ${c.dim(r.blockedReason ?? "")}`);
  log(RULE(c.magenta));
  field("merchant earned", c.green(xlm(earned)) + c.dim(" (paid by the user, through the contract)"));

  // The requirement: 3 paid+received, the 4th blocked by the contract, exactly
  // 3 XLM moved to the merchant (asserted as a delta, robust to friendbot funding).
  const pass =
    paid.length === 3 &&
    blocked.length === 1 &&
    blocked[0]?.blockedReason === "budget exceeded" &&
    paid.every((result) => result.deliveryState === "delivered" && result.receipt?.proofVersion === 2) &&
    pendingReceipts.length === 0 &&
    replayAttack.status === 409 &&
    earned === 30000000n;

  log("");
  log(RULE(pass ? c.green : c.red));
  log(`  ${pass ? c.green("✦") : c.red("✖")} ${c.bold("x402 E2E")}  ${c.dim(pass ? "round-trip works; budget enforced through the HTTP layer" : "FAILED")}`);
  log(RULE(pass ? c.green : c.red));
  log("");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(receiptRoot, { recursive: true, force: true });
  exit(pass ? 0 : 1);
}

main().catch((e) => die(String(e instanceof Error ? e.message : e)));
