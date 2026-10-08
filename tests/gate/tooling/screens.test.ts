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
import { screens, SCREENS_NOTE } from "../../../src/artifact/screens.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
const outDir = mkdtempSync(join(tmpdir(), "hbc2js-screens-"));
writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
const svc = new ArtifactService(outDir);

test.after(() => rmSync(outDir, { recursive: true, force: true }));

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("screens: a plain template with no react-navigation finds nothing, honestly (not an error)", () => {
  const result = screens(svc);
  assert.deepEqual(result.navigators, []);
  assert.deepEqual(result.screens, []);
  assert.deepEqual(result.navigateSites, []);
  assert.equal(result.totalNavigators, 0);
  assert.equal(result.totalScreens, 0);
  assert.equal(result.totalNavigateSites, 0);
  assert.equal(result.truncatedScreens, false);
  assert.equal(result.note, SCREENS_NOTE);
});

test("screens CLI: --help prints usage and exits 0", () => {
  const { status, stdout } = runCli(["screens", "--help"]);
  assert.equal(status, 0);
  assert.match(stdout, /hbc2js screens --artifact <dir>/);
});

test("screens CLI: missing --artifact is E_USAGE, exit 2, never a silent no-op", () => {
  const { status, stderr } = runCli(["screens"]);
  assert.equal(status, 2);
  assert.match(stderr, /E_USAGE/);
  assert.match(stderr, /screens --artifact/);
});

test("screens CLI: --json on a bundle with no react-navigation is valid JSON, honestly empty, exit 0", () => {
  const { status, stdout } = runCli(["screens", "--artifact", outDir, "--json"]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as ReturnType<typeof screens>;
  assert.equal(parsed.totalNavigators, 0);
  assert.equal(parsed.totalScreens, 0);
  assert.equal(parsed.note, SCREENS_NOTE);
});

test("screens CLI: human output carries the heuristic-recovery note and zero counts", () => {
  const { status, stdout } = runCli(["screens", "--artifact", outDir]);
  assert.equal(status, 0);
  assert.match(stdout, /note: heuristic recovery, not proof/);
  assert.match(stdout, /navigators \(0\):/);
  assert.match(stdout, /screens \(0\):/);
  assert.match(stdout, /navigateSites \(0, weak evidence only\):/);
});
