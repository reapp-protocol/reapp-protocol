import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeExpectedPaymentSequence,
  resolveExpectedPaymentSequence,
} from "./payment-sequence.js";

test("expected payment sequence accepts equal string, number, and bigint u32 values", () => {
  assert.equal(resolveExpectedPaymentSequence(0, "0"), 0);
  assert.equal(resolveExpectedPaymentSequence(7, 7), 7);
  assert.equal(resolveExpectedPaymentSequence(42, 42n), 42);
  assert.equal(resolveExpectedPaymentSequence(0xffff_ffff, "4294967295"), 0xffff_ffff);
  assert.equal(resolveExpectedPaymentSequence(9), 9);
});

test("expected payment sequence mismatch refuses the operation", () => {
  assert.throws(
    () => resolveExpectedPaymentSequence(8, "7"),
    /expected mandate sequence 7, but current sequence is 8; refusing to create another transaction/,
  );
});

test("expected payment sequence rejects malformed and non-canonical strings", () => {
  for (const value of ["", "-1", "+1", "01", "1.0", "1e2", " 1", "1 ", "１２", "abc"]) {
    assert.throws(
      () => normalizeExpectedPaymentSequence(value),
      /canonical unsigned decimal/,
      `expected rejection for ${JSON.stringify(value)}`,
    );
  }
});

test("expected payment sequence rejects negative, fractional, unsafe, and out-of-u32 values", () => {
  for (const value of [-1, -1n, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0000, 0x1_0000_0000n, "4294967296"]) {
    assert.throws(
      () => normalizeExpectedPaymentSequence(value),
      /safe non-negative integer|outside the contract u32 range/,
      `expected rejection for ${String(value)}`,
    );
  }
});
