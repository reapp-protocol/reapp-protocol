#!/usr/bin/env node
import { stdin, stdout, exit } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import StellarHDWallet from "stellar-hd-wallet";

// Resolve .env from the repo root (one level up from scripts/), NOT from cwd —
// so it loads no matter where the command is launched.
const ENV_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
const loaded = dotenv.config({ path: ENV_PATH, quiet: true });

console.log(`dotenv: ${loaded.error ? `FAILED (${loaded.error.message})` : "loaded"} ${ENV_PATH}`);
if (!loaded.error) {
  const keys = Object.keys(loaded.parsed ?? {});
  console.log(`dotenv: parsed ${keys.length} keys -> ${keys.join(", ") || "(none)"}`);
  console.log(
    `dotenv: REAPP_BURNER_PUBLIC_KEY = ${process.env.REAPP_BURNER_PUBLIC_KEY || "(empty)"}`,
  );
}

const expectedPublicKey =
  process.argv.find((arg) => arg.startsWith("--public="))?.slice("--public=".length) ??
  process.env.REAPP_BURNER_PUBLIC_KEY ??
  "";

const scanCount = Number(
  process.argv.find((arg) => arg.startsWith("--scan="))?.slice("--scan=".length) ?? "20",
);

function mask(value) {
  if (!value) return "missing";
  return `${value.slice(0, 4)}...${value.slice(-4)} (${value.length} chars)`;
}

function askHidden(question) {
  return new Promise((resolve) => {
    stdout.write(question);

    let value = "";
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    function done() {
      stdin.off("data", onData);
      stdin.off("end", done);
      if (stdin.setRawMode) stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stdout.write("\n");
      resolve(value.trim().replace(/\s+/g, " "));
    }

    function onData(chunk) {
      for (const char of chunk) {
        if (char === "") {
          // Ctrl-C
          stdout.write("\nAborted.\n");
          exit(130);
        }

        if (char === "\r" || char === "\n") {
          done();
          return;
        }

        if (char === "") {
          // backspace / delete
          value = value.slice(0, -1);
          continue;
        }

        value += char;
      }
    }

    stdin.on("data", onData);
    stdin.on("end", done);
  });
}

console.log();
console.log("============================================================");
console.log("REAPP FREIGHTER SEED PHRASE -> STELLAR SECRET KEY");
console.log("============================================================");
console.log();
console.log("This runs locally and does not write your seed phrase anywhere.");
console.log("Expected public key:", mask(expectedPublicKey));
console.log(`Scanning account indexes: 0-${scanCount - 1}`);
console.log();

if (!expectedPublicKey) {
  console.error("Missing REAPP_BURNER_PUBLIC_KEY in .env or --public=G...");
  exit(1);
}

const mnemonic = await askHidden("Paste Freighter seed phrase (hidden input): ");

if (!StellarHDWallet.validateMnemonic(mnemonic)) {
  console.error("Invalid mnemonic. Check the words/order and try again.");
  exit(1);
}

const wallet = StellarHDWallet.fromMnemonic(mnemonic);
let match = null;

console.log();
console.log("Derived public keys:");
for (let index = 0; index < scanCount; index += 1) {
  const publicKey = wallet.getPublicKey(index);
  const isMatch = publicKey === expectedPublicKey;
  console.log(`  [${index}] ${mask(publicKey)}${isMatch ? "  MATCH" : ""}`);

  if (isMatch) {
    match = {
      index,
      publicKey,
      secretKey: wallet.getSecret(index),
    };
  }
}

console.log();

if (!match) {
  console.error("No matching account found.");
  console.error("Try a wider scan, for example: npm run keys:derive-freighter -- --scan=50");
  exit(1);
}

console.log("============================================================");
console.log("MATCH FOUND");
console.log("============================================================");
console.log(`Account index: ${match.index}`);
console.log(`Public key: ${match.publicKey}`);
console.log(`Secret key: ${match.secretKey}`);
console.log();
console.log("Put this in .env:");
console.log(`REAPP_BURNER_PUBLIC_KEY=${match.publicKey}`);
console.log(`REAPP_BURNER_SECRET_KEY=${match.secretKey}`);
console.log("============================================================");
console.log();
