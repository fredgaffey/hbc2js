// The CLI's reported version (src/version.ts, used by --version and every
// hbc2js-machine/1 reply) must equal package.json's version. Regression:
// the 0.1.1 release candidate, packed and installed, still printed 0.1.0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { VERSION } from "../../../src/version.ts";

test("release (0.1.1 rc printed 0.1.0): src/version.ts VERSION equals package.json version", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
});
