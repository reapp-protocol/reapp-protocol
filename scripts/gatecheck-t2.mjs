#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = "/tmp/reapp-t2-npm-cache";

const packages = [
  ["packages/stellar", "@reapp-sdk/stellar", "0.2.2"],
  ["packages/sdk", "@reapp-sdk/core", "0.3.1"],
  ["packages/ap2", "@reapp-sdk/ap2", "0.3.0"],
  ["packages/express-middleware", "@reapp-sdk/express-middleware", "0.2.2"],
  ["packages/cli", "reapp-protocol-cli", "0.1.5"],
];

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, npm_config_cache: CACHE },
  });
  if (result.error || result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with ${result.status ?? "an execution error"}`);
  }
  return result.stdout;
}

function main() {
let packRoot;
try {
console.log("T2 gate check 1/4: clean contract and workspace verification");
run(process.execPath, ["scripts/verify.mjs"]);
run("npm", ["run", "cli:bundle"]);

console.log("T2 gate check 2/4: public package manifests and tarball contents");
packRoot = mkdtempSync(path.join(tmpdir(), "reapp-t2-pack-"));
const tarballs = new Map();
for (const [directory, expectedName, expectedVersion] of packages) {
  const packageRoot = path.join(ROOT, directory);
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
    fail(`${directory} is ${manifest.name}@${manifest.version}, expected ${expectedName}@${expectedVersion}`);
  }
  for (const scriptName of ["preinstall", "install", "postinstall"]) {
    if (manifest.scripts?.[scriptName]) fail(`${expectedName} contains forbidden ${scriptName} script`);
  }
  const packed = JSON.parse(run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], packageRoot));
  const entry = packed[0];
  if (!entry || entry.name !== expectedName || entry.version !== expectedVersion) {
    fail(`${expectedName} dry-run pack metadata did not match its manifest`);
  }
  const names = new Set((entry.files ?? []).map((file) => file.path));
  for (const required of ["package.json", "README.md"]) {
    if (!names.has(required)) fail(`${expectedName} tarball is missing ${required}`);
  }
  if (expectedName === "reapp-protocol-cli") {
    if (manifest.bin?.reapp !== "dist/reapp-cli.bundle.mjs") {
      fail("reapp-protocol-cli bin does not point at dist/reapp-cli.bundle.mjs");
    }
    if (!names.has("dist/reapp-cli.bundle.mjs")) {
      fail("reapp-protocol-cli tarball is missing its executable bundle");
    }
  } else {
    for (const required of ["dist/index.js", "dist/index.d.ts"]) {
      if (!names.has(required)) fail(`${expectedName} tarball is missing ${required}`);
    }
  }
  for (const name of names) {
    if (
      name.startsWith("src/")
      || name.startsWith("test/")
      || name.includes(".env")
      || /(?:^|\/)(?:secrets?|credentials)(?:\.|$)/i.test(name)
    ) {
      fail(`${expectedName} tarball unexpectedly contains ${name}`);
    }
  }
  const actual = JSON.parse(run("npm", [
    "pack", "--json", "--ignore-scripts", "--pack-destination", packRoot,
  ], packageRoot))[0];
  if (!actual?.filename) fail(`${expectedName} did not produce a real tarball`);
  tarballs.set(expectedName, path.join(packRoot, actual.filename));
  console.log(`  verified ${expectedName}@${expectedVersion} (${entry.entryCount} files)`);
}

console.log("T2 gate check 3/4: clean install, strict TypeScript, runtime imports, and CLI bin");
  const installRoot = path.join(packRoot, "clean-install");
  mkdirSync(installRoot);
  const dependencies = Object.fromEntries(
    [...tarballs].map(([name, tarball]) => [name, `file:${tarball}`]),
  );
  Object.assign(dependencies, {
    express: "^5.2.1",
    "@types/express": "^5.0.6",
    typescript: "^5.7.2",
  });
  writeFileSync(path.join(installRoot, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies,
  }, null, 2));
  run("npm", ["install", "--ignore-scripts", ["--no-", "au", "dit"].join(""), "--no-fund"], installRoot);
  writeFileSync(path.join(installRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    include: ["clean-install.ts"],
  }, null, 2));
  writeFileSync(path.join(installRoot, "clean-install.ts"), `
import { reapp, DeliveryPendingError } from "@reapp-sdk/core";
import { TESTNET } from "@reapp-sdk/stellar";
import { createAp2ComplianceValidator, InMemoryAp2ReplayStore } from "@reapp-sdk/ap2";
import { createBoundReappPaidJsonRoute, InMemoryBoundRedemptionStore } from "@reapp-sdk/express-middleware";

void [reapp, DeliveryPendingError, TESTNET];
const validator = createAp2ComplianceValidator({
  replayStore: new InMemoryAp2ReplayStore(),
  replayNamespace: "clean-install",
});
const route = createBoundReappPaidJsonRoute({
  merchant: "GCREL554SPELMSCEIQQVYS2TPDWONZ6AVQXMUNBEGGZ2X5FNYHDC2RZG",
  amount: "1.00",
  audience: "https://merchant.example",
  challengeSecret: "clean-install-secret-that-is-at-least-thirty-two-bytes",
  redemptionStore: new InMemoryBoundRedemptionStore(),
}, async () => ({ body: { ok: true } }));
void [validator, route];
`);
  writeFileSync(path.join(installRoot, "runtime.mjs"), `
await Promise.all([
  import("@reapp-sdk/core"), import("@reapp-sdk/stellar"),
  import("@reapp-sdk/ap2"), import("@reapp-sdk/express-middleware"),
]);
console.log("runtime imports passed");
`);
  run(path.join(installRoot, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], installRoot);
  run(process.execPath, ["runtime.mjs"], installRoot);
  const cliVersion = run(path.join(installRoot, "node_modules", ".bin", "reapp"), ["--version"], installRoot).trim();
  if (cliVersion !== "0.1.5") fail(`clean-installed CLI reported ${JSON.stringify(cliVersion)}`);
  console.log("  clean install, strict types, ESM imports, and CLI executable passed");

console.log("T2 gate check 4/4: public terminology and private-file boundary");
const tracked = run("git", ["ls-files", "--cached", "--others", "--exclude-standard"])
  .split("\n")
  .filter(Boolean)
  .filter((file) => existsSync(path.join(ROOT, file)));
for (const forbidden of ["REAPP_PROGRESS_LOG.md", "CONTRACT_UPGRADE_PLAYBOOK.md"]) {
  if (tracked.some((file) => path.basename(file) === forbidden)) {
    fail(`private file ${forbidden} is tracked in the public repository`);
  }
  const ignoredCopies = run("git", [
    "ls-files", "--others", "--ignored", "--exclude-standard", "--",
    forbidden, `:(glob)**/${forbidden}`,
  ]).split("\n").filter(Boolean);
  if (ignoredCopies.length > 0) {
    fail(`private file ${forbidden} exists inside the public repository, including ignored paths`);
  }
}
const publicText = tracked.filter((file) => /\.md$/i.test(file));
for (const file of publicText) {
  const body = readFileSync(path.join(ROOT, file), "utf8");
  if (/\bau(?:dit)[a-z-]*\b/i.test(body)) {
    fail(`${file} contains prohibited T1 review terminology; use gate check`);
  }
  if (/BulletproofBar|novel[ -]lens/i.test(body)) {
    fail(`${file} contains internal review terminology`);
  }
}

console.log("\nT2 gate check passed");
} finally {
  if (packRoot) rmSync(packRoot, { recursive: true, force: true });
}
}

try {
  main();
} catch (error) {
  console.error(`\nT2 gate check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
