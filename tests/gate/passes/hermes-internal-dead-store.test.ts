// hermes-internal-dead-store (docs/LOWERING-CATALOGUE.md R17): roundtrip
// review `diff:TryGetById(reg)` bucket, 2026-11-10 -- after `template-literal`
// folds `Reflect.apply(concat, "", [...])` into a template literal, the callee
// spill `concat = __hbc_HermesInternal.concat` (or the namespace pair
// `r = __hbc_HermesInternal; c = r.concat`) stayed behind as a dead store, and
// hermesc cannot drop a global read, so it recompiled to a live
// TryGetById + GetById pair ahead of the template's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { analyzeHermesInternal } from "../../../src/passes/hermes-internal-dead-store/analysis.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";

const FIXTURE = "290-template-concat-dead-spill";
const code = (v: number): string =>
  decompile(new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${v}.hbc`))), { moduleName: FIXTURE, resolveV98Ambiguity: true }).code;
const fnText = (out: string, name: string): string => {
  const i = out.indexOf(`function ${name}(`);
  const j = out.indexOf("\n    function ", i + 1);
  return out.slice(i, j < 0 ? undefined : j);
};

test("roundtrip-trygetreg: fixture 290 leaves no dead HermesInternal spill beside a folded template", () => {
  for (const v of [84, 94, 96, 98, 99]) {
    const out = code(v);
    for (const f of ["msg", "pick", "boom"]) {
      const body = fnText(out, f);
      assert.ok(body.includes("`"), `v${v} ${f}: template not folded:\n${body}`);
      assert.ok(!body.includes("__hbc_HermesInternal"), `v${v} ${f}: dead spill left:\n${body}`);
    }
    // negative twin: a user getter named `concat` read for effect survives
    assert.match(fnText(out, "touch"), /\.concat;/, `v${v} touch lost its getter read`);
  }
});

test("roundtrip-trygetreg: fixture 290 (incl. getter twin, throwing substitution) is T2 PASS at every version", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, only: [FIXTURE], versions: [84, 94, 96, 98, 99] });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS).map((r) => `${r.fixture.name}: ${r.verdict}`);
  assert.deepEqual(bad, []);
  assert.ok(report.results.length >= 5, `only ${report.results.map((r) => r.fixture.name).join(",")} ran`);
});

// --- hand-built sites -----------------------------------------------------------
const set = (r: string, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target: id(r), value } });
const member = (obj: Expr, prop: string): Expr => ({ k: "member", obj, prop: lit(prop), computed: false });
const HI = id("__hbc_HermesInternal");
const ret = (e: Expr): Stmt => ({ k: "return", arg: e });
const deleted = (body: readonly Stmt[]): number[] => {
  const a = analyzeHermesInternal(body);
  return body.map((s, i) => (a.deadStores.has(s) ? i : -1)).filter((i) => i >= 0);
};

test("roundtrip-trygetreg: dead direct and namespace spills are deleted, live ones are kept", () => {
  assert.deepEqual(deleted([set("r1", member(HI, "concat")), ret(id("a1"))]), [0]);
  assert.deepEqual(deleted([set("r1", HI), set("r2", member(id("r1"), "concat")), ret(id("a1"))]), [0, 1]);
  // still read: kept
  assert.deepEqual(deleted([set("r1", member(HI, "concat")), ret(id("r1"))]), []);
  assert.deepEqual(deleted([set("r1", HI), set("r2", member(id("r1"), "concat")), ret(id("r1"))]), [1]);
});

test("roundtrip-trygetreg: a `.concat` read off anything but the shim is never deleted", () => {
  // r1 is not proven to hold the shim (a write in between)
  assert.deepEqual(deleted([set("r1", HI), set("r1", id("a1")), set("r2", member(id("r1"), "concat")), ret(id("a2"))]), [0]);
  assert.deepEqual(deleted([set("r2", member(id("a1"), "concat")), ret(id("a2"))]), []);
  assert.deepEqual(deleted([set("r2", member(id("HermesInternal"), "concat")), ret(id("a2"))]), []);
  assert.deepEqual(deleted([set("r2", member(HI, "getEpilogues")), ret(id("a2"))]), [0]);
});

test("roundtrip-trygetreg: a return/throw ends the spill's life only in a function with no try", () => {
  const thenList: Stmt[] = [set("r1", member(HI, "concat")), ret(id("a1"))];
  const ifS = (then: Stmt[]): Stmt => ({ k: "if", test: id("a2"), then, else: [] }) as Stmt;
  const a1 = analyzeHermesInternal([ifS(thenList), set("r1", id("a3")), ret(id("r1"))]);
  assert.ok(a1.deadStores.has(thenList[0]!));
  // inside a try whose finally reads the register: kept
  const block: Stmt[] = [set("r1", member(HI, "concat")), ret(id("a1"))];
  const tryS = { k: "try", block, param: null, handler: [], finalizer: [{ k: "expr", expr: id("r1") }] } as unknown as Stmt;
  assert.equal(analyzeHermesInternal([tryS, set("r1", id("a3")), ret(id("r1"))]).deadStores.size, 0);
});
