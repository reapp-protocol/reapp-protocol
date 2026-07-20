/**
 * Single source of truth for REAPP's deployed contract addresses.
 *
 * An address lives in exactly one place: here. Everything else — the SDK network
 * config (`config.ts`), the generated contract binding (`client.ts`), the scripts,
 * and the reference apps — reads from this module, so there is never a second copy
 * to keep in sync.
 *
 * The testnet `mandateRegistryId` is the permanent same-address upgrade target.
 * `npm run deploy:testnet` writes experimental deployments only to `.env`; it does
 * not rewrite this published default. To point at a different deployment at
 * runtime without editing source, pass a custom `NetworkConfig` to any SDK call.
 */
export const DEPLOYMENTS = {
  testnet: {
    /** Deployed MandateRegistry contract id. */
    mandateRegistryId: "CCHQ5G4Y4YBMY6D3TYYJSVJVCKUM22Q6TMKCCHVAHY4X7K6QELQACZRM",
    /** Native XLM Stellar Asset Contract — a real SEP-41 token. */
    nativeSac: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  },
} as const;
