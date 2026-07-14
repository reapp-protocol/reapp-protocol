// Runs the full adversarial suite sequentially and aggregates pass/fail.
// Each script self-funds ephemeral testnet actors via friendbot; no .env needed.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const scripts = [
  ["a1-lifecycle.mjs", "mandate lifecycle + on-chain negatives"],
  ["a2-x402-roundtrip.mjs", "bound-v2 x402 round-trip + replay defense"],
  ["a3-bypass-attempts.mjs", "malicious-SDK bypass attempts"],
  ["a4-ap2-adversarial.mjs", "AP2 credential tamper/forgery/replay"],
  ["a5-custody-and-landed-revert.mjs", "on-chain allowance custody proof"],
  ["a6-landed-revert-race.mjs", "landed-and-reverted negative transaction"],
];

function run(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(here, file)], { stdio: "inherit" });
    p.on("close", (code) => resolve(code ?? 1));
  });
}

let failed = 0;
for (const [file, desc] of scripts) {
  console.log(`\n============================================================`);
  console.log(`  ${file} — ${desc}`);
  console.log(`============================================================`);
  const code = await run(file);
  if (code !== 0) { failed++; console.log(`>>> ${file} FAILED (exit ${code})`); }
}

console.log(`\n============================================================`);
console.log(failed === 0
  ? `  ADVERSARIAL SUITE: all ${scripts.length} scripts passed`
  : `  ADVERSARIAL SUITE: ${failed}/${scripts.length} scripts FAILED`);
console.log(`============================================================`);
process.exit(failed ? 1 : 0);
