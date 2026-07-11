import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "buffer";
import { Keypair } from "@stellar/stellar-sdk";
import { reapp } from "@reapp-sdk/core";
import {
  AP2_INTENT_DATA_KEY,
  AP2_SPEC_VERSION,
  REAPP_AP2_BINDING_VERSION,
  bindIntentMandate,
  canonicalizeJson,
  type Ap2IntentMandate,
} from "./index.js";

const user = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const agent = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const merchant = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();

const baseIntent: Ap2IntentMandate = {
  user_cart_confirmation_required: false,
  natural_language_description: "Buy one research dataset",
  merchants: [merchant],
  skus: [],
  requires_refundability: false,
  intent_expiry: "2099-01-01T00:00:00Z",
};

const bind = (intent: Ap2IntentMandate = baseIntent, nonce = "vector-1") =>
  bindIntentMandate({
    intent,
    stellar: {
      user,
      agent,
      asset: reapp.testnet.nativeSac,
      maxAmount: "5.00",
      nonce,
    },
  });

test("canonical JSON is independent of object key insertion order", () => {
  const first = canonicalizeJson({ z: [3, { b: true, a: "x" }], a: 1 });
  const second = canonicalizeJson({ a: 1, z: [3, { a: "x", b: true }] });
  assert.equal(first, second);
  assert.equal(first, '{"a":1,"z":[3,{"a":"x","b":true}]}');
});

test("binds the supported AP2 v0.2.0 intent to a 32-byte REAPP vc_hash", () => {
  const result = bind();
  assert.equal(result.ap2SpecVersion, AP2_SPEC_VERSION);
  assert.equal(result.ap2DataKey, AP2_INTENT_DATA_KEY);
  assert.equal(result.bindingVersion, REAPP_AP2_BINDING_VERSION);
  assert.equal(result.normalizedIntent.merchants[0], merchant);
  assert.equal(result.mandate.merchant, merchant);
  assert.equal(result.mandate.expiry, 4_070_908_800);
  assert.equal(result.mandate.id.length, 64);
  assert.equal(result.mandate.idBuffer.length, 32);
  assert.equal(result.mandate.idBuffer.toString("hex"), result.mandate.id);
});

test("pins a canonical AP2 hash vector", () => {
  const result = bind();
  assert.equal(result.intentHash, "1da97a920afae68979bf01a0b1a01d570494ac046eb9e277d53b0c453f4316c1");
});

test("provided nonce makes the full binding reproducible across key order", () => {
  const reordered: Ap2IntentMandate = {
    intent_expiry: baseIntent.intent_expiry,
    requires_refundability: false,
    skus: [],
    merchants: [merchant],
    natural_language_description: baseIntent.natural_language_description,
    user_cart_confirmation_required: false,
  };
  const first = bind(baseIntent, "repeatable");
  const second = bind(reordered, "repeatable");
  assert.equal(first.canonicalIntent, second.canonicalIntent);
  assert.equal(first.intentHash, second.intentHash);
  assert.equal(first.mandate.id, second.mandate.id);
});

test("secure default nonces keep identical intents distinct", () => {
  const first = bindIntentMandate({
    intent: baseIntent,
    stellar: { user, agent, asset: reapp.testnet.nativeSac, maxAmount: "5.00" },
  });
  const second = bindIntentMandate({
    intent: baseIntent,
    stellar: { user, agent, asset: reapp.testnet.nativeSac, maxAmount: "5.00" },
  });
  assert.equal(first.intentHash, second.intentHash);
  assert.notEqual(first.bindingNonce, second.bindingNonce);
  assert.notEqual(first.mandate.id, second.mandate.id);
});

test("fails closed for AP2 constraints MandateRegistry cannot enforce", () => {
  assert.throws(
    () => bind({ ...baseIntent, user_cart_confirmation_required: true }),
    /user_cart_confirmation_required=false/,
  );
  assert.throws(
    () => bind({ ...baseIntent, merchants: [] }),
    /exactly one Stellar merchant/,
  );
  assert.throws(
    () => bind({ ...baseIntent, merchants: [merchant, user] }),
    /exactly one Stellar merchant/,
  );
  assert.throws(
    () => bind({ ...baseIntent, skus: ["SKU-1"] }),
    /does not enforce SKU/,
  );
  assert.throws(
    () => bind({ ...baseIntent, requires_refundability: true }),
    /does not enforce refundability/,
  );
});

test("rejects ambiguous expiry and invalid Stellar authorization", () => {
  assert.throws(
    () => bind({ ...baseIntent, intent_expiry: "2099-01-01T00:00:00.001Z" }),
    /whole-second precision/,
  );
  assert.throws(
    () => bind({ ...baseIntent, intent_expiry: "2020-01-01T00:00:00Z" }),
    /future Unix timestamp/,
  );
  assert.throws(
    () =>
      bindIntentMandate({
        intent: baseIntent,
        stellar: { user: "not-an-address", agent, asset: reapp.testnet.nativeSac, maxAmount: "5.00" },
      }),
    /stellar.user must be a valid Stellar address/,
  );
  assert.throws(
    () =>
      bindIntentMandate({
        intent: baseIntent,
        stellar: { user, agent, asset: merchant, maxAmount: "5.00" },
      }),
    /stellar.asset must be a valid Stellar contract address/,
  );
});
