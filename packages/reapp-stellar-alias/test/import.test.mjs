import assert from "node:assert/strict";
import test from "node:test";
import { TESTNET, registryClient, token } from "../dist/index.js";

test("@reapp/stellar exposes the canonical typed implementation", () => {
  assert.match(TESTNET.mandateRegistryId, /^C[A-Z2-7]{55}$/);
  assert.equal(typeof registryClient, "function");
  assert.equal(typeof token.balance, "function");
});
