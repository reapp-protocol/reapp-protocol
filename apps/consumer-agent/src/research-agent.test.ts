import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createSettlementReceiptId,
  DeliveryPendingError,
  reapp,
  type SettlementReceipt,
} from "@reapp-sdk/core";
import {
  acknowledgePendingDelivery,
  blockReason,
  buyResearch,
  resumePendingDelivery,
} from "./research-agent.js";
import type {
  PurchaseOutcomeStore,
  StoredPurchaseOutcome,
} from "./outcome-store.js";

const emptyReceiptStore = {
  async savePending() {},
  async clearPending() {},
  async listPending() { return []; },
};

function memoryOutcomeStore(): PurchaseOutcomeStore {
  const records = new Map<string, { executionId: string; outcome?: StoredPurchaseOutcome }>();
  return {
    async lookup(identity) {
      const record = records.get(identity.key);
      if (!record) return { kind: "missing" };
      return record.outcome
        ? { kind: "completed", outcome: record.outcome }
        : { kind: "executing", executionId: record.executionId };
    },
    async claim(identity, executionId) {
      const record = records.get(identity.key);
      if (record?.outcome) return { kind: "completed", outcome: record.outcome };
      if (record) return { kind: "executing", executionId: record.executionId };
      records.set(identity.key, { executionId });
      return { kind: "claimed" };
    },
    async complete(identity, executionId, outcome) {
      const record = records.get(identity.key);
      if (!record || record.executionId !== executionId) throw new Error("wrong execution");
      if (record.outcome && record.outcome.outcomeId !== outcome.outcomeId) throw new Error("conflict");
      record.outcome = outcome;
      return outcome;
    },
  };
}

test("blockReason maps terminal contract rejections without calling them retryable", () => {
  assert.equal(blockReason("Error(Contract, #4)"), "mandate expired");
  assert.equal(blockReason("Error(Contract, #5)"), "mandate revoked");
  assert.equal(blockReason("Error(Contract, #6)"), "budget exceeded");
  assert.equal(blockReason("Error(Contract, #7)"), "merchant out of scope");
  assert.equal(blockReason("other"), "rejected on-chain");
});

test("consumer surfaces settled-but-undelivered payment and never retries blindly", async () => {
  const key = Keypair.random();
  const mandate = reapp.createIntentMandate({
    user: key.publicKey(),
    agent: key.publicKey(),
    merchant: key.publicKey(),
    asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    maxAmount: "1.00",
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  const receipt: SettlementReceipt = {
    receiptId: "c".repeat(64),
    proofVersion: 1,
    url: "http://merchant.test/source/market",
    method: "GET",
    txHash: "a".repeat(64),
    mandateId: mandate.id,
    amount: "1.00",
    submittedAt: 1_700_000_000,
    validUntil: 1_700_000_060,
    proof: {
      scheme: "reapp-soroban",
      network: "stellar-testnet",
      txHash: "a".repeat(64),
      mandateId: mandate.id,
      amount: "1.00",
    },
  };
  const originalAgent = reapp.agent;
  let fetchCalls = 0;
  reapp.agent = (() => ({
    fetch: async () => {
      fetchCalls += 1;
      throw new DeliveryPendingError(receipt, new TypeError("connection refused"));
    },
  })) as unknown as typeof reapp.agent;
  try {
    const result = await buyResearch({
      serverUrl: "http://merchant.test",
      sourceIds: ["market"],
      mandate,
      agentSecret: key.secret(),
      receiptStore: emptyReceiptStore,
      outcomeStore: memoryOutcomeStore(),
    });
    assert.equal(fetchCalls, 1);
    assert.equal(result[0]?.ok, false);
    assert.equal(result[0]?.deliveryState, "pending");
    assert.equal(result[0]?.txHash, receipt.txHash);
    assert.deepEqual(result[0]?.receipt, receipt);
    assert.match(result[0]?.blockedReason ?? "", /do not pay again/);
  } finally {
    reapp.agent = originalAgent;
  }
});

test("durable application outcome survives an acknowledgment crash and restart never fetches again", async () => {
  const key = Keypair.random();
  const mandate = reapp.createIntentMandate({
    user: key.publicKey(),
    agent: key.publicKey(),
    merchant: key.publicKey(),
    asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    maxAmount: "1.00",
    expiry: Math.floor(Date.now() / 1000) + 3600,
    nonce: "application-outcome-crash-test",
  });
  const proof = {
    scheme: "reapp-soroban",
    network: "stellar-testnet",
    txHash: "a".repeat(64),
    mandateId: mandate.id,
    amount: "1.00",
  };
  const receiptWithoutId = {
    proofVersion: 1 as const,
    url: "http://merchant.test/source/market",
    method: "GET",
    txHash: proof.txHash,
    mandateId: mandate.id,
    amount: proof.amount,
    submittedAt: 1_700_000_000,
    validUntil: 1_700_000_060,
    proof,
  };
  const receipt: SettlementReceipt = {
    receiptId: createSettlementReceiptId(receiptWithoutId),
    ...receiptWithoutId,
  };
  const pending = new Map([[receipt.receiptId, receipt]]);
  const receiptStore = {
    async savePending(candidate: Readonly<SettlementReceipt>) { pending.set(candidate.receiptId, candidate); },
    async clearPending(receiptId: string) { pending.delete(receiptId); },
    async listPending() { return [...pending.values()]; },
  };
  const outcomeStore = memoryOutcomeStore();
  const originalAgent = reapp.agent;
  const originalFetch = globalThis.fetch;
  const actualAgent = originalAgent({ mandate, signer: key.secret(), receiptStore });
  let fetchCalls = 0;
  let failAcknowledgment = true;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    name: "Market",
    data: "accepted",
    settledTx: receipt.txHash,
  }), { status: 200, headers: { "content-type": "application/json" } });
  reapp.agent = (() => ({
    fetch: async () => {
      fetchCalls += 1;
      return actualAgent.retryDelivery(receipt);
    },
    acknowledgeDelivery: async (candidate: Readonly<SettlementReceipt>) => {
      if (failAcknowledgment) {
        failAcknowledgment = false;
        throw new DeliveryPendingError(candidate, new Error("simulated crash before receipt clear"));
      }
      await actualAgent.acknowledgeDelivery(candidate);
    },
  })) as unknown as typeof reapp.agent;
  try {
    const first = await buyResearch({
      serverUrl: "http://merchant.test",
      sourceIds: ["market"],
      mandate,
      agentSecret: key.secret(),
      receiptStore,
      outcomeStore,
    });
    assert.equal(first[0]?.deliveryState, "pending");
    assert.equal(fetchCalls, 1);
    assert.equal(pending.size, 1);

    const restarted = await buyResearch({
      serverUrl: "http://merchant.test",
      sourceIds: ["market"],
      mandate,
      agentSecret: key.secret(),
      receiptStore,
      outcomeStore,
    });
    assert.equal(restarted[0]?.deliveryState, "delivered");
    assert.equal(restarted[0]?.data, "accepted");
    assert.equal(fetchCalls, 1);
    assert.equal(pending.size, 0);
  } finally {
    reapp.agent = originalAgent;
    globalThis.fetch = originalFetch;
  }
});

test("resume and explicit acknowledgment reuse the exact receipt and have no payment path", async () => {
  const key = Keypair.random();
  const mandate = reapp.createIntentMandate({
    user: key.publicKey(),
    agent: key.publicKey(),
    merchant: key.publicKey(),
    asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    maxAmount: "1.00",
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  const proof = {
    scheme: "reapp-soroban",
    network: "stellar-testnet",
    txHash: "a".repeat(64),
    mandateId: mandate.id,
    amount: "1.00",
  };
  const receipt: SettlementReceipt = {
    receiptId: "c".repeat(64),
    proofVersion: 1,
    url: "http://merchant.test/source/market",
    method: "GET",
    txHash: proof.txHash,
    mandateId: mandate.id,
    amount: proof.amount,
    submittedAt: 1_700_000_000,
    validUntil: 1_700_000_060,
    proof,
  };
  const originalAgent = reapp.agent;
  let retried: Readonly<SettlementReceipt> | undefined;
  let acknowledged: Readonly<SettlementReceipt> | undefined;
  reapp.agent = (() => ({
    retryDelivery: async (candidate: Readonly<SettlementReceipt>) => {
      retried = candidate;
      return new Response("recovered", { status: 200 });
    },
    acknowledgeDelivery: async (candidate: Readonly<SettlementReceipt>) => {
      acknowledged = candidate;
    },
  })) as unknown as typeof reapp.agent;
  try {
    const response = await resumePendingDelivery({
      mandate,
      agentSecret: key.secret(),
      receipt,
      receiptStore: emptyReceiptStore,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(retried, receipt);
    await acknowledgePendingDelivery({
      mandate,
      agentSecret: key.secret(),
      receipt,
      receiptStore: emptyReceiptStore,
    });
    assert.deepEqual(acknowledged, receipt);
  } finally {
    reapp.agent = originalAgent;
  }
});
