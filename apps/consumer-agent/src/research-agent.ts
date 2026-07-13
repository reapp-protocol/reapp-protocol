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
import { randomUUID } from "node:crypto";
import {
  DeliveryPendingError,
  getSettlementReceipt,
  reapp,
  type IntentMandate,
  type SettlementReceipt,
  type SettlementReceiptStore,
} from "@reapp-sdk/core";
import {
  createPurchaseIdentity,
  createStoredPurchaseOutcome,
  type PurchaseOutcomeStore,
  type StoredPurchaseOutcome,
} from "./outcome-store.js";

export interface BuyResult {
  id: string;
  ok: boolean;
  deliveryState: "delivered" | "pending" | "rejected";
  /** Source name + data, when the purchase succeeded and the resource was served. */
  name?: string;
  data?: string;
  /** The on-chain settlement transaction the merchant verified. */
  txHash?: string;
  /** Exact recovery evidence. Retain it; retrying it never creates a payment. */
  receipt?: Readonly<SettlementReceipt>;
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
  type: "buying" | "paid" | "delivery-pending" | "blocked";
  id: string;
  txHash?: string;
  receipt?: Readonly<SettlementReceipt>;
  reason?: string;
}

function resultFromOutcome(
  outcome: Readonly<StoredPurchaseOutcome>,
  receipt?: Readonly<SettlementReceipt>,
): BuyResult {
  if (outcome.kind === "delivered") {
    return {
      id: outcome.identity.sourceId,
      ok: true,
      deliveryState: "delivered",
      name: outcome.name,
      data: outcome.data,
      txHash: outcome.txHash,
      receipt,
    };
  }
  return {
    id: outcome.identity.sourceId,
    ok: false,
    deliveryState: "rejected",
    txHash: outcome.kind === "terminal" ? outcome.txHash : undefined,
    receipt,
    blockedReason: outcome.reason,
  };
}

function eventFromResult(result: Readonly<BuyResult>): BuyEvent {
  return result.ok
    ? { type: "paid", id: result.id, txHash: result.txHash, receipt: result.receipt }
    : { type: "blocked", id: result.id, txHash: result.txHash, receipt: result.receipt, reason: result.blockedReason };
}

/** Resume delivery from an existing settlement. This function cannot pay. */
export async function resumePendingDelivery(opts: {
  mandate: IntentMandate;
  agentSecret: string;
  receipt: Readonly<SettlementReceipt>;
  receiptStore: SettlementReceiptStore;
}): Promise<Response> {
  const agent = reapp.agent({
    mandate: opts.mandate,
    signer: opts.agentSecret,
    proofPolicy: "bound-v2-only",
    receiptStore: opts.receiptStore,
  });
  return agent.retryDelivery(opts.receipt);
}

/** Commit delivery only after the caller has durably accepted the response. */
export async function acknowledgePendingDelivery(opts: {
  mandate: IntentMandate;
  agentSecret: string;
  receipt: Readonly<SettlementReceipt>;
  receiptStore: SettlementReceiptStore;
}): Promise<void> {
  const agent = reapp.agent({
    mandate: opts.mandate,
    signer: opts.agentSecret,
    proofPolicy: "bound-v2-only",
    receiptStore: opts.receiptStore,
  });
  await agent.acknowledgeDelivery(opts.receipt);
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
  receiptStore: SettlementReceiptStore;
  outcomeStore: PurchaseOutcomeStore;
  onEvent?: (e: BuyEvent) => void;
}): Promise<BuyResult[]> {
  const agent = reapp.agent({
    mandate: opts.mandate,
    signer: opts.agentSecret,
    proofPolicy: "bound-v2-only",
    receiptStore: opts.receiptStore,
  });
  const results: BuyResult[] = [];

  for (const id of opts.sourceIds) {
    const url = `${opts.serverUrl.replace(/\/$/, "")}/source/${id}`;
    const identity = createPurchaseIdentity({ mandateId: opts.mandate.id, url, sourceId: id });
    const executionId = randomUUID();
    const claim = await opts.outcomeStore.claim(identity, executionId, Math.floor(Date.now() / 1_000));

    if (claim.kind === "completed") {
      const pending = await opts.receiptStore.listPending();
      let matchingReceipt: Readonly<SettlementReceipt> | undefined;
      if (claim.outcome.kind === "delivered" || claim.outcome.kind === "terminal") {
        const completedOutcome = claim.outcome;
        matchingReceipt = pending.find((receipt) =>
          receipt.receiptId === completedOutcome.receiptId
          && receipt.txHash === completedOutcome.txHash
          && receipt.mandateId === identity.mandateId
          && receipt.method === identity.method
          && receipt.url === identity.url
        );
        if (pending.length > 0 && !matchingReceipt) {
          throw new Error("a pending receipt does not match the durable accepted purchase outcome");
        }
        if (matchingReceipt) await agent.acknowledgeDelivery(matchingReceipt);
      } else if (pending.length > 0) {
        throw new Error("a no-payment rejection cannot acknowledge an unrelated pending receipt");
      }
      const replayed = resultFromOutcome(claim.outcome, matchingReceipt);
      results.push(replayed);
      opts.onEvent?.(eventFromResult(replayed));
      continue;
    }

    if (claim.kind === "executing") {
      const pending = await opts.receiptStore.listPending();
      if (pending.length > 1) throw new Error("multiple pending receipts require manual evidence review");
      const receipt = pending.find((candidate) =>
        candidate.mandateId === identity.mandateId
        && candidate.method === identity.method
        && candidate.url === identity.url
      );
      const reason = receipt
        ? "payment transaction is unresolved; reconcile and retry this exact receipt, do not pay again"
        : "purchase execution was interrupted before a receipt was recorded; confirm the original owner is dead before manual recovery";
      const blocked: BuyResult = {
        id,
        ok: false,
        deliveryState: "pending",
        txHash: receipt?.txHash,
        receipt,
        blockedReason: reason,
      };
      results.push(blocked);
      opts.onEvent?.({ type: "delivery-pending", id, txHash: receipt?.txHash, receipt, reason });
      continue;
    }

    opts.onEvent?.({ type: "buying", id });
    let settledReceipt: Readonly<SettlementReceipt> | undefined;
    try {
      const res = await agent.fetch(url);
      settledReceipt = getSettlementReceipt(res);
      if (res.ok) {
        const body = (await res.json()) as {
          ok?: boolean;
          name?: unknown;
          data?: unknown;
          settledTx?: unknown;
          error?: unknown;
          deliveryState?: unknown;
        };
        if (
          settledReceipt
          && body.ok === false
          && body.deliveryState === "terminal"
          && typeof body.error === "string"
        ) {
          const outcome = createStoredPurchaseOutcome({
            identity,
            kind: "terminal",
            receiptId: settledReceipt.receiptId,
            txHash: settledReceipt.txHash,
            reason: body.error,
          });
          await opts.outcomeStore.complete(identity, executionId, outcome);
          await agent.acknowledgeDelivery(settledReceipt);
          results.push({
            id,
            ok: false,
            deliveryState: "rejected",
            txHash: settledReceipt.txHash,
            receipt: settledReceipt,
            blockedReason: body.error,
          });
          opts.onEvent?.({
            type: "blocked",
            id,
            txHash: settledReceipt.txHash,
            receipt: settledReceipt,
            reason: body.error,
          });
          continue;
        }
        if (
          !settledReceipt
          || body.ok !== true
          || typeof body.name !== "string"
          || typeof body.data !== "string"
          || typeof body.settledTx !== "string"
          || body.settledTx.toLowerCase() !== settledReceipt.txHash.toLowerCase()
        ) {
          if (settledReceipt) {
            throw new DeliveryPendingError(
              settledReceipt,
              new Error("merchant delivered an invalid paid result; retain and retry the exact receipt"),
            );
          }
          throw new Error("merchant returned success without settlement evidence");
        }
        const outcome = createStoredPurchaseOutcome({
          identity,
          kind: "delivered",
          receiptId: settledReceipt.receiptId,
          txHash: settledReceipt.txHash,
          name: body.name,
          data: body.data,
        });
        await opts.outcomeStore.complete(identity, executionId, outcome);
        await agent.acknowledgeDelivery(settledReceipt);
        results.push({
          id,
          ok: true,
          deliveryState: "delivered",
          name: body.name,
          data: body.data,
          txHash: body.settledTx,
          receipt: settledReceipt,
        });
        opts.onEvent?.({ type: "paid", id, txHash: body.settledTx, receipt: settledReceipt });
      } else {
        // The on-chain payment happened but the merchant refused the proof (e.g.
        // replay, or it verified the chain and was not satisfied). Surface it.
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const reason = body.error ?? `merchant responded ${res.status}`;
        const outcome = createStoredPurchaseOutcome({ identity, kind: "rejected", reason });
        await opts.outcomeStore.complete(identity, executionId, outcome);
        results.push({ id, ok: false, deliveryState: "rejected", blockedReason: reason });
        opts.onEvent?.({ type: "blocked", id, reason });
      }
    } catch (e) {
      if (e instanceof DeliveryPendingError) {
        const reason = "payment transaction submitted; settlement or delivery is pending — reconcile and retry the same receipt, do not pay again";
        results.push({
          id,
          ok: false,
          deliveryState: "pending",
          txHash: e.receipt.txHash,
          receipt: e.receipt,
          blockedReason: reason,
        });
        opts.onEvent?.({
          type: "delivery-pending",
          id,
          txHash: e.receipt.txHash,
          receipt: e.receipt,
          reason,
        });
        continue;
      }
      if (settledReceipt) {
        const reason = "payment response arrived but application acceptance is pending; retry the same receipt, do not pay again";
        results.push({
          id,
          ok: false,
          deliveryState: "pending",
          txHash: settledReceipt.txHash,
          receipt: settledReceipt,
          blockedReason: reason,
        });
        opts.onEvent?.({
          type: "delivery-pending",
          id,
          txHash: settledReceipt.txHash,
          receipt: settledReceipt,
          reason,
        });
        continue;
      }
      // `fetch` throws when the contract rejects the payment (budget, expiry,
      // revoke, scope). This is the protocol working, not an error to retry.
      const message = e instanceof Error ? e.message : String(e);
      const reason = blockReason(message);
      if (reason !== "rejected on-chain") {
        const outcome = createStoredPurchaseOutcome({ identity, kind: "rejected", reason });
        await opts.outcomeStore.complete(identity, executionId, outcome);
        results.push({ id, ok: false, deliveryState: "rejected", blockedReason: reason });
        opts.onEvent?.({ type: "blocked", id, reason });
      } else {
        const pendingReason = "purchase execution is uncertain and remains durably claimed; inspect it before any retry";
        results.push({ id, ok: false, deliveryState: "pending", blockedReason: pendingReason });
        opts.onEvent?.({ type: "delivery-pending", id, reason: pendingReason });
      }
    }
  }

  return results;
}
