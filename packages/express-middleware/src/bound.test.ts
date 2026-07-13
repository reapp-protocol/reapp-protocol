import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { afterEach, test } from "node:test";
import express, { type Response } from "express";
import { Keypair } from "@stellar/stellar-sdk";
import {
  BOUND_PAYMENT_CAPABILITY,
  REAPP_PAYMENT_CAPABILITIES_HEADER,
  X_PAYMENT_HEADER,
  createBoundPaymentProof,
  encodePaymentProof,
  parse402,
  type BoundPaymentChallengeV2,
  type BoundPaymentProofV2,
  type LegacyPaymentProof,
} from "@reapp-sdk/core";
import { TESTNET } from "@reapp-sdk/stellar";
import {
  getVerifiedPayment,
  InMemoryBoundRedemptionStore,
  type BoundRedemptionStore,
  type PaymentVerifier,
  type VerifiedPayment,
} from "./index.js";
import {
  createBoundReappPaymentMiddleware,
  type BoundReappPaymentMiddlewareOptions,
} from "./bound.js";

const merchant = "GCREL554SPELMSCEIQQVYS2TPDWONZ6AVQXMUNBEGGZ2X5FNYHDC2RZG";
const user = "GBE3PH4ZYVYUXZWZL4YJP22H5J46U6VQVF6SYNJ3GGU3RHBN4M77VNBG";
const agentKey = Keypair.random();
const txHash = "a".repeat(64);
const mandateId = "b".repeat(64);
const NOW = 1_700_000_000;
const SECRET = "bound-test-secret-that-is-at-least-thirty-two-bytes";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

function payment(overrides: Partial<VerifiedPayment> = {}): VerifiedPayment {
  return {
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
    ...overrides,
  };
}

function successfulVerifier(
  onVerify?: (hash: string) => void,
  overrides: Partial<VerifiedPayment> = {},
): PaymentVerifier {
  return {
    async verify(hash) {
      onVerify?.(hash);
      return { ok: true, payment: payment({ txHash: hash, ...overrides }) };
    },
  };
}

async function start(options: {
  verifier?: PaymentVerifier;
  secret?: string;
  now?: () => number;
  audience?: string;
  handler?: (response: Response) => void;
  middleware?: Partial<BoundReappPaymentMiddlewareOptions>;
  store?: BoundRedemptionStore;
} = {}): Promise<{ url: string; handled: () => number }> {
  let handled = 0;
  let runtimeAudience = "";
  const app = express();
  const requirePayment = createBoundReappPaymentMiddleware({
    merchant,
    amount: "1.00",
    audience: options.audience ?? (() => runtimeAudience),
    challengeSecret: options.secret ?? SECRET,
    redemptionStore: options.store ?? new InMemoryBoundRedemptionStore(),
    verifier: options.verifier ?? successfulVerifier(),
    now: options.now ?? (() => NOW),
    randomBytes: () => Buffer.alloc(32, 7),
    ...options.middleware,
  });
  app.all("/source/:id", requirePayment, (_request, response) => {
    handled += 1;
    const verified = getVerifiedPayment(response);
    if (!verified) {
      response.status(500).json({ error: "missing verified payment" });
      return;
    }
    options.handler?.(response);
    if (!response.headersSent) {
      response.json({ source: "data", settledTx: verified.txHash, mandateId: verified.mandateId });
    }
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const url = `http://127.0.0.1:${address.port}`;
  runtimeAudience = url;
  return { url, handled: () => handled };
}

const capabilities = { [REAPP_PAYMENT_CAPABILITIES_HEADER]: BOUND_PAYMENT_CAPABILITY };

async function quote(baseUrl: string, resource = "/source/market"): Promise<BoundPaymentChallengeV2> {
  const response = await fetch(`${baseUrl}${resource}`, { headers: capabilities });
  assert.equal(response.status, 402);
  const required = await parse402(response);
  assert.equal(required.proofVersion, 2);
  assert.ok(required.challenge);
  return required.challenge;
}

function signedProof(challenge: BoundPaymentChallengeV2, signer = agentKey): BoundPaymentProofV2 {
  return createBoundPaymentProof({ challenge, txHash, mandateId, signer });
}

function paidHeaders(proof: BoundPaymentProofV2): Record<string, string> {
  return {
    ...capabilities,
    [X_PAYMENT_HEADER]: encodePaymentProof(proof),
  };
}

test("old clients receive 426 and no payment challenge or chain lookup", async () => {
  let verifies = 0;
  const app = await start({ verifier: successfulVerifier(() => { verifies += 1; }) });
  const response = await fetch(`${app.url}/source/market`);
  assert.equal(response.status, 426);
  assert.equal(response.headers.get("upgrade"), BOUND_PAYMENT_CAPABILITY);
  assert.equal(verifies, 0);
  assert.equal(app.handled(), 0);
  const body = await response.json() as Record<string, unknown>;
  assert.equal("accepts" in body, false);
});

test("capable unpaid client receives an authenticated exact-request challenge", async () => {
  let verifies = 0;
  const app = await start({ verifier: successfulVerifier(() => { verifies += 1; }) });
  const response = await fetch(`${app.url}/source/market?format=json`, { headers: capabilities });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("vary") ?? "", /X-PAYMENT/i);
  const requirement = await parse402(response);
  const challenge = requirement.challenge;
  assert.ok(challenge);
  assert.equal(challenge.audience, app.url);
  assert.equal(challenge.method, "GET");
  assert.equal(challenge.resource, "/source/market?format=json");
  assert.equal(challenge.amountStroops, "10000000");
  assert.equal(challenge.registryId, TESTNET.mandateRegistryId);
  assert.equal(challenge.authorization.algorithm, "hmac-sha256");
  assert.equal(Buffer.from(challenge.authorization.mac, "base64").length, 32);
  assert.equal(verifies, 0);
});

test("internal authorization claims once and never re-runs an executing request", async () => {
  let verifies = 0;
  const app = await start({ verifier: successfulVerifier(() => { verifies += 1; }) });
  const proof = signedProof(await quote(app.url));
  const first = await fetch(`${app.url}/source/market`, { headers: paidHeaders(proof) });
  const recovery = await fetch(`${app.url}/source/market`, { headers: paidHeaders(proof) });
  assert.equal(first.status, 200);
  assert.equal(recovery.status, 503);
  assert.equal(verifies, 1, "an executing claim uses stored evidence without another RPC read");
  assert.equal(app.handled(), 1);
});

test("public transaction data without the agent signature cannot unlock", async () => {
  let verifies = 0;
  const app = await start({ verifier: successfulVerifier(() => { verifies += 1; }) });
  const legacy: LegacyPaymentProof = {
    scheme: "reapp-soroban",
    network: "stellar-testnet",
    txHash,
    mandateId,
    amount: "1.00",
  };
  const response = await fetch(`${app.url}/source/market`, {
    headers: { ...capabilities, [X_PAYMENT_HEADER]: encodePaymentProof(legacy) },
  });
  assert.equal(response.status, 402);
  assert.equal(verifies, 0);
  assert.equal(app.handled(), 0);
});

test("signature from a key other than the chain-derived agent is rejected", async () => {
  let verifies = 0;
  const app = await start({ verifier: successfulVerifier(() => { verifies += 1; }) });
  const proof = signedProof(await quote(app.url), Keypair.random());
  const response = await fetch(`${app.url}/source/market`, { headers: paidHeaders(proof) });
  assert.equal(response.status, 402);
  assert.equal(verifies, 1);
  assert.equal(app.handled(), 0);
});

test("a valid proof cannot cross resource, query, or method boundaries", async () => {
  let verifies = 0;
  const app = await start({ verifier: successfulVerifier(() => { verifies += 1; }) });
  const proof = signedProof(await quote(app.url));
  for (const target of ["/source/news", "/source/market?format=json"]) {
    const response = await fetch(`${app.url}${target}`, { headers: paidHeaders(proof) });
    assert.equal(response.status, 402);
  }
  const head = await fetch(`${app.url}/source/market`, { method: "HEAD", headers: paidHeaders(proof) });
  assert.equal(head.status, 405);
  assert.equal(verifies, 0);
  assert.equal(app.handled(), 0);
});

const CHALLENGE_TAMPERS: Array<[string, (challenge: BoundPaymentChallengeV2) => BoundPaymentChallengeV2]> = [
  ["audience", (c) => ({ ...c, audience: "https://other.example" })],
  ["resource", (c) => ({ ...c, resource: "/source/other" })],
  ["method", (c) => ({ ...c, method: "HEAD" })],
  ["network", (c) => ({ ...c, network: "other-network" })],
  ["network id", (c) => ({ ...c, networkId: "1".repeat(64) })],
  ["registry", (c) => ({ ...c, registryId: "CDIFFERENT" })],
  ["merchant", (c) => ({ ...c, merchant: user })],
  ["asset", (c) => ({ ...c, asset: TESTNET.mandateRegistryId })],
  ["amount", (c) => ({ ...c, amountStroops: "20000000" })],
  ["decimals", (c) => ({ ...c, decimals: 6 })],
  ["expiry", (c) => ({ ...c, expiresAt: c.expiresAt + 1 })],
  ["mac", (c) => ({ ...c, authorization: { ...c.authorization, mac: Buffer.alloc(32, 9).toString("base64") } })],
];

for (const [label, tamper] of CHALLENGE_TAMPERS) {
  test(`tampered ${label} challenge fails before chain verification`, async () => {
    let verifies = 0;
    const app = await start({ verifier: successfulVerifier(() => { verifies += 1; }) });
    const proof = signedProof(tamper(await quote(app.url)));
    const response = await fetch(`${app.url}/source/market`, { headers: paidHeaders(proof) });
    assert.equal(response.status, 402);
    assert.equal(verifies, 0);
    assert.equal(app.handled(), 0);
  });
}

test("tampered agent signature fails after independent chain verification", async () => {
  let verifies = 0;
  const app = await start({ verifier: successfulVerifier(() => { verifies += 1; }) });
  const original = signedProof(await quote(app.url));
  const bytes = Buffer.from(original.authorization.signature, "base64");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  const proof = {
    ...original,
    authorization: { ...original.authorization, signature: bytes.toString("base64") },
  };
  const response = await fetch(`${app.url}/source/market`, {
    headers: { ...capabilities, [X_PAYMENT_HEADER]: encodePaymentProof(proof) },
  });
  assert.equal(response.status, 402);
  assert.equal(verifies, 1);
  assert.equal(app.handled(), 0);
});

test("expired and not-yet-valid challenges fail before chain verification", async () => {
  let clock = NOW;
  let verifies = 0;
  const app = await start({
    now: () => clock,
    verifier: successfulVerifier(() => { verifies += 1; }),
  });
  const proof = signedProof(await quote(app.url));
  clock = NOW + 900;
  const expired = await fetch(`${app.url}/source/market`, { headers: paidHeaders(proof) });
  assert.equal(expired.status, 402);
  assert.equal(verifies, 0);
});

test("same-secret restart preserves an executing claim while a different secret rejects it", async () => {
  const store = new InMemoryBoundRedemptionStore();
  const first = await start({ secret: SECRET, store });
  const proof = signedProof(await quote(first.url));
  const accepted = await fetch(`${first.url}/source/market`, { headers: paidHeaders(proof) });
  assert.equal(accepted.status, 200);
  await new Promise<void>((resolve, reject) => servers.shift()?.close((error) => error ? reject(error) : resolve()));

  const recovered = await start({ secret: SECRET, store, audience: first.url });
  const delivered = await fetch(`${recovered.url}/source/market`, { headers: paidHeaders(proof) });
  assert.equal(delivered.status, 503);

  const different = await start({ secret: `${SECRET}-different`, store, audience: first.url });
  const rejected = await fetch(`${different.url}/source/market`, { headers: paidHeaders(proof) });
  assert.equal(rejected.status, 402);
  assert.equal(different.handled(), 0);
});

test("one old transaction cannot be re-signed for a fresh challenge or resource", async () => {
  let verifies = 0;
  const store = new InMemoryBoundRedemptionStore();
  const app = await start({ store, verifier: successfulVerifier(() => { verifies += 1; }) });
  const marketProof = signedProof(await quote(app.url, "/source/market"));
  const market = await fetch(`${app.url}/source/market`, { headers: paidHeaders(marketProof) });
  assert.equal(market.status, 200);

  const newsProof = signedProof(await quote(app.url, "/source/news"));
  const news = await fetch(`${app.url}/source/news`, { headers: paidHeaders(newsProof) });
  assert.equal(news.status, 409);
  assert.equal(verifies, 1, "conflicting proof is rejected from the atomic store before RPC");
  assert.equal(app.handled(), 1);
});

test("redemption-store lookup and claim failures fail closed", async () => {
  const lookupFailure: BoundRedemptionStore = {
    lookup: () => { throw new Error("store offline"); },
    claim: () => { throw new Error("must not claim"); },
    complete: () => { throw new Error("must not complete"); },
  };
  const lookupApp = await start({ store: lookupFailure });
  const lookupProof = signedProof(await quote(lookupApp.url));
  const lookup = await fetch(`${lookupApp.url}/source/market`, { headers: paidHeaders(lookupProof) });
  assert.equal(lookup.status, 503);
  assert.equal(lookupApp.handled(), 0);

  const claimFailure: BoundRedemptionStore = {
    lookup: () => ({ kind: "missing" }),
    claim: () => { throw new Error("store offline"); },
    complete: () => { throw new Error("must not complete"); },
  };
  const claimApp = await start({ store: claimFailure });
  const claimProof = signedProof(await quote(claimApp.url));
  const claim = await fetch(`${claimApp.url}/source/market`, { headers: paidHeaders(claimProof) });
  assert.equal(claim.status, 503);
  assert.equal(claimApp.handled(), 0);
});

for (const [label, verifier, status] of [
  ["RPC unavailable", { verify: async () => ({ ok: false, kind: "unavailable", reason: "RPC offline" }) }, 503],
  ["invalid settlement", { verify: async () => ({ ok: false, kind: "invalid", reason: "wrong transfer" }) }, 402],
  ["verifier exception", { verify: async () => { throw new Error("RPC crashed"); } }, 503],
] as const) {
  test(`${label} fails closed without fulfillment`, async () => {
    const app = await start({ verifier: verifier as PaymentVerifier });
    const proof = signedProof(await quote(app.url));
    const response = await fetch(`${app.url}/source/market`, { headers: paidHeaders(proof) });
    assert.equal(response.status, status);
    assert.equal(app.handled(), 0);
  });
}

for (const [label, overrides] of [
  ["mandate id", { mandateId: "c".repeat(64) }],
  ["amount", { amountStroops: 20_000_000n }],
  ["merchant", { merchant: user }],
  ["asset", { asset: TESTNET.mandateRegistryId }],
  ["registry", { registryId: TESTNET.nativeSac }],
  ["scheme", { scheme: "reapp-soroban" }],
  ["network", { network: "other-network" }],
] as const) {
  test(`chain-derived ${label} mismatch cannot unlock`, async () => {
    const app = await start({ verifier: successfulVerifier(undefined, overrides) });
    const proof = signedProof(await quote(app.url));
    const response = await fetch(`${app.url}/source/market`, { headers: paidHeaders(proof) });
    assert.equal(response.status, 402);
    assert.equal(app.handled(), 0);
  });
}

test("non-idempotent methods and missing capability on a paid request fail before verification", async () => {
  let verifies = 0;
  const app = await start({ verifier: successfulVerifier(() => { verifies += 1; }) });
  const post = await fetch(`${app.url}/source/market`, { method: "POST", headers: capabilities });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");

  const proof = signedProof(await quote(app.url));
  const noCapability = await fetch(`${app.url}/source/market`, {
    headers: { [X_PAYMENT_HEADER]: encodePaymentProof(proof) },
  });
  assert.equal(noCapability.status, 426);
  assert.equal(verifies, 0);
  assert.equal(app.handled(), 0);
});
