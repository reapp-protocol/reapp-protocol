/**
 * Secrets store: testnet burner keys written to ~/.reapp/credentials.json,
 * OUTSIDE any repo, with tight permissions (dir 0700, file 0600). These are
 * throwaway testnet keys — never mainnet, never committed. Set REAPP_HOME to
 * relocate the store (handy for tests and CI).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Credentials = {
  network: "testnet";
  userSecret: string;
  userPublic: string;
  agentSecret: string;
  agentPublic: string;
  merchantSecret: string;
  merchantPublic: string;
};

export function reappHome(): string {
  return process.env.REAPP_HOME ?? join(homedir(), ".reapp");
}

export function credentialsPath(): string {
  return join(reappHome(), "credentials.json");
}

export function credentialsExist(): boolean {
  return existsSync(credentialsPath());
}

export function loadCredentials(): Credentials {
  return JSON.parse(readFileSync(credentialsPath(), "utf8")) as Credentials;
}

export function saveCredentials(creds: Credentials): string {
  const home = reappHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = credentialsPath();
  writeFileSync(path, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  return path;
}
