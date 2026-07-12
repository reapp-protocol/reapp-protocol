import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  DeliveryPendingError,
  reapp,
  type SettlementReceipt,
} from "@reapp-sdk/core";
import { blockReason, buyResearch } from "./research-agent.js";

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
    url: "http://merchant.test/source/market",
    method: "GET",
    txHash: "a".repeat(64),
    mandateId: mandate.id,
    amount: "1.00",
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
    });
    assert.equal(fetchCalls, 1);
    assert.equal(result[0]?.ok, false);
    assert.equal(result[0]?.txHash, receipt.txHash);
    assert.match(result[0]?.blockedReason ?? "", /do not pay again/);
  } finally {
    reapp.agent = originalAgent;
  }
});
