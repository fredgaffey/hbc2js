// Inline function expressions (spec 27 §12) indent their body one level below
// the line that opens them and align the closing brace with that line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import { printProgram } from "../../../src/emit/print.ts";
import { repoRoot } from "../../support/paths.ts";

const indentOf = (l: string): number => l.length - l.trimStart().length;

/** For every line ending in `function ..(..) {` that opens an expression
 *  (not a declaration), check body indent = opener + 2 and closer aligns. */
function check(code: string): number {
  const lines = code.split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!/function\*? ?\w*\([^)]*\) \{$/.test(l) || /^\s*(async )?function/.test(l)) continue;
    seen++;
    const open = indentOf(l);
    let j = i + 1;
    while (lines[j]!.trim() === "") j++;
    assert.equal(indentOf(lines[j]!), open + 2, `body of line ${i + 1}: ${l}`);
    let k = j;
    while (!(indentOf(lines[k]!) === open && /^\s*\}/.test(lines[k]!))) k++;
    assert.ok(k > j, `closer found for line ${i + 1}`);
  }
  return seen;
}

for (const version of ["v84", "v96", "v99"]) {
  test(`indent-func-expr: 200-closure-in-loop-identity ${version} body indented, closer aligned`, () => {
    const f = join(repoRoot(), "tests", "fixtures", "constructs", "200-closure-in-loop-identity", `${version}.hbc`);
    const code = decompile(new Uint8Array(readFileSync(f)), { resolveV98Ambiguity: true, passes: {} }).code;
    assert.ok(check(code) >= 1, "fixture has an inline function expression");
  });
}

test("indent-func-expr: nested function expressions inside a loop", () => {
  const inner = { k: "func", name: "_fn2", params: [], body: [{ k: "return", arg: { k: "num", value: 1 } }] };
  const outer = { k: "func", name: "_fn1", params: [], body: [{ k: "return", arg: { k: "array", elements: [inner] } }] };
  const loop = { k: "while", label: null, body: [{ k: "expr", expr: { k: "call", callee: { k: "ident", name: "push" }, args: [outer] } }] };
  const code = printProgram([loop] as never);
  assert.equal(check(code), 2, code);
});
