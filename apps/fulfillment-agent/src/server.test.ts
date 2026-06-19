import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { xdr } from "@stellar/stellar-sdk";
import { TESTNET } from "@reapp-sdk/stellar";
import {
  extractContractEvents,
  interpretEvents,
  selectPayment,
  ProofLedger,
  type DecodedEvent,
  type PaymentCheck,
} from "./server.ts";

// A real, successful `execute_payment` captured from Stellar testnet via Soroban
// RPC. Decoding it here proves the merchant's verification works against actual
// Soroban output (TransactionMetaV4), not against hand-built XDR that might not
// match reality. See fixtures/payment-meta.json for the source tx hash.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "payment-meta.json"), "utf8"),
) as { txHash: string; metaXdr: string; note: string };

const REGISTRY = TESTNET.mandateRegistryId; // the trusted emitter
const MERCHANT = "GCREL554SPELMSCEIQQVYS2TPDWONZ6AVQXMUNBEGGZ2X5FNYHDC2RZG"; // paid in the fixture
const OTHER = "GAHGD3Q6ZKKJFM4FM5M6DSDNTT6KGCEZRZ2NLBBGILZFSKNUFT7VTORQ"; // a different account
const SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"; // the token contract (not the registry)
const PRICE = 10_000_000n; // 1.00 XLM, the unlock price
const CHECK: PaymentCheck = { merchant: MERCHANT, registryId: REGISTRY, priceStroops: PRICE };

// The golden fixture is a real execute_payment on the source-verified MandateRegistry
// (TESTNET.mandateRegistryId), captured from testnet, with the registry as the trusted emitter.

/** A well-formed decoded payment event from the registry; override per case. */
const paymentEvent = (over: Partial<DecodedEvent> = {}): DecodedEvent => ({
  contractId: REGISTRY,
  topic0: "payment",
  topic1: MERCHANT,
  amount: PRICE,
  ...over,
});

// ---------- golden: the real on-chain payment, decoded end to end ----------

test("golden: the real tx decodes to two events, one emitted by the registry", () => {
  const meta = xdr.TransactionMeta.fromXDR(fixture.metaXdr, "base64");
  const decoded = interpretEvents(extractContractEvents(meta));
  // The tx carries two contract events: the token's transfer and the registry's payment.
  assert.equal(decoded.length, 2);
  const reg = decoded.find((e) => e.contractId === REGISTRY);
  assert.ok(reg, "expected an event emitted by the MandateRegistry");
  assert.equal(reg.topic0, "payment");
  assert.equal(String(reg.topic1), MERCHANT);
  assert.equal(reg.amount, PRICE);
  // The token's own transfer event is present too, and is emitted by a DIFFERENT
  // contract, so the merchant must be able to tell them apart.
  const other = decoded.find((e) => e.contractId !== REGISTRY);
  assert.ok(other, "expected the token's transfer event to also be present");
  assert.notEqual(other.contractId, REGISTRY);
});

test("golden: selectPayment accepts the real payment to this merchant", () => {
  const meta = xdr.TransactionMeta.fromXDR(fixture.metaXdr, "base64");
  const verdict = selectPayment(interpretEvents(extractContractEvents(meta)), CHECK);
  assert.deepEqual(verdict, { ok: true, amount: PRICE });
});

test("golden: the same real tx does NOT unlock for a different merchant", () => {
  const meta = xdr.TransactionMeta.fromXDR(fixture.metaXdr, "base64");
  const verdict = selectPayment(interpretEvents(extractContractEvents(meta)), { ...CHECK, merchant: OTHER });
  assert.equal(verdict.ok, false);
});

// ---------- selectPayment: the security decision, exhaustively ----------

test("accepts a valid registry payment that meets the price", () => {
  assert.deepEqual(selectPayment([paymentEvent()], CHECK), { ok: true, amount: PRICE });
});

test("accepts an overpayment", () => {
  assert.deepEqual(selectPayment([paymentEvent({ amount: PRICE + 5n })], CHECK), { ok: true, amount: PRICE + 5n });
});

test("REJECTS a forged event: right topics and amount, wrong emitting contract", () => {
  // The exact bypass the audit caught: a ("payment", merchant, price) event that
  // would unlock the resource, but emitted by the token (or any attacker) contract.
  assert.equal(selectPayment([paymentEvent({ contractId: SAC })], CHECK).ok, false);
});

test("REJECTS an event with no emitting contract", () => {
  assert.equal(selectPayment([paymentEvent({ contractId: null })], CHECK).ok, false);
});

test("REJECTS a payment to a different merchant", () => {
  assert.equal(selectPayment([paymentEvent({ topic1: OTHER })], CHECK).ok, false);
});

test("REJECTS a non-payment topic from the registry (e.g. transfer)", () => {
  assert.equal(selectPayment([paymentEvent({ topic0: "transfer" })], CHECK).ok, false);
});

test("REJECTS an underpayment, with a clear reason", () => {
  const verdict = selectPayment([paymentEvent({ amount: PRICE - 1n })], CHECK);
  assert.equal(verdict.ok, false);
  assert.match((verdict as { ok: false; reason: string }).reason, /below the price/);
});

test("REJECTS an event whose amount could not be decoded", () => {
  assert.equal(selectPayment([paymentEvent({ amount: null })], CHECK).ok, false);
});

test("REJECTS when there are no events at all", () => {
  const verdict = selectPayment([], CHECK);
  assert.equal(verdict.ok, false);
  assert.match((verdict as { ok: false; reason: string }).reason, /no Soroban contract events/);
});

test("ignores a forged sibling event and still finds the genuine registry payment", () => {
  // Exactly the real shape: a token transfer event next to the registry payment.
  const events: DecodedEvent[] = [
    { contractId: SAC, topic0: "transfer", topic1: OTHER, amount: PRICE },
    paymentEvent(),
  ];
  assert.deepEqual(selectPayment(events, CHECK), { ok: true, amount: PRICE });
});

test("does not unlock when the only payment-shaped event is forged", () => {
  const events: DecodedEvent[] = [{ contractId: SAC, topic0: "payment", topic1: MERCHANT, amount: PRICE }];
  assert.equal(selectPayment(events, CHECK).ok, false);
});

// ---------- ProofLedger: the replay / TOCTOU guard ----------

test("ProofLedger reserves a proof once and blocks the replay", () => {
  const ledger = new ProofLedger();
  assert.equal(ledger.reserve("abc"), true);
  assert.equal(ledger.reserve("abc"), false); // replay blocked
  assert.equal(ledger.has("abc"), true);
});

test("ProofLedger releases a proof so a transient failure does not burn it", () => {
  const ledger = new ProofLedger();
  assert.equal(ledger.reserve("xyz"), true);
  ledger.release("xyz");
  assert.equal(ledger.has("xyz"), false);
  assert.equal(ledger.reserve("xyz"), true); // can retry after release
});

test("ProofLedger tracks proofs independently", () => {
  const ledger = new ProofLedger();
  ledger.reserve("one");
  assert.equal(ledger.reserve("two"), true);
  assert.equal(ledger.reserve("one"), false);
});
