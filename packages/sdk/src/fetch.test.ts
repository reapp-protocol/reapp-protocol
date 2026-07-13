import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "buffer";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { Keypair, hash } from "@stellar/stellar-sdk";
import {
  BOUND_PAYMENT_CAPABILITY,
  BOUND_PAYMENT_SCHEME,
  DeliveryPendingError,
  SettlementUncertainError,
  REAPP_PAYMENT_CAPABILITIES_HEADER,
  createSettlementReceiptId,
  getSettlementReceipt,
  isBoundPaymentProof,
  reapp,
  decodePaymentProof,
  X_PAYMENT_HEADER,
  type BoundPaymentChallengeV2,
  type SettlementReceiptStore,
} from "@reapp-sdk/core";

// Unit coverage for the Agent.fetch x402 orchestration: the 402 handling, the
// pre-flight merchant/asset checks, the on-chain settle, and the proof-carrying
// retry. We stub global fetch (no network) and override pay (no chain), so this
// tests the HTTP glue in isolation. The contract and the merchant remain the real
// security boundaries; here we only assert fetch wires them together correctly.

const MERCHANT = "GMERCHANT_TEST_ADDRESS";
const ASSET = "CASSET_TEST_CONTRACT";
const TARGET = "https://merchant.example/source/market";
const TXHASH = "a".repeat(64);

function memoryReceiptStore(): SettlementReceiptStore {
  const pending = new Map<string, Parameters<SettlementReceiptStore["savePending"]>[0]>();
  return {
    async savePending(receipt) { pending.set(receipt.receiptId, receipt); },
    async clearPending(receiptId) { pending.delete(receiptId); },
    async listPending() { return [...pending.values()]; },
  };
}

function makeAgent() {
  const mandate = reapp.createIntentMandate({
    user: "GUSER_TEST_ADDRESS",
    agent: "GAGENT_TEST_ADDRESS",
    merchant: MERCHANT,
    asset: ASSET,
    maxAmount: "5.00",
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  return {
    agent: reapp.agent({ mandate, signer: Keypair.random(), receiptStore: memoryReceiptStore() }),
    mandate,
  };
}

/** A 402 challenge naming this mandate's merchant/asset; override per case. */
const challenge402 = (over: Record<string, unknown> = {}): Response =>
  new Response(
    JSON.stringify({
      x402Version: 1,
      accepts: [
        {
          scheme: "reapp-soroban",
          network: "stellar-testnet",
          maxAmountRequired: "1.00",
          asset: ASSET,
          payTo: MERCHANT,
          resource: "/source/market",
          extra: {},
          ...over,
        },
      ],
    }),
    { status: 402, headers: { "content-type": "application/json" } },
  );

/** Install a scripted global fetch; returns recorded calls and a restore fn. */
function stubFetch(responder: (call: number) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return await responder(calls.length);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("fetch returns a non-402 response unchanged, without paying", async () => {
  const { agent } = makeAgent();
  let paid = false;
  agent.pay = async () => { paid = true; return TXHASH; };
  const stub = stubFetch(() => new Response("the resource", { status: 200 }));
  try {
    const res = await agent.fetch(TARGET);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "the resource");
    assert.equal(paid, false, "must not pay when the server did not ask");
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("same-mandate agents claim synchronously before the first chain read", async () => {
  let heldResponse: ServerResponse | undefined;
  let requests = 0;
  let releaseStarted!: () => void;
  const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
  const server = createServer((_request, response) => {
    requests += 1;
    if (requests === 1) {
      heldResponse = response;
      releaseStarted();
      return;
    }
    response.statusCode = 500;
    response.end("rpc unavailable");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") assert.fail("test RPC did not bind");

  const key = Keypair.random();
  const mandate = reapp.createIntentMandate({
    user: key.publicKey(),
    agent: key.publicKey(),
    merchant: Keypair.random().publicKey(),
    asset: reapp.testnet.nativeSac,
    maxAmount: "2.00",
    expiry: Math.floor(Date.now() / 1_000) + 3_600,
    nonce: "same-mandate-operation-claim",
  });
  const net = { ...reapp.testnet, rpcUrl: `http://127.0.0.1:${address.port}` };
  const firstAgent = reapp.agent({ mandate, signer: key }, net);
  const secondAgent = reapp.agent({ mandate, signer: key }, net);
  const lifecycle = { onPrepared: async () => undefined };

  const first = firstAgent.pay("1.00", lifecycle);
  await started;
  await assert.rejects(
    () => secondAgent.pay("1.00", lifecycle),
    /another payment operation for this mandate is already active/,
  );
  heldResponse!.statusCode = 500;
  heldResponse!.end("rpc unavailable");
  await assert.rejects(first);

  await assert.rejects(
    () => secondAgent.pay("1.00", lifecycle),
    (error: unknown) => error instanceof Error && !/already active/.test(error.message),
  );
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("fetch pays on a 402 and retries with the X-PAYMENT proof", async () => {
  const { agent, mandate } = makeAgent();
  const paidWith: string[] = [];
  agent.pay = async (amount: string) => { paidWith.push(amount); return TXHASH; };
  const stub = stubFetch((call) =>
    call === 1 ? challenge402() : new Response(JSON.stringify({ data: "premium" }), { status: 200 }),
  );
  try {
    const res = await agent.fetch(TARGET);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: "premium" });
    // paid exactly once, for the amount the challenge asked
    assert.deepEqual(paidWith, ["1.00"]);
    // two fetches: the unpaid GET, then the paid retry
    assert.equal(stub.calls.length, 2);
    // the retry carried a well-formed settlement proof for THIS mandate
    const headers = new Headers(stub.calls[1]!.init?.headers);
    const proofHeader = headers.get(X_PAYMENT_HEADER);
    assert.ok(proofHeader, "retry must carry the X-PAYMENT header");
    const proof = decodePaymentProof(proofHeader);
    assert.equal(proof.txHash, TXHASH);
    assert.equal(proof.mandateId, mandate.id);
    assert.equal(proof.amount, "1.00");
  } finally {
    stub.restore();
  }
});

test("fetch refuses to pay a 402 that names a different merchant", async () => {
  const { agent } = makeAgent();
  let paid = false;
  agent.pay = async () => { paid = true; return TXHASH; };
  const stub = stubFetch(() => challenge402({ payTo: "GSOMEONE_ELSE_ADDRESS" }));
  try {
    await assert.rejects(() => agent.fetch(TARGET), /not this mandate's merchant/);
    assert.equal(paid, false, "must not pay a merchant the mandate is not scoped to");
    assert.equal(stub.calls.length, 1, "must not retry after refusing");
  } finally {
    stub.restore();
  }
});

test("fetch refuses to pay a 402 that names a different asset", async () => {
  const { agent } = makeAgent();
  let paid = false;
  agent.pay = async () => { paid = true; return TXHASH; };
  const stub = stubFetch(() => challenge402({ asset: "CDIFFERENT_ASSET" }));
  try {
    await assert.rejects(() => agent.fetch(TARGET), /different asset/);
    assert.equal(paid, false);
  } finally {
    stub.restore();
  }
});

test("post-settlement network failure preserves a receipt and retryDelivery never pays twice", async () => {
  const { agent, mandate } = makeAgent();
  let payCalls = 0;
  agent.pay = async () => {
    payCalls += 1;
    return TXHASH;
  };
  const outage = stubFetch((call) => {
    if (call === 1) return challenge402();
    throw new TypeError("merchant connection refused");
  });

  let pending: DeliveryPendingError | undefined;
  try {
    await agent.fetch(TARGET);
    assert.fail("delivery outage should throw");
  } catch (error) {
    assert.ok(error instanceof DeliveryPendingError);
    pending = error;
  } finally {
    outage.restore();
  }

  assert.ok(pending);
  assert.equal(payCalls, 1);
  assert.equal(pending.receipt.txHash, TXHASH);
  assert.equal(pending.receipt.mandateId, mandate.id);
  assert.equal(pending.receipt.amount, "1.00");
  assert.equal(pending.receipt.url, TARGET);

  const recovery = stubFetch(() => new Response("delivered", { status: 200 }));
  try {
    const response = await agent.retryDelivery(pending.receipt);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "delivered");
    assert.equal(payCalls, 1, "delivery retry must never create a second payment");
    const header = new Headers(recovery.calls[0]?.init?.headers).get(X_PAYMENT_HEADER);
    assert.ok(header);
    assert.deepEqual(decodePaymentProof(header), pending.receipt.proof);
  } finally {
    recovery.restore();
  }
});

for (const status of [402, 409, 503]) {
  test(`post-settlement HTTP ${status} preserves a receipt instead of looking unpaid`, async () => {
    const { agent, mandate } = makeAgent();
    let payCalls = 0;
    agent.pay = async () => {
      payCalls += 1;
      return TXHASH;
    };
    const rejectedDelivery = stubFetch((call) =>
      call === 1
        ? challenge402()
        : new Response(JSON.stringify({ error: "delivery not confirmed" }), { status }),
    );

    let pending: DeliveryPendingError | undefined;
    try {
      await agent.fetch(TARGET);
      assert.fail(`paid HTTP ${status} should be delivery-pending`);
    } catch (error) {
      assert.ok(error instanceof DeliveryPendingError);
      pending = error;
    } finally {
      rejectedDelivery.restore();
    }

    assert.ok(pending);
    assert.equal(payCalls, 1);
    assert.equal(pending.receipt.txHash, TXHASH);
    assert.equal(pending.receipt.mandateId, mandate.id);
    assert.match(String(pending.cause), new RegExp(`HTTP ${status}`));
  });
}

test("retryDelivery rejects a receipt for another mandate before any HTTP request", async () => {
  const { agent } = makeAgent();
  const stub = stubFetch(() => new Response("should not run"));
  try {
    await assert.rejects(() => agent.retryDelivery({
      receiptId: "c".repeat(64),
      proofVersion: 1,
      url: TARGET,
      method: "GET",
      txHash: TXHASH,
      mandateId: "different",
      amount: "1.00",
      submittedAt: 1_700_000_000,
      validUntil: 1_700_000_060,
      proof: {
        scheme: "reapp-soroban",
        network: "stellar-testnet",
        txHash: TXHASH,
        mandateId: "different",
        amount: "1.00",
      },
    }), /different mandate/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

function makeBoundAgent(receiptStore: SettlementReceiptStore = memoryReceiptStore()) {
  const user = Keypair.random();
  const signer = Keypair.random();
  const merchant = Keypair.random();
  const mandate = reapp.createIntentMandate({
    user: user.publicKey(),
    agent: signer.publicKey(),
    merchant: merchant.publicKey(),
    asset: reapp.testnet.nativeSac,
    maxAmount: "5.00",
    expiry: Math.floor(Date.now() / 1000) + 3600,
    nonce: "bound-fetch-tests",
  });
  return {
    signer,
    mandate,
    agent: reapp.agent({
      mandate,
      signer,
      proofPolicy: "bound-v2-only",
      receiptStore,
    }),
  };
}

function boundChallenge(
  mandate: ReturnType<typeof makeBoundAgent>["mandate"],
  challengeOverrides: Partial<BoundPaymentChallengeV2> = {},
  requirementOverrides: Record<string, unknown> = {},
): Response {
  const now = Math.floor(Date.now() / 1000);
  const challenge: BoundPaymentChallengeV2 = {
    proofVersion: 2,
    challengeId: Buffer.alloc(32, 4).toString("base64url"),
    audience: "https://merchant.example",
    scheme: BOUND_PAYMENT_SCHEME,
    method: "GET",
    resource: "/source/market",
    bodySha256: null,
    network: "stellar-testnet",
    networkId: hash(Buffer.from(reapp.testnet.networkPassphrase, "utf8")).toString("hex"),
    registryId: reapp.testnet.mandateRegistryId,
    merchant: mandate.merchant,
    asset: mandate.asset,
    amountStroops: "10000000",
    decimals: mandate.decimals,
    issuedAt: now,
    expiresAt: now + 900,
    authorization: {
      algorithm: "hmac-sha256",
      mac: Buffer.alloc(32, 5).toString("base64"),
    },
    ...challengeOverrides,
  };
  return new Response(JSON.stringify({
    x402Version: 1,
    accepts: [{
      scheme: BOUND_PAYMENT_SCHEME,
      network: "stellar-testnet",
      maxAmountRequired: "1.00",
      asset: mandate.asset,
      payTo: mandate.merchant,
      resource: "/source/market",
      extra: {
        contract: reapp.testnet.mandateRegistryId,
        reappProofVersion: 2,
        challenge,
      },
      ...requirementOverrides,
    }],
  }), { status: 402, headers: { "content-type": "application/json" } });
}

test("bound-only fetch pays once, signs the exact challenge, and retains the durable receipt", async () => {
  const events: string[] = [];
  let secondRequestObservedSavedReceipt = false;
  const receiptStore: SettlementReceiptStore = {
    async savePending() { events.push("saved"); },
    async clearPending() { events.push("cleared"); },
    async listPending() { return []; },
  };
  const { agent, mandate, signer } = makeBoundAgent(receiptStore);
  let payCalls = 0;
  agent.pay = async () => { payCalls += 1; return TXHASH; };
  const stub = stubFetch((call) => {
    if (call === 1) return boundChallenge(mandate);
    secondRequestObservedSavedReceipt = events[0] === "saved";
    return new Response(JSON.stringify({ data: "premium" }), { status: 200 });
  });
  try {
    const response = await agent.fetch(TARGET);
    assert.equal(response.status, 200);
    assert.equal(payCalls, 1);
    assert.equal(secondRequestObservedSavedReceipt, true);
    assert.deepEqual(events, ["saved"], "transport success must not delete receipt before app acknowledgment");
    assert.equal(stub.calls.length, 2);
    for (const call of stub.calls) {
      const headers = new Headers(call.init?.headers);
      assert.equal(headers.get(REAPP_PAYMENT_CAPABILITIES_HEADER), BOUND_PAYMENT_CAPABILITY);
      assert.equal(call.init?.redirect, "manual");
    }
    const proofHeader = new Headers(stub.calls[1]?.init?.headers).get(X_PAYMENT_HEADER);
    assert.ok(proofHeader);
    const proof = decodePaymentProof(proofHeader);
    assert.equal(isBoundPaymentProof(proof), true);
    if (!isBoundPaymentProof(proof)) assert.fail("expected bound proof");
    assert.equal(proof.challenge.resource, "/source/market");
    assert.equal(proof.challenge.audience, "https://merchant.example");
    assert.equal(proof.mandateId, mandate.id);
    assert.equal(proof.authorization.algorithm, "stellar-ed25519-sha256");
    const receipt = getSettlementReceipt(response);
    assert.ok(receipt);
    assert.equal(receipt.proofVersion, 2);
    assert.equal(receipt.txHash, TXHASH);
    assert.deepEqual(receipt.proof, proof);
    assert.equal(receipt.mandateId, mandate.id);
    assert.equal(mandate.agent, signer.publicKey());
    await assert.rejects(() => agent.fetch(TARGET), /prior payment|reconcile/);
    await agent.acknowledgeDelivery(receipt);
    assert.deepEqual(events, ["saved", "cleared"]);
  } finally {
    stub.restore();
  }
});

test("bound-only fetch refuses legacy and 426 responses before any payment", async () => {
  for (const kind of ["legacy", "upgrade"] as const) {
    const { agent, mandate } = makeBoundAgent();
    const response = kind === "legacy"
      ? challenge402({ payTo: mandate.merchant, asset: mandate.asset })
      : new Response("upgrade", { status: 426 });
    let payCalls = 0;
    agent.pay = async () => { payCalls += 1; return TXHASH; };
    const stub = stubFetch(() => response);
    try {
      await assert.rejects(() => agent.fetch(TARGET), /bound-v2-only|capability/);
      assert.equal(payCalls, 0);
      assert.equal(stub.calls.length, 1);
    } finally {
      stub.restore();
    }
  }
});

test("bound fetch returns redirects without following or paying", async () => {
  const { agent } = makeBoundAgent();
  let payCalls = 0;
  agent.pay = async () => { payCalls += 1; return TXHASH; };
  const stub = stubFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
  try {
    const response = await agent.fetch(TARGET);
    assert.equal(response.status, 302);
    assert.equal(payCalls, 0);
    assert.equal(stub.calls[0]?.init?.redirect, "manual");
  } finally {
    stub.restore();
  }
});

const BOUND_MISMATCHES: Array<[
  string,
  Partial<BoundPaymentChallengeV2>,
  Record<string, unknown>?,
]> = [
  ["method", { method: "HEAD" }],
  ["resource", { resource: "/source/other" }],
  ["body", { bodySha256: "1".repeat(64) }],
  ["network identity", { networkId: "2".repeat(64) }],
  ["registry", { registryId: "CDIFFERENT" }],
  ["merchant", { merchant: "GDIFFERENT" }],
  ["asset", { asset: "CDIFFERENT" }],
  ["amount", { amountStroops: "20000000" }],
  ["decimals", { decimals: 6 }],
  ["expiry", { expiresAt: 1 }],
  ["outer resource", {}, { resource: "/source/other" }],
  ["outer contract", {}, { extra: { contract: "CDIFFERENT", reappProofVersion: 2 } }],
];

for (const [label, challengeOverrides, requirementOverrides = {}] of BOUND_MISMATCHES) {
  test(`bound fetch rejects ${label} mismatch before paying`, async () => {
    const { agent, mandate } = makeBoundAgent();
    let payCalls = 0;
    agent.pay = async () => { payCalls += 1; return TXHASH; };
    let response: Response;
    if (label === "outer contract") {
      const original = await boundChallenge(mandate).json() as {
        accepts: Array<Record<string, unknown>>;
      };
      original.accepts[0] = { ...original.accepts[0], ...requirementOverrides };
      response = new Response(JSON.stringify(original), { status: 402 });
    } else {
      response = boundChallenge(mandate, challengeOverrides, requirementOverrides);
    }
    const stub = stubFetch(() => response);
    try {
      await assert.rejects(() => agent.fetch(TARGET), /x402:/);
      assert.equal(payCalls, 0);
      assert.equal(stub.calls.length, 1);
    } finally {
      stub.restore();
    }
  });
}

test("receipt-store failure stops before HTTP delivery and never creates a second payment", async () => {
  const receiptStore: SettlementReceiptStore = {
    async savePending() { throw new Error("encrypted store offline"); },
    async clearPending() { assert.fail("must not clear"); },
    async listPending() { return []; },
  };
  const { agent, mandate } = makeBoundAgent(receiptStore);
  let payCalls = 0;
  agent.pay = async () => { payCalls += 1; return TXHASH; };
  const stub = stubFetch(() => boundChallenge(mandate));
  try {
    await assert.rejects(
      () => agent.fetch(TARGET),
      (error: unknown) => error instanceof DeliveryPendingError && error.receipt.proofVersion === 2,
    );
    assert.equal(payCalls, 1);
    assert.equal(stub.calls.length, 1, "delivery must wait until the receipt is durable");
  } finally {
    stub.restore();
  }
});

test("delivery recovery rejects method changes before HTTP and performs zero payments", async () => {
  const { agent, mandate } = makeBoundAgent();
  let payCalls = 0;
  agent.pay = async () => { payCalls += 1; return TXHASH; };
  const outage = stubFetch((call) => {
    if (call === 1) return boundChallenge(mandate);
    throw new TypeError("connection refused");
  });
  let receipt;
  try {
    await agent.fetch(TARGET);
    assert.fail("expected pending delivery");
  } catch (error) {
    assert.ok(error instanceof DeliveryPendingError);
    receipt = error.receipt;
  } finally {
    outage.restore();
  }
  assert.ok(receipt);
  const retry = stubFetch(() => new Response("must not run"));
  try {
    await assert.rejects(() => agent.retryDelivery(receipt, { method: "HEAD" }), /method/);
    assert.equal(retry.calls.length, 0);
    assert.equal(payCalls, 1);
  } finally {
    retry.restore();
  }
});

test("delivery recovery rejects a retargeted receipt URL before HTTP", async () => {
  const { agent, mandate } = makeBoundAgent();
  let payCalls = 0;
  agent.pay = async () => { payCalls += 1; return TXHASH; };
  const outage = stubFetch((call) => {
    if (call === 1) return boundChallenge(mandate);
    throw new TypeError("connection refused");
  });
  let receipt;
  try {
    await agent.fetch(TARGET);
    assert.fail("expected pending delivery");
  } catch (error) {
    assert.ok(error instanceof DeliveryPendingError);
    receipt = error.receipt;
  } finally {
    outage.restore();
  }
  assert.ok(receipt);
  const retry = stubFetch(() => new Response("must not run"));
  try {
    await assert.rejects(
      () => agent.retryDelivery({ ...receipt, url: "https://collector.example/source/market" }),
      /integrity/,
    );
    assert.equal(retry.calls.length, 0);
    assert.equal(payCalls, 1);
  } finally {
    retry.restore();
  }
});

test("bound fetch rejects a relayed genuine challenge at another origin before paying", async () => {
  const { agent, mandate } = makeBoundAgent();
  let payCalls = 0;
  agent.pay = async () => { payCalls += 1; return TXHASH; };
  const relayTarget = "https://collector.example/source/market";
  const stub = stubFetch(() => boundChallenge(mandate));
  try {
    await assert.rejects(() => agent.fetch(relayTarget), /exact request/);
    assert.equal(payCalls, 0);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("delivery recovery rejects cross-origin retargeting even with a recomputed public receipt id", async () => {
  const { agent, mandate } = makeBoundAgent();
  agent.pay = async () => TXHASH;
  const outage = stubFetch((call) => {
    if (call === 1) return boundChallenge(mandate);
    throw new TypeError("connection refused");
  });
  let receipt;
  try {
    await agent.fetch(TARGET);
    assert.fail("expected pending delivery");
  } catch (error) {
    assert.ok(error instanceof DeliveryPendingError);
    receipt = error.receipt;
  } finally {
    outage.restore();
  }
  assert.ok(receipt);
  const retargetedWithoutId = {
    proofVersion: receipt.proofVersion,
    url: "https://collector.example/source/market",
    method: receipt.method,
    txHash: receipt.txHash,
    mandateId: receipt.mandateId,
    amount: receipt.amount,
    submittedAt: receipt.submittedAt,
    validUntil: receipt.validUntil,
    proof: receipt.proof,
  };
  const retargeted = {
    receiptId: createSettlementReceiptId(retargetedWithoutId),
    ...retargetedWithoutId,
  };
  const retry = stubFetch(() => new Response("must not run"));
  try {
    await assert.rejects(() => agent.retryDelivery(retargeted), /delivery target/);
    assert.equal(retry.calls.length, 0);
  } finally {
    retry.restore();
  }
});

test("a truncated 2xx body remains delivery-pending and is never cleared", async () => {
  const events: string[] = [];
  const receiptStore: SettlementReceiptStore = {
    async savePending() { events.push("saved"); },
    async clearPending() { events.push("cleared"); },
    async listPending() { return []; },
  };
  const { agent, mandate } = makeBoundAgent(receiptStore);
  agent.pay = async () => TXHASH;
  let pulls = 0;
  const brokenBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
      } else {
        controller.error(new Error("socket reset during body"));
      }
    },
  });
  const stub = stubFetch((call) => call === 1
    ? boundChallenge(mandate)
    : new Response(brokenBody, { status: 200, headers: { "content-type": "application/json" } }));
  try {
    await assert.rejects(
      () => agent.fetch(TARGET),
      (error: unknown) => error instanceof DeliveryPendingError
        && String(error.cause).includes("socket reset during body"),
    );
    assert.deepEqual(events, ["saved"]);
  } finally {
    stub.restore();
  }
});

test("submitted-but-unconfirmed settlement survives Agent restart and blocks a second payment", async () => {
  const receiptStore = memoryReceiptStore();
  const { agent, mandate, signer } = makeBoundAgent(receiptStore);
  let payCalls = 0;
  agent.pay = (async (
    amount: string,
    lifecycle?: { onPrepared?: (settlement: {
      txHash: string;
      mandateId: string;
      amount: string;
      expectedSeq: string;
      submittedAt: number;
      validUntil: number;
    }) => string | undefined | Promise<string | undefined> },
  ) => {
    payCalls += 1;
    const submittedAt = Math.floor(Date.now() / 1_000);
    const prepared = {
      txHash: TXHASH,
      mandateId: mandate.id,
      amount,
      expectedSeq: "0",
      submittedAt,
      validUntil: submittedAt + 60,
    };
    const receiptId = await lifecycle?.onPrepared?.(prepared);
    throw new SettlementUncertainError({
      ...prepared,
      ...(receiptId ? { receiptId } : {}),
    }, new Error("RPC polling timed out after submission"));
  }) as typeof agent.pay;
  const stub = stubFetch(() => boundChallenge(mandate));
  let pending: DeliveryPendingError | undefined;
  try {
    await agent.fetch(TARGET);
    assert.fail("expected uncertain settlement");
  } catch (error) {
    assert.ok(error instanceof DeliveryPendingError);
    pending = error;
  }
  assert.ok(pending);
  assert.equal(pending.receipt.txHash, TXHASH);
  assert.equal(payCalls, 1);
  await assert.rejects(() => agent.fetch(TARGET), /prior payment|reconcile/);
  assert.equal(payCalls, 1);
  stub.restore();

  const restarted = reapp.agent({
    mandate,
    signer,
    proofPolicy: "bound-v2-only",
    receiptStore,
  });
  const afterRestart = stubFetch(() => new Response("must not request or pay"));
  try {
    await assert.rejects(
      () => restarted.fetch(TARGET),
      (error: unknown) => error instanceof DeliveryPendingError
        && error.receipt.txHash === TXHASH,
    );
    assert.equal(afterRestart.calls.length, 0);
  } finally {
    afterRestart.restore();
  }
});
