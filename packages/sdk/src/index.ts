/**
 * @reapp/sdk — create an agent, connect to the testnet MandateRegistry, and
 * execute a mandate-validated payment in under 10 lines.
 *
 * The SDK is UNTRUSTED infrastructure: it never holds the allowance (only the
 * contract does), and every spend is validated + consumed on-chain by
 * `execute_payment`. A buggy or malicious SDK cannot exceed the mandate.
 *
 *   const m = reapp.createIntentMandate({ user, agent, merchant, asset, maxAmount: "5.00", expiry });
 *   await reapp.registerMandate(m, { signer: userKey });
 *   await reapp.approveBudget(m,   { signer: userKey });
 *   const agent = reapp.agent({ mandate: m, signer: agentKey });
 *   await agent.pay("1.00");
 */
import { Buffer } from "buffer";
import { Keypair, hash } from "@stellar/stellar-sdk";
import { TESTNET, keypairSigner, registryClient, token, type NetworkConfig } from "@reapp/stellar";

export interface CreateIntentMandateInput {
  user: string;
  agent: string;
  merchant: string;
  asset: string;
  /** Human amount, e.g. "5.00". */
  maxAmount: string;
  /** Unix seconds after which the mandate is dead. */
  expiry: number;
  /** Token decimals (default 7, matching Stellar assets). */
  decimals?: number;
  /** Optional explicit nonce; defaults to a unique value so ids don't collide. */
  nonce?: string;
}

export interface IntentMandate {
  /** Canonical hash hex — the on-chain mandate id (`vc_hash`). */
  id: string;
  idBuffer: Buffer;
  user: string;
  agent: string;
  merchant: string;
  asset: string;
  /** Budget in stroops. */
  maxAmount: bigint;
  expiry: number;
  decimals: number;
}

export interface SignerInput {
  signer: Keypair | string;
}

const DEFAULT_DECIMALS = 7;

export function toStroops(human: string, decimals = DEFAULT_DECIMALS): bigint {
  const parts = human.trim().split(".");
  const whole = parts[0] ?? "0";
  const frac = parts[1] ?? "";
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const sign = whole.startsWith("-") ? -1n : 1n;
  const wholeAbs = whole.replace("-", "") || "0";
  return sign * (BigInt(wholeAbs) * 10n ** BigInt(decimals) + BigInt(fracPadded || "0"));
}

const asKeypair = (s: Keypair | string): Keypair =>
  typeof s === "string" ? Keypair.fromSecret(s) : s;

/** An agent bound to a registered mandate. Its only power is `pay`, and every
 *  payment is enforced on-chain against the mandate. */
export class Agent {
  constructor(
    private readonly net: NetworkConfig,
    private readonly mandate: IntentMandate,
    private readonly agentKeypair: Keypair,
  ) {}

  /** Execute a mandate-validated payment of `amount` (human, e.g. "1.00").
   *  Reads the current sequence, then calls the contract's `execute_payment`
   *  (agent-signed). Throws if the contract rejects it. Returns the tx hash. */
  async pay(amount: string): Promise<string> {
    const signer = keypairSigner(this.agentKeypair, this.net.networkPassphrase);
    const client = registryClient(this.net, signer);
    const current = (await client.get_mandate({ mandate_id: this.mandate.idBuffer })).result.unwrap();
    const at = await client.execute_payment({
      mandate_id: this.mandate.idBuffer,
      amount: toStroops(amount, this.mandate.decimals),
      expected_seq: current.seq,
    });
    const sent = await at.signAndSend();
    sent.result.unwrap();
    return sent.sendTransactionResponse?.hash ?? "";
  }
}

export const reapp = {
  testnet: TESTNET,

  /** Build an AP2-style IntentMandate and its canonical id (no chain calls). */
  createIntentMandate(input: CreateIntentMandateInput, net: NetworkConfig = TESTNET): IntentMandate {
    void net;
    const decimals = input.decimals ?? DEFAULT_DECIMALS;
    const nonce = input.nonce ?? `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const canonical = JSON.stringify({
      user: input.user,
      agent: input.agent,
      merchant: input.merchant,
      asset: input.asset,
      maxAmount: input.maxAmount,
      expiry: input.expiry,
      nonce,
    });
    const idBuffer = hash(Buffer.from(canonical, "utf8"));
    return {
      id: idBuffer.toString("hex"),
      idBuffer,
      user: input.user,
      agent: input.agent,
      merchant: input.merchant,
      asset: input.asset,
      maxAmount: toStroops(input.maxAmount, decimals),
      expiry: input.expiry,
      decimals,
    };
  },

  /** Register the mandate on-chain (user-signed). */
  async registerMandate(
    mandate: IntentMandate,
    opts: SignerInput,
    net: NetworkConfig = TESTNET,
  ): Promise<string> {
    const signer = keypairSigner(asKeypair(opts.signer), net.networkPassphrase);
    const client = registryClient(net, signer);
    const at = await client.register_mandate({
      user: mandate.user,
      agent: mandate.agent,
      merchant: mandate.merchant,
      asset: mandate.asset,
      max_amount: mandate.maxAmount,
      expiry: BigInt(mandate.expiry),
      vc_hash: mandate.idBuffer,
    });
    const sent = await at.signAndSend();
    sent.result.unwrap();
    return sent.sendTransactionResponse?.hash ?? "";
  },

  /** Grant the contract a SEP-41 allowance up to the mandate budget (user-signed). */
  async approveBudget(
    mandate: IntentMandate,
    opts: SignerInput,
    net: NetworkConfig = TESTNET,
  ): Promise<string> {
    return token.approve(
      net,
      mandate.asset,
      asKeypair(opts.signer),
      net.mandateRegistryId,
      mandate.maxAmount,
    );
  },

  /** Revoke the mandate (user-signed). After this, `pay` is rejected on-chain. */
  async revokeMandate(
    mandate: IntentMandate,
    opts: SignerInput,
    net: NetworkConfig = TESTNET,
  ): Promise<string> {
    const signer = keypairSigner(asKeypair(opts.signer), net.networkPassphrase);
    const client = registryClient(net, signer);
    const at = await client.revoke_mandate({ mandate_id: mandate.idBuffer });
    const sent = await at.signAndSend();
    sent.result.unwrap();
    return sent.sendTransactionResponse?.hash ?? "";
  },

  /** Bind an agent to a registered mandate. */
  agent(
    opts: { mandate: IntentMandate; signer: Keypair | string },
    net: NetworkConfig = TESTNET,
  ): Agent {
    return new Agent(net, opts.mandate, asKeypair(opts.signer));
  },
};
