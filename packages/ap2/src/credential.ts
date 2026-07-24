import { Buffer } from "buffer";
import { Keypair, hash } from "@stellar/stellar-sdk";
import {
  AP2_OPEN_PAYMENT_VCT,
  AP2_SPEC_VERSION,
  REAPP_AP2_BINDING_VERSION,
  bindPaymentMandate,
  canonicalizeJson,
  type Ap2MandateBinding,
  type BindPaymentMandateInput,
  type NormalizedAp2OpenPaymentMandate,
} from "./index.js";

export const REAPP_AP2_CREDENTIAL_VERSION = "reapp-ap2-credential/2" as const;
export const REAPP_AP2_SIGNATURE_ALGORITHM = "stellar-ed25519-sha256" as const;

const SIGNATURE_DOMAIN = "REAPP\0AP2\0SIGNED-MANDATE\0V2\0";
const LOWER_HEX_32 = /^[0-9a-f]{64}$/;
const CANONICAL_BASE64_64 = /^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/;

export interface ReappAp2CredentialPayload {
  ap2SpecVersion: typeof AP2_SPEC_VERSION;
  ap2Vct: typeof AP2_OPEN_PAYMENT_VCT;
  bindingVersion: typeof REAPP_AP2_BINDING_VERSION;
  paymentMandate: NormalizedAp2OpenPaymentMandate;
  stellar: {
    user: string;
    agent: string;
    asset: string;
    decimals: number;
    currencyDecimals: number;
    nonce: string;
  };
}

export interface SignedAp2Mandate {
  credentialVersion: typeof REAPP_AP2_CREDENTIAL_VERSION;
  payload: ReappAp2CredentialPayload;
  mandateHash: string;
  signature: {
    algorithm: typeof REAPP_AP2_SIGNATURE_ALGORITHM;
    value: string;
  };
}

type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

function deepFreeze<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value) as Readonly<T>;
  }
  return value;
}

export function ap2CredentialSigningDigest(
  credentialVersion: string,
  payload: Pick<ReappAp2CredentialPayload, "ap2SpecVersion" | "ap2Vct" | "bindingVersion">,
  mandateHash: string,
): Buffer {
  if (!LOWER_HEX_32.test(mandateHash)) throw new Error("mandateHash must be lowercase 32-byte hex.");
  const payloadHash = hash(Buffer.from(canonicalizeJson(payload), "utf8"));
  return hash(Buffer.concat([
    Buffer.from(SIGNATURE_DOMAIN, "utf8"),
    Buffer.from(credentialVersion, "utf8"),
    Buffer.from([0]),
    Buffer.from(payload.ap2SpecVersion, "utf8"),
    Buffer.from([0]),
    Buffer.from(payload.ap2Vct, "utf8"),
    Buffer.from([0]),
    Buffer.from(payload.bindingVersion, "utf8"),
    Buffer.from([0]),
    payloadHash,
    Buffer.from([0]),
    Buffer.from(mandateHash, "hex"),
  ]));
}

export function createSignedAp2Credential(
  binding: Ap2MandateBinding,
  input: BindPaymentMandateInput,
  signer: Keypair,
): Readonly<SignedAp2Mandate> {
  if (signer.publicKey() !== binding.mandate.user) {
    throw new Error("the signing key must match stellar.user.");
  }
  const payload: ReappAp2CredentialPayload = {
    ap2SpecVersion: binding.ap2SpecVersion,
    ap2Vct: binding.ap2Vct,
    bindingVersion: binding.bindingVersion,
    paymentMandate: binding.normalizedPaymentMandate,
    stellar: {
      user: binding.mandate.user,
      agent: binding.mandate.agent,
      asset: binding.mandate.asset,
      decimals: binding.mandate.decimals,
      currencyDecimals: input.stellar.currencyDecimals ?? 2,
      nonce: binding.bindingNonce,
    },
  };
  const digest = ap2CredentialSigningDigest(REAPP_AP2_CREDENTIAL_VERSION, payload, binding.mandate.id);
  return deepFreeze({
    credentialVersion: REAPP_AP2_CREDENTIAL_VERSION,
    payload,
    mandateHash: binding.mandate.id,
    signature: {
      algorithm: REAPP_AP2_SIGNATURE_ALGORITHM,
      value: signer.sign(digest).toString("base64"),
    },
  });
}

export function parseSignedAp2Mandate(value: unknown): SignedAp2Mandate {
  const envelope = requireRecord("credential", value);
  requireExactKeys("credential", envelope, ["credentialVersion", "payload", "mandateHash", "signature"]);
  const payload = requireRecord("credential.payload", envelope.payload);
  requireExactKeys("credential.payload", payload, [
    "ap2SpecVersion",
    "ap2Vct",
    "bindingVersion",
    "paymentMandate",
    "stellar",
  ]);
  const stellar = requireRecord("credential.payload.stellar", payload.stellar);
  requireExactKeys("credential.payload.stellar", stellar, [
    "user",
    "agent",
    "asset",
    "decimals",
    "currencyDecimals",
    "nonce",
  ]);
  if (!Number.isInteger(stellar.decimals) || (stellar.decimals as number) < 0 || (stellar.decimals as number) > 38) {
    throw new Error("credential.payload.stellar.decimals must be an integer from 0 through 38.");
  }
  if (
    !Number.isInteger(stellar.currencyDecimals) ||
    (stellar.currencyDecimals as number) < 0 ||
    (stellar.currencyDecimals as number) > 9
  ) {
    throw new Error("credential.payload.stellar.currencyDecimals must be an integer from 0 through 9.");
  }
  const signature = requireRecord("credential.signature", envelope.signature);
  requireExactKeys("credential.signature", signature, ["algorithm", "value"]);
  const mandateHash = requireText("credential.mandateHash", envelope.mandateHash);
  if (!LOWER_HEX_32.test(mandateHash)) {
    throw new Error("credential.mandateHash must be lowercase 32-byte hex.");
  }

  return {
    credentialVersion: requireText("credential.credentialVersion", envelope.credentialVersion) as typeof REAPP_AP2_CREDENTIAL_VERSION,
    payload: {
      ap2SpecVersion: requireText("credential.payload.ap2SpecVersion", payload.ap2SpecVersion) as typeof AP2_SPEC_VERSION,
      ap2Vct: requireText("credential.payload.ap2Vct", payload.ap2Vct) as typeof AP2_OPEN_PAYMENT_VCT,
      bindingVersion: requireText("credential.payload.bindingVersion", payload.bindingVersion) as typeof REAPP_AP2_BINDING_VERSION,
      paymentMandate: payload.paymentMandate as NormalizedAp2OpenPaymentMandate,
      stellar: {
        user: requireText("credential.payload.stellar.user", stellar.user),
        agent: requireText("credential.payload.stellar.agent", stellar.agent),
        asset: requireText("credential.payload.stellar.asset", stellar.asset),
        decimals: stellar.decimals as number,
        currencyDecimals: stellar.currencyDecimals as number,
        nonce: requireText("credential.payload.stellar.nonce", stellar.nonce),
      },
    },
    mandateHash,
    signature: {
      algorithm: requireText("credential.signature.algorithm", signature.algorithm) as typeof REAPP_AP2_SIGNATURE_ALGORITHM,
      value: requireText("credential.signature.value", signature.value),
    },
  };
}

export function decodeCanonicalSignature(value: string): Buffer {
  if (!CANONICAL_BASE64_64.test(value)) {
    throw new Error("credential.signature.value must be canonical base64 for 64 bytes.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== value) {
    throw new Error("credential.signature.value must decode to exactly 64 bytes.");
  }
  return bytes;
}

export function rebuildCredentialBinding(payload: ReappAp2CredentialPayload): Ap2MandateBinding {
  return bindPaymentMandate({
    paymentMandate: payload.paymentMandate,
    stellar: {
      user: payload.stellar.user,
      agent: payload.stellar.agent,
      asset: payload.stellar.asset,
      decimals: payload.stellar.decimals,
      currencyDecimals: payload.stellar.currencyDecimals,
      nonce: payload.stellar.nonce,
    },
  });
}
