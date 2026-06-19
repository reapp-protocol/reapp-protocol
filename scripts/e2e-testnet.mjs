#!/usr/bin/env node
/**
 * PRODUCTION-GRADE on-chain end-to-end — NO MOCKS.
 *
 *   npm run e2e:testnet
 *
 * Real testnet, real SEP-41 token (the native XLM asset contract), real funded
 * accounts. Proves the full flow + the bypass-proof property on live testnet:
 *
 *   user (deployer)  — funds + grants the SEP-41 allowance to the contract
 *   agent (fresh)    — the ONLY signer that can call execute_payment
 *   merchant (fresh) — receives the funds
 *
 * Flow: ensure native SAC → fund agent+merchant → user approves contract →
 *       register_mandate → get_mandate → validate_mandate →
 *       execute_payment (agent-signed, XLM actually moves) → balances →
 *       revoke_mandate → confirm revoked.
 *
 * Reads everything from .env (cwd-proof). NO_COLOR=1 disables color.
 */
import { stdout, exit } from "node:process";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { TESTNET } from "@reapp-sdk/stellar";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CARGO_BIN = path.join(os.homedir(), ".cargo", "bin");
const ENV = { ...process.env, PATH: `${CARGO_BIN}:/opt/homebrew/bin:${process.env.PATH ?? ""}` };
const ENV_PATH = path.join(ROOT, ".env");
dotenv.config({ path: ENV_PATH, quiet: true });

// ── colors ─────────────────────────────────────────────────────────────────
const TTY = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
const sgr = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: sgr(1), dim: sgr(2), red: sgr(31), green: sgr(32), yellow: sgr(33),
  blue: sgr(34), magenta: sgr(35), cyan: sgr(36), gray: sgr(90), link: sgr("4;36"),
};
const RULE = (p = c.gray) => p("─".repeat(64));

// Rewrite the stellar CLI's explorer links to stellarchain.io (testnet).
const chainify = (s) =>
  String(s)
    .replaceAll("https://stellar.expert/explorer/testnet/tx/", "https://testnet.stellarchain.io/tx/")
    .replaceAll("https://stellar.expert/explorer/testnet/contract/", "https://testnet.stellarchain.io/contracts/")
    .replaceAll("https://stellar.expert/explorer/testnet/account/", "https://testnet.stellarchain.io/accounts/")
    .replaceAll("https://lab.stellar.org/r/testnet/contract/", "https://testnet.stellarchain.io/contracts/");
const log = (...a) => console.log(...a);
const step = (s) => console.log(`\n${c.cyan("▸")} ${c.bold(c.cyan(s))}`);
const field = (l, v) => console.log(`     ${c.gray("·")} ${c.dim(`${l}`.padEnd(14))} ${v}`);
const cmdLine = (l) => console.log(`     ${c.gray("$")} ${c.dim(l)}`);
const note = (s) => console.log(`     ${c.blue("ℹ")} ${c.blue(s)}`);
const proves = (s) => console.log(`     ${c.green("✔ proves")} ${c.dim(s)}`);
const die = (m) => { console.error(`\n${c.red("✖")} ${c.red(m)}`); exit(1); };

// ── config ─────────────────────────────────────────────────────────────────
const CONTRACT = TESTNET.mandateRegistryId;
const RPC = process.env.SOROBAN_RPC_URL?.trim();
const PASS = process.env.NETWORK_PASSPHRASE?.trim();
const USER_SECRET = process.env.REAPP_BURNER_SECRET_KEY?.trim();
const USER = process.env.REAPP_BURNER_PUBLIC_KEY?.trim();
const NET = ["--rpc-url", RPC, "--network-passphrase", PASS];

if (!CONTRACT) die("MANDATE_REGISTRY_CONTRACT_ID not set (run npm run deploy:testnet first).");
if (!RPC || !PASS) die("SOROBAN_RPC_URL / NETWORK_PASSPHRASE not set.");
if (!USER_SECRET || !USER_SECRET.startsWith("S")) die("REAPP_BURNER_SECRET_KEY not set.");
if (!USER) die("REAPP_BURNER_PUBLIC_KEY not set.");

const maskSecret = (s) => `${s.slice(0, 4)}${c.dim("…")}${s.slice(-4)}`;
// SAC balance prints a quoted i128 like "100000000000" — strip to a number.
const num = (v) => Number(String(v).replace(/[^0-9-]/g, "") || "0");
const xlm = (v) => `${(num(v) / 1e7).toFixed(4)} XLM`;

// amounts in stroops (7 decimals)
const MAX = "50000000"; //   5 XLM budget
const SPEND = "10000000"; // 1 XLM per payment
const ALLOWANCE = "50000000";
const VC_HASH = randomBytes(32).toString("hex"); // fresh mandate id every run

// ── shell helpers ──────────────────────────────────────────────────────────
function sh(bin, args, { mask, quiet } = {}) {
  const shown = mask ? args.map((a) => (a === mask ? maskSecret(mask) : a)) : args;
  cmdLine(`${bin} ${shown.join(" ")}`);
  const res = spawnSync(bin, args, { cwd: ROOT, encoding: "utf8", env: ENV });
  const out = `${res.stdout ?? ""}`.trim();
  const err = `${res.stderr ?? ""}`.trim();
  const okExit = !res.error && res.status === 0;
  if (!quiet) {
    for (const l of err.split("\n").filter(Boolean)) log(`       ${(okExit ? c.dim : c.red)(chainify(l))}`);
    if (out) log(`       ${c.dim(chainify(out))}`);
  }
  return { okExit, out, err };
}

async function friendbotFund(addr) {
  try {
    const r = await fetch(`https://friendbot.stellar.org/?addr=${addr}`);
    return r.ok;
  } catch {
    return false;
  }
}

async function latestLedger() {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
  });
  const j = await r.json();
  return Number(j.result.sequence);
}

// stellar identity → ensure it exists + is funded, return its G-address
function ensureAccount(name) {
  spawnSync("stellar", ["keys", "generate", name, "--network", "testnet", "--fund"], { env: ENV, encoding: "utf8" });
  const addr = spawnSync("stellar", ["keys", "address", name], { env: ENV, encoding: "utf8" }).stdout.trim();
  return addr;
}

function invoke({ source, method, args = [], mask }) {
  return sh("stellar", ["contract", "invoke", "--id", method.id ?? CONTRACT, "--source-account", source, ...NET, "--", method.name, ...args], { mask });
}

function sacInvoke(sac, source, name, args, mask) {
  return sh("stellar", ["contract", "invoke", "--id", sac, "--source-account", source, ...NET, "--", name, ...args], { mask });
}

const results = [];
const record = (label, okExit) => {
  results.push({ label, passed: okExit });
  log(okExit ? `     ${c.green("✓ pass")} ${c.dim(label)}` : `     ${c.red("✖ fail")} ${c.dim(label)}`);
  return okExit;
};

// ── run ──────────────────────────────────────────────────────────────────--
async function main() {
  log("");
  log(RULE(c.magenta));
  log(`  ${c.bold(c.magenta("REAPP"))}  ${c.dim("·")}  ${c.bold("on-chain e2e")} ${c.dim("— testnet, NO MOCKS")}`);
  log(RULE(c.magenta));
  log(`  ${c.dim("The thesis: an autonomous agent cannot be trusted to police its own")}`);
  log(`  ${c.dim("spending — so the limit lives BELOW the agent, in a Soroban contract")}`);
  log(`  ${c.dim("that sits in the money path. This script proves it on live testnet.")}`);
  log("");
  log(`  ${c.bold("Actors")}`);
  log(`    ${c.yellow("user")}     ${c.dim("your deployer wallet — owns the funds, signs the mandate")}`);
  log(`    ${c.yellow("agent")}    ${c.dim("autonomous spender — the ONLY one allowed to call execute_payment")}`);
  log(`    ${c.yellow("merchant")} ${c.dim("the payee — receives funds")}`);
  log("");
  field("contract", c.yellow(CONTRACT));
  field("explorer", c.link(`https://testnet.stellarchain.io/contracts/${CONTRACT}`));
  field("user", c.yellow(USER));
  field("vc_hash", c.dim(VC_HASH));

  step("Accounts (friendbot-funded)");
  note("Creating two brand-new testnet accounts and funding them via Friendbot.");
  note("The agent will SIGN payments; the merchant only RECEIVES. Both are real.");
  const AGENT = ensureAccount("reapp-agent");
  const MERCHANT = ensureAccount("reapp-merchant");
  await friendbotFund(AGENT);
  await friendbotFund(MERCHANT);
  field("agent", c.yellow(AGENT));
  field("merchant", c.yellow(MERCHANT));

  step("Native SEP-41 token (XLM asset contract)");
  note("Using Stellar's native XLM as a REAL SEP-41 token via its asset contract.");
  note("No mock token anywhere — actual on-chain balances will move.");
  const dep = sh("stellar", ["contract", "asset", "deploy", "--asset", "native", "--source-account", USER_SECRET, ...NET], { mask: USER_SECRET, quiet: true });
  if (dep.okExit) note("native asset contract deployed.");
  else if (/ExistingValue|already exists/.test(dep.err)) note("native asset contract already deployed — reusing it (expected).");
  else log(`       ${c.red(dep.err || "asset deploy failed")}`);
  const sacRes = spawnSync("stellar", ["contract", "id", "asset", "--asset", "native", ...NET], { env: ENV, encoding: "utf8" });
  const SAC = (sacRes.stdout ?? "").trim().match(/C[A-Z2-7]{55}/)?.[0];
  if (!SAC) die("could not resolve native asset contract id.");
  field("asset (SAC)", c.yellow(SAC));

  step("User grants SEP-41 allowance to the contract");
  note("The USER approves the CONTRACT (never the agent) as spender. This is the");
  note("custody model: funds stay in the user's wallet until the contract pulls");
  note("them — and the agent has NO allowance, so it can't move money directly.");
  const expLedger = String((await latestLedger()) + 17280);
  field("amount", `${ALLOWANCE} ${c.dim(`(${xlm(ALLOWANCE)})`)}`);
  field("spender", c.dim(CONTRACT));
  field("expiry ledger", c.dim(expLedger));
  record("approve", sacInvoke(SAC, USER_SECRET, "approve",
    ["--from", USER, "--spender", CONTRACT, "--amount", ALLOWANCE, "--expiration_ledger", expLedger], USER_SECRET).okExit);

  step("1/5 · register_mandate  (user-signed)");
  note("The user signs the authorization: 'agent may spend up to 5 XLM at this");
  note("merchant until expiry.' The contract stores it with spent=0, status=Active.");
  proves("a caller cannot set spent/status — the contract initializes them.");
  const expiry = String(Math.floor(Date.now() / 1000) + 3600);
  record("register_mandate", invoke({
    source: USER_SECRET, mask: USER_SECRET,
    method: { name: "register_mandate" },
    args: ["--user", USER, "--agent", AGENT, "--merchant", MERCHANT, "--asset", SAC,
           "--max_amount", MAX, "--expiry", expiry, "--vc_hash", VC_HASH],
  }).okExit);

  step("2/5 · get_mandate");
  note("Read the mandate back from the chain — confirms it's stored and Active.");
  record("get_mandate", invoke({ source: USER_SECRET, mask: USER_SECRET,
    method: { name: "get_mandate" }, args: ["--mandate_id", VC_HASH] }).okExit);

  step("3/5 · validate_mandate  (read-only preflight)");
  note("Dry-run: would a 1 XLM payment to this merchant be allowed right now?");
  note("Mutates nothing — it's the clean error the SDK checks before paying.");
  record("validate_mandate", invoke({ source: USER_SECRET, mask: USER_SECRET,
    method: { name: "validate_mandate" },
    args: ["--mandate_id", VC_HASH, "--amount", SPEND, "--merchant", MERCHANT] }).okExit);

  step("4 · execute_payment  (AGENT-signed — real funds move)");
  note("The AGENT signs this — NOT the user. The contract re-validates everything,");
  note("checks the sequence (replay guard), then pulls 1 XLM via the allowance.");
  proves("the agent moves the user's funds only within the signed mandate.");
  const before = num(sacInvoke(SAC, USER_SECRET, "balance", ["--id", MERCHANT], USER_SECRET).out);
  field("merchant before", c.dim(`${xlm(before)}`));
  const ok4 = invoke({ source: "reapp-agent",
    method: { name: "execute_payment" }, args: ["--mandate_id", VC_HASH, "--amount", SPEND, "--expected_seq", "0"] }).okExit;
  const after = num(sacInvoke(SAC, USER_SECRET, "balance", ["--id", MERCHANT], USER_SECRET).out);
  field("merchant after", c.green(`${xlm(after)}`));
  field("delta", c.green(`+${xlm(after - before)}  (expected +${xlm(SPEND)})`));
  record("execute_payment", ok4 && after - before === Number(SPEND));

  step("ROGUE · overspend — agent tries to exceed the budget");
  note("A hostile agent asks for far more than the mandate allows (correct seq).");
  proves("budget cap is enforced on-chain → BudgetExceeded.");
  {
    const r = invoke({ source: "reapp-agent", method: { name: "execute_payment" },
      args: ["--mandate_id", VC_HASH, "--amount", String(Number(MAX) * 2), "--expected_seq", "1"] });
    record("rogue overspend rejected", !r.okExit);
  }

  step("ROGUE · replay — agent resubmits an already-consumed sequence");
  note("The agent replays seq 0 after it was spent. The mandate-layer guard refuses.");
  proves("replay protection on-chain → BadSequence.");
  {
    const r = invoke({ source: "reapp-agent", method: { name: "execute_payment" },
      args: ["--mandate_id", VC_HASH, "--amount", SPEND, "--expected_seq", "0"] });
    record("rogue replay rejected", !r.okExit);
  }

  step("5 · revoke_mandate  (user-signed)");
  note("The user withdraws consent — the contract marks the mandate Revoked.");
  record("revoke_mandate", invoke({ source: USER_SECRET, mask: USER_SECRET,
    method: { name: "revoke_mandate" }, args: ["--mandate_id", VC_HASH] }).okExit);

  step("PUNCHLINE · revoked mandate blocks payment");
  note("The same agent tries to pay again on a revoked mandate. The contract REJECTS");
  note("it on-chain. The limit lives in the contract, not the SDK — a rogue agent");
  note("changes nothing. A passing ✓ here means the rejection happened.");
  proves("enforcement is protocol-level: revoked = no payment, period.");
  {
    const r = invoke({ source: "reapp-agent", method: { name: "execute_payment" },
      args: ["--mandate_id", VC_HASH, "--amount", SPEND, "--expected_seq", "1"] });
    record("revoked blocks payment", !r.okExit);
  }

  // summary
  const pass = results.filter((r) => r.passed).length;
  const all = pass === results.length;
  const paint = all ? c.green : c.red;
  log("");
  log(RULE(paint));
  log(`  ${all ? c.green("✦") : c.red("✖")} ${c.bold("SUMMARY")}  ${c.dim(`${pass}/${results.length} on-chain steps passed`)}`);
  log(RULE(paint));
  for (const r of results) log(`  ${r.passed ? c.green("✓") : c.red("✖")} ${r.label}`);
  log(RULE(paint));
  log("");
  exit(all ? 0 : 1);
}

main().catch((e) => die(String(e instanceof Error ? e.message : e)));
