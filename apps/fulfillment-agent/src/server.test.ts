import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { afterEach, test } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  BOUND_PAYMENT_CAPABILITY,
  REAPP_PAYMENT_CAPABILITIES_HEADER,
  X_PAYMENT_HEADER,
  createBoundPaymentProof,
  encodePaymentProof,
  parse402,
  type BoundPaymentProofV2,
} from "@reapp-sdk/core";
import {
  InMemoryBoundRedemptionStore,
  type BoundRedemptionStore,
  type PaymentVerifier,
  type VerifiedPayment,
} from "@reapp-sdk/express-middleware";
import { TESTNET } from "@reapp-sdk/stellar";
import { createFulfillmentApp } from "./server.js";

const merchant = "GCREL554SPELMSCEIQQVYS2TPDWONZ6AVQXMUNBEGGZ2X5FNYHDC2RZG";
const user = "GBE3PH4ZYVYUXZWZL4YJP22H5J46U6VQVF6SYNJ3GGU3RHBN4M77VNBG";
const agentKey = Keypair.random();
const txHash = "a".repeat(64);
const mandateId = "b".repeat(64);
const challengeSecret = "reference-server-test-secret-is-long-enough";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

const verifiedPayment = (): VerifiedPayment => ({
  txHash,
  ledger: 100,
  mandateId,
  user,
  agent: agentKey.publicKey(),
  amount: "1",
  amountStroops: 10_000_000n,
  merchant,
  asset: TESTNET.nativeSac,
  registryId: TESTNET.mandateRegistryId,
  scheme: "reapp-soroban-bound",
  network: "stellar-testnet",
});

const successfulVerifier = (onVerify?: (hash: string) => void): PaymentVerifier => ({
  async verify(hash) {
    onVerify?.(hash);
    return { ok: true, payment: { ...verifiedPayment(), txHash: hash } };
  },
});

async function start(
  verifier: PaymentVerifier,
  secret = challengeSecret,
  redemptionStore: BoundRedemptionStore = new InMemoryBoundRedemptionStore(),
  configuredAudience?: string,
): Promise<string> {
  let runtimeAudience = "";
  const server = createFulfillmentApp({
    merchant,
    verifier,
    challengeSecret: secret,
    redemptionStore,
    audience: configuredAudience ?? (() => runtimeAudience),
  }).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  const url = `http://127.0.0.1:${address.port}`;
  runtimeAudience = url;
  return url;
}

const capabilityHeaders = {
  [REAPP_PAYMENT_CAPABILITIES_HEADER]: BOUND_PAYMENT_CAPABILITY,
};

async function proofFor(url: string, source = "market"): Promise<BoundPaymentProofV2> {
  const quoted = await fetch(`${url}/source/${source}`, { headers: capabilityHeaders });
  assert.equal(quoted.status, 402);
  const requirement = await parse402(quoted);
  assert.ok(requirement.challenge);
  return createBoundPaymentProof({
    challenge: requirement.challenge,
    txHash,
    mandateId,
    signer: agentKey,
  });
}

function headersFor(proof: BoundPaymentProofV2): Record<string, string> {
  return { ...capabilityHeaders, [X_PAYMENT_HEADER]: encodePaymentProof(proof) };
}

test("unknown resources return 404 before any payment negotiation or verification", async () => {
  let verifies = 0;
  const url = await start(successfulVerifier(() => { verifies += 1; }));
  const response = await fetch(`${url}/source/not-real`);
  assert.equal(response.status, 404);
  assert.equal(verifies, 0);
});

test("known resources require bound-v2 capability before issuing a 402", async () => {
  let verifies = 0;
  const url = await start(successfulVerifier(() => { verifies += 1; }));
  const oldClient = await fetch(`${url}/source/market`);
  assert.equal(oldClient.status, 426);
  const capable = await fetch(`${url}/source/market`, { headers: capabilityHeaders });
  assert.equal(capable.status, 402);
  const requirement = await parse402(capable);
  assert.equal(requirement.challenge?.audience, url);
  assert.equal(requirement.challenge?.resource, "/source/market");
  assert.equal(verifies, 0);
});

test("verified agent-bound settlement serves chain-derived content evidence", async () => {
  let verifierHash = "";
  const url = await start(successfulVerifier((hash) => { verifierHash = hash; }));
  const proof = await proofFor(url, "academic");
  const response = await fetch(`${url}/source/academic`, { headers: headersFor(proof) });
  assert.equal(response.status, 200);
  assert.equal(verifierHash, txHash);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json() as {
    source: string;
    settledTx: string;
    mandateId: string;
    settledAmount: string;
  };
  assert.equal(body.source, "academic");
  assert.equal(body.settledTx, txHash);
  assert.equal(body.mandateId, mandateId);
  assert.equal(body.settledAmount, "1");
});

test("same proof recovers the same idempotent source but cannot unlock another source", async () => {
  const url = await start(successfulVerifier());
  const proof = await proofFor(url);
  const first = await fetch(`${url}/source/market`, { headers: headersFor(proof) });
  const recovery = await fetch(`${url}/source/market`, { headers: headersFor(proof) });
  const crossResource = await fetch(`${url}/source/news`, { headers: headersFor(proof) });
  assert.equal(first.status, 200);
  assert.equal(recovery.status, 200);
  assert.equal(crossResource.status, 402);
});

test("same-secret restart recovers a settled receipt without another payment", async () => {
  const store = new InMemoryBoundRedemptionStore();
  const firstUrl = await start(successfulVerifier(), challengeSecret, store);
  const proof = await proofFor(firstUrl);
  const first = await fetch(`${firstUrl}/source/market`, { headers: headersFor(proof) });
  assert.equal(first.status, 200);
  const firstServer = servers.shift();
  await new Promise<void>((resolve, reject) => firstServer?.close((error) => error ? reject(error) : resolve()));

  const recoveredUrl = await start(successfulVerifier(), challengeSecret, store, firstUrl);
  const response = await fetch(`${recoveredUrl}/source/market`, { headers: headersFor(proof) });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { settledTx: string }).settledTx, txHash);
});

test("invalid or unavailable settlement never reaches fulfillment", async () => {
  const invalidUrl = await start({
    verify: async () => ({ ok: false, kind: "invalid", reason: "wrong asset transfer" }),
  });
  const invalidProof = await proofFor(invalidUrl);
  const invalid = await fetch(`${invalidUrl}/source/market`, { headers: headersFor(invalidProof) });
  assert.equal(invalid.status, 402);

  const unavailableUrl = await start({
    verify: async () => ({ ok: false, kind: "unavailable", reason: "RPC unavailable" }),
  });
  const unavailableProof = await proofFor(unavailableUrl);
  const unavailable = await fetch(`${unavailableUrl}/source/market`, { headers: headersFor(unavailableProof) });
  assert.equal(unavailable.status, 503);
  const body = await unavailable.json() as Record<string, unknown>;
  assert.equal("accepts" in body, false);
});
