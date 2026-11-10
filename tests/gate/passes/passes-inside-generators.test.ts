// passes-inside-generators: at v84/94/96 a generator/async body is emitted as
// `return function (__sent, __isReturn, __isThrow) { switch (__state) ... }`
// (`func.sameFrame`), and before this item no stage-B pass ever visited it
// (docs/specs/passes/03-global-access.md section 7, "Lowered generator
// bodies"). Audited rungs (`Pass.sameFrame`) now see its lists, with the
// closure treated as part of the enclosing frame AND as a loop body whose
// entry has unknown register state (docs/specs/passes/00-LADDER.md
// "Resumable bodies"). Construct fixture 370 pins both directions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/passes/ast.ts";
import { stmtLists } from "../../../src/passes/ast.ts";
import { classifySite } from "../../../src/passes/global-access/match.ts";
import { isProvenUndefinedThis } from "../../../src/passes/call-shape/match.ts";
import { analyze } from "../../../src/passes/globalthis-dead-store/analysis.ts";

const FIXTURE = "370-passes-in-generator-body";
const code = (v: number): string => decompile(new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${v}.hbc`))), { moduleName: FIXTURE, resolveV98Ambiguity: true }).code;
/** The text of every `sameFrame` resume closure in `src` (from its
 *  `return function (__sent` line to the end of its enclosing `_fnN`). */
const resumeClosures = (src: string): string => src.split("return function (__sent").slice(1).map((c) => c.split(/\n {4,8}function _fn|\n {4}function /)[0]!).join("\n");
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

test("passes-inside-generators: global-access, call-shape and object-literal fire inside the resume closure (fixture 370, 84/94/96)", () => {
  for (const v of [84, 94, 96]) {
    const inside = resumeClosures(code(v));
    assert.ok(inside.length > 0, `v${v}: no resume closure found`);
    // global-access: a first-resume read folds to the bare global.
    assert.match(inside, /= Math;|Math\.abs\(|= Math\.abs/, `v${v}: no folded global read inside the closure`);
    // call-shape: the `f.call(undefined, t)` site is a direct call, not Reflect.apply.
    assert.match(inside, /\.call\(/, `v${v}: no recovered .call( inside the closure`);
    // object-literal: `r = {}; r.x = ...` folded.
    assert.match(inside, /= \{[a-z]+: /, `v${v}: no folded object literal inside the closure`);
  }
});

test("passes-inside-generators: a globalThis register stored in an earlier resume stays guarded (fixture 370 negative twin)", () => {
  for (const v of [84, 94, 96]) {
    const inside = resumeClosures(code(v));
    // `JSON`/`Number` are read in the LAST resume of `walk` through the
    // register the first resume loaded `globalThis` into.
    assert.match(inside, /if \(!\("JSON" in r\d+\)\)/, `v${v}: the cross-resume JSON guard was folded`);
  }
  for (const v of [98, 99]) assert.equal(count(code(v), /doesn't exist/g), 0, `v${v}: native generators fold every guard`);
});

// ---------------------------------------------------------------------------
// Hand-built ASTs: the framework rules themselves.
// ---------------------------------------------------------------------------
const id = (name: string): Expr => ({ k: "ident", name });
const lit = (text: string): Expr => ({ k: "lit", text });
const set = (r: string, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target: id(r), value } as Expr });
const guard = (p: string, g: Expr): Stmt => ({
  k: "if",
  test: { k: "unary", op: "!", arg: { k: "bin", op: "in", left: lit(`"${p}"`), right: g } } as Expr,
  then: [{ k: "throw", arg: { k: "new", callee: id("ReferenceError"), args: [lit(`"Property '${p}' doesn't exist"`)] } as Expr }],
  else: [],
});
const read = (dst: string, g: string, p: string): Stmt => set(dst, { k: "member", obj: id(g), prop: lit(p), computed: false } as Expr);
const resume = (body: readonly Stmt[]): Stmt => ({ k: "return", arg: { k: "func", name: null, params: [], body, sameFrame: true } as Expr });
const frame = (body: readonly Stmt[]): Stmt[] => [{ k: "decl", kind: "let", names: ["r0", "r1", "r2"] } as Stmt, resume(body)];

test("passes-inside-generators: stmtLists descends into the resume closure only when asked", () => {
  const inner: Stmt[] = [set("r1", id("globalThis"))];
  const body = frame(inner);
  assert.equal(stmtLists(body).includes(inner), false);
  assert.equal(stmtLists(body, { sameFrame: true }).includes(inner), true);
});

test("passes-inside-generators: resume entry -- a guard with no globalThis store earlier in the same resume is refused", () => {
  const caseBody: Stmt[] = [guard("Math", id("r1")), read("r0", "r1", "Math")];
  const sw: Stmt = { k: "switch", disc: id("__state"), cases: [{ test: lit("1"), body: caseBody }] } as unknown as Stmt;
  const tail: Stmt[] = [set("r1", id("globalThis")), guard("Math", id("r1")), read("r0", "r1", "Math")];
  const body = frame([sw, ...tail]);
  const inner = (body[1] as unknown as { arg: { body: Stmt[] } }).arg.body;
  // the case reads a register stored by an earlier resume: refused
  assert.equal(classifySite(caseBody, body, 0, "Math", id("r1")).ok, false);
  // the store-then-guard in the same resume: folds
  assert.equal(classifySite(inner, body, 2, "Math", id("r1")).ok, true);
});

test("passes-inside-generators: the resume closure is a loop body -- a later clobber refuses the whole-function proof", () => {
  const thenL: Stmt[] = [guard("Math", id("r1")), read("r0", "r1", "Math")];
  const mk = (): Stmt[] => [set("r1", id("globalThis")), { k: "if", test: id("r2"), then: thenL, else: [] } as Stmt, set("r1", lit("7"))];
  // as a plain function body: the later scratch reuse is harmless
  const plain = mk();
  assert.deepEqual(classifySite(thenL, plain, 0, "Math", id("r1")).ok, true, JSON.stringify(classifySite(thenL, plain, 0, "Math", id("r1"))));
  // inside the resume closure: the clobber runs before the next resume's read
  const v = classifySite(thenL, frame(mk()), 0, "Math", id("r1"));
  assert.deepEqual(v, { ok: false, reason: "loop-reentry-clobber" });
});

test("passes-inside-generators: call-shape's every-write proof sees writes inside the resume closure", () => {
  assert.equal(isProvenUndefinedThis(id("r2"), frame([set("r2", lit("undefined"))])), true);
  assert.equal(isProvenUndefinedThis(id("r2"), frame([set("r2", lit("undefined")), set("r2", id("obj"))])), false);
});

test("passes-inside-generators: globalthis-dead-store keeps a closure store a later resume reads", () => {
  const caseBody: Stmt[] = [read("r0", "r1", "Math")];
  const sw: Stmt = { k: "switch", disc: id("__state"), cases: [{ test: lit("1"), body: caseBody }] } as unknown as Stmt;
  const store = set("r1", id("globalThis"));
  assert.equal(analyze(frame([sw, store, { k: "return", arg: null } as Stmt])).deadStores.has(store), false);
  const lone = set("r2", id("globalThis"));
  assert.equal(analyze(frame([lone])).deadStores.has(lone), true);
});
