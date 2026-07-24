/**
 * AP2 v0.1 credential compatibility.
 *
 * This preserves the exact fail-closed IntentMandate envelope admitted by the
 * 0.3.x package. It is intentionally isolated from the v0.2 Payment Mandate
 * schema so neither version can be interpreted as the other.
 */
import { Buffer } from "buffer";
import { hash } from "@stellar/stellar-sdk";
import { reapp, type IntentMandate } from "@reapp-sdk/core";

export const REAPP_AP2_V01_CREDENTIAL_VERSION = "reapp-ap2-credential/1" as const;
export const REAPP_AP2_V01_SIGNATURE_ALGORITHM = "stellar-ed25519-sha256" as const;
export const AP2_V01_SPEC_VERSION = "0.1.0" as const;
export const AP2_V01_INTENT_DATA_KEY = "ap2.mandates.IntentMandate" as const;
export const REAPP_AP2_V01_BINDING_VERSION = "reapp-ap2/1" as const;

const SIGNATURE_DOMAIN = "REAPP\0AP2\0SIGNED-MANDATE\0V1\0";
const LOWER_HEX_32 = /^[0-9a-f]{64}$/;
const CANONICAL_BASE64_64 = /^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/;

export interface NormalizedAp2V01IntentMandate {
  user_cart_confirmation_required: false;
  natural_language_description: string;
  merchants: [string];
  skus: [];
  requires_refundability: false;
  intent_expiry: string;
}

export interface ReappAp2V01CredentialPayload {
  ap2SpecVersion: typeof AP2_V01_SPEC_VERSION;
  ap2DataKey: typeof AP2_V01_INTENT_DATA_KEY;
  bindingVersion: typeof REAPP_AP2_V01_BINDING_VERSION;
  intent: NormalizedAp2V01IntentMandate;
  stellar: {
    user: string;
    agent: string;
    asset: string;
    maxAmount: string;
    decimals: number;
    nonce: string;
  };
}

export interface SignedAp2V01Mandate {
  credentialVersion: typeof REAPP_AP2_V01_CREDENTIAL_VERSION;
  payload: ReappAp2V01CredentialPayload;
  mandateHash: string;
  signature: {
    algorithm: typeof REAPP_AP2_V01_SIGNATURE_ALGORITHM;
    value: string;
  };
}

export interface Ap2V01MandateBinding {
  ap2SpecVersion: typeof AP2_V01_SPEC_VERSION;
  ap2DataKey: typeof AP2_V01_INTENT_DATA_KEY;
  bindingVersion: typeof REAPP_AP2_V01_BINDING_VERSION;
  normalizedIntent: NormalizedAp2V01IntentMandate;
  canonicalIntent: string;
  intentHash: string;
  bindingNonce: string;
  mandate: IntentMandate;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(label: string, value: unknown): UnknownRecord {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value;
}

function requireExactKeys(label: string, value: UnknownRecord, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
}

function requireText(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace.`);
  }
  return value;
}

function requireStringArray(label: string, value: unknown, length: number): string[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`${label} must contain exactly ${length} item${length === 1 ? "" : "s"}.`);
  }
  return value.map((item, index) => requireText(`${label}[${index}]`, item));
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  if (!isRecord(value)) throw new Error("canonical JSON values must be plain data");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

export function ap2V01CredentialSigningDigest(
  credentialVersion: string,
  payload: Pick<
    ReappAp2V01CredentialPayload,
    "ap2SpecVersion" | "ap2DataKey" | "bindingVersion"
  >,
  mandateHash: string,
): Buffer {
  if (!LOWER_HEX_32.test(mandateHash)) {
    throw new Error("mandateHash must be lowercase 32-byte hex.");
  }
  const payloadHash = hash(Buffer.from(canonicalize(payload), "utf8"));
  return hash(Buffer.concat([
    Buffer.from(SIGNATURE_DOMAIN, "utf8"),
    Buffer.from(credentialVersion, "utf8"),
    Buffer.from([0]),
    Buffer.from(payload.ap2SpecVersion, "utf8"),
    Buffer.from([0]),
    Buffer.from(payload.ap2DataKey, "utf8"),
    Buffer.from([0]),
    Buffer.from(payload.bindingVersion, "utf8"),
    Buffer.from([0]),
    payloadHash,
    Buffer.from([0]),
    Buffer.from(mandateHash, "hex"),
  ]));
}

export function parseSignedAp2V01Mandate(value: unknown): SignedAp2V01Mandate {
  const envelope = requireRecord("credential", value);
  requireExactKeys("credential", envelope, [
    "credentialVersion",
    "payload",
    "mandateHash",
    "signature",
  ]);
  const payloadValue = requireRecord("credential.payload", envelope.payload);
  requireExactKeys("credential.payload", payloadValue, [
    "ap2SpecVersion",
    "ap2DataKey",
    "bindingVersion",
    "intent",
    "stellar",
  ]);
  const intentValue = requireRecord("credential.payload.intent", payloadValue.intent);
  requireExactKeys("credential.payload.intent", intentValue, [
    "user_cart_confirmation_required",
    "natural_language_description",
    "merchants",
    "skus",
    "requires_refundability",
    "intent_expiry",
  ]);
  if (intentValue.user_cart_confirmation_required !== false) {
    throw new Error("credential intent must be human-not-present.");
  }
  if (intentValue.requires_refundability !== false) {
    throw new Error("credential intent cannot require unenforced refundability.");
  }
  const merchants = requireStringArray(
    "credential.payload.intent.merchants",
    intentValue.merchants,
    1,
  );
  const skus = requireStringArray("credential.payload.intent.skus", intentValue.skus, 0);

  const stellarValue = requireRecord("credential.payload.stellar", payloadValue.stellar);
  requireExactKeys("credential.payload.stellar", stellarValue, [
    "user",
    "agent",
    "asset",
    "maxAmount",
    "decimals",
    "nonce",
  ]);
  if (
    !Number.isInteger(stellarValue.decimals) ||
    (stellarValue.decimals as number) < 0 ||
    (stellarValue.decimals as number) > 38
  ) {
    throw new Error("credential.payload.stellar.decimals must be an integer from 0 through 38.");
  }
  const signatureValue = requireRecord("credential.signature", envelope.signature);
  requireExactKeys("credential.signature", signatureValue, ["algorithm", "value"]);
  const mandateHash = requireText("credential.mandateHash", envelope.mandateHash);
  if (!LOWER_HEX_32.test(mandateHash)) {
    throw new Error("credential.mandateHash must be lowercase 32-byte hex.");
  }

  return {
    credentialVersion: requireText(
      "credential.credentialVersion",
      envelope.credentialVersion,
    ) as typeof REAPP_AP2_V01_CREDENTIAL_VERSION,
    payload: {
      ap2SpecVersion: requireText(
        "credential.payload.ap2SpecVersion",
        payloadValue.ap2SpecVersion,
      ) as typeof AP2_V01_SPEC_VERSION,
      ap2DataKey: requireText(
        "credential.payload.ap2DataKey",
        payloadValue.ap2DataKey,
      ) as typeof AP2_V01_INTENT_DATA_KEY,
      bindingVersion: requireText(
        "credential.payload.bindingVersion",
        payloadValue.bindingVersion,
      ) as typeof REAPP_AP2_V01_BINDING_VERSION,
      intent: {
        user_cart_confirmation_required: false,
        natural_language_description: requireText(
          "credential.payload.intent.natural_language_description",
          intentValue.natural_language_description,
        ),
        merchants: [merchants[0]!],
        skus: skus as [],
        requires_refundability: false,
        intent_expiry: requireText(
          "credential.payload.intent.intent_expiry",
          intentValue.intent_expiry,
        ),
      },
      stellar: {
        user: requireText("credential.payload.stellar.user", stellarValue.user),
        agent: requireText("credential.payload.stellar.agent", stellarValue.agent),
        asset: requireText("credential.payload.stellar.asset", stellarValue.asset),
        maxAmount: requireText("credential.payload.stellar.maxAmount", stellarValue.maxAmount),
        decimals: stellarValue.decimals as number,
        nonce: requireText("credential.payload.stellar.nonce", stellarValue.nonce),
      },
    },
    mandateHash,
    signature: {
      algorithm: requireText(
        "credential.signature.algorithm",
        signatureValue.algorithm,
      ) as typeof REAPP_AP2_V01_SIGNATURE_ALGORITHM,
      value: requireText("credential.signature.value", signatureValue.value),
    },
  };
}

export function decodeCanonicalV01Signature(value: string): Buffer {
  if (!CANONICAL_BASE64_64.test(value)) {
    throw new Error("credential.signature.value must be canonical base64 for 64 bytes.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== value) {
    throw new Error("credential.signature.value must decode to exactly 64 bytes.");
  }
  return bytes;
}

export function rebuildV01CredentialBinding(
  payload: ReappAp2V01CredentialPayload,
): Ap2V01MandateBinding {
  const canonicalIntent = canonicalize(payload.intent);
  const intentHash = hash(Buffer.from(canonicalIntent, "utf8")).toString("hex");
  const expiryMs = Date.parse(payload.intent.intent_expiry);
  const canonicalExpiry = Number.isFinite(expiryMs)
    ? new Date(expiryMs).toISOString().replace(".000Z", "Z")
    : "";
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(payload.intent.intent_expiry) ||
    canonicalExpiry !== payload.intent.intent_expiry
  ) {
    throw new Error("credential expiry must be a real canonical UTC whole-second timestamp.");
  }
  const coreNonce = `${payload.bindingVersion}:${intentHash}:${payload.stellar.nonce}`;
  const mandate = reapp.createIntentMandate({
    user: payload.stellar.user,
    agent: payload.stellar.agent,
    merchant: payload.intent.merchants[0],
    asset: payload.stellar.asset,
    maxAmount: payload.stellar.maxAmount,
    expiry: expiryMs / 1_000,
    decimals: payload.stellar.decimals,
    nonce: coreNonce,
  });
  return {
    ap2SpecVersion: payload.ap2SpecVersion,
    ap2DataKey: payload.ap2DataKey,
    bindingVersion: payload.bindingVersion,
    normalizedIntent: payload.intent,
    canonicalIntent,
    intentHash,
    bindingNonce: payload.stellar.nonce,
    mandate,
  };
}
