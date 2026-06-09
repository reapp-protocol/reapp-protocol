/**
 * Shared script bootstrap: loads .env and gives every script the same verbose,
 * masked-env logging. Importing this module loads .env as a side effect.
 *
 * Masking rules:
 *   - MNEMONIC / SEED / PHRASE  -> word count only, value never shown.
 *   - SECRET / PRIVATE / KEY / TOKEN / PASSWORD -> first 4 … last 4.
 *   - everything else (urls, public keys, network) -> shown in full.
 *
 * VERBOSE defaults ON; set VERBOSE=0 in .env to quiet the `debug()` stream.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Resolve .env from the repo root (../../ from scripts/lib/), NOT from the
// process cwd — so scripts work no matter where they're invoked.
const ENV_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env");
const RESULT = dotenv.config({ path: ENV_PATH });

export const VERBOSE = process.env.VERBOSE !== "0";

if (VERBOSE) {
  if (RESULT.error) {
    console.log(`  · dotenv: FAILED to load ${ENV_PATH} — ${RESULT.error.message}`);
  } else {
    const keys = Object.keys(RESULT.parsed ?? {});
    console.log(`  · dotenv: loaded ${ENV_PATH}`);
    console.log(`  · dotenv: parsed keys -> ${keys.length ? keys.join(", ") : "(none)"}`);
  }
}

/** Always printed. */
export function log(...args: unknown[]): void {
  console.log(...args);
}

/** Printed only when VERBOSE (the default). Prefixed so it's scannable. */
export function debug(...args: unknown[]): void {
  if (VERBOSE) console.log("  ·", ...args);
}

/** A labelled step header. */
export function step(title: string): void {
  console.log(`\n▶ ${title}`);
}

const SENSITIVE = /SECRET|PRIVATE|PASSWORD|TOKEN|(^|_)KEY($|_)/i;
// NB: must NOT match NETWORK_PASSPHRASE (public value) — so no bare "PHRASE".
const PHRASE = /MNEMONIC|SEED/i;

export function mask(key: string, value: string): string {
  if (PHRASE.test(key)) {
    const words = value.trim().split(/\s+/).filter(Boolean).length;
    return `•••••••••• (${words} words)`;
  }
  if (!SENSITIVE.test(key)) return value;
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** The full set of env vars REAPP scripts read. */
export const ENV_KEYS = [
  "STELLAR_NETWORK",
  "SOROBAN_RPC_URL",
  "NETWORK_PASSPHRASE",
  "REAPP_BURNER_PUBLIC_KEY",
  "REAPP_BURNER_SECRET_KEY",
  "MANDATE_REGISTRY_CONTRACT_ID",
  "USDC_SAC_CONTRACT_ID",
] as const;

/** Print a masked banner of the environment a script is running with. */
export function printEnvBanner(scriptName: string, keys: readonly string[] = ENV_KEYS): void {
  log(`\n=== ${scriptName} :: environment (masked) ===`);
  for (const key of keys) {
    const value = process.env[key];
    log(`  ${key.padEnd(28)} = ${value ? mask(key, value) : "(unset)"}`);
  }
  log(`  ${"VERBOSE".padEnd(28)} = ${VERBOSE ? "on" : "off"}`);
  log("=".repeat(48));
}
