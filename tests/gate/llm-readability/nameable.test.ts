// Spec 28 section 7 coverage DENOMINATOR (docs/READABILITY.md "Nameable
// denominator"): only registers the rendered source binds to a local
// identifier are asked about. Construct fixture 01-if-else-chain (v98), no
// model, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { decompileFunction, parseForDecompile } from "../../../src/decompile.ts";
import { rawFrameBodies } from "../../../src/name-overlay/frames.ts";
import { listNameable } from "../../../src/artifact/frame-queries.ts";
import { nameableIndex } from "../../../src/readability/nameable.ts";
import { recordingStats } from "../../../src/readability/measure.ts";
import { collectTargets } from "../../../tools/readability/record.ts";
import { OverlayStore } from "../../../src/name-overlay/index.ts";
import type { Recording } from "../../../src/workers/backends/replay.ts";

const HBC = join(repoRoot(), "tests", "fixtures", "constructs", "01-if-else-chain", "v98.hbc");

test("nameable: a register is nameable iff the unnamed rendered source binds its identifier", () => {
  const bytes = readFileSync(HBC);
  const analysis = analyseModule(parseForDecompile(bytes, {}).module, { strictEnv: false });
  const frames = rawFrameBodies(analysis, { strictEnv: false });
  const idx = nameableIndex(analysis, { strictEnv: false });
  let candidates = 0, nameable = 0;
  for (let fn = 0; fn < analysis.module.functions.length; fn++) {
    const code = decompileFunction(bytes, fn, { strictEnv: false }).code;
    const bound = new Set(idx.of(fn));
    for (const r of listNameable(frames, fn)) {
      candidates += 1;
      const word = new RegExp(`\\br${String(r.reg)}\\b`);
      if (bound.has(r.reg)) nameable += 1;
      else assert.ok(!word.test(code), `fn ${String(fn)} r${String(r.reg)} is not nameable but its identifier is rendered`);
    }
  }
  assert.ok(candidates > 0);
  assert.ok(nameable < candidates, `the fixture must contain a register the rendered source never binds (${String(nameable)}/${String(candidates)})`);
});

test("nameable: collectTargets only requests nameable registers; stats use the nameable map as the denominator", () => {
  const bytes = readFileSync(HBC);
  const analysis = analyseModule(parseForDecompile(bytes, {}).module, { strictEnv: false });
  const frames = rawFrameBodies(analysis, { strictEnv: false });
  const idx = nameableIndex(analysis, { strictEnv: false });
  const store = new OverlayStore({ bundle: "x" });
  const all = collectTargets(analysis, frames, store, null);
  const filtered = collectTargets(analysis, frames, store, null, idx);
  assert.ok(filtered.length < all.length);
  for (const t of filtered) assert.ok(idx.of(t.fn).includes(t.reg));

  const text = JSON.stringify({ abstained: false, names: [{ bindingId: { fn: 1, reg: 1 }, name: "n", confidence: "high", evidence: "x" }] });
  const recording = { k: { text, meta: { fn: 1, requested: 9 } } } as unknown as Recording;
  const withMap = recordingStats(recording, { "1": [1, 2] });
  assert.equal(withMap.requested, 2);
  assert.equal(withMap.coverage, 0.5);
  assert.equal(recordingStats(recording).requested, 9, "without a map the recorded request is the denominator");
});
