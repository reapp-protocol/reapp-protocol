import { Address, Keypair, StrKey } from "@stellar/stellar-sdk";
import { toStroops } from "@reapp-sdk/core";
import {
  REAPP_AP2_CREDENTIAL_VERSION,
  REAPP_AP2_SIGNATURE_ALGORITHM,
  ap2CredentialSigningDigest,
  decodeCanonicalSignature,
  parseSignedAp2Mandate,
  rebuildCredentialBinding,
  type SignedAp2Mandate,
} from "./credential.js";
import type { Ap2MandateBinding } from "./index.js";
import type { Ap2ReplayRecord, Ap2ReplayStore } from "./replay-store.js";

export type Ap2ValidationErrorCode =
  | "INVALID_CREDENTIAL"
  | "UNSUPPORTED_VERSION"
  | "INVALID_SIGNATURE"
  | "SIGNER_MISMATCH"
  | "BINDING_MISMATCH"
  | "MERCHANT_MISMATCH"
  | "INVALID_AMOUNT"
  | "AMOUNT_EXCEEDS_MANDATE"
  | "EXPIRED"
  | "REPLAYED"
  | "REPLAY_STORE_UNAVAILABLE";

export class Ap2ValidationError extends Error {
  readonly code: Ap2ValidationErrorCode;

  constructor(code: Ap2ValidationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "Ap2ValidationError";
    this.code = code;
  }
}

export interface CreateAp2ComplianceValidatorOptions {
  replayStore: Ap2ReplayStore;
  replayNamespace: string;
  now?: () => number;
}

export interface ValidateAp2MandateInput {
  credential: unknown;
  expectedUser: string;
  merchant: string;
  amount: string;
}

export interface ValidatedAp2Mandate {
  credential: Readonly<SignedAp2Mandate>;
  binding: Ap2MandateBinding;
  mandateHash: string;
  amountStroops: bigint;
  acceptedAt: number;
}

function invalidCredential(message: string, cause?: unknown): Ap2ValidationError {
  return new Ap2ValidationError("INVALID_CREDENTIAL", message, { cause });
}

function requireAddress(label: string, value: string): void {
  try {
    Address.fromString(value);
  } catch (cause) {
    throw invalidCredential(`${label} must be a valid Stellar address.`, cause);
  }
}

function captureNow(now: () => number): number {
  const value = now();
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw invalidCredential("validator clock must return safe whole Unix seconds.");
  }
  return value;
}

/**
 * Validate and consume a signed AP2 mandate at admission/registration time.
 * This is intentionally independent of HTTP/x402. Repeated payment enforcement
 * remains on-chain through MandateRegistry sequence and cumulative spent state.
 */
export function createAp2ComplianceValidator(
  options: CreateAp2ComplianceValidatorOptions,
): {
  validateAndConsume(input: ValidateAp2MandateInput): Promise<Readonly<ValidatedAp2Mandate>>;
} {
  if (!options.replayStore || typeof options.replayStore.consumeOnce !== "function") {
    throw new Error("replayStore with an atomic consumeOnce method is required.");
  }
  if (
    typeof options.replayNamespace !== "string" ||
    options.replayNamespace.length === 0 ||
    options.replayNamespace.trim() !== options.replayNamespace
  ) {
    throw new Error("replayNamespace must be a non-empty string without surrounding whitespace.");
  }
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  return Object.freeze({
    async validateAndConsume(
      input: ValidateAp2MandateInput,
    ): Promise<Readonly<ValidatedAp2Mandate>> {
      const acceptedAt = captureNow(now);
      let credential: SignedAp2Mandate;
      try {
        credential = parseSignedAp2Mandate(input.credential);
      } catch (cause) {
        throw invalidCredential("signed AP2 credential is structurally invalid.", cause);
      }

      if (
        credential.credentialVersion !== REAPP_AP2_CREDENTIAL_VERSION ||
        credential.payload.ap2SpecVersion !== "0.1.0" ||
        credential.payload.ap2DataKey !== "ap2.mandates.IntentMandate" ||
        credential.payload.bindingVersion !== "reapp-ap2/1" ||
        credential.signature.algorithm !== REAPP_AP2_SIGNATURE_ALGORITHM
      ) {
        throw new Ap2ValidationError(
          "UNSUPPORTED_VERSION",
          "credential, AP2, binding, data-key, or signature version is unsupported.",
        );
      }

      if (
        !StrKey.isValidEd25519PublicKey(credential.payload.stellar.user) ||
        !StrKey.isValidEd25519PublicKey(input.expectedUser)
      ) {
        throw invalidCredential("credential user and expectedUser must be Stellar G-addresses.");
      }
      if (credential.payload.stellar.user !== input.expectedUser) {
        throw new Ap2ValidationError(
          "SIGNER_MISMATCH",
          "credential signer does not match the trusted expected user.",
        );
      }
      if (!StrKey.isValidEd25519PublicKey(credential.payload.stellar.agent)) {
        throw invalidCredential("credential agent must be a Stellar G-address.");
      }
      requireAddress("credential merchant", credential.payload.intent.merchants[0]);
      if (!StrKey.isValidContract(credential.payload.stellar.asset)) {
        throw invalidCredential("credential asset must be a Stellar contract address.");
      }

      let binding: Ap2MandateBinding;
      try {
        binding = rebuildCredentialBinding(credential.payload);
      } catch (cause) {
        throw invalidCredential("credential cannot be rebound to a REAPP mandate.", cause);
      }
      if (binding.mandate.id !== credential.mandateHash) {
        throw new Ap2ValidationError(
          "BINDING_MISMATCH",
          "credential payload does not match its mandate hash.",
        );
      }

      let signature: Buffer;
      try {
        signature = decodeCanonicalSignature(credential.signature.value);
      } catch (cause) {
        throw new Ap2ValidationError(
          "INVALID_SIGNATURE",
          "credential signature encoding is invalid.",
          { cause },
        );
      }
      const digest = ap2CredentialSigningDigest(
        credential.credentialVersion,
        credential.payload,
        credential.mandateHash,
      );
      if (!Keypair.fromPublicKey(credential.payload.stellar.user).verify(digest, signature)) {
        throw new Ap2ValidationError("INVALID_SIGNATURE", "credential signature is invalid.");
      }

      if (input.merchant !== credential.payload.intent.merchants[0]) {
        throw new Ap2ValidationError(
          "MERCHANT_MISMATCH",
          "requested merchant is outside the signed mandate scope.",
        );
      }

      let amountStroops: bigint;
      try {
        amountStroops = toStroops(input.amount, credential.payload.stellar.decimals);
      } catch (cause) {
        throw new Ap2ValidationError("INVALID_AMOUNT", "requested amount is invalid.", { cause });
      }
      if (amountStroops <= 0n) {
        throw new Ap2ValidationError("INVALID_AMOUNT", "requested amount must be greater than zero.");
      }
      if (amountStroops > binding.mandate.maxAmount) {
        throw new Ap2ValidationError(
          "AMOUNT_EXCEEDS_MANDATE",
          "requested amount exceeds the signed mandate maximum.",
        );
      }

      if (binding.mandate.expiry <= acceptedAt) {
        throw new Ap2ValidationError("EXPIRED", "signed mandate is expired.");
      }

      const replayRecord: Readonly<Ap2ReplayRecord> = Object.freeze({
        key: `${options.replayNamespace}:${credential.mandateHash}`,
        namespace: options.replayNamespace,
        mandateHash: credential.mandateHash,
        user: credential.payload.stellar.user,
        acceptedAt,
      });
      let replayResult: unknown;
      try {
        replayResult = await options.replayStore.consumeOnce(replayRecord);
      } catch (cause) {
        throw new Ap2ValidationError(
          "REPLAY_STORE_UNAVAILABLE",
          "replay store failed closed.",
          { cause },
        );
      }
      if (replayResult === "duplicate") {
        throw new Ap2ValidationError("REPLAYED", "mandate hash was already admitted.");
      }
      if (replayResult !== "consumed") {
        throw new Ap2ValidationError(
          "REPLAY_STORE_UNAVAILABLE",
          "replay store returned an unsupported result.",
        );
      }

      return Object.freeze({
        credential: Object.freeze(credential),
        binding,
        mandateHash: credential.mandateHash,
        amountStroops,
        acceptedAt,
      });
    },
  });
}
