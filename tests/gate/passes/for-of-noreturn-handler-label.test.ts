// for-of P4.3 regression (docs/BUGS.md `for-of-noreturn-handler-label`): at
// v98/v99 Hermes proves a callee never returns and lets the call's block fall
// straight into the for-of cleanup `Catch; IteratorClose; Throw`. The
// structurer prints that fallthrough as `break L<n>` to the merge-point
// wrapper; the for-of pass dropped the wrapper and left the break dangling,
// so the whole file failed to parse ("Undefined label", found exporting a
// 39k-function bare RN app). Fixture 470 is the minimised repro. Also covers
// EM-01b, the emitter's own unbound-label check that turns any future leak
// into an isolated throwing stub instead of invalid syntax.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { decompile } from "../../../src/decompile.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";
import { collectUnboundLabels } from "../../../src/emit/scope-check.ts";
import type { Stmt } from "../../../src/emit/ast.ts";
import { repoRoot } from "../../support/paths.ts";

const FIXTURE = "470-for-of-noreturn-call";
const DIR = join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE);
const VERSIONS = ["v84", "v94", "v96", "v98", "v99"] as const;
const expected = readFileSync(join(DIR, "expected.txt"), "utf8");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dec = (version: string, mode: "on" | "none"): { code: string; diagnostics: readonly { code: string; message: string }[] } => decompile(new Uint8Array(readFileSync(join(DIR, `${version}.hbc`))), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} }) as any;
const run = (code: string): string => {
  const out: string[] = [];
  runInNewContext(code, { print: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  return out.join("\n") + "\n";
};

for (const version of VERSIONS) {
  for (const mode of ["none", "on"] as const) {
    test(`for-of P4.3: ${FIXTURE} ${version} --passes=${mode} parses, runs and prints expected.txt with no isolated stub`, () => {
      const r = dec(version, mode);
      assert.equal(run(r.code), expected);
      assert.deepEqual(r.diagnostics.filter((d) => d.code === "W_UNBOUND_ISOLATED"), []);
    });
  }
}

test(`for-of P4.3: ${FIXTURE} is PASS under the gate tier at every version`, async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, versions: [84, 94, 96, 98, 99], only: [FIXTURE] });
  assert.ok(report.results.length > 0);
  for (const r of report.results) assert.equal(r.verdict, VERDICT.PASS, `${r.fixture.name} ${r.version}: ${r.oracles.map((o) => `${o.oracle}=${o.verdict} ${o.detail ?? ""}`).join(" ")}`);
});

const fn = (name: string, body: Stmt[]): Stmt => ({ k: "func", name, params: [], body });
const brk = (label: string | null): Stmt => ({ k: "break", label });
const cont = (label: string | null): Stmt => ({ k: "continue", label });

test("EM-01b: labels in scope are accepted (labeled blocks, labeled loops, switch, unlabeled loop jumps)", () => {
  const program: Stmt[] = [
    { k: "iife", body: [fn("_fn1", [
      { k: "labeled", label: "L0", body: [brk("L0")] },
      { k: "while", label: "L1", body: [{ k: "labeled", label: "L2", body: [brk("L2"), cont("L1"), brk("L1"), cont(null)] }, brk(null)] },
      { k: "switch", disc: { k: "id", name: "undefined" }, cases: [{ test: null, body: [brk(null)] }] },
    ] as Stmt[])] },
  ] as Stmt[];
  assert.deepEqual(collectUnboundLabels(program), []);
});

test("EM-01b: dangling, non-loop-continue, cross-function and stray unlabeled jumps are all reported under their function", () => {
  const program: Stmt[] = [
    { k: "iife", body: [fn("_fn1", [
      { k: "for-of", label: null, decl: "let", left: { k: "id", name: "x" }, right: { k: "id", name: "y" }, body: [brk("L12")] },
      { k: "labeled", label: "L3", body: [cont("L3")] },
      { k: "while", label: "L4", body: [fn("_fn2", [brk("L4"), brk(null)])] },
    ] as Stmt[])] },
  ] as Stmt[];
  const got = collectUnboundLabels(program);
  assert.deepEqual(got.map((u) => u.path.at(-1)), ["_fn1", "_fn1", "_fn2", "_fn2"]);
  assert.match(got[0]!.message, /break L12/);
});
