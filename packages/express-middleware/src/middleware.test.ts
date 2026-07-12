import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "buffer";
import { Keypair } from "@stellar/stellar-sdk";
import { encodePaymentProof } from "@reapp-sdk/core";
import { TESTNET } from "@reapp-sdk/stellar";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  createReappPaymentMiddleware,
  createRedemptionKey,
  getVerifiedPayment,
} from "./middleware.js";
import { InMemoryRedemptionStore } from "./proof-store.js";
import type {
  PaymentRequirement,
  PaymentVerifier,
  RedemptionStore,
  ReappPaymentMiddlewareOptions,
  VerifiedPayment,
} from "./types.js";

const user = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const agent = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const merchant = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();
const txHash = "a".repeat(64);

const verifiedPayment = (overrides: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  txHash,
  ledger: 100,
  mandateId: "b".repeat(64),
  user,
  agent,
  amount: "1",
  amountStroops: 10_000_000n,
  merchant,
  asset: TESTNET.nativeSac,
  registryId: TESTNET.mandateRegistryId,
  scheme: "reapp-soroban",
  network: "stellar-testnet",
  ...overrides,
});

const goodHeader = (overrides: Record<string, string> = {}): string => encodePaymentProof({
  scheme: "reapp-soroban",
  network: "stellar-testnet",
  txHash,
  mandateId: "b".repeat(64),
  amount: "1.00",
  ...overrides,
});

interface FakeResponse extends Response {
  statusCode: number;
  bodyValue: unknown;
  headerValues: Map<string, string>;
}

function makeResponse(onFinish: () => void): FakeResponse {
  const response = {
    locals: {},
    statusCode: 200,
    bodyValue: undefined,
    headerValues: new Map<string, string>(),
    status(status: number) {
      this.statusCode = status;
      return this;
    },
    set(name: string, value: string) {
      this.headerValues.set(name.toLowerCase(), value);
      return this;
    },
    vary(field: string) {
      const current = this.headerValues.get("vary");
      const values = new Set((current ? current.split(/,\s*/) : []).filter(Boolean));
      values.add(field);
      this.headerValues.set("vary", [...values].join(", "));
      return this;
    },
    json(value: unknown) {
      this.bodyValue = value;
      queueMicrotask(onFinish);
      return this;
    },
  };
  return response as unknown as FakeResponse;
}

interface Invocation {
  response: FakeResponse;
  nextCalls: number;
}

function invoke(
  middleware: RequestHandler,
  rawHeaders: string[] = [],
  path = "/source/market",
): Promise<Invocation> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let nextCalls = 0;
    const finish = (response: FakeResponse) => {
      if (!settled) {
        settled = true;
        resolve({ response, nextCalls });
      }
    };
    const response = makeResponse(() => finish(response));
    const request = {
      rawHeaders,
      originalUrl: path,
      url: path,
      method: "GET",
    } as Request;
    const next: NextFunction = (error?: unknown) => {
      nextCalls += 1;
      if (error) reject(error);
      else queueMicrotask(() => finish(response));
    };
    middleware(request, response, next);
  });
}

function successfulVerifier(onVerify?: (tx: string, requirement: PaymentRequirement) => void): PaymentVerifier {
  return {
    async verify(tx, requirement) {
      onVerify?.(tx, requirement);
      return { ok: true, payment: verifiedPayment() };
    },
  };
}

function options(overrides: Partial<ReappPaymentMiddlewareOptions> = {}): ReappPaymentMiddlewareOptions {
  return {
    merchant,
    amount: "1.00",
    resource: "/source/market",
    verifier: successfulVerifier(),
    redemptionStore: new InMemoryRedemptionStore(),
    ...overrides,
  };
}

test("missing proof returns a private 402 challenge without touching verifier or store", async () => {
  let verifies = 0;
  let consumes = 0;
  const result = await invoke(createReappPaymentMiddleware(options({
    verifier: successfulVerifier(() => { verifies += 1; }),
    redemptionStore: { consumeOnce: () => { consumes += 1; return "consumed"; } },
  })));
  assert.equal(result.response.statusCode, 402);
  assert.equal(verifies, 0);
  assert.equal(consumes, 0);
  assert.equal(result.response.headerValues.get("cache-control"), "private, no-store");
  assert.equal(result.response.headerValues.get("vary"), "X-PAYMENT");
  assert.deepEqual((result.response.bodyValue as { accepts: unknown[] }).accepts.length, 1);
});

test("only normalized txHash crosses the verifier boundary; header mandate and amount never authorize", async () => {
  let receivedTx = "";
  let receivedRequirement: PaymentRequirement | undefined;
  const middleware = createReappPaymentMiddleware(options({
    verifier: successfulVerifier((tx, requirement) => {
      receivedTx = tx;
      receivedRequirement = requirement;
    }),
  }));
  const result = await invoke(middleware, [
    "X-PAYMENT",
    goodHeader({ txHash: "A".repeat(64), mandateId: "caller-lie", amount: "999999999" }),
  ]);
  assert.equal(result.nextCalls, 1);
  assert.equal(receivedTx, "a".repeat(64));
  assert.equal(receivedRequirement?.amountStroops, 10_000_000n);
  assert.deepEqual(getVerifiedPayment(result.response), verifiedPayment());
});

test("malformed, duplicate, comma-joined, noncanonical, and oversized headers fail before RPC", async () => {
  let verifies = 0;
  const middleware = createReappPaymentMiddleware(options({
    verifier: successfulVerifier(() => { verifies += 1; }),
    maxHeaderBytes: 256,
  }));
  const headers: string[][] = [
    ["X-PAYMENT", "not base64"],
    ["X-PAYMENT", `${goodHeader()},${goodHeader()}`],
    ["X-PAYMENT", goodHeader(), "x-payment", goodHeader()],
    ["X-PAYMENT", `${goodHeader()}=`],
    ["X-PAYMENT", "A".repeat(260)],
    ["X-PAYMENT", Buffer.from("null").toString("base64")],
  ];
  for (const raw of headers) {
    const result = await invoke(middleware, raw);
    assert.equal(result.response.statusCode, 402);
  }
  assert.equal(verifies, 0);
});

test("wrong scheme, network, and transaction hash fail before RPC", async () => {
  let verifies = 0;
  const middleware = createReappPaymentMiddleware(options({
    verifier: successfulVerifier(() => { verifies += 1; }),
  }));
  for (const proof of [
    goodHeader({ scheme: "other" }),
    goodHeader({ network: "stellar-mainnet" }),
    goodHeader({ txHash: "not-a-hash" }),
  ]) {
    const result = await invoke(middleware, ["X-PAYMENT", proof]);
    assert.equal(result.response.statusCode, 402);
  }
  assert.equal(verifies, 0);
});

test("invalid proof is 402, unavailable proof is 503 without a replacement challenge", async () => {
  const invalid = await invoke(createReappPaymentMiddleware(options({
    verifier: { verify: async () => ({ ok: false, kind: "invalid", reason: "wrong transfer" }) },
  })), ["X-PAYMENT", goodHeader()]);
  assert.equal(invalid.response.statusCode, 402);
  assert.ok("accepts" in (invalid.response.bodyValue as object));

  const unavailable = await invoke(createReappPaymentMiddleware(options({
    verifier: { verify: async () => ({ ok: false, kind: "unavailable", reason: "rpc lag" }) },
  })), ["X-PAYMENT", goodHeader()]);
  assert.equal(unavailable.response.statusCode, 503);
  assert.equal(unavailable.response.headerValues.get("retry-after"), "1");
  assert.equal("accepts" in (unavailable.response.bodyValue as object), false);

  const thrown = await invoke(createReappPaymentMiddleware(options({
    verifier: { verify: async () => { throw new Error("offline"); } },
  })), ["X-PAYMENT", goodHeader()]);
  assert.equal(thrown.response.statusCode, 503);
});

test("store failure fails closed and duplicate redemption is 409 without another challenge", async () => {
  const failed = await invoke(createReappPaymentMiddleware(options({
    redemptionStore: { consumeOnce: () => { throw new Error("store offline"); } },
  })), ["X-PAYMENT", goodHeader()]);
  assert.equal(failed.response.statusCode, 503);
  assert.equal(failed.nextCalls, 0);

  const store = new InMemoryRedemptionStore();
  const middleware = createReappPaymentMiddleware(options({ redemptionStore: store }));
  const first = await invoke(middleware, ["X-PAYMENT", goodHeader()]);
  const second = await invoke(middleware, ["X-PAYMENT", goodHeader()]);
  assert.equal(first.nextCalls, 1);
  assert.equal(second.response.statusCode, 409);
  assert.equal("accepts" in (second.response.bodyValue as object), false);
});

test("100 simultaneous replays across two middleware instances reach exactly one handler", async () => {
  const store = new InMemoryRedemptionStore();
  const verifier = successfulVerifier();
  const first = createReappPaymentMiddleware(options({ verifier, redemptionStore: store }));
  const second = createReappPaymentMiddleware(options({ verifier, redemptionStore: store }));
  const attempts = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    invoke(index % 2 === 0 ? first : second, ["X-PAYMENT", goodHeader()])));
  assert.equal(attempts.filter((attempt) => attempt.nextCalls === 1).length, 1);
  assert.equal(attempts.filter((attempt) => attempt.response.statusCode === 409).length, 99);
});

test("one settlement cannot unlock a second resource", async () => {
  const store = new InMemoryRedemptionStore();
  const middleware = createReappPaymentMiddleware(options({
    resource: (request) => request.originalUrl,
    redemptionStore: store,
  }));
  const first = await invoke(middleware, ["X-PAYMENT", goodHeader()], "/one");
  const second = await invoke(middleware, ["X-PAYMENT", goodHeader()], "/two");
  assert.equal(first.nextCalls, 1);
  assert.equal(second.response.statusCode, 409);
});

test("redemption keys isolate networks and registries while normalizing transaction case", () => {
  const a = createRedemptionKey("network-a", TESTNET.mandateRegistryId, "A".repeat(64));
  const same = createRedemptionKey("network-a", TESTNET.mandateRegistryId.toLowerCase(), "a".repeat(64));
  const otherNetwork = createRedemptionKey("network-b", TESTNET.mandateRegistryId, "a".repeat(64));
  const otherRegistry = createRedemptionKey("network-a", TESTNET.nativeSac, "a".repeat(64));
  assert.equal(a, same);
  assert.notEqual(a, otherNetwork);
  assert.notEqual(a, otherRegistry);
});

test("constructor and request-specific configuration errors fail closed", async () => {
  assert.throws(() => createReappPaymentMiddleware(options({ redemptionStore: undefined as unknown as RedemptionStore })), /redemptionStore/);
  assert.throws(() => createReappPaymentMiddleware(options({ amount: "0" })), /greater than zero/);
  assert.throws(() => createReappPaymentMiddleware(options({ amount: "1e2" })), /Invalid amount/);
  assert.throws(() => createReappPaymentMiddleware(options({ maxHeaderBytes: 1 })), /maxHeaderBytes/);

  const result = await invoke(createReappPaymentMiddleware(options({
    amount: () => { throw new Error("resolver fault"); },
  })), ["X-PAYMENT", goodHeader()]);
  assert.equal(result.response.statusCode, 500);
  assert.equal(result.nextCalls, 0);
});
