/**
 * @reapp-sdk/ap2 — signed AP2 v0.2 REAPP profile validation and binding.
 *
 * The bridge accepts the narrow autonomous Open Payment Mandate subset that
 * MandateRegistry can faithfully enforce, then translates it into the existing
 * REAPP core mandate. The envelope is REAPP-specific; it is not a general
 * SD-JWT implementation. Contract enforcement remains authoritative.
 */
import { Buffer } from "buffer";
import { Address, Keypair, StrKey, hash } from "@stellar/stellar-sdk";
import { reapp, type IntentMandate } from "@reapp-sdk/core";
import { createSignedAp2Credential, type SignedAp2Mandate } from "./credential.js";

export {
  REAPP_AP2_CREDENTIAL_VERSION,
  REAPP_AP2_SIGNATURE_ALGORITHM,
  type ReappAp2CredentialPayload,
  type SignedAp2Mandate,
} from "./credential.js";
export * from "./replay-store.js";
export * from "./validator.js";
export * from "./sd-jwt.js";
export * from "./merchant.js";
export * from "./authorization.js";
export * from "./pool.js";
export * from "./legacy-v01.js";

export const AP2_SPEC_VERSION = "0.2.0" as const;
export const AP2_OPEN_PAYMENT_VCT = "mandate.payment.open.1" as const;
export const REAPP_AP2_BINDING_VERSION = "reapp-ap2/2" as const;

export interface Ap2Merchant {
  id: string;
  name: string;
  website?: string;
}

export interface Ap2AllowedPayeesConstraint {
  type: "payment.allowed_payees";
  allowed: readonly Ap2Merchant[];
}

export interface Ap2AmountRangeConstraint {
  type: "payment.amount_range";
  currency: string;
  max: number;
  min?: number;
}

export interface Ap2BudgetConstraint {
  type: "payment.budget";
  max: number;
  currency: string;
}

export interface Ap2AgentRecurrenceConstraint {
  type: "payment.agent_recurrence";
  frequency: "ON_DEMAND" | "DAILY" | "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUALLY";
  max_occurrences?: number;
}

export interface Ap2ExecutionDateConstraint {
  type: "payment.execution_date";
  not_before?: string;
  not_after?: string;
}

export interface Ap2PaymentReferenceConstraint {
  type: "payment.reference";
  conditional_transaction_id: string;
}

export type Ap2PaymentConstraint =
  | Ap2AllowedPayeesConstraint
  | Ap2AmountRangeConstraint
  | Ap2BudgetConstraint
  | Ap2AgentRecurrenceConstraint
  | Ap2ExecutionDateConstraint
  | Ap2PaymentReferenceConstraint
  | { type: string; readonly [key: string]: unknown };

export interface Ap2Ed25519Confirmation {
  jwk: {
    kty: "OKP";
    crv: "Ed25519";
    x: string;
  };
}

/** AP2 v0.2 Open Payment Mandate input shape used by the REAPP profile. */
export interface Ap2OpenPaymentMandate {
  vct: typeof AP2_OPEN_PAYMENT_VCT;
  constraints: readonly Ap2PaymentConstraint[];
  cnf: Ap2Ed25519Confirmation;
  exp: number;
}

/** Canonically ordered, exact AP2 v0.2 subset REAPP accepts. */
export interface NormalizedAp2OpenPaymentMandate {
  vct: typeof AP2_OPEN_PAYMENT_VCT;
  constraints: [
    Ap2AllowedPayeesConstraint & { allowed: [Ap2Merchant] },
    Ap2AmountRangeConstraint & { min?: never },
    Ap2AgentRecurrenceConstraint & { frequency: "ON_DEMAND"; max_occurrences?: never },
    Ap2BudgetConstraint,
    Ap2ExecutionDateConstraint & { not_before?: never; not_after: string },
    Ap2PaymentReferenceConstraint,
  ];
  cnf: Ap2Ed25519Confirmation;
  exp: number;
}

/** Stellar authorization details AP2 does not carry. */
export interface StellarMandateAuthorization {
  user: string;
  agent: string;
  asset: string;
  /** SEP-41 token decimals; defaults to Stellar's 7. */
  decimals?: number;
  /** ISO-4217 minor-unit exponent used by amount_range; defaults to 2. */
  currencyDecimals?: number;
  /** Optional reproducibility nonce; secure random bytes are used by default. */
  nonce?: string;
}

export interface BindPaymentMandateInput {
  paymentMandate: Ap2OpenPaymentMandate;
  stellar: StellarMandateAuthorization;
}

export interface Ap2MandateBinding {
  ap2SpecVersion: typeof AP2_SPEC_VERSION;
  ap2Vct: typeof AP2_OPEN_PAYMENT_VCT;
  bindingVersion: typeof REAPP_AP2_BINDING_VERSION;
  normalizedPaymentMandate: NormalizedAp2OpenPaymentMandate;
  canonicalPaymentMandate: string;
  /** SHA-256 of canonicalPaymentMandate, as lowercase hex. */
  paymentMandateHash: string;
  /** Random by default; supply one only for reproducible vectors. */
  bindingNonce: string;
  /** REAPP's contract-facing mandate; mandate.id is the on-chain vc_hash. */
  mandate: IntentMandate;
}

/** Deterministic JSON with recursively sorted object keys. */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("value is not representable as canonical JSON");
    return encoded;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON numbers must be finite");
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("value is not representable as canonical JSON");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
  }
  if (typeof value !== "object") throw new Error("value is not representable as canonical JSON");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("canonical JSON objects must be plain objects");
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(object[key]!)}`)
    .join(",")}}`;
}

function requireExactText(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace.`);
  }
  return value;
}

function requirePlainObject(label: string, value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(label: string, value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const object = requirePlainObject(label, value);
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported field ${JSON.stringify(unknown[0])}.`);
  }
  return object;
}

function requireStellarAddress(label: string, value: unknown): string {
  const address = requireExactText(label, value);
  try {
    Address.fromString(address);
  } catch {
    throw new Error(`${label} must be a valid Stellar address.`);
  }
  return address;
}

function requireEd25519Address(label: string, value: unknown): string {
  const address = requireExactText(label, value);
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new Error(`${label} must be a Stellar G-address.`);
  }
  return address;
}

function normalizeTimestamp(label: string, value: unknown): { iso: string; unixSeconds: number } {
  const timestamp = requireExactText(label, value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp)) {
    throw new Error(`${label} must be a canonical UTC whole-second ISO 8601 timestamp.`);
  }
  const milliseconds = Date.parse(timestamp);
  const canonical = Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString().replace(".000Z", "Z")
    : "";
  if (canonical !== timestamp) throw new Error(`${label} must be a real calendar timestamp.`);
  return { iso: timestamp, unixSeconds: milliseconds / 1000 };
}

function requireSafePositiveInteger(label: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value as number;
}

function requireCurrency(value: unknown): string {
  const currency = requireExactText("payment amount currency", value);
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("payment amount currency must be an uppercase ISO-4217 alpha-3 code.");
  }
  return currency;
}

function decimalNumberToMinor(label: string, value: unknown, decimals: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number.`);
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match || (match[2]?.length ?? 0) > decimals) {
    throw new Error(`${label} must resolve exactly to positive safe integer minor units.`);
  }
  const minor = BigInt(`${match[1]}${(match[2] ?? "").padEnd(decimals, "0")}`);
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} must resolve exactly to positive safe integer minor units.`);
  }
  return Number(minor);
}

function minorToDecimal(minor: number, decimals: number): string {
  const digits = String(minor).padStart(decimals + 1, "0");
  if (decimals === 0) return digits;
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

function expectedAgentJwk(agent: string): Ap2Ed25519Confirmation {
  const raw = StrKey.decodeEd25519PublicKey(agent);
  return {
    jwk: {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(raw).toString("base64url"),
    },
  };
}

function normalizeMerchant(value: unknown): Ap2Merchant {
  rejectUnknownKeys("payment.allowed_payees.allowed[0]", value, ["id", "name", "website"]);
  const input = value as Ap2Merchant;
  const merchant: Ap2Merchant = {
    id: requireStellarAddress("payment.allowed_payees.allowed[0].id", input.id),
    name: requireExactText("payment.allowed_payees.allowed[0].name", input.name),
  };
  if (input.website !== undefined) {
    const website = requireExactText("payment.allowed_payees.allowed[0].website", input.website);
    let parsed: URL;
    try {
      parsed = new URL(website);
    } catch {
      throw new Error("payment.allowed_payees.allowed[0].website must be a valid HTTPS URL.");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("payment.allowed_payees.allowed[0].website must be a valid HTTPS URL.");
    }
    merchant.website = website;
  }
  return merchant;
}

export function normalizeAp2PaymentMandate(
  paymentMandate: Ap2OpenPaymentMandate,
  stellar: StellarMandateAuthorization,
): {
  paymentMandate: NormalizedAp2OpenPaymentMandate;
  merchant: string;
  maxAmount: string;
  unixExpiry: number;
} {
  rejectUnknownKeys("paymentMandate", paymentMandate, ["vct", "constraints", "cnf", "exp"]);
  if (paymentMandate.vct !== AP2_OPEN_PAYMENT_VCT) {
    throw new Error(`paymentMandate.vct must be ${AP2_OPEN_PAYMENT_VCT}.`);
  }
  if (!Array.isArray(paymentMandate.constraints)) {
    throw new Error("paymentMandate.constraints must be an array.");
  }

  const byType = new Map<string, Ap2PaymentConstraint>();
  for (const [index, constraint] of paymentMandate.constraints.entries()) {
    const object = requirePlainObject(`paymentMandate.constraints[${index}]`, constraint);
    const type = requireExactText(`paymentMandate.constraints[${index}].type`, object.type);
    if (byType.has(type)) throw new Error(`paymentMandate contains duplicate constraint ${type}.`);
    byType.set(type, constraint);
  }
  const supported = [
    "payment.allowed_payees",
    "payment.amount_range",
    "payment.agent_recurrence",
    "payment.budget",
    "payment.execution_date",
    "payment.reference",
  ];
  for (const type of byType.keys()) {
    if (!supported.includes(type)) {
      throw new Error(`paymentMandate contains unsupported constraint ${type}.`);
    }
  }
  for (const type of supported) {
    if (!byType.has(type)) throw new Error(`paymentMandate requires constraint ${type}.`);
  }

  const payees = byType.get("payment.allowed_payees") as Ap2AllowedPayeesConstraint;
  rejectUnknownKeys("payment.allowed_payees", payees, ["type", "allowed"]);
  if (!Array.isArray(payees.allowed) || payees.allowed.length !== 1) {
    throw new Error("payment.allowed_payees.allowed must contain exactly one Stellar merchant.");
  }
  const merchant = normalizeMerchant(payees.allowed[0]);

  const amountRange = byType.get("payment.amount_range") as Ap2AmountRangeConstraint;
  rejectUnknownKeys("payment.amount_range", amountRange, ["type", "currency", "max", "min"]);
  const currency = requireCurrency(amountRange.currency);
  const maxMinor = requireSafePositiveInteger("payment.amount_range.max", amountRange.max);
  if (amountRange.min !== undefined) {
    throw new Error("payment.amount_range.min is unsupported because MandateRegistry has no minimum-payment policy.");
  }

  const recurrence = byType.get("payment.agent_recurrence") as Ap2AgentRecurrenceConstraint;
  rejectUnknownKeys("payment.agent_recurrence", recurrence, ["type", "frequency", "max_occurrences"]);
  if (recurrence.frequency !== "ON_DEMAND" || recurrence.max_occurrences !== undefined) {
    throw new Error("payment.agent_recurrence must be ON_DEMAND without max_occurrences.");
  }

  const currencyDecimals = stellar.currencyDecimals ?? 2;
  if (!Number.isInteger(currencyDecimals) || currencyDecimals < 0 || currencyDecimals > 9) {
    throw new Error("stellar.currencyDecimals must be an integer from 0 through 9.");
  }
  const budget = byType.get("payment.budget") as Ap2BudgetConstraint;
  rejectUnknownKeys("payment.budget", budget, ["type", "max", "currency"]);
  if (requireCurrency(budget.currency) !== currency) {
    throw new Error("payment.budget currency must match payment.amount_range currency.");
  }
  if (decimalNumberToMinor("payment.budget.max", budget.max, currencyDecimals) !== maxMinor) {
    throw new Error("payment.budget.max must equal payment.amount_range.max in currency minor units.");
  }

  const execution = byType.get("payment.execution_date") as Ap2ExecutionDateConstraint;
  rejectUnknownKeys("payment.execution_date", execution, ["type", "not_before", "not_after"]);
  if (execution.not_before !== undefined) {
    throw new Error("payment.execution_date.not_before is unsupported by MandateRegistry.");
  }
  const expiry = normalizeTimestamp("payment.execution_date.not_after", execution.not_after);
  if (expiry.unixSeconds !== paymentMandate.exp) {
    throw new Error("paymentMandate.exp must equal payment.execution_date.not_after.");
  }
  if (!Number.isSafeInteger(paymentMandate.exp) || paymentMandate.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("paymentMandate.exp must be a future safe whole Unix timestamp.");
  }

  const reference = byType.get("payment.reference") as Ap2PaymentReferenceConstraint;
  rejectUnknownKeys("payment.reference", reference, ["type", "conditional_transaction_id"]);
  const conditionalTransactionId = requireExactText(
    "payment.reference.conditional_transaction_id",
    reference.conditional_transaction_id,
  );

  rejectUnknownKeys("paymentMandate.cnf", paymentMandate.cnf, ["jwk"]);
  rejectUnknownKeys("paymentMandate.cnf.jwk", paymentMandate.cnf.jwk, ["kty", "crv", "x"]);
  const agent = requireEd25519Address("stellar.agent", stellar.agent);
  const cnf = expectedAgentJwk(agent);
  if (
    paymentMandate.cnf.jwk.kty !== cnf.jwk.kty ||
    paymentMandate.cnf.jwk.crv !== cnf.jwk.crv ||
    paymentMandate.cnf.jwk.x !== cnf.jwk.x
  ) {
    throw new Error("paymentMandate.cnf must contain the Ed25519 JWK for stellar.agent.");
  }

  return {
    paymentMandate: {
      vct: AP2_OPEN_PAYMENT_VCT,
      constraints: [
        { type: "payment.allowed_payees", allowed: [merchant] },
        { type: "payment.amount_range", currency, max: maxMinor },
        { type: "payment.agent_recurrence", frequency: "ON_DEMAND" },
        { type: "payment.budget", max: budget.max, currency },
        { type: "payment.execution_date", not_after: expiry.iso },
        { type: "payment.reference", conditional_transaction_id: conditionalTransactionId },
      ],
      cnf,
      exp: paymentMandate.exp,
    },
    merchant: merchant.id,
    maxAmount: minorToDecimal(maxMinor, currencyDecimals),
    unixExpiry: expiry.unixSeconds,
  };
}

function secureNonce(): string {
  type CryptoSource = { getRandomValues(bytes: Uint8Array): Uint8Array };
  const source = (globalThis as typeof globalThis & { crypto?: CryptoSource }).crypto;
  if (!source) throw new Error("Web Crypto is required to create a secure AP2 binding nonce.");
  const bytes = source.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bindPaymentMandate(input: BindPaymentMandateInput): Ap2MandateBinding {
  rejectUnknownKeys("input", input, ["paymentMandate", "stellar"]);
  rejectUnknownKeys("stellar", input.stellar, [
    "user",
    "agent",
    "asset",
    "decimals",
    "currencyDecimals",
    "nonce",
  ]);
  const user = requireEd25519Address("stellar.user", input.stellar.user);
  const agent = requireEd25519Address("stellar.agent", input.stellar.agent);
  const asset = requireExactText("stellar.asset", input.stellar.asset);
  if (!StrKey.isValidContract(asset)) throw new Error("stellar.asset must be a valid Stellar contract address.");
  const decimals = input.stellar.decimals ?? 7;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new Error("stellar.decimals must be an integer from 0 through 38.");
  }

  const normalized = normalizeAp2PaymentMandate(input.paymentMandate, input.stellar);
  const canonicalPaymentMandate = canonicalizeJson(normalized.paymentMandate);
  const paymentMandateHash = hash(Buffer.from(canonicalPaymentMandate, "utf8")).toString("hex");
  const bindingNonce = input.stellar.nonce === undefined
    ? secureNonce()
    : requireExactText("stellar.nonce", input.stellar.nonce);
  const coreNonce = `${REAPP_AP2_BINDING_VERSION}:${paymentMandateHash}:${bindingNonce}`;
  const mandate = reapp.createIntentMandate({
    user,
    agent,
    merchant: normalized.merchant,
    asset,
    maxAmount: normalized.maxAmount,
    expiry: normalized.unixExpiry,
    decimals,
    nonce: coreNonce,
  });

  return {
    ap2SpecVersion: AP2_SPEC_VERSION,
    ap2Vct: AP2_OPEN_PAYMENT_VCT,
    bindingVersion: REAPP_AP2_BINDING_VERSION,
    normalizedPaymentMandate: normalized.paymentMandate,
    canonicalPaymentMandate,
    paymentMandateHash,
    bindingNonce,
    mandate,
  };
}

/** Sign the supported AP2 v0.2 Open Payment Mandate with its Stellar user key. */
export function signAp2Mandate(
  input: BindPaymentMandateInput,
  signer: Keypair,
): Readonly<SignedAp2Mandate> {
  return createSignedAp2Credential(bindPaymentMandate(input), input, signer);
}
