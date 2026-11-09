// docs/BUGS.md 2026-11-09 "method read moved past an intervening getter"
// (review passes-roundtrip-objlit). `src/emit/lower.ts`'s method-call fusion
// (spec 05 section 7.4) re-emitted `GetById rF, rO, "m"` as `rO.m(...)` at the
// call, after a getter read sitting between the two, so `api.m(t, "c",
// {value: src.v})` logged "v,m" instead of "m,v". Fusion now only crosses
// frame-local instructions; anything else stays `Reflect.apply(rF, rO, [...])`
// for expr-rebuild + call-shape R3b to re-fuse when the argument expressions
// inline after the read, in order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { decompile } from "../../../src/decompile.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";
import { repoRoot } from "../../support/paths.ts";

const FIXTURE = "250-method-read-before-getter-arg";
const dir = join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE);

test("method-read fusion order: 250-method-read-before-getter-arg is PASS under T2 at v84..v99", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, versions: [84, 94, 96, 98, 99], only: [FIXTURE] });
  assert.equal(report.results.length, 5);
  for (const r of report.results) assert.equal(r.verdict, VERDICT.PASS, `${r.fixture.name}: ${r.oracles.map((o) => `${o.oracle}=${o.verdict} ${o.detail ?? ""}`).join(" ")}`);
});

for (const version of ["v84", "v94", "v96", "v98", "v99"] as const) {
  for (const mode of ["none", "on"] as const) {
    test(`method-read fusion order: ${FIXTURE} ${version} --passes=${mode} reads api.m before src.v and still reads as a method call`, () => {
      const code = decompile(new Uint8Array(readFileSync(join(dir, `${version}.hbc`))), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} }).code;
      const out: string[] = [];
      runInNewContext(code, { print: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
      assert.equal(out.join("\n") + "\n", readFileSync(join(dir, "expected.txt"), "utf8"));
      if (mode === "on") assert.match(code, /\bapi\.m\(/, "call-shape R3b re-fuses the unfused read into a method call");
    });
  }
}
