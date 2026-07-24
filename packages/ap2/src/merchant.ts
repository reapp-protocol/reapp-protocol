/**
 * Merchant-side AP2 v0.2 verification.
 *
 * This verifies open/closed Checkout and Payment Mandate chains and evaluates
 * their disclosed constraints against the exact merchant-signed checkout.
 * It is an admission/evidence boundary. MandateRegistry remains authoritative
 * for Stellar scope, budget, expiry, sequence, and token movement.
 */
import {
  hashAp2Text,
  signCompactJws,
  verifyCompactJws,
  verifyDelegateSdJwtChain,
  type Ap2JwsHeader,
  type Ap2JwsPublicKey,
  type SignCompactJwsOptions,
  type VerifiedDelegateSdJwtChain,
} from "./sd-jwt.js";

export const AP2_OPEN_CHECKOUT_VCT = "mandate.checkout.open.1" as const;
export const AP2_CHECKOUT_VCT = "mandate.checkout.1" as const;
export const AP2_CLOSED_PAYMENT_VCT = "mandate.payment.1" as const;

export interface Ap2MerchantIdentity {
  id: string;
  name: string;
  website?: string;
}

export interface Ap2Amount {
  amount: number;
  currency: string;
}

export interface Ap2PaymentInstrument {
  id: string;
  type: string;
  description?: string;
}

export interface Ap2Pisp {
  legal_name: string;
  brand_name: string;
  domain_name: string;
}

export interface Ap2CheckoutLineItem {
  id: string;
  item: {
    id: string;
    title: string;
    price: number;
    image_url?: string;
  };
  quantity: number;
  totals: readonly unknown[];
  parent_id?: string;
}

export interface Ap2Checkout {
  id: string;
  merchant?: Ap2MerchantIdentity;
  line_items: readonly Ap2CheckoutLineItem[];
  status: string;
  currency: string;
  totals: readonly unknown[];
  links: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface Ap2ClosedCheckoutMandate {
  vct: typeof AP2_CHECKOUT_VCT;
  checkout_jwt: string;
  checkout_hash: string;
  iat?: number;
  exp?: number;
}

export interface Ap2ClosedPaymentMandate {
  vct: typeof AP2_CLOSED_PAYMENT_VCT;
  transaction_id: string;
  payee: Ap2MerchantIdentity;
  payment_amount: Ap2Amount;
  payment_instrument: Ap2PaymentInstrument;
  pisp?: Ap2Pisp;
  execution_date?: string;
  risk_data?: Readonly<Record<string, unknown>>;
  iat?: number;
  exp?: number;
}

export interface Ap2MandateUsageContext {
  totalAmountMinor: number;
  totalUses: number;
  lastUsedAt?: number;
}

export interface VerifyAp2CheckoutAuthorizationInput {
  checkoutMandateChain: string;
  resolveCheckoutRootKey: Parameters<typeof verifyDelegateSdJwtChain>[1]["resolveRootKey"];
  resolveCheckoutJwtKey: (
    header: Readonly<Ap2JwsHeader>,
    payload: Readonly<Record<string, unknown>>,
  ) => Ap2JwsPublicKey | Promise<Ap2JwsPublicKey>;
  expectedAudience: string;
  expectedCheckoutNonce: string;
  expectedMerchant: Ap2MerchantIdentity;
  expectedCurrency: string;
  currentTime?: number;
  clockSkewSeconds?: number;
}

export interface VerifyAp2MerchantAuthorizationInput
  extends VerifyAp2CheckoutAuthorizationInput {
  paymentMandateChain: string;
  resolvePaymentRootKey: Parameters<typeof verifyDelegateSdJwtChain>[1]["resolveRootKey"];
  expectedPaymentNonce: string;
  expectedAmountMinor: number;
  usage?: Ap2MandateUsageContext;
  /** ISO-4217 exponent for `payment.budget`; defaults to 2. */
  currencyMinorUnitExponent?: number;
}

export interface VerifiedAp2CheckoutAuthorization {
  checkoutChain: VerifiedDelegateSdJwtChain;
  checkout: Readonly<Ap2Checkout>;
  closedCheckout: Readonly<Ap2ClosedCheckoutMandate>;
  checkoutJwtHash: string;
  openCheckoutHash: string;
  closedCheckoutHash: string;
}

export interface VerifiedAp2MerchantAuthorization
  extends VerifiedAp2CheckoutAuthorization {
  paymentChain: VerifiedDelegateSdJwtChain;
  closedPayment: Readonly<Ap2ClosedPaymentMandate>;
  openPaymentHash: string;
  closedPaymentHash: string;
}

export class Ap2MerchantVerificationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "Ap2MerchantVerificationError";
  }
}

function reject(code: string, message: string): never {
  throw new Ap2MerchantVerificationError(code, message);
}

function object(label: string, value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    reject("SCHEMA_INVALID", `${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function text(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    reject("SCHEMA_INVALID", `${label} must be a non-empty string.`);
  }
  return value;
}

function integer(label: string, value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    reject("SCHEMA_INVALID", `${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value as number;
}

function array(label: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) reject("SCHEMA_INVALID", `${label} must be an array.`);
  return value;
}

function merchant(label: string, value: unknown): Ap2MerchantIdentity {
  const candidate = object(label, value);
  const result: Ap2MerchantIdentity = {
    id: text(`${label}.id`, candidate.id),
    name: text(`${label}.name`, candidate.name),
  };
  if (candidate.website !== undefined) result.website = text(`${label}.website`, candidate.website);
  return result;
}

function merchantMatches(candidate: Ap2MerchantIdentity, expected: Ap2MerchantIdentity): boolean {
  if (candidate.id && expected.id) return candidate.id === expected.id;
  return candidate.name === expected.name &&
    candidate.website !== undefined &&
    candidate.website === expected.website;
}

function amount(label: string, value: unknown): Ap2Amount {
  const candidate = object(label, value);
  const currency = text(`${label}.currency`, candidate.currency);
  if (!/^[A-Z]{3}$/.test(currency)) {
    reject("SCHEMA_INVALID", `${label}.currency must be an uppercase ISO-4217 code.`);
  }
  return {
    amount: integer(`${label}.amount`, candidate.amount),
    currency,
  };
}

function paymentInstrument(label: string, value: unknown): Ap2PaymentInstrument {
  const candidate = object(label, value);
  const result: Ap2PaymentInstrument = {
    id: text(`${label}.id`, candidate.id),
    type: text(`${label}.type`, candidate.type),
  };
  if (candidate.description !== undefined) {
    result.description = text(`${label}.description`, candidate.description);
  }
  return result;
}

function pisp(label: string, value: unknown): Ap2Pisp {
  const candidate = object(label, value);
  return {
    legal_name: text(`${label}.legal_name`, candidate.legal_name),
    brand_name: text(`${label}.brand_name`, candidate.brand_name),
    domain_name: text(`${label}.domain_name`, candidate.domain_name),
  };
}

function parseCheckout(value: unknown): Ap2Checkout {
  const candidate = object("checkout JWT payload", value);
  const lineItems = array("checkout.line_items", candidate.line_items).map((entry, index) => {
    const line = object(`checkout.line_items[${index}]`, entry);
    const item = object(`checkout.line_items[${index}].item`, line.item);
    const parsed: Ap2CheckoutLineItem = {
      id: text(`checkout.line_items[${index}].id`, line.id),
      item: {
        id: text(`checkout.line_items[${index}].item.id`, item.id),
        title: text(`checkout.line_items[${index}].item.title`, item.title),
        price: integer(`checkout.line_items[${index}].item.price`, item.price),
      },
      quantity: integer(`checkout.line_items[${index}].quantity`, line.quantity, 1),
      totals: array(`checkout.line_items[${index}].totals`, line.totals),
    };
    if (item.image_url !== undefined) {
      parsed.item.image_url = text(`checkout.line_items[${index}].item.image_url`, item.image_url);
    }
    if (line.parent_id !== undefined) {
      parsed.parent_id = text(`checkout.line_items[${index}].parent_id`, line.parent_id);
    }
    return parsed;
  });
  const status = text("checkout.status", candidate.status);
  if (!new Set([
    "incomplete",
    "requires_escalation",
    "ready_for_complete",
    "complete_in_progress",
    "completed",
    "canceled",
  ]).has(status)) {
    reject("SCHEMA_INVALID", `checkout.status ${JSON.stringify(status)} is not recognized.`);
  }
  const parsed: Ap2Checkout = {
    ...candidate,
    id: text("checkout.id", candidate.id),
    line_items: lineItems,
    status,
    currency: text("checkout.currency", candidate.currency),
    totals: array("checkout.totals", candidate.totals),
    links: array("checkout.links", candidate.links),
  };
  if (!/^[A-Z]{3}$/.test(parsed.currency)) {
    reject("SCHEMA_INVALID", "checkout.currency must be an uppercase ISO-4217 code.");
  }
  if (candidate.merchant !== undefined) parsed.merchant = merchant("checkout.merchant", candidate.merchant);
  return parsed;
}

function parseClosedCheckout(value: unknown): Ap2ClosedCheckoutMandate {
  const candidate = object("closed Checkout Mandate", value);
  if (candidate.vct !== AP2_CHECKOUT_VCT) {
    reject("VCT_MISMATCH", `closed Checkout Mandate must use ${AP2_CHECKOUT_VCT}.`);
  }
  return {
    vct: AP2_CHECKOUT_VCT,
    checkout_jwt: text("closed Checkout Mandate.checkout_jwt", candidate.checkout_jwt),
    checkout_hash: text("closed Checkout Mandate.checkout_hash", candidate.checkout_hash),
    ...(candidate.iat === undefined ? {} : { iat: integer("closed Checkout Mandate.iat", candidate.iat) }),
    ...(candidate.exp === undefined ? {} : { exp: integer("closed Checkout Mandate.exp", candidate.exp) }),
  };
}

function parseClosedPayment(value: unknown): Ap2ClosedPaymentMandate {
  const candidate = object("closed Payment Mandate", value);
  if (candidate.vct !== AP2_CLOSED_PAYMENT_VCT) {
    reject("VCT_MISMATCH", `closed Payment Mandate must use ${AP2_CLOSED_PAYMENT_VCT}.`);
  }
  const parsed: Ap2ClosedPaymentMandate = {
    vct: AP2_CLOSED_PAYMENT_VCT,
    transaction_id: text("closed Payment Mandate.transaction_id", candidate.transaction_id),
    payee: merchant("closed Payment Mandate.payee", candidate.payee),
    payment_amount: amount("closed Payment Mandate.payment_amount", candidate.payment_amount),
    payment_instrument: paymentInstrument(
      "closed Payment Mandate.payment_instrument",
      candidate.payment_instrument,
    ),
  };
  if (candidate.pisp !== undefined) parsed.pisp = pisp("closed Payment Mandate.pisp", candidate.pisp);
  if (candidate.execution_date !== undefined) {
    parsed.execution_date = text("closed Payment Mandate.execution_date", candidate.execution_date);
    if (!Number.isFinite(Date.parse(parsed.execution_date))) {
      reject("SCHEMA_INVALID", "closed Payment Mandate.execution_date must be ISO 8601.");
    }
  }
  if (candidate.risk_data !== undefined) {
    parsed.risk_data = object("closed Payment Mandate.risk_data", candidate.risk_data);
  }
  if (candidate.iat !== undefined) parsed.iat = integer("closed Payment Mandate.iat", candidate.iat);
  if (candidate.exp !== undefined) parsed.exp = integer("closed Payment Mandate.exp", candidate.exp);
  return parsed;
}

function splitChain(
  label: string,
  chain: VerifiedDelegateSdJwtChain,
  openVct: string,
  closedVct: string,
): { opens: Record<string, unknown>[]; closed: Record<string, unknown> } {
  if (chain.payloads.length === 0) reject("CHAIN_INVALID", `${label} chain has no disclosed mandate.`);
  const closed = chain.payloads.at(-1)! as Record<string, unknown>;
  if (closed.vct !== closedVct) reject("VCT_MISMATCH", `${label} chain must end in ${closedVct}.`);
  const opens = chain.payloads.slice(0, -1) as Record<string, unknown>[];
  for (const [index, open] of opens.entries()) {
    if (open.vct !== openVct) {
      reject("VCT_MISMATCH", `${label} open hop ${index} must use ${openVct}.`);
    }
    if (typeof open.cnf !== "object" || open.cnf === null || Array.isArray(open.cnf)) {
      reject("SCHEMA_INVALID", `${label} open hop ${index} must disclose cnf.`);
    }
    array(`${label} open hop ${index}.constraints`, open.constraints);
  }
  return { opens, closed };
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => sameJson(entry, right[index]));
  }
  if (
    typeof left === "object" &&
    left !== null &&
    !Array.isArray(left) &&
    typeof right === "object" &&
    right !== null &&
    !Array.isArray(right)
  ) {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a).sort();
    return keys.length === Object.keys(b).length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameJson(a[key], b[key]));
  }
  return false;
}

function evaluateCheckoutLineItems(constraint: Record<string, unknown>, checkout: Ap2Checkout): void {
  const requirements = array("checkout.line_items.items", constraint.items).map((entry, index) => {
    const requirement = object(`checkout.line_items.items[${index}]`, entry);
    const acceptable = array(
      `checkout.line_items.items[${index}].acceptable_items`,
      requirement.acceptable_items,
    ).map((item, itemIndex) => {
      const parsed = object(`acceptable_items[${itemIndex}]`, item);
      return {
        id: text(`acceptable_items[${itemIndex}].id`, parsed.id),
        title: text(`acceptable_items[${itemIndex}].title`, parsed.title),
      };
    });
    return {
      id: text(`checkout.line_items.items[${index}].id`, requirement.id),
      acceptable: new Set(acceptable.map((item) => item.id)),
      quantity: integer(`checkout.line_items.items[${index}].quantity`, requirement.quantity, 1),
    };
  });
  if (requirements.length === 0) reject("CHECKOUT_CONSTRAINT_FAILED", "line_items constraint is empty.");

  const skuQuantities = new Map<string, number>();
  for (const line of checkout.line_items) {
    skuQuantities.set(line.item.id, (skuQuantities.get(line.item.id) ?? 0) + line.quantity);
  }
  const skus = [...skuQuantities.keys()];
  for (const sku of skus) {
    if (!requirements.some((requirement) => requirement.acceptable.size === 0 || requirement.acceptable.has(sku))) {
      reject("CHECKOUT_CONSTRAINT_FAILED", `checkout item ${JSON.stringify(sku)} is not allowed.`);
    }
  }

  // Small bounded bipartite max flow: source -> SKU quantity -> requirement
  // capacity -> sink. This prevents one cart quantity satisfying two clauses.
  const source = 0;
  const skuOffset = 1;
  const requirementOffset = skuOffset + skus.length;
  const sink = requirementOffset + requirements.length;
  const capacity = Array.from({ length: sink + 1 }, () => Array<number>(sink + 1).fill(0));
  for (const [index, sku] of skus.entries()) {
    capacity[source]![skuOffset + index] = skuQuantities.get(sku)!;
    for (const [requirementIndex, requirement] of requirements.entries()) {
      if (requirement.acceptable.size === 0 || requirement.acceptable.has(sku)) {
        capacity[skuOffset + index]![requirementOffset + requirementIndex] = Number.MAX_SAFE_INTEGER;
      }
    }
  }
  for (const [index, requirement] of requirements.entries()) {
    capacity[requirementOffset + index]![sink] = requirement.quantity;
  }
  let flow = 0;
  while (true) {
    const parent = Array<number>(sink + 1).fill(-1);
    parent[source] = source;
    const queue = [source];
    for (let cursor = 0; cursor < queue.length && parent[sink] === -1; cursor += 1) {
      const from = queue[cursor]!;
      for (let to = 0; to <= sink; to += 1) {
        if (parent[to] === -1 && capacity[from]![to]! > 0) {
          parent[to] = from;
          queue.push(to);
        }
      }
    }
    if (parent[sink] === -1) break;
    let pushed = Number.MAX_SAFE_INTEGER;
    for (let node = sink; node !== source; node = parent[node]!) {
      pushed = Math.min(pushed, capacity[parent[node]!]![node]!);
    }
    for (let node = sink; node !== source; node = parent[node]!) {
      const from = parent[node]!;
      const forward = capacity[from]![node]!;
      const reverse = capacity[node]![from]!;
      capacity[from]![node] = forward - pushed;
      capacity[node]![from] = reverse + pushed;
    }
    flow += pushed;
  }
  const totalCartQuantity = [...skuQuantities.values()].reduce((sum, value) => sum + value, 0);
  if (flow !== totalCartQuantity) {
    reject("CHECKOUT_CONSTRAINT_FAILED", "checkout quantities cannot be assigned to the line-item requirements.");
  }
}

function evaluateCheckoutConstraints(open: Record<string, unknown>, checkout: Ap2Checkout): void {
  for (const raw of array("open Checkout Mandate.constraints", open.constraints)) {
    const constraint = object("Checkout constraint", raw);
    switch (constraint.type) {
      case "checkout.allowed_merchants": {
        if (!checkout.merchant) {
          reject("CHECKOUT_CONSTRAINT_FAILED", "checkout does not identify its merchant.");
        }
        const allowed = array("checkout.allowed_merchants.allowed", constraint.allowed)
          .map((value, index) => merchant(`allowed merchant ${index}`, value));
        if (!allowed.some((candidate) => merchantMatches(candidate, checkout.merchant!))) {
          reject("CHECKOUT_CONSTRAINT_FAILED", "checkout merchant is not allowed.");
        }
        break;
      }
      case "checkout.line_items":
        evaluateCheckoutLineItems(constraint, checkout);
        break;
      default:
        reject("UNKNOWN_CONSTRAINT", `unsupported Checkout constraint ${JSON.stringify(constraint.type)}.`);
    }
  }
}

function toMinorUnits(label: string, value: unknown, exponent: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    reject("SCHEMA_INVALID", `${label} must be a non-negative finite number.`);
  }
  const factor = 10 ** exponent;
  const minor = value * factor;
  if (!Number.isSafeInteger(minor)) {
    reject("SCHEMA_INVALID", `${label} cannot be represented exactly in minor units.`);
  }
  return minor;
}

function evaluatePaymentConstraints(
  open: Record<string, unknown>,
  closed: Ap2ClosedPaymentMandate,
  openCheckoutHash: string,
  usage: Ap2MandateUsageContext | undefined,
  exponent: number,
): void {
  for (const field of ["payee", "payment_amount", "payment_instrument", "pisp", "execution_date"] as const) {
    if (open[field] !== undefined && !sameJson(open[field], closed[field])) {
      reject("PAYMENT_CONSTRAINT_FAILED", `closed Payment Mandate changes preset ${field}.`);
    }
  }

  const constraints = array("open Payment Mandate.constraints", open.constraints)
    .map((value) => object("Payment constraint", value));
  const hasRecurrence = constraints.some((constraint) => constraint.type === "payment.agent_recurrence");
  if (
    hasRecurrence &&
    (!constraints.some((constraint) => constraint.type === "payment.amount_range") ||
      !constraints.some((constraint) => constraint.type === "payment.budget"))
  ) {
    reject("PAYMENT_CONSTRAINT_FAILED", "payment.agent_recurrence requires amount_range and budget.");
  }

  for (const constraint of constraints) {
    switch (constraint.type) {
      case "payment.allowed_payees": {
        const allowed = array("payment.allowed_payees.allowed", constraint.allowed)
          .map((value, index) => merchant(`allowed payee ${index}`, value));
        if (!allowed.some((candidate) => merchantMatches(candidate, closed.payee))) {
          reject("PAYMENT_CONSTRAINT_FAILED", "closed Payment Mandate payee is not allowed.");
        }
        break;
      }
      case "payment.allowed_payment_instruments": {
        const allowed = array("payment.allowed_payment_instruments.allowed", constraint.allowed)
          .map((value, index) => paymentInstrument(`allowed payment instrument ${index}`, value));
        if (!allowed.some((candidate) => candidate.id === closed.payment_instrument.id)) {
          reject("PAYMENT_CONSTRAINT_FAILED", "closed payment instrument is not allowed.");
        }
        break;
      }
      case "payment.allowed_pisps": {
        if (!closed.pisp) reject("PAYMENT_CONSTRAINT_FAILED", "closed Payment Mandate does not identify a PISP.");
        const allowed = array("payment.allowed_pisps.allowed", constraint.allowed)
          .map((value, index) => pisp(`allowed PISP ${index}`, value));
        if (!allowed.some((candidate) => sameJson(candidate, closed.pisp))) {
          reject("PAYMENT_CONSTRAINT_FAILED", "closed PISP is not allowed.");
        }
        break;
      }
      case "payment.amount_range": {
        const currency = text("payment.amount_range.currency", constraint.currency);
        const maximum = integer("payment.amount_range.max", constraint.max);
        const minimum = constraint.min === undefined ? undefined : integer("payment.amount_range.min", constraint.min);
        if (
          closed.payment_amount.currency !== currency ||
          closed.payment_amount.amount > maximum ||
          (minimum !== undefined && closed.payment_amount.amount < minimum)
        ) {
          reject("PAYMENT_CONSTRAINT_FAILED", "closed payment amount is outside the allowed range.");
        }
        break;
      }
      case "payment.budget": {
        const currency = text("payment.budget.currency", constraint.currency);
        const maximum = toMinorUnits("payment.budget.max", constraint.max, exponent);
        if (closed.payment_amount.currency !== currency) {
          reject("PAYMENT_CONSTRAINT_FAILED", "payment budget currency does not match.");
        }
        if (!usage) reject("MISSING_USAGE_CONTEXT", "payment.budget requires cumulative usage context.");
        if (usage.totalAmountMinor + closed.payment_amount.amount > maximum) {
          reject("PAYMENT_CONSTRAINT_FAILED", "closed payment would exceed the cumulative budget.");
        }
        break;
      }
      case "payment.agent_recurrence": {
        const frequency = text("payment.agent_recurrence.frequency", constraint.frequency);
        if (!new Set([
          "ON_DEMAND",
          "DAILY",
          "WEEKLY",
          "BIWEEKLY",
          "MONTHLY",
          "QUARTERLY",
          "ANNUALLY",
        ]).has(frequency)) {
          reject("SCHEMA_INVALID", `unsupported recurrence frequency ${JSON.stringify(frequency)}.`);
        }
        if (constraint.max_occurrences !== undefined) {
          if (!usage) reject("MISSING_USAGE_CONTEXT", "bounded recurrence requires usage context.");
          const limit = integer("payment.agent_recurrence.max_occurrences", constraint.max_occurrences, 1);
          if (usage.totalUses >= limit) {
            reject("PAYMENT_CONSTRAINT_FAILED", "maximum payment occurrences have been reached.");
          }
        }
        break;
      }
      case "payment.execution_date": {
        if (closed.execution_date !== undefined) {
          const execution = Date.parse(closed.execution_date);
          if (!Number.isFinite(execution)) reject("SCHEMA_INVALID", "execution_date must be ISO 8601.");
          if (
            constraint.not_before !== undefined &&
            execution < Date.parse(text("payment.execution_date.not_before", constraint.not_before))
          ) {
            reject("PAYMENT_CONSTRAINT_FAILED", "payment executes before the allowed window.");
          }
          if (
            constraint.not_after !== undefined &&
            execution > Date.parse(text("payment.execution_date.not_after", constraint.not_after))
          ) {
            reject("PAYMENT_CONSTRAINT_FAILED", "payment executes after the allowed window.");
          }
        }
        break;
      }
      case "payment.reference":
        if (
          text("payment.reference.conditional_transaction_id", constraint.conditional_transaction_id) !==
          openCheckoutHash
        ) {
          reject("PAYMENT_CONSTRAINT_FAILED", "Payment Mandate does not reference the open Checkout Mandate.");
        }
        break;
      default:
        reject("UNKNOWN_CONSTRAINT", `unsupported Payment constraint ${JSON.stringify(constraint.type)}.`);
    }
  }
}

export async function verifyAp2CheckoutAuthorization(
  input: VerifyAp2CheckoutAuthorizationInput,
): Promise<Readonly<VerifiedAp2CheckoutAuthorization>> {
  text("expectedAudience", input.expectedAudience);
  text("expectedCheckoutNonce", input.expectedCheckoutNonce);
  const expectedMerchant = merchant("expectedMerchant", input.expectedMerchant);
  const expectedCurrency = text("expectedCurrency", input.expectedCurrency);
  if (!/^[A-Z]{3}$/.test(expectedCurrency)) {
    reject("SCHEMA_INVALID", "expectedCurrency must be an uppercase ISO-4217 code.");
  }

  let checkoutChain: VerifiedDelegateSdJwtChain;
  try {
    checkoutChain = await verifyDelegateSdJwtChain(input.checkoutMandateChain, {
      resolveRootKey: input.resolveCheckoutRootKey,
      expectedAudience: input.expectedAudience,
      expectedNonce: input.expectedCheckoutNonce,
      currentTime: input.currentTime,
      clockSkewSeconds: input.clockSkewSeconds,
    });
  } catch (error) {
    reject("CHAIN_INVALID", error instanceof Error ? error.message : "AP2 mandate chain verification failed.");
  }

  const checkoutMandates = splitChain(
    "Checkout Mandate",
    checkoutChain,
    AP2_OPEN_CHECKOUT_VCT,
    AP2_CHECKOUT_VCT,
  );
  const closedCheckout = parseClosedCheckout(checkoutMandates.closed);

  let checkoutJws;
  try {
    const unsignedParts = closedCheckout.checkout_jwt.split(".");
    if (unsignedParts.length !== 3) reject("CHECKOUT_JWT_INVALID", "checkout_jwt is not a compact JWS.");
    const header = JSON.parse(Buffer.from(unsignedParts[0]!, "base64url").toString("utf8")) as Ap2JwsHeader;
    const payload = JSON.parse(Buffer.from(unsignedParts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    checkoutJws = verifyCompactJws(
      closedCheckout.checkout_jwt,
      await input.resolveCheckoutJwtKey(header, payload),
    );
  } catch (error) {
    if (error instanceof Ap2MerchantVerificationError) throw error;
    reject("CHECKOUT_JWT_INVALID", error instanceof Error ? error.message : "checkout_jwt verification failed.");
  }
  const checkout = parseCheckout(checkoutJws.payload);
  const closedCheckoutHop = checkoutChain.hops.at(-1)!.token;
  const checkoutJwtHash = hashAp2Text(closedCheckout.checkout_jwt, closedCheckoutHop.sdAlg);
  if (closedCheckout.checkout_hash !== checkoutJwtHash) {
    reject("CHECKOUT_HASH_MISMATCH", "closed Checkout Mandate does not hash the merchant Checkout JWT.");
  }
  if (!checkout.merchant || !merchantMatches(checkout.merchant, expectedMerchant)) {
    reject("MERCHANT_MISMATCH", "merchant Checkout JWT does not identify the expected merchant.");
  }
  if (checkout.currency !== expectedCurrency) {
    reject("AMOUNT_MISMATCH", "merchant Checkout currency does not match the pending Stellar capture.");
  }

  for (const open of checkoutMandates.opens) evaluateCheckoutConstraints(open, checkout);

  return Object.freeze({
    checkoutChain,
    checkout: Object.freeze(checkout),
    closedCheckout: Object.freeze(closedCheckout),
    checkoutJwtHash,
    openCheckoutHash: checkoutChain.rootSdHash,
    closedCheckoutHash: checkoutChain.leafSdHash,
  });
}

export async function verifyAp2MerchantAuthorization(
  input: VerifyAp2MerchantAuthorizationInput,
): Promise<Readonly<VerifiedAp2MerchantAuthorization>> {
  text("expectedPaymentNonce", input.expectedPaymentNonce);
  const expectedMerchant = merchant("expectedMerchant", input.expectedMerchant);
  const expectedAmount = integer("expectedAmountMinor", input.expectedAmountMinor, 1);
  const exponent = input.currencyMinorUnitExponent ?? 2;
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 9) {
    reject("SCHEMA_INVALID", "currencyMinorUnitExponent must be an integer from 0 through 9.");
  }

  const checkoutAuthorization = await verifyAp2CheckoutAuthorization(input);
  let paymentChain: VerifiedDelegateSdJwtChain;
  try {
    paymentChain = await verifyDelegateSdJwtChain(input.paymentMandateChain, {
      resolveRootKey: input.resolvePaymentRootKey,
      expectedAudience: input.expectedAudience,
      expectedNonce: input.expectedPaymentNonce,
      currentTime: input.currentTime,
      clockSkewSeconds: input.clockSkewSeconds,
    });
  } catch (error) {
    reject("CHAIN_INVALID", error instanceof Error ? error.message : "AP2 mandate chain verification failed.");
  }
  const paymentMandates = splitChain(
    "Payment Mandate",
    paymentChain,
    "mandate.payment.open.1",
    AP2_CLOSED_PAYMENT_VCT,
  );
  const closedPayment = parseClosedPayment(paymentMandates.closed);
  if (closedPayment.transaction_id !== checkoutAuthorization.checkoutJwtHash) {
    reject("CHECKOUT_HASH_MISMATCH", "closed Payment Mandate is not bound to the merchant Checkout JWT.");
  }
  if (!merchantMatches(closedPayment.payee, expectedMerchant)) {
    reject("MERCHANT_MISMATCH", "closed Payment Mandate does not identify the expected payee.");
  }
  if (
    closedPayment.payment_amount.amount !== expectedAmount ||
    closedPayment.payment_amount.currency !== input.expectedCurrency
  ) {
    reject("AMOUNT_MISMATCH", "closed Payment Mandate amount does not match the pending Stellar capture.");
  }

  for (const open of paymentMandates.opens) {
    evaluatePaymentConstraints(
      open,
      closedPayment,
      checkoutAuthorization.openCheckoutHash,
      input.usage,
      exponent,
    );
  }

  return Object.freeze({
    ...checkoutAuthorization,
    paymentChain,
    closedPayment: Object.freeze(closedPayment),
    openPaymentHash: paymentChain.rootSdHash,
    closedPaymentHash: paymentChain.leafSdHash,
  });
}

export type Ap2ReceiptStatus = "Success" | "Error";

export interface Ap2ReceiptBase {
  status: Ap2ReceiptStatus;
  iss: string;
  iat: number;
  reference: string;
  error?: string;
  error_description?: string;
}

export interface SignAp2CheckoutReceiptInput extends Ap2ReceiptBase {
  order_id?: string;
}

export interface SignAp2PaymentReceiptInput extends Ap2ReceiptBase {
  payment_id: string;
  psp_confirmation_id?: string;
  network_confirmation_id?: string;
}

function validateReceiptBase(input: Ap2ReceiptBase): void {
  text("receipt.iss", input.iss);
  integer("receipt.iat", input.iat);
  text("receipt.reference", input.reference);
  if (input.status === "Success") {
    if (input.error !== undefined || input.error_description !== undefined) {
      reject("SCHEMA_INVALID", "successful receipt cannot include error fields.");
    }
  } else if (input.status === "Error") {
    text("receipt.error", input.error);
    text("receipt.error_description", input.error_description);
  } else {
    reject("SCHEMA_INVALID", "receipt.status must be Success or Error.");
  }
}

export function signAp2CheckoutReceipt(
  input: SignAp2CheckoutReceiptInput,
  signer: SignCompactJwsOptions,
): string {
  validateReceiptBase(input);
  if (input.status === "Success") text("receipt.order_id", input.order_id);
  if (input.status === "Error" && input.order_id !== undefined) {
    reject("SCHEMA_INVALID", "failed Checkout receipt cannot include order_id.");
  }
  return signCompactJws({ ...input }, signer);
}

export function signAp2PaymentReceipt(
  input: SignAp2PaymentReceiptInput,
  signer: SignCompactJwsOptions,
): string {
  validateReceiptBase(input);
  text("receipt.payment_id", input.payment_id);
  if (input.status === "Success") {
    text("receipt.psp_confirmation_id", input.psp_confirmation_id);
    text("receipt.network_confirmation_id", input.network_confirmation_id);
  } else if (
    input.psp_confirmation_id !== undefined ||
    input.network_confirmation_id !== undefined
  ) {
    reject("SCHEMA_INVALID", "failed Payment receipt cannot include confirmation IDs.");
  }
  return signCompactJws({ ...input }, signer);
}
