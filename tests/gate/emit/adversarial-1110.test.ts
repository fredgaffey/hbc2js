// adversarial-1110 (branch adversarial-eval-order): evaluation-order /
// definition-semantics programs under tests/fixtures/adversarial/60-85. Each
// confirmed emitter bug gets a minimal construct fixture here, checked in both
// --passes modes at every version against the VM-agreeing expected.txt.
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

const cases: readonly { readonly what: string; readonly fixture: string; readonly versions: readonly string[] }[] = [
  // PutOwnByVal with a literal "__proto__" key must define, not [[Set]] (adversarial 79).
  { what: "computed __proto__ key defines an own property", fixture: "351-computed-proto-key", versions: ["v84", "v94", "v96", "v98", "v99"] },
];

for (const c of cases) {
  const dir = join(repoRoot(), "tests", "fixtures", "constructs", c.fixture);
  const expected = readFileSync(join(dir, "expected.txt"), "utf8");
  for (const version of c.versions) {
    for (const mode of ["none", "on"] as const) {
      test(`adversarial-1110: ${c.what} (${c.fixture} ${version} --passes=${mode})`, () => {
        const code = decompile(new Uint8Array(readFileSync(join(dir, `${version}.hbc`))), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} }).code;
        assert.equal(run(code), expected);
      });
    }
  }
}
