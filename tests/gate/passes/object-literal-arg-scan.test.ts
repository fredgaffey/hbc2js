// closure-inline-hang (branch passes-roundtrip-closure-temp after merging
// passes-roundtrip-objlit): the react-navigation-example `--split`, passes
// on, ran for hours instead of minutes. Root cause: object-literal-arg's
// `stableFunctionNames` walked the WHOLE function body once per top-level
// function declaration, and redid it on every list it matched. In a bundle's
// global function the declarations nest the whole bundle, so one match was
// quadratic in the bundle and the driver repeats the match per list per site.
// object-literal-arg part only (closure-inline-hang 1ccdbc6); counts node visits.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stmt } from "../../../src/passes/ast.ts";
import { stableFunctionNames } from "../../../src/passes/object-literal-arg/match.ts";

/** `F` declarations `function _fnI() { <probe> }` whose probe statement
 *  counts every read of its `k` tag (one per visit by any walker). */
function countingBody(F: number): { body: readonly Stmt[]; visits: () => number } {
  let n = 0;
  const body: Stmt[] = [];
  for (let i = 0; i < F; i++) {
    const probe = { text: `probe ${i}`, get k() { n++; return "comment"; } } as unknown as Stmt;
    body.push({ k: "func", name: `_fn${i}`, params: [], body: [probe] } as unknown as Stmt);
  }
  body.push({ k: "expr", expr: { k: "assign", target: { k: "ident", name: "_fn3" }, value: { k: "lit", text: "0" } } } as unknown as Stmt);
  return { body, visits: () => n };
}

test("closure-inline-hang: object-literal-arg's stable-function scan visits each nested body a constant number of times", () => {
  const F = 300;
  const { body, visits } = countingBody(F);
  const names = stableFunctionNames(body);
  assert.equal(names.size, F - 1, "every declaration but the reassigned _fn3 is stable");
  assert.ok(!names.has("_fn3"));
  // one walk visits each probe a small constant number of times; the old
  // per-declaration walk visited each probe F times (F*F = 90000 here)
  assert.ok(visits() <= 4 * F, `visits ${visits()} > ${4 * F}: the scan is per-declaration (quadratic)`);
});
test("closure-inline-hang: the stable-function scan is memoised per function body", () => {
  const { body, visits } = countingBody(50);
  stableFunctionNames(body);
  const first = visits();
  for (let i = 0; i < 20; i++) stableFunctionNames(body);
  assert.equal(visits(), first, "a second match on the same body must not re-walk it");
});
