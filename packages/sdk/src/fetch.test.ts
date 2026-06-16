import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { reapp, decodePaymentProof, X_PAYMENT_HEADER } from "@reapp-sdk/core";

// Unit coverage for the Agent.fetch x402 orchestration: the 402 handling, the
// pre-flight merchant/asset checks, the on-chain settle, and the proof-carrying
// retry. We stub global fetch (no network) and override pay (no chain), so this
// tests the HTTP glue in isolation. The contract and the merchant remain the real
// security boundaries; here we only assert fetch wires them together correctly.

const MERCHANT = "GMERCHANT_TEST_ADDRESS";
const ASSET = "CASSET_TEST_CONTRACT";
const TARGET = "https://merchant.example/source/market";
const TXHASH = "a".repeat(64);

function makeAgent() {
  const mandate = reapp.createIntentMandate({
    user: "GUSER_TEST_ADDRESS",
    agent: "GAGENT_TEST_ADDRESS",
    merchant: MERCHANT,
    asset: ASSET,
    maxAmount: "5.00",
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  return { agent: reapp.agent({ mandate, signer: Keypair.random() }), mandate };
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
function stubFetch(responder: (call: number) => Response) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return responder(calls.length);
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
