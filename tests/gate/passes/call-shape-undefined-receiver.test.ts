// Round-trip review "passes-roundtrip-this" (E2E tier 1,
// react-navigation-example-0.85.3 v98, passes-on): a leftover
// `Reflect.apply(F, rN, [...])` whose `this` register is written the literal
// `undefined` more than once (hermesc loads `undefined` once per path that
// reaches a call). R3a/R3f's proof accepted exactly one write, so every such
// call stayed a real `Reflect.apply` (GetGlobalObject + TryGetById "Reflect" +
// an args array when recompiled).
//
// Docs: docs/specs/passes/04-call-shape.md section 4, R3g.
//
// Fixture 190: three plain-call functions with two or three `undefined`
// writes to the receiver register; `mixed` (negative twin) keeps its method
// call's receiver.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoRoot } from "../../support/paths.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import type { HbcVersion } from "../../support/hermesc.ts";
import { findHermesVm } from "../../support/hermesvm.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { classifyNode, isProvenUndefinedThis } from "../../../src/passes/call-shape/match.ts";

const call = (callee: Expr, args: readonly Expr[]): Expr => ({ k: "call", callee, args });
const member = (obj: Expr, prop: string): Expr => ({ k: "member", obj, prop: lit(prop), computed: false });
const reflectApply = (F: Expr, T: Expr, args: readonly Expr[]): Expr & { k: "call" } => call(member(id("Reflect"), "apply"), [F, T, { k: "array", elements: args }]) as Expr & { k: "call" };
const asg = (t: string, v: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target: id(t), value: v } });
const U = lit("undefined");

test("R3g: a receiver register written `undefined` on two paths is proven", () => {
  const body: Stmt[] = [{ k: "if", test: id("c"), then: [asg("r1", U)], else: [asg("r1", U)] }];
  assert.equal(isProvenUndefinedThis(id("r1"), body), true);
  const r = classifyNode(reflectApply(id("f"), id("r1"), [id("x")]), body);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.rule, "R3a");
});

test("R3g: `let r1 = undefined` plus a later `undefined` store is proven, for R3f too", () => {
  const body: Stmt[] = [{ k: "init", kind: "let", name: "r1", value: U }, asg("r1", U)];
  const r = classifyNode(reflectApply(member(id("ns"), "fn"), id("r1"), []), body);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.rule, "R3f");
});

test("R3g negative: one non-undefined write among several refuses", () => {
  const body: Stmt[] = [asg("r1", U), { k: "if", test: id("c"), then: [asg("r1", id("o"))], else: [] }, asg("r1", U)];
  assert.equal(isProvenUndefinedThis(id("r1"), body), false);
  assert.deepEqual(classifyNode(reflectApply(id("f"), id("r1"), []), body), { ok: false, reason: "unproven-this" });
});

test("R3g negative: a non-undefined write nested inside an expression refuses", () => {
  const body: Stmt[] = [asg("r1", U), { k: "expr", expr: call(id("g"), [{ k: "assign", target: id("r1"), value: id("o") }]) }, asg("r1", U)];
  assert.equal(isProvenUndefinedThis(id("r1"), body), false);
});

test("R3g negative: the register as a for-in target, a catch param or a pattern target refuses", () => {
  const forIn: Stmt[] = [asg("r1", U), { k: "for-in", label: null, decl: null, left: id("r1"), right: id("o"), body: [] }];
  const caught: Stmt[] = [asg("r1", U), { k: "try", block: [], param: "r1", handler: [] }];
  const pattern: Stmt[] = [asg("r1", U), { k: "expr", expr: { k: "destructure", pattern: { k: "parr", elements: [{ k: "pel", target: { k: "pid", name: "r1" } }] }, source: id("o") } }];
  for (const body of [forIn, caught, pattern]) assert.equal(isProvenUndefinedThis(id("r1"), body), false, JSON.stringify(body));
});

test("R3g negative: a register never written is not proven (it may not even be declared)", () => {
  assert.equal(isProvenUndefinedThis(id("r1"), [asg("r2", U)]), false);
});

const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "190-undefined-receiver-rewritten");

function decompiled(bytes: Uint8Array): string {
  try {
    return decompile(bytes).code;
  } catch {
    return decompile(bytes, { opcodeTable: "hbc98-late" }).code;
  }
}
function fnText(code: string, name: string): string {
  const i = code.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} not in output`);
  return code.slice(i, code.indexOf("\n    }\n", i));
}

for (const version of [84, 94, 96, 98, 99] as const) {
  test(`190-undefined-receiver-rewritten v${version}: no Reflect.apply survives; mixed keeps its method call`, () => {
    const p = join(FIXTURE, `v${version}.hbc`);
    if (!existsSync(p)) return;
    const code = decompiled(new Uint8Array(readFileSync(p)));
    for (const name of ["joinAfterLabel", "loopThenTail", "bySwitch"]) assert.doesNotMatch(fnText(code, name), /Reflect\.apply/, `${name}\n${fnText(code, name)}`);
    assert.match(fnText(code, "mixed"), /\.m\(/);
  });

  test(`190-undefined-receiver-rewritten v${version}: T2, the decompiled source prints expected.txt under the real VM`, (t) => {
    const p = join(FIXTURE, `v${version}.hbc`);
    const hermesc = findHermesc(version as HbcVersion);
    const vm = findHermesVm(version);
    if (!existsSync(p) || hermesc === null || vm === null) {
      t.skip(`v${version}: fixture, hermesc or VM missing`);
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "hbc2js-r3g-"));
    try {
      writeFileSync(join(dir, "in.js"), decompiled(new Uint8Array(readFileSync(p))));
      const r = runHermesc(hermesc, ["-O", "-emit-binary", `-out=${join(dir, "out.hbc")}`, "in.js"], dir);
      assert.equal(r.status, 0, r.stderr);
      const out = execFileSync(vm.path, [join(dir, "out.hbc")], { encoding: "utf8" });
      assert.equal(out, readFileSync(join(FIXTURE, "expected.txt"), "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// R3h: the register is reused for scratch elsewhere, but the write reaching
// the call in its own statement list is `undefined`.
const site = (list: readonly Stmt[]): { node: Expr; i: number } => {
  const i = list.length - 1;
  const s = list[i] as Stmt & { k: "expr" };
  return { node: (s.expr as Expr & { k: "assign" }).value, i };
};
const applyStmt = (T: string): Stmt => asg("r0", reflectApply(id("f"), id(T), [id("x")]));

test("R3h: a reused register whose reaching write is `undefined` becomes a plain call", () => {
  const list: Stmt[] = [asg("r4", id("o")), asg("r4", U), asg("r9", call(id("g"), [id("r4")])), applyStmt("r4")];
  const { node, i } = site(list);
  assert.equal(isProvenUndefinedThis(id("r4"), list), false);
  const r = classifyNode(node, list, { list, stmtIndex: i });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.rule, "R3a");
});

test("R3h: `r4 = Reflect.apply(f, r4, ...)` itself (the store happens after the call) is accepted", () => {
  const list: Stmt[] = [asg("r4", id("o")), asg("r4", U), asg("r4", reflectApply(id("f"), id("r4"), []))];
  const { node, i } = site(list);
  assert.ok(classifyNode(node, list, { list, stmtIndex: i }).ok);
});

test("R3h negative: a write between the `undefined` store and the call, at any depth, refuses", () => {
  const list: Stmt[] = [asg("r4", U), { k: "if", test: id("c"), then: [asg("r4", id("o"))], else: [] }, applyStmt("r4")];
  const { node, i } = site(list);
  assert.deepEqual(classifyNode(node, list, { list, stmtIndex: i }), { ok: false, reason: "unproven-this" });
});

test("R3h negative: the nearest reaching write is not `undefined`", () => {
  const list: Stmt[] = [asg("r4", U), asg("r4", id("o")), applyStmt("r4")];
  const { node, i } = site(list);
  assert.deepEqual(classifyNode(node, list, { list, stmtIndex: i }), { ok: false, reason: "unproven-this" });
});

test("R3h negative: the call statement writes the register before the call", () => {
  const inner = reflectApply(id("f"), id("r4"), []);
  const list: Stmt[] = [asg("r4", id("o")), asg("r4", U), asg("r0", { k: "seq", exprs: [{ k: "assign", target: id("r4"), value: id("o") }, inner] })];
  assert.deepEqual(classifyNode(inner, list, { list, stmtIndex: 2 }), { ok: false, reason: "unproven-this" });
});

test("R3h negative: no write in the call's own list (only in an enclosing one) refuses", () => {
  const inner: Stmt[] = [applyStmt("r4")];
  const outer: Stmt[] = [asg("r4", U), { k: "if", test: id("c"), then: inner, else: [] }, asg("r4", id("o"))];
  const { node, i } = site(inner);
  assert.deepEqual(classifyNode(node, outer, { list: inner, stmtIndex: i }), { ok: false, reason: "unproven-this" });
});
