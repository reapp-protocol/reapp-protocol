#!/usr/bin/env node
/**
 * reapp — CLI for the REAPP MandateRegistry. The contract is the source of truth;
 * this tool is a thin, untrusted client over the published @reapp-sdk packages.
 */
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runSetup } from "./commands/setup.js";
import { runMandateCreate } from "./commands/mandate.js";
import { runPay } from "./commands/pay.js";
import { runDemo } from "./commands/demo.js";
import { runSettlementAcknowledge, runSettlementReconcile } from "./commands/reconcile.js";
import { CLI_VERSION } from "./version.js";

const program = new Command();

program
  .name("reapp")
  .description("Agent payments on Stellar, enforced on-chain by the REAPP MandateRegistry.")
  .version(CLI_VERSION);

program
  .command("init")
  .description("scaffold a project in the current directory (writes reapp.config.json)")
  .option("-f, --force", "overwrite an existing reapp.config.json")
  .action((opts) => runInit(opts));

program
  .command("setup")
  .description("generate testnet burner keys and fund them via friendbot")
  .option("-f, --force", "regenerate fresh keys, overwriting existing credentials")
  .action((opts) => runSetup(opts));

const mandate = program.command("mandate").description("manage AP2 mandates");
mandate
  .command("create")
  .description("register an AP2 mandate on-chain and approve the SEP-41 allowance")
  .option("-b, --budget <xlm>", "mandate cap in XLM (default: from reapp.config.json)")
  .option("-e, --expiry <seconds>", "seconds until the mandate expires", "3600")
  .option("-f, --force", "replace an existing stored mandate")
  .action((opts) => runMandateCreate(opts));

program
  .command("pay")
  .description("make an agent-signed payment against the active mandate (budget enforced on-chain)")
  .argument("[amount]", "XLM amount to pay (default: unlockPrice from reapp.config.json)")
  .action((amount) => runPay(amount));

const settlement = program.command("settlement").description("inspect crash-safe payment state");
settlement
  .command("reconcile")
  .description("query the exact prepared transaction hash before allowing another payment")
  .action(() => runSettlementReconcile());
settlement
  .command("acknowledge")
  .description("acknowledge one exact durably recorded successful payment")
  .argument("<tx-hash>", "the exact 64-character lowercase transaction hash")
  .action((txHash) => runSettlementAcknowledge(txHash));

program
  .command("demo")
  .description("list or run a self-contained on-chain demo (ephemeral accounts, no setup needed)")
  .argument("[target]", "which demo to run; omit to list available demos")
  .action((target) => runDemo(target));

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
