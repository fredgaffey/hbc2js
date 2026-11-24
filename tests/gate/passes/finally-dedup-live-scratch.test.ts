// finally-dedup R-FD9 regression (docs/BUGS.md `finally-dedup-register-mismatch`):
// the handler-side finalizer copy, which ends in a rethrow, may use registers
// that are live on the normal path as scratch. Printing it as a JS `finally`
// made it run on the normal path too and clobber them (torture s1-n10000:
// `arr.slice is not a function`). Fixture 460 is the minimised repro.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { decompile } from "../../../src/decompile.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";
import { repoRoot } from "../../support/paths.ts";

const FIXTURE = "460-finally-dedup-live-scratch";
const DIR = join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE);
const VERSIONS = ["v84", "v94", "v96", "v98", "v99"] as const;
const expected = readFileSync(join(DIR, "expected.txt"), "utf8");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dec = (version: string, mode: "on" | "none"): { code: string; diagnostics: readonly { code: string; message: string }[] } => decompile(new Uint8Array(readFileSync(join(DIR, `${version}.hbc`))), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} }) as any;
const run = (code: string): string => {
  const out: string[] = [];
  runInNewContext(code, { print: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  return out.join("\n") + "\n";
};

for (const version of VERSIONS) {
  for (const mode of ["none", "on"] as const) {
    test(`finally-dedup R-FD9: ${FIXTURE} ${version} --passes=${mode} runs and prints expected.txt`, () => {
      assert.equal(run(dec(version, mode).code), expected);
    });
  }
}

// MEASURED 2026-11-24: before R-FD9 both functions folded (and miscompiled)
// at v94/v96/v98/v99; v84 lays the finalizer out differently and never folded.
for (const version of ["v94", "v96", "v98", "v99"] as const) {
  test(`finally-dedup R-FD9: the scratch-clobbering handler copy is refused with a named code at ${version}`, () => {
    const r = dec(version, "on");
    const got = r.diagnostics.filter((d) => d.code === "W_PASS_REFUSED" && d.message.includes("finally-dedup") && d.message.includes("R-FD9"));
    assert.ok(got.length > 0, `an R-FD9 refusal is reported: ${r.diagnostics.map((d) => d.message).join(" / ")}`);
  });
}

test(`finally-dedup R-FD9: ${FIXTURE} is PASS under the gate tier at every version`, async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, versions: [84, 94, 96, 98, 99], only: [FIXTURE] });
  assert.ok(report.results.length > 0);
  for (const r of report.results) assert.equal(r.verdict, VERDICT.PASS, `${r.fixture.name}: ${r.oracles.map((o) => `${o.oracle}=${o.verdict} ${o.detail ?? ""}`).join(" ")}`);
});
