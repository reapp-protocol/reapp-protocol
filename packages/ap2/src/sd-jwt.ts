/**
 * AP2 v0.2 Delegate SD-JWT verification.
 *
 * This module implements the compact `~~` chain used by the AP2 v0.2
 * reference SDK. Trust remains an application decision: callers resolve the
 * root JWS key from a trusted issuer, `kid`, or validated certificate chain.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign as createSignature,
  verify as verifySignature,
  type JsonWebKey,
} from "node:crypto";

export type Ap2JwsPublicKey = JsonWebKey | KeyObject | string | Buffer;
export type Ap2JwsPrivateKey = JsonWebKey | KeyObject | string | Buffer;

export interface Ap2JwsHeader {
  alg: string;
  kid?: string;
  typ?: string;
  x5c?: readonly string[];
  readonly [key: string]: unknown;
}

export interface ParsedSdJwt {
  issuerJwt: string;
  disclosures: readonly string[];
  canonical: string;
  sdJwt: string;
  header: Ap2JwsHeader;
  payload: Record<string, unknown>;
  sdAlg?: "sha-256" | "sha-384" | "sha-512";
}

export interface VerifiedCompactJws {
  serialized: string;
  header: Readonly<Ap2JwsHeader>;
  payload: Readonly<Record<string, unknown>>;
}

export interface SignCompactJwsOptions {
  alg: "ES256" | "EdDSA";
  key: Ap2JwsPrivateKey;
  kid?: string;
  typ?: string;
  additionalHeader?: Readonly<Record<string, unknown>>;
}

export interface VerifiedSdJwtHop {
  token: ParsedSdJwt;
  payload: Readonly<Record<string, unknown>>;
  effectivePayloads: readonly Readonly<Record<string, unknown>>[];
}

export interface VerifiedDelegateSdJwtChain {
  serialized: string;
  hops: readonly VerifiedSdJwtHop[];
  /** One effective mandate per hop for a normal AP2 chain. */
  payloads: readonly Readonly<Record<string, unknown>>[];
  rootSdHash: string;
  leafSdHash: string;
  rootIssuerJwtHash: string;
  leafIssuerJwtHash: string;
}

export type Ap2RootKeyResolver = (
  header: Readonly<Ap2JwsHeader>,
  payload: Readonly<Record<string, unknown>>,
) => Ap2JwsPublicKey | Promise<Ap2JwsPublicKey>;

export interface VerifyDelegateSdJwtChainOptions {
  resolveRootKey: Ap2RootKeyResolver;
  expectedAudience?: string;
  expectedNonce?: string;
  /** Defaults to 300 seconds, matching the AP2 v0.2 reference SDK. */
  clockSkewSeconds?: number;
  /** Defaults to the current Unix time. */
  currentTime?: number;
  /** Bounds untrusted input before JSON or signature work. Defaults to 8. */
  maxHops?: number;
  /** Bounds each compact chain segment. Defaults to 64 KiB. */
  maxSegmentBytes?: number;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const JWT_PARTS = 3;
const DEFAULT_MAX_HOPS = 8;
const DEFAULT_MAX_SEGMENT_BYTES = 64 * 1024;
const TERMINAL_TYPES = new Set(["kb+sd-jwt", "kb-sd-jwt"]);
const INTERMEDIATE_TYPES = new Set(["kb+sd-jwt+kb", "kb-sd-jwt+kb"]);
const HASH_NAMES = {
  "sha-256": "sha256",
  "sha-384": "sha384",
  "sha-512": "sha512",
} as const;

function fail(message: string): never {
  throw new Error(`AP2 SD-JWT: ${message}`);
}

function requirePlainObject(label: string, value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function decodeBase64Url(label: string, value: string): Buffer {
  if (value.length === 0 || !BASE64URL.test(value)) {
    fail(`${label} is not canonical unpadded base64url`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) {
    fail(`${label} is not canonical unpadded base64url`);
  }
  return bytes;
}

function decodeJsonObject(label: string, value: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeBase64Url(label, value).toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("AP2 SD-JWT:")) throw error;
    fail(`${label} is not valid UTF-8 JSON`);
  }
  return requirePlainObject(label, decoded);
}

function requireSdAlg(value: unknown): ParsedSdJwt["sdAlg"] {
  if (value === undefined) return undefined;
  if (value !== "sha-256" && value !== "sha-384" && value !== "sha-512") {
    fail(`unsupported _sd_alg ${JSON.stringify(value)}`);
  }
  return value;
}

function hashBase64Url(value: string, sdAlg?: ParsedSdJwt["sdAlg"]): string {
  return createHash(HASH_NAMES[sdAlg ?? "sha-256"]).update(value, "ascii").digest("base64url");
}

function canonicalChainSegment(segment: string, index: number, total: number): string {
  if (index === total - 1 || segment.endsWith("~")) return segment;
  if (!segment.includes("~")) return `${segment}~`;
  const last = segment.slice(segment.lastIndexOf("~") + 1);
  return last.split(".").length === JWT_PARTS ? segment : `${segment}~`;
}

export function parseSdJwt(value: string): ParsedSdJwt {
  if (typeof value !== "string" || value.length === 0) fail("token must be a non-empty string");
  if (value.startsWith("~")) fail("token has an empty issuer JWT");
  if (!value.includes("~")) fail("token is missing its SD-JWT disclosure separator");

  const parts = value.split("~");
  const issuerJwt = parts[0]!;
  let disclosures: string[];
  let canonical: string;
  if (value.endsWith("~")) {
    disclosures = parts.slice(1, -1);
    canonical = value;
  } else {
    // AP2 Delegate SD-JWT hops do not use a trailing, separate KB-JWT. Refuse
    // one here rather than accidentally treating its JWS as a disclosure.
    const trailing = parts.at(-1)!;
    if (trailing.split(".").length === JWT_PARTS) {
      fail("a trailing KB-JWT is not valid in an AP2 Delegate SD-JWT hop");
    }
    disclosures = parts.slice(1);
    canonical = `${value}~`;
  }
  if (disclosures.some((entry) => entry.length === 0)) {
    fail("token contains an empty disclosure segment");
  }

  const jwtParts = issuerJwt.split(".");
  if (jwtParts.length !== JWT_PARTS) fail("issuer JWT must contain three compact segments");
  const header = decodeJsonObject("JWT header", jwtParts[0]!) as unknown as Ap2JwsHeader;
  const payload = decodeJsonObject("JWT payload", jwtParts[1]!);
  if (typeof header.alg !== "string" || header.alg.length === 0 || header.alg === "none") {
    fail("JWT header alg must identify a signed algorithm");
  }

  return {
    issuerJwt,
    disclosures,
    canonical,
    sdJwt: disclosures.length > 0 ? `${issuerJwt}~${disclosures.join("~")}~` : `${issuerJwt}~`,
    header,
    payload,
    sdAlg: requireSdAlg(payload._sd_alg),
  };
}

function publicKey(value: Ap2JwsPublicKey): KeyObject {
  if (typeof value === "string" || Buffer.isBuffer(value)) return createPublicKey(value);
  if (value instanceof KeyObject) return value;
  return createPublicKey({ key: value, format: "jwk" });
}

function privateKey(value: Ap2JwsPrivateKey): KeyObject {
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    return createPrivateKey(value);
  }
  if (value instanceof KeyObject) {
    if (value.type !== "private") fail("JWS signing key must be private");
    return value;
  }
  const key = createPrivateKey({ key: value, format: "jwk" });
  if (key.type !== "private") fail("JWS signing key must be private");
  return key;
}

function verifyJwsSignature(
  serialized: string,
  header: Ap2JwsHeader,
  key: Ap2JwsPublicKey,
): void {
  const parts = serialized.split(".");
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");
  const signature = decodeBase64Url("JWT signature", parts[2]!);
  let verified = false;
  try {
    if (header.alg === "ES256") {
      if (signature.length !== 64) fail("ES256 signature must contain a 64-byte JWS R||S value");
      verified = verifySignature(
        "sha256",
        signingInput,
        { key: publicKey(key), dsaEncoding: "ieee-p1363" },
        signature,
      );
    } else if (header.alg === "EdDSA") {
      if (signature.length !== 64) fail("EdDSA signature must contain 64 bytes");
      verified = verifySignature(null, signingInput, publicKey(key), signature);
    } else {
      fail(`unsupported JWS alg ${JSON.stringify(header.alg)}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("AP2 SD-JWT:")) throw error;
    fail(`could not verify ${header.alg} signature`);
  }
  if (!verified) fail("JWS signature is invalid");
}

function verifyJws(token: ParsedSdJwt, key: Ap2JwsPublicKey): void {
  verifyJwsSignature(token.issuerJwt, token.header, key);
}

export function verifyCompactJws(serialized: string, key: Ap2JwsPublicKey): VerifiedCompactJws {
  if (typeof serialized !== "string" || serialized.length === 0) fail("JWS must be a non-empty string");
  const parts = serialized.split(".");
  if (parts.length !== JWT_PARTS) fail("JWS must contain three compact segments");
  const header = decodeJsonObject("JWS header", parts[0]!) as unknown as Ap2JwsHeader;
  const payload = decodeJsonObject("JWS payload", parts[1]!);
  if (typeof header.alg !== "string" || header.alg.length === 0 || header.alg === "none") {
    fail("JWS header alg must identify a signed algorithm");
  }
  verifyJwsSignature(serialized, header, key);
  return { serialized, header, payload };
}

export function signCompactJws(
  payload: Readonly<Record<string, unknown>>,
  options: SignCompactJwsOptions,
): string {
  requirePlainObject("JWS payload", payload);
  const additional = options.additionalHeader ?? {};
  requirePlainObject("JWS additional header", additional);
  if (
    Object.prototype.hasOwnProperty.call(additional, "alg") ||
    Object.prototype.hasOwnProperty.call(additional, "kid") ||
    Object.prototype.hasOwnProperty.call(additional, "typ")
  ) {
    fail("JWS additional header cannot replace alg, kid, or typ");
  }
  const header: Record<string, unknown> = { alg: options.alg, ...additional };
  if (options.kid !== undefined) header.kid = options.kid;
  if (options.typ !== undefined) header.typ = options.typ;
  const encodedHeader = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii");
  let signature: Buffer;
  try {
    signature = options.alg === "ES256"
      ? createSignature(
        "sha256",
        signingInput,
        { key: privateKey(options.key), dsaEncoding: "ieee-p1363" },
      )
      : createSignature(null, signingInput, privateKey(options.key));
  } catch {
    fail(`could not sign ${options.alg} JWS`);
  }
  return `${encodedHeader}.${encodedPayload}.${signature.toString("base64url")}`;
}

type Disclosure = {
  encoded: string;
  digest: string;
  decoded: readonly unknown[];
  used: boolean;
};

function decodeDisclosures(token: ParsedSdJwt): Map<string, Disclosure> {
  const byDigest = new Map<string, Disclosure>();
  for (const encoded of token.disclosures) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(decodeBase64Url("disclosure", encoded).toString("utf8"));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("AP2 SD-JWT:")) throw error;
      fail("disclosure is not valid UTF-8 JSON");
    }
    if (!Array.isArray(decoded) || (decoded.length !== 2 && decoded.length !== 3)) {
      fail("disclosure must be [salt, value] or [salt, name, value]");
    }
    if (typeof decoded[0] !== "string" || decoded[0].length === 0) {
      fail("disclosure salt must be a non-empty string");
    }
    if (decoded.length === 3 && (typeof decoded[1] !== "string" || decoded[1].length === 0)) {
      fail("object-property disclosure name must be a non-empty string");
    }
    const digest = hashBase64Url(encoded, token.sdAlg);
    if (byDigest.has(digest)) fail("duplicate disclosure digest");
    byDigest.set(digest, { encoded, digest, decoded, used: false });
  }
  return byDigest;
}

function resolveValue(value: unknown, disclosures: Map<string, Disclosure>): unknown {
  if (Array.isArray(value)) {
    const resolved: unknown[] = [];
    for (const entry of value) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        Object.keys(entry).length === 1 &&
        typeof (entry as Record<string, unknown>)["..."] === "string"
      ) {
        const digest = (entry as Record<string, string>)["..."]!;
        const disclosure = disclosures.get(digest);
        if (!disclosure) continue;
        if (disclosure.decoded.length !== 2) fail("array digest refers to a property disclosure");
        if (disclosure.used) fail("one disclosure is referenced more than once");
        disclosure.used = true;
        resolved.push(resolveValue(disclosure.decoded[1], disclosures));
        continue;
      }
      // The AP2 reference SDK also accepts a disclosure digest directly in
      // delegate_payload for compatibility with existing wallets.
      if (typeof entry === "string") {
        const disclosure = disclosures.get(entry);
        if (disclosure) {
          if (disclosure.used) fail("one disclosure is referenced more than once");
          disclosure.used = true;
          const disclosed = disclosure.decoded.length === 2
            ? disclosure.decoded[1]
            : disclosure.decoded[2];
          resolved.push(resolveValue(disclosed, disclosures));
          continue;
        }
      }
      resolved.push(resolveValue(entry, disclosures));
    }
    return resolved;
  }
  if (typeof value !== "object" || value === null) return value;
  const source = requirePlainObject("disclosed claim", value);
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === "_sd" || key === "_sd_alg") continue;
    output[key] = resolveValue(entry, disclosures);
  }
  if (source._sd !== undefined) {
    if (!Array.isArray(source._sd) || source._sd.some((entry) => typeof entry !== "string")) {
      fail("_sd must be an array of disclosure digests");
    }
    const seen = new Set<string>();
    for (const digest of source._sd as string[]) {
      if (seen.has(digest)) fail("_sd contains a duplicate digest");
      seen.add(digest);
      const disclosure = disclosures.get(digest);
      if (!disclosure) continue;
      if (disclosure.decoded.length !== 3) fail("object digest refers to an array disclosure");
      if (disclosure.used) fail("one disclosure is referenced more than once");
      disclosure.used = true;
      const name = disclosure.decoded[1] as string;
      if (Object.prototype.hasOwnProperty.call(output, name)) {
        fail(`disclosure would overwrite claim ${JSON.stringify(name)}`);
      }
      output[name] = resolveValue(disclosure.decoded[2], disclosures);
    }
  }
  return output;
}

function resolvePayload(token: ParsedSdJwt): Record<string, unknown> {
  const disclosures = decodeDisclosures(token);
  const resolved = requirePlainObject("resolved JWT payload", resolveValue(token.payload, disclosures));
  for (const disclosure of disclosures.values()) {
    if (!disclosure.used) fail("presentation contains an unbound disclosure");
  }
  return resolved;
}

function effectivePayloads(payload: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(payload.delegate_payload)) return [payload];
  const items: Record<string, unknown>[] = [];
  for (const item of payload.delegate_payload) {
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      items.push(requirePlainObject("delegate_payload item", item));
      continue;
    }
    if (typeof item === "string") {
      try {
        const decoded = JSON.parse(decodeBase64Url("delegate_payload disclosure", item).toString("utf8"));
        if (Array.isArray(decoded) && (decoded.length === 2 || decoded.length === 3)) {
          const candidate = decoded.length === 2 ? decoded[1] : decoded[2];
          if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
            items.push(requirePlainObject("delegate_payload disclosed item", candidate));
          }
        }
      } catch {
        // An undisclosed or decoy item has no effective mandate content.
      }
    }
  }
  return items.length > 0 ? items : [payload];
}

function checkTimes(payload: Record<string, unknown>, hop: number, now: number, skew: number): void {
  const exp = payload.exp;
  if (exp !== undefined) {
    if (!Number.isSafeInteger(exp)) fail(`hop ${hop} exp must be an integer Unix timestamp`);
    if (now > (exp as number) + skew) fail(`hop ${hop} expired at ${exp}`);
  }
  const iat = payload.iat;
  if (iat !== undefined) {
    if (!Number.isSafeInteger(iat)) fail(`hop ${hop} iat must be an integer Unix timestamp`);
    if ((iat as number) > now + skew) fail(`hop ${hop} iat is in the future`);
  }
}

function findConfirmationKey(
  payload: Record<string, unknown>,
  effective: readonly Record<string, unknown>[],
): JsonWebKey | undefined {
  for (const candidate of [...effective, payload]) {
    const cnf = candidate.cnf;
    if (typeof cnf !== "object" || cnf === null || Array.isArray(cnf)) continue;
    const jwk = (cnf as Record<string, unknown>).jwk;
    if (typeof jwk === "object" && jwk !== null && !Array.isArray(jwk)) {
      return jwk as JsonWebKey;
    }
  }
  return undefined;
}

function verifyBinding(payload: Record<string, unknown>, previous: ParsedSdJwt): void {
  const hasSdHash = Object.prototype.hasOwnProperty.call(payload, "sd_hash");
  const hasIssuerHash = Object.prototype.hasOwnProperty.call(payload, "issuer_jwt_hash");
  if (hasSdHash === hasIssuerHash) {
    fail("delegation hop must contain exactly one of sd_hash or issuer_jwt_hash");
  }
  if (hasSdHash) {
    const expected = computeSdHash(previous);
    if (payload.sd_hash !== expected) fail("delegation hop sd_hash does not match its predecessor");
  } else {
    const expected = computeIssuerJwtHash(previous);
    if (payload.issuer_jwt_hash !== expected) {
      fail("delegation hop issuer_jwt_hash does not match its predecessor");
    }
  }
}

export function computeSdHash(token: ParsedSdJwt): string {
  return hashBase64Url(token.sdJwt, token.sdAlg);
}

export function computeIssuerJwtHash(token: ParsedSdJwt): string {
  return hashBase64Url(token.issuerJwt, token.sdAlg);
}

export function hashAp2Text(value: string, sdAlg?: ParsedSdJwt["sdAlg"]): string {
  if (typeof value !== "string" || value.length === 0) fail("value to hash must be a non-empty string");
  return hashBase64Url(value, sdAlg);
}

export async function verifyDelegateSdJwtChain(
  serialized: string,
  options: VerifyDelegateSdJwtChainOptions,
): Promise<VerifiedDelegateSdJwtChain> {
  if (typeof serialized !== "string" || serialized.length === 0) fail("chain must be a non-empty string");
  if (!options || typeof options.resolveRootKey !== "function") {
    fail("resolveRootKey is required");
  }
  const rawSegments = serialized.split("~~");
  const maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
  if (!Number.isSafeInteger(maxHops) || maxHops < 1 || rawSegments.length > maxHops) {
    fail(`chain exceeds the ${maxHops}-hop limit`);
  }
  if (rawSegments.some((segment) => segment.length === 0)) fail("chain contains an empty hop");
  const maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
  if (!Number.isSafeInteger(maxSegmentBytes) || maxSegmentBytes < 1) {
    fail("maxSegmentBytes must be a positive safe integer");
  }
  for (const segment of rawSegments) {
    if (Buffer.byteLength(segment, "utf8") > maxSegmentBytes) {
      fail(`chain segment exceeds the ${maxSegmentBytes}-byte limit`);
    }
  }

  const now = options.currentTime ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 300;
  if (!Number.isSafeInteger(now) || now < 0) fail("currentTime must be a non-negative Unix timestamp");
  if (!Number.isSafeInteger(skew) || skew < 0) fail("clockSkewSeconds must be non-negative");

  const tokens = rawSegments.map((segment, index) =>
    parseSdJwt(canonicalChainSegment(segment, index, rawSegments.length)));
  const hops: VerifiedSdJwtHop[] = [];

  const root = tokens[0]!;
  verifyJws(root, await options.resolveRootKey(root.header, root.payload));
  const rootPayload = resolvePayload(root);
  const rootEffective = effectivePayloads(rootPayload);
  if (rootEffective.length !== 1) fail("root hop must disclose exactly one mandate");
  checkTimes(rootPayload, 0, now, skew);
  for (const payload of rootEffective) checkTimes(payload, 0, now, skew);
  hops.push({ token: root, payload: rootPayload, effectivePayloads: rootEffective });

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const previousHop = hops[index - 1]!;
    const confirmationKey = findConfirmationKey(previousHop.payload, previousHop.effectivePayloads);
    if (!confirmationKey) fail(`hop ${index - 1} does not disclose cnf.jwk for its delegate`);

    const isLast = index === tokens.length - 1;
    const typ = token.header.typ;
    const expectedTypes = isLast ? TERMINAL_TYPES : INTERMEDIATE_TYPES;
    if (typeof typ !== "string" || !expectedTypes.has(typ)) {
      fail(`hop ${index} has invalid typ ${JSON.stringify(typ)}`);
    }
    verifyJws(token, confirmationKey);
    const payload = resolvePayload(token);
    const effective = effectivePayloads(payload);
    if (effective.length !== 1) fail(`hop ${index} must disclose exactly one mandate`);
    verifyBinding(payload, previousHop.token);
    if (!Number.isSafeInteger(payload.iat)) fail(`hop ${index} is missing required iat`);
    checkTimes(payload, index, now, skew);
    for (const item of effective) checkTimes(item, index, now, skew);

    const nextKey = findConfirmationKey(payload, effective);
    if (isLast && nextKey) fail("terminal delegation hop must not carry cnf.jwk");
    if (!isLast && !nextKey) fail(`intermediate hop ${index} must carry cnf.jwk`);
    if (isLast && options.expectedAudience !== undefined && payload.aud !== options.expectedAudience) {
      fail(`terminal aud does not match ${JSON.stringify(options.expectedAudience)}`);
    }
    if (isLast && options.expectedNonce !== undefined && payload.nonce !== options.expectedNonce) {
      fail("terminal nonce does not match the verifier challenge");
    }
    hops.push({ token, payload, effectivePayloads: effective });
  }

  const leaf = tokens.at(-1)!;
  return {
    serialized,
    hops,
    payloads: hops.flatMap((hop) => hop.effectivePayloads),
    rootSdHash: computeSdHash(root),
    leafSdHash: computeSdHash(leaf),
    rootIssuerJwtHash: computeIssuerJwtHash(root),
    leafIssuerJwtHash: computeIssuerJwtHash(leaf),
  };
}
