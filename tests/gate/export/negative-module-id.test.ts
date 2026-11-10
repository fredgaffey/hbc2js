// Spec 33 L5 (export-boot apps): Expensify's react-native-worklets runtime
// module is registered under Metro id -2 (`__d(function…,-2,[…])`). The
// split writes `__d(factory, -2, [...])`, and the export's rewrite matched
// only `\d+`, so the whole export failed: "module -2's split file has no
// trailing __d(factory, ...) call to rewrite".
import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteModuleFile } from "../../../src/export/rewrite.ts";

test("export-boot apps: a negative Metro module id (worklets -2) rewrites like any other", () => {
  const split = "// hbc2js --split -- Metro module -2 (source fn#1, x.hbc)\nfunction factory(global, require) { require('./module_-3.js'); }\n__d(factory, -2, [-3, 651]);\n";
  const r = rewriteModuleFile(split, -2, {
    path: "src/_unclassified/module_-2.js", registryPath: "src/_hbc/registry.js",
    pathOf: (id) => `src/_unclassified/module_${id}.js`, tier: "flat", bucket: "unclassified", factoryFunctionIndex: 1,
  });
  assert.match(r.text, /__hbc\.define\(factory, -2, \[-3,651\]\);/);
  assert.match(r.text, /__hbc\.r\(-3\)/);
  assert.equal(r.edgesRewritten, 1);
});
