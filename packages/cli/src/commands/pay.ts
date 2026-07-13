/**
 * `reapp pay [amount]` — agent-signed payment against the active mandate.
 *
 * Rebuilds the stored mandate (same nonce -> same id), then has the AGENT sign
 * execute_payment. Budget, expiry, and replay are enforced ON-CHAIN: when the
 * agent tries to spend past the mandate cap the contract rejects it — that
 * rejection is the whole point, so we surface it clearly rather than as a stack
 * trace. The CLI is an untrusted client; the contract is the source of truth.
 */
import { SettlementUncertainError, reapp } from "@reapp-sdk/core";
import { log, c } from "../ui.js";
import { configExists, loadConfig, networkConfig } from "../config.js";
import { credentialsExist, loadCredentials } from "../secrets.js";
import { mandateExists, loadMandate } from "../mandate-store.js";
import {
  assertNoPendingSettlement,
  claimPendingSettlement,
  clearPendingSettlement,
  markSettlementCompleted,
} from "../settlement-store.js";
import { isFinalPaymentRejection } from "../payment-failure.js";

const short = (s: string) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "");

function rejectionSummary(reason: string): string {
  const code = (reason.match(/Error\(Contract,\s*#(\d+)\)/) ?? [])[1];
  switch (code) {
    case "4":
      return "MandateExpired";
    case "5":
      return "MandateRevoked";
    case "6":
      return "BudgetExceeded";
    case "7":
      return "MerchantOutOfScope";
    case "8":
      return "BadSequence";
    case "9":
      return "InvalidAmount";
    default:
      return reason.split("\n")[0] ?? reason;
  }
}

export async function runPay(amountArg?: string): Promise<void> {
  try {
    await assertNoPendingSettlement();
  } catch (error) {
    log.err("payment blocked by unresolved journal state", {
      reason: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }
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
  const net = networkConfig(config);
  const creds = loadCredentials();
  const stored = loadMandate();
  const txUrl = (hash: string) => `${config.explorer}/tx/${hash}`;

  const amount = amountArg ?? config.unlockPrice;
  const mandate = reapp.createIntentMandate(stored.inputs); // same nonce -> same id

  log.step("execute_payment (agent-signed)", { amount: `${amount} XLM`, mandate: short(mandate.id) });
  let preparedHash: string | undefined;
  let hash: string;
  try {
    hash = await reapp.agent({ mandate, signer: creds.agentSecret }, net).pay(amount, {
      onPrepared: async (pending) => {
        await claimPendingSettlement("pay", net.mandateRegistryId, pending);
        preparedHash = pending.txHash;
      },
    });
  } catch (err) {
    if (err instanceof SettlementUncertainError) {
      log.err("payment result is uncertain; durable journal retained", { tx: short(err.settlement.txHash) });
      log.info("run `reapp settlement reconcile`; do not run pay again");
      console.log(c.dim(`  ${txUrl(err.settlement.txHash)}`));
      process.exitCode = 1;
      return;
    }
    const reason = err instanceof Error ? err.message : String(err);
    if (isFinalPaymentRejection(err)) {
      if (preparedHash) {
        try {
          await clearPendingSettlement(preparedHash);
        } catch (clearError) {
          log.err("final rejection was observed but its durable journal could not be cleared", {
            reason: clearError instanceof Error ? clearError.message : String(clearError),
          });
          process.exitCode = 1;
          return;
        }
      }
      log.err("payment rejected by the contract", { reason: rejectionSummary(reason) });
      log.info("budget, expiry, and replay are enforced on-chain — the CLI cannot override them");
    } else if (preparedHash) {
      log.err("payment result is uncertain; durable journal retained", { tx: short(preparedHash) });
      log.info("run `reapp settlement reconcile`; do not run pay again");
    } else {
      log.err("payment failed before a transaction hash was durably prepared", {
        reason: reason.split("\n")[0],
      });
    }
    process.exitCode = 1;
    return;
  }

  try {
    await markSettlementCompleted(hash);
  } catch (error) {
    log.err("payment succeeded but completion could not be durably recorded", {
      tx: short(hash),
      reason: error instanceof Error ? error.message : String(error),
    });
    log.info("run `reapp settlement reconcile`; do not run pay again");
    process.exitCode = 1;
    return;
  }

  log.chain("payment settled on-chain; durable acknowledgment is required", { tx: short(hash) });
  console.log(
    "\n" +
      c.bold("Payment") +
      "\n" +
      c.gray("  amount  ") + c.white(`${amount} XLM`) +
      "\n" +
      c.gray("  tx      ") + c.dim(txUrl(hash)) +
      "\n",
  );
  log.info(`after you durably accept this result, run \`reapp settlement acknowledge ${hash}\``);
}
