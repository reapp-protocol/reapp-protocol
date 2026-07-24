import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "buffer";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { reapp } from "@reapp-sdk/core";
import {
  AP2_OPEN_PAYMENT_VCT,
  AP2_SPEC_VERSION,
  REAPP_AP2_BINDING_VERSION,
  bindPaymentMandate,
  canonicalizeJson,
  type Ap2OpenPaymentMandate,
  type BindPaymentMandateInput,
} from "./index.js";

const user = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const agent = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const merchant = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();
const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey();
const agentJwk = {
  kty: "OKP" as const,
  crv: "Ed25519" as const,
  x: Buffer.from(StrKey.decodeEd25519PublicKey(agent)).toString("base64url"),
};

const basePaymentMandate: Ap2OpenPaymentMandate = {
  vct: AP2_OPEN_PAYMENT_VCT,
  constraints: [
    {
      type: "payment.allowed_payees",
      allowed: [{ id: merchant, name: "Research Merchant", website: "https://merchant.example/" }],
    },
    { type: "payment.amount_range", currency: "USD", max: 500 },
    { type: "payment.agent_recurrence", frequency: "ON_DEMAND" },
    { type: "payment.budget", currency: "USD", max: 5 },
    { type: "payment.execution_date", not_after: "2099-01-01T00:00:00Z" },
    { type: "payment.reference", conditional_transaction_id: "checkout-sha256-vector" },
  ],
  cnf: { jwk: agentJwk },
  exp: 4_070_908_800,
};

const baseInput: BindPaymentMandateInput = {
  paymentMandate: basePaymentMandate,
  stellar: {
    user,
    agent,
    asset: reapp.testnet.nativeSac,
    decimals: 7,
    currencyDecimals: 2,
    nonce: "vector-1",
  },
};

const bind = (paymentMandate = basePaymentMandate, nonce = "vector-1") =>
  bindPaymentMandate({
    paymentMandate,
    stellar: { ...baseInput.stellar, nonce },
  });

test("canonical JSON is independent of object key insertion order", () => {
  const first = canonicalizeJson({ z: [3, { b: true, a: "x" }], a: 1 });
  const second = canonicalizeJson({ a: 1, z: [3, { a: "x", b: true }] });
  assert.equal(first, second);
  assert.equal(first, '{"a":1,"z":[3,{"a":"x","b":true}]}');
});

test("binds the supported AP2 v0.2 open payment mandate to REAPP", () => {
  const result = bind();
  assert.equal(result.ap2SpecVersion, AP2_SPEC_VERSION);
  assert.equal(result.ap2Vct, AP2_OPEN_PAYMENT_VCT);
  assert.equal(result.bindingVersion, REAPP_AP2_BINDING_VERSION);
  assert.equal(result.mandate.merchant, merchant);
  assert.equal(result.mandate.maxAmount, 50_000_000n);
  assert.equal(result.mandate.expiry, 4_070_908_800);
  assert.equal(result.paymentMandateHash.length, 64);
  assert.equal(result.mandate.idBuffer.length, 32);
});

test("canonical constraint order makes input array order irrelevant", () => {
  const reversed = { ...basePaymentMandate, constraints: [...basePaymentMandate.constraints].reverse() };
  const first = bind();
  const second = bind(reversed);
  assert.equal(first.canonicalPaymentMandate, second.canonicalPaymentMandate);
  assert.equal(first.paymentMandateHash, second.paymentMandateHash);
  assert.equal(first.mandate.id, second.mandate.id);
});

test("secure default nonces keep identical mandates distinct", () => {
  const stellar = { ...baseInput.stellar };
  delete stellar.nonce;
  const first = bindPaymentMandate({ paymentMandate: basePaymentMandate, stellar });
  const second = bindPaymentMandate({ paymentMandate: basePaymentMandate, stellar });
  assert.equal(first.paymentMandateHash, second.paymentMandateHash);
  assert.notEqual(first.bindingNonce, second.bindingNonce);
  assert.notEqual(first.mandate.id, second.mandate.id);
});

test("requires the exact v0.2 mandate type and supported constraint set", () => {
  assert.throws(
    () => bind({ ...basePaymentMandate, vct: "mandate.payment.open.2" as typeof AP2_OPEN_PAYMENT_VCT }),
    /vct must be mandate\.payment\.open\.1/,
  );
  assert.throws(
    () => bind({
      ...basePaymentMandate,
      constraints: [...basePaymentMandate.constraints, { type: "payment.allowed_pisps", allowed: [] }],
    }),
    /unsupported constraint payment\.allowed_pisps/,
  );
  assert.throws(
    () => bind({
      ...basePaymentMandate,
      constraints: basePaymentMandate.constraints.filter(({ type }) => type !== "payment.reference"),
    }),
    /requires constraint payment\.reference/,
  );
});

test("requires exactly one Stellar payee", () => {
  const constraints = basePaymentMandate.constraints.map((constraint) =>
    constraint.type === "payment.allowed_payees"
      ? { ...constraint, allowed: [{ id: merchant, name: "A" }, { id: other, name: "B" }] }
      : constraint);
  assert.throws(() => bind({ ...basePaymentMandate, constraints }), /exactly one Stellar merchant/);
});

test("requires matching amount range and cumulative budget", () => {
  const constraints = basePaymentMandate.constraints.map((constraint) =>
    constraint.type === "payment.budget" ? { ...constraint, max: 6 } : constraint);
  assert.throws(() => bind({ ...basePaymentMandate, constraints }), /must equal payment\.amount_range\.max/);
});

test("accepts exact decimal budgets without binary floating-point rejection", () => {
  const constraints = basePaymentMandate.constraints.map((constraint) => {
    if (constraint.type === "payment.amount_range") return { ...constraint, max: 29 };
    if (constraint.type === "payment.budget") return { ...constraint, max: 0.29 };
    return constraint;
  });
  const result = bind({ ...basePaymentMandate, constraints });
  assert.equal(result.mandate.maxAmount, 2_900_000n);
});

test("rejects unenforceable recurrence, minimum, and start time", () => {
  const replace = (type: string, replacement: Record<string, unknown>) => ({
    ...basePaymentMandate,
    constraints: basePaymentMandate.constraints.map((constraint) =>
      constraint.type === type ? replacement : constraint),
  });
  assert.throws(
    () => bind(replace("payment.agent_recurrence", {
      type: "payment.agent_recurrence",
      frequency: "DAILY",
    }) as Ap2OpenPaymentMandate),
    /must be ON_DEMAND/,
  );
  assert.throws(
    () => bind(replace("payment.amount_range", {
      type: "payment.amount_range",
      currency: "USD",
      min: 100,
      max: 500,
    }) as Ap2OpenPaymentMandate),
    /minimum-payment policy/,
  );
  assert.throws(
    () => bind(replace("payment.execution_date", {
      type: "payment.execution_date",
      not_before: "2098-01-01T00:00:00Z",
      not_after: "2099-01-01T00:00:00Z",
    }) as Ap2OpenPaymentMandate),
    /not_before is unsupported/,
  );
});

test("requires cnf to bind the Stellar agent's Ed25519 key", () => {
  const badX = Buffer.from(StrKey.decodeEd25519PublicKey(other)).toString("base64url");
  assert.throws(
    () => bind({ ...basePaymentMandate, cnf: { jwk: { ...agentJwk, x: badX } } }),
    /Ed25519 JWK for stellar\.agent/,
  );
});

test("requires exp and execution-date expiry to match", () => {
  assert.throws(() => bind({ ...basePaymentMandate, exp: 4_070_908_799 }), /exp must equal/);
  const constraints = basePaymentMandate.constraints.map((constraint) =>
    constraint.type === "payment.execution_date"
      ? { ...constraint, not_after: "2099-02-30T00:00:00Z" }
      : constraint);
  assert.throws(
    () => bind({ ...basePaymentMandate, constraints, exp: 4_076_006_400 }),
    /real calendar timestamp/,
  );
});

test("rejects unknown top-level and Stellar fields", () => {
  assert.throws(
    () => bind({ ...basePaymentMandate, risk_data: {} } as Ap2OpenPaymentMandate),
    /unsupported field "risk_data"/,
  );
  assert.throws(
    () => bindPaymentMandate({
      ...baseInput,
      stellar: { ...baseInput.stellar, future: true } as BindPaymentMandateInput["stellar"],
    }),
    /unsupported field "future"/,
  );
});
