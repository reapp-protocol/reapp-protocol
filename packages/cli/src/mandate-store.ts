/**
 * Mandate store: the active mandate's inputs + on-chain ids, written to
 * ~/.reapp/mandate.json. NOT secret (no private keys) — it holds the exact
 * CreateIntentMandateInput (incl. nonce + expiry) so `reapp pay` can rebuild
 * the identical mandate id the contract registered.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CreateIntentMandateInput } from "@reapp-sdk/core";
import { reappHome } from "./secrets.js";

export type StoredMandate = {
  inputs: CreateIntentMandateInput;
  id: string;
  registerTx: string;
  approveTx: string;
};

export function mandatePath(): string {
  return join(reappHome(), "mandate.json");
}

export function mandateExists(): boolean {
  return existsSync(mandatePath());
}

export function loadMandate(): StoredMandate {
  return JSON.parse(readFileSync(mandatePath(), "utf8")) as StoredMandate;
}

export function saveMandate(m: StoredMandate): string {
  const path = mandatePath();
  writeFileSync(path, JSON.stringify(m, null, 2) + "\n", { mode: 0o600 });
  return path;
}
