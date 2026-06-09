/**
 * Reference fulfillment agent (the merchant).
 *
 * A single 402-gated route priced in USDC. The 402 challenge tells the agent
 * the price, the merchant, and that payment MUST occur via
 * MandateRegistry.execute_payment. Before returning the resource, the server
 * verifies the on-chain payment + mandate consumption via Soroban RPC.
 *
 * This file is a first-read doc: it must show the SAFE pattern clearly.
 *
 * STUB — wired in the MVP build (skill Step 5).
 */

export {};

async function main(): Promise<void> {
  throw new Error("not implemented");
}

void main;
