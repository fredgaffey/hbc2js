// Regression tests for the first finding of the export boot proof (spec 33
// L1): the exported `index.js` required the entry module's FILE only. A file
// require only registers the module (`__hbc.define`, spec 29 §4.4), so no
// factory ran at all, and the original's run-before-main module (RN's
// InitializeCore, `__r(48); __r(0)` on rn-template-0.72) was dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildIndexJs } from "../../../src/export/boilerplate.ts";
import { wrapReadableModule } from "../../../src/export/rewrite.ts";
import { repoRoot } from "../../support/paths.ts";
import { cleanup, exportTo } from "../export/support.ts";

const RN_HBC = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

test("export-boot L1: index.js registers and runs the run-before-main modules, then the entry", () => {
  const js = buildIndexJs(0, "src/App.js", [{ id: 48, path: "src/_vendor/react-native/module_48.js" }]);
  const at = (s: string): number => js.indexOf(s);
  assert.ok(at(`require("./src/_vendor/react-native/module_48.js")`) >= 0, js);
  assert.ok(at(`__hbc.r(48)`) >= 0, `run-before-main module never runs:\n${js}`);
  assert.ok(at(`__hbc.r(0)`) >= 0, `entry factory never runs:\n${js}`);
  assert.ok(at(`require("./src/App.js")`) < at(`__hbc.r(48)`), "every file registers before any factory runs");
  assert.ok(at(`__hbc.r(48)`) < at(`__hbc.r(0)`), "run-before-main runs before the entry");
});

test("export-boot L1: rn-template export's index.js runs InitializeCore (48) before the entry (0)", () => {
  const { out, run } = exportTo(RN_HBC, ["--instrument=modules", "--substitute", "none"]);
  try {
    assert.equal(run.status, 0, run.stderr);
    const js = readFileSync(join(out, "index.js"), "utf8");
    const r48 = js.indexOf("__hbc.r(48);"), r0 = js.indexOf("__hbc.r(0);");
    assert.ok(r48 >= 0 && r0 > r48, js);
  } finally {
    cleanup(out);
  }
});

test("export-boot L1: a readable module registers its factory, not a runtime helper hoisted above it", () => {
  const code = [
    "function __hbc_pnames(o) {",
    "  return [];",
    "}",
    "function _fn798(a1, a2, a3, a4, a5, a6, a7) {",
    "  a2(a7[0]);",
    "}",
    "",
  ].join("\n");
  const opts = { path: "src/m59.js", registryPath: "src/_hbc/registry.js", pathOf: (id: number) => `src/m${id}.js`, tier: "passes", bucket: "vendor", factoryFunctionIndex: 798 };
  assert.match(wrapReadableModule(code, 59, [13], opts).text, /__hbc\.define\(_fn798, 59, \[13\]\);/);
  // No `_fn<idx>` declaration (e.g. a renamed factory): still never a helper.
  const renamed = code.replace(/_fn798/g, "factory");
  assert.match(wrapReadableModule(renamed, 59, [13], { ...opts, factoryFunctionIndex: 1 }).text, /__hbc\.define\(factory, 59/);
});
