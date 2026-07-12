import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CLI_VERSION } from "./version.js";

test("the executable version matches the npm package version", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };

  assert.equal(CLI_VERSION, packageJson.version);
});
