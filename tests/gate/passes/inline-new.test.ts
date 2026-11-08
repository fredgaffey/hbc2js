// ACCEPTANCE + REGRESSION: hermesc-inlined `new C(...)` (rung `inline-new`,
// docs/specs/passes/24-class-recover.md section 9) and class-recover's F1
// through a labelled block (section 3.1), from the docs/BUGS.md row "E2E tier
// 1 -- bucket `diff:GetOwnPrivateBySym/GetByVal`", 2026-11-09 items (i)/(ii).
// Fixtures: 90-inlined-new (base, private field, top level + other frame),
// 91-inlined-new-derived, 92-inlined-new-lookalike (must stay as written),
// 93-class-labelled-block (F1: before the fix no class was recovered).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { decompile } from "../../../src/decompile.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";
import type { Expr, Stmt } from "../../../src/passes/ast.ts";
import { foldAll } from "../../../src/passes/inline-new/match.ts";
import { repoRoot } from "../../support/paths.ts";

const FIXTURES = ["90-inlined-new", "91-inlined-new-derived", "92-inlined-new-lookalike", "93-class-labelled-block"];
const dirOf = (f: string): string => join(repoRoot(), "tests", "fixtures", "constructs", f);
const js = (fixture: string, version: "v98" | "v99", mode: "on" | "none"): string =>
  decompile(new Uint8Array(readFileSync(join(dirOf(fixture), `${version}.hbc`))), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} }).code;
const run = (code: string): string => {
  const out: string[] = [];
  runInNewContext(code, { print: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  return out.join("\n") + "\n";
};
const fnText = (code: string, name: string): string => {
  const i = code.indexOf(`function ${name}(`);
  assert.notEqual(i, -1, `no function ${name}`);
  return code.slice(i, code.indexOf("\n    }\n", i));
};

test("inline-new: fixtures 90-93 are PASS under T2 at v98 and v99", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, versions: [98, 99], only: FIXTURES });
  assert.equal(report.results.length, 8);
  for (const r of report.results) assert.equal(r.verdict, VERDICT.PASS, `${r.fixture.name}: ${r.oracles.map((o) => `${o.oracle}=${o.verdict} ${o.detail ?? ""}`).join(" ")}`);
});

for (const version of ["v98", "v99"] as const) {
  for (const fixture of FIXTURES) {
    const expected = readFileSync(join(dirOf(fixture), "expected.txt"), "utf8");
    for (const mode of ["none", "on"] as const) {
      test(`inline-new: ${fixture} ${version} --passes=${mode} runs and prints expected.txt`, () => assert.equal(run(js(fixture, version, mode)), expected));
    }
  }

  test(`inline-new: 90-inlined-new ${version} -- both inlined constructions are rebuilt as new Account(...)`, () => {
    const on = js("90-inlined-new", version, "on");
    assert.match(on, /= new \w+\("top", 10\);/);
    assert.match(fnText(on, "open"), /\w+ = new \w+\(a1, 3\);/);
    assert.doesNotMatch(fnText(on, "open"), /\.prototype;\n\s+\w+ = Object\.create\(/);
    assert.match(js("90-inlined-new", version, "none"), /Object\.create\(\w+ === null \? null : typeof \w+ === "object"/);
  });

  test(`inline-new: 91-inlined-new-derived ${version} -- the inlined Reflect.construct + body is rebuilt as new Derived(...)`, () => {
    const on = js("91-inlined-new-derived", version, "on");
    assert.match(on, /= new \w+\(1, "x"\);/);
    assert.match(fnText(on, "child"), /\w+ = new \w+\(a1, \w+\);\n\s+return /);
    assert.doesNotMatch(fnText(on, "child"), /Reflect\.construct|super\(\) called twice/);
  });

  test(`inline-new: 92-inlined-new-lookalike ${version} -- hand-written look-alike construction stays as written`, () => {
    const on = js("92-inlined-new-lookalike", version, "on");
    assert.match(fnText(on, "lookalike"), /\.tag = /);
    assert.doesNotMatch(fnText(on, "lookalike"), /= new \w+\(/);
  });

  test(`class-recover F1 (BUGS GetOwnPrivateBySym row item (i)): 93-class-labelled-block ${version} -- classes inside L0: { ... } are recovered`, () => {
    assert.match(js("93-class-labelled-block", version, "none"), /\n {4}L0: \{\n/);
    const on = js("93-class-labelled-block", version, "on");
    assert.match(on, /class Account \{/);
    assert.match(on, /class Derived extends /);
  });
}

// Unit-level soundness: the exact inlined shape, built by hand, with ONE
// extra write between the create and the constructor body. Not a copy of
// the constructor, so it must be refused (R-IN2) and left untouched.
const id = (name: string): Expr => ({ k: "ident", name });
const lit = (text: string): Expr => ({ k: "lit", text });
const mem = (obj: Expr, p: string): Expr => ({ k: "member", obj, prop: lit(p), computed: false });
const set = (target: Expr, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target, value } });
const cls: Expr = { k: "class", name: "P", superClass: null, members: [
  { kind: "method", static: false, computed: false, key: id("constructor"), value: { k: "func", name: null, params: [{ name: "a1" }], body: [set(mem({ k: "this" }, "x"), id("a1"))] } },
] } as unknown as Expr;
const createOf = (x: string): Stmt => set(id(x), { k: "call", callee: mem(id("Object"), "create"), args: [{ k: "cond", test: { k: "bin", op: "===", left: id(x), right: lit("null") }, then: lit("null"), else: { k: "cond", test: { k: "bin", op: "===", left: { k: "unary", op: "typeof ", arg: id(x) }, right: lit('"object"') }, then: id(x), else: mem(id("Object"), "prototype") } } as Expr] });
const module = (extra: readonly Stmt[]): Stmt[] => [
  set(id("r1"), cls),
  set(id("_e0_0"), id("r1")),
  { k: "func", name: "mk", params: [{ name: "a1" }], body: [set(id("r2"), id("_e0_0")), set(id("r3"), mem(id("r2"), "prototype")), createOf("r3"), ...extra, set(mem(id("r3"), "x"), id("a1")), { k: "return", arg: id("r3") }] },
];

test("inline-new (spec 24 section 9.3 R-IN2): an extra write between the create and the constructor body is refused", () => {
  const codes: string[] = [];
  const r = foldAll(module([set(mem(id("r3"), "tag"), lit('"fake"'))]), (x) => codes.push(x.code));
  assert.equal(r.folded, 0);
  assert.deepEqual(codes, ["R-IN2"]);
});

test("inline-new (spec 24 section 9.2): the same shape without the extra write is rebuilt as new", () => {
  const r = foldAll(module([]));
  assert.equal(r.folded, 1);
  const mk = r.after[2] as Extract<Stmt, { k: "func" }>;
  assert.deepEqual(mk.body.slice(1), [set(id("r3"), { k: "new", callee: id("r2"), args: [id("a1")] }), { k: "return", arg: id("r3") }]);
});
