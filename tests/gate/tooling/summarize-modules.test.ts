import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { repoRoot } from "../../support/paths.ts";
import { computeSelfTimes, formatReport, loadArtifactIndex, packageFor, parseDump, summarizeModules } from "../../../tools/perf/summarize-modules.mjs";

const FIXTURES = join(repoRoot(), "tests", "fixtures", "tooling", "boot-timings");
const DUMP = join(FIXTURES, "dump.txt");
const INDEX = join(FIXTURES, "artifact-index.json");
const SCRIPT = join(repoRoot(), "tools", "perf", "summarize-modules.mjs");

test("parseDump: accepts marker-prefixed (incl. logcat-wrapped), bare-JSON, and skips noise/blank lines", () => {
  const records = parseDump(readFileSync(DUMP, "utf8"));
  const byId = new Map(records.map((r) => [r.id, r]));
  assert.equal(records.length, 5, "expected exactly the 5 well-formed records, noise/blank lines skipped");
  assert.deepEqual(byId.get(3), { id: 3, t0: 10, dt: 10 });
  assert.deepEqual(byId.get(2), { id: 2, t0: 5, dt: 40 });
  assert.deepEqual(byId.get(4), { id: 4, t0: 50, dt: 20 }, "bare JSON line (no marker) must parse too");
  assert.deepEqual(byId.get(5), { id: 5, t0: 75, dt: 5 });
  assert.deepEqual(byId.get(1), { id: 1, t0: 0, dt: 100 });
});

test("loadArtifactIndex / packageFor: named owner, app bucket, and a genuine join miss are three different outcomes", () => {
  const index = loadArtifactIndex(JSON.parse(readFileSync(INDEX, "utf8")));
  assert.equal(packageFor(index, 1), "app", "module 1 has no owner but IS in the index (bucket app) -- not a miss");
  assert.equal(packageFor(index, 2), "react-native");
  assert.equal(packageFor(index, 4), "lodash");
  assert.equal(packageFor(index, 999), "unknown", "an id absent from the index entirely is a genuine join miss");
});

test("computeSelfTimes: nested factory time is attributed to the innermost module, never double-counted", () => {
  const records = parseDump(readFileSync(DUMP, "utf8"));
  const selfById = computeSelfTimes(records);
  assert.equal(selfById.get(3), 10, "module 3 (leaf) keeps its whole dt");
  assert.equal(selfById.get(2), 30, "module 2's self time excludes module 3's nested 10ms (40 - 10)");
  assert.equal(selfById.get(4), 20);
  assert.equal(selfById.get(5), 5);
  assert.equal(selfById.get(1), 35, "module 1's self excludes modules 2, 4, 5's nested time (100 - 40 - 20 - 5)");
  const total = [...selfById.values()].reduce((a, b) => a + b, 0);
  assert.equal(total, 100, "self times must sum to the outermost (root) module's own total dt");
});

test("summarizeModules: top-N ordering by self time, with an unattributed id counted, never dropped", () => {
  const records = parseDump(readFileSync(DUMP, "utf8"));
  const index = loadArtifactIndex(JSON.parse(readFileSync(INDEX, "utf8")));
  const summary = summarizeModules(records, index, 3);
  assert.deepEqual(
    summary.top.map((r) => [r.id, r.package, r.selfMs]),
    [
      [1, "app", 35],
      [2, "react-native", 30],
      [4, "lodash", 20],
    ],
  );
  assert.equal(summary.moduleCount, 5, "all 5 timed modules must be counted, even outside the top-N");
  assert.equal(summary.unattributedModuleCount, 1, "module 5 (absent from the index) must be counted as unattributed");
  assert.equal(summary.unattributedSelfMs, 5);
  assert.equal(summary.totalMs, 100);

  const text = formatReport(summary);
  assert.match(text, /total self time: 100\.0 ms, 5 module\(s\) timed, 1 unattributed/);
  assert.match(text, /^self_ms\tid\tpackage\tpath$/m);
  assert.match(text, /35\.0\t1\tapp\t/);
  assert.doesNotMatch(text, /\t5\tunknown\t/, "module 5 is outside the top-3 and must not appear in the printed rows");
});

test("CLI: node tools/perf/summarize-modules.mjs <dump> <index> [topN] prints the same report", () => {
  const out = execFileSync(process.execPath, [SCRIPT, DUMP, INDEX, "3"], { encoding: "utf8" });
  const records = parseDump(readFileSync(DUMP, "utf8"));
  const index = loadArtifactIndex(JSON.parse(readFileSync(INDEX, "utf8")));
  const expected = formatReport(summarizeModules(records, index, 3));
  assert.equal(out.trim(), expected.trim());
});

test("CLI: missing arguments exits non-zero with a usage message", () => {
  assert.throws(() => execFileSync(process.execPath, [SCRIPT], { encoding: "utf8", stdio: "pipe" }));
});
