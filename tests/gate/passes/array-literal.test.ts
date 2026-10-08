// docs/specs/passes/31-array-literal.md — the array-literal rung. Unit
// tests on hand-built ASTs (positives: a plain three-element run, `k=0`;
// negatives: a partial run, a gap, a non-own-index opcode, an unstamped
// statement, a synthetic self-referencing element) plus fixture-level,
// rung-owned assertions on 84 (the consolidation notes §B item 7: no
// exact-output comparison against a shared fixture's whole decompiled
// text).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decompile } from "../../../src/decompile.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { check } from "../../../src/passes/array-literal/check.ts";
import { arrayLiteral } from "../../../src/passes/array-literal/index.ts";
import { match } from "../../../src/passes/array-literal/match.ts";
import { rewrite } from "../../../src/passes/array-literal/rewrite.ts";
import type { PassContext } from "../../../src/passes/types.ts";
import type { FunctionCfg } from "../../../src/cfg/types.ts";
import { repoRoot } from "../../support/paths.ts";

const id = (name: string): Expr => ({ k: "ident", name });
const lit = (text: string): Expr => ({ k: "lit", text });

/** A statement stamped as if the emitter had lowered `opcode` at `offset`. */
let nextOffset = 0;
const stamped = (s: Stmt, opcode: string): Stmt => {
  const offset = nextOffset;
  nextOffset += 4;
  OPCODES.set(offset, opcode);
  return { ...s, origin: { fn: 0, start: offset, end: offset + 4 } } as Stmt;
};
const OPCODES = new Map<number, string>();

const def = (reg: string, k: number, opcode = "NewArray"): Stmt => stamped({ k: "expr", expr: { k: "assign", target: id(reg), value: { k: "new", callee: id("Array"), args: [lit(String(k))], fromNewArray: true } } }, opcode);
const store = (reg: string, index: number, value: Expr, opcode = "PutOwnByIndex"): Stmt =>
  stamped({ k: "expr", expr: { k: "assign", target: { k: "member", obj: id(reg), prop: lit(String(index)), computed: true }, value } }, opcode);

/** A `PassContext` whose `cfg` answers `opcodeAt` from `OPCODES`. */
function ctxFor(): PassContext {
  const blocks = [{ instructions: [...OPCODES].map(([offset, name]) => ({ offset, name, length: 4, operands: [] })) }];
  return { functionIndex: 0, cfg: { blocks } as unknown as FunctionCfg } as PassContext;
}

function fold(list: readonly Stmt[]): readonly Stmt[] | null {
  const ctx = ctxFor();
  const m = match(list, ctx);
  if (m === null) return null;
  const after = rewrite(m);
  const v = check(list, after, ctx);
  assert.equal(v.ok, true, v.reason);
  return after;
}

// ---------------------------------------------------------------------------
// Positives.
// ---------------------------------------------------------------------------

test("array-literal folds a plain three-element NewArray run", () => {
  const list = [def("r0", 3), store("r0", 0, id("r3")), store("r0", 1, id("r2")), store("r0", 2, id("r1")), { k: "return", arg: id("r0") } as Stmt];
  const after = fold(list);
  assert.ok(after !== null);
  assert.equal(after.length, 2);
  const value = (after[0] as { expr: { value: Expr } }).expr.value;
  assert.equal(value.k, "array");
  assert.deepEqual(
    (value as Extract<Expr, { k: "array" }>).elements.map((e) => (e as { name?: string }).name),
    ["r3", "r2", "r1"],
  );
});

test("array-literal folds k=0 with no stores to []", () => {
  const list = [def("r0", 0), { k: "return", arg: id("r0") } as Stmt];
  const after = fold(list);
  assert.ok(after !== null);
  assert.equal(after.length, 2);
  const value = (after[0] as { expr: { value: Expr } }).expr.value;
  assert.equal(value.k, "array");
  assert.equal((value as Extract<Expr, { k: "array" }>).elements.length, 0);
});

test("array-literal folds a DefineOwnInDenseArray run (v99 opcode family)", () => {
  const list = [def("r0", 2, "NewFastArray"), store("r0", 0, id("r1"), "DefineOwnInDenseArray"), store("r0", 1, id("r2"), "DefineOwnInDenseArray")];
  const after = fold(list);
  assert.ok(after !== null);
  assert.equal(after.length, 1);
});

// ---------------------------------------------------------------------------
// Negatives.
// ---------------------------------------------------------------------------

test("array-literal refuses a partial run (trailing elision, elements.length !== k)", () => {
  const list = [def("r0", 3), store("r0", 0, id("r1")), store("r0", 1, id("r2")), { k: "return", arg: id("r0") } as Stmt];
  assert.equal(match(list, ctxFor()), null);
});

test("array-literal refuses a gap (indices 0, 2 — not ascending)", () => {
  const list = [def("r0", 3), store("r0", 0, id("r1")), store("r0", 2, id("r2")), { k: "return", arg: id("r0") } as Stmt];
  assert.equal(match(list, ctxFor()), null);
});

test("array-literal refuses a PutByVal store (full [[Set]], not an own-index define)", () => {
  const list = [def("r0", 2), store("r0", 0, id("r1")), store("r0", 1, id("r2"), "PutByVal"), { k: "return", arg: id("r0") } as Stmt];
  assert.equal(match(list, ctxFor()), null);
});

test("array-literal refuses a source-level `new Array(x)` (no fromNewArray provenance)", () => {
  const list = [stamped({ k: "expr", expr: { k: "assign", target: id("r0"), value: { k: "new", callee: id("Array"), args: [id("r1")] } } }, "Construct")];
  assert.equal(match(list, ctxFor()), null);
});

test("array-literal refuses an unstamped store", () => {
  const list = [def("r0", 1), { k: "expr", expr: { k: "assign", target: { k: "member", obj: id("r0"), prop: lit("0"), computed: true }, value: id("r1") } } as Stmt];
  assert.equal(match(list, ctxFor()), null);
});

// §4 precondition 4: measured unreachable via real source (docs/specs/
// passes/31-array-literal.md §2/§4) — every real own-index store is part of
// the literal's own bracket syntax, never able to reference the register
// being built. Kept defensive; exercised here on a hand-built AST only.
test("array-literal refuses a synthetic own-index store whose value reads the register being built", () => {
  const list = [def("r0", 2), store("r0", 0, id("r1")), store("r0", 1, { k: "member", obj: id("r0"), prop: lit("0"), computed: true })];
  assert.equal(match(list, ctxFor()), null);
});

// docs/BUGS.md `array-literal-interleaved` (F1's finding, ported from
// `object-literal`'s own `canHoist` commutation proof): an interleaved
// statement between two own-index stores is no longer an automatic
// refusal — a *pure register def* commutes above the run when it is safe
// to (reads nothing the run has already exposed, writes nothing the run
// itself depends on, and never redefines the array's own register); a
// genuinely unsafe one (or a call/anything with an effect) still ends the
// run there.
test("array-literal hoists a pure interleaved register def above the run", () => {
  const list = [def("r0", 2), store("r0", 0, id("r3")), { k: "expr", expr: { k: "assign", target: id("r5"), value: lit("1") } } as Stmt, store("r0", 1, id("r5"))];
  const after = fold(list);
  assert.ok(after !== null);
  // The hoisted statement stays a statement of its own, placed before the
  // rebuilt literal — it is relocated, not folded into an element.
  assert.equal(after!.length, 2);
  assert.deepEqual(after![0], list[2]);
});

test("array-literal refuses to hoist a statement that reads the half-built array", () => {
  // `r5 = r0` is syntactically a pure register def, but `r0` is the array
  // this very run is building — hoisting it above the definition would read
  // the array before it exists.
  const list = [def("r0", 1), { k: "expr", expr: { k: "assign", target: id("r5"), value: id("r0") } } as Stmt, store("r0", 0, id("r5"))];
  assert.equal(match(list, ctxFor()), null);
});

test("array-literal refuses to hoist an interleaved statement with an effect (a call)", () => {
  const list = [def("r0", 2), store("r0", 0, id("r3")), { k: "expr", expr: { k: "assign", target: id("r5"), value: { k: "call", callee: id("f"), args: [] } } } as Stmt, store("r0", 1, id("r5"))];
  assert.equal(match(list, ctxFor()), null);
});

// A register REUSED for a redefinition that an EARLIER fold already read
// (register generation hazard, `object-literal-interleaved`'s own residual
// shape in miniature) must not hoist — doing so would change what that
// earlier fold observes. Measured unreachable via real array-literal
// syntax (indices evaluate strictly ascending, unlike an object literal's
// key positions — docs/specs/passes/31-array-literal.md §4), kept
// defensive and covered by a synthetic unit test only, same reasoning as
// precondition 4's self-referencing-element check.
test("array-literal refuses to hoist a register redefinition an earlier fold has already read", () => {
  const list = [def("r0", 2), store("r0", 0, id("r5")), { k: "expr", expr: { k: "assign", target: id("r5"), value: id("r6") } } as Stmt, store("r0", 1, id("r5"))];
  assert.equal(match(list, ctxFor()), null);
});

test("array-literal is a fixed point (PL-08)", () => {
  const list = [def("r0", 2), store("r0", 0, id("r3")), store("r0", 1, id("r2"))];
  const once = fold(list);
  assert.ok(once !== null);
  assert.equal(match(once, ctxFor()), null);
});

// ---------------------------------------------------------------------------
// The checker rejects a mutated writer.
// ---------------------------------------------------------------------------

test("array-literal check rejects a reordered element list", () => {
  const list = [def("r0", 2), store("r0", 0, id("r3")), store("r0", 1, id("r2"))];
  const ctx = ctxFor();
  const m = match(list, ctx);
  assert.ok(m !== null);
  const bad = rewrite({ ...m, data: { ...m.data, elements: [...m.data.elements].reverse() } });
  const v = check(list, bad, ctx);
  assert.equal(v.ok, false);
});

test("array-literal check rejects dropping one store too few", () => {
  const list = [def("r0", 2), store("r0", 0, id("r3")), store("r0", 1, id("r2")), { k: "return", arg: id("r0") } as Stmt];
  const ctx = ctxFor();
  const m = match(list, ctx);
  assert.ok(m !== null);
  const bad = rewrite({ ...m, data: { ...m.data, count: m.data.count - 1 } });
  assert.equal(check(list, bad, ctx).ok, false);
});

test("array-literal registers in the ladder between object-literal and jsx-recover", () => {
  assert.equal(arrayLiteral.stage, "B");
  assert.deepEqual([...arrayLiteral.before!], ["jsx-recover", "var-naming"]);
  assert.ok(arrayLiteral.after!.includes("expr-rebuild"));
});

// ---------------------------------------------------------------------------
// Fixture-level, rung-owned assertions (CONSOLIDATION §B item 7).
// ---------------------------------------------------------------------------

const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "84-array-literal");

function js(version: string, skip: readonly string[] = []): string {
  return decompile(readFileSync(join(FIXTURE, `${version}.hbc`)), { resolveV98Ambiguity: true, passes: skip.length > 0 ? { skip } : {} }).code;
}

for (const version of ["v84", "v94", "v96", "v98", "v99"]) {
  test(`array-literal rebuilds the fixture's normalFold and empty at ${version}`, () => {
    const on = js(version);
    const off = js(version, ["array-literal"]);
    const normalFoldOn = on.match(/function normalFold[\s\S]*?\n {4}\}/)?.[0] ?? "";
    const normalFoldOff = off.match(/function normalFold[\s\S]*?\n {4}\}/)?.[0] ?? "";
    // Baseline: `new Array(3)` followed by three index stores; with the
    // rung on, no `[0] =`/`[1] =`/`[2] =` store survives inside `normalFold`
    // and the literal carries all three elements.
    assert.match(normalFoldOff, /new Array\(3\)/);
    assert.doesNotMatch(normalFoldOn, /\[\d\] = /);
    assert.match(normalFoldOn, /= \[a1, a2, a3\];/);
    // `empty` folds `new Array(0)` to `[]` (inlined by `expr-rebuild` into
    // its sole `return`, so the rewrite is a `return [];`, not an assign).
    assert.doesNotMatch(on, /new Array\(0\)/);
    assert.match(on, /return \[\];/);
    // Rung-owned count: strictly fewer index-store statements survive with
    // the rung on than off.
    const stores = (s: string): number => (s.match(/^\s*\w+\[\d+\] = [^\n]*;$/gm) ?? []).length;
    assert.ok(stores(on) < stores(off), `expected fewer index stores with the rung on (${stores(on)} vs ${stores(off)})`);
  });

  test(`array-literal refuses the fixture's negative controls at ${version}`, () => {
    const on = js(version);
    // partialRun: trailing elision, stays as `new Array(3)` + 2 stores.
    assert.match(on, /new Array\(3\)/);
    // ctorNew: unaffected, still a plain `new Array(x)` call.
    assert.match(on, /new Array\(\w+\)/);
    // selfReferencingStore / holedLiteral: index stores survive as
    // separate statements (never folded into a literal).
    assert.match(on, /\[0\] = /);
    assert.match(on, /\[1\] = /);
  });
}

// ---------------------------------------------------------------------------
// docs/BUGS.md `array-literal-interleaved` (F1's finding): the interleaved
// case, on `85-array-literal-interleaved`.
// ---------------------------------------------------------------------------

const FIXTURE_INTERLEAVED = join(repoRoot(), "tests", "fixtures", "constructs", "85-array-literal-interleaved");

function jsInterleaved(version: string, skip: readonly string[] = []): string {
  return decompile(readFileSync(join(FIXTURE_INTERLEAVED, `${version}.hbc`)), { resolveV98Ambiguity: true, passes: skip.length > 0 ? { skip } : {} }).code;
}

for (const version of ["v84", "v94", "v96", "v98", "v99"]) {
  test(`array-literal hoists the fixture's interleaved closure-reference copy at ${version}`, () => {
    const on = jsInterleaved(version);
    const off = jsInterleaved(version, ["array-literal"]);
    // Off: the run stays a `new Array(2)` plus two separate stores, one of
    // them the interleaved closure-reference copy.
    assert.match(off, /new Array\(2\)/);
    // On: the whole run folds to a two-element array literal — the
    // interleaved copy commutes above it and the run completes.
    const hoistableOn = on.match(/function hoistable[\s\S]*?\n {4}\}/)?.[0] ?? "";
    assert.doesNotMatch(hoistableOn, /new Array\(2\)/);
    assert.match(hoistableOn, /= \[\w+, \w+\];/);
  });

  test(`array-literal still refuses the fixture's register-reuse hazard at ${version}`, () => {
    const on = jsInterleaved(version);
    // nonHoistable: the SAME reason as before this rung (F1's dominant real
    // shape) — a reload reusing a register an earlier element already
    // read is correctly refused, not hoisted. The run stays partial: the
    // `new Array(4)` allocation and its first two stores survive, the
    // reload and the last store stay separate statements.
    const nonHoistableOn = on.match(/function nonHoistable[\s\S]*?\n {4}\}/)?.[0] ?? "";
    assert.match(nonHoistableOn, /new Array\(4\)/);
    assert.match(nonHoistableOn, /\[3\] = /);
  });
}
