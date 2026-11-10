// fix-closure-identity-2: the two docs/BUGS.md rows review-1110 iife/private
// left open against spec 27 section 12. Each fixture is compiled for every
// version hermesc supports; expected.txt is the real Hermes VM's output
// (v94/v96/v98/v99 VMs agree).
//
//   380 a named function expression created in a loop printed `.name` as
//       `_fnN` under `--passes on` (section 12 emits it as an expression and
//       `fn-naming` only renamed declarations): `name: _fn4 _fn4 true
//       function`. `--passes none` never recovers names, so only `on` is
//       asserted.
//   381 a closure whose creator hermesc inlined into two functions was one
//       declaration at their common host, so every call returned the same
//       object at v98/v99, both modes: `distinct: false false false`,
//       `weakmap: 2 2 2`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { decompile } from "../../../src/decompile.ts";
import { repoRoot } from "../../support/paths.ts";

const run = (code: string): string => {
  const out: string[] = [];
  try {
    runInNewContext(code, { print: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  } catch (e) {
    out.push(`THROW ${String(e)}`);
  }
  return out.join("\n") + "\n";
};

const ALL = ["v84", "v94", "v96", "v98", "v99"] as const;
const cases: readonly { readonly title: string; readonly fixture: string; readonly modes: readonly ("none" | "on")[] }[] = [
  { title: "a named function expression in a loop keeps its name", fixture: "380-named-fn-expr-in-loop", modes: ["on"] },
  { title: "a closure whose creator was inlined into two functions is fresh per call", fixture: "381-closure-inlined-creator-identity", modes: ["none", "on"] },
];

for (const c of cases) {
  const dir = join(repoRoot(), "tests", "fixtures", "constructs", c.fixture);
  const expected = readFileSync(join(dir, "expected.txt"), "utf8");
  for (const version of ALL) {
    for (const mode of c.modes) {
      test(`fix-closure-identity-2: ${c.title} (${c.fixture} ${version} --passes=${mode})`, () => {
        const file = join(dir, `${version}.hbc`);
        assert.ok(existsSync(file), `${file} missing; run tests/fixtures/build.sh`);
        const code = decompile(new Uint8Array(readFileSync(file)), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} }).code;
        assert.equal(run(code), expected);
      });
    }
  }
}
