// Corpus a03 (hbc98, zustand persist's inlined `toThenable`): the returned
// closure `f` creates `then`/`catch`, which create `f` again over an
// environment THEY own. `f`'s per-creation-context copies for those sites
// were hosted inside `f`'s own subtree, could not nest inside themselves, and
// fell to module level unbound (`_fn7372__c1`, `hydrate` E_UNBOUND_IDENT,
// boot INCONCLUSIVE). The G2 factory trigger now follows creation through
// uncopied creators, so `f` becomes a factory. Fixture 501.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";

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
