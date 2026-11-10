// Review 1110 (diamonds): adversarial soundness probes of the v98+ `f.call` /
// `f.apply(t, arguments)` JmpBuiltinIs diamonds (fcall-diamond, R3g,
// docs/specs/passes/04-call-shape.md section 10) and the `__hbc_arguments`
// unmapped-copy helper (src/runtime/helpers.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";

const PROBES = "320-review-diamonds-probes";
const CALLEE = "321-review-diamonds-arguments-callee";

async function t2(fixture: string): Promise<void> {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, only: [fixture], versions: [84, 94, 96, 98, 99] });
  const ran = report.results.filter((r) => r.fixture.name.startsWith(fixture));
  assert.ok(ran.length >= 5, `only ${ran.length} versions ran`);
  assert.deepEqual(ran.filter((r) => r.verdict !== VERDICT.PASS).map((r) => `${r.fixture.name}: ${r.verdict}`), []);
}

test("review-1110 diamonds: negative controls (exotic callees, call/apply deleted or overridden mid-function, getters, receiver reassignment, nested diamonds, exception edges, mutated/escaping arguments) are T2 PASS at every version", async () => {
  await t2(PROBES);
});

test("review-1110 diamonds: every v98/v99 diamond in the probe fixture collapses (no builtin shim left)", () => {
  for (const v of [98, 99]) {
    const out = decompile(new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", PROBES, `v${v}.hbc`))), { moduleName: PROBES, resolveV98Ambiguity: true }).code;
    assert.ok(!/__hbc_b_functionPrototype(Call|Apply)|__hbc_b_applyArguments\(/.test(out), `v${v} still has a diamond shim`);
  }
});

test("review-1110 diamonds: a loose function's forwarded/escaping arguments keep `callee` (the unmapped copy was a strict arguments object whose callee throws) -- T2 PASS at every version", async () => {
  await t2(CALLEE);
});
