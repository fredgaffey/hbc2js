// docs/BUGS.md row "E2E tier 1 -- bucket `diff:GetOwnPrivateBySym/GetByVal`",
// 2026-11-09 pf-hoisted item: the 46 react-navigation `defining-body-escape`
// refusals once read as "a member function hermesc hoisted into the defining
// frame" are all PRIVATE METHODS (spec 24 section 1.7.1). hermesc lowers
// `#m(){}` to a function created once in the defining frame and kept in an
// env slot, plus a brand symbol the constructor installs; the method body
// reads the class's private fields from outside the class body, so
// private-fields refuses every field such a method touches.
// Fixture 102-private-method reproduces that shape (a recursive private
// method, which hermesc cannot inline). These tests pin today's behaviour --
// refused, symbol-keyed, and still correct under the real VMs' expected.txt
// in both modes -- and are the acceptance fixture for the private-methods
// fold that section 1.7.1 specifies (that landing flips the last test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { decompile } from "../../../src/decompile.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";
import { repoRoot } from "../../support/paths.ts";

const FIXTURE = "102-private-method";
const dir = join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE);
const js = (version: "v98" | "v99", mode: "on" | "none"): string =>
  decompile(new Uint8Array(readFileSync(join(dir, `${version}.hbc`))), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} }).code;
const run = (code: string): string => {
  const out: string[] = [];
  runInNewContext(code, { print: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  return out.join("\n") + "\n";
};

test("private methods: 102-private-method is PASS under T2 at v98 and v99", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, versions: [98, 99], only: [FIXTURE] });
  assert.equal(report.results.length, 2);
  for (const r of report.results) assert.equal(r.verdict, VERDICT.PASS, `${r.fixture.name}: ${r.oracles.map((o) => `${o.oracle}=${o.verdict} ${o.detail ?? ""}`).join(" ")}`);
});

for (const version of ["v98", "v99"] as const) {
  const expected = readFileSync(join(dir, "expected.txt"), "utf8");
  for (const mode of ["none", "on"] as const) {
    test(`private methods: ${FIXTURE} ${version} --passes=${mode} runs and prints expected.txt`, () => assert.equal(run(js(version, mode)), expected));
  }

  test(`private methods: ${FIXTURE} ${version} -- the method is lowered outside the class and #n stays symbol-keyed (section 1.7.1 not yet folded)`, () => {
    const on = js(version, "on");
    assert.match(on, /\/\/ fn#\d+ "#bump"/);
    assert.match(on, /Private element not found/);
    assert.match(on, /Symbol\("#n"\)/);
  });
}
