// REGRESSION (docs/BUGS.md row "E2E tier 1 -- bucket
// `diff:GetOwnPrivateBySym/GetByVal`", 2026-11-09 inline-new-3 item, the six
// R-IN1 frames): after super-call rebuilt a derived constructor's `super()`,
// the constructor keeps the dead `r = Object.getPrototypeOf(<class binding>)`
// store ahead of it, and inline-new refused the inlined construction as R-IN1
// ("no leading super(...) after silent stores"), so private-fields refused
// R-PF1 on the inlined installs. Spec 24 section 9.2 (6).
// Fixtures: 110-inlined-new-derived-residue (folds) and its negative twin
// 111-inlined-new-derived-before-super (user code before super: stays).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { decompile } from "../../../src/decompile.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";
import { repoRoot } from "../../support/paths.ts";

const FIXTURES = ["110-inlined-new-derived-residue", "111-inlined-new-derived-before-super"];
const dirOf = (f: string): string => join(repoRoot(), "tests", "fixtures", "constructs", f);
const js = (fixture: string, version: "v98" | "v99", mode: "on" | "none"): string =>
  decompile(new Uint8Array(readFileSync(join(dirOf(fixture), `${version}.hbc`))), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} }).code;
const run = (code: string): string => {
  const out: string[] = [];
  runInNewContext(code, { print: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  return out.join("\n") + "\n";
};

test("inline-new derived residue: fixtures 110/111 are PASS under T2 at v98 and v99", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, versions: [98, 99], only: FIXTURES });
  assert.equal(report.results.length, 4);
  for (const r of report.results) assert.equal(r.verdict, VERDICT.PASS, `${r.fixture.name}: ${r.oracles.map((o) => `${o.oracle}=${o.verdict} ${o.detail ?? ""}`).join(" ")}`);
});

for (const version of ["v98", "v99"] as const) {
  for (const fixture of FIXTURES) {
    const expected = readFileSync(join(dirOf(fixture), "expected.txt"), "utf8");
    for (const mode of ["none", "on"] as const) {
      test(`inline-new derived residue: ${fixture} ${version} --passes=${mode} runs and prints expected.txt`, () => assert.equal(run(js(fixture, version, mode)), expected));
    }
  }

  test(`inline-new derived residue: 110-inlined-new-derived-residue ${version} -- the inlined construction is new FocusManager() and its private names fold`, () => {
    const on = js("110-inlined-new-derived-residue", version, "on");
    assert.doesNotMatch(on, /Reflect\.construct/);
    assert.match(on, /= new \w+\(\);/);
    assert.doesNotMatch(on, /Symbol\("#/);
    assert.match(on, /this\.#setup/);
  });

  test(`inline-new derived residue: 111-inlined-new-derived-before-super ${version} -- user code before super keeps the inlined construction`, () => {
    const on = js("111-inlined-new-derived-before-super", version, "on");
    assert.match(on, /Reflect\.construct/);
  });
}
