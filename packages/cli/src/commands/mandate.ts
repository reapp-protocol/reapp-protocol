/**
 * `reapp mandate create` — register an AP2 IntentMandate on-chain (REAPP-44).
 *
 * Builds the mandate from the stored testnet keys, registers it, and approves the
 * SEP-41 allowance to the CONTRACT (never to the agent) — both user-signed.
 * Persists the inputs so `reapp pay` rebuilds the identical mandate id. Mirrors
 * the demo's reapp-server.setup(). The contract is the source of truth; this
 * tool is an untrusted client.
 */
import { reapp, type CreateIntentMandateInput } from "@reapp-sdk/core";
import { log, c } from "../ui.js";
import { configExists, loadConfig } from "../config.js";
import { credentialsExist, loadCredentials } from "../secrets.js";
import { mandateExists, saveMandate, type StoredMandate } from "../mandate-store.js";

export type MandateCreateOptions = { budget?: string; expiry?: string; force?: boolean };

const short = (s: string) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "");

export async function runMandateCreate(opts: MandateCreateOptions = {}): Promise<void> {
  if (!configExists()) {
    log.warn("no reapp.config.json here — run `reapp init` first");
    return;
  }
  if (!credentialsExist()) {
    log.warn("no credentials — run `reapp setup` first");
    return;
  }
  if (mandateExists() && !opts.force) {
    log.warn("a mandate already exists — re-run with --force to replace it");
    return;
  }

  const config = loadConfig();
  const creds = loadCredentials();
  const txUrl = (hash: string) => `${config.explorer}/tx/${hash}`;

  const budget = opts.budget ?? config.budget;
  const expirySecs = opts.expiry ? Number(opts.expiry) : 3600;
  if (!Number.isFinite(expirySecs) || expirySecs <= 0) {
    log.err("--expiry must be a positive number of seconds");
    return;
  }

  const inputs: CreateIntentMandateInput = {
    user: creds.userPublic,
    agent: creds.agentPublic,
    merchant: creds.merchantPublic,
    asset: reapp.testnet.nativeSac,
    maxAmount: budget,
    expiry: Math.floor(Date.now() / 1000) + expirySecs,
    nonce: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
  };

  const mandate = reapp.createIntentMandate(inputs);
  log.step("authorizing mandate", {
    budget: `${budget} XLM`,
    merchant: short(creds.merchantPublic),
    id: short(mandate.id),
  });

  const registerTx = await reapp.registerMandate(mandate, { signer: creds.userSecret });
  log.chain("register_mandate confirmed", { tx: short(registerTx) });

  const approveTx = await reapp.approveBudget(mandate, { signer: creds.userSecret });
  log.chain("approveBudget confirmed (SEP-41 allowance to contract)", { tx: short(approveTx) });

  const stored: StoredMandate = { inputs, id: mandate.id, registerTx, approveTx };
  const path = saveMandate(stored);
  log.ok("mandate saved", { path });

  console.log(
    "\n" +
      c.bold("Mandate") +
      "\n" +
      c.gray("  id        ") + c.white(mandate.id) +
      "\n" +
      c.gray("  budget    ") + c.white(`${budget} XLM`) +
      "\n" +
      c.gray("  register  ") + c.dim(txUrl(registerTx)) +
      "\n" +
      c.gray("  approve   ") + c.dim(txUrl(approveTx)) +
      "\n",
  );
  log.info("next", { run: "reapp pay" });
}
