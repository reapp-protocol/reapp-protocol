/**
 * Reference fulfillment agent: an Express API protected by REAPP settlement.
 *
 * Safe pattern:
 *   - issue a 402 requirement;
 *   - independently verify the successful MandateRegistry payment and matching
 *     SEP-41 transfer through @reapp-sdk/express-middleware;
 *   - atomically bind the settlement transaction to its first signed proof;
 *   - allow only the exact proof to recover the same idempotent resource.
 *
 * Unsafe patterns this example never uses:
 *   - trusting amount or mandate claims in X-PAYMENT;
 *   - treating a successful arbitrary transaction as payment;
 *   - treating cached application claims as a substitute for initial chain evidence;
 *   - serving first and checking settlement afterward.
 */
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Buffer } from "buffer";
import { once } from "node:events";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import {
  InMemoryBoundRedemptionStore,
  createBoundReappPaidJsonRoute,
  resolveBoundReappInterruptedDelivery,
  type BoundRedemptionStore,
  type PaymentVerifier,
} from "@reapp-sdk/express-middleware";
import { FileBoundRedemptionStore } from "./redemption-store.js";

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
  /** Stable HMAC secret for restart-safe bound challenges. A process-local secret is generated for demos. */
  challengeSecret?: string | Uint8Array;
  /** Exact public HTTP(S) origin included in every signed challenge. */
  audience: string | ((request: Request) => string);
  /** Durable/shared in production. The default is process-local for the one-command demo. */
  redemptionStore?: BoundRedemptionStore;
  /** Deterministic test/alternate infrastructure hook. */
  verifier?: PaymentVerifier;
}

export interface ServerOptions extends FulfillmentAppOptions {
  /** Port to listen on. Defaults to 8402. */
  port?: number;
}

export function createFulfillmentApp(options: FulfillmentAppOptions): Express {
  const app = express();
  const challengeSecret = options.challengeSecret ?? randomBytes(32);
  const redemptionStore = options.redemptionStore ?? new InMemoryBoundRedemptionStore();
  const paidSource = createBoundReappPaidJsonRoute({
    merchant: options.merchant,
    sourceAccount: options.sourceAccount ?? options.merchant,
    amount: SOURCE_PRICE,
    audience: options.audience,
    challengeSecret,
    redemptionStore,
    resource: (request) => request.originalUrl,
    verifier: options.verifier,
  }, ({ request, payment }) => {
    const id = request.params.id as string;
    const source = CATALOG[id];
    if (!source) throw new Error("validated source disappeared before fulfillment");
    return {
      body: {
        ok: true,
        source: id,
        name: source.name,
        data: source.data,
        settledTx: payment.txHash,
        mandateId: payment.mandateId,
        settledAmount: payment.amount,
      },
    };
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
    paidSource,
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

export async function startServer(
  options: Omit<ServerOptions, "audience"> & { audience?: ServerOptions["audience"] },
): Promise<{ server: Server; port: number; url: string }> {
  const requestedPort = options.port ?? 8402;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("port must be an integer from 0 through 65535");
  }
  let runtimeAudience: string | undefined;
  const audience = options.audience ?? (() => {
    if (!runtimeAudience) throw new Error("fulfillment public origin is not initialized");
    return runtimeAudience;
  });
  const server = createFulfillmentApp({ ...options, audience }).listen(requestedPort);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("fulfillment server did not bind a TCP port");
  }
  const port = address.port;
  const url = `http://127.0.0.1:${port}`;
  runtimeAudience = url;
  return { server, port, url };
}

// Standalone merchant: `REAPP_MERCHANT=G... npm run start -w @reapp-sdk/fulfillment-agent`
if (import.meta.url === `file://${process.argv[1]}`) {
  const merchant = (process.env.REAPP_MERCHANT ?? "").trim();
  const sourceAccount = (process.env.REAPP_READ_SOURCE ?? merchant).trim();
  const challengeSecret = (process.env.REAPP_CHALLENGE_SECRET ?? "").trim();
  const redemptionPath = (process.env.REAPP_REDEMPTION_STORE ?? "").trim();
  const publicOrigin = (process.env.REAPP_PUBLIC_ORIGIN ?? "").trim() || undefined;
  if (Buffer.byteLength(challengeSecret, "utf8") < 32) {
    console.error("REAPP_CHALLENGE_SECRET must contain at least 32 bytes for restart-safe fulfillment");
    process.exitCode = 1;
  } else if (!redemptionPath) {
    console.error("REAPP_REDEMPTION_STORE must name a private durable redemption file");
    process.exitCode = 1;
  } else {
    const redemptionStore = new FileBoundRedemptionStore(redemptionPath);
    void (async () => {
      for (const record of await redemptionStore.listExecuting()) {
        await resolveBoundReappInterruptedDelivery({ redemptionStore, record });
      }
      return startServer({
        merchant,
        sourceAccount,
        challengeSecret,
        audience: publicOrigin,
        redemptionStore,
        port: Number(process.env.PORT ?? 8402),
      });
    })().then(({ url }) => {
      console.log(`fulfillment-agent listening on ${url}  merchant=${merchant}`);
    }).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
