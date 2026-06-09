/**
 * @reapp/sdk — thin, UNTRUSTED client for the REAPP MandateRegistry.
 *
 * Hard rules (enforced in review):
 *  - The SDK is NEVER granted a token allowance — only the contract is.
 *  - `agent.fetch` may preflight via a `validate_and_consume` simulation for a
 *    clean error, but the authoritative spend is always on-chain
 *    `execute_payment`.
 *  - The SDK exposes NO method that moves funds outside `execute_payment`.
 *
 * It must be impossible for the SDK to be the reason a payment is or isn't
 * authorized — that is always the contract.
 */

/** An AP2 IntentMandate VC plus its canonical hash (the on-chain mandate id). */
export interface IntentMandate {
  /** Canonical hash of the VC; equals the on-chain `mandate_id` / `vc_hash`. */
  id: string;
  user: string;
  agent: string;
  merchant: string;
  asset: string;
  /** Human amount, e.g. "5.00". */
  maxAmount: string;
  /** Unix ms after which the mandate is dead. */
  expiry: number;
  /** The W3C Verifiable Credential payload (AP2 IntentMandate). */
  vc: unknown;
}

export interface CreateIntentMandateInput {
  user: string;
  agent: string;
  merchant: string;
  asset: string;
  maxAmount: string;
  expiry: number;
}

/** Opaque signer (Stellar keypair). Shape defined alongside @reapp/stellar. */
export interface Signer {
  publicKey(): string;
}

export interface Agent {
  /** x402 round-trip: 402 → consume mandate via execute_payment → resource. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export const reapp = {
  /** Build an AP2 IntentMandate VC and compute its canonical hash. */
  async createIntentMandate(_input: CreateIntentMandateInput): Promise<IntentMandate> {
    throw new Error("not implemented");
  },

  /** Submit the user-signed mandate to MandateRegistry.register_mandate. */
  async registerMandate(_mandate: IntentMandate, _opts: { signer: Signer }): Promise<void> {
    throw new Error("not implemented");
  },

  /** SEP-41 approve(spender = registry, amount = maxAmount). Never the SDK. */
  async approveBudget(_mandate: IntentMandate, _opts: { signer: Signer }): Promise<void> {
    throw new Error("not implemented");
  },

  /** Construct an agent bound to a registered mandate. */
  agent(_opts: { mandateId: string; signer: Signer }): Agent {
    throw new Error("not implemented");
  },
};
