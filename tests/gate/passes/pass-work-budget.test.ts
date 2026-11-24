// W_PASS_BUDGET (corpus a05): `applyAstPasses` rescans from the top after
// every accepted site, so a long straight-line body (a 7,070-getter icon
// registry, ~42k statements) was cubic and never finished. A deterministic
// per-function work budget now stops the passes for that function only,
// reverts the pass in flight, and marks the function for export.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stmt } from "../../../src/emit/ast.ts";
import { id } from "../../../src/emit/ast.ts";
import { printProgram } from "../../../src/emit/print.ts";
import { AST_PASS_WORK_DEFAULT, applyAstPasses } from "../../../src/passes/ast.ts";
import { passBudgetFunctionsIn } from "../../../src/export/index.ts";
import { PASS_BUDGET_MARKER } from "../../../src/passes/index.ts";
import type { Pass, PassContext } from "../../../src/passes/types.ts";

/** A pass that renames one `from;` statement to `to;` per site. */
function renamePass(name: string, from: string, to: string): Pass<readonly Stmt[]> {
  return {
    name,
    stage: "B",
    targets: [],
    catalogue: [],
    match: (list: readonly Stmt[]) => {
      const i = list.findIndex((s: Stmt) => s.k === "expr" && s.expr.k === "ident" && s.expr.name === from);
      return i < 0 ? null : { root: list, nodes: list, data: i, at: { functionIndex: 7, offset: i } };
    },
    rewrite: (m: { root: readonly Stmt[]; data: number }) => m.root.map((s, k) => (k === m.data ? ({ k: "expr", expr: id(to) } as Stmt) : s)),
    check: () => ({ ok: true }),
  } as unknown as Pass<readonly Stmt[]>;
}

const base = { analysis: null as unknown as PassContext["analysis"], functionIndex: 7, cfg: {} as PassContext["cfg"], hbcVersion: 98, layoutClass: "hbc94" as PassContext["layoutClass"], diagnostic: () => {} };
const body: Stmt[] = Array.from({ length: 200 }, () => ({ k: "expr", expr: id("a") }) as Stmt);
const passes = [renamePass("p1", "a", "b"), renamePass("p2", "b", "c")];

function withBudget<T>(v: string | undefined, f: () => T): T {
  const old = process.env.HBC2JS_AST_PASS_WORK;
  if (v === undefined) delete process.env.HBC2JS_AST_PASS_WORK;
  else process.env.HBC2JS_AST_PASS_WORK = v;
  try {
    return f();
  } finally {
    if (old === undefined) delete process.env.HBC2JS_AST_PASS_WORK;
    else process.env.HBC2JS_AST_PASS_WORK = old;
  }
}

test("pass work budget: an ordinary body is untouched by the default budget", () => {
  assert.ok(AST_PASS_WORK_DEFAULT >= 100_000_000);
  const r = withBudget(undefined, () => applyAstPasses(body, passes, base));
  assert.equal(r.applied.length, 400);
  assert.ok(!r.diagnostics.some((d) => d.code === "W_PASS_BUDGET"));
  assert.equal(printProgram(r.body), "c;\n".repeat(200));
});

test("pass work budget: past it, the pass in flight is reverted and later passes are skipped", () => {
  // p1 needs 201 rounds x 200 statements; 30,000 trips it mid-pass.
  const r = withBudget("30000", () => applyAstPasses(body, passes, base));
  assert.equal(r.applied.length, 0);
  assert.equal(r.body, body, "the function keeps its pre-pass body");
  const d = r.diagnostics.filter((x) => x.code === "W_PASS_BUDGET");
  assert.equal(d.length, 1);
  assert.match(d[0]!.message, /fn#7: AST passes stopped at "p1"/);
  // A budget that lets p1 finish stops p2 instead, keeping p1's work.
  const r2 = withBudget("60000", () => applyAstPasses(body, passes, base));
  assert.equal(r2.applied.length, 200);
  assert.equal(printProgram(r2.body), "b;\n".repeat(200));
  assert.match(r2.diagnostics.find((x) => x.code === "W_PASS_BUDGET")!.message, /stopped at "p2"/);
});

test("pass work budget: export finds the marker astPassHook writes", () => {
  const text = `function f() {\n  // ${PASS_BUDGET_MARKER} fn#538: AST passes stopped (work budget)\n}\n// ${PASS_BUDGET_MARKER} fn#538: again\n`;
  assert.deepEqual(passBudgetFunctionsIn(text), [538]);
  assert.deepEqual(passBudgetFunctionsIn("function g() {}\n"), []);
});
