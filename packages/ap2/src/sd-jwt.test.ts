import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type JsonWebKey, type KeyObject } from "node:crypto";
import { test } from "node:test";
import {
  computeSdHash,
  parseSdJwt,
  signCompactJws,
  verifyDelegateSdJwtChain,
} from "./sd-jwt.js";

function p256(): { privateKey: KeyObject; publicJwk: JsonWebKey } {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey: pair.privateKey,
    publicJwk: pair.publicKey.export({ format: "jwk" }),
  };
}

function ed25519(): { privateKey: KeyObject; publicJwk: JsonWebKey } {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey,
    publicJwk: pair.publicKey.export({ format: "jwk" }),
  };
}

function sdJwt(
  payload: Readonly<Record<string, unknown>>,
  key: KeyObject,
  alg: "ES256" | "EdDSA" = "ES256",
  typ?: string,
  disclosures: readonly string[] = [],
): string {
  const jwt = signCompactJws(payload, { alg, key, ...(typ ? { typ } : {}) });
  return `${jwt}~${disclosures.length > 0 ? `${disclosures.join("~")}~` : ""}`;
}

function append(...segments: readonly string[]): string {
  return segments.map((segment, index) =>
    index < segments.length - 1 && segment.endsWith("~") ? segment.slice(0, -1) : segment
  ).join("~~");
}

test("verifies AP2 root -> intermediate -> terminal Delegate SD-JWT chains", async () => {
  const user = p256();
  const shoppingAgent = p256();
  const credentialProvider = p256();
  const now = 1_800_000_000;

  const root = sdJwt({
    delegate_payload: [{
      vct: "mandate.payment.open.1",
      constraints: [],
      cnf: { jwk: shoppingAgent.publicJwk },
      exp: now + 600,
    }],
    _sd_alg: "sha-256",
  }, user.privateKey);
  const middle = sdJwt({
    delegate_payload: [{
      vct: "mandate.payment.open.1",
      constraints: [],
      cnf: { jwk: credentialProvider.publicJwk },
    }],
    iat: now,
    aud: "credential-provider",
    nonce: "cp-nonce",
    sd_hash: computeSdHash(parseSdJwt(root)),
  }, shoppingAgent.privateKey, "ES256", "kb+sd-jwt+kb");
  const terminal = sdJwt({
    delegate_payload: [{
      vct: "mandate.payment.1",
      transaction_id: "checkout-hash",
    }],
    iat: now,
    aud: "merchant.example",
    nonce: "merchant-nonce",
    sd_hash: computeSdHash(parseSdJwt(middle)),
  }, credentialProvider.privateKey, "ES256", "kb+sd-jwt");

  const verified = await verifyDelegateSdJwtChain(append(root, middle, terminal), {
    resolveRootKey: () => user.publicJwk,
    expectedAudience: "merchant.example",
    expectedNonce: "merchant-nonce",
    currentTime: now,
  });

  assert.equal(verified.hops.length, 3);
  assert.equal(verified.payloads[0]!.vct, "mandate.payment.open.1");
  assert.equal(verified.payloads[2]!.vct, "mandate.payment.1");
  assert.equal(verified.rootSdHash, computeSdHash(parseSdJwt(root)));
  assert.equal(verified.leafSdHash, computeSdHash(parseSdJwt(terminal)));
});

test("resolves selectively disclosed delegate payloads and Ed25519 key binding", async () => {
  const user = ed25519();
  const agent = ed25519();
  const now = 1_800_000_000;
  const open = {
    vct: "mandate.checkout.open.1",
    constraints: [{ type: "checkout.line_items", items: [] }],
    cnf: { jwk: agent.publicJwk },
  };
  const disclosure = Buffer.from(JSON.stringify(["salt-1", open]), "utf8").toString("base64url");
  const digest = createHash("sha256").update(disclosure, "ascii").digest("base64url");
  const root = sdJwt({
    delegate_payload: [digest],
    _sd_alg: "sha-256",
  }, user.privateKey, "EdDSA", undefined, [disclosure]);
  const terminal = sdJwt({
    delegate_payload: [{
      vct: "mandate.checkout.1",
      checkout_jwt: "header.payload.signature",
      checkout_hash: "hash",
    }],
    iat: now,
    aud: "merchant",
    nonce: "nonce",
    issuer_jwt_hash: createHash("sha256")
      .update(parseSdJwt(root).issuerJwt, "ascii")
      .digest("base64url"),
  }, agent.privateKey, "EdDSA", "kb-sd-jwt");

  const verified = await verifyDelegateSdJwtChain(append(root, terminal), {
    resolveRootKey: () => user.publicJwk,
    expectedAudience: "merchant",
    expectedNonce: "nonce",
    currentTime: now,
  });
  assert.equal(verified.payloads[0]!.vct, "mandate.checkout.open.1");
  assert.equal(verified.payloads[1]!.vct, "mandate.checkout.1");
});

test("rejects a wrong terminal challenge and altered predecessor binding", async () => {
  const user = p256();
  const agent = p256();
  const now = 1_800_000_000;
  const root = sdJwt({
    delegate_payload: [{
      vct: "mandate.payment.open.1",
      constraints: [],
      cnf: { jwk: agent.publicJwk },
    }],
  }, user.privateKey);
  const terminal = sdJwt({
    delegate_payload: [{ vct: "mandate.payment.1" }],
    iat: now,
    aud: "merchant",
    nonce: "nonce",
    sd_hash: "not-the-root-hash",
  }, agent.privateKey, "ES256", "kb+sd-jwt");

  await assert.rejects(
    verifyDelegateSdJwtChain(append(root, terminal), {
      resolveRootKey: () => user.publicJwk,
      expectedAudience: "merchant",
      expectedNonce: "wrong",
      currentTime: now,
    }),
    /sd_hash does not match/,
  );
});

test("rejects unbound disclosures and unsupported algorithms", async () => {
  const user = p256();
  const unbound = Buffer.from(JSON.stringify(["salt", "unused", true]), "utf8").toString("base64url");
  const root = sdJwt({
    delegate_payload: [{
      vct: "mandate.payment.open.1",
      constraints: [],
      cnf: { jwk: user.publicJwk },
    }],
  }, user.privateKey, "ES256", undefined, [unbound]);

  await assert.rejects(
    verifyDelegateSdJwtChain(root, { resolveRootKey: () => user.publicJwk }),
    /unbound disclosure/,
  );
});
