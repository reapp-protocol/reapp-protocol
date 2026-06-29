#!/usr/bin/env node
/**
 * reapp — CLI for the REAPP MandateRegistry. The contract is the source of truth;
 * this tool is a thin, untrusted client over the published @reapp-sdk packages.
 *
 * Commands land incrementally: init (REAPP-42) first; setup/mandate/pay/demo
 * follow in REAPP-43..46.
 */
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runSetup } from "./commands/setup.js";

const program = new Command();

program
  .name("reapp")
  .description("Agent payments on Stellar, enforced on-chain by the REAPP MandateRegistry.")
  .version("0.0.0");

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

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
