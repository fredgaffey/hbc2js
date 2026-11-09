// global-access local-store proof (docs/specs/passes/03-global-access.md
// section 4, condition 7): roundtrip review `diff:JmpTrue(label)` bucket,
// 2026-11-09 -- a guarded global read whose `globalThis` register had held an
// earlier, unrelated value in the same function stayed as
// `r = globalThis; if (!("Object" in r)) throw ...; x = r.Object`, because the
// whole-function proof wants the `globalThis` write to be the register's first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { classifySite } from "../../../src/passes/global-access/match.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";

const FIXTURE = "210-global-guard-reused-register";
const code = (v: number): string =>
  decompile(new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${v}.hbc`))), { moduleName: FIXTURE, resolveV98Ambiguity: true }).code;

test("roundtrip-guard: fixture 210 has no global guard left at any version", () => {
  for (const v of [84, 94, 96, 98, 99]) {
    const out = code(v);
    assert.ok(!out.includes("doesn't exist"), `v${v} still has a guard:\n${out}`);
  }
});

test("roundtrip-guard: fixture 210 (incl. absent global, shadowing local) is T2 PASS at every version", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, only: [FIXTURE], versions: [84, 94, 96, 98, 99] });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS).map((r) => `${r.fixture.name}: ${r.verdict}`);
  assert.deepEqual(bad, []);
  assert.ok(report.results.length >= 5, `only ${report.results.map((r) => r.fixture.name).join(",")} ran`);
});

// --- hand-built sites -----------------------------------------------------------
const exprStmt = (e: Expr): Stmt => ({ k: "expr", expr: e });
const set = (r: string, value: Expr): Stmt => exprStmt({ k: "assign", target: id(r), value });
const member = (obj: Expr, prop: string): Expr => ({ k: "member", obj, prop: lit(prop), computed: false });
const quoted = (s: string): Expr => lit(`"${s}"`);
const guardFor = (p: string, g: Expr): Stmt => ({
  k: "if",
  test: { k: "unary", op: "!", arg: { k: "bin", op: "in", left: quoted(p), right: g } },
  then: [{ k: "throw", arg: { k: "new", callee: id("ReferenceError"), args: [quoted(`Property '${p}' doesn't exist`)] } }],
  else: [],
});
const G = id("r2");
const verdict = (fnBody: readonly Stmt[], list: readonly Stmt[], i: number): string => {
  const r = classifySite(list, fnBody, i, "Object", G);
  return r.ok ? "ok" : r.reason;
};

test("roundtrip-guard: a globalThis store earlier in the same list proves the register at the guard", () => {
  // r2 = a; L: { r2 = globalThis; guard; r3 = r2.Object; }   -- r2's first write is not globalThis
  const inner: Stmt[] = [set("r2", id("globalThis")), guardFor("Object", G), set("r3", member(G, "Object"))];
  const fnBody: Stmt[] = [set("r2", id("a1")), { k: "labeled", label: "L0", body: inner } as Stmt];
  assert.equal(verdict(fnBody, inner, 1), "ok");
  // inside a loop whose body later clobbers r2: the store re-runs on every visit
  const loopBody: Stmt[] = [set("r2", id("globalThis")), guardFor("Object", G), set("r3", member(G, "Object")), set("r2", id("a1"))];
  const fnLoop: Stmt[] = [{ k: "while", label: null, test: id("a2"), body: loopBody }];
  assert.equal(verdict(fnLoop, loopBody, 1), "ok");
});

test("roundtrip-guard: the local proof refuses a write between the store and the guard, or in the read's statement", () => {
  const between: Stmt[] = [set("r2", id("globalThis")), { k: "if", test: id("a2"), then: [set("r2", id("a1"))], else: [] } as Stmt, guardFor("Object", G), set("r3", member(G, "Object"))];
  assert.notEqual(verdict([set("r2", id("a1")), { k: "labeled", label: "L0", body: between } as Stmt], between, 2), "ok");
  // r2 = globalThis; guard; r3 = (r2 = a1, r2.Object)
  const inRead: Stmt[] = [set("r2", id("globalThis")), guardFor("Object", G), set("r3", { k: "seq", exprs: [{ k: "assign", target: id("r2"), value: id("a1") }, member(G, "Object")] } as Expr)];
  assert.notEqual(verdict([set("r2", id("a1")), { k: "labeled", label: "L0", body: inRead } as Stmt], inRead, 1), "ok");
  // no store in the list at all: still the whole-function proof, which refuses
  const none: Stmt[] = [guardFor("Object", G), set("r3", member(G, "Object"))];
  assert.equal(verdict([set("r2", id("a1")), set("r2", id("globalThis")), { k: "labeled", label: "L0", body: none } as Stmt], none, 0), "unproven-global");
});
