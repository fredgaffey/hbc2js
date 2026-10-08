import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBundle } from "../../../src/tooling/check-bundle.ts";

function names(result: Awaited<ReturnType<typeof checkBundle>>): string[] {
  return result.freeGlobals.map((g) => g.name);
}

test("check-bundle AST boundary: a ternary's true-branch free read is no longer swallowed by the label-colon heuristic", async () => {
  const text = `
__d(function(global, require, importDefault, importAll, module, exports, dependencyMap) {
  var flag = true;
  module.exports = flag ? undeclaredGlobalTernary : 2;
}, 0, []);
`;
  const result = await checkBundle(text, { root: ".", fileExists: () => true });
  assert.ok(names(result).includes("undeclaredGlobalTernary"), `expected undeclaredGlobalTernary in freeGlobals, got ${JSON.stringify(names(result))}`);
});

test("check-bundle AST boundary: a destructuring default's own free variable is no longer treated as declared", async () => {
  const text = `
__d(function(global, require, importDefault, importAll, module, exports, dependencyMap) {
  var { a = undeclaredGlobalDestructure } = module;
  exports.a = a;
}, 1, []);
`;
  const result = await checkBundle(text, { root: ".", fileExists: () => true });
  assert.ok(names(result).includes("undeclaredGlobalDestructure"), `expected undeclaredGlobalDestructure in freeGlobals, got ${JSON.stringify(names(result))}`);
});

test("check-bundle AST boundary: a method-shorthand parameter default's own free variable is no longer treated as declared", async () => {
  const text = `
__d(function(global, require, importDefault, importAll, module, exports, dependencyMap) {
  var o = { foo(x = undeclaredGlobalMethodDefault) { return x; } };
  module.exports = o;
}, 2, []);
`;
  const result = await checkBundle(text, { root: ".", fileExists: () => true });
  assert.ok(
    names(result).includes("undeclaredGlobalMethodDefault"),
    `expected undeclaredGlobalMethodDefault in freeGlobals, got ${JSON.stringify(names(result))}`,
  );
});
