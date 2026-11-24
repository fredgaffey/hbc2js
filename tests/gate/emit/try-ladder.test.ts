// fix-boot-oom (2026-11-25): a bare RN 0.88 app's hbc99 lowered generator
// (fn#37772) decompiled to 247 directly nested `__pc`-guarded `try`s, and the
// Hermes compiler's optimiser (default -O, as `equiv --boot` and a release
// build use it) needed more than 18 GB for it: the boot check's original side
// was OOM-killed. Fixture 500 is the small shape (20 regions, hbc99): the nest
// now prints as one `try` with an `else if` chain in the catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { decompile } from "../../../src/decompile.ts";
import { printProgram } from "../../../src/emit/print.ts";
import { guardedTry, LADDER_MIN } from "../../../src/emit/try-ladder.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";

const DIR = new URL("../../fixtures/constructs/500-try-ladder-deep/", import.meta.url);

function maxTryDepth(js: string): number {
  // The printer is deterministic: a try block opens on a `try {` line and
  // closes on the `} catch`/`} finally` line at the same indentation.
  const open: number[] = [];
  let max = 0;
  for (const line of js.split("\n")) {
    const indent = line.length - line.trimStart().length;
    const t = line.trimStart();
    if (t.startsWith("try {") || /[:)] try \{$/.test(t)) {
      open.push(indent);
      max = Math.max(max, open.length);
    } else if ((t.startsWith("} catch") || t.startsWith("} finally")) && open[open.length - 1] === indent) open.pop();
  }
  return max;
}

test("fix-boot-oom: fixture 500 (hbc99, 20 guarded regions) prints no try nest as deep as LADDER_MIN and still runs right", () => {
  const code = decompile(new Uint8Array(readFileSync(new URL("v99.hbc", DIR)))).code;
  assert.ok(maxTryDepth(code) < LADDER_MIN, `try nesting depth ${maxTryDepth(code)}`);
  assert.match(code, /\} else if \(__pc >= \d+ && __pc <= \d+\) \{/);
  const out: string[] = [];
  runInNewContext(code, { print: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  assert.equal(out.join("\n") + "\n", readFileSync(new URL("expected.txt", DIR), "utf8"));
});

const pcIn = (a: number): Expr => ({ k: "logical", op: "&&", left: { k: "bin", op: ">=", left: { k: "ident", name: "__pc" }, right: { k: "lit", text: String(a) } }, right: { k: "bin", op: "<=", left: { k: "ident", name: "__pc" }, right: { k: "lit", text: String(a) } } });
const tail = (p: string): Stmt[] => [{ k: "expr", expr: { k: "assign", target: { k: "ident", name: "__exc" }, value: { k: "ident", name: p } } }, { k: "break", label: "L0" }];
const nest = (n: number, rest: (i: number) => Stmt[] = (i) => tail(`_e${i}`)): Stmt => {
  let s: Stmt[] = [{ k: "expr", expr: { k: "call", callee: { k: "ident", name: "body" }, args: [] } }];
  for (let i = 0; i < n; i++) s = [guardedTry(s, `_e${i}`, pcIn(i), rest(i))];
  return s[0]!;
};

test("fix-boot-oom: a guarded nest LADDER_MIN deep flattens, innermost region first, one shared catch binding", () => {
  const js = printProgram([nest(LADDER_MIN)]);
  assert.equal(maxTryDepth(js), 1);
  assert.ok(js.indexOf("__pc >= 0 &&") < js.indexOf("__pc >= 1 &&"), "the innermost region is offered the exception first");
  assert.ok(!/_e[1-9]/.test(js), "every arm reads the one catch binding");
  assert.match(js, /\} else \{\n\s*throw _e0;/);
});

test("fix-boot-oom: a shallower nest, or one whose handler tail could throw, keeps its nested shape", () => {
  assert.equal(maxTryDepth(printProgram([nest(LADDER_MIN - 1)])), LADDER_MIN - 1);
  const throwing = (i: number): Stmt[] => [{ k: "expr", expr: { k: "call", callee: { k: "ident", name: "f" }, args: [{ k: "ident", name: `_e${i}` }] } }];
  assert.equal(maxTryDepth(printProgram([nest(LADDER_MIN + 4, throwing)])), LADDER_MIN + 4);
});
