// The rn-template bundle (a plain template, no redux at all) is the FAST
// honest-empty path plus the CLI wiring; the synthetic fixture is the one
// test of the tool's actual matching logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import { cachedSplitProject as splitProject } from "../../support/decompiled.ts";
import { splitProject as splitProjectFresh } from "../../../src/split/index.ts";
import { writeArtifact } from "../../../src/artifact/write.ts";
import { ArtifactService } from "../../../src/artifact/service.ts";
import { actions, ACTIONS_NOTE } from "../../../src/artifact/actions.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const rnBytes = readFileSync(RN_TEMPLATE);
const rnSplit = splitProject(rnBytes, { moduleName: "index.android.hbc" });
const rnOutDir = mkdtempSync(join(tmpdir(), "hbc2js-actions-rn-"));
writeArtifact({ bytes: rnBytes, splitResult: rnSplit, outDir: rnOutDir, passes: {}, strictEnv: false, form: "flat" });
const rnSvc = new ArtifactService(rnOutDir);

test.after(() => rmSync(rnOutDir, { recursive: true, force: true }));

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const RN_TEMPLATE_FALSE_POSITIVES = ["BYTECODE", "FRAME", "INTERNAL_BYTECODE", "NATIVE", "SKIPPED", "SOURCE"];

test("actions: rn-template (no redux/flux code at all) still reports 6 rows -- all false positives from Hermes's own stack-symbolication shim, never proof of a real action", () => {
  const result = actions(rnSvc);
  assert.equal(result.totalActions, RN_TEMPLATE_FALSE_POSITIVES.length);
  assert.deepEqual(result.actions.map((a) => a.value).sort(), [...RN_TEMPLATE_FALSE_POSITIVES].sort());
  assert.equal(result.truncatedActions, false);
  assert.equal(result.note, ACTIONS_NOTE);
  // Every one resolves to the SAME single creator function -- one frame-kind
  // classifier, not six independent action creators.
  const creatorFns = new Set(result.actions.map((a) => a.creator?.fn));
  assert.equal(creatorFns.size, 1);
});

test("actions CLI: --help prints usage and exits 0", () => {
  const { status, stdout } = runCli(["actions", "--help"]);
  assert.equal(status, 0);
  assert.match(stdout, /hbc2js actions --artifact <dir>/);
});

test("actions CLI: missing --artifact is E_USAGE, exit 2, never a silent no-op", () => {
  const { status, stderr } = runCli(["actions"]);
  assert.equal(status, 2);
  assert.match(stderr, /E_USAGE/);
  assert.match(stderr, /actions --artifact/);
});

test("actions CLI: --json is valid JSON, carries the note, exit 0 (rn-template's own 6 false-positive rows -- see the test above)", () => {
  const { status, stdout } = runCli(["actions", "--artifact", rnOutDir, "--json"]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as ReturnType<typeof actions>;
  assert.equal(parsed.totalActions, RN_TEMPLATE_FALSE_POSITIVES.length);
  assert.equal(parsed.note, ACTIONS_NOTE);
});

test("actions CLI: human output carries the heuristic note and the row count", () => {
  const { status, stdout } = runCli(["actions", "--artifact", rnOutDir]);
  assert.equal(status, 0);
  assert.match(stdout, /note: heuristic recovery, not proof/);
  assert.match(stdout, new RegExp(`actions \\(${RN_TEMPLATE_FALSE_POSITIVES.length}\\):`));
});

// --- the synthetic fixture: the one real test of the matching logic -------

const FIXTURE_SOURCE = join(repoRoot(), "tests", "fixtures", "tooling", "actions", "source.js");

function buildSyntheticArtifact(t: import("node:test").TestContext): ArtifactService | null {
  const hermesc = findHermesc(99);
  if (hermesc === null) {
    t.skip("hermesc v99 not found (run tools/get-hermesc.sh 99)");
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-actions-synth-src-"));
  const source = readFileSync(FIXTURE_SOURCE, "utf8");
  writeFileSync(join(dir, "source.js"), source, "utf8");
  const outPath = join(dir, "source.hbc");
  const r = runHermesc(hermesc, ["-O", "-emit-binary", `-out=${outPath}`, "source.js"], dir);
  assert.equal(r.status, 0, `hermesc failed: ${r.stderr}`);
  const bytes = readFileSync(outPath);
  const sr = splitProjectFresh(bytes, {});
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-actions-synth-artifact-"));
  writeArtifact({ bytes, splitResult: sr, outDir, passes: {}, strictEnv: false, form: "flat" });
  rmSync(dir, { recursive: true, force: true });
  return new ArtifactService(outDir);
}

void test("actions (synthetic fixture, precision against its own assumptions -- see file header): matches the shapes the fixture was written to exercise", (t) => {
  const svc = buildSyntheticArtifact(t);
  if (svc === null) return;

  const result = actions(svc, { all: true });

  const byValue = new Map(result.actions.map((a) => [a.value, a]));

  // UNRELATED_CONSTANT never co-occurs with a type-key/type-get/dispatch-get
  // signal anywhere -- proves this is not a bundle-wide grep for the naming
  // convention alone.
  assert.equal(byValue.has("UNRELATED_CONSTANT"), false);

  const inc = byValue.get("INCREMENT");
  assert.ok(inc !== undefined, "expected an INCREMENT row");
  // increment() and dispatchIncrement() both build {type: 'INCREMENT'} --
  // ambiguous creator, never guessed.
  assert.equal(inc!.creator, null);
  assert.equal(inc!.creatorCandidates.length, 2);
  assert.match(inc!.creatorNote, /ambiguous: 2/);
  assert.equal(inc!.reducers.length, 1, "counterReducer reads action.type and mentions INCREMENT");
  assert.equal(inc!.dispatchSites.length, 1, "dispatchIncrement reads .dispatch and mentions INCREMENT");

  const dec = byValue.get("DECREMENT");
  assert.ok(dec !== undefined, "expected a DECREMENT row");
  // decrement() is the ONLY function that builds {type: 'DECREMENT'} --
  // unambiguous creator.
  assert.ok(dec!.creator !== null, "expected an unambiguous DECREMENT creator");
  assert.equal(dec!.creatorCandidates.length, 0);
  assert.equal(dec!.reducers.length, 1);
  assert.equal(dec!.dispatchSites.length, 0, "no function reads .dispatch and mentions DECREMENT");

  // Every row's evidence is one of the three documented, always-weak tiers
  // -- never a bare boolean/guess with no explanation.
  for (const row of result.actions) {
    if (row.creator !== null) assert.equal(row.creator.evidence, "type-write-cooccurrence");
    for (const c of row.creatorCandidates) assert.equal(c.evidence, "type-write-cooccurrence");
    for (const r of row.reducers) assert.equal(r.evidence, "type-get-cooccurrence");
    for (const d of row.dispatchSites) assert.equal(d.evidence, "dispatch-name-cooccurrence");
  }
});
