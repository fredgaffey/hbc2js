// review-1110 guard/this: adversarial review of the 2026-11-09 landings
// `passes-roundtrip-guard` (global-access condition 7, the local-store proof,
// docs/specs/passes/03-global-access.md section 4) and `passes-roundtrip-this`
// (call-shape R3h "every write is undefined" and R3i "the reaching write is
// `r = undefined`", docs/specs/passes/04-call-shape.md section 4). No probe
// broke either rule; these are the probes, kept as negative controls.
//
// Fixtures (T2 on the real VMs, every version):
//   310 guard: captured local named `globalThis`, counting getter on the
//       global object, a global created and deleted mid-loop, generator and
//       async resumption, try/finally, for-in.
//   311 this: plain calls sharing a `this` register with method calls across
//       branches, loop back-edges, try/catch/finally, generator, async,
//       for-in, conditional/optional/parenthesised callees, tagged templates,
//       switch fall-through; strict and sloppy callees report their `this`.
//   312 guard: named function expressions called `JSON`/`Math`.
//   313 guard: a top-level function reassigned after a reader was compiled.
//   314 guard: an outer `globalThis.X` snapshot var-naming could call `X`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { classifySite, isLocallyProvenGlobal } from "../../../src/passes/global-access/match.ts";
import { classifyNode, isProvenUndefinedThis } from "../../../src/passes/call-shape/match.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";

const FIXTURES = [
  "310-review-guard-probes",
  "311-review-this-probes",
  "312-review-guard-named-fnexpr",
  "313-review-guard-reassigned-global-fn",
  "314-review-guard-outer-local-name",
];
const VERSIONS = [84, 94, 96, 98, 99];

test("review-1110 guard/this: probe fixtures 310-314 are T2 PASS at every version", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, only: FIXTURES, versions: VERSIONS });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS).map((r) => `${r.fixture.name}: ${r.verdict}`);
  assert.deepEqual(bad, []);
  assert.equal(report.results.length, FIXTURES.length * VERSIONS.length);
});

// 84/94/96 keep guards in the generator/async lowered bodies (missed folds,
// not a soundness question), so only 98/99 are pinned guard-free.
test("review-1110 guard/this: fixture 310 has no global guard left at 98/99, so condition 7 is what was exercised", () => {
  for (const v of [98, 99]) {
    const bytes = new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", FIXTURES[0]!, `v${v}.hbc`)));
    const out = decompile(bytes, { moduleName: FIXTURES[0]!, resolveV98Ambiguity: true }).code;
    assert.ok(!out.includes("doesn't exist"), `v${v} still has a guard`);
  }
});

// --- hand-built: global-access condition 7 ----------------------------------------
const exprStmt = (e: Expr): Stmt => ({ k: "expr", expr: e });
const set = (r: string, value: Expr): Stmt => exprStmt({ k: "assign", target: id(r), value });
const member = (obj: Expr, prop: string): Expr => ({ k: "member", obj, prop: lit(prop), computed: false });
const quoted = (s: string): Expr => lit(`"${s}"`);
const G = id("r2");
const guardFor = (p: string): Stmt => ({
  k: "if",
  test: { k: "unary", op: "!", arg: { k: "bin", op: "in", left: quoted(p), right: G } },
  then: [{ k: "throw", arg: { k: "new", callee: id("ReferenceError"), args: [quoted(`Property '${p}' doesn't exist`)] } }],
  else: [],
});
const store = set("r2", id("globalThis"));
const read = set("r3", member(G, "Object"));
const forIn = (left: string, body: Stmt[] = []): Stmt => ({ k: "for-in", label: null, decl: null, left: id(left), right: id("a3"), body });
const site = (list: Stmt[], i: number): string => {
  const fnBody: Stmt[] = [set("r2", id("a1")), { k: "labeled", label: "L0", body: list }];
  const r = classifySite(list, fnBody, i, "Object", G);
  return r.ok ? "ok" : r.reason;
};

test("review-1110 guard/this: condition 7 refuses a for-in that retargets the register between store and guard", () => {
  assert.equal(site([store, forIn("r2"), guardFor("Object"), read], 2), "unproven-global");
  // ... or a nested list that writes it on one path only
  assert.equal(site([store, { k: "while", label: null, test: id("a2"), body: [set("r2", id("a1"))] }, guardFor("Object"), read], 2), "unproven-global");
});

test("review-1110 guard/this: condition 7 needs the store before the guard in the guard's own list", () => {
  // store after the guard (a loop back-edge would reach the guard with the old value)
  assert.equal(site([guardFor("Object"), read, store], 0), "unproven-global");
  assert.equal(isLocallyProvenGlobal([guardFor("Object"), read, store], 0, 1, G), false);
  // the read itself overwrites the register before reading it
  const clobberRead = set("r3", { k: "seq", exprs: [{ k: "assign", target: G, value: id("a1") }, member(G, "Object")] });
  assert.equal(isLocallyProvenGlobal([store, guardFor("Object"), clobberRead], 1, 2, G), false);
  // a write between the guard and the read
  assert.equal(isLocallyProvenGlobal([store, guardFor("Object"), set("r2", id("a1")), read], 1, 3, G), false);
  // a non-register is never locally proven
  assert.equal(isLocallyProvenGlobal([set("g", id("globalThis")), guardFor("Object"), read], 1, 2, id("g")), false);
});

// --- hand-built: call-shape R3h / R3i ---------------------------------------------
const call = (callee: Expr, args: readonly Expr[]): Expr => ({ k: "call", callee, args });
const reflectApply = (T: Expr, extra: readonly Expr[] = []): Expr & { k: "call" } =>
  call(member(id("Reflect"), "apply"), [id("f"), T, { k: "array", elements: extra }]) as Expr & { k: "call" };
const U = lit("undefined");
const verdictAt = (list: Stmt[], i: number, node: Expr, fnBody: Stmt[] = list): string => {
  const r = classifyNode(node, fnBody, { list, stmtIndex: i });
  return r.ok ? r.rule : r.reason;
};

test("review-1110 guard/this: R3i takes the nearest write, and accepts r = undefined after scratch use", () => {
  const n = reflectApply(id("r1"));
  assert.equal(verdictAt([set("r1", id("o")), exprStmt(call(id("g"), [id("r1")])), set("r1", U), set("r0", n)], 3, n), "R3a");
  // the call's own top-level target store happens after the call
  const n2 = reflectApply(id("r1"));
  assert.equal(verdictAt([set("r1", id("o")), set("r1", U), set("r1", n2)], 2, n2), "R3a");
  // nearest write is the scratch value
  const n3 = reflectApply(id("r1"));
  assert.equal(verdictAt([set("r1", U), set("r1", id("o")), set("r0", n3)], 2, n3), "unproven-this");
});

test("review-1110 guard/this: R3i refuses writes hidden in try, for-in, catch parameter, loop, or the call's own arguments", () => {
  const between = (mid: Stmt): string => {
    const n = reflectApply(id("r1"));
    return verdictAt([set("r1", id("o")), set("r1", U), mid, set("r0", n)], 3, n);
  };
  assert.equal(between({ k: "try", block: [set("r1", id("o"))], param: "e", handler: [] }), "unproven-this");
  assert.equal(between(forIn("r1")), "unproven-this");
  assert.equal(between({ k: "try", block: [], param: "r1", handler: [] }), "unproven-this");
  assert.equal(between({ k: "while", label: null, test: id("a2"), body: [exprStmt({ k: "seq", exprs: [{ k: "assign", target: id("r1"), value: id("o") }, id("a2")] })] }), "unproven-this");
  // a write inside the call's own arguments runs before the call (refused,
  // here already by the argument-array shape)
  const own = reflectApply(id("r1"), [{ k: "seq", exprs: [{ k: "assign", target: id("r1"), value: id("o") }, lit("1")] }]);
  assert.notEqual(verdictAt([set("r1", id("o")), set("r1", U), set("r0", own)], 2, own), "R3a");
  // ... or in the statement around it, before the call
  const n4 = reflectApply(id("r1"));
  assert.equal(verdictAt([set("r1", id("o")), set("r1", U), set("r0", { k: "seq", exprs: [{ k: "assign", target: id("r1"), value: id("o") }, n4] })], 2, n4), "unproven-this");
  // the call in a while test whose body writes the register (loop back-edge)
  const inTest = reflectApply(id("r1"));
  assert.equal(verdictAt([set("r1", id("o")), set("r1", U), { k: "while", label: null, test: inTest, body: [set("r1", id("o"))] }], 2, inTest), "unproven-this");
});

test("review-1110 guard/this: R3i does not consult the enclosing list", () => {
  const n = reflectApply(id("r1"));
  const inner: Stmt[] = [set("r0", n)];
  const fnBody: Stmt[] = [set("r1", id("o")), set("r1", U), { k: "labeled", label: "L0", body: inner }];
  assert.equal(verdictAt(inner, 0, n, fnBody), "unproven-this");
});

test("review-1110 guard/this: R3h refuses a for-in target or catch parameter among all-undefined writes", () => {
  assert.equal(isProvenUndefinedThis(id("r1"), [set("r1", U), forIn("r1"), set("r1", U)]), false);
  assert.equal(isProvenUndefinedThis(id("r1"), [set("r1", U), { k: "try", block: [], param: "r1", handler: [] }]), false);
  assert.equal(isProvenUndefinedThis(id("r1"), [set("r1", U), exprStmt(call(id("g"), [{ k: "assign", target: id("r1"), value: id("o") }]))]), false);
  // a write in a nested func is another frame and does not count
  assert.equal(isProvenUndefinedThis(id("r1"), [set("r1", U), { k: "func", name: "h", params: [], body: [set("r1", id("o"))] }]), true);
});
