/**
 * Reference fulfillment agent: an Express API protected by REAPP settlement.
 *
 * Safe pattern:
 *   - issue a 402 requirement;
 *   - independently verify the successful MandateRegistry payment and matching
 *     SEP-41 transfer through @reapp-sdk/express-middleware;
 *   - atomically consume the settlement before serving the resource.
 *
 * Unsafe patterns this example never uses:
 *   - trusting amount or mandate claims in X-PAYMENT;
 *   - treating a successful arbitrary transaction as payment;
 *   - consulting cached application state instead of contract evidence;
 *   - serving first and checking settlement afterward.
 */
import type { Server } from "node:http";
import { once } from "node:events";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import {
  InMemoryRedemptionStore,
  createReappPaymentMiddleware,
  getVerifiedPayment,
  type PaymentVerifier,
  type RedemptionStore,
} from "@reapp-sdk/express-middleware";

export const SOURCE_PRICE = "1.00";

/** Deterministic demo content. A real merchant can protect any API or model call. */
export const CATALOG: Readonly<Record<string, Readonly<{ name: string; data: string }>>> = Object.freeze({
  market: Object.freeze({ name: "Market Data API", data: "Live prices, 30d volatility, liquidity depth, and on-chain flow for the requested assets." }),
  academic: Object.freeze({ name: "Academic Papers", data: "Peer-reviewed studies with empirical results, sample sizes, and methodology notes." }),
  news: Object.freeze({ name: "News Archive", data: "Recent events, official announcements, and aggregated market sentiment." }),
  patents: Object.freeze({ name: "Patent Database", data: "Worldwide IP filings: inventions, assignees, jurisdictions, and filing-trend deltas." }),
  analyst: Object.freeze({ name: "Analyst Reports", data: "Premium desk forecasts, ratings, price targets, and competitive positioning." }),
  expert: Object.freeze({ name: "Expert Network", data: "Practitioner interview transcripts: primary, non-public operating insight." }),
});

export interface FulfillmentAppOptions {
  /** Merchant Stellar address that must receive every protected payment. */
  merchant: string;
  /** Funded G-address used only for read-only contract simulation. Defaults to merchant. */
  sourceAccount?: string;
  /** Required in production; the default is safe only for this one-process demo. */
  redemptionStore?: RedemptionStore;
  /** Deterministic test/alternate infrastructure hook. */
  verifier?: PaymentVerifier;
}

export interface ServerOptions extends FulfillmentAppOptions {
  /** Port to listen on. Defaults to 8402. */
  port?: number;
}

export function createFulfillmentApp(options: FulfillmentAppOptions): Express {
  const app = express();
  const redemptionStore = options.redemptionStore ?? new InMemoryRedemptionStore();
  const requirePayment = createReappPaymentMiddleware({
    merchant: options.merchant,
    sourceAccount: options.sourceAccount ?? options.merchant,
    amount: SOURCE_PRICE,
    resource: (request) => request.originalUrl,
    redemptionStore,
    verifier: options.verifier,
  });

  app.get(
    "/source/:id",
    (request: Request, response: Response, next: NextFunction): void => {
      const id = request.params.id;
      if (typeof id !== "string" || !CATALOG[id]) {
        response.status(404).json({ error: `unknown source ${JSON.stringify(id)}` });
        return;
      }
      next();
    },
    requirePayment,
    (request: Request, response: Response): void => {
      const id = request.params.id as string;
      const source = CATALOG[id];
      const payment = getVerifiedPayment(response);
      if (!source || !payment) {
        response.status(500).json({ error: "verified fulfillment evidence was unavailable" });
        return;
      }
      response.json({
        source: id,
        name: source.name,
        data: source.data,
        settledTx: payment.txHash,
        mandateId: payment.mandateId,
        settledAmount: payment.amount,
      });
    },
  );

  app.use((_request: Request, response: Response): void => {
    response.status(404).json({ error: "not found" });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction): void => {
    response.set("cache-control", "private, no-store");
    response.status(500).json({
      error: `fulfillment failed closed: ${error instanceof Error ? error.message : String(error)}`,
    });
  });

  return app;
}

export async function startServer(options: ServerOptions): Promise<{ server: Server; port: number; url: string }> {
  const requestedPort = options.port ?? 8402;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("port must be an integer from 0 through 65535");
  }
  const server = createFulfillmentApp(options).listen(requestedPort);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("fulfillment server did not bind a TCP port");
  }
  const port = address.port;
  return { server, port, url: `http://127.0.0.1:${port}` };
}

// Standalone merchant: `REAPP_MERCHANT=G... npm run start -w @reapp-sdk/fulfillment-agent`
if (import.meta.url === `file://${process.argv[1]}`) {
  const merchant = (process.env.REAPP_MERCHANT ?? "").trim();
  const sourceAccount = (process.env.REAPP_READ_SOURCE ?? merchant).trim();
  void startServer({
    merchant,
    sourceAccount,
    port: Number(process.env.PORT ?? 8402),
  }).then(({ url }) => {
    console.log(`fulfillment-agent listening on ${url}  merchant=${merchant}`);
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
