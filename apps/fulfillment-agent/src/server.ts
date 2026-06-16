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

/** Pull contract events out of a transaction's result meta across protocol
 *  versions: V4 (protocol 23+) carries them per operation, V3 nests them under
 *  sorobanMeta. Returns an empty array if neither shape is present. */
export function extractContractEvents(meta: xdr.TransactionMeta): xdr.ContractEvent[] {
  try {
    return meta.v4().operations().flatMap((op) => op.events());
  } catch {
    try {
      return meta.v3().sorobanMeta()?.events() ?? [];
    } catch {
      return [];
    }
  }
}

/** A contract event flattened to a network-free shape, so the matching logic can
 *  be tested without constructing XDR by hand. */
export interface DecodedEvent {
  /** Strkey contract id of the emitter, or null if the event carries none. */
  contractId: string | null;
  /** First topic; the registry's payment event uses the symbol "payment". */
  topic0: unknown;
  /** Second topic; the registry's payment event uses the merchant address. */
  topic1: unknown;
  /** The i128 amount from the event data ([mandate_id, amount]), or null. */
  amount: bigint | null;
}

/** Decode raw contract events into {@link DecodedEvent}s. This is the only place
 *  that touches XDR; it is kept thin so the security decision below stays pure. */
export function interpretEvents(events: xdr.ContractEvent[]): DecodedEvent[] {
  return events.map((ev) => {
    const cid = ev.contractId();
    const contractId = cid ? StrKey.encodeContract(cid as unknown as Buffer) : null;
    let topic0: unknown;
    let topic1: unknown;
    let amount: bigint | null = null;
    try {
      const v0 = ev.body().v0();
      const topics = v0.topics();
      if (topics[0]) topic0 = scValToNative(topics[0]);
      if (topics[1]) topic1 = scValToNative(topics[1]);
      const data = scValToNative(v0.data()) as unknown;
      if (Array.isArray(data) && data.length >= 2) {
        amount = BigInt(data[1] as bigint | number | string);
      }
    } catch {
      // A malformed event leaves the fields unset; selectPayment skips it.
    }
    return { contractId, topic0, topic1, amount };
  });
}

/** What a valid payment must satisfy for this merchant. */
export interface PaymentCheck {
  /** The merchant address that must be paid. */
  merchant: string;
  /** Strkey of the trusted MandateRegistry. Events from any other contract are ignored. */
  registryId: string;
  /** Minimum amount (stroops) that unlocks the resource. */
  priceStroops: bigint;
}

/** The security decision, pure and fully testable: is there a `payment` event,
 *  emitted by the trusted registry, that paid THIS merchant at least the price?
 *  Every way a forged or wrong payment is rejected lives here. */
export function selectPayment(
  decoded: DecodedEvent[],
  cfg: PaymentCheck,
): { ok: true; amount: bigint } | { ok: false; reason: string } {
  if (decoded.length === 0) {
    return { ok: false, reason: "transaction carried no Soroban contract events" };
  }
  for (const ev of decoded) {
    // SAFETY (the load-bearing check): only honor events emitted by the real
    // MandateRegistry. Topics and data are attacker-controllable, so a forged
    // ("payment", merchant, amount) event from any other contract (for example
    // the token's own "transfer" event in the same transaction) must be ignored.
    if (ev.contractId !== cfg.registryId) continue;
    if (ev.topic0 !== "payment") continue;
    if (String(ev.topic1) !== cfg.merchant) continue; // paid someone else: not our sale
    if (ev.amount === null) continue;
    if (ev.amount < cfg.priceStroops) {
      return { ok: false, reason: `paid ${ev.amount} stroops, below the price` };
    }
    return { ok: true, amount: ev.amount };
  }
  return { ok: false, reason: "no payment event to this merchant in that transaction" };
}

/** Tracks redeemed payment proofs and reserves them atomically. `reserve` is
 *  synchronous so two concurrent requests with the same proof cannot both pass
 *  during an await window (TOCTOU); a failed verification `release`s the proof so
 *  a transient RPC lag does not permanently burn a real payment. */
export class ProofLedger {
  private readonly redeemed = new Set<string>();
  /** Reserve `txHash`. Returns false if it was already reserved. */
  reserve(txHash: string): boolean {
    if (this.redeemed.has(txHash)) return false;
    this.redeemed.add(txHash);
    return true;
  }
  /** Release a previously reserved `txHash` (used when verification fails). */
  release(txHash: string): void {
    this.redeemed.delete(txHash);
  }
  /** Whether `txHash` is currently reserved. */
  has(txHash: string): boolean {
    return this.redeemed.has(txHash);
  }
}

export function startServer(opts: ServerOptions): { server: Server; port: number; url: string } {
  const merchant = opts.merchant.trim();
  if (!merchant.startsWith("G")) {
    throw new Error("startServer: `merchant` must be a Stellar address (G...)");
  }
  const port = opts.port ?? 8402;
  const soroban = new rpc.Server(TESTNET.rpcUrl, { allowHttp: TESTNET.rpcUrl.startsWith("http://") });

  // Redeemed proofs. A real merchant persists this; in-memory is fine for a
  // single-process demo. Without it, one on-chain payment could unlock forever.
  const ledger = new ProofLedger();
  const check: PaymentCheck = {
    merchant,
    registryId: TESTNET.mandateRegistryId,
    priceStroops: PRICE_STROOPS,
  };

  /** Independently verify, against the chain, that `txHash` is a successful
   *  `execute_payment` that paid THIS merchant at least the price. Never trusts
   *  the caller: it reads the transaction, then matches the registry's payment
   *  event (topics: "payment", merchant; data: mandate_id, amount) through the
   *  pure {@link selectPayment} so the security decision is unit-tested. */
  async function verifyOnChain(txHash: string): Promise<{ ok: true; amount: bigint } | { ok: false; reason: string }> {
    if (!/^[0-9a-f]{64}$/i.test(txHash)) return { ok: false, reason: "proof is not a transaction hash" };

    // The payment settles before the agent retries, but RPC can lag a beat; poll briefly.
    let tx = await soroban.getTransaction(txHash);
    for (let i = 0; tx.status === "NOT_FOUND" && i < 15; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      tx = await soroban.getTransaction(txHash);
    }
    if (tx.status !== "SUCCESS") return { ok: false, reason: `transaction is ${tx.status}, not SUCCESS` };

    return selectPayment(interpretEvents(extractContractEvents(tx.resultMetaXdr)), check);
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
    // Reserve the proof synchronously, BEFORE the async verification, so two
    // concurrent requests with the same proof cannot both pass during the await
    // window (TOCTOU). A verification failure releases it, so a transient RPC lag
    // does not permanently burn a real payment.
    if (!ledger.reserve(txHash)) {
      return send(res, 402, { error: "this payment was already redeemed", ...challenge(url.pathname, merchant) });
    }
    const verdict = await verifyOnChain(txHash);
    if (!verdict.ok) {
      ledger.release(txHash);
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
