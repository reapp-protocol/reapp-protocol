import assert from "node:assert/strict";
import test from "node:test";

import { networks } from "./client.js";
import { TESTNET } from "./config.js";
import { DEPLOYMENTS } from "./deployments.js";

const PERMANENT_TESTNET_REGISTRY =
  "CCHQ5G4Y4YBMY6D3TYYJSVJVCKUM22Q6TMKCCHVAHY4X7K6QELQACZRM";

test("all published testnet defaults use the permanent upgradable contract", () => {
  assert.equal(DEPLOYMENTS.testnet.mandateRegistryId, PERMANENT_TESTNET_REGISTRY);
  assert.equal(TESTNET.mandateRegistryId, PERMANENT_TESTNET_REGISTRY);
  assert.equal(networks.testnet.contractId, PERMANENT_TESTNET_REGISTRY);
});
