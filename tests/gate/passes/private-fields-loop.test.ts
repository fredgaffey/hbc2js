// REGRESSION (docs/BUGS.md row "E2E tier 1 -- bucket
// `diff:GetOwnPrivateBySym/GetByVal`", 2026-11-09 inline-new-3 item, the four
// loop frames): a class member that reads a private name inside a loop copies
// the symbol from its env slot into a register in the loop body. The member
// scan treated the loop as one leaf, so the slot stayed mentioned and R-PF1
// (defining-body-escape) refused the name. Spec 24 section 1.7, "loops".
// Fixture 112-private-field-loop-copy folds; the hand-built negatives below
// are the shapes the back-edge argument must refuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { decompile } from "../../../src/decompile.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";
import { foldInBody } from "../../../src/passes/private-fields/match.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { repoRoot } from "../../support/paths.ts";

const FIXTURE = "112-private-field-loop-copy";
const dir = join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE);
const js = (version: "v98" | "v99", mode: "on" | "none"): string =>
  decompile(new Uint8Array(readFileSync(join(dir, `${version}.hbc`))), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} }).code;
const run = (code: string): string => {
  const out: string[] = [];
  runInNewContext(code, { print: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  return out.join("\n") + "\n";
};

test("private-fields loops: fixture 112 is PASS under T2 at v98 and v99", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, versions: [98, 99], only: [FIXTURE] });
  assert.equal(report.results.length, 2);
  for (const r of report.results) assert.equal(r.verdict, VERDICT.PASS, `${r.fixture.name}: ${r.oracles.map((o) => `${o.oracle}=${o.verdict} ${o.detail ?? ""}`).join(" ")}`);
});

for (const version of ["v98", "v99"] as const) {
  const expected = readFileSync(join(dir, "expected.txt"), "utf8");
  for (const mode of ["none", "on"] as const) {
    test(`private-fields loops: ${FIXTURE} ${version} --passes=${mode} runs and prints expected.txt`, () => assert.equal(run(js(version, mode)), expected));
  }
  test(`private-fields loops: ${FIXTURE} ${version} -- #tag is folded inside both loops`, () => {
    const on = js(version, "on");
    assert.doesNotMatch(on, /Symbol\("#tag"\)/);
    assert.match(on, /\n\s+#tag = -1;\n/);
    assert.ok((on.match(/\.#tag\b/g) ?? []).length >= 3, "the constructor write and both loop reads use #tag");
  });
}

// Hand-built member bodies: `_e0_0` holds the symbol, `this` the receiver.
const id = (name: string): Expr => ({ k: "ident", name });
const set = (name: string, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target: id(name), value } });
const rd = (reg: string): Expr => ({ k: "member", obj: { k: "this" } as Expr, prop: id(reg), computed: true });
const leak = (e: Expr): Stmt => ({ k: "expr", expr: { k: "call", callee: id("leak"), args: [e] } });
const loop = (body: Stmt[]): Stmt => ({ k: "while", label: null, test: id("c"), body });
const folded = (body: Stmt[]): boolean => {
  const r = foldInBody(body, "_e0_0", "#x", false);
  return r !== null && !JSON.stringify(r.body).includes('"_e0_0"');
};

test("private-fields loops: a copy killed in the same straight-line stretch folds", () => {
  const body = [loop([set("r1", id("_e0_0")), set("r1", rd("r1")), leak(id("r1"))])];
  assert.equal(folded(body), true);
  const out = JSON.stringify(foldInBody(body, "_e0_0", "#x", false)!.body);
  assert.ok(out.includes('"text":"#x"'), out);
});

test("private-fields loops: refuses every copy whose symbol value can outlive its stretch", () => {
  const cases: Record<string, Stmt[]> = {
    "carried over the back edge": [loop([leak(rd("r1")), set("r1", id("_e0_0"))])],
    "carried out of the loop": [loop([set("r1", id("_e0_0")), leak(rd("r1"))]), leak(id("r1"))],
    "a continue before the kill": [loop([set("r1", id("_e0_0")), { k: "if", test: id("d"), then: [{ k: "continue", label: null } as Stmt], else: [] }, set("r1", rd("r1"))])],
    "an entry alias overwritten in the loop": [set("r1", id("_e0_0")), loop([leak(rd("r1")), set("r1", { k: "lit", text: "0" })])],
  };
  for (const [what, body] of Object.entries(cases)) assert.equal(folded(body), false, `${what}: must refuse`);
});
