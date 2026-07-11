/**
 * Single source of truth for REAPP's deployed contract addresses.
 *
 * An address lives in exactly one place: here. Everything else — the SDK network
 * config (`config.ts`), the generated contract binding (`client.ts`), the scripts,
 * and the reference apps — reads from this module, so there is never a second copy
 * to keep in sync.
 *
 * `npm run deploy:testnet` rewrites the testnet `mandateRegistryId` below
 * automatically after a successful deploy. To point at a different deployment at
 * runtime without editing source, pass a custom `NetworkConfig` to any SDK call.
 */
export const DEPLOYMENTS = {
  testnet: {
    /** Deployed MandateRegistry contract id. */
    mandateRegistryId: "CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE",
    /** Native XLM Stellar Asset Contract — a real SEP-41 token. */
    nativeSac: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  },
} as const;
