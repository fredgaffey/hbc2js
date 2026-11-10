// Review 2026-11-10 (branch review-iife-private): adversarial soundness review
// of spec 27 sections 10-12 (closure placement and per-execution identity) and
// spec 24 section 1.7 / 1.7.1 (private fields, methods, `#x in`). Each fixture
// is compiled for every version hermesc supports; expected.txt is the real
// Hermes VM's output (v94/v96/v98/v99 VMs agree).
//
// Bugs (failed before the fix, both --passes modes):
//   340 a closure in a retry loop whose back edge runs through a `catch` was
//       hoisted (the cycle is only in the exceptional CFG): `attempts: 4 false
//       false`, `weakmap: 3 3 3`.
//   341 a closure created after a `yield` in a pre-v97 generator loop was
//       hoisted into the generator factory (the loop is a resume, not a CFG
//       cycle): `loop distinct: false` at v84/v94/v96.
//   342 `o.#x` / `o.#x = v` on an object without the field (foreign, primitive,
//       or inheriting it through its prototype) must throw a TypeError; the
//       symbol lowering read undefined / the prototype's field and the write
//       created the field.
// Negative controls (held before and after): 343 (return-override stamping,
// static private), 344 (closures created at most once per activation).
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
const PRIVATE = ["v98", "v99"] as const;
const cases: readonly { readonly title: string; readonly fixture: string; readonly versions: readonly string[] }[] = [
  { title: "closure in a catch-retry loop is fresh per attempt", fixture: "340-closure-in-catch-retry-loop", versions: ALL },
  { title: "closure after a yield is fresh per resumption", fixture: "341-closure-per-generator-resume", versions: ALL },
  { title: "private get/set of a missing field throws", fixture: "342-private-field-missing-throws", versions: PRIVATE },
  { title: "negative control: return-override stamping and static private", fixture: "343-private-return-override-stamp", versions: PRIVATE },
  { title: "negative control: once-per-activation closures", fixture: "344-closure-once-per-activation", versions: ALL },
];

for (const c of cases) {
  const dir = join(repoRoot(), "tests", "fixtures", "constructs", c.fixture);
  const expected = readFileSync(join(dir, "expected.txt"), "utf8");
  for (const version of c.versions) {
    for (const mode of ["none", "on"] as const) {
      test(`review-1110 iife/private: ${c.title} (${c.fixture} ${version} --passes=${mode})`, () => {
        const file = join(dir, `${version}.hbc`);
        assert.ok(existsSync(file), `${file} missing; run tests/fixtures/build.sh`);
        const code = decompile(new Uint8Array(readFileSync(file)), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} }).code;
        assert.equal(run(code), expected);
      });
    }
  }
}

test("review-1110 iife/private: --passes=on folds the private access helper back to `#a` syntax (342 v99, inner class)", () => {
  const dir = join(repoRoot(), "tests", "fixtures", "constructs", "342-private-field-missing-throws");
  const code = decompile(new Uint8Array(readFileSync(join(dir, "v99.hbc"))), { resolveV98Ambiguity: true, passes: {} }).code;
  assert.match(code, /\breturn a1\.#a;/);
});
