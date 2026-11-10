// passes-roundtrip-getbyidreg (roundtrip `diff:GetById(reg)` bucket): the
// expression-only check flagged a loop-carried register (read at the top of
// a loop body, redefined at its bottom) as "read before its first def in the
// rewrite" even though it was exactly as read-before-def in `before`; the
// refusal dropped every fold in that body. Fixed on main by the carried
// live-in rule (rt-fcall4, spec 02 s6); these tests pin the loop-body case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import { expressionOnlyCheck } from "../../../src/passes/ast.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { bin, id } from "../../../src/emit/ast.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";

const FIXTURE = "340-loop-carried-fold-check";
const code = (v: number): string =>
  decompile(new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${v}.hbc`))), { moduleName: FIXTURE, resolveV98Ambiguity: true }).code;

test("roundtrip-getbyidreg: fixture 340's loop-body `s[i]()` folds back into a direct call at every version", () => {
  for (const v of [84, 94, 96, 98, 99]) {
    const out = code(v);
    assert.ok(!out.includes("Reflect.apply"), `v${v} still has Reflect.apply:\n${out}`);
  }
});

test("roundtrip-getbyidreg: fixture 340 (incl. getter-ordered twin) is T2 PASS at every version", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, only: [FIXTURE], versions: [84, 94, 96, 98, 99] });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS).map((r) => `${r.fixture.name}: ${r.verdict}`);
  assert.deepEqual(bad, []);
  assert.ok(report.results.length >= 5, `only ${report.results.map((r) => r.fixture.name).join(",")} ran`);
});

// --- hand-built lists --------------------------------------------------------------
const set = (r: string, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target: id(r), value } });
const call = (callee: Expr, ...args: Expr[]): Expr => ({ k: "call", callee, args });
const idx = (o: string, k: string): Expr => ({ k: "member", obj: id(o), prop: id(k), computed: true });
const add1 = (r: string): Expr => bin("+", id(r), { k: "lit", text: "1" });

test("roundtrip-getbyidreg: a fold that keeps a loop-carried read before its def passes the check", () => {
  // body: r2 = r4[r3]; r5 = g(r2); r3 = r3 + 1  ->  r5 = g(r4[r3]); r3 = r3 + 1
  const tail = set("r3", add1("r3"));
  const before = [set("r2", idx("r4", "r3")), set("r5", call(id("g"), id("r2"))), tail];
  const after = [set("r5", call(id("g"), idx("r4", "r3"))), tail];
  assert.deepEqual(expressionOnlyCheck(before, after), { ok: true });
  // the strict form (derived-constructor frames) still refuses it
  assert.equal(expressionOnlyCheck(before, after, { carryLiveIn: false }).ok, false);
});

test("roundtrip-getbyidreg: deleting a def so more reads precede the first def still fails (negative twin)", () => {
  // r3 = 0; f(r3); r3 = r3 + 1  ->  f(r3); r3 = r3 + 1 : r3 was read-before-def-free, now is not
  const tail = set("r3", add1("r3"));
  const use: Stmt = { k: "expr", expr: call(id("f"), id("r3")) };
  const before = [set("r3", { k: "lit", text: "0" }), use, tail];
  assert.equal(expressionOnlyCheck(before, [use, tail]).ok, false);
  // already violating, but the deletion adds a read before the (new) first def
  const top: Stmt = { k: "expr", expr: call(id("g"), id("r3")) };
  const before2 = [top, set("r3", { k: "lit", text: "0" }), use, tail];
  assert.equal(expressionOnlyCheck(before2, [top, use, tail]).ok, false);
});
