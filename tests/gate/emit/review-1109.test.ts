// Review 2026-11-09 (branch review-passes-1109, docs/REVIEW-1109.md):
// independent soundness review of the passes merged that day. Each fixture
// here is a confirmed divergence from the real Hermes VM's output
// (expected.txt is the VM's output for the fixture's own bytecode). These
// tests FAIL until the bugs are fixed; they are deliberately not fixed here.
//
// review-1109-1 (fixture 200): a closure created inside a loop is emitted as
//   one hoisted function declaration, so every iteration yields the same
//   function object (closure identity; both --passes modes, every version).
// review-1109-2 (fixture 201): `#x in v` with a primitive v throws TypeError in
//   the VM; the lowered brand test `hasOwnProperty.call(v, sym)` returns false.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const cases: readonly { readonly id: string; readonly fixture: string; readonly versions: readonly string[] }[] = [
  { id: "review-1109-1", fixture: "200-closure-in-loop-identity", versions: ["v84", "v94", "v96", "v98", "v99"] },
  { id: "review-1109-2", fixture: "201-private-brand-in-primitive", versions: ["v98", "v99"] },
];

for (const c of cases) {
  const dir = join(repoRoot(), "tests", "fixtures", "constructs", c.fixture);
  const expected = readFileSync(join(dir, "expected.txt"), "utf8");
  for (const version of c.versions) {
    for (const mode of ["none", "on"] as const) {
      test(`${c.id}: ${c.fixture} ${version} --passes=${mode} prints the VM's expected.txt`, () => {
        const code = decompile(new Uint8Array(readFileSync(join(dir, `${version}.hbc`))), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} }).code;
        assert.equal(run(code), expected);
      });
    }
  }
}
