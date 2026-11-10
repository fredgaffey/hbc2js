// fix-env-per-context (G2): a function whose own environment is ambiguous --
// it is created from several contexts, one of them itself, and creates an
// environment whose parent is `GetParentEnvironment 1` of whichever
// environment it captured (react-navigation fn#14983/14984/14986/12754,
// Expensify fn#95616/95617/95619/72937/76056: 18 and 20 unresolved env
// accesses). Fixture 440 is the construct; spec 03 §6.2 "polymorphic parent".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseHbc } from "../../../src/index.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";

const FX = "440-self-creating-closure-env";
const VERSIONS = [84, 94, 96, 98, 99] as const;

for (const v of [98, 99] as const) {
  test(`env-per-context G2: fixture 440 v${v} resolves every environment access, the self-creating closures become factories`, () => {
    const mod = parseHbc(new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", FX, `v${v}.hbc`))));
    const g = analyseModule(mod, { strictEnv: false }).envGraph;
    assert.deepEqual(g.unresolved.map((u) => `${u.functionIndex}@${u.offset}`), []);
    assert.ok(g.closureFactories.size >= 2, `expected map/both to be closure factories, got ${[...g.closureFactories]}`);
  });
}

test("env-per-context G2: fixture 440 is T2 PASS at 84/94/96/98/99 (fresh objects, shared `seq`, per-instance `count`)", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, only: [FX], versions: [...VERSIONS] });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS).map((r) => `${r.fixture.name}: ${r.verdict}`);
  assert.equal(report.results.length, VERSIONS.length);
  assert.deepEqual(bad, []);
});
