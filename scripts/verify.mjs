#!/usr/bin/env node
/**
 * Local CI-equivalent gate. Run before every push (also wired as a git
 * pre-push hook) so no commit that would fail CI ever reaches the remote.
 *
 *   npm run verify
 *
 * Mirrors .github/workflows/ci.yml (plus clippy and a CLEAN workspace build,
 * since CI runs from a fresh checkout where each package's dist is absent).
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = path.join(ROOT, "contracts", "mandate-registry");
const CARGO_BIN = path.join(os.homedir(), ".cargo", "bin");
const ENV = { ...process.env, PATH: `${CARGO_BIN}:/opt/homebrew/bin:${process.env.PATH ?? ""}` };

function run(label, cmd, args, cwd) {
  process.stdout.write(`\n▶ ${label}\n`);
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", env: ENV });
  if (res.error || res.status !== 0) {
    console.error(`\n✖ verify failed at: ${label}`);
    process.exit(1);
  }
}

// Contract (mirrors CI's Rust job + clippy)
run("rustfmt --check", "cargo", ["fmt", "--all", "--", "--check"], CONTRACT);
run("clippy (deny warnings)", "cargo", ["clippy", "--all-targets", "--", "-D", "warnings"], CONTRACT);
run("cargo test", "cargo", ["test"], CONTRACT);

// Workspaces (mirrors CI's TypeScript job — from a CLEAN build)
rmSync(path.join(ROOT, "packages/sdk/dist"), { recursive: true, force: true });
rmSync(path.join(ROOT, "packages/stellar/dist"), { recursive: true, force: true });
rmSync(path.join(ROOT, "packages/ap2/dist"), { recursive: true, force: true });
run("npm run build (clean)", "npm", ["run", "build"], ROOT);
run("npm test", "npm", ["test"], ROOT);

console.log("\n✓ verify passed — safe to push");
