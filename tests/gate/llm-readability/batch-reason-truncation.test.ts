// Readability batch (2026-11-09, held-out recording findings): function-level
// sampling, a REQUIRED abstain reason, truncated-reply retry, recording
// statistics, the section-7 wiring helper and the register-label tool.
// No network, no model: stub claude and canned recordings only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseReadabilityResult, ReferenceNameRater, highConfidenceAccuracy } from "../../../src/readability/types.ts";
import type { ClaudeCliBackendConfig, LabelledSample } from "../../../src/readability/types.ts";
import { ClaudeCliBackend } from "../../../src/workers/backends/claude-cli.ts";
import { recordedNames, recordingStats, proposalsForLabels } from "../../../src/readability/measure.ts";
import { sampleTargetsByFunction } from "../../../tools/readability/record.ts";
import { parseRaDump } from "../../../tools/readability/label-registers.ts";
import type { Recording } from "../../../src/workers/backends/replay.ts";

const STUB = join(repoRoot(), "tests", "support", "stub-claude.mjs");

test("abstain requires a reason: a bare abstention is a rejected reply, a reasoned one parses", () => {
  assert.equal(parseReadabilityResult('{"names":[],"abstained":true}').ok, false);
  assert.equal(parseReadabilityResult('{"names":[]}').ok, false);
  const ok = parseReadabilityResult('{"names":[],"abstained":true,"reason":"no literals, no named callees"}');
  assert.ok(ok.ok && ok.result.reason === "no literals, no named callees");
  // A non-abstaining answer needs no reason.
  const named = parseReadabilityResult(
    '{"names":[{"bindingId":{"fn":1,"reg":2},"name":"userId","confidence":"high","evidence":"param"}],"abstained":false}',
  );
  assert.ok(named.ok);
});

test("function-mode --sample N samples FUNCTIONS: every sampled function keeps all its registers", () => {
  const targets = [];
  for (let fn = 0; fn < 40; fn++) for (let reg = 0; reg < 5; reg++) targets.push({ fn, reg });
  const got = sampleTargetsByFunction(targets, 6, 1);
  const fns = new Set(got.map((t) => t.fn));
  assert.equal(fns.size, 6);
  assert.equal(got.length, 30, "5 registers per sampled function, not 1");
  assert.deepEqual(sampleTargetsByFunction(targets, 6, 1), got, "deterministic for a seed");
});

function cliConfig(cacheDir: string): ClaudeCliBackendConfig {
  return {
    model: "haiku",
    budgetTokens: 2000000,
    cacheDir,
    skillsDir: join(repoRoot(), "skills"),
    maxOutputTokens: 2048,
    claudeBin: STUB,
    timeoutMs: 10000,
  };
}

test("claude-cli: a max_tokens reply is retried ONCE with a bigger output cap", async () => {
  const prior = process.env["STUB_CLAUDE_TRUNCATE_BELOW"];
  process.env["STUB_CLAUDE_TRUNCATE_BELOW"] = "4000";
  try {
    const b = new ClaudeCliBackend(cliConfig(mkdtempSync(join(tmpdir(), "hbc2js-trunc-"))));
    const res = await b.run({ kind: "suggest-name", prompt: "", context: { fn: 1, targets: ["{1,2}"], source: "function f(){}" } });
    const parsed = parseReadabilityResult(res.text);
    assert.ok(parsed.ok, `retry should have produced complete JSON, got: ${res.text}`);
    assert.equal(parsed.ok && parsed.result.names.length, 1);
  } finally {
    if (prior === undefined) delete process.env["STUB_CLAUDE_TRUNCATE_BELOW"];
    else process.env["STUB_CLAUDE_TRUNCATE_BELOW"] = prior;
  }
});

const REPLY = (names: readonly [number, number, string, string][]): string =>
  JSON.stringify({
    names: names.map(([fn, reg, name, confidence]) => ({ bindingId: { fn, reg }, name, confidence, evidence: "e" })),
    abstained: names.length === 0,
    ...(names.length === 0 ? { reason: "no evidence" } : {}),
  });

const REC: Recording = {
  a: { text: REPLY([[1, 2, "userId", "high"], [1, 3, "token", "med"]]), meta: { fn: 1, requested: 4 } },
  b: { text: REPLY([]), meta: { fn: 2, requested: 3 } },
  c: { text: '{"names":[],"abstained":true}', meta: { fn: 3, requested: 1 } },
  d: { text: '{"names":[{"bindingId"', meta: { fn: 4, requested: 2 } },
  e: { text: REPLY([[9, 9, "legacy", "high"]]) },
};

test("recordingStats: coverage = named/requested over entries that record a request; abstain reasons and truncation counted", () => {
  const s = recordingStats(REC);
  assert.equal(s.requested, 10);
  assert.equal(s.named, 2);
  assert.equal(s.coverage, 0.2);
  assert.equal(s.abstainEntries, 2);
  assert.equal(s.abstainWithoutReason, 1);
  assert.equal(s.unparseable, 1);
  assert.equal(s.legacyEntries, 1);
  assert.deepEqual([...recordedNames(REC).keys()].sort(), ["1,2", "1,3", "9,9"]);
});

test("section 7 wiring: register labels with a binding are graded against the recording's high-confidence names", () => {
  const sample = {
    app: "x", bundle: "x", labelledBy: "t", labelSource: "t", ts: "t",
    targets: [
      { id: "r1", kind: "register", source: "/a.js", binding: { fn: 1, reg: 2 }, referenceName: "userId", alsoAccept: [], securityRelevant: false, note: "n" },
      { id: "r2", kind: "register", source: "/a.js", binding: { fn: 1, reg: 3 }, referenceName: "sessionToken", alsoAccept: [], securityRelevant: false, note: "n" },
    ],
  } as unknown as LabelledSample;
  const proposals = proposalsForLabels(sample, recordedNames(REC));
  assert.deepEqual([...proposals.keys()], ["r1", "r2"]);
  const acc = highConfidenceAccuracy(new ReferenceNameRater(), sample, proposals);
  assert.deepEqual(acc && { n: acc.n, rate: acc.rate }, { n: 1, rate: 1 }, "only the high-confidence proposal is graded");
});

test("label-registers: parseRaDump recovers param and environment-variable register names from hermesc -dump-ra", () => {
  const dump = `function outer(userId: any): object 
source location: [x.js:1:1 ... x.js:3:2)
%BB0:
  {r0}      %0 = HBCCreateFunctionEnvironmentInst (:environment) %VS0: any, %parentScope: environment
  {r1}      %4 = LoadParamInst (:any) %userId: any
  {r3}      %7 = HBCCallNInst (:any) {r1} %6: any
                 StoreFrameInst {r0} %0: environment, {r3} %7: any, [%VS0.sessionToken]: any
  {r5}      %9 = LoadFrameInst (:any) {r0} %0: environment, [%VS0.count]: any
function_end
`;
  const fns = parseRaDump(dump);
  assert.equal(fns.length, 1);
  assert.equal(fns[0]!.name, "outer");
  assert.deepEqual(
    fns[0]!.irLabels.map((l) => `${l.cls}${String(l.k)}:${l.name}:${l.via}`).sort(),
    ["r1:userId:param", "r3:sessionToken:env-store", "r5:count:env-load"],
  );
});

test("label-registers: live hermesc run on the iife-closures construct fixture labels the parameter of the named function expression", async (t) => {
  const { requireHermesc } = await import("../../support/hermesc.ts");
  const h = requireHermesc(t, 98);
  if (h === null) return;
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(h.path, ["-O", "-g", "-dump-ra", "-dump-source-location=loc", join(repoRoot(), "tests", "fixtures", "constructs", "21-iife-closures", "source.js")], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  const names = parseRaDump(r.stdout).flatMap((f) => f.irLabels.map((l) => l.name));
  assert.ok(names.includes("n"), `expected the parameter "n" among ${JSON.stringify([...new Set(names)])}`);
});
