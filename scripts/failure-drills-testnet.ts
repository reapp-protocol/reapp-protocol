#!/usr/bin/env tsx
/** Live testnet failure drills. Fresh keys only; no local secrets or mocks. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { exit } from "node:process";
import { Keypair } from "@stellar/stellar-sdk";
import {
  DeliveryPendingError,
  parse402,
  reapp,
  type IntentMandate,
} from "@reapp-sdk/core";
import { TESTNET, keypairSigner, registryClient, token } from "@reapp-sdk/stellar";
import { SOURCE_PRICE, startServer } from "../apps/fulfillment-agent/src/server.ts";

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const txUrl = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;
const log = (...values: unknown[]) => console.log(...values);

async function fund(address: string): Promise<void> {
  let last = "";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(`https://friendbot.stellar.org/?addr=${address}`);
      if (response.ok) return;
      last = `${response.status} ${await response.text()}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(attempt * 1_000);
  }
  throw new Error(`friendbot could not fund ${address}: ${last}`);
}

async function latestTestnetCloseTime(): Promise<number> {
  const response = await fetch("https://horizon-testnet.stellar.org/ledgers?order=desc&limit=1");
  if (!response.ok) throw new Error(`Horizon latest-ledger read failed: ${response.status}`);
  const body = await response.json() as {
    _embedded?: { records?: Array<{ closed_at?: string }> };
  };
  const closedAt = body._embedded?.records?.[0]?.closed_at;
  const seconds = closedAt ? Math.floor(Date.parse(closedAt) / 1_000) : Number.NaN;
  if (!Number.isSafeInteger(seconds)) throw new Error("Horizon omitted a safe latest-ledger close time");
  return seconds;
}

async function waitForLedgerExpiry(expiry: number): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const closedAt = await latestTestnetCloseTime();
    if (closedAt >= expiry) return;
    await sleep(2_000);
  }
  throw new Error(`testnet did not close a ledger at or after expiry ${expiry}`);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
}

async function register(
  user: Keypair,
  agent: Keypair,
  merchant: Keypair,
  maxAmount: string,
  expiry: number,
): Promise<IntentMandate> {
  const mandate = reapp.createIntentMandate({
    user: user.publicKey(),
    agent: agent.publicKey(),
    merchant: merchant.publicKey(),
    asset: TESTNET.nativeSac,
    maxAmount,
    expiry,
  });
  await reapp.registerMandate(mandate, { signer: user });
  await reapp.approveBudget(mandate, { signer: user });
  return mandate;
}

function challenge(resource: string, merchant: string): object {
  return {
    x402Version: 1,
    accepts: [{
      scheme: "reapp-soroban",
      network: "stellar-testnet",
      maxAmountRequired: SOURCE_PRICE,
      asset: TESTNET.nativeSac,
      payTo: merchant,
      resource,
      extra: { contract: TESTNET.mandateRegistryId },
    }],
  };
}

async function startChallengeThenStop(merchant: string): Promise<{
  url: string;
  port: number;
  closed: Promise<void>;
}> {
  let challenged = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const server = createServer((request, response) => {
    if (challenged) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "merchant shutting down" }));
      return;
    }
    challenged = true;
    const resource = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.writeHead(402, {
      "content-type": "application/json",
      "cache-control": "private, no-store",
    });
    response.end(JSON.stringify(challenge(resource, merchant)), () => {
      setTimeout(() => {
        server.close(() => resolveClosed());
        server.closeAllConnections();
      }, 100);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("downtime server did not bind TCP");
  return {
    url: `http://127.0.0.1:${address.port}/source/market`,
    port: address.port,
    closed,
  };
}

async function readMandate(mandate: IntentMandate, reader: Keypair) {
  const client = registryClient(TESTNET, keypairSigner(reader, TESTNET.networkPassphrase));
  return (await client.get_mandate({ mandate_id: mandate.idBuffer })).result.unwrap();
}

async function main(): Promise<void> {
  const user = Keypair.random();
  const agentKey = Keypair.random();
  const merchant = Keypair.random();
  log("REAPP live failure drills — Stellar testnet");
  log("contract", TESTNET.mandateRegistryId);
  await Promise.all([fund(user.publicKey()), fund(agentKey.publicKey()), fund(merchant.publicKey())]);
  await sleep(3_000);

  log("\n1/3 rogue agent stays inside the signed envelope");
  const rogueMandate = await register(
    user,
    agentKey,
    merchant,
    "2.00",
    Math.floor(Date.now() / 1_000) + 3_600,
  );
  const rogueAgent = reapp.agent({ mandate: rogueMandate, signer: agentKey });
  const rogueBefore = await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey());
  const rogueTx = await rogueAgent.pay("1.00");
  const rogueAfter = await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey());
  const rogueState = await readMandate(rogueMandate, agentKey);
  assert.equal(rogueAfter - rogueBefore, 10_000_000n);
  assert.equal(rogueState.spent, 10_000_000n);
  assert.equal(rogueState.seq, 1);
  await reapp.revokeMandate(rogueMandate, { signer: user });
  await assert.rejects(() => rogueAgent.pay("0.50"), /#5|MandateRevoked/);
  assert.equal(await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey()), rogueAfter);
  log("PASS: within-scope spend settled; revoke blocked the next request", txUrl(rogueTx));

  log("\n2/3 merchant disappears after settlement and before delivery");
  const downtimeMandate = await register(
    user,
    agentKey,
    merchant,
    "1.00",
    Math.floor(Date.now() / 1_000) + 3_600,
  );
  const downtimeAgent = reapp.agent({ mandate: downtimeMandate, signer: agentKey });
  const downtimeBefore = await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey());
  const outage = await startChallengeThenStop(merchant.publicKey());
  let pending: DeliveryPendingError | undefined;
  try {
    await downtimeAgent.fetch(outage.url);
    assert.fail("delivery should fail after the merchant stops");
  } catch (error) {
    assert.ok(error instanceof DeliveryPendingError);
    pending = error;
  }
  await outage.closed;
  assert.ok(pending);
  const downtimeAfter = await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey());
  assert.equal(downtimeAfter - downtimeBefore, 10_000_000n);
  const downtimeState = await readMandate(downtimeMandate, agentKey);
  assert.equal(downtimeState.spent, 10_000_000n);
  assert.equal(downtimeState.seq, 1);

  const recovered = await startServer({ merchant: merchant.publicKey(), port: outage.port });
  try {
    const delivered = await downtimeAgent.retryDelivery(pending.receipt);
    assert.equal(delivered.status, 200);
    const body = await delivered.json() as { settledTx?: string };
    assert.equal(body.settledTx, pending.receipt.txHash);
    assert.equal(await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey()), downtimeAfter);
    const replay = await downtimeAgent.retryDelivery(pending.receipt);
    assert.equal(replay.status, 409);
    assert.equal(await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey()), downtimeAfter);
  } finally {
    await closeServer(recovered.server);
  }
  log("PASS: receipt recovered delivery with zero second payment", txUrl(pending.receipt.txHash));

  log("\n3/3 mandate expires between quote and settlement");
  const closeTime = await latestTestnetCloseTime();
  const expiry = closeTime + 45;
  const expiryMandate = await register(user, agentKey, merchant, "1.00", expiry);
  const expiryAgent = reapp.agent({ mandate: expiryMandate, signer: agentKey });
  const expiryServer = await startServer({ merchant: merchant.publicKey(), port: 0 });
  const expiryBefore = await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey());
  try {
    const quoted = await fetch(`${expiryServer.url}/source/market`);
    assert.equal(quoted.status, 402);
    const requirement = await parse402(quoted);
    assert.equal(requirement.amount, SOURCE_PRICE);
    assert.ok(await latestTestnetCloseTime() < expiry, "quote must arrive while mandate is valid");
    await waitForLedgerExpiry(expiry);
    await assert.rejects(() => expiryAgent.pay(requirement.amount), /#4|MandateExpired/);
    const expiryState = await readMandate(expiryMandate, agentKey);
    assert.equal(expiryState.spent, 0n);
    assert.equal(expiryState.seq, 0);
    assert.equal(await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey()), expiryBefore);
  } finally {
    await closeServer(expiryServer.server);
  }
  log("PASS: expired before settlement; no funds moved and no resource was delivered");

  log("\n3/3 live failure drills passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  exit(1);
});
