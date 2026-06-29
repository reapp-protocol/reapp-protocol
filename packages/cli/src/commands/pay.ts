/**
 * `reapp pay [amount]` — agent-signed payment against the active mandate (REAPP-45).
 *
 * Rebuilds the stored mandate (same nonce -> same id), then has the AGENT sign
 * execute_payment. Budget, expiry, and replay are enforced ON-CHAIN: when the
 * agent tries to spend past the mandate cap the contract rejects it — that
 * rejection is the whole point, so we surface it clearly rather than as a stack
 * trace. The CLI is an untrusted client; the contract is the source of truth.
 */
import { reapp } from "@reapp-sdk/core";
import { log, c } from "../ui.js";
import { configExists, loadConfig } from "../config.js";
import { credentialsExist, loadCredentials } from "../secrets.js";
import { mandateExists, loadMandate } from "../mandate-store.js";

const short = (s: string) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "");

export async function runPay(amountArg?: string): Promise<void> {
  if (!configExists()) {
    log.warn("no reapp.config.json here — run `reapp init` first");
    return;
  }
  if (!credentialsExist()) {
    log.warn("no credentials — run `reapp setup` first");
    return;
  }
  if (!mandateExists()) {
    log.warn("no mandate — run `reapp mandate create` first");
    return;
  }

  const config = loadConfig();
  const creds = loadCredentials();
  const stored = loadMandate();
  const txUrl = (hash: string) => `${config.explorer}/tx/${hash}`;

  const amount = amountArg ?? config.unlockPrice;
  const mandate = reapp.createIntentMandate(stored.inputs); // same nonce -> same id

  log.step("execute_payment (agent-signed)", { amount: `${amount} XLM`, mandate: short(mandate.id) });
  try {
    const hash = await reapp.agent({ mandate, signer: creds.agentSecret }).pay(amount);
    log.chain("payment settled on-chain", { tx: short(hash) });
    console.log(
      "\n" +
        c.bold("Payment") +
        "\n" +
        c.gray("  amount  ") + c.white(`${amount} XLM`) +
        "\n" +
        c.gray("  tx      ") + c.dim(txUrl(hash)) +
        "\n",
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.err("payment rejected by the contract", { reason });
    log.info("budget, expiry, and replay are enforced on-chain — the CLI cannot override them");
    process.exitCode = 1;
  }
}
