import { DEPLOYMENTS } from "./deployments.js";

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
  mandateRegistryId: DEPLOYMENTS.testnet.mandateRegistryId,
  nativeSac: DEPLOYMENTS.testnet.nativeSac,
};
