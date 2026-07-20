#!/usr/bin/env node
/**
 * Build + deploy MandateRegistry to Stellar testnet, verbosely.
 *
 *   npm run deploy:testnet
 *
 * - Resolves .env from the repo root (cwd-proof).
 * - Verifies the `stellar` CLI and `cargo` are installed.
 * - Builds the contract to WASM (`stellar contract build`).
 * - Reads the deployer SECRET from REAPP_BURNER_SECRET_KEY, or prompts for it
 *   at runtime (hidden input) — never stored, never echoed.
 * - Deploys, captures the contract ID, writes it back to .env, and prints the
 *   stellar.expert link.
 *
 * The deployer account must be funded with testnet XLM.
 * (Set NO_COLOR=1 to disable colored output.)
 */
import { stdin, stdout, exit } from "node:process";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Ensure child processes can find cargo (rustup installs to ~/.cargo/bin),
// which isn't always on PATH when launched via npm.
const CARGO_BIN = path.join(os.homedir(), ".cargo", "bin");
const CHILD_ENV = { ...process.env, PATH: `${CARGO_BIN}${path.delimiter}${process.env.PATH ?? ""}` };

const ENV_PATH = path.join(ROOT, ".env");
const MANIFEST = path.join(ROOT, "contracts", "mandate-registry", "Cargo.toml");
const CONTRACT_DIR = path.join(ROOT, "contracts", "mandate-registry");
const EXPLORER = "https://stellar.expert/explorer/testnet/contract/";

const loaded = dotenv.config({ path: ENV_PATH, quiet: true });

// ── colors ───────────────────────────────────────────────────────────────--
const TTY = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
const sgr = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: sgr(1),
  dim: sgr(2),
  red: sgr(31),
  green: sgr(32),
  yellow: sgr(33),
  blue: sgr(34),
  magenta: sgr(35),
  cyan: sgr(36),
  gray: sgr(90),
  link: sgr("4;36"), // underlined cyan
};
const RULE = (paint = c.gray) => paint("─".repeat(62));

// Normalize the stellar CLI's explorer links to stellar.expert (testnet).
const explorerize = (s) =>
  String(s)
    .replaceAll("https://testnet.stellarchain.io/tx/", "https://stellar.expert/explorer/testnet/tx/")
    .replaceAll("https://testnet.stellarchain.io/contracts/", "https://stellar.expert/explorer/testnet/contract/")
    .replaceAll("https://testnet.stellarchain.io/accounts/", "https://stellar.expert/explorer/testnet/account/")
    .replaceAll("https://lab.stellar.org/r/testnet/contract/", "https://stellar.expert/explorer/testnet/contract/");

// ── logging ────────────────────────────────────────────────────────────────
const startedAt = Date.now();
const log = (...a) => console.log(...a);
const debug = (label, value) =>
  console.log(
    value === undefined
      ? `   ${c.gray("·")} ${c.dim(label)}`
      : `   ${c.gray("·")} ${c.dim(`${label}`.padEnd(11))} ${value}`,
  );
const ok = (label) => console.log(`   ${c.green("✓")} ${c.dim(label)}`);
const step = (s) => console.log(`\n${c.cyan("▸")} ${c.bold(c.cyan(s))}`);
const cmd = (line) => console.log(`   ${c.gray("$")} ${c.dim(line)}`);
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

function die(msg) {
  console.error(`\n${c.red("✖")} ${c.red(msg)}`);
  exit(1);
}

// ── command runners ──────────────────────────────────────────────────────--
// Live, inherited stdio. `display` overrides the printed args so secrets hide.
function run(bin, args, display) {
  cmd(`${bin} ${(display ?? args).join(" ")}`);
  const res = spawnSync(bin, args, { cwd: ROOT, stdio: "inherit", env: CHILD_ENV });
  if (res.error) die(`failed to spawn ${bin}: ${res.error.message}`);
  if (res.status !== 0) die(`${bin} exited with code ${res.status}`);
}

// Capture stdout (still echoes), masking secrets in the printed command.
function capture(bin, args, display) {
  cmd(`${bin} ${(display ?? args).join(" ")}`);
  const res = spawnSync(bin, args, { cwd: ROOT, encoding: "utf8", env: CHILD_ENV });
  if (res.error) die(`failed to spawn ${bin}: ${res.error.message}`);
  if (res.stdout) stdout.write(explorerize(res.stdout));
  if (res.stderr) process.stderr.write(explorerize(res.stderr));
  if (res.status !== 0) die(`${bin} exited with code ${res.status}`);
  return `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
}

function has(bin) {
  const res = spawnSync(bin, ["--version"], { encoding: "utf8", env: CHILD_ENV });
  return !res.error && res.status === 0;
}

function findWasm(dir) {
  if (!existsSync(dir)) return null;
  let best = null;
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = path.join(d, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (entry.endsWith(".wasm") && p.includes(`${path.sep}release${path.sep}`)) {
        if (!best || statSync(best).mtimeMs < s.mtimeMs) best = p;
      }
    }
  };
  walk(dir);
  return best;
}

function askHidden(question) {
  return new Promise((resolve) => {
    stdout.write(question);
    let value = "";
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = () => {
      stdin.off("data", onData);
      if (stdin.setRawMode) stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stdout.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char.charCodeAt(0) === 3) {
          stdout.write("\nAborted.\n");
          exit(130);
        }
        if (char === "\r" || char === "\n") return done();
        if (char.charCodeAt(0) === 127) {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on("data", onData);
  });
}

const maskSecret = (s) => (s ? `${s.slice(0, 4)}${c.dim("…")}${s.slice(-4)}` : "(none)");

function writeContractIdToEnv(id) {
  let text = readFileSync(ENV_PATH, "utf8");
  const line = `MANDATE_REGISTRY_CONTRACT_ID=${id}`;
  if (/^MANDATE_REGISTRY_CONTRACT_ID=.*$/m.test(text)) {
    text = text.replace(/^MANDATE_REGISTRY_CONTRACT_ID=.*$/m, line);
  } else {
    text += `${text.endsWith("\n") ? "" : "\n"}${line}\n`;
  }
  writeFileSync(ENV_PATH, text);
}

// ── main ─────────────────────────────────────────────────────────────────--
async function main() {
  log("");
  log(RULE(c.magenta));
  log(`  ${c.bold(c.magenta("REAPP"))}  ${c.dim("·")}  ${c.bold("deploy MandateRegistry")} ${c.dim("→ Stellar testnet")}`);
  log(RULE(c.magenta));

  step("Environment");
  debug("repo root", c.dim(ROOT));
  debug("dotenv", loaded.error ? c.red(`FAILED (${loaded.error.message})`) : c.dim(ENV_PATH));
  const rpcUrl = process.env.SOROBAN_RPC_URL;
  const passphrase = process.env.NETWORK_PASSPHRASE;
  debug("rpc url", c.dim(rpcUrl || "(unset)"));
  debug("passphrase", c.dim(passphrase || "(unset)"));
  debug("deployer", c.yellow(process.env.REAPP_BURNER_PUBLIC_KEY || "(unset)"));
  if (!rpcUrl || !passphrase) die("SOROBAN_RPC_URL and NETWORK_PASSPHRASE must be set in .env");

  step("Toolchain check");
  if (!has("stellar")) die("`stellar` CLI not found. Install: brew install stellar-cli");
  ok("stellar CLI");
  if (!has("cargo")) die("`cargo` not found. Install Rust: https://rustup.rs");
  ok("cargo");

  step("Build contract → WASM");
  run("stellar", ["contract", "build", "--manifest-path", MANIFEST]);
  const wasm = findWasm(path.join(CONTRACT_DIR, "target")) ?? findWasm(path.join(ROOT, "target"));
  if (!wasm) die("build succeeded but no .wasm found under target/**/release/");
  ok(`wasm built (${(statSync(wasm).size / 1024).toFixed(1)} KiB)`);
  debug("path", c.dim(wasm));

  step("Deployer secret");
  let secret = process.env.REAPP_BURNER_SECRET_KEY?.trim();
  if (secret && secret.startsWith("S") && secret.length === 56) {
    debug("source", `${c.dim(".env →")} ${maskSecret(secret)}`);
  } else {
    secret = await askHidden(`   ${c.gray("?")} ${c.dim("Paste deployer SECRET key (S…, hidden): ")}`);
    if (!secret.startsWith("S") || secret.length !== 56) {
      die("That does not look like a Stellar secret key (expected S…, 56 chars).");
    }
    debug("source", `${c.dim("prompt →")} ${maskSecret(secret)}`);
  }

  step("Deploy");
  const args = [
    "contract",
    "deploy",
    "--wasm",
    wasm,
    "--source-account",
    secret,
    "--rpc-url",
    rpcUrl,
    "--network-passphrase",
    passphrase,
  ];
  const display = args.map((a) => (a === secret ? maskSecret(secret) : a));
  const out = capture("stellar", args, display);

  const ids = out.match(/C[A-Z2-7]{55}/g) ?? [];
  const contractId = ids[ids.length - 1];
  if (!contractId) die("deploy finished but no contract ID (C…) found in output.");

  writeContractIdToEnv(contractId);

  const link = `${EXPLORER}${contractId}`;
  log("");
  log(RULE(c.green));
  log(`  ${c.green("✦")} ${c.bold(c.green("DEPLOYED"))}  ${c.dim(`in ${elapsed()}`)}`);
  log(RULE(c.green));
  log(`  ${c.bold("Contract")}   ${c.yellow(contractId)}`);
  log(`  ${c.bold("Explorer")}   ${c.link(link)}`);
  log(`  ${c.bold("config")}     ${c.dim(".env updated; published SDK default unchanged")}`);
  log(RULE(c.green));
  log("");
}

main().catch((err) => die(String(err instanceof Error ? err.message : err)));
