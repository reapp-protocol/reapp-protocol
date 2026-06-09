/**
 * Reference consumer (the ResearchAgent).
 *
 * Signs a $5 IntentMandate scoped to one merchant, registers it, grants the
 * allowance to the contract, then buys a 402-gated resource via the SDK.
 *
 * Demonstrates the <10-line happy path (T1 acceptance):
 *
 *   const mandate = await reapp.createIntentMandate({ ... });
 *   await reapp.registerMandate(mandate, { signer: userKeypair });
 *   await reapp.approveBudget(mandate,   { signer: userKeypair });
 *   const agent = reapp.agent({ mandateId: mandate.id, signer: agentKeypair });
 *   const data  = await agent.fetch("https://merchant.example/research?q=...");
 *
 * STUB — wired in the MVP build (skill Step 6).
 */

export {};

async function main(): Promise<void> {
  throw new Error("not implemented");
}

void main;
