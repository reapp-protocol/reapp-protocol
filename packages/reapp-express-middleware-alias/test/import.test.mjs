import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryBoundRedemptionStore,
  createBoundReappPaidJsonRoute,
} from "../dist/index.js";

test("@reapp/express-middleware exposes the canonical typed implementation", () => {
  assert.equal(typeof createBoundReappPaidJsonRoute, "function");
  assert.equal(typeof InMemoryBoundRedemptionStore, "function");
});
