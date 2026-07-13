import assert from "node:assert/strict";
import test from "node:test";
import { PaymentRejectedError, SettlementUncertainError } from "@reapp-sdk/core";
import { isFinalPaymentRejection } from "./payment-failure.js";

test("only a typed finalized rejection may clear a prepared payment journal", () => {
  const mandateId = "a".repeat(64);
  assert.equal(isFinalPaymentRejection(new PaymentRejectedError(mandateId, new Error("Error(Contract, #6)"))), true);
  assert.equal(isFinalPaymentRejection(new Error("payment rejected by contract: Error(Contract, #6)")), false);
  assert.equal(isFinalPaymentRejection(new Error("decoder failed after preparation")), false);
  assert.equal(isFinalPaymentRejection(new SettlementUncertainError({
    txHash: "b".repeat(64),
    mandateId,
    amount: "1.00",
    expectedSeq: "0",
    submittedAt: 1_700_000_000,
    validUntil: 1_700_000_060,
  }, new Error("RPC unavailable"))), false);
});
