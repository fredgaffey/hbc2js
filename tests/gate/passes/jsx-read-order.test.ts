// fix-jsx-read-order (probe of the method-read worker's suspected gap): the
// element factory read must keep its place against the type/props work
// around it. Three bugs, one fixture (construct 360, all versions):
//  * expr-rebuild R1a folded an impure `rT = X.Text` into the very next
//    statement's argument even when that statement evaluates something
//    observable first (`r1 = r3.createElement(rT, null)` reads
//    `r3.createElement` before the argument) -- now `firstReadOrder` must
//    report the read as the first observable evaluation (default pipeline);
//  * jsx-recover absorbed the same impure type read into a call whose
//    member callee is read at the call (`--jsx`, `moved-impure`);
//  * reg-split never descended into a `jsx` node, so a split register in
//    an attribute kept the pre-split name (`--jsx`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { decompile } from "../../../src/decompile.ts";
import { firstReadOrder } from "../../../src/passes/ast.ts";
import type { Expr } from "../../../src/passes/ast.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";
import { repoRoot } from "../../support/paths.ts";

const FIXTURE = "360-jsx-factory-read-order";
const dir = join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE);

test("fix-jsx-read-order: 360-jsx-factory-read-order is PASS under T2 at v84..v99", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, versions: [84, 94, 96, 98, 99], only: [FIXTURE] });
  assert.equal(report.results.length, 5);
  for (const r of report.results) assert.equal(r.verdict, VERDICT.PASS, `${r.fixture.name}: ${r.oracles.map((o) => `${o.oracle}=${o.verdict} ${o.detail ?? ""}`).join(" ")}`);
});

for (const version of ["v84", "v94", "v96", "v98", "v99"] as const) {
  for (const mode of ["none", "on", "jsx"] as const) {
    test(`fix-jsx-read-order: ${FIXTURE} ${version} --passes=${mode} keeps factory reads in source order`, () => {
      const passes = mode === "none" ? { none: true } : mode === "jsx" ? { optIn: ["jsx-recover"] } : {};
      const code = decompile(new Uint8Array(readFileSync(join(dir, `${version}.hbc`))), { resolveV98Ambiguity: true, passes }).code;
      const out: string[] = [];
      runInNewContext(code, { print: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
      assert.equal(out.join("\n") + "\n", readFileSync(join(dir, "expected.txt"), "utf8"));
    });
  }
}

const id = (name: string): Expr => ({ k: "ident", name });
const lit = (text: string): Expr => ({ k: "lit", text });
const member = (obj: Expr, p: string): Expr => ({ k: "member", obj, prop: lit(p), computed: false });

test("fix-jsx-read-order: firstReadOrder puts a member callee's get before the arguments", () => {
  const call: Expr = { k: "call", callee: member(id("r3"), "createElement"), args: [id("r2"), lit("null")] };
  assert.equal(firstReadOrder(call, "r2", []), "impure");
  const regCallee: Expr = { k: "call", callee: id("r3"), args: [id("r2"), lit("null")] };
  const names: string[] = [];
  assert.equal(firstReadOrder(regCallee, "r2", names), "found");
  assert.deepEqual(names, ["r3"]);
  assert.equal(firstReadOrder(member(id("r2"), "x"), "r2", []), "found");
});

test("fix-jsx-read-order: firstReadOrder treats a read under && or ?: as not first", () => {
  assert.equal(firstReadOrder({ k: "logical", op: "&&", left: id("r1"), right: id("r2") } as Expr, "r2", []), "impure");
  assert.equal(firstReadOrder({ k: "bin", op: "+", left: id("r1"), right: id("r2") } as Expr, "r2", []), "found");
  assert.equal(firstReadOrder({ k: "bin", op: "+", left: member(id("r1"), "a"), right: id("r2") } as Expr, "r2", []), "impure");
});
