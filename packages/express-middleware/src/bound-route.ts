import { createHash } from "node:crypto";
import { Buffer } from "buffer";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  createBoundReappPaymentMiddleware,
  getBoundDeliveryContext,
  type BoundReappPaymentMiddlewareOptions,
} from "./bound.js";
import type {
  BoundDeliveryRecord,
  BoundRedemptionStore,
  StoredBoundJsonResponse,
} from "./bound-store.js";
import type { VerifiedPayment } from "./types.js";

export interface BoundJsonResult {
  /** Successful paid responses only. Defaults to 200. */
  status?: number;
  body: unknown;
}

export interface BoundJsonFulfillmentContext {
  request: Request;
  payment: Readonly<VerifiedPayment>;
}

export type BoundJsonFulfillment = (
  context: BoundJsonFulfillmentContext,
) => BoundJsonResult | Promise<BoundJsonResult>;

export interface BoundReappPaidJsonRouteOptions extends BoundReappPaymentMiddlewareOptions {
  /** Maximum stored UTF-8 JSON response size. Defaults to 1 MiB. */
  maxResponseBytes?: number;
}

const CONTENT_TYPE = "application/json; charset=utf-8" as const;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

function storedResponse(status: number, body: unknown, maxBytes: number): StoredBoundJsonResponse {
  if (!Number.isInteger(status) || status < 200 || status > 299) {
    throw new Error("paid JSON fulfillment status must be an integer from 200 through 299");
  }
  const json = JSON.stringify(body);
  if (json === undefined) throw new Error("paid JSON fulfillment body must be JSON-serializable");
  const bytes = Buffer.from(json, "utf8");
  if (bytes.length > maxBytes) throw new Error("paid JSON fulfillment body exceeds maxResponseBytes");
  return Object.freeze({
    status,
    contentType: CONTENT_TYPE,
    bodyBase64: bytes.toString("base64"),
    bodySha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function terminalFailure(maxBytes: number): StoredBoundJsonResponse {
  return storedResponse(200, {
    ok: false,
    error: "paid fulfillment failed after settlement",
    deliveryState: "terminal",
  }, maxBytes);
}

/**
 * Resolve an orphaned at-most-once execution without invoking fulfillment
 * again. Call this only from trusted operator/outbox code after confirming the
 * original execution owner is dead. The exact terminal bytes become immutable
 * and subsequent receipt recovery replays them.
 */
export async function resolveBoundReappInterruptedDelivery(options: {
  redemptionStore: BoundRedemptionStore;
  record: Readonly<BoundDeliveryRecord>;
  maxResponseBytes?: number;
}): Promise<Readonly<BoundDeliveryRecord>> {
  if (options.record.state !== "executing") {
    throw new Error("only an executing paid delivery can be resolved as interrupted");
  }
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16_777_216) {
    throw new Error("maxResponseBytes must be an integer from 1 through 16777216");
  }
  const completed = await options.redemptionStore.complete({
    key: options.record.key,
    proofDigest: options.record.proofDigest,
    executionId: options.record.executionId,
    response: terminalFailure(maxBytes),
  });
  if (completed.kind !== "completed" || completed.record.state !== "completed") {
    throw new Error("interrupted paid delivery could not be resolved atomically");
  }
  return completed.record;
}

function decodeStoredResponse(
  stored: Readonly<StoredBoundJsonResponse>,
  maxBytes: number,
): Buffer {
  if (
    !Number.isInteger(stored.status)
    || stored.status < 200
    || stored.status > 299
    || stored.contentType !== CONTENT_TYPE
    || !/^[0-9a-f]{64}$/.test(stored.bodySha256)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(stored.bodyBase64)
  ) {
    throw new Error("stored paid response schema is invalid");
  }
  const bytes = Buffer.from(stored.bodyBase64, "base64");
  if (
    bytes.length > maxBytes
    || bytes.toString("base64") !== stored.bodyBase64
    || createHash("sha256").update(bytes).digest("hex") !== stored.bodySha256
  ) {
    throw new Error("stored paid response integrity check failed");
  }
  return bytes;
}

function sendStored(
  response: Response,
  stored: Readonly<StoredBoundJsonResponse>,
  maxBytes: number,
): void {
  const bytes = decodeStoredResponse(stored, maxBytes);
  response.status(stored.status);
  response.set("content-type", stored.contentType);
  response.set("content-length", String(bytes.length));
  response.set("cache-control", "private, no-store");
  response.set("x-content-type-options", "nosniff");
  response.end(bytes);
}

function unavailable(response: Response, message: string): void {
  response.status(503);
  response.set("retry-after", "1");
  response.set("cache-control", "private, no-store");
  response.json({ error: message, retryable: true });
}

/**
 * Safe paid JSON route. Fulfillment executes once after an atomic claim; its
 * exact bytes are stored before they are sent. Recovery replays those bytes and
 * never invokes the fulfillment callback again.
 */
export function createBoundReappPaidJsonRoute(
  options: BoundReappPaidJsonRouteOptions,
  fulfill: BoundJsonFulfillment,
): RequestHandler {
  if (typeof fulfill !== "function") throw new Error("paid JSON fulfillment callback is required");
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16_777_216) {
    throw new Error("maxResponseBytes must be an integer from 1 through 16777216");
  }
  const authorize = createBoundReappPaymentMiddleware(options);

  return (request: Request, response: Response, next: NextFunction): void => {
    authorize(request, response, (authorizationError?: unknown) => {
      if (authorizationError) {
        next(authorizationError);
        return;
      }
      void (async () => {
        const context = getBoundDeliveryContext(response);
        if (!context) throw new Error("bound delivery context was unavailable");
        if (context.kind === "completed") {
          if (context.record.state !== "completed") throw new Error("completed delivery record is inconsistent");
          sendStored(response, context.record.response, maxBytes);
          return;
        }
        if (context.record.state !== "executing") {
          throw new Error("claimed delivery record is inconsistent");
        }

        let result: StoredBoundJsonResponse;
        try {
          const provided = await fulfill({ request, payment: context.record.payment });
          result = storedResponse(provided.status ?? 200, provided.body, maxBytes);
        } catch {
          // Store one immutable terminal result. Never re-run arbitrary paid work.
          result = terminalFailure(maxBytes);
        }

        let completed;
        try {
          completed = await options.redemptionStore.complete({
            key: context.record.key,
            proofDigest: context.record.proofDigest,
            executionId: context.record.executionId,
            response: result,
          });
        } catch {
          unavailable(response, "paid fulfillment result store is unavailable; retry the same proof");
          return;
        }
        if (completed.kind !== "completed" || completed.record.state !== "completed") {
          unavailable(response, "paid fulfillment result could not be committed");
          return;
        }
        sendStored(response, completed.record.response, maxBytes);
      })().catch(next);
    });
  };
}
