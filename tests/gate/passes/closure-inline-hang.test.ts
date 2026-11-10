// closure-inline-hang (branch passes-roundtrip-closure-temp after merging
// passes-roundtrip-objlit): the react-navigation-example `--split`, passes
// on, ran for hours instead of minutes. Root cause: object-literal-arg's
// `stableFunctionNames` walked the WHOLE function body once per top-level
// function declaration, and redid it on every list it matched. In a bundle's
// global function the declarations nest the whole bundle, so one match was
// quadratic in the bundle and the driver repeats the match per list per site.
// The tests count node visits and driver iterations, never wall time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAstPasses } from "../../../src/passes/ast.ts";
import type { Stmt } from "../../../src/passes/ast.ts";
import type { CheckResult, Match, Pass, PassContext } from "../../../src/passes/types.ts";
import { stableFunctionNames } from "../../../src/passes/object-literal-arg/match.ts";
import { entryCreated } from "../../../src/passes/closure-inline/match.ts";
import type { FunctionCfg } from "../../../src/passes/tree.ts";

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

test("closure-inline-hang: closure-inline's prologue scan sorts a function's instructions once", () => {
  let sorts = 0;
  const insns = [{ offset: 0, name: "CreateClosure", operands: [] }, { offset: 4, name: "Ret", operands: [] }];
  const blocks = [{ get instructions() { sorts++; return insns; } }];
  const cfg = { blocks } as unknown as FunctionCfg;
  entryCreated(cfg);
  const first = sorts;
  for (let i = 0; i < 20; i++) entryCreated(cfg);
  assert.equal(sorts, first, "entryCreated must be memoised per FunctionCfg");
});

test("closure-inline-hang: a rung that never reaches a fixed point is stopped by the driver's per-pass site cap", () => {
  let matches = 0;
  const pingPong: Pass<readonly Stmt[], null> = {
    name: "synthetic-ping-pong",
    stage: "B",
    targets: [],
    catalogue: ["R1"],
    match(list): Match<readonly Stmt[], null> | null {
      matches++;
      return { root: list, nodes: [list], data: null, at: { functionIndex: 0, offset: 0 } };
    },
    rewrite(m): readonly Stmt[] {
      // always a fresh list: the driver never sees the same site twice
      return m.nodes[0]!.map((s) => (s.k === "comment" ? { ...s, text: s.text === "a" ? "b" : "a" } : s));
    },
    check(): CheckResult {
      return { ok: true };
    },
  };
  const base: Omit<PassContext, "applied" | "structured" | "parentOf" | "fnBody"> = {
    analysis: null as unknown as PassContext["analysis"],
    functionIndex: 0,
    cfg: null as unknown as PassContext["cfg"],
    hbcVersion: 94,
    layoutClass: "hbc94" as PassContext["layoutClass"],
    diagnostic: () => {},
  };
  const r = applyAstPasses([{ k: "comment", text: "a" } as Stmt], [pingPong as unknown as Pass<readonly Stmt[]>], base);
  assert.ok(matches <= 10_001, `driver ran ${matches} matches`);
  assert.equal(r.applied.length, 10_000);
});
