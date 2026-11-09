// REGRESSION (pf-hosted-r1, the private-methods worker's report): `foldOne`'s
// R-PF1 (defining-frame escape) only scanned the statement list the class was
// matched in. When hermesc hosts the class inside a labelled block in the
// function body, a function at the body's TOP LEVEL (outside that block) that
// still reads the symbol's env slot was never checked, so the class folded to
// `#v` while that function kept reading `o[_e0_0]` -- a slot nothing writes
// any more. Spec 24 section 1.7, R-PF1. Fixture
// 180-private-field-hosted-hoisted-escape (must stay symbol-keyed and run);
// positive twins 181-private-method-hosted and 182-private-method-register-hop
// (spec 24 section 1.7.1's hosted and register-hop method shapes fold).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { decompile } from "../../../src/decompile.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";
import { repoRoot } from "../../support/paths.ts";

const FIXTURES = ["180-private-field-hosted-hoisted-escape", "181-private-method-hosted", "182-private-method-register-hop"];
const dirOf = (f: string): string => join(repoRoot(), "tests", "fixtures", "constructs", f);
const js = (fixture: string, version: "v98" | "v99", mode: "on" | "none"): string =>
  decompile(new Uint8Array(readFileSync(join(dirOf(fixture), `${version}.hbc`))), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} }).code;
const run = (code: string): string => {
  const out: string[] = [];
  runInNewContext(code, { print: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  return out.join("\n") + "\n";
};

test("private-fields hosted: fixtures are PASS under T2 at v98 and v99", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, versions: [98, 99], only: FIXTURES });
  assert.equal(report.results.length, FIXTURES.length * 2);
  for (const r of report.results) assert.equal(r.verdict, VERDICT.PASS, `${r.fixture.name}: ${r.oracles.map((o) => `${o.oracle}=${o.verdict} ${o.detail ?? ""}`).join(" ")}`);
});

for (const version of ["v98", "v99"] as const) {
  for (const fixture of FIXTURES) {
    const expected = readFileSync(join(dirOf(fixture), "expected.txt"), "utf8");
    for (const mode of ["none", "on"] as const) {
      test(`private-fields hosted: ${fixture} ${version} --passes=${mode} runs and prints expected.txt`, () => assert.equal(run(js(fixture, version, mode)), expected));
    }
  }

  test(`private-fields hosted: 180-private-field-hosted-hoisted-escape ${version} -- a top-level reader outside the hosting block keeps #v symbol-keyed`, () => {
    const on = js("180-private-field-hosted-hoisted-escape", version, "on");
    assert.match(on, /Symbol\("#v"\)/);
    assert.doesNotMatch(on, /\.#v\b/);
  });

  test(`private-fields hosted: 181-private-method-hosted ${version} -- the hosted #bump moves into the class and #n folds`, () => {
    const on = js("181-private-method-hosted", version, "on");
    assert.match(on, /\n\s+#bump\(a1\) \{/);
    assert.match(on, /\.#bump\(/);
    assert.doesNotMatch(on, /Symbol\("#n"\)/);
    assert.doesNotMatch(on, /Symbol\("Counter"\)/);
  });
}

test("private-fields hosted: 182-private-method-register-hop v99 -- #step folds through the recycled hop register", () => {
  const on = js("182-private-method-register-hop", "v99", "on");
  assert.match(on, /\n\s+#step\(a1\) \{/);
  assert.match(on, /\.#step\(/);
  assert.doesNotMatch(on, /Symbol\("#v"\)/);
});
