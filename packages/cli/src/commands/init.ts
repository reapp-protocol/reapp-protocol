/**
 * `reapp init` — scaffold a project in the current directory by writing a
 * committable reapp.config.json (network, contract id, explorer, demo defaults).
 * Idempotent: refuses to clobber an existing config unless --force is passed.
 */
import { banner, log, c } from "../ui.js";
import { configExists, configPath, defaultConfig, saveConfig, CONFIG_FILE } from "../config.js";

export type InitOptions = { force?: boolean };

export function runInit(opts: InitOptions = {}): void {
  console.log("\n" + banner() + "\n");

  if (configExists() && !opts.force) {
    log.warn(`${CONFIG_FILE} already exists`, { path: configPath() });
    log.info("re-run with --force to overwrite, or edit it directly");
    return;
  }

  const config = defaultConfig();
  const path = saveConfig(config);
  log.ok(`wrote ${CONFIG_FILE}`, { path });
  log.info("config", { network: config.network, contract: config.contractId });

  console.log(
    "\n" +
      c.bold("Next steps") +
      "\n" +
      c.gray("  1. ") +
      c.white("reapp setup") +
      c.gray("   configure keys + fund testnet accounts") +
      "\n" +
      c.gray("  2. ") +
      c.white("reapp mandate create") +
      c.gray("   register an AP2 mandate on-chain") +
      "\n" +
      c.gray("  3. ") +
      c.white("reapp pay") +
      c.gray("   make an agent-signed payment") +
      "\n",
  );
}
