// Review 2026-11-10 (branch review-objlit-fold): adversarial soundness review
// of object-literal-arg (docs/specs/passes/20-object-literal.md section 9),
// expressionOnlyCheck's carried live-in reads and its derived-ctor strict
// form (02-expr-rebuild.md), and super-call's kept `let T;`.
//
// Each case runs the fixture's own bytecode through the decompiler (both
// --passes modes) and compares the program's output with expected.txt, the
// real Hermes VM's output for that bytecode.
//
// 330: object-literal-arg kind B moved a global callee base past a global
//      getter read and a `+` (valueOf) it called pure (confirmed bug, fixed).
// 331, 332: negative controls -- probes that held.
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

const ALL = ["v84", "v94", "v96", "v98", "v99"] as const;
const cases: readonly { readonly id: string; readonly fixture: string; readonly versions: readonly string[] }[] = [
  { id: "callee base not moved past a getter or valueOf", fixture: "330-callee-base-past-getter", versions: ALL },
  { id: "negative controls (literal-arg inputs, carried live-ins)", fixture: "331-objlit-fold-controls", versions: ALL },
  { id: "negative control (derived-ctor carried live-ins)", fixture: "332-derived-ctor-carried-live-in", versions: ["v98", "v99"] },
];

for (const c of cases) {
  const dir = join(repoRoot(), "tests", "fixtures", "constructs", c.fixture);
  const expected = readFileSync(join(dir, "expected.txt"), "utf8");
  for (const version of c.versions) {
    for (const mode of ["none", "on"] as const) {
      test(`review-1110 objlit/fold: ${c.id} -- ${c.fixture} ${version} --passes=${mode}`, () => {
        const code = decompile(new Uint8Array(readFileSync(join(dir, `${version}.hbc`))), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} }).code;
        assert.equal(run(code), expected);
      });
    }
  }
}
