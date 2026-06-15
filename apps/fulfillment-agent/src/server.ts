/**
 * Reference fulfillment agent (the merchant).
 *
 * A 402-gated HTTP API that sells "premium research sources". It is the first
 * thing a developer reads to learn the safe REAPP pattern, so it is written to be
 * exemplary and to call out the unsafe shortcuts a developer might invent.
 *
 * The x402 flow:
 *   1. GET /source/:id  with no payment   -> 402 + an x402 challenge.
 *   2. The agent pays on-chain (MandateRegistry.execute_payment) and retries with
 *      an `X-PAYMENT` settlement proof (the transaction hash).
 *   3. The server VERIFIES that payment on-chain before serving the resource.
 *
 * THE SAFE PATTERN this file demonstrates:
 *   The merchant NEVER trusts the client's claim. It independently reads the
 *   transaction from Soroban RPC, confirms the contract's `payment` event paid
 *   THIS merchant at least the price, and refuses to honor the same payment twice.
 *
 * UNSAFE patterns a developer might invent (all rejected here):
 *   - Trusting the `X-PAYMENT` header without reading the chain.   (forgeable)
 *   - Checking only that "a tx succeeded", not merchant + amount.  (pay someone else, get my goods)
 *   - Not tracking spent proofs.                                   (one payment, unlimited unlocks)
 *
 * Zero HTTP framework: uses node:http so the example has nothing to learn around it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { rpc, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import { TESTNET } from "@reapp-sdk/stellar";
import { decodePaymentProof, X_PAYMENT_HEADER } from "@reapp-sdk/core";

const DEFAULT_PRICE = "1.00"; // XLM per source
const PRICE_STROOPS = 10_000_000n; // 1.00 XLM, the minimum a payment must settle to unlock

/** The premium "sources" this merchant sells. The content is what a paid request
 *  unlocks. A real merchant would gate anything (an API, a file, a model call);
 *  here it is a short canned dataset so the demo is deterministic. */
const CATALOG: Record<string, { name: string; data: string }> = {
  market: { name: "Market Data API", data: "Live prices, 30d volatility, liquidity depth, and on-chain flow for the requested assets." },
  academic: { name: "Academic Papers", data: "Peer-reviewed studies with empirical results, sample sizes, and methodology notes." },
  news: { name: "News Archive", data: "Recent events, official announcements, and aggregated market sentiment." },
  patents: { name: "Patent Database", data: "Worldwide IP filings: inventions, assignees, jurisdictions, and filing-trend deltas." },
  analyst: { name: "Analyst Reports", data: "Premium desk forecasts, ratings, price targets, and competitive positioning." },
  expert: { name: "Expert Network", data: "Practitioner interview transcripts: primary, non-public operating insight." },
};

export interface ServerOptions {
  /** The merchant's Stellar address (G...). Payments must land here to unlock. */
  merchant: string;
  /** Port to listen on. Default 8402. */
  port?: number;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

/** The x402 challenge for a resource: pay `DEFAULT_PRICE` to `merchant` in XLM. */
function challenge(resource: string, merchant: string) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "reapp-soroban",
        network: "stellar-testnet",
        maxAmountRequired: DEFAULT_PRICE,
        asset: TESTNET.nativeSac,
        payTo: merchant,
        resource,
        extra: { contract: TESTNET.mandateRegistryId },
      },
    ],
  };
}

export function startServer(opts: ServerOptions): { server: Server; port: number; url: string } {
  const merchant = opts.merchant.trim();
  if (!merchant.startsWith("G")) {
    throw new Error("startServer: `merchant` must be a Stellar address (G...)");
  }
  const port = opts.port ?? 8402;
  const soroban = new rpc.Server(TESTNET.rpcUrl, { allowHttp: TESTNET.rpcUrl.startsWith("http://") });

  // Proofs already redeemed. A real merchant persists this; in-memory is fine for a
  // single-process demo. Without it, one on-chain payment could unlock forever.
  const redeemed = new Set<string>();

  /** Independently verify, against the chain, that `txHash` is a successful
   *  `execute_payment` that paid THIS merchant at least the price. Never trusts
   *  the caller: it reads the transaction and decodes the contract's payment event
   *  (topics: "payment", merchant; data: mandate_id, amount). */
  async function verifyOnChain(txHash: string): Promise<{ ok: true; amount: bigint } | { ok: false; reason: string }> {
    if (!/^[0-9a-f]{64}$/i.test(txHash)) return { ok: false, reason: "proof is not a transaction hash" };

    // The payment settles before the agent retries, but RPC can lag a beat; poll briefly.
    let tx = await soroban.getTransaction(txHash);
    for (let i = 0; tx.status === "NOT_FOUND" && i < 15; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      tx = await soroban.getTransaction(txHash);
    }
    if (tx.status !== "SUCCESS") return { ok: false, reason: `transaction is ${tx.status}, not SUCCESS` };

    // Contract events live per-operation in TransactionMetaV4 (protocol 23+) and
    // nested under sorobanMeta in V3. Try V4 first, then fall back to V3.
    let events: xdr.ContractEvent[] = [];
    try {
      events = tx.resultMetaXdr.v4().operations().flatMap((op) => op.events());
    } catch {
      try {
        events = tx.resultMetaXdr.v3().sorobanMeta()?.events() ?? [];
      } catch {
        events = [];
      }
    }
    if (events.length === 0) return { ok: false, reason: "transaction carried no Soroban contract events" };
    for (const ev of events) {
      // SAFETY (the load-bearing check): only honor events emitted by the real
      // MandateRegistry. Topics and data are attacker-controllable — any contract
      // can publish a ("payment", merchant, amount) event — so without binding the
      // emitting contract, a forged event would unlock the resource for free.
      const cid = ev.contractId();
      if (!cid || StrKey.encodeContract(cid as unknown as Buffer) !== TESTNET.mandateRegistryId) continue;
      const v0 = ev.body().v0();
      const topics = v0.topics();
      const t0 = topics[0];
      const t1 = topics[1];
      if (!t0 || !t1) continue;
      if (scValToNative(t0) !== "payment") continue;
      const paidMerchant = String(scValToNative(t1));
      if (paidMerchant !== merchant) continue; // paid someone else: not our sale
      const data = scValToNative(v0.data()) as unknown[]; // [mandate_id, amount]
      const amount = BigInt(data[1] as bigint | number | string);
      if (amount < PRICE_STROOPS) return { ok: false, reason: `paid ${amount} stroops, below the price` };
      return { ok: true, amount };
    }
    return { ok: false, reason: "no payment event to this merchant in that transaction" };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const match = url.pathname.match(/^\/source\/([a-z]+)$/);
    if (!match) return send(res, 404, { error: "not found" });

    const id = match[1]!;
    const source = CATALOG[id];
    if (!source) return send(res, 404, { error: `unknown source "${id}"` });

    const proofHeader = req.headers[X_PAYMENT_HEADER];
    // No payment yet: answer 402 with the challenge. The only thing an unpaid
    // request ever gets.
    if (!proofHeader || typeof proofHeader !== "string") {
      return send(res, 402, challenge(url.pathname, merchant));
    }

    // A payment was claimed. Decode it, verify it ON-CHAIN, and refuse replays.
    let txHash: string;
    try {
      txHash = decodePaymentProof(proofHeader).txHash;
    } catch {
      return send(res, 402, { error: "malformed X-PAYMENT proof", ...challenge(url.pathname, merchant) });
    }
    if (redeemed.has(txHash)) {
      return send(res, 402, { error: "this payment was already redeemed", ...challenge(url.pathname, merchant) });
    }
    // Reserve the proof synchronously, BEFORE the async verification, so two
    // concurrent requests with the same proof cannot both pass the has() check
    // during the await window (TOCTOU). On a verification failure we release it,
    // so a transient RPC lag does not permanently burn a real payment.
    redeemed.add(txHash);
    const verdict = await verifyOnChain(txHash);
    if (!verdict.ok) {
      redeemed.delete(txHash);
      return send(res, 402, { error: `payment not verified on-chain: ${verdict.reason}`, ...challenge(url.pathname, merchant) });
    }

    send(res, 200, { source: id, name: source.name, data: source.data, settledTx: txHash });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { error: e instanceof Error ? e.message : String(e) }));
  });
  server.listen(port);
  return { server, port, url: `http://localhost:${port}` };
}

// Run standalone: `REAPP_MERCHANT=G... tsx src/server.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const merchant = (process.env.REAPP_MERCHANT ?? "").trim();
  const { url } = startServer({ merchant, port: Number(process.env.PORT ?? 8402) });
  console.log(`fulfillment-agent listening on ${url}  merchant=${merchant}`);
}
