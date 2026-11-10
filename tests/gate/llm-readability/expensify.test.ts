// Second-app leg for the v6 naming skill: Expensify/App 0.86.0 (open source).
// Labels: tools/readability/label-registers.ts over the app's own hermesc -O -g
// dumps (300-function sample of the 40,391 resolved parameter labels). Skips
// only when the recording or labels are absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { rateHighConfidence } from "../../../src/readability/rater.ts";
import { proposalsForLabels, recordedNames, recordingStats } from "../../../src/readability/measure.ts";
import type { NameableMap } from "../../../src/readability/measure.ts";
import type { Recording } from "../../../src/workers/backends/replay.ts";
import type { LabelledSample } from "../../../src/readability/types.ts";

const DIR = join(repoRoot(), "tests", "fixtures", "llm-readability");
const LABELS = join(DIR, "expensify-app-0.86.0.labels.json");
const RECORDING = join(DIR, "expensify-app-0.86.0.recording.idmatch.v6.json");
/** Measured 2026-11-09 (v6, sonnet, 60 fns): coverage 411/424, lenient all 32/93, high 14/15 lenient (14 exact). */
const FLOOR_COVERAGE = 0.9;
const FLOOR_N = 60;
const FLOOR_LENIENT = 0.25;
const FLOOR_HIGH_N = 10;
const FLOOR_HIGH_LENIENT = 0.7;
const NAMEABLE = join(DIR, "expensify-app-0.86.0.nameable.idmatch.json");

test("expensify v6: labels are register-level, from the app's own source map, and carry no vendor code", (t) => {
  if (!existsSync(LABELS)) return t.skip("needs expensify-app-0.86.0.labels.json");
  const s = JSON.parse(readFileSync(LABELS, "utf8")) as LabelledSample;
  assert.equal(s.app, "expensify-app-0.86.0");
  const fns = new Set<number>();
  for (const x of s.targets) {
    assert.equal(x.kind, "register");
    assert.ok(!x.source.includes("node_modules"), `${x.id}: vendor source`);
    assert.ok(x.binding !== undefined);
    fns.add(x.binding.fn);
  }
  assert.ok(fns.size >= 250, `${String(fns.size)} labelled functions`);
});

test("expensify v6: coverage and accuracy floors over the 60-function id-match recording", (t) => {
  if (!existsSync(LABELS) || !existsSync(RECORDING) || !existsSync(NAMEABLE)) return t.skip("needs the expensify labels, v6 recording and nameable map");
  const s = JSON.parse(readFileSync(LABELS, "utf8")) as LabelledSample;
  const rec = JSON.parse(readFileSync(RECORDING, "utf8")) as Recording;
  const stats = recordingStats(rec, JSON.parse(readFileSync(NAMEABLE, "utf8")) as NameableMap);
  const both = rateHighConfidence(s, proposalsForLabels(s, recordedNames(rec)));
  t.diagnostic(`expensify v6: coverage ${String(stats.named)}/${String(stats.requested)}; high ${String(both.high.lenient)}/${String(both.high.n)} lenient (${String(both.high.exact)} exact); all ${String(both.all.lenient)}/${String(both.all.n)} (${String(both.all.exact)} exact)`);
  assert.ok(stats.coverage !== undefined && stats.coverage >= FLOOR_COVERAGE, `coverage ${String(stats.coverage)}`);
  assert.equal(stats.abstainWithoutReason, 0);
  assert.ok(both.all.lenient >= both.all.exact);
  assert.ok(both.all.n >= FLOOR_N && both.all.lenient / both.all.n >= FLOOR_LENIENT, `lenient ${String(both.all.lenient)}/${String(both.all.n)}`);
  assert.ok(both.high.n >= FLOOR_HIGH_N && both.high.lenient / both.high.n >= FLOOR_HIGH_LENIENT, `high lenient ${String(both.high.lenient)}/${String(both.high.n)}`);
});

// readability-v9 (docs/READABILITY.md "Skill v9: parameters first"): the same
// 60 functions under v9b. Coverage falls 4.2 points (silent omissions), the
// high tier is less accurate; low rises 3/25 -> 6/25. v6 stays default.
test("readability-v9: Expensify v6 vs v9b on the same 60 functions (v6 stays default)", (t) => {
  const V9 = join(DIR, "expensify-app-0.86.0.recording.idmatch.v9b.json");
  if (!existsSync(LABELS) || !existsSync(RECORDING) || !existsSync(NAMEABLE) || !existsSync(V9)) return t.skip("needs the expensify labels, recordings and nameable map");
  const s = JSON.parse(readFileSync(LABELS, "utf8")) as LabelledSample;
  const nameable = JSON.parse(readFileSync(NAMEABLE, "utf8")) as NameableMap;
  const arm = (path: string) => {
    const rec = JSON.parse(readFileSync(path, "utf8")) as Recording;
    const props = proposalsForLabels(s, recordedNames(rec));
    const tier = (c: string) => rateHighConfidence(s, new Map([...props].filter(([, p]) => p.confidence === c))).all;
    return { named: recordingStats(rec, nameable).named, high: tier("high"), low: tier("low") };
  };
  const v6 = arm(RECORDING);
  const v9 = arm(V9);
  assert.deepEqual([v6.named, v9.named], [411, 393], "coverage 96.9% vs 92.7% of 424 (the failing leg)");
  assert.deepEqual([v6.high.lenient, v6.high.n, v9.high.lenient, v9.high.n], [14, 15, 14, 18]);
  assert.deepEqual([v6.low.lenient, v6.low.n, v9.low.lenient, v9.low.n], [3, 25, 6, 25]);
});
