// REGRESSION (docs/BUGS.md row "E2E tier 1 -- bucket
// `diff:GetOwnPrivateBySym/GetByVal`", 2026-11-09 inline-new-2 item):
// `private-fields` left a private access inside a function DECLARED in a
// class member untouched, so the symbol's env slot stayed mentioned and R-PF1
// (defining-body-escape) refused the whole name. Spec 24 section 1.7.
// Fixtures: 100-private-field-nested-function (folds) and its negative twin
// 101-private-field-hoisted-function (hermesc hoists the non-capturing
// function out of the class: must stay symbol-keyed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { decompile } from "../../../src/decompile.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";
import { repoRoot } from "../../support/paths.ts";

const FIXTURES = ["100-private-field-nested-function", "101-private-field-hoisted-function"];
const dirOf = (f: string): string => join(repoRoot(), "tests", "fixtures", "constructs", f);
const js = (fixture: string, version: "v98" | "v99", mode: "on" | "none"): string =>
  decompile(new Uint8Array(readFileSync(join(dirOf(fixture), `${version}.hbc`))), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} }).code;
const run = (code: string): string => {
  const out: string[] = [];
  runInNewContext(code, { print: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  return out.join("\n") + "\n";
};

test("private-fields nested functions: fixtures 100/101 are PASS under T2 at v98 and v99", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, versions: [98, 99], only: FIXTURES });
  assert.equal(report.results.length, 4);
  for (const r of report.results) assert.equal(r.verdict, VERDICT.PASS, `${r.fixture.name}: ${r.oracles.map((o) => `${o.oracle}=${o.verdict} ${o.detail ?? ""}`).join(" ")}`);
});

for (const version of ["v98", "v99"] as const) {
  for (const fixture of FIXTURES) {
    const expected = readFileSync(join(dirOf(fixture), "expected.txt"), "utf8");
    for (const mode of ["none", "on"] as const) {
      test(`private-fields nested functions: ${fixture} ${version} --passes=${mode} runs and prints expected.txt`, () => assert.equal(run(js(fixture, version, mode)), expected));
    }
  }

  test(`private-fields nested functions: 100-private-field-nested-function ${version} -- #v is folded inside the member's nested functions`, () => {
    const on = js("100-private-field-nested-function", version, "on");
    assert.doesNotMatch(on, /Symbol\("#v"\)/);
    assert.match(on, /\n\s+#v( = undefined)?;\n/);
    assert.match(on, /function get\(\) \{[^}]*\.#v;/);
    assert.match(on, /#v in \w+/);
    assert.match(on, /function inner\(\) \{[^}]*\.#v \* 2;/);
  });

  test(`private-fields nested functions: 101-private-field-hoisted-function ${version} -- the hoisted reader keeps the name symbol-keyed`, () => {
    const on = js("101-private-field-hoisted-function", version, "on");
    assert.match(on, /Symbol\("#n"\)/);
    assert.doesNotMatch(on, /\.#n\b/);
  });
}
