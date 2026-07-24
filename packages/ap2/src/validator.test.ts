import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "buffer";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { reapp } from "@reapp-sdk/core";
import {
  AP2_OPEN_PAYMENT_VCT,
  AP2_V01_INTENT_DATA_KEY,
  AP2_V01_SPEC_VERSION,
  Ap2ValidationError,
  InMemoryAp2ReplayStore,
  REAPP_AP2_V01_BINDING_VERSION,
  REAPP_AP2_V01_CREDENTIAL_VERSION,
  REAPP_AP2_V01_SIGNATURE_ALGORITHM,
  REAPP_AP2_SIGNATURE_ALGORITHM,
  ap2V01CredentialSigningDigest,
  createAp2ComplianceValidator,
  rebuildV01CredentialBinding,
  signAp2Mandate,
  type Ap2ReplayRecord,
  type Ap2ReplayResult,
  type Ap2ReplayStore,
  type BindPaymentMandateInput,
  type ReappAp2V01CredentialPayload,
  type SignedAp2V01Mandate,
  type SignedAp2Mandate,
} from "./index.js";
import { ap2CredentialSigningDigest } from "./credential.js";

const userKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11));
const otherUserKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 12));
const agentKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 13));
const merchantKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 14));
const otherMerchantKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 15));
const NOW = 4_000_000_000;
const CHECKOUT_REFERENCE = "checkout-sha256-validator-vector";

const baseInput: BindPaymentMandateInput = {
  paymentMandate: {
    vct: AP2_OPEN_PAYMENT_VCT,
    constraints: [
      {
        type: "payment.allowed_payees",
        allowed: [{ id: merchantKey.publicKey(), name: "Research Merchant" }],
      },
      { type: "payment.amount_range", currency: "USD", max: 500 },
      { type: "payment.agent_recurrence", frequency: "ON_DEMAND" },
      { type: "payment.budget", currency: "USD", max: 5 },
      { type: "payment.execution_date", not_after: "2099-01-01T00:00:00Z" },
      { type: "payment.reference", conditional_transaction_id: CHECKOUT_REFERENCE },
    ],
    cnf: {
      jwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(StrKey.decodeEd25519PublicKey(agentKey.publicKey())).toString("base64url"),
      },
    },
    exp: 4_070_908_800,
  },
  stellar: {
    user: userKey.publicKey(),
    agent: agentKey.publicKey(),
    asset: reapp.testnet.nativeSac,
    decimals: 7,
    currencyDecimals: 2,
    nonce: "validator-vector-1",
  },
};

const signed = (input: BindPaymentMandateInput = baseInput) => signAp2Mandate(input, userKey);
const mutable = (credential: Readonly<SignedAp2Mandate> = signed()): SignedAp2Mandate =>
  structuredClone(credential) as SignedAp2Mandate;
const tampered = (mutate: (credential: SignedAp2Mandate) => void): SignedAp2Mandate => {
  const credential = mutable();
  mutate(credential);
  return credential;
};
const validator = (
  replayStore: Ap2ReplayStore = new InMemoryAp2ReplayStore(),
  replayNamespace = "stellar-testnet:CC6JMPDH",
  now = NOW,
) => createAp2ComplianceValidator({ replayStore, replayNamespace, now: () => now });
const request = (credential: unknown = signed(), amount = "1.00") => ({
  credential,
  expectedUser: userKey.publicKey(),
  merchant: merchantKey.publicKey(),
  checkoutReference: CHECKOUT_REFERENCE,
  amount,
});

function signedV01(): SignedAp2V01Mandate {
  const payload: ReappAp2V01CredentialPayload = {
    ap2SpecVersion: AP2_V01_SPEC_VERSION,
    ap2DataKey: AP2_V01_INTENT_DATA_KEY,
    bindingVersion: REAPP_AP2_V01_BINDING_VERSION,
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
      nonce: "legacy-validator-vector-1",
    },
  };
  const mandateHash = rebuildV01CredentialBinding(payload).mandate.id;
  return {
    credentialVersion: REAPP_AP2_V01_CREDENTIAL_VERSION,
    payload,
    mandateHash,
    signature: {
      algorithm: REAPP_AP2_V01_SIGNATURE_ALGORITHM,
      value: userKey.sign(
        ap2V01CredentialSigningDigest(
          REAPP_AP2_V01_CREDENTIAL_VERSION,
          payload,
          mandateHash,
        ),
      ).toString("base64"),
    },
  };
}

const requestV01 = (credential: unknown = signedV01(), amount = "1.00") => ({
  credential,
  expectedUser: userKey.publicKey(),
  merchant: merchantKey.publicKey(),
  amount,
});

async function expectCode(
  promise: Promise<unknown>,
  code: Ap2ValidationError["code"],
): Promise<void> {
  try {
    await promise;
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.ok(error instanceof Ap2ValidationError);
    assert.equal(error.code, code);
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

test("valid signed AP2 v0.2 mandate succeeds and rebuilds the same REAPP id", async () => {
  const result = await validator().validateAndConsume(request());
  assert.equal(result.binding.mandate.id, result.mandateHash);
  assert.equal(result.amountStroops, 10_000_000n);
  assert.equal(result.acceptedAt, NOW);
});

test("valid AP2 v0.1 IntentMandate is admitted with legacy semantics", async () => {
  const credential = signedV01();
  const result = await validator().validateAndConsume({
    credential,
    expectedUser: userKey.publicKey(),
    merchant: merchantKey.publicKey(),
    amount: "1.00",
  });
  assert.equal(result.credential.payload.ap2SpecVersion, "0.1.0");
  assert.equal(result.binding.mandate.id, credential.mandateHash);
  assert.equal(result.amountStroops, 10_000_000n);
});

test("AP2 v0.1 rejects a signature from another key", async () => {
  const badSignature = structuredClone(signedV01());
  badSignature.signature.value = otherUserKey.sign(
    ap2V01CredentialSigningDigest(
      badSignature.credentialVersion,
      badSignature.payload,
      badSignature.mandateHash,
    ),
  ).toString("base64");
  await expectCode(validator().validateAndConsume(requestV01(badSignature)), "INVALID_SIGNATURE");
});

test("AP2 v0.1 rejects a merchant outside the signed scope", async () => {
  await expectCode(
    validator().validateAndConsume({ ...requestV01(), merchant: otherMerchantKey.publicKey() }),
    "MERCHANT_MISMATCH",
  );
});

test("AP2 v0.1 rejects replayed mandate hashes", async () => {
  const check = validator();
  const legacyRequest = requestV01();
  await check.validateAndConsume(legacyRequest);
  await expectCode(check.validateAndConsume(legacyRequest), "REPLAYED");
});

test("fixed seed and nonce produce a deterministic signature", () => {
  const first = signed();
  const second = signed();
  const digest = ap2CredentialSigningDigest(first.credentialVersion, first.payload, first.mandateHash);
  assert.equal(digest.length, 32);
  assert.equal(first.mandateHash, "dfb015530a199321e7acab0cc4ebbcc8614e90191bd57101233ffdd00f05a2d6");
  assert.equal(digest.toString("hex"), "346ddb50d625580d58eb38c8440e4ccc91d6a29ee68e79fe101ebe787db56d2c");
  assert.equal(
    first.signature.value,
    "8Ve367LgqxXTSte181ggKU2+IR3hpVlLTITMsqzLEka4Xr6tLjY52grk2gSw1tr7lGbzLmrjy3UEiEYYJ/4+Cw==",
  );
  assert.equal(first.mandateHash, second.mandateHash);
  assert.equal(first.signature.value, second.signature.value);
  assert.equal(first.signature.algorithm, REAPP_AP2_SIGNATURE_ALGORITHM);
});

test("signing key must match the signed Stellar user", () => {
  assert.throws(() => signAp2Mandate(baseInput, otherUserKey), /must match stellar\.user/);
});

test("trusted expected user must match the signed user", async () => {
  await expectCode(
    validator().validateAndConsume({ ...request(), expectedUser: otherUserKey.publicKey() }),
    "SIGNER_MISMATCH",
  );
});

test("tampered payee fails the signed mandate binding", async () => {
  const credential = tampered((value) => {
    value.payload.paymentMandate.constraints[0].allowed[0].id = otherMerchantKey.publicKey();
  });
  await expectCode(validator().validateAndConsume(request(credential)), "BINDING_MISMATCH");
});

test("tampered budget fails closed", async () => {
  const credential = tampered((value) => {
    value.payload.paymentMandate.constraints[3].max = 500;
  });
  await expectCode(validator().validateAndConsume(request(credential)), "INVALID_CREDENTIAL");
});

test("tampered expiry fails closed", async () => {
  const credential = tampered((value) => {
    value.payload.paymentMandate.exp -= 1;
  });
  await expectCode(validator().validateAndConsume(request(credential)), "INVALID_CREDENTIAL");
});

test("tampered agent fails closed", async () => {
  const credential = tampered((value) => {
    value.payload.stellar.agent = otherUserKey.publicKey();
  });
  await expectCode(validator().validateAndConsume(request(credential)), "INVALID_CREDENTIAL");
});

test("tampered asset fails closed", async () => {
  const credential = tampered((value) => {
    value.payload.stellar.asset = merchantKey.publicKey();
  });
  await expectCode(validator().validateAndConsume(request(credential)), "INVALID_CREDENTIAL");
});

test("signature created by another key is rejected", async () => {
  const badSignature = mutable();
  badSignature.signature.value = otherUserKey
    .sign(ap2CredentialSigningDigest(
      badSignature.credentialVersion,
      badSignature.payload,
      badSignature.mandateHash,
    ))
    .toString("base64");
  await expectCode(validator().validateAndConsume(request(badSignature)), "INVALID_SIGNATURE");
});

test("malformed signature encoding is rejected", async () => {
  const malformed = mutable();
  malformed.signature.value = "not-base64";
  await expectCode(validator().validateAndConsume(request(malformed)), "INVALID_SIGNATURE");
});

test("unknown AP2 credential versions are rejected", async () => {
  const credential = tampered((value) => {
    value.credentialVersion = "reapp-ap2-credential/3" as typeof value.credentialVersion;
  });
  await expectCode(validator().validateAndConsume(request(credential)), "UNSUPPORTED_VERSION");
});

test("cross-version AP2 spec fields are rejected", async () => {
  const credential = tampered((value) => {
    value.payload.ap2SpecVersion = "0.1.0" as typeof value.payload.ap2SpecVersion;
  });
  await expectCode(validator().validateAndConsume(request(credential)), "UNSUPPORTED_VERSION");
});

test("cross-version REAPP binding fields are rejected", async () => {
  const credential = tampered((value) => {
    value.payload.bindingVersion = "reapp-ap2/1" as typeof value.payload.bindingVersion;
  });
  await expectCode(validator().validateAndConsume(request(credential)), "UNSUPPORTED_VERSION");
});

test("cross-version AP2 mandate types are rejected", async () => {
  const credential = tampered((value) => {
    value.payload.ap2Vct = "ap2.mandates.IntentMandate" as typeof value.payload.ap2Vct;
  });
  await expectCode(validator().validateAndConsume(request(credential)), "UNSUPPORTED_VERSION");
});

test("trusted merchant must match the signed scope", async () => {
  await expectCode(
    validator().validateAndConsume({ ...request(), merchant: otherMerchantKey.publicKey() }),
    "MERCHANT_MISMATCH",
  );
});

test("trusted checkout reference must match the signed reference", async () => {
  await expectCode(
    validator().validateAndConsume({ ...request(), checkoutReference: "other-checkout" }),
    "CHECKOUT_REFERENCE_MISMATCH",
  );
});

test("amount exactly equal to the signed maximum succeeds", async () => {
  assert.equal(
    (await validator().validateAndConsume(request(signed(), "5.00"))).amountStroops,
    50_000_000n,
  );
});

test("one stroop over the signed maximum is rejected as overspend", async () => {
  await expectCode(validator().validateAndConsume(request(signed(), "5.0000001")), "AMOUNT_EXCEEDS_MANDATE");
});

test("zero payment amount is rejected", async () => {
  await expectCode(validator().validateAndConsume(request(signed(), "0")), "INVALID_AMOUNT");
});

test("scientific-notation payment amount is rejected", async () => {
  await expectCode(validator().validateAndConsume(request(signed(), "1e2")), "INVALID_AMOUNT");
});

test("expiry equal to the trusted clock is rejected", async () => {
  await expectCode(
    validator(new InMemoryAp2ReplayStore(), "test", 4_070_908_800).validateAndConsume(request()),
    "EXPIRED",
  );
});

test("expiry before the trusted clock is rejected", async () => {
  await expectCode(
    validator(new InMemoryAp2ReplayStore(), "test", 4_070_908_801).validateAndConsume(request()),
    "EXPIRED",
  );
});

test("replay admission is atomic under concurrency", async () => {
  const store = new InMemoryAp2ReplayStore();
  const check = validator(store);
  const outcomes = await Promise.allSettled(
    Array.from({ length: 100 }, () => check.validateAndConsume(request())),
  );
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 99);
  assert.equal(store.size, 1);
});

test("replay store outages fail closed", async () => {
  const unavailable: Ap2ReplayStore = {
    consumeOnce() {
      throw new Error("database unavailable");
    },
  };
  await expectCode(validator(unavailable).validateAndConsume(request()), "REPLAY_STORE_UNAVAILABLE");
});

test("invalid credentials do not poison replay state", async () => {
  const store = new CountingStore();
  const credential = mutable();
  credential.signature.value = Buffer.alloc(64).toString("base64");
  await expectCode(validator(store).validateAndConsume(request(credential)), "INVALID_SIGNATURE");
  assert.equal(store.calls, 0);
});
