// Fixture: rn-template's release build (index.android.hbc, 424 owned
// modules -- distinct from index.android.debug.hbc's 412, the agent notes
// "never mix up the two builds"). "AbortSignal" is a real property written
// once in module 126 (fn 1496, role property-put, n:2) and read once in
// module 95 (fn 1125, role property-get, n:1) -- found by scanning every
// sid with disjoint write/read module sets and a DIRECT eager dep edge
// (module 95's `deps` names module 126 `kind:"eager"`), pinned here so the
// test is a real assertion, not a smoke test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { cachedSplitProject as splitProject } from "../../support/decompiled.ts";
import { writeArtifact } from "../../../src/artifact/write.ts";
import { ArtifactService } from "../../../src/artifact/service.ts";
import { traceProp } from "../../../src/artifact/trace-prop.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
const outDir = mkdtempSync(join(tmpdir(), "hbc2js-trace-prop-"));
writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
const svc = new ArtifactService(outDir);

test.after(() => rmSync(outDir, { recursive: true, force: true }));

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("traceProp: AbortSignal is written in module 126 and read in module 95, writer ordered before reader", () => {
  const result = traceProp(svc, "AbortSignal");
  assert.equal(result.found, true);
  assert.equal(result.total, 2);
  assert.deepEqual(result.rows, [
    { module: 126, fn: 1496, kind: "write", n: 2 },
    { module: 95, fn: 1125, kind: "read", n: 1 },
  ]);
});

test("traceProp: --module filters to one module's own rows", () => {
  const result = traceProp(svc, "AbortSignal", { module: 126 });
  assert.equal(result.found, true);
  assert.deepEqual(result.rows, [{ module: 126, fn: 1496, kind: "write", n: 2 }]);
  assert.equal(result.total, 1);
});

test("traceProp: a property name that does not exist is an empty result, not an error", () => {
  const result = traceProp(svc, "hbc2js-definitely-not-a-real-property-xyz-H4");
  assert.equal(result.found, false);
  assert.deepEqual(result.rows, []);
  assert.equal(result.total, 0);
});

test("traceProp: the result always carries the index-query-not-dataflow note", () => {
  const result = traceProp(svc, "AbortSignal");
  assert.match(result.note, /index query/i);
  assert.match(result.note, /not.*dataflow|never.*prove/i);
});

test("CLI: trace-prop --json reports both rows and the index-query note", () => {
  const r = runCli(["trace-prop", "AbortSignal", "--artifact", outDir, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.found, true);
  assert.equal(parsed.total, 2);
  assert.match(parsed.note, /index query/i);
});

test("CLI: trace-prop human output prints the disclaimer in its own header, not only in docs", () => {
  const r = runCli(["trace-prop", "AbortSignal", "--artifact", outDir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /index query/i);
  assert.match(r.stdout, /not.*dataflow|never.*prove/i);
  assert.match(r.stdout, /m:126 fn:1496 write n:2/);
  assert.match(r.stdout, /m:95 fn:1125 read n:1/);
});

test("CLI: trace-prop on a nonexistent property prints a clear empty result and exits 0", () => {
  const r = runCli(["trace-prop", "hbc2js-definitely-not-a-real-property-xyz-H4", "--artifact", outDir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no string literal/i);
  // The claim is "this command says nothing on stderr for a clean miss", NOT
  // "stderr is byte-empty": the runtime writes its own warnings there and we
  // do not control them. Asserting emptiness made this pass on the dev Mac and
  // fail on the Linux gate box, whose node emits
  //   (node:410564) ExperimentalWarning: SQLite is an experimental feature ...
  //   (Use `node --trace-warnings ...` to show where the warning was created)
  // Strip the runtime's own `(node:PID)` warning lines and their indented
  // continuations, then assert nothing of OURS is left.
  const ours = r.stderr
    .split("\n")
    .filter((l) => !/^\(node:\d+\)/.test(l) && !/^\(Use `node --trace-warnings/.test(l))
    .join("")
    .trim();
  assert.equal(ours, "", `trace-prop wrote to stderr on a clean miss: ${JSON.stringify(r.stderr)}`);
});

test("CLI: trace-prop --module with an out-of-range module id is an actionable usage error, not a silent no-op", () => {
  const r = runCli(["trace-prop", "AbortSignal", "--artifact", outDir, "--module", "999999"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /E_USAGE/);
  assert.match(r.stderr, /999999/);
});

test("CLI: trace-prop with no --artifact is a usage error", () => {
  const r = runCli(["trace-prop", "AbortSignal"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /E_USAGE/);
});
