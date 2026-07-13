import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "buffer";
import { Keypair } from "@stellar/stellar-sdk";
import {
  BOUND_PAYMENT_SCHEME,
  createBoundPaymentProof,
  decodePaymentProof,
  encodePaymentProof,
  parse402,
  verifyBoundPaymentProofSignature,
  type BoundPaymentChallengeV2,
  type PaymentProof,
} from "@reapp-sdk/core";

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

// ---------------------------------------------------------------------------
// parse402: the other half of the wire format. It reads a server's 402 body and
// extracts the first payment requirement, or throws a clear x402 error. Every
// throw branch and the default-filling are exercised here.

/** Build a 402 Response with the given body (object is JSON-encoded). */
const res402 = (body: unknown): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 402,
    headers: { "content-type": "application/json" },
  });

test("parse402 parses a full challenge", async () => {
  const req = await parse402(
    res402({
      x402Version: 1,
      accepts: [
        {
          scheme: "reapp-soroban",
          network: "stellar-testnet",
          maxAmountRequired: "1.00",
          asset: "CASSET",
          payTo: "GMERCHANT",
          resource: "/source/market",
          extra: { contract: "CREGISTRY" },
        },
      ],
    }),
  );
  assert.deepEqual(req, {
    scheme: "reapp-soroban",
    network: "stellar-testnet",
    amount: "1.00",
    asset: "CASSET",
    payTo: "GMERCHANT",
    resource: "/source/market",
    contract: "CREGISTRY",
  });
});

test("parse402 applies defaults for a minimal challenge", async () => {
  const req = await parse402(res402({ accepts: [{ maxAmountRequired: "2.50", payTo: "GMERCHANT" }] }));
  assert.equal(req.scheme, "reapp-soroban");
  assert.equal(req.network, "stellar-testnet");
  assert.equal(req.amount, "2.50");
  assert.equal(req.asset, "");
  assert.equal(req.resource, "");
  assert.equal(req.contract, undefined);
});

test("parse402 accepts `amount` as an alias for maxAmountRequired", async () => {
  const req = await parse402(res402({ accepts: [{ amount: "3.00", payTo: "GMERCHANT" }] }));
  assert.equal(req.amount, "3.00");
});

test("parse402 rejects a non-JSON body", async () => {
  await assert.rejects(() => parse402(res402("this is not json")), /not valid JSON/);
});

test("parse402 rejects a body with no `accepts` requirement", async () => {
  await assert.rejects(() => parse402(res402({ x402Version: 1 })), /accepts/);
  await assert.rejects(() => parse402(res402({ accepts: [] })), /accepts/);
});

test("parse402 rejects a requirement missing an amount", async () => {
  await assert.rejects(() => parse402(res402({ accepts: [{ payTo: "GMERCHANT" }] })), /missing an amount/);
});

test("parse402 rejects a requirement missing payTo (the merchant)", async () => {
  await assert.rejects(() => parse402(res402({ accepts: [{ maxAmountRequired: "1.00" }] })), /payTo/);
});

const BOUND_CHALLENGE: BoundPaymentChallengeV2 = {
  proofVersion: 2,
  challengeId: Buffer.alloc(32, 1).toString("base64url"),
  audience: "https://merchant.example",
  scheme: BOUND_PAYMENT_SCHEME,
  method: "GET",
  resource: "/source/market?format=json",
  bodySha256: null,
  network: "stellar-testnet",
  networkId: "1".repeat(64),
  registryId: "CREGISTRY",
  merchant: "GMERCHANT",
  asset: "CASSET",
  amountStroops: "10000000",
  decimals: 7,
  issuedAt: 1_700_000_000,
  expiresAt: 1_700_000_900,
  authorization: {
    algorithm: "hmac-sha256",
    mac: Buffer.alloc(32, 2).toString("base64"),
  },
};

test("bound-v2 proof strictly round-trips and verifies only for the on-chain agent", () => {
  const agent = Keypair.random();
  const stranger = Keypair.random();
  const proof = createBoundPaymentProof({
    challenge: BOUND_CHALLENGE,
    txHash: "a".repeat(64),
    mandateId: "b".repeat(64),
    signer: agent,
  });
  const decoded = decodePaymentProof(encodePaymentProof(proof));
  assert.deepEqual(decoded, proof);
  assert.equal(verifyBoundPaymentProofSignature(proof, agent.publicKey()), true);
  assert.equal(verifyBoundPaymentProofSignature(proof, stranger.publicKey()), false);
});

test("bound-v2 signature binds the request, mandate, and transaction", () => {
  const agent = Keypair.random();
  const proof = createBoundPaymentProof({
    challenge: BOUND_CHALLENGE,
    txHash: "a".repeat(64),
    mandateId: "b".repeat(64),
    signer: agent,
  });
  const variants = [
    { ...proof, txHash: "c".repeat(64) },
    { ...proof, mandateId: "d".repeat(64) },
    { ...proof, challenge: { ...proof.challenge, resource: "/source/other" } },
    { ...proof, challenge: { ...proof.challenge, audience: "https://other.example" } },
    { ...proof, challenge: { ...proof.challenge, amountStroops: "20000000" } },
  ];
  for (const variant of variants) {
    assert.equal(verifyBoundPaymentProofSignature(variant, agent.publicKey()), false);
  }
});

test("bound-v2 decoder rejects unknown fields and noncanonical encodings", () => {
  const agent = Keypair.random();
  const proof = createBoundPaymentProof({
    challenge: BOUND_CHALLENGE,
    txHash: "a".repeat(64),
    mandateId: "b".repeat(64),
    signer: agent,
  });
  assert.throws(
    () => decodePaymentProof(b64({ ...proof, surprise: true })),
    /missing or unknown fields/,
  );
  assert.throws(
    () => decodePaymentProof(b64({
      ...proof,
      txHash: proof.txHash.toUpperCase(),
    })),
    /32-byte hex/,
  );
  assert.throws(
    () => decodePaymentProof(b64({
      ...proof,
      challenge: { ...proof.challenge, challengeId: `${"A".repeat(42)}B` },
    })),
    /challengeId/,
  );
  assert.throws(
    () => decodePaymentProof(b64({
      ...proof,
      authorization: { ...proof.authorization, signature: "not-base64" },
    })),
    /canonical base64/,
  );
  assert.throws(
    () => decodePaymentProof(b64({ ...proof, scheme: "attacker-scheme" })),
    /do not match the signed challenge/,
  );
  assert.throws(
    () => decodePaymentProof(b64({ ...proof, network: "attacker-network" })),
    /do not match the signed challenge/,
  );
  assert.throws(
    () => decodePaymentProof(`${encodePaymentProof(proof)}\n`),
    /canonical base64/,
  );
  assert.throws(
    () => decodePaymentProof(b64({
      proofVersion: 3,
      scheme: "future",
      network: "future",
      txHash: proof.txHash,
      mandateId: proof.mandateId,
      amount: "1.00",
      futureAuthorization: {},
    })),
    /unsupported payment proof version/,
  );
  assert.throws(
    () => decodePaymentProof(b64({
      scheme: "reapp-soroban",
      network: "stellar-testnet",
      txHash: proof.txHash,
      mandateId: proof.mandateId,
      amount: "1.00",
      ignored: true,
    })),
    /missing or unknown fields/,
  );
});

test("parse402 rejects unsupported advertised REAPP proof versions", async () => {
  await assert.rejects(
    () => parse402(res402({
      accepts: [{
        maxAmountRequired: "1.00",
        payTo: "GMERCHANT",
        extra: { reappProofVersion: 3, challenge: {} },
      }],
    })),
    /unsupported REAPP payment proof version/,
  );
});

test("parse402 exposes a strict bound-v2 challenge without changing legacy output", async () => {
  const requirement = await parse402(res402({
    x402Version: 1,
    accepts: [{
      scheme: BOUND_PAYMENT_SCHEME,
      network: "stellar-testnet",
      maxAmountRequired: "1.00",
      asset: "CASSET",
      payTo: "GMERCHANT",
      resource: BOUND_CHALLENGE.resource,
      extra: {
        contract: "CREGISTRY",
        reappProofVersion: 2,
        challenge: BOUND_CHALLENGE,
      },
    }],
  }));
  assert.equal(requirement.proofVersion, 2);
  assert.deepEqual(requirement.challenge, BOUND_CHALLENGE);
  assert.equal(requirement.scheme, BOUND_PAYMENT_SCHEME);
});
