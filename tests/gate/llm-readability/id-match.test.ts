// readability-id-match: the ids a naming prompt asks about must be identifiers
// the model can literally see in the printed body. Before the fix the nameable
// index also counted a binding that var-naming renders under a heuristic name
// (`r1_2` printed as `apply`), so the prompt asked for ids absent from `source`
// and the model abstained ("requested ids cannot be matched"). One render is
// the source of truth: nameable set == requestable identifiers of the body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { decompileFunction, parseForDecompile } from "../../../src/decompile.ts";
import { registerIdent } from "../../../src/name-overlay/id.ts";
import { nameableIndex } from "../../../src/readability/nameable.ts";

const DIR = join(repoRoot(), "tests", "fixtures", "constructs");
const CASES: readonly [string, string][] = [
  ["96-reg-reuse-straight", "v99.hbc"],
  ["96-reg-reuse-straight", "v98.hbc"],
  ["01-if-else-chain", "v98.hbc"],
];

for (const [name, file] of CASES) {
  test(`id-match: every requested binding of ${name}/${file} appears literally in the printed body`, () => {
    const bytes = readFileSync(join(DIR, name, file));
    const analysis = analyseModule(parseForDecompile(bytes, {}).module, { strictEnv: false });
    const idx = nameableIndex(analysis, { strictEnv: false });
    let checked = 0;
    for (let fn = 0; fn < analysis.module.functions.length; fn++) {
      const code = decompileFunction(bytes, fn, { strictEnv: false }).code;
      const idents = new Set(code.match(/[A-Za-z_$][\w$]*/g) ?? []);
      for (const b of idx.bindings(fn)) {
        checked += 1;
        const ident = registerIdent(b);
        assert.ok(idents.has(ident), `fn ${String(fn)}: requested ${ident} is not an identifier of the printed body`);
      }
    }
    assert.ok(checked > 0);
  });
}
