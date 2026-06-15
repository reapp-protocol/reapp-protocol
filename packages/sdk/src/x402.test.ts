import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "buffer";
import { decodePaymentProof, encodePaymentProof, type PaymentProof } from "@reapp-sdk/core";

/** A complete, well-formed settlement proof. */
const PROOF: PaymentProof = {
  scheme: "reapp-soroban",
  network: "stellar-testnet",
  txHash: "a".repeat(64),
  mandateId: "b".repeat(64),
  amount: "1.00",
};

/** Base64-encode an arbitrary value as if it were an X-PAYMENT payload, WITHOUT
 *  going through encodePaymentProof — so we can forge wrong-shaped payloads. */
const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64");

test("round-trips a well-formed proof", () => {
  const decoded = decodePaymentProof(encodePaymentProof(PROOF));
  assert.deepEqual(decoded, PROOF);
});

test("rejects a payload that is not valid JSON", () => {
  const header = Buffer.from("this is not json", "utf8").toString("base64");
  assert.throws(() => decodePaymentProof(header), /x402:.*not valid JSON/);
});

// The core of this test: valid base64 + valid JSON, but the WRONG SHAPE. Before
// hardening, each of these returned a value whose `.txHash` was undefined (or, for
// null, threw a TypeError on property access) instead of a clear x402 error.
const GARBAGE_SHAPES: Array<[string, unknown]> = [
  ["a number", 42],
  ["an array", ["a".repeat(64)]],
  ["a string", "a".repeat(64)],
  ["an empty object", {}],
  ["null", null],
  ["an object missing txHash", { scheme: "s", network: "n", mandateId: "m", amount: "1.00" }],
];

for (const [label, value] of GARBAGE_SHAPES) {
  test(`rejects ${label}`, () => {
    assert.throws(() => decodePaymentProof(b64(value)), /^Error: x402:/);
  });
}

test("rejects an object whose txHash is the wrong type", () => {
  const value = { ...PROOF, txHash: 123 };
  assert.throws(() => decodePaymentProof(b64(value)), /non-string `txHash`/);
});

test("rejects an object with an empty-string required field", () => {
  const value = { ...PROOF, txHash: "" };
  assert.throws(() => decodePaymentProof(b64(value)), /`txHash`/);
});

test("rejects each missing required field in turn", () => {
  for (const field of ["scheme", "network", "txHash", "mandateId", "amount"] as const) {
    const value: Record<string, unknown> = { ...PROOF };
    delete value[field];
    assert.throws(
      () => decodePaymentProof(b64(value)),
      new RegExp(`\`${field}\``),
      `expected a throw when ${field} is absent`,
    );
  }
});
