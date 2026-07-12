import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { afterEach, test } from "node:test";
import { encodePaymentProof } from "@reapp-sdk/core";
import {
  InMemoryRedemptionStore,
  type PaymentVerifier,
  type VerifiedPayment,
} from "@reapp-sdk/express-middleware";
import { TESTNET } from "@reapp-sdk/stellar";
import { createFulfillmentApp } from "./server.js";

const merchant = "GCREL554SPELMSCEIQQVYS2TPDWONZ6AVQXMUNBEGGZ2X5FNYHDC2RZG";
const user = "GBE3PH4ZYVYUXZWZL4YJP22H5J46U6VQVF6SYNJ3GGU3RHBN4M77VNBG";
const agent = "GAHGD3Q6ZKKJFM4FM5M6DSDNTT6KGCEZRZ2NLBBGILZFSKNUFT7VTORQ";
const txHash = "a".repeat(64);
const mandateId = "b".repeat(64);
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
  agent,
  amount: "1",
  amountStroops: 10_000_000n,
  merchant,
  asset: TESTNET.nativeSac,
  registryId: TESTNET.mandateRegistryId,
  scheme: "reapp-soroban",
  network: "stellar-testnet",
});

const successfulVerifier = (onVerify?: (hash: string) => void): PaymentVerifier => ({
  async verify(hash) {
    onVerify?.(hash);
    return { ok: true, payment: verifiedPayment() };
  },
});

const proof = (overrides: Record<string, string> = {}): string => encodePaymentProof({
  scheme: "reapp-soroban",
  network: "stellar-testnet",
  txHash,
  mandateId,
  amount: "1.00",
  ...overrides,
});

async function start(verifier: PaymentVerifier, store = new InMemoryRedemptionStore()): Promise<string> {
  const server = createFulfillmentApp({ merchant, verifier, redemptionStore: store }).listen(0);
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

test("unpaid known resource returns the exact REAPP payment requirement", async () => {
  let verifies = 0;
  const url = await start(successfulVerifier(() => { verifies += 1; }));
  const response = await fetch(`${url}/source/market`);
  assert.equal(response.status, 402);
  assert.equal(verifies, 0);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("vary") ?? "", /X-PAYMENT/i);
  const body = await response.json() as { accepts: Array<{ extra: { contract: string }; asset: string }> };
  assert.equal(body.accepts[0]?.extra.contract, TESTNET.mandateRegistryId);
  assert.equal(body.accepts[0]?.asset, TESTNET.nativeSac);
});

test("unknown resources return 404 before asking for payment", async () => {
  let verifies = 0;
  const url = await start(successfulVerifier(() => { verifies += 1; }));
  const response = await fetch(`${url}/source/not-real`, {
    headers: { "X-PAYMENT": proof() },
  });
  assert.equal(response.status, 404);
  assert.equal(verifies, 0);
});

test("verified settlement serves content and uses chain-derived evidence", async () => {
  let verifierHash = "";
  const url = await start(successfulVerifier((hash) => { verifierHash = hash; }));
  const response = await fetch(`${url}/source/academic`, {
    headers: {
      "X-PAYMENT": proof({
        txHash: txHash.toUpperCase(),
        mandateId: "caller-supplied-lie",
        amount: "999999",
      }),
    },
  });
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

test("one settlement serves exactly once across different resources", async () => {
  const url = await start(successfulVerifier());
  const first = await fetch(`${url}/source/market`, { headers: { "X-PAYMENT": proof() } });
  const replay = await fetch(`${url}/source/news`, { headers: { "X-PAYMENT": proof() } });
  assert.equal(first.status, 200);
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), { error: "this payment was already redeemed" });
});

test("invalid settlement and unavailable verification never serve content", async () => {
  const invalidUrl = await start({
    verify: async () => ({ ok: false, kind: "invalid", reason: "wrong asset transfer" }),
  });
  const invalid = await fetch(`${invalidUrl}/source/market`, { headers: { "X-PAYMENT": proof() } });
  assert.equal(invalid.status, 402);

  const unavailableUrl = await start({
    verify: async () => ({ ok: false, kind: "unavailable", reason: "RPC unavailable" }),
  });
  const unavailable = await fetch(`${unavailableUrl}/source/market`, { headers: { "X-PAYMENT": proof() } });
  assert.equal(unavailable.status, 503);
  const body = await unavailable.json() as Record<string, unknown>;
  assert.equal("accepts" in body, false);
});

test("redemption store failure returns 503 and never reaches fulfillment", async () => {
  const url = await start(successfulVerifier(), {
    consumeOnce: () => { throw new Error("shared store offline"); },
  });
  const response = await fetch(`${url}/source/market`, { headers: { "X-PAYMENT": proof() } });
  assert.equal(response.status, 503);
});
