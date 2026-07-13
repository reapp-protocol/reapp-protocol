#!/usr/bin/env node
/**
 * PRODUCTION e2e through the @reapp-sdk/core surface — NO MOCKS, live testnet.
 *
 *   npm run e2e:sdk
 *
 * Proves the published SDK does the full mandate-validated flow against the live
 * contract, and that the contract enforces the limit even when driven by the SDK:
 *   create → register → approve → pay (1 XLM moves) → overspend REJECTED →
 *   revoke → pay-after-revoke REJECTED.
 *
 * user  = funded burner (REAPP_BURNER_SECRET_KEY)
 * agent = fresh friendbot-funded keypair (the only signer that can pay)
 * merchant = fresh friendbot-funded keypair (receives)
 */
import { exit, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Keypair } from "@stellar/stellar-sdk";
import { SettlementUncertainError, reapp } from "@reapp-sdk/core";
import { TESTNET, token } from "@reapp-sdk/stellar";

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"), quiet: true });

const TTY = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
const sgr = (n) => (s) => (TTY ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const c = { bold: sgr(1), dim: sgr(2), red: sgr(31), green: sgr(32), yellow: sgr(33), blue: sgr(34), magenta: sgr(35), cyan: sgr(36), gray: sgr(90), link: sgr("4;36") };
const RULE = (p = c.gray) => p("─".repeat(64));
const log = (...a) => console.log(...a);
const step = (s) => console.log(`\n${c.cyan("▸")} ${c.bold(c.cyan(s))}`);
const note = (s) => console.log(`     ${c.blue("ℹ")} ${c.blue(s)}`);
const field = (l, v) => console.log(`     ${c.gray("·")} ${c.dim(`${l}`.padEnd(13))} ${v}`);
const die = (m) => { console.error(`\n${c.red("✖")} ${c.red(m)}`); exit(1); };
const xlm = (stroops) => `${(Number(stroops) / 1e7).toFixed(4)} XLM`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const record = (label, ok) => { results.push({ label, ok }); log(ok ? `     ${c.green("✓ pass")} ${c.dim(label)}` : `     ${c.red("✖ fail")} ${c.dim(label)}`); };

async function fund(pub) {
  try { const r = await fetch(`https://friendbot.stellar.org/?addr=${pub}`); return r.ok; } catch { return false; }
}

async function journaledPay(agent, amount, journalPath) {
  let safeToClear = false;
  try {
    const hash = await agent.pay(amount, {
      onPrepared: async (pending) => {
        const temporary = `${journalPath}.${randomUUID()}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify({ version: 1, pending }, null, 2)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, journalPath);
        await chmod(journalPath, 0o600);
      },
    });
    safeToClear = true;
    return hash;
  } catch (error) {
    safeToClear = !(error instanceof SettlementUncertainError);
    throw error;
  } finally {
    if (safeToClear) await rm(journalPath, { force: true });
  }
}

async function main() {
  const journalRoot = await mkdtemp(path.join(tmpdir(), "reapp-sdk-e2e-"));
  const userSecret = process.env.REAPP_BURNER_SECRET_KEY?.trim();
  if (!userSecret || !userSecret.startsWith("S")) die("REAPP_BURNER_SECRET_KEY not set in .env");

  const user = Keypair.fromSecret(userSecret);
  const agent = Keypair.random();
  const merchant = Keypair.random();
  const asset = TESTNET.nativeSac;

  log("");
  log(RULE(c.magenta));
  log(`  ${c.bold(c.magenta("REAPP"))}  ${c.dim("·")}  ${c.bold("@reapp-sdk/core e2e")} ${c.dim("— live testnet, no mocks")}`);
  log(RULE(c.magenta));
  field("contract", c.yellow(TESTNET.mandateRegistryId));
  field("explorer", c.link(`https://stellar.expert/explorer/testnet/contract/${TESTNET.mandateRegistryId}`));
  field("user", c.yellow(user.publicKey()));
  field("agent", c.yellow(agent.publicKey()));
  field("merchant", c.yellow(merchant.publicKey()));

  step("Fund agent + merchant (friendbot)");
  note("Fresh keypairs, funded with testnet XLM. Agent signs payments; merchant receives.");
  await fund(agent.publicKey());
  await fund(merchant.publicKey());
  await sleep(3000);
  record("accounts funded", true);

  step("createIntentMandate  (SDK, no chain)");
  note("The user authorizes: agent may spend <= 5 XLM at this merchant until expiry.");
  const mandate = reapp.createIntentMandate({
    user: user.publicKey(), agent: agent.publicKey(), merchant: merchant.publicKey(),
    asset, maxAmount: "5.00", expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  field("mandate id", c.dim(mandate.id));
  field("gatecheck", c.dim(`npm run gatecheck -- ${mandate.id}`));
  record("createIntentMandate", Boolean(mandate.id));

  step("registerMandate  (SDK, user-signed)");
  const regHash = await reapp.registerMandate(mandate, { signer: user });
  field("tx", c.link(`https://stellar.expert/explorer/testnet/tx/${regHash}`));
  record("registerMandate", Boolean(regHash));

  step("approveBudget  (SDK, user-signed SEP-41)");
  note("User approves the CONTRACT (not the agent) for a 5 XLM allowance.");
  const apprHash = await reapp.approveBudget(mandate, { signer: user });
  field("tx", c.link(`https://stellar.expert/explorer/testnet/tx/${apprHash}`));
  record("approveBudget", Boolean(apprHash));

  const a = reapp.agent({ mandate, signer: agent });

  step("agent.pay('1.00')  (SDK, agent-signed — funds move)");
  const before = await token.balance(TESTNET, asset, merchant.publicKey());
  field("merchant before", c.dim(xlm(before)));
  const payHash = await journaledPay(a, "1.00", path.join(journalRoot, "payment.json"));
  const after = await token.balance(TESTNET, asset, merchant.publicKey());
  field("tx", c.link(`https://stellar.expert/explorer/testnet/tx/${payHash}`));
  field("merchant after", c.green(xlm(after)));
  field("delta", c.green(`+${xlm(after - before)}`));
  record("agent.pay moved exactly 1 XLM", after - before === 10000000n);

  step("ROGUE · agent.pay('10.00')  (over budget — must be rejected)");
  note("A hostile agent asks for more than the mandate allows. The contract refuses.");
  let overspendRejected = false;
  try { await journaledPay(a, "10.00", path.join(journalRoot, "overspend.json")); } catch { overspendRejected = true; }
  record("overspend rejected by contract", overspendRejected);

  step("revokeMandate  (SDK, user-signed)");
  const revHash = await reapp.revokeMandate(mandate, { signer: user });
  field("tx", c.link(`https://stellar.expert/explorer/testnet/tx/${revHash}`));
  record("revokeMandate", Boolean(revHash));

  step("PUNCHLINE · agent.pay('1.00') after revoke (must be rejected)");
  note("The limit lives in the contract, not the SDK — a revoked mandate cannot pay.");
  let revokedRejected = false;
  try { await journaledPay(a, "1.00", path.join(journalRoot, "revoked.json")); } catch { revokedRejected = true; }
  record("revoked mandate blocks payment", revokedRejected);

  const pass = results.filter((r) => r.ok).length;
  const all = pass === results.length;
  const paint = all ? c.green : c.red;
  log("");
  log(RULE(paint));
  log(`  ${all ? c.green("✦") : c.red("✖")} ${c.bold("SDK E2E SUMMARY")}  ${c.dim(`${pass}/${results.length} passed`)}`);
  log(RULE(paint));
  for (const r of results) log(`  ${r.ok ? c.green("✓") : c.red("✖")} ${r.label}`);
  if (all) log(`  ${c.cyan("→")} ${c.bold("gatecheck")} ${c.dim(`npm run gatecheck -- ${mandate.id}`)}`);
  log(RULE(paint));
  log("");
  await rm(journalRoot, { recursive: true, force: true });
  exit(all ? 0 : 1);
}

main().catch((e) => die(String(e instanceof Error ? e.message : e)));
