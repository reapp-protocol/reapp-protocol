#!/usr/bin/env node
/**
 * Composite mandates on-chain end-to-end — testnet, no mocks.
 *
 *   npm run e2e:composites
 *
 * The scenario from the composite spec: a vendor posts a group-buy minimum
 * (9 units, 40.5 XLM net). Three independent buyers each sign the rule
 * "3 units at 5 XLM, or 1 at 10 XLM" as a pooled mandate and commit it to the
 * clearing pool. No single buyer meets the minimum; together they do. At the
 * deadline anyone closes the auction: the contract recomputes the unique
 * uniform clearing price (4.5 XLM — lower than any posted tier, the minimal
 * feasible price) and settles all three legs in ONE transaction.
 *
 * Also proves the negatives on live testnet: clearing before the deadline is
 * rejected (deadline auction — no timing option), and a second clear is
 * rejected (idempotent capture).
 *
 * Actors: originator (deployer wallet) posts the pool; 3 fresh buyer accounts;
 * a fresh merchant that only receives. Reads .env (cwd-proof). NO_COLOR=1
 * disables color.
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
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

// ── colors ─────────────────────────────────────────────────────────────────
const TTY = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
const sgr = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: sgr(1), dim: sgr(2), red: sgr(31), green: sgr(32), yellow: sgr(33),
  blue: sgr(34), magenta: sgr(35), cyan: sgr(36), gray: sgr(90), link: sgr("4;36"),
};
const RULE = (p = c.gray) => p("─".repeat(64));
const explorerize = (s) =>
  String(s)
    .replaceAll("https://testnet.stellarchain.io/tx/", "https://stellar.expert/explorer/testnet/tx/")
    .replaceAll("https://testnet.stellarchain.io/contracts/", "https://stellar.expert/explorer/testnet/contract/")
    .replaceAll("https://testnet.stellarchain.io/accounts/", "https://stellar.expert/explorer/testnet/account/")
    .replaceAll("https://lab.stellar.org/r/testnet/contract/", "https://stellar.expert/explorer/testnet/contract/");
const log = (...a) => console.log(...a);
const step = (s) => console.log(`\n${c.cyan("▸")} ${c.bold(c.cyan(s))}`);
const field = (l, v) => console.log(`     ${c.gray("·")} ${c.dim(`${l}`.padEnd(16))} ${v}`);
const cmdLine = (l) => console.log(`     ${c.gray("$")} ${c.dim(l)}`);
const note = (s) => console.log(`     ${c.blue("ℹ")} ${c.blue(s)}`);
const proves = (s) => console.log(`     ${c.green("✔ proves")} ${c.dim(s)}`);
const die = (m) => { console.error(`\n${c.red("✖")} ${c.red(m)}`); exit(1); };

// ── config ─────────────────────────────────────────────────────────────────
const CONTRACT = TESTNET.mandateRegistryId;
const RPC = process.env.SOROBAN_RPC_URL?.trim();
const PASS = process.env.NETWORK_PASSPHRASE?.trim();
const ORIGINATOR_SECRET = process.env.REAPP_BURNER_SECRET_KEY?.trim();
const ORIGINATOR = process.env.REAPP_BURNER_PUBLIC_KEY?.trim();
const NET = ["--rpc-url", RPC, "--network-passphrase", PASS];

if (!CONTRACT) die("MANDATE_REGISTRY_CONTRACT_ID not set (run npm run deploy:testnet first).");
if (!RPC || !PASS) die("SOROBAN_RPC_URL / NETWORK_PASSPHRASE not set.");
if (!ORIGINATOR_SECRET?.startsWith("S") || !ORIGINATOR) die("REAPP burner keys not set in .env.");

const maskSecret = (s) => `${s.slice(0, 4)}${c.dim("…")}${s.slice(-4)}`;
const num = (v) => Number(String(v).replace(/[^0-9-]/g, "") || "0");
const xlm = (v) => `${(num(v) / 1e7).toFixed(4)} XLM`;

// The composite-spec example, in stroops (7 decimals):
// each buyer: "3 units at 5 XLM each, OR 1 unit at 10 XLM".
const SCHEDULE = JSON.stringify([
  { unit_price: "50000000", max_qty: "3" },
  { unit_price: "100000000", max_qty: "1" },
]);
const CHILD_MAX = "200000000"; // 20 XLM signed budget ceiling (worst_case is 15)
const ALLOWANCE = "200000000";
// vendor minimum: 9 units AND 40.5 XLM net order value
const THRESHOLD_QTY = "9";
const THRESHOLD_VALUE = "405000000";
// expected clearing: p* = 45000000 (4.5 XLM), 3 units each, 13.5 XLM per buyer
const EXPECTED_LEG = 135000000;
const EXPECTED_TOTAL = 405000000;
// deadline auction: give registration+commits this long, then close. Generous
// because each CLI invoke is a fresh process + full testnet round trip; a slow
// ledger day must never push the buyer phase past the close.
const DEADLINE_SECS = 220;

// ── shell helpers (same house style as e2e-testnet.mjs) ─────────────────────
function sh(bin, args, { mask, quiet } = {}) {
  const shown = mask ? args.map((a) => (a === mask ? maskSecret(mask) : a)) : args;
  cmdLine(`${bin} ${shown.join(" ")}`);
  const res = spawnSync(bin, args, { cwd: ROOT, encoding: "utf8", env: ENV });
  const out = `${res.stdout ?? ""}`.trim();
  const err = `${res.stderr ?? ""}`.trim();
  const okExit = !res.error && res.status === 0;
  if (!quiet) {
    for (const l of err.split("\n").filter(Boolean)) log(`       ${(okExit ? c.dim : c.red)(explorerize(l))}`);
    if (out) log(`       ${c.dim(explorerize(out))}`);
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

function ensureAccount(name) {
  spawnSync("stellar", ["keys", "generate", name, "--network", "testnet", "--fund"], { env: ENV, encoding: "utf8" });
  return spawnSync("stellar", ["keys", "address", name], { env: ENV, encoding: "utf8" }).stdout.trim();
}

function invoke(source, name, args, { mask, quiet } = {}) {
  return sh(
    "stellar",
    ["contract", "invoke", "--id", CONTRACT, "--source-account", source, ...NET, "--", name, ...args],
    { mask, quiet },
  );
}

function sacInvoke(sac, source, name, args, mask) {
  return sh("stellar", ["contract", "invoke", "--id", sac, "--source-account", source, ...NET, "--", name, ...args], { mask, quiet: true });
}

const results = [];
const record = (label, okExit) => {
  results.push({ label, passed: okExit });
  log(okExit ? `     ${c.green("✓ pass")} ${c.dim(label)}` : `     ${c.red("✖ fail")} ${c.dim(label)}`);
  return okExit;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── run ──────────────────────────────────────────────────────────────────--
async function main() {
  log("");
  log(RULE(c.magenta));
  log(`  ${c.bold(c.magenta("REAPP"))}  ${c.dim("·")}  ${c.bold("composite mandates e2e")} ${c.dim("— testnet, no mocks")}`);
  log(RULE(c.magenta));
  log(`  ${c.dim("Three independent buyer agents clear ONE deal no single agent could")}`);
  log(`  ${c.dim("trigger alone. The clearing price is a pure on-chain function of the")}`);
  log(`  ${c.dim("committed schedules — the organizer provably cannot skim the spread.")}`);
  log("");
  field("contract", c.yellow(CONTRACT));
  field("explorer", c.link(`https://stellar.expert/explorer/testnet/contract/${CONTRACT}`));

  step("Accounts (friendbot-funded)");
  note("A fresh merchant plus three fresh, independent buyers.");
  const MERCHANT = ensureAccount("reapp-gb-merchant");
  const BUYERS = ["reapp-gb-buyer1", "reapp-gb-buyer2", "reapp-gb-buyer3"].map((n) => ({
    name: n,
    addr: ensureAccount(n),
  }));
  await Promise.all([friendbotFund(MERCHANT), ...BUYERS.map((b) => friendbotFund(b.addr))]);
  field("merchant", c.yellow(MERCHANT));
  BUYERS.forEach((b, i) => field(`buyer ${i + 1}`, c.yellow(b.addr)));

  step("Native SEP-41 token (XLM asset contract)");
  const sacRes = spawnSync("stellar", ["contract", "id", "asset", "--asset", "native", ...NET], { env: ENV, encoding: "utf8" });
  const SAC = (sacRes.stdout ?? "").trim().match(/C[A-Z2-7]{55}/)?.[0];
  if (!SAC) die("could not resolve native asset contract id.");
  field("asset (SAC)", c.yellow(SAC));

  step("1 · register_pool  (originator-signed — the LAST special signature)");
  note("The vendor minimum goes on-chain: 9 units AND 40.5 XLM order value,");
  note("with a hard close time. The pool id is sha256 of these exact terms, so");
  note("the terms cannot be swapped under the members.");
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECS;
  const nonce = randomBytes(32).toString("hex");
  field("threshold_qty", THRESHOLD_QTY);
  field("threshold_value", `${THRESHOLD_VALUE} ${c.dim(`(${xlm(THRESHOLD_VALUE)})`)}`);
  field("deadline", c.dim(`${deadline} (in ${DEADLINE_SECS}s — a real deadline auction)`));
  const reg = invoke(ORIGINATOR_SECRET, "register_pool", [
    "--originator", ORIGINATOR, "--merchant", MERCHANT, "--asset", SAC,
    "--kind", "ThresholdFloor", "--threshold_qty", THRESHOLD_QTY,
    "--threshold_value", THRESHOLD_VALUE, "--min_child_value", "0",
    "--clearing_deadline", String(deadline), "--nonce", nonce,
  ], { mask: ORIGINATOR_SECRET });
  const POOL_ID = reg.out.match(/[0-9a-f]{64}/)?.[0];
  record("register_pool", reg.okExit && Boolean(POOL_ID));
  if (!POOL_ID) die("no pool id in register_pool output");
  field("pool_id", c.yellow(POOL_ID));

  step("2 · each buyer signs + commits a child mandate");
  note('Each buyer\'s rule: "3 units at 5 XLM, or 1 at 10 XLM" — a monotone');
  note("demand schedule. The signature over (schedule, pool, budget, expiry) is");
  note("the buyer's ENTIRE authorization; no one signs anything at capture.");
  const expiry = String(deadline + 86400 + 3600); // > deadline + capture window
  const allowanceExpiry = String((await latestLedger()) + 17280 * 20); // ~20 days, inside max TTL
  const childIds = [];
  for (const [i, b] of BUYERS.entries()) {
    const vcHash = randomBytes(32).toString("hex");
    childIds.push(vcHash);
    // Option<BytesN<32>> is JSON-parsed by the CLI: the hex must be a JSON string.
    const r1 = invoke(b.name, "register_mandate", [
      "--user", b.addr, "--agent", b.addr, "--merchant", MERCHANT, "--asset", SAC,
      "--max_amount", CHILD_MAX, "--expiry", expiry, "--vc_hash", vcHash,
      "--pool_id", `"${POOL_ID}"`, "--price_schedule", SCHEDULE,
    ], { quiet: true });
    const r2 = sacInvoke(SAC, b.name, "approve", [
      "--from", b.addr, "--spender", CONTRACT, "--amount", ALLOWANCE, "--expiration_ledger", allowanceExpiry,
    ]);
    const r3 = invoke(ORIGINATOR_SECRET, "commit_child", ["--mandate_id", vcHash], { mask: ORIGINATOR_SECRET, quiet: true });
    const ok = r1.okExit && r2.okExit && r3.okExit;
    record(`buyer ${i + 1}: register + approve + commit`, ok);
    if (!ok) {
      for (const [step_, r] of [["register", r1], ["approve", r2], ["commit", r3]]) {
        if (!r.okExit) log(`       ${c.red(`${step_} failed:`)} ${c.dim((r.err || r.out).split("\n").slice(-3).join(" · "))}`);
      }
    }
  }

  step("3 · simulate_clear  (read-only — anyone can recompute the allocation)");
  note("The exact outcome capture will execute, computed from on-chain state.");
  proves("no discretion: simulate == capture, so the organizer can't skim.");
  const sim = invoke(ORIGINATOR_SECRET, "simulate_clear", ["--pool_id", POOL_ID], { mask: ORIGINATOR_SECRET });
  record("simulate_clear fires", sim.okExit && /"fires":\s*true/.test(sim.out));
  const simPrice = sim.out.match(/"clearing_price":\s*"?(\d+)"?/)?.[1];
  if (simPrice) field("clearing price", `${c.green(xlm(simPrice))} ${c.dim("per unit — below every posted tier")}`);

  step("ROGUE · clear before the deadline (feasible ≠ clearable)");
  note("The threshold is already met, but capture before the close would hand");
  note("whoever fires first a timing option. The contract refuses.");
  proves("deadline auction: p* is a function of the set at close, not of speed.");
  if (Math.floor(Date.now() / 1000) >= deadline - 10) {
    // A very slow testnet day consumed the whole pre-close budget; attempting
    // the "early" clear now would actually be a legitimate capture.
    die("buyer phase overran the auction close — raise DEADLINE_SECS and rerun");
  }
  {
    const r = invoke(ORIGINATOR_SECRET, "clear_pool", ["--pool_id", POOL_ID], { mask: ORIGINATOR_SECRET, quiet: true });
    record("pre-deadline clear rejected", !r.okExit && /DeadlineNotReached|Error\(Contract, #29\)/.test(r.err + r.out));
  }

  const waitMs = deadline * 1000 - Date.now() + 7000; // + ledger-close margin
  step(`4 · the auction closes  (waiting ${Math.ceil(waitMs / 1000)}s for the deadline)`);
  await sleep(Math.max(waitMs, 0));

  step("5 · clear_pool  (ANYONE-signed — the atomic capture)");
  note("One transaction: recompute the canonical allocation, then settle all");
  note("three legs. If any leg failed, every leg would revert — nobody pays.");
  const before = num(sacInvoke(SAC, ORIGINATOR_SECRET, "balance", ["--id", MERCHANT], ORIGINATOR_SECRET).out);
  const clr = invoke(ORIGINATOR_SECRET, "clear_pool", ["--pool_id", POOL_ID], { mask: ORIGINATOR_SECRET });
  const after = num(sacInvoke(SAC, ORIGINATOR_SECRET, "balance", ["--id", MERCHANT], ORIGINATOR_SECRET).out);
  field("merchant before", c.dim(xlm(before)));
  field("merchant after", c.green(xlm(after)));
  field("delta", c.green(`+${xlm(after - before)}  (expected +${xlm(EXPECTED_TOTAL)})`));
  record("clear_pool captured", clr.okExit && after - before === EXPECTED_TOTAL);
  proves("a purchase happened that NO single buyer could have triggered alone.");

  step("6 · per-buyer state: uniform price, Captured, budget consumed");
  let uniform = true;
  for (const [i, id] of childIds.entries()) {
    const m = invoke(ORIGINATOR_SECRET, "get_mandate", ["--mandate_id", id], { mask: ORIGINATOR_SECRET, quiet: true });
    const spent = m.out.match(/"spent":\s*"?(-?\d+)"?/)?.[1];
    const captured = /Captured/.test(m.out);
    field(`buyer ${i + 1} spent`, `${xlm(spent ?? 0)} ${c.dim("(expected 13.5000 XLM)")} ${captured ? c.green("Captured") : c.red("NOT CAPTURED")}`);
    uniform &&= num(spent) === EXPECTED_LEG && captured;
  }
  record("uniform price across all buyers", uniform);

  step("ROGUE · double clear (idempotent capture)");
  proves("a terminal pool rejects every re-clear: no double capture, ever.");
  {
    const r = invoke(ORIGINATOR_SECRET, "clear_pool", ["--pool_id", POOL_ID], { mask: ORIGINATOR_SECRET, quiet: true });
    record("double clear rejected", !r.okExit && /PoolNotOpen|Error\(Contract, #12\)/.test(r.err + r.out));
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
