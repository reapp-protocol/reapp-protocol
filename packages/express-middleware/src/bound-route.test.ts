import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { afterEach, test } from "node:test";
import express from "express";
import { Keypair } from "@stellar/stellar-sdk";
import {
  BOUND_PAYMENT_CAPABILITY,
  REAPP_PAYMENT_CAPABILITIES_HEADER,
  X_PAYMENT_HEADER,
  createBoundPaymentProof,
  encodePaymentProof,
  parse402,
} from "@reapp-sdk/core";
import { TESTNET } from "@reapp-sdk/stellar";
import {
  InMemoryBoundRedemptionStore,
  createBoundReappPaidJsonRoute,
  resolveBoundReappInterruptedDelivery,
  type BoundDeliveryRecord,
  type BoundJsonFulfillment,
  type BoundRedemptionStore,
  type PaymentVerifier,
  type VerifiedPayment,
} from "./index.js";

const merchant = "GCREL554SPELMSCEIQQVYS2TPDWONZ6AVQXMUNBEGGZ2X5FNYHDC2RZG";
const user = "GBE3PH4ZYVYUXZWZL4YJP22H5J46U6VQVF6SYNJ3GGU3RHBN4M77VNBG";
const agentKey = Keypair.random();
const txHash = "a".repeat(64);
const mandateId = "b".repeat(64);
const secret = "paid-route-test-secret-that-is-at-least-thirty-two-bytes";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

function payment(): VerifiedPayment {
  return {
    txHash, ledger: 100, mandateId, user, agent: agentKey.publicKey(), amount: "1",
    amountStroops: 10_000_000n, merchant, asset: TESTNET.nativeSac,
    registryId: TESTNET.mandateRegistryId, scheme: "reapp-soroban-bound", network: "stellar-testnet",
  };
}

async function start(options: {
  store?: BoundRedemptionStore;
  fulfill?: BoundJsonFulfillment;
  audience?: string;
  onVerify?: () => void;
} = {}): Promise<{ url: string; calls: () => number }> {
  let runtimeAudience = "";
  let calls = 0;
  const verifier: PaymentVerifier = {
    async verify() {
      options.onVerify?.();
      return { ok: true, payment: payment() };
    },
  };
  const route = createBoundReappPaidJsonRoute({
    merchant,
    amount: "1.00",
    audience: options.audience ?? (() => runtimeAudience),
    challengeSecret: secret,
    redemptionStore: options.store ?? new InMemoryBoundRedemptionStore(),
    verifier,
    now: () => 1_700_000_000,
    randomBytes: () => Buffer.alloc(32, 9),
  }, async (context) => {
    calls += 1;
    return options.fulfill
      ? options.fulfill(context)
      : { body: { source: "data", settledTx: context.payment.txHash } };
  });
  const app = express();
  app.get("/source/market", route);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const url = `http://127.0.0.1:${address.port}`;
  runtimeAudience = url;
  return { url, calls: () => calls };
}

const capability = { [REAPP_PAYMENT_CAPABILITIES_HEADER]: BOUND_PAYMENT_CAPABILITY };

async function proof(url: string) {
  const quote = await fetch(`${url}/source/market`, { headers: capability });
  const requirement = await parse402(quote);
  assert.ok(requirement.challenge);
  return createBoundPaymentProof({ challenge: requirement.challenge, txHash, mandateId, signer: agentKey });
}

function headers(paymentProof: ReturnType<typeof createBoundPaymentProof>): Record<string, string> {
  return { ...capability, [X_PAYMENT_HEADER]: encodePaymentProof(paymentProof) };
}

test("100 exact-proof recoveries replay byte-identical JSON and execute fulfillment once", async () => {
  let verifies = 0;
  const app = await start({ onVerify: () => { verifies += 1; } });
  const paymentProof = await proof(app.url);
  const bodies: string[] = [];
  for (let index = 0; index < 100; index += 1) {
    const response = await fetch(`${app.url}/source/market`, { headers: headers(paymentProof) });
    assert.equal(response.status, 200);
    bodies.push(await response.text());
  }
  assert.equal(new Set(bodies).size, 1);
  assert.equal(app.calls(), 1);
  assert.equal(verifies, 1);
});

test("a completed paid result survives restart and bypasses verifier and fulfillment", async () => {
  const store = new InMemoryBoundRedemptionStore();
  const first = await start({ store });
  const paymentProof = await proof(first.url);
  const original = await fetch(`${first.url}/source/market`, { headers: headers(paymentProof) });
  const body = await original.text();
  assert.equal(first.calls(), 1);

  let restartVerifies = 0;
  const restarted = await start({ store, audience: first.url, onVerify: () => { restartVerifies += 1; } });
  const recovered = await fetch(`${restarted.url}/source/market`, { headers: headers(paymentProof) });
  assert.equal(recovered.status, 200);
  assert.equal(await recovered.text(), body);
  assert.equal(restarted.calls(), 0);
  assert.equal(restartVerifies, 0);
});

test("an executing claim returns 503 and never starts fulfillment twice", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const app = await start({ fulfill: async ({ payment }) => {
    await blocked;
    return { body: { settledTx: payment.txHash } };
  } });
  const paymentProof = await proof(app.url);
  const first = fetch(`${app.url}/source/market`, { headers: headers(paymentProof) });
  while (app.calls() === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  const concurrent = await fetch(`${app.url}/source/market`, { headers: headers(paymentProof) });
  assert.equal(concurrent.status, 503);
  assert.equal(app.calls(), 1);
  release();
  assert.equal((await first).status, 200);
});

test("result-store failure sends no resource, never re-runs work, and supports trusted terminal resolution", async () => {
  const base = new InMemoryBoundRedemptionStore();
  let claimedRecord: Readonly<BoundDeliveryRecord> | undefined;
  const store: BoundRedemptionStore = {
    lookup: (key, digest) => base.lookup(key, digest),
    claim: (record, executionId, startedAt) => {
      const result = base.claim(record, executionId, startedAt);
      if (result.kind === "claimed") claimedRecord = result.record;
      return result;
    },
    complete: () => { throw new Error("result database offline"); },
  };
  const app = await start({ store });
  const paymentProof = await proof(app.url);
  const first = await fetch(`${app.url}/source/market`, { headers: headers(paymentProof) });
  const retry = await fetch(`${app.url}/source/market`, { headers: headers(paymentProof) });
  assert.equal(first.status, 503);
  assert.equal(retry.status, 503);
  assert.equal(app.calls(), 1);

  assert.ok(claimedRecord);
  await resolveBoundReappInterruptedDelivery({ redemptionStore: base, record: claimedRecord });
  const resolved = await fetch(`${app.url}/source/market`, { headers: headers(paymentProof) });
  assert.equal(resolved.status, 200);
  assert.deepEqual(await resolved.json(), {
    ok: false,
    error: "paid fulfillment failed after settlement",
    deliveryState: "terminal",
  });
  assert.equal(app.calls(), 1);
});

test("a fulfillment exception becomes one immutable terminal JSON result", async () => {
  const app = await start({ fulfill: () => { throw new Error("upstream model crashed"); } });
  const paymentProof = await proof(app.url);
  const first = await fetch(`${app.url}/source/market`, { headers: headers(paymentProof) });
  const retry = await fetch(`${app.url}/source/market`, { headers: headers(paymentProof) });
  assert.equal(first.status, 200);
  const body = await first.text();
  assert.equal(body, await retry.text());
  assert.deepEqual(JSON.parse(body), {
    ok: false,
    error: "paid fulfillment failed after settlement",
    deliveryState: "terminal",
  });
  assert.equal(app.calls(), 1);
});
