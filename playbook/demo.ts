/**
 * The REAPP "aha" demo (§9) — runs the full on-chain end-to-end against testnet:
 * the happy path (user authorizes → agent pays → 1 XLM moves) followed by the
 * rogue-agent rejections the CONTRACT enforces, not the SDK:
 *
 *   overspend → BudgetExceeded   ·   replay → BadSequence   ·   revoked → MandateRevoked
 *
 * The lesson: the SDK is untrusted; the limit lives in the contract; a hostile
 * agent changes nothing.
 *
 * This is a thin wrapper so `npm run demo` runs the canonical on-chain script
 * (scripts/e2e-testnet.mjs). All logic + verbose narration lives there.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const e2e = path.resolve(here, "..", "scripts", "e2e-testnet.mjs");

const res = spawnSync("node", [e2e, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(res.status ?? 1);
