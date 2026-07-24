import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import {
  captureAuthorizationId,
  poolParticipationAuthorizationId,
  signAp2CaptureAuthorization,
  signAp2PoolParticipationAuthorization,
  stellarNetworkId,
  type Ap2CaptureAuthorization,
  type Ap2PoolParticipationAuthorization,
} from "./authorization.js";

const verifier = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const addresses = [
  "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR",
  "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U",
  "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG",
  "GDFJHLAXAUMHA4OWPOB4P7YO72AQR2HMIUYFOXLXE2DZGM633K7HZDQP",
] as const;

function capture(): Ap2CaptureAuthorization {
  return {
    version: 1,
    networkId: "09".repeat(32),
    registry: addresses[0],
    kind: "Simple",
    mandateId: "01".repeat(32),
    agent: addresses[1],
    merchant: addresses[2],
    asset: addresses[3],
    amount: 100n,
    expectedSeq: 0,
    openCheckoutEvidence: "02".repeat(32),
    closedCheckoutEvidence: "03".repeat(32),
    openPaymentEvidence: "04".repeat(32),
    closedPaymentEvidence: "05".repeat(32),
    nonce: "06".repeat(32),
    verifierKey: verifier.rawPublicKey().toString("hex"),
    notBefore: 1_799_999_999,
    expiresAt: 1_800_000_600,
  };
}

test("capture authorization ID matches the Soroban contract vector", () => {
  const authorization = capture();
  const id = captureAuthorizationId(authorization);
  assert.equal(id, "8993a72430d4f600f151b0fafd8ab24a15cf0664306512303df3b7d97d239663");

  const signed = signAp2CaptureAuthorization(authorization, verifier);
  assert.equal(signed.authorizationId, id);
  assert.equal(Buffer.from(signed.signature, "hex").length, 64);
  assert(verifier.verify(Buffer.from(id, "hex"), Buffer.from(signed.signature, "hex")));
});

test("authorization IDs are route-specific and network-bound", () => {
  const authorization = capture();
  assert.notEqual(
    captureAuthorizationId({ ...authorization, kind: "CompositeSolo" }),
    captureAuthorizationId(authorization),
  );
  assert.notEqual(
    captureAuthorizationId({ ...authorization, registry: addresses[1] }),
    captureAuthorizationId(authorization),
  );
  assert.notEqual(
    stellarNetworkId(Networks.TESTNET),
    stellarNetworkId(Networks.PUBLIC),
  );
});

test("pool participation authorizations have a separate domain and signature", () => {
  const authorization: Ap2PoolParticipationAuthorization = {
    version: 1,
    networkId: "09".repeat(32),
    registry: addresses[0],
    poolId: "10".repeat(32),
    mandateId: "11".repeat(32),
    agent: addresses[1],
    merchant: addresses[2],
    asset: addresses[3],
    maxAmount: 500n,
    scheduleHash: "12".repeat(32),
    openCheckoutEvidence: "13".repeat(32),
    closedCheckoutEvidence: "14".repeat(32),
    openParticipationEvidence: "15".repeat(32),
    closedParticipationEvidence: "16".repeat(32),
    nonce: "17".repeat(32),
    verifierKey: verifier.rawPublicKey().toString("hex"),
    notBefore: 1_799_999_999,
    expiresAt: 1_800_000_600,
  };
  const signed = signAp2PoolParticipationAuthorization(authorization, verifier);
  assert.equal(signed.authorizationId, poolParticipationAuthorizationId(authorization));
  assert.notEqual(signed.authorizationId, captureAuthorizationId(capture()));
  assert(verifier.verify(
    Buffer.from(signed.authorizationId, "hex"),
    Buffer.from(signed.signature, "hex"),
  ));
});
