/**
 * Reference consumer (the ResearchAgent).
 *
 * The agent answers a question by buying premium sources from a 402-gated
 * merchant. It does not move money itself and it does not hold the budget: every
 * purchase is `agent.fetch(url)`, which on a 402 settles `execute_payment`
 * on-chain through the MandateRegistry. The contract enforces the budget. Once the
 * mandate is spent, the contract REJECTS the next payment and `fetch` throws, so
 * the agent simply works with the sources it could afford.
 *
 * This is the SAFE pattern: the agent is untrusted, the contract is the leash.
 * Note what the agent CANNOT do, by construction:
 *   - It cannot pay a merchant the mandate does not name (scope is on-chain).
 *   - It cannot spend past the budget (the contract rejects it).
 *   - It cannot "skip" settlement: `fetch` only returns the resource after a real,
 *     server-verified on-chain payment.
 */
import {
  DeliveryPendingError,
  reapp,
  type IntentMandate,
} from "@reapp-sdk/core";

export interface BuyResult {
  id: string;
  ok: boolean;
  /** Source name + data, when the purchase succeeded and the resource was served. */
  name?: string;
  data?: string;
  /** The on-chain settlement transaction the merchant verified. */
  txHash?: string;
  /** Why the purchase did not yield the resource (contract rejection or server refusal). */
  blockedReason?: string;
}

/** Map a contract rejection message to a short, human reason. */
export function blockReason(msg: string): string {
  if (msg.includes("#6")) return "budget exceeded";
  if (msg.includes("#5")) return "mandate revoked";
  if (msg.includes("#4")) return "mandate expired";
  if (msg.includes("#7")) return "merchant out of scope";
  return "rejected on-chain";
}

export interface BuyEvent {
  type: "buying" | "paid" | "blocked";
  id: string;
  txHash?: string;
  reason?: string;
}

/**
 * Walk a list of sources, buying each via `agent.fetch`. Payments are sequential
 * on purpose: the mandate's sequence increments on-chain with every spend, so two
 * payments must not race. Returns one result per source.
 */
export async function buyResearch(opts: {
  serverUrl: string;
  sourceIds: string[];
  mandate: IntentMandate;
  agentSecret: string;
  onEvent?: (e: BuyEvent) => void;
}): Promise<BuyResult[]> {
  const agent = reapp.agent({ mandate: opts.mandate, signer: opts.agentSecret });
  const results: BuyResult[] = [];

  for (const id of opts.sourceIds) {
    const url = `${opts.serverUrl.replace(/\/$/, "")}/source/${id}`;
    opts.onEvent?.({ type: "buying", id });
    try {
      const res = await agent.fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { name: string; data: string; settledTx: string };
        results.push({ id, ok: true, name: body.name, data: body.data, txHash: body.settledTx });
        opts.onEvent?.({ type: "paid", id, txHash: body.settledTx });
      } else {
        // The on-chain payment happened but the merchant refused the proof (e.g.
        // replay, or it verified the chain and was not satisfied). Surface it.
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const reason = body.error ?? `merchant responded ${res.status}`;
        results.push({ id, ok: false, blockedReason: reason });
        opts.onEvent?.({ type: "blocked", id, reason });
      }
    } catch (e) {
      if (e instanceof DeliveryPendingError) {
        const reason = "payment settled; delivery pending — retry the same receipt, do not pay again";
        results.push({ id, ok: false, txHash: e.receipt.txHash, blockedReason: reason });
        opts.onEvent?.({ type: "blocked", id, txHash: e.receipt.txHash, reason });
        continue;
      }
      // `fetch` throws when the contract rejects the payment (budget, expiry,
      // revoke, scope). This is the protocol working, not an error to retry.
      const reason = blockReason(e instanceof Error ? e.message : String(e));
      results.push({ id, ok: false, blockedReason: reason });
      opts.onEvent?.({ type: "blocked", id, reason });
    }
  }

  return results;
}
