#!/usr/bin/env node
/**
 * reapp gatecheck — independent, on-chain checker for a REAPP mandate.
 *
 *   node scripts/gatecheck-mandate.mjs <mandate-id-hex> [--source <PUBKEY>] [--json]
 *   npm run gatecheck -- <mandate-id-hex>
 *
 * The whole point of REAPP is that the spending limit lives in the contract, not
 * the app or the SDK. This tool proves that from the outside: it reads the mandate
 * straight from the MandateRegistry (the source of truth), plus the on-chain
 * SEP-41 allowance the user approved for the contract and the user's balance, and
 * reports the TRUE amount the agent can still spend — derived purely from chain
 * state, trusting no application claim.
 *
 * The mandate read goes through the published @reapp-sdk/stellar surface; nothing
 * here trusts a cached or app-reported value.
 */
import { exit, argv, stdout } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import dotenv from "dotenv";
import {
  Address,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
} from "@stellar/stellar-sdk";
import { TESTNET, registryClient, token, Errors } from "@reapp-sdk/stellar";

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"),
  quiet: true,
});

const TTY = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
const sgr = (n) => (s) => (TTY ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const c = {
  bold: sgr(1), dim: sgr(2), red: sgr(31), green: sgr(32), yellow: sgr(33),
  blue: sgr(34), magenta: sgr(35), cyan: sgr(36), gray: sgr(90), link: sgr("4;36"),
};
const RULE = (p = c.gray) => p("─".repeat(64));
const die = (m) => { console.error(`\n${c.red("✖")} ${c.red(m)}\n`); exit(1); };
const xlm = (stroops) => `${(Number(stroops) / 1e7).toFixed(7).replace(/0+$/, "").replace(/\.$/, ".0")} (${stroops} stroops)`;

function parseArgs(args) {
  const out = { json: false, source: process.env.REAPP_BURNER_PUBLIC_KEY?.trim() || "", id: "" };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--json") out.json = true;
    else if (a === "--source") { out.source = args[i + 1]; i += 1; }
    else if (!a.startsWith("-") && !out.id) out.id = a;
  }
  return out;
}

/** A read-only "signer": a real, funded source account for simulation. get_mandate
 *  and the SEP-41 reads never sign, so signTransaction is never invoked. */
function readOnlySigner(publicKey) {
  const refuse = async () => { throw new Error("gatecheck is read-only; it never signs or sends"); };
  return { publicKey, keypair: null, signTransaction: refuse, signAuthEntry: refuse };
}

/** SEP-41 allowance(from, spender) -> i128, read by simulation (no signing). */
async function allowance(net, tokenId, from, spender, source) {
  const server = new rpc.Server(net.rpcUrl, { allowHttp: net.rpcUrl.startsWith("http://") });
  const acct = await server.getAccount(source);
  const op = new Contract(tokenId).call(
    "allowance",
    new Address(from).toScVal(),
    new Address(spender).toScVal(),
  );
  const tx = new TransactionBuilder(acct, { fee: "100000", networkPassphrase: net.networkPassphrase })
    .addOperation(op)
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`allowance sim failed: ${sim.error}`);
  return scValToNative(sim.result.retval);
}

async function main() {
  const { id, source, json } = parseArgs(argv.slice(2));
  const net = TESTNET;

  if (!id) die("usage: node scripts/gatecheck-mandate.mjs <mandate-id-hex> [--source <PUBKEY>] [--json]");
  if (!/^[0-9a-fA-F]{64}$/.test(id)) die(`mandate id must be 64 hex chars (a 32-byte sha256); got ${JSON.stringify(id)}`);
  if (!source || !source.startsWith("G")) die("need a funded testnet source account for the read: pass --source <PUBKEY> or set REAPP_BURNER_PUBLIC_KEY in .env");

  const mandateId = Buffer.from(id, "hex");
  const registry = registryClient(net, readOnlySigner(source));

  let m;
  try {
    m = (await registry.get_mandate({ mandate_id: mandateId })).result.unwrap();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/#2\b/.test(msg) || /NotFound/i.test(msg)) {
      die(`no mandate ${id} on ${net.mandateRegistryId} — ${Errors[2].message}`);
    }
    die(`failed to read mandate from the contract: ${msg}`);
  }

  const status = m.status.tag; // Active | Revoked | Exhausted
  const max = BigInt(m.max_amount);
  const spent = BigInt(m.spent);
  const remaining = max - spent;
  const expiry = Number(m.expiry);
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = nowSec >= expiry;

  // Independent on-chain ceilings the agent is actually bounded by.
  let allow = null;
  let userBal = null;
  try { allow = BigInt(await allowance(net, m.asset, m.user, net.mandateRegistryId, source)); } catch { /* asset may not be a SAC we can read */ }
  try { userBal = BigInt(await token.balance(net, m.asset, m.user)); } catch { /* ignore */ }

  // The numeric headroom across the three independent on-chain limits.
  const ceilings = [remaining];
  if (allow !== null) ceilings.push(allow);
  if (userBal !== null) ceilings.push(userBal);
  const numericCeiling = ceilings.reduce((a, b) => (b < a ? b : a));

  const blockers = [];
  if (status === "Revoked") blockers.push("mandate is REVOKED");
  if (status === "Exhausted") blockers.push("mandate is EXHAUSTED (budget fully spent)");
  if (expired) blockers.push(`mandate EXPIRED at ${new Date(expiry * 1000).toISOString()}`);
  if (remaining <= 0n) blockers.push("no budget remaining");
  if (allow !== null && allow <= 0n) blockers.push("no SEP-41 allowance to the contract");
  if (userBal !== null && userBal <= 0n) blockers.push("user has no balance of the asset");
  const spendable = blockers.length === 0;
  // The honest answer: a revoked/expired/exhausted mandate can move nothing,
  // even if budget and allowance remain. The contract is the gate.
  const canMoveNow = spendable ? numericCeiling : 0n;

  if (json) {
    console.log(JSON.stringify({
      network: "testnet",
      contract: net.mandateRegistryId,
      mandateId: id,
      status, user: m.user, agent: m.agent, merchant: m.merchant, asset: m.asset,
      maxAmount: max.toString(), spent: spent.toString(), remaining: remaining.toString(),
      seq: Number(m.seq), expiry, expired,
      allowanceToContract: allow === null ? null : allow.toString(),
      userBalance: userBal === null ? null : userBal.toString(),
      numericCeiling: numericCeiling.toString(),
      canMoveNow: canMoveNow.toString(),
      spendable, blockers,
    }, null, 2));
    exit(spendable ? 0 : 0); // a read is a successful read regardless of spendability
    return;
  }

  const statusColor = status === "Active" ? c.green : status === "Exhausted" ? c.yellow : c.red;
  console.log("");
  console.log(RULE(c.magenta));
  console.log(`  ${c.bold(c.magenta("REAPP"))}  ${c.dim("·")}  ${c.bold("mandate gatecheck")} ${c.dim("— read straight from the contract, no app trust")}`);
  console.log(RULE(c.magenta));
  const f = (l, v) => console.log(`  ${c.gray("·")} ${c.dim(`${l}`.padEnd(18))} ${v}`);
  f("network", "testnet");
  f("contract", c.yellow(net.mandateRegistryId));
  f("explorer", c.link(`https://stellar.expert/explorer/testnet/contract/${net.mandateRegistryId}`));
  f("mandate id", c.dim(id));
  console.log(RULE());
  f("status", statusColor(status));
  f("user", m.user);
  f("agent", m.agent);
  f("merchant", m.merchant);
  f("asset", m.asset);
  console.log(RULE());
  f("budget (max)", xlm(max));
  f("spent", xlm(spent));
  f("remaining", (remaining > 0n ? c.green : c.red)(xlm(remaining)));
  f("payments (seq)", String(Number(m.seq)));
  f("expiry", `${new Date(expiry * 1000).toISOString()} ${expired ? c.red("(EXPIRED)") : c.green("(valid)")}`);
  console.log(RULE());
  f("allowance → contract", allow === null ? c.dim("unreadable for this asset") : (allow > 0n ? c.green : c.red)(xlm(allow)));
  f("user balance", userBal === null ? c.dim("unreadable for this asset") : xlm(userBal));
  f("agent can move now", c.bold((canMoveNow > 0n ? c.green : c.red)(xlm(canMoveNow))));
  console.log(c.dim(`  ${" ".repeat(20)} 0 if revoked/expired/exhausted; else min(remaining, allowance, balance) — from chain state alone`));
  console.log(RULE());
  if (spendable) {
    console.log(`  ${c.green("✦")} ${c.bold(c.green("SPENDABLE"))}, up to ${c.bold(xlm(canMoveNow))} to ${c.dim(m.merchant)}`);
  } else {
    console.log(`  ${c.red("✖")} ${c.bold(c.red("NOT SPENDABLE"))}`);
    for (const b of blockers) console.log(`     ${c.red("·")} ${b}`);
  }
  console.log(RULE(c.magenta));
  console.log("");
  exit(0);
}

main().catch((e) => die(String(e instanceof Error ? e.message : e)));
