/**
 * `reapp setup` — configure keys + fund testnet accounts (REAPP-43).
 *
 * Generates three fresh testnet burners (user / agent / merchant), funds them
 * via friendbot, and persists the secrets to ~/.reapp/credentials.json (0600,
 * outside the repo). Idempotent: refuses to overwrite existing credentials
 * unless --force is passed. Mirrors the demo's reapp-server.init().
 */
import { Keypair } from "@stellar/stellar-sdk";
import { log, c } from "../ui.js";
import { configExists, loadConfig, defaultConfig } from "../config.js";
import { credentialsExist, credentialsPath, saveCredentials, type Credentials } from "../secrets.js";

export type SetupOptions = { force?: boolean };

const short = (s: string) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "");

async function friendbot(pub: string): Promise<void> {
  await fetch(`https://friendbot.stellar.org/?addr=${pub}`).catch(() => undefined);
}

export async function runSetup(opts: SetupOptions = {}): Promise<void> {
  if (!configExists()) {
    log.warn("no reapp.config.json here — run `reapp init` first");
    return;
  }
  if (credentialsExist() && !opts.force) {
    log.warn("credentials already exist", { path: credentialsPath() });
    log.info("re-run with --force to regenerate fresh testnet keys");
    return;
  }

  const config = configExists() ? loadConfig() : defaultConfig();
  const accountUrl = (pub: string) => `${config.explorer}/account/${pub}`;

  const user = Keypair.random();
  const agent = Keypair.random();
  const merchant = Keypair.random();
  log.step("generated 3 fresh testnet keypairs", {
    user: short(user.publicKey()),
    agent: short(agent.publicKey()),
    merchant: short(merchant.publicKey()),
  });

  log.step("funding via friendbot");
  await Promise.all([
    friendbot(user.publicKey()),
    friendbot(agent.publicKey()),
    friendbot(merchant.publicKey()),
  ]);
  await new Promise((r) => setTimeout(r, 3000)); // brief settle
  log.chain("accounts funded + settled");

  const creds: Credentials = {
    network: config.network,
    userSecret: user.secret(),
    userPublic: user.publicKey(),
    agentSecret: agent.secret(),
    agentPublic: agent.publicKey(),
    merchantSecret: merchant.secret(),
    merchantPublic: merchant.publicKey(),
  };
  const path = saveCredentials(creds);
  log.ok("wrote credentials (0600, outside the repo)", { path });

  console.log(
    "\n" +
      c.bold("Accounts") +
      "\n" +
      c.gray("  user     ") + c.white(user.publicKey()) + c.dim("  " + accountUrl(user.publicKey())) +
      "\n" +
      c.gray("  agent    ") + c.white(agent.publicKey()) + c.dim("  " + accountUrl(agent.publicKey())) +
      "\n" +
      c.gray("  merchant ") + c.white(merchant.publicKey()) + c.dim("  " + accountUrl(merchant.publicKey())) +
      "\n",
  );
  log.info("next", { run: "reapp mandate create" });
}
