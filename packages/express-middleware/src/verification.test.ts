import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Buffer } from "buffer";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { TESTNET } from "@reapp-sdk/stellar";
import {
  createStellarPaymentVerifier,
  extractContractEvents,
  interpretEvents,
  selectPayment,
  selectTransfer,
  type DecodedEvent,
  type DecodedValue,
  type LoadedMandate,
  type LoadedTransaction,
} from "./verification.js";
import type { PaymentRequirement } from "./types.js";

const user = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
const agent = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey();
const merchant = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
const otherMerchant = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 10)).publicKey();
const mandateId = Buffer.alloc(32, 11);
const price = 10_000_000n;

const value = (type: string, native: unknown): DecodedValue => ({ type, value: native });
const paymentEvent = (overrides: Partial<DecodedEvent> = {}): DecodedEvent => ({
  type: "contract",
  contractId: TESTNET.mandateRegistryId,
  topics: [value("scvSymbol", "payment"), value("scvAddress", merchant)],
  data: value("scvVec", [value("scvBytes", mandateId), value("scvI128", price)]),
  ...overrides,
});
const transferEvent = (overrides: Partial<DecodedEvent> = {}): DecodedEvent => ({
  type: "contract",
  contractId: TESTNET.nativeSac,
  topics: [
    value("scvSymbol", "transfer"),
    value("scvAddress", user),
    value("scvAddress", merchant),
    value("scvString", "native"),
  ],
  data: value("scvI128", price),
  ...overrides,
});

const requirement: PaymentRequirement = {
  scheme: "reapp-soroban",
  network: "stellar-testnet",
  resource: "/source/market",
  merchant,
  asset: TESTNET.nativeSac,
  amount: "1.00",
  amountStroops: price,
  registryId: TESTNET.mandateRegistryId,
  decimals: 7,
};

const successTransaction = (): LoadedTransaction => ({
  status: "SUCCESS",
  ledger: 100,
  latestLedger: 110,
  events: [transferEvent(), paymentEvent()],
});
const storedMandate = (): LoadedMandate => ({
  user,
  agent,
  merchant,
  asset: TESTNET.nativeSac,
});

function verifierWith(options: {
  transaction?: LoadedTransaction | (() => Promise<LoadedTransaction>);
  mandate?: LoadedMandate | (() => Promise<LoadedMandate>);
  passphrase?: string | (() => Promise<string>);
  pollAttempts?: number;
  maxProofAgeLedgers?: number;
} = {}) {
  const transaction = options.transaction ?? successTransaction();
  const mandate = options.mandate ?? storedMandate();
  const passphrase = options.passphrase ?? TESTNET.networkPassphrase;
  return createStellarPaymentVerifier({
    networkConfig: TESTNET,
    pollAttempts: options.pollAttempts ?? 0,
    pollIntervalMs: 0,
    maxProofAgeLedgers: options.maxProofAgeLedgers,
    wait: async () => undefined,
    loadNetworkPassphrase: typeof passphrase === "function" ? passphrase : async () => passphrase,
    loadTransaction: typeof transaction === "function" ? transaction : async () => transaction,
    loadMandate: typeof mandate === "function" ? mandate : async () => mandate,
  });
}

test("golden V4 metadata retains the exact payment and transfer event types", () => {
  const fixture = JSON.parse(readFileSync(
    new URL("../../../apps/fulfillment-agent/src/fixtures/payment-meta.json", import.meta.url),
    "utf8",
  )) as { metaXdr: string; registryId: string };
  const events = interpretEvents(extractContractEvents(xdr.TransactionMeta.fromXDR(fixture.metaXdr, "base64")));
  assert.equal(events.length, 2);
  const payment = selectPayment(events, {
    merchant: "GCREL554SPELMSCEIQQVYS2TPDWONZ6AVQXMUNBEGGZ2X5FNYHDC2RZG",
    registryId: fixture.registryId,
    priceStroops: price,
  });
  assert.equal(payment.ok, true);
  const transfer = selectTransfer(events, {
    asset: TESTNET.nativeSac,
    user: "GBE3PH4ZYVYUXZWZL4YJP22H5J46U6VQVF6SYNJ3GGU3RHBN4M77VNBG",
    merchant: "GCREL554SPELMSCEIQQVYS2TPDWONZ6AVQXMUNBEGGZ2X5FNYHDC2RZG",
    amount: price,
  });
  assert.deepEqual(transfer, { ok: true });
});

test("selectPayment accepts one exact trusted event and scans past underpayment", () => {
  const under = paymentEvent({
    data: value("scvVec", [value("scvBytes", mandateId), value("scvI128", price - 1n)]),
  });
  const result = selectPayment([under, paymentEvent()], {
    merchant,
    registryId: TESTNET.mandateRegistryId,
    priceStroops: price,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.amount, price);
    assert.deepEqual(result.mandateId, mandateId);
  }
});

test("selectPayment rejects ambiguity instead of choosing the first event", () => {
  const result = selectPayment([paymentEvent(), paymentEvent()], {
    merchant,
    registryId: TESTNET.mandateRegistryId,
    priceStroops: price,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /multiple/);
});

test("selectPayment rejects wrong emitters, event types, topics, and payload discriminants", () => {
  const check = { merchant, registryId: TESTNET.mandateRegistryId, priceStroops: price };
  const cases: DecodedEvent[] = [
    paymentEvent({ contractId: TESTNET.nativeSac }),
    paymentEvent({ contractId: null }),
    paymentEvent({ type: "diagnostic" }),
    paymentEvent({ topics: [value("scvString", "payment"), value("scvAddress", merchant)] }),
    paymentEvent({ topics: [value("scvSymbol", "payment"), value("scvAddress", otherMerchant)] }),
    paymentEvent({ topics: [value("scvSymbol", "payment"), value("scvAddress", merchant), value("scvVoid", null)] }),
    paymentEvent({ data: value("scvVec", [value("scvString", mandateId.toString("hex")), value("scvI128", price)]) }),
    paymentEvent({ data: value("scvVec", [value("scvBytes", Buffer.alloc(31)), value("scvI128", price)]) }),
    paymentEvent({ data: value("scvVec", [value("scvBytes", mandateId), value("scvU64", price)]) }),
    paymentEvent({ data: value("scvVec", [value("scvBytes", mandateId), value("scvI128", 0n)]) }),
  ];
  for (const candidate of cases) assert.equal(selectPayment([candidate], check).ok, false);
});

test("selectTransfer requires one exact asset-emitted user-to-merchant transfer", () => {
  const check = { asset: TESTNET.nativeSac, user, merchant, amount: price };
  assert.deepEqual(selectTransfer([transferEvent()], check), { ok: true });
  const cases: DecodedEvent[] = [
    transferEvent({ contractId: TESTNET.mandateRegistryId }),
    transferEvent({ type: "system" }),
    transferEvent({ topics: [value("scvString", "transfer"), value("scvAddress", user), value("scvAddress", merchant)] }),
    transferEvent({ topics: [value("scvSymbol", "transfer"), value("scvAddress", agent), value("scvAddress", merchant)] }),
    transferEvent({ topics: [value("scvSymbol", "transfer"), value("scvAddress", user), value("scvAddress", otherMerchant)] }),
    transferEvent({ data: value("scvI128", price - 1n) }),
  ];
  for (const candidate of cases) assert.equal(selectTransfer([candidate], check).ok, false);
  assert.equal(selectTransfer([transferEvent(), transferEvent()], check).ok, false);
});

test("verifier returns only chain-derived settlement fields", async () => {
  const result = await verifierWith().verify("A".repeat(64), requirement);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.payment.txHash, "a".repeat(64));
    assert.equal(result.payment.mandateId, mandateId.toString("hex"));
    assert.equal(result.payment.amount, "1");
    assert.equal(result.payment.amountStroops, price);
    assert.equal(result.payment.user, user);
    assert.equal(result.payment.agent, agent);
    assert.equal(result.payment.ledger, 100);
  }
});

test("verifier rejects stored mandate merchant and asset mismatches", async () => {
  const wrongMerchant = await verifierWith({ mandate: { ...storedMandate(), merchant: otherMerchant } })
    .verify("a".repeat(64), requirement);
  assert.equal(wrongMerchant.ok, false);
  if (!wrongMerchant.ok) assert.match(wrongMerchant.reason, /stored mandate merchant/);

  const wrongAsset = await verifierWith({ mandate: { ...storedMandate(), asset: TESTNET.mandateRegistryId } })
    .verify("a".repeat(64), requirement);
  assert.equal(wrongAsset.ok, false);
  if (!wrongAsset.ok) assert.match(wrongAsset.reason, /stored mandate asset/);
});

test("verifier rejects a registry payment without the matching SEP-41 transfer", async () => {
  const result = await verifierWith({
    transaction: { ...successTransaction(), events: [paymentEvent(), transferEvent({ data: value("scvI128", price - 1n) })] },
  }).verify("a".repeat(64), requirement);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /matching transfer/);
});

test("verifier rejects failed, stale, future, and incomplete transaction evidence", async () => {
  const failed = await verifierWith({ transaction: { status: "FAILED", ledger: 100, latestLedger: 100 } })
    .verify("a".repeat(64), requirement);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.kind, "invalid");

  const stale = await verifierWith({ transaction: { ...successTransaction(), ledger: 1, latestLedger: 200 }, maxProofAgeLedgers: 10 })
    .verify("a".repeat(64), requirement);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.reason, /freshness/);

  const future = await verifierWith({ transaction: { ...successTransaction(), ledger: 201, latestLedger: 200 } })
    .verify("a".repeat(64), requirement);
  assert.equal(future.ok, false);
  if (!future.ok) assert.equal(future.kind, "unavailable");

  const incomplete = await verifierWith({ transaction: { status: "SUCCESS", events: successTransaction().events } })
    .verify("a".repeat(64), requirement);
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.equal(incomplete.kind, "unavailable");
});

test("verifier polls NOT_FOUND and classifies RPC and mandate lookup faults unavailable", async () => {
  let reads = 0;
  const missing = await verifierWith({
    pollAttempts: 2,
    transaction: async () => {
      reads += 1;
      return { status: "NOT_FOUND", latestLedger: 100 };
    },
  }).verify("a".repeat(64), requirement);
  assert.equal(reads, 3);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.kind, "unavailable");

  const rpcFault = await verifierWith({ transaction: async () => { throw new Error("rpc offline"); } })
    .verify("a".repeat(64), requirement);
  assert.equal(rpcFault.ok, false);
  if (!rpcFault.ok) assert.match(rpcFault.reason, /rpc offline/);

  const mandateFault = await verifierWith({ mandate: async () => { throw new Error("NotFound"); } })
    .verify("a".repeat(64), requirement);
  assert.equal(mandateFault.ok, false);
  if (!mandateFault.ok) assert.equal(mandateFault.kind, "unavailable");
});

test("verifier checks RPC network identity before trusting transaction data", async () => {
  const mismatch = await verifierWith({ passphrase: "Public Global Stellar Network ; September 2015" })
    .verify("a".repeat(64), requirement);
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.equal(mismatch.kind, "unavailable");
    assert.match(mismatch.reason, /passphrase/);
  }
});

test("verifier rejects noncanonical hashes and insecure RPC by default", async () => {
  const badHash = await verifierWith().verify("z".repeat(64), requirement);
  assert.equal(badHash.ok, false);
  assert.throws(() => createStellarPaymentVerifier({
    networkConfig: { ...TESTNET, rpcUrl: "http://127.0.0.1:8000" },
    loadMandate: async () => storedMandate(),
  }), /https/);
});
