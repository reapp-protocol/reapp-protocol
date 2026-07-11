/**
 * @reapp-sdk/ap2 — a narrow AP2 v0.2.0 IntentMandate bridge for REAPP.
 *
 * This package translates a supported human-not-present AP2 IntentMandate into
 * the existing REAPP core mandate. It does not implement AP2 credential
 * signing, checkout mandates, payment mandates, or the x402 wire format.
 * Contract enforcement remains authoritative for every payment.
 */
import { Buffer } from "buffer";
import { Address, StrKey, hash } from "@stellar/stellar-sdk";
import { reapp, type IntentMandate } from "@reapp-sdk/core";

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

function requireStellarAddress(label: string, value: unknown): string {
  const address = requireExactText(label, value);
  try {
    Address.fromString(address);
  } catch {
    throw new Error(`${label} must be a valid Stellar address.`);
  }
  return address;
}

function normalizeExpiry(value: unknown): { iso: string; unixSeconds: number } {
  const expiry = requireExactText("intent.intent_expiry", value);
  const wholeSecondIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!wholeSecondIso.test(expiry)) {
    throw new Error("intent.intent_expiry must be an ISO 8601 timestamp with a timezone and whole-second precision.");
  }
  const milliseconds = Date.parse(expiry);
  if (!Number.isFinite(milliseconds) || milliseconds % 1000 !== 0) {
    throw new Error("intent.intent_expiry must be a valid whole-second ISO 8601 timestamp.");
  }
  const unixSeconds = milliseconds / 1000;
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds <= Math.floor(Date.now() / 1000)) {
    throw new Error("intent.intent_expiry must resolve to a future Unix timestamp.");
  }
  return {
    iso: new Date(milliseconds).toISOString().replace(".000Z", "Z"),
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
  const normalized = normalizeAp2Intent(input.intent);
  const canonicalIntent = canonicalizeJson(normalized.intent);
  const intentHash = hash(Buffer.from(canonicalIntent, "utf8")).toString("hex");

  const user = requireStellarAddress("stellar.user", input.stellar.user);
  const agent = requireStellarAddress("stellar.agent", input.stellar.agent);
  const asset = requireExactText("stellar.asset", input.stellar.asset);
  if (!StrKey.isValidContract(asset)) {
    throw new Error("stellar.asset must be a valid Stellar contract address.");
  }

  const bindingNonce = input.stellar.nonce === undefined
    ? secureNonce()
    : requireExactText("stellar.nonce", input.stellar.nonce);
  const coreNonce = `${REAPP_AP2_BINDING_VERSION}:${intentHash}:${bindingNonce}`;
  const mandate = reapp.createIntentMandate({
    user,
    agent,
    merchant: normalized.intent.merchants[0],
    asset,
    maxAmount: input.stellar.maxAmount,
    expiry: normalized.unixExpiry,
    decimals: input.stellar.decimals,
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
