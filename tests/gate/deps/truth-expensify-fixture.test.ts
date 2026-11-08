// J3: the Expensify/App ground-truth fixture (second held-out app, owner
// ruling 2026-09-29). Schema + internal consistency only: no bundle, no
// network. The .hbc is not committed; truth pins it by sha256 and
// tests/fixtures/bundles/expensify-app-0.86.0/BUILD.md has the recipe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

type Truth = {
  hbcSha256s: Record<string, string>;
  moduleCount: number;
  packages: Record<string, string | null>;
  transitiveOf: Record<string, string[]>;
  modules: Record<string, { package: string | null; version?: string | null }>;
};
const truth: Truth = JSON.parse(readFileSync(join(repoRoot(), "tests", "fixtures", "bundles", "expensify-app-0.86.0", "deps-truth.json"), "utf8"));

test("J3 expensify truth: schema, sha pin and module count", () => {
  const shas = Object.values(truth.hbcSha256s);
  assert.ok(shas.length >= 1 && shas.every((s) => /^[0-9a-f]{64}$/.test(s)));
  assert.equal(Object.keys(truth.modules).length, truth.moduleCount);
  assert.ok(Object.keys(truth.packages).length >= 250);
  for (const v of Object.values(truth.packages)) assert.ok(v === null || typeof v === "string");
});

test("J3 expensify truth: modules, packages and transitiveOf agree", () => {
  const pkgs = new Set(Object.keys(truth.packages));
  const used = new Set<string>();
  for (const m of Object.values(truth.modules)) if (m.package !== null) used.add(m.package);
  for (const p of used) assert.ok(pkgs.has(p), `module package ${p} missing from packages`);
  for (const p of pkgs) assert.ok(used.has(p), `package ${p} has no module`);
  for (const [p, owners] of Object.entries(truth.transitiveOf)) {
    assert.ok(pkgs.has(p), `transitiveOf key ${p} not a package`);
    for (const o of owners) assert.ok(pkgs.has(o), `transitiveOf owner ${o} not a package`);
  }
  const direct = [...pkgs].filter((p) => !(p in truth.transitiveOf));
  assert.ok(direct.length >= 80 && direct.length < pkgs.size);
  assert.ok(pkgs.has("react-native") && pkgs.has("react-native-reanimated"));
});
