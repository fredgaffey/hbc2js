// Register walks must see every expression kind. The Ignite 11.5.0 export
// (bench, 2026-11-24) shipped `r7?.getStateFromPath` after var-naming had
// renamed r7's def to `options`: `renameExpr`, `countUses` and EM-01's
// `scope-check` all lacked the F18 `optmember`/`optcall` cases (and the
// F14/F25 template/tagged/await/yield ones), so the rename skipped the read,
// the checker's use counts agreed with the broken rewrite, and EM-01 never
// saw the now-undeclared register. These tests pin each walk per kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { printProgram } from "../../../src/emit/print.ts";
import { collectUnbound } from "../../../src/emit/scope-check.ts";
import { identUses } from "../../../src/passes/ast.ts";
import { renameRegisterInFrame, renameRegistersInFrame } from "../../../src/passes/var-naming/rewrite.ts";

const optm = (obj: Expr, prop: string): Expr => ({ k: "optmember", obj, prop: lit(prop), computed: false });
const optc = (callee: Expr, args: readonly Expr[]): Expr => ({ k: "optcall", callee, args, thisIsBase: false });
const ex = (e: Expr): Stmt => ({ k: "expr", expr: e });

/** One expression of every kind that can hold a register read, each reading `name`. */
function everyKindReading(name: string): readonly Expr[] {
  const r = id(name);
  return [
    optm(r, "getStateFromPath"),
    optc(optm(id("a1"), "cb"), [r]),
    optc(r, []),
    { k: "optmember", obj: id("a1"), prop: r, computed: true },
    { k: "template", quasis: ["", "%"], exprs: [r] },
    { k: "tagged", tag: r, quasi: { k: "template", quasis: ["x"], exprs: [] } },
    { k: "spread", arg: r },
    { k: "await", arg: r },
    { k: "yield", arg: r, delegate: false },
  ];
}

test("identUses counts a register read through every expression kind (optmember/optcall/template/tagged/spread/await/yield)", () => {
  for (const e of everyKindReading("r7")) {
    const u = identUses([ex(e)], "r7");
    assert.equal(u.reads, 1, `kind ${e.k}: ${printProgram([ex(e)])}`);
  }
});

test("var-naming's frame rename reaches a register read through every expression kind", () => {
  for (const e of everyKindReading("r7")) {
    const before: readonly Stmt[] = [{ k: "decl", kind: "let", names: ["r7"] }, ex(e)];
    const after = renameRegisterInFrame(before, "r7", "options");
    const text = printProgram(after);
    assert.doesNotMatch(text, /\br7\b/, `kind ${e.k}: ${text}`);
    assert.match(text, /\boptions\b/, `kind ${e.k}: ${text}`);
  }
});

test("EM-01 scope-check reports an undeclared identifier under every expression kind", () => {
  for (const e of everyKindReading("r7")) {
    const program: readonly Stmt[] = [{ k: "func", name: "_fn0", params: [{ name: "a1" }], body: [ex(e)] }];
    const names = collectUnbound(program, [], 0).map((u) => u.name);
    assert.deepEqual(names, ["r7"], `kind ${e.k}: ${printProgram(program)}`);
  }
});

test("var-naming's frame rename reaches a register in a for-of/for-in head and body, and a class's superclass/computed key", () => {
  // render-cost 09-switch-fallthrough (named overlay): `for (const r8 of r3)
  // { r7(r8, r1, r6) }` kept `r1` after the overlay renamed its def to `n0`;
  // the extended EM-01 then stubbed the whole-module render but not the scoped one.
  const loops: readonly Stmt[] = (["for-of", "for-in"] as const).map((k) => ({
    k, label: null, decl: "const", left: id("r8"), right: id("r3"),
    body: [ex({ k: "call", callee: id("r7"), args: [id("r8"), id("r1")] })],
  }) as Stmt);
  const cls: Stmt = { k: "classdecl", name: "C", value: { k: "class", name: "C", superClass: id("r1"), members: [{ kind: "method", static: false, computed: true, key: id("r1"), value: { k: "func", name: null, params: [], body: [] } }] } };
  for (const s of [...loops, cls]) {
    const before: readonly Stmt[] = [{ k: "decl", kind: "let", names: ["r1", "r3", "r7", "r8"] }, s];
    const text = printProgram(renameRegistersInFrame(before, new Map([["r1", "n0"], ["r3", "list"], ["r8", "x"]])));
    assert.doesNotMatch(text, /\br1\b|\br3\b|\br8\b/, `${s.k}: ${text}`);
  }
});
