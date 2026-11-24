// Corpus a03 (hbc98, zustand persist's inlined `toThenable`): the returned
// closure `f` creates `then`/`catch`, which create `f` again over an
// environment THEY own. `f`'s per-creation-context copies for those sites
// were hosted inside `f`'s own subtree, could not nest inside themselves, and
// fell to module level unbound (`_fn7372__c1`, `hydrate` E_UNBOUND_IDENT,
// boot INCONCLUSIVE). `then` is lexically nested in `f`, so `f` now becomes
// a G2 factory. Fixture 501.
//
// The react-navigation case pins the rule's other side: fn 11444 creates
// sibling 11442 over their shared outer environment and 11442 creates 11444
// over an environment it owns. That is creation, not lexical nesting; the
// per-site copies are fine. A trigger that followed bare creation made 11444
// a factory and overflowed the stack in emission.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { repoRoot } from "../../support/paths.ts";
import { decompile, decompileFunction } from "../../../src/decompile.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { analyseModule } from "../../../src/cfg/index.ts";

const DIR = join(repoRoot(), "tests", "fixtures", "constructs", "501-closure-copy-self-nesting");
const expected = readFileSync(join(DIR, "expected.txt"), "utf8");

for (const v of [84, 94, 96, 98, 99]) {
  test(`501 closure copy self-nesting: v${v} decompiles with no isolated function and runs`, () => {
    const code = decompile(new Uint8Array(readFileSync(join(DIR, `v${v}.hbc`))), { moduleName: "x", resolveV98Ambiguity: true }).code;
    assert.doesNotMatch(code, /ISOLATED FAILURE|could not decompile/);
    const out: string[] = [];
    runInNewContext(code, { print: (...a: unknown[]) => out.push(a.join(" ")), Promise, Error, Object, Symbol, Reflect, TypeError, String });
    assert.equal(out.join("\n") + "\n", expected);
  });
}

test("react-navigation fn 11444: creation without lexical nesting stays per-site copies; decompile completes", () => {
  const bytes = new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc")));
  const graph = analyseModule(parseHbc(bytes, { resolveV98Ambiguity: true }), { lenientEnv: true }).envGraph;
  assert.ok(!graph.closureFactories.has(11444), "11444 must not become a G2 factory");
  assert.deepEqual([...graph.closureFactories].sort((a, b) => a - b), [11751, 12280, 12406, 12407, 12408, 12754, 13078, 13523, 13524, 14287, 14983, 14984, 14985, 14986, 15373]);
  for (const fn of [793, 11444]) {
    const code = decompileFunction(bytes, fn, { resolveV98Ambiguity: true }).code;
    assert.doesNotMatch(code, /ISOLATED FAILURE|could not decompile/, `fn ${fn}`);
  }
});
