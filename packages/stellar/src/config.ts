/** Network configuration for REAPP's Soroban layer. */
export interface NetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
  /** Deployed MandateRegistry contract id for this network. */
  mandateRegistryId: string;
  /** Native XLM Stellar Asset Contract (a real SEP-41 token) for this network. */
  nativeSac: string;
}

/** Stellar testnet — the live, audited MandateRegistry deployment. */
export const TESTNET: NetworkConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  mandateRegistryId: "CB4KOTLGMM5JEPFPU6QBJLADIBP3RSGUX44FOYTFRICNXKKFPYIW7ZOA",
  nativeSac: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
};
