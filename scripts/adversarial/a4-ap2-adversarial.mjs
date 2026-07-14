// Gate A4 — adversarial validation of the PUBLISHED @reapp-sdk/ap2 validator.
// Every mutation of a validly signed AP2 credential must fail closed.
import {
  InMemoryAp2ReplayStore,
  createAp2ComplianceValidator,
  signAp2Mandate,
} from "@reapp-sdk/ap2";
import { reapp } from "@reapp-sdk/core";
import { Keypair } from "@stellar/stellar-sdk";

const results = [];
let failures = 0;
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

const USER = Keypair.random();
const AGENT = Keypair.random();
const MERCHANT = Keypair.random().publicKey();
const OTHER_MERCHANT = Keypair.random().publicKey();

function freshCredential(overrides = {}) {
  return signAp2Mandate({
    intent: {
      user_cart_confirmation_required: false,
      natural_language_description: "Buy one research dataset",
      merchants: [MERCHANT],
      intent_expiry: new Date((Math.floor(Date.now() / 1000) + 3600) * 1000).toISOString(),
      ...overrides.intent,
    },
    stellar: {
      user: USER.publicKey(),
      agent: AGENT.publicKey(),
      asset: reapp.testnet.nativeSac,
      maxAmount: "5.00",
      ...overrides.stellar,
    },
  }, overrides.signer ?? USER);
}

function freshValidator() {
  return createAp2ComplianceValidator({
    replayStore: new InMemoryAp2ReplayStore(),
    replayNamespace: `stellar-testnet:${reapp.testnet.mandateRegistryId}`,
  });
}

const baseArgs = { expectedUser: USER.publicKey(), merchant: MERCHANT, amount: "1.00" };

// 1. valid credential admits
{
  const accepted = await freshValidator().validateAndConsume({ credential: freshCredential(), ...baseArgs });
  record("valid signed mandate admits and yields on-chain binding", !!accepted?.binding?.mandate?.id, `mandate=${accepted?.binding?.mandate?.id?.slice(0, 12)}…`);
}

async function mustReject(name, fn) {
  try {
    await fn();
    record(name, false, "validator unexpectedly admitted");
  } catch (err) {
    record(name, true, String(err?.message ?? err).slice(0, 110));
  }
}

// 2. altered signature byte — well-formed base64, one bit flipped
await mustReject("tampered signature (one flipped bit) fails closed", async () => {
  const cred = structuredClone(freshCredential());
  const sig = Buffer.from(cred.signature.value, "base64");
  sig[0] ^= 0x01;
  cred.signature = { ...cred.signature, value: sig.toString("base64") };
  await freshValidator().validateAndConsume({ credential: cred, ...baseArgs });
});

// 3. payload mutation after signing (amount escalation, signature untouched)
await mustReject("payload maxAmount escalated after signing fails closed", async () => {
  const cred = structuredClone(freshCredential());
  cred.payload.stellar.maxAmount = "500.00";
  await freshValidator().validateAndConsume({ credential: cred, ...baseArgs });
});

// 3b. mandateHash recomputed for the mutated payload, signature untouched
await mustReject("recomputed hash with mutated payload still fails signature check", async () => {
  const good = structuredClone(freshCredential());
  const evil = structuredClone(good);
  evil.payload.stellar.maxAmount = "500.00";
  // attacker also swaps in the hash of a DIFFERENT credential they observed
  evil.mandateHash = freshCredential().mandateHash;
  await freshValidator().validateAndConsume({ credential: evil, ...baseArgs });
});

// 4. wrong merchant at admission
await mustReject("merchant outside mandate scope fails closed", async () => {
  await freshValidator().validateAndConsume({ credential: freshCredential(), ...baseArgs, merchant: OTHER_MERCHANT });
});

// 5. amount above budget
await mustReject("admission amount above signed budget fails closed", async () => {
  await freshValidator().validateAndConsume({ credential: freshCredential(), ...baseArgs, amount: "6.00" });
});

// 6. expired intent
await mustReject("expired intent fails closed", async () => {
  const cred = freshCredential({ intent: { intent_expiry: new Date((Math.floor(Date.now() / 1000) - 60) * 1000).toISOString() } });
  await freshValidator().validateAndConsume({ credential: cred, ...baseArgs });
});

// 7. replayed mandate hash (same credential, same validator, twice)
await mustReject("replayed mandate hash fails closed on second admission", async () => {
  const validator = freshValidator();
  const cred = freshCredential();
  await validator.validateAndConsume({ credential: cred, ...baseArgs });
  await validator.validateAndConsume({ credential: cred, ...baseArgs });
});

// 8. wrong expected user (session identity mismatch)
await mustReject("credential signed by a different user than the session fails closed", async () => {
  await freshValidator().validateAndConsume({ credential: freshCredential(), ...baseArgs, expectedUser: Keypair.random().publicKey() });
});

// 9. signer is not the mandate user (forged issuer)
await mustReject("credential signed by non-user key fails closed", async () => {
  const cred = freshCredential({ signer: Keypair.random() });
  await freshValidator().validateAndConsume({ credential: cred, ...baseArgs });
});

// 10. replay store outage fails closed (no silent admit)
await mustReject("replay store outage fails closed", async () => {
  const validator = createAp2ComplianceValidator({
    replayStore: { async consumeOnce() { throw new Error("store down"); } },
    replayNamespace: "outage-test",
  });
  await validator.validateAndConsume({ credential: freshCredential(), ...baseArgs });
});

// 11. unsupported AP2 semantics fail closed (cart confirmation required)
await mustReject("unsupported cart-confirmation semantics fail closed", async () => {
  const cred = freshCredential({ intent: { user_cart_confirmation_required: true } });
  await freshValidator().validateAndConsume({ credential: cred, ...baseArgs });
});

// 12. multi-merchant intent fails closed (single-merchant profile)
await mustReject("multi-merchant intent fails closed", async () => {
  const cred = freshCredential({ intent: { merchants: [MERCHANT, OTHER_MERCHANT] } });
  await freshValidator().validateAndConsume({ credential: cred, ...baseArgs });
});

console.log(`\nA4 SUMMARY: ${results.filter(r => r.ok).length}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
