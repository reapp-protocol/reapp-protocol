/**
 * @reapp-sdk/ap2 — signed AP2 v0.2 REAPP profile validation and binding.
 *
 * This package signs and validates the supported human-not-present AP2
 * IntentMandate profile, then translates it into the existing REAPP core
 * mandate. It does not claim universal AP2 VC/JWS support and has no dependency
 * on the x402 wire format. Contract enforcement remains authoritative for
 * every payment.
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

export const AP2_SPEC_VERSION = "0.2.0" as const;
export const AP2_INTENT_DATA_KEY = "ap2.mandates.IntentMandate" as const;
export const REAPP_AP2_BINDING_VERSION = "reapp-ap2/1" as const;

/** AP2 v0.2.0 sample IntentMandate data shape (wire names preserved). */
export interface Ap2IntentMandate {
  user_cart_confirmation_required: boolean;
  natural_language_description: string;
  merchants?: readonly string[];
  skus?: readonly string[];
  requires_refundability?: boolean;
  intent_expiry: string;
}

/** The exact, fail-closed AP2 subset that REAPP can enforce today. */
export interface NormalizedAp2IntentMandate {
  user_cart_confirmation_required: false;
  natural_language_description: string;
  merchants: [string];
  skus: [];
  requires_refundability: false;
  intent_expiry: string;
}

/** Stellar-specific authorization that AP2's commerce intent does not carry. */
export interface StellarMandateAuthorization {
  user: string;
  agent: string;
  asset: string;
  /** Human amount, such as "5.00". */
  maxAmount: string;
  /** Token decimals; defaults to Stellar's 7. */
  decimals?: number;
  /** Optional reproducibility nonce; secure random bytes are used by default. */
  nonce?: string;
}

export interface BindIntentMandateInput {
  intent: Ap2IntentMandate;
  stellar: StellarMandateAuthorization;
}

export interface Ap2MandateBinding {
  ap2SpecVersion: typeof AP2_SPEC_VERSION;
  ap2DataKey: typeof AP2_INTENT_DATA_KEY;
  bindingVersion: typeof REAPP_AP2_BINDING_VERSION;
  normalizedIntent: NormalizedAp2IntentMandate;
  canonicalIntent: string;
  /** SHA-256 of canonicalIntent, as lowercase hex. */
  intentHash: string;
  /** Random by default; supply one only for reproducible vectors. */
  bindingNonce: string;
  /** REAPP's contract-facing mandate; mandate.id is the on-chain vc_hash. */
  mandate: IntentMandate;
}

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

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
  if (typeof value !== "object") {
    throw new Error("value is not representable as canonical JSON");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("canonical JSON objects must be plain objects");
  }
  const object = value as { readonly [key: string]: unknown };
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

function rejectUnknownKeys(
  label: string,
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
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

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function normalizeExpiry(value: unknown): { iso: string; unixSeconds: number } {
  const expiry = requireExactText("intent.intent_expiry", value);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.000)?(Z|[+-](\d{2}):(\d{2}))$/.exec(expiry);
  if (!match) {
    throw new Error("intent.intent_expiry must be an ISO 8601 timestamp with a timezone and whole-second precision.");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new Error("intent.intent_expiry must be a real calendar timestamp.");
  }
  const milliseconds = Date.parse(expiry);
  if (!Number.isFinite(milliseconds) || milliseconds % 1000 !== 0) {
    throw new Error("intent.intent_expiry must be a valid whole-second ISO 8601 timestamp.");
  }
  const iso = new Date(milliseconds).toISOString().replace(".000Z", "Z");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(iso)) {
    throw new Error("intent.intent_expiry must normalize within the supported four-digit UTC year range.");
  }
  const unixSeconds = milliseconds / 1000;
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds <= Math.floor(Date.now() / 1000)) {
    throw new Error("intent.intent_expiry must resolve to a future Unix timestamp.");
  }
  return {
    iso,
    unixSeconds,
  };
}

/**
 * Normalize and validate the AP2 subset REAPP can enforce without inventing
 * application-only policy. Unsupported constraints fail closed.
 */
export function normalizeAp2Intent(intent: Ap2IntentMandate): {
  intent: NormalizedAp2IntentMandate;
  unixExpiry: number;
} {
  rejectUnknownKeys("intent", intent, [
    "user_cart_confirmation_required",
    "natural_language_description",
    "merchants",
    "skus",
    "requires_refundability",
    "intent_expiry",
  ]);
  if (intent.user_cart_confirmation_required !== false) {
    throw new Error(
      "REAPP's AP2 bridge requires user_cart_confirmation_required=false; cart-confirmation state is not enforced by MandateRegistry.",
    );
  }
  const description = requireExactText(
    "intent.natural_language_description",
    intent.natural_language_description,
  );
  if (!Array.isArray(intent.merchants) || intent.merchants.length !== 1) {
    throw new Error("intent.merchants must contain exactly one Stellar merchant address.");
  }
  const merchant = requireStellarAddress("intent.merchants[0]", intent.merchants[0]);
  if (intent.skus !== undefined && (!Array.isArray(intent.skus) || intent.skus.length > 0)) {
    throw new Error("intent.skus is not supported because MandateRegistry does not enforce SKU constraints.");
  }
  if (intent.requires_refundability === true) {
    throw new Error(
      "intent.requires_refundability=true is not supported because MandateRegistry does not enforce refundability.",
    );
  }
  if (
    intent.requires_refundability !== undefined &&
    typeof intent.requires_refundability !== "boolean"
  ) {
    throw new Error("intent.requires_refundability must be a boolean when present.");
  }
  const expiry = normalizeExpiry(intent.intent_expiry);
  return {
    intent: {
      user_cart_confirmation_required: false,
      natural_language_description: description,
      merchants: [merchant],
      skus: [],
      requires_refundability: false,
      intent_expiry: expiry.iso,
    },
    unixExpiry: expiry.unixSeconds,
  };
}

function secureNonce(): string {
  type CryptoSource = { getRandomValues(bytes: Uint8Array): Uint8Array };
  const source = (globalThis as typeof globalThis & { crypto?: CryptoSource }).crypto;
  if (!source) {
    throw new Error("Web Crypto is required to create a secure AP2 binding nonce.");
  }
  const bytes = source.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Bind a supported AP2 IntentMandate to REAPP's existing core mandate.
 *
 * The AP2 hash is embedded in core's existing nonce field. Core's canonical
 * field order is unchanged, so existing non-AP2 mandate ids remain stable.
 */
export function bindIntentMandate(input: BindIntentMandateInput): Ap2MandateBinding {
  rejectUnknownKeys("input", input, ["intent", "stellar"]);
  rejectUnknownKeys("stellar", input.stellar, [
    "user",
    "agent",
    "asset",
    "maxAmount",
    "decimals",
    "nonce",
  ]);
  const normalized = normalizeAp2Intent(input.intent);
  const canonicalIntent = canonicalizeJson(normalized.intent);
  const intentHash = hash(Buffer.from(canonicalIntent, "utf8")).toString("hex");

  const user = requireEd25519Address("stellar.user", input.stellar.user);
  const agent = requireEd25519Address("stellar.agent", input.stellar.agent);
  const asset = requireExactText("stellar.asset", input.stellar.asset);
  if (!StrKey.isValidContract(asset)) {
    throw new Error("stellar.asset must be a valid Stellar contract address.");
  }

  const bindingNonce = input.stellar.nonce === undefined
    ? secureNonce()
    : requireExactText("stellar.nonce", input.stellar.nonce);
  const decimals = input.stellar.decimals ?? 7;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new Error("stellar.decimals must be an integer from 0 through 38.");
  }
  const maxAmount = requireExactText("stellar.maxAmount", input.stellar.maxAmount);
  const coreNonce = `${REAPP_AP2_BINDING_VERSION}:${intentHash}:${bindingNonce}`;
  const mandate = reapp.createIntentMandate({
    user,
    agent,
    merchant: normalized.intent.merchants[0],
    asset,
    maxAmount,
    expiry: normalized.unixExpiry,
    decimals,
    nonce: coreNonce,
  });

  return {
    ap2SpecVersion: AP2_SPEC_VERSION,
    ap2DataKey: AP2_INTENT_DATA_KEY,
    bindingVersion: REAPP_AP2_BINDING_VERSION,
    normalizedIntent: normalized.intent,
    canonicalIntent,
    intentHash,
    bindingNonce,
    mandate,
  };
}

/** Sign a supported AP2 intent using the Stellar user key after fail-closed binding. */
export function signAp2Mandate(
  input: BindIntentMandateInput,
  signer: Keypair,
): Readonly<SignedAp2Mandate> {
  return createSignedAp2Credential(bindIntentMandate(input), input, signer);
}
