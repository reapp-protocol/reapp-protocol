import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "buffer";
import { Keypair } from "@stellar/stellar-sdk";
import { reapp } from "@reapp-sdk/core";
import {
  Ap2ValidationError,
  InMemoryAp2ReplayStore,
  REAPP_AP2_SIGNATURE_ALGORITHM,
  createAp2ComplianceValidator,
  signAp2Mandate,
  type Ap2ReplayRecord,
  type Ap2ReplayResult,
  type Ap2ReplayStore,
  type BindIntentMandateInput,
  type SignedAp2Mandate,
} from "./index.js";
import { ap2CredentialSigningDigest } from "./credential.js";

const userKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11));
const otherUserKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 12));
const agentKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 13));
const merchantKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 14));
const otherMerchantKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 15));
const NOW = 4_000_000_000;

const baseInput: BindIntentMandateInput = {
  intent: {
    user_cart_confirmation_required: false,
    natural_language_description: "Buy one research dataset",
    merchants: [merchantKey.publicKey()],
    skus: [],
    requires_refundability: false,
    intent_expiry: "2099-01-01T00:00:00Z",
  },
  stellar: {
    user: userKey.publicKey(),
    agent: agentKey.publicKey(),
    asset: reapp.testnet.nativeSac,
    maxAmount: "5.00",
    decimals: 7,
    nonce: "validator-vector-1",
  },
};

const signed = (input: BindIntentMandateInput = baseInput) => signAp2Mandate(input, userKey);

const mutable = (credential: Readonly<SignedAp2Mandate> = signed()): SignedAp2Mandate =>
  structuredClone(credential) as SignedAp2Mandate;

const validator = (
  replayStore: Ap2ReplayStore = new InMemoryAp2ReplayStore(),
  replayNamespace = "stellar-testnet:CC6JMPDH",
  now = NOW,
) => createAp2ComplianceValidator({ replayStore, replayNamespace, now: () => now });

const request = (credential: unknown = signed(), amount = "1.00") => ({
  credential,
  expectedUser: userKey.publicKey(),
  merchant: merchantKey.publicKey(),
  amount,
});

async function expectCode(
  promise: Promise<unknown>,
  code: Ap2ValidationError["code"],
): Promise<Ap2ValidationError> {
  try {
    await promise;
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.ok(error instanceof Ap2ValidationError);
    assert.equal(error.code, code);
    return error;
  }
}

class CountingStore implements Ap2ReplayStore {
  calls = 0;
  result: Ap2ReplayResult = "consumed";

  consumeOnce(_record: Readonly<Ap2ReplayRecord>): Ap2ReplayResult {
    this.calls += 1;
    return this.result;
  }
}

test("valid signed AP2 mandate succeeds", async () => {
  const result = await validator().validateAndConsume(request());
  assert.equal(result.mandateHash, signed().mandateHash);
  assert.equal(result.amountStroops, 10_000_000n);
  assert.equal(result.acceptedAt, NOW);
});

test("returned mandate hash equals the recomputed REAPP id", async () => {
  const result = await validator().validateAndConsume(request());
  assert.equal(result.binding.mandate.id, result.mandateHash);
  assert.equal(result.binding.mandate.idBuffer.toString("hex"), result.mandateHash);
});

test("fixed seed and nonce produce a deterministic signature digest and signature", () => {
  const first = signed();
  const second = signed();
  const digest = ap2CredentialSigningDigest(
    first.credentialVersion,
    first.payload,
    first.mandateHash,
  );
  assert.equal(digest.length, 32);
  assert.equal(first.mandateHash, "f2c3f0063aa31ca4c7a78ffb19e4afa533a7e380ef175c22f71720154d6ae796");
  assert.equal(digest.toString("hex"), "e38d15c1b2f3271cf4c702c59dffb9ee2d52cadc5b4146d4c9d8ea2922716ded");
  assert.equal(
    first.signature.value,
    "hxX8IZJq7FUs3qaQjdaGTCUUsLzpTL4vl5DxivIQJqAcemYqMO//NDj3IXsEYIQw+qZTI2ZfQcQxhQFWA6zKDg==",
  );
  assert.equal(first.mandateHash, second.mandateHash);
  assert.equal(first.signature.value, second.signature.value);
  assert.equal(first.signature.algorithm, REAPP_AP2_SIGNATURE_ALGORITHM);
});

test("exact signed maximum amount succeeds", async () => {
  const result = await validator().validateAndConsume(request(signed(), "5.00"));
  assert.equal(result.amountStroops, 50_000_000n);
});

test("one-stroop positive amount succeeds", async () => {
  const result = await validator().validateAndConsume(request(signed(), "0.0000001"));
  assert.equal(result.amountStroops, 1n);
});

test("signing key must match the payload user", () => {
  assert.throws(
    () => signAp2Mandate(baseInput, otherUserKey),
    /signing key must match stellar.user/,
  );
});

test("trusted expected user mismatch is rejected", async () => {
  const input = { ...request(), expectedUser: otherUserKey.publicKey() };
  await expectCode(validator().validateAndConsume(input), "SIGNER_MISMATCH");
});

test("tampered natural-language intent is rejected by binding", async () => {
  const credential = mutable();
  credential.payload.intent.natural_language_description = "Buy everything";
  await expectCode(validator().validateAndConsume(request(credential)), "BINDING_MISMATCH");
});

test("tampered merchant is rejected by binding", async () => {
  const credential = mutable();
  credential.payload.intent.merchants[0] = otherMerchantKey.publicKey();
  await expectCode(validator().validateAndConsume(request(credential)), "BINDING_MISMATCH");
});

test("tampered maximum amount is rejected by binding", async () => {
  const credential = mutable();
  credential.payload.stellar.maxAmount = "500.00";
  await expectCode(validator().validateAndConsume(request(credential)), "BINDING_MISMATCH");
});

test("tampered decimals are rejected by the full-payload signature", async () => {
  const credential = mutable();
  credential.payload.stellar.decimals = 6;
  await expectCode(validator().validateAndConsume(request(credential)), "INVALID_SIGNATURE");
});

test("tampered expiry is rejected by binding", async () => {
  const credential = mutable();
  credential.payload.intent.intent_expiry = "2098-01-01T00:00:00Z";
  await expectCode(validator().validateAndConsume(request(credential)), "BINDING_MISMATCH");
});

test("tampered agent is rejected by binding", async () => {
  const credential = mutable();
  credential.payload.stellar.agent = otherUserKey.publicKey();
  await expectCode(validator().validateAndConsume(request(credential)), "BINDING_MISMATCH");
});

test("tampered asset is rejected before signature verification", async () => {
  const credential = mutable();
  credential.payload.stellar.asset = merchantKey.publicKey();
  await expectCode(validator().validateAndConsume(request(credential)), "INVALID_CREDENTIAL");
});

test("malformed base64 signature is rejected", async () => {
  const credential = mutable();
  credential.signature.value = "not-base64";
  await expectCode(validator().validateAndConsume(request(credential)), "INVALID_SIGNATURE");
});

test("non-canonical base64 signature is rejected", async () => {
  const credential = mutable();
  credential.signature.value = credential.signature.value.replace(/==$/, "");
  await expectCode(validator().validateAndConsume(request(credential)), "INVALID_SIGNATURE");
});

test("signature with the wrong decoded length is rejected", async () => {
  const credential = mutable();
  credential.signature.value = Buffer.alloc(63).toString("base64");
  await expectCode(validator().validateAndConsume(request(credential)), "INVALID_SIGNATURE");
});

test("signature created by another Ed25519 key is rejected", async () => {
  const credential = mutable();
  const digest = ap2CredentialSigningDigest(
    credential.credentialVersion,
    credential.payload,
    credential.mandateHash,
  );
  credential.signature.value = otherUserKey.sign(digest).toString("base64");
  await expectCode(validator().validateAndConsume(request(credential)), "INVALID_SIGNATURE");
});

test("unsupported signature algorithm is rejected", async () => {
  const credential = mutable();
  credential.signature.algorithm = "ed25519" as typeof credential.signature.algorithm;
  await expectCode(validator().validateAndConsume(request(credential)), "UNSUPPORTED_VERSION");
});

test("unsupported credential version is rejected", async () => {
  const credential = mutable();
  credential.credentialVersion = "reapp-ap2-credential/2" as typeof credential.credentialVersion;
  await expectCode(validator().validateAndConsume(request(credential)), "UNSUPPORTED_VERSION");
});

test("unsupported AP2 version is rejected", async () => {
  const credential = mutable();
  credential.payload.ap2SpecVersion = "0.3.0" as typeof credential.payload.ap2SpecVersion;
  await expectCode(validator().validateAndConsume(request(credential)), "UNSUPPORTED_VERSION");
});

test("unsupported REAPP binding version is rejected", async () => {
  const credential = mutable();
  credential.payload.bindingVersion = "reapp-ap2/2" as typeof credential.payload.bindingVersion;
  await expectCode(validator().validateAndConsume(request(credential)), "UNSUPPORTED_VERSION");
});

test("wrong AP2 data key is rejected", async () => {
  const credential = mutable();
  credential.payload.ap2DataKey = "ap2.mandates.Other" as typeof credential.payload.ap2DataKey;
  await expectCode(validator().validateAndConsume(request(credential)), "UNSUPPORTED_VERSION");
});

test("envelope mandate hash mismatch is rejected", async () => {
  const credential = mutable();
  credential.mandateHash = "00".repeat(32);
  await expectCode(validator().validateAndConsume(request(credential)), "BINDING_MISMATCH");
});

test("unknown top-level credential field fails closed", async () => {
  const credential = { ...mutable(), future_constraint: true };
  await expectCode(validator().validateAndConsume(request(credential)), "INVALID_CREDENTIAL");
});

test("unknown intent field fails closed", async () => {
  const credential = mutable() as SignedAp2Mandate & {
    payload: SignedAp2Mandate["payload"] & { intent: Record<string, unknown> };
  };
  credential.payload.intent.future_constraint = true;
  await expectCode(validator().validateAndConsume(request(credential)), "INVALID_CREDENTIAL");
});

test("trusted merchant outside signed scope is rejected", async () => {
  const input = { ...request(), merchant: otherMerchantKey.publicKey() };
  await expectCode(validator().validateAndConsume(input), "MERCHANT_MISMATCH");
});

test("zero amount is rejected", async () => {
  await expectCode(validator().validateAndConsume(request(signed(), "0")), "INVALID_AMOUNT");
});

test("negative amount is rejected", async () => {
  await expectCode(validator().validateAndConsume(request(signed(), "-1")), "INVALID_AMOUNT");
});

test("scientific-notation amount is rejected", async () => {
  await expectCode(validator().validateAndConsume(request(signed(), "1e2")), "INVALID_AMOUNT");
});

test("excess fractional precision is rejected", async () => {
  await expectCode(
    validator().validateAndConsume(request(signed(), "0.00000001")),
    "INVALID_AMOUNT",
  );
});

test("one stroop over the signed maximum is rejected as overspend", async () => {
  await expectCode(
    validator().validateAndConsume(request(signed(), "5.0000001")),
    "AMOUNT_EXCEEDS_MANDATE",
  );
});

test("amount beyond contract i128 is rejected", async () => {
  await expectCode(
    validator().validateAndConsume(request(signed(), "999999999999999999999999999999999999999")),
    "INVALID_AMOUNT",
  );
});

test("expired signed mandate is rejected", async () => {
  await expectCode(
    validator(new InMemoryAp2ReplayStore(), "test", 4_070_908_801).validateAndConsume(request()),
    "EXPIRED",
  );
});

test("expiry exactly equal to the trusted clock is rejected", async () => {
  await expectCode(
    validator(new InMemoryAp2ReplayStore(), "test", 4_070_908_800).validateAndConsume(request()),
    "EXPIRED",
  );
});

test("future expiry succeeds under the injected clock", async () => {
  const result = await validator(new InMemoryAp2ReplayStore(), "test", 4_070_908_799)
    .validateAndConsume(request());
  assert.equal(result.acceptedAt, 4_070_908_799);
});

test("impossible calendar expiry fails closed", async () => {
  const credential = mutable();
  credential.payload.intent.intent_expiry = "2099-02-30T00:00:00Z";
  await expectCode(validator().validateAndConsume(request(credential)), "INVALID_CREDENTIAL");
});

test("replayed mandate hash is rejected on second admission", async () => {
  const store = new InMemoryAp2ReplayStore();
  const check = validator(store);
  await check.validateAndConsume(request());
  await expectCode(check.validateAndConsume(request()), "REPLAYED");
  assert.equal(store.size, 1);
});

test("100 concurrent admissions yield exactly one success", async () => {
  const check = validator(new InMemoryAp2ReplayStore());
  const outcomes = await Promise.allSettled(
    Array.from({ length: 100 }, () => check.validateAndConsume(request())),
  );
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const failures = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  assert.equal(failures.length, 99);
  assert.ok(
    failures.every(
      ({ reason }) => reason instanceof Ap2ValidationError && reason.code === "REPLAYED",
    ),
  );
});

test("replay store exception fails closed", async () => {
  const store: Ap2ReplayStore = {
    consumeOnce() {
      throw new Error("database unavailable");
    },
  };
  await expectCode(validator(store).validateAndConsume(request()), "REPLAY_STORE_UNAVAILABLE");
});

test("unsupported replay store result fails closed", async () => {
  const store = {
    consumeOnce: () => "maybe",
  } as unknown as Ap2ReplayStore;
  await expectCode(validator(store).validateAndConsume(request()), "REPLAY_STORE_UNAVAILABLE");
});

test("bad signature does not poison the replay store", async () => {
  const store = new CountingStore();
  const credential = mutable();
  credential.signature.value = Buffer.alloc(64).toString("base64");
  await expectCode(validator(store).validateAndConsume(request(credential)), "INVALID_SIGNATURE");
  assert.equal(store.calls, 0);
});

test("wrong merchant does not poison the replay store", async () => {
  const store = new CountingStore();
  const input = { ...request(), merchant: otherMerchantKey.publicKey() };
  await expectCode(validator(store).validateAndConsume(input), "MERCHANT_MISMATCH");
  assert.equal(store.calls, 0);
});

test("overspend does not poison the replay store", async () => {
  const store = new CountingStore();
  await expectCode(
    validator(store).validateAndConsume(request(signed(), "6.00")),
    "AMOUNT_EXCEEDS_MANDATE",
  );
  assert.equal(store.calls, 0);
});

test("expired credential does not poison the replay store", async () => {
  const store = new CountingStore();
  await expectCode(
    validator(store, "test", 4_070_908_800).validateAndConsume(request()),
    "EXPIRED",
  );
  assert.equal(store.calls, 0);
});

test("explicit replay namespaces isolate independent registries", async () => {
  const store = new InMemoryAp2ReplayStore();
  await validator(store, "stellar-testnet:registry-a").validateAndConsume(request());
  await validator(store, "stellar-testnet:registry-b").validateAndConsume(request());
  assert.equal(store.size, 2);
});

test("invalid user, agent, and asset identities fail closed", async () => {
  for (const mutateCredential of [
    (credential: SignedAp2Mandate) => { credential.payload.stellar.user = "not-a-key"; },
    (credential: SignedAp2Mandate) => { credential.payload.stellar.agent = "not-a-key"; },
    (credential: SignedAp2Mandate) => { credential.payload.stellar.asset = "not-a-contract"; },
  ]) {
    const credential = mutable();
    mutateCredential(credential);
    await expectCode(validator().validateAndConsume(request(credential)), "INVALID_CREDENTIAL");
  }
});
