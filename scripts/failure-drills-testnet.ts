#!/usr/bin/env tsx
/** Live testnet failure drills. Fresh keys only; no local secrets or mocks. */
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, open, rename, rm } from "node:fs/promises";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exit } from "node:process";
import { Keypair } from "@stellar/stellar-sdk";
import {
  BOUND_PAYMENT_CAPABILITY,
  BOUND_PAYMENT_SCHEME,
  DeliveryPendingError,
  SettlementUncertainError,
  REAPP_PAYMENT_CAPABILITIES_HEADER,
  boundChallengeAuthorizationBytes,
  parse402,
  reapp,
  type UnsignedBoundPaymentChallengeV2,
  type IntentMandate,
  type Agent,
} from "@reapp-sdk/core";
import { TESTNET, keypairSigner, registryClient, token } from "@reapp-sdk/stellar";
import { SOURCE_PRICE, startServer } from "../apps/fulfillment-agent/src/server.ts";
import { FileBoundRedemptionStore } from "../apps/fulfillment-agent/src/redemption-store.ts";
import { FileSettlementReceiptStore } from "../apps/consumer-agent/src/receipt-store.ts";

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const txUrl = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;
const log = (...values: unknown[]) => console.log(...values);

async function journaledPay(agent: Agent, amount: string, journalPath: string): Promise<string> {
  let safeToClear = false;
  try {
    const hash = await agent.pay(amount, {
      onPrepared: async (pending) => {
        const temporary = `${journalPath}.${randomUUID()}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify({ version: 1, pending }, null, 2)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, journalPath);
        await chmod(journalPath, 0o600);
      },
    });
    safeToClear = true;
    return hash;
  } catch (error) {
    safeToClear = !(error instanceof SettlementUncertainError);
    throw error;
  } finally {
    if (safeToClear) await rm(journalPath, { force: true });
  }
}

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

function challenge(resource: string, merchant: string, secret: string, audience: string): object {
  const now = Math.floor(Date.now() / 1_000);
  const unsigned: UnsignedBoundPaymentChallengeV2 = {
    proofVersion: 2,
    challengeId: randomBytes(32).toString("base64url"),
    audience,
    scheme: BOUND_PAYMENT_SCHEME,
    method: "GET",
    resource,
    bodySha256: null,
    network: "stellar-testnet",
    networkId: createHash("sha256").update(TESTNET.networkPassphrase, "utf8").digest("hex"),
    registryId: TESTNET.mandateRegistryId,
    merchant,
    asset: TESTNET.nativeSac,
    amountStroops: "10000000",
    decimals: 7,
    issuedAt: now,
    expiresAt: now + 900,
  };
  const bound = {
    ...unsigned,
    authorization: {
      algorithm: "hmac-sha256" as const,
      mac: createHmac("sha256", secret)
        .update(boundChallengeAuthorizationBytes(unsigned))
        .digest("base64"),
    },
  };
  return {
    x402Version: 1,
    accepts: [{
      scheme: BOUND_PAYMENT_SCHEME,
      network: "stellar-testnet",
      maxAmountRequired: SOURCE_PRICE,
      asset: TESTNET.nativeSac,
      payTo: merchant,
      resource,
      extra: {
        contract: TESTNET.mandateRegistryId,
        reappProofVersion: 2,
        challenge: bound,
      },
    }],
  };
}

async function startChallengeThenStop(merchant: string, secret: string): Promise<{
  url: string;
  port: number;
  closed: Promise<void>;
}> {
  let challenged = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const server = createServer((request, response) => {
    if (request.headers[REAPP_PAYMENT_CAPABILITIES_HEADER] !== BOUND_PAYMENT_CAPABILITY) {
      response.writeHead(426, { "content-type": "application/json" });
      response.end(JSON.stringify({ requiredCapability: BOUND_PAYMENT_CAPABILITY }));
      return;
    }
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
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("downtime server address unavailable");
    const audience = `http://127.0.0.1:${address.port}`;
    response.end(JSON.stringify(challenge(resource, merchant, secret, audience)), () => {
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
  const drillRoot = await mkdtemp(join(tmpdir(), "reapp-failure-drills-"));
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
  const rogueJournal = join(drillRoot, "rogue-payment.json");
  const rogueTx = await journaledPay(rogueAgent, "1.00", rogueJournal);
  const rogueAfter = await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey());
  const rogueState = await readMandate(rogueMandate, agentKey);
  assert.equal(rogueAfter - rogueBefore, 10_000_000n);
  assert.equal(rogueState.spent, 10_000_000n);
  assert.equal(rogueState.seq, 1);
  await reapp.revokeMandate(rogueMandate, { signer: user });
  await assert.rejects(() => journaledPay(rogueAgent, "0.50", rogueJournal), /#5|MandateRevoked/);
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
  const downtimeAgent = reapp.agent({
    mandate: downtimeMandate,
    signer: agentKey,
    proofPolicy: "bound-v2-only",
    receiptStore: new FileSettlementReceiptStore(join(drillRoot, "pending-receipts.json")),
  });
  const downtimeBefore = await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey());
  const challengeSecret = randomBytes(32).toString("hex");
  const redemptionStore = new FileBoundRedemptionStore(join(drillRoot, "redemptions.json"));
  const outage = await startChallengeThenStop(merchant.publicKey(), challengeSecret);
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

  const recovered = await startServer({
    merchant: merchant.publicKey(),
    challengeSecret,
    redemptionStore,
    port: outage.port,
  });
  try {
    const delivered = await downtimeAgent.retryDelivery(pending.receipt);
    assert.equal(delivered.status, 200);
    const body = await delivered.json() as { settledTx?: string };
    assert.equal(body.settledTx, pending.receipt.txHash);
    assert.equal(await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey()), downtimeAfter);
    const replay = await downtimeAgent.retryDelivery(pending.receipt);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { settledTx?: string }).settledTx, pending.receipt.txHash);
    assert.equal(await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey()), downtimeAfter);
    await downtimeAgent.acknowledgeDelivery(pending.receipt);
  } finally {
    await closeServer(recovered.server);
  }
  log("PASS: receipt recovered delivery with zero second payment", txUrl(pending.receipt.txHash));

  log("\n3/3 mandate expires between quote and settlement");
  const closeTime = await latestTestnetCloseTime();
  const expiry = closeTime + 45;
  const expiryMandate = await register(user, agentKey, merchant, "1.00", expiry);
  const expiryAgent = reapp.agent({ mandate: expiryMandate, signer: agentKey, proofPolicy: "bound-v2-only" });
  const expiryServer = await startServer({ merchant: merchant.publicKey(), port: 0 });
  const expiryBefore = await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey());
  try {
    const quoted = await fetch(`${expiryServer.url}/source/market`, {
      headers: { [REAPP_PAYMENT_CAPABILITIES_HEADER]: BOUND_PAYMENT_CAPABILITY },
    });
    assert.equal(quoted.status, 402);
    const requirement = await parse402(quoted);
    assert.equal(requirement.amount, SOURCE_PRICE);
    assert.ok(await latestTestnetCloseTime() < expiry, "quote must arrive while mandate is valid");
    await waitForLedgerExpiry(expiry);
    await assert.rejects(
      () => journaledPay(expiryAgent, requirement.amount, join(drillRoot, "expiry-payment.json")),
      /#4|MandateExpired/,
    );
    const expiryState = await readMandate(expiryMandate, agentKey);
    assert.equal(expiryState.spent, 0n);
    assert.equal(expiryState.seq, 0);
    assert.equal(await token.balance(TESTNET, TESTNET.nativeSac, merchant.publicKey()), expiryBefore);
  } finally {
    await closeServer(expiryServer.server);
  }
  log("PASS: expired before settlement; no funds moved and no resource was delivered");

  log("\n3/3 live failure drills passed");
  await rm(drillRoot, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  exit(1);
});
