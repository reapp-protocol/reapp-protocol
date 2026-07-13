import assert from "node:assert/strict";
import test from "node:test";
import { AP2_SPEC_VERSION, createAp2ComplianceValidator } from "../dist/index.js";

test("@reapp/ap2 exposes the canonical typed implementation", () => {
  assert.equal(AP2_SPEC_VERSION, "0.2.0");
  assert.equal(typeof createAp2ComplianceValidator, "function");
});
