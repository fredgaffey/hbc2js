import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import {
  parseEtime,
  parseProcessInfo,
  parseLockInfo,
  parseSha256sumOutput,
  parseSeamFile,
  deriveRestarting,
  deriveBundleMatch,
  computeStartTime,
  computeExpectedBundleSha,
  readSeamFile,
  handleStatus,
  main,
  RESTARTING_WINDOW_SECONDS,
} from "../../../src/device/device.ts";

const FIX = join(repoRoot(), "tests", "fixtures", "device");
const read = (name: string): string => readFileSync(join(FIX, name), "utf8");
const path = (name: string): string => join(FIX, name);

const baseFlags = {
  json: true, help: false, serial: null, udid: null, app: null,
  platform: null, seam: null, runs: null, statusJson: null,
} as any;
const detectedAndroid = {
  platform: "android" as const, platformSource: "single-adb-device",
  serial: "R1", serialSource: "x", udid: null, udidSource: "x",
};

// --- pure: parseEtime -----------------------------------------------------------

test("parseEtime: bare seconds, MM:SS, HH:MM:SS, DD-HH:MM:SS", () => {
  assert.equal(parseEtime("45"), 45);
  assert.equal(parseEtime("01:05"), 65);
  assert.equal(parseEtime("00:00:45"), 45);
  assert.equal(parseEtime("01-00:00:00"), 86400);
  assert.equal(parseEtime("2-01:00:00"), 2 * 86400 + 3600);
  assert.equal(parseEtime("not-a-time"), null);
  assert.equal(parseEtime(null), null);
});

// --- pure: parseProcessInfo ------------------------------------------------------

test("parseProcessInfo: a steady process line -> pid + etimeSeconds", () => {
  const r = parseProcessInfo(read("ps-steady.txt"));
  assert.deepEqual(r, { pid: 20481, etimeSeconds: 45 });
});

test("parseProcessInfo: a just-started process line -> small etimeSeconds", () => {
  const r = parseProcessInfo(read("ps-restarting.txt"));
  assert.deepEqual(r, { pid: 20999, etimeSeconds: 3 });
});

test("parseProcessInfo: empty text -> pid null, etimeSeconds null", () => {
  const r = parseProcessInfo(read("ps-empty.txt"));
  assert.deepEqual(r, { pid: null, etimeSeconds: null });
  assert.deepEqual(parseProcessInfo(null), { pid: null, etimeSeconds: null });
});

// --- pure: parseLockInfo ----------------------------------------------------------

test("parseLockInfo: dumpsys window excerpt with mDreamingLockscreen=true -> locked true", () => {
  const r = parseLockInfo(read("dumpsys-window-locked.txt"));
  assert.deepEqual(r, { locked: true, lockedSource: "dumpsys-window-mDreamingLockscreen" });
});

test("parseLockInfo: dumpsys window excerpt with mDreamingLockscreen=false -> locked false", () => {
  const r = parseLockInfo(read("dumpsys-window-unlocked.txt"));
  assert.deepEqual(r, { locked: false, lockedSource: "dumpsys-window-mDreamingLockscreen" });
});

test("parseLockInfo: no text (not captured, e.g. iOS) -> null + lock-not-captured", () => {
  assert.deepEqual(parseLockInfo(null), { locked: null, lockedSource: "lock-not-captured" });
});

test("parseLockInfo: text with no recognisable lock line -> null + lock-state-not-found", () => {
  assert.deepEqual(parseLockInfo("some unrelated dumpsys output\n"), { locked: null, lockedSource: "lock-state-not-found" });
});

// --- pure: parseSha256sumOutput ----------------------------------------------------

test("parseSha256sumOutput: a recorded sha256sum line -> the hex sha", () => {
  const r = parseSha256sumOutput(read("sha256sum-deployed-match.txt"));
  assert.equal(r.sha, "c0760be405210ba46d92ada2a30dfd4a81ac68d66df2663e3483ad47d1483f6b");
  assert.equal(r.shaSource, "sha256sum-output");
});

test("parseSha256sumOutput: unparseable text -> null + source", () => {
  const r = parseSha256sumOutput("no such file\n");
  assert.equal(r.sha, null);
  assert.equal(r.shaSource, "sha256sum-output-unparseable");
});

test("parseSha256sumOutput: null text -> null + not-captured", () => {
  const r = parseSha256sumOutput(null);
  assert.equal(r.sha, null);
  assert.equal(r.shaSource, "sha-not-captured");
});

// --- pure: parseSeamFile ------------------------------------------------------------

test("parseSeamFile: full seam JSON -> mode/seed/env from seam-file", () => {
  const r = parseSeamFile(read("seam-full.json"));
  assert.deepEqual(r, {
    mode: "e2e", modeSource: "seam-file",
    seed: "1234", seedSource: "seam-file",
    env: "staging", envSource: "seam-file",
  });
});

test("parseSeamFile: seam JSON missing seed/env -> those two null + seam-file-missing-field", () => {
  const r = parseSeamFile(read("seam-missing-fields.json"));
  assert.equal(r.mode, "e2e");
  assert.equal(r.modeSource, "seam-file");
  assert.equal(r.seed, null);
  assert.equal(r.seedSource, "seam-file-missing-field");
  assert.equal(r.env, null);
  assert.equal(r.envSource, "seam-file-missing-field");
});

test("parseSeamFile: null/invalid text -> all three null + seam-file-unparseable", () => {
  const r = parseSeamFile("not json{{");
  assert.equal(r.mode, null);
  assert.equal(r.modeSource, "seam-file-unparseable");
  assert.equal(r.seed, null);
  assert.equal(r.env, null);
});

test("readSeamFile: no path -> all null + seam-file-absent", () => {
  const r = readSeamFile(null);
  assert.equal(r.mode, null);
  assert.equal(r.modeSource, "seam-file-absent");
});

test("readSeamFile: a real fixture path reads and parses it", () => {
  const r = readSeamFile(path("seam-full.json"));
  assert.equal(r.mode, "e2e");
  assert.equal(r.seed, "1234");
  assert.equal(r.env, "staging");
});

// --- pure: deriveRestarting ----------------------------------------------------------

test("deriveRestarting: no pid -> restarting true, no-pid-yet", () => {
  const r = deriveRestarting(null, null);
  assert.equal(r.restarting, true);
  assert.equal(r.restartingSource, "no-pid-yet");
});

test("deriveRestarting: pid present but etime unavailable -> null (never a false negative)", () => {
  const r = deriveRestarting(1234, null);
  assert.equal(r.restarting, null);
  assert.equal(r.restartingSource, "etime-unavailable");
});

test(`deriveRestarting: etime < ${RESTARTING_WINDOW_SECONDS}s -> restarting true`, () => {
  const r = deriveRestarting(1234, 3);
  assert.equal(r.restarting, true);
  assert.match(r.restartingSource, /pid-age-3s/);
});

test(`deriveRestarting: etime >= ${RESTARTING_WINDOW_SECONDS}s -> restarting false`, () => {
  const r = deriveRestarting(1234, 45);
  assert.equal(r.restarting, false);
  assert.match(r.restartingSource, /pid-stable-45s/);
});

// --- pure: computeStartTime -----------------------------------------------------------

test("computeStartTime: subtracts etimeSeconds from an injected now", () => {
  const now = Date.parse("2026-09-20T10:00:00.000Z");
  assert.equal(computeStartTime(45, now), "2026-09-20T09:59:15.000Z");
});

test("computeStartTime: null etime -> null", () => {
  assert.equal(computeStartTime(null, Date.now()), null);
});

// --- pure: deriveBundleMatch -----------------------------------------------------------

test("deriveBundleMatch: equal shas -> true", () => {
  const r = deriveBundleMatch("abc", "abc");
  assert.deepEqual(r, { bundleMatches: true, bundleMatchesSource: "compared" });
});

test("deriveBundleMatch: different shas -> false (stale bundle)", () => {
  const r = deriveBundleMatch("abc", "def");
  assert.deepEqual(r, { bundleMatches: false, bundleMatchesSource: "compared" });
});

test("deriveBundleMatch: deployed sha unavailable -> null + no-deployed-sha", () => {
  const r = deriveBundleMatch(null, "def");
  assert.deepEqual(r, { bundleMatches: null, bundleMatchesSource: "no-deployed-sha" });
});

test("deriveBundleMatch: expected sha unavailable -> null + no-expected-sha", () => {
  const r = deriveBundleMatch("abc", null);
  assert.deepEqual(r, { bundleMatches: null, bundleMatchesSource: "no-expected-sha" });
});

// --- computeExpectedBundleSha (reads a local path directly; deterministic) -------------

test("computeExpectedBundleSha: hashes a real local fixture file", () => {
  const r = computeExpectedBundleSha(path("expected-bundle.js"));
  assert.equal(r.expectedBundleSha, "c0760be405210ba46d92ada2a30dfd4a81ac68d66df2663e3483ad47d1483f6b");
  assert.equal(r.expectedBundleShaSource, "local-file-sha256");
});

test("computeExpectedBundleSha: no path -> null + no-expected-bundle-flag", () => {
  const r = computeExpectedBundleSha(null);
  assert.deepEqual(r, { expectedBundleSha: null, expectedBundleShaSource: "no-expected-bundle-flag" });
});

test("computeExpectedBundleSha: a missing file -> null + a read-failure source", () => {
  const r = computeExpectedBundleSha(path("does-not-exist.js"));
  assert.equal(r.expectedBundleSha, null);
  assert.match(r.expectedBundleShaSource, /expected-bundle-read-failed/);
});

// --- handleStatus: full integration over recorded fixtures ------------------------------

function fixtureCapture(overrides: Record<string, unknown> = {}) {
  return {
    adbDevices: () => null,
    simctlList: () => null,
    lock: () => read("dumpsys-window-unlocked.txt"),
    process: () => read("ps-steady.txt"),
    deployedBundleSha: () => read("sha256sum-deployed-match.txt"),
    ...overrides,
  };
}

test("handleStatus: steady app, unlocked, matching bundle -> ok:true, every field populated", () => {
  const flags = { ...baseFlags, seam: path("seam-full.json"), expectedBundle: path("expected-bundle.js") };
  const r = handleStatus({ detected: detectedAndroid, flags, env: {}, capture: fixtureCapture() });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
  assert.equal(r.payload.locked, false);
  assert.equal(r.payload.pid, 20481);
  assert.equal(r.payload.pidSource, "process-list");
  assert.match(r.payload.startTime as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(r.payload.restarting, false);
  assert.equal(r.payload.bundleSha, "c0760be405210ba46d92ada2a30dfd4a81ac68d66df2663e3483ad47d1483f6b");
  assert.equal(r.payload.expectedBundleSha, "c0760be405210ba46d92ada2a30dfd4a81ac68d66df2663e3483ad47d1483f6b");
  assert.equal(r.payload.bundleMatches, true);
  assert.equal(r.payload.mode, "e2e");
  assert.equal(r.payload.seed, "1234");
  assert.equal(r.payload.env, "staging");
});

test("handleStatus: a stale deployed bundle -> bundleMatches false, still ok:true (exit 0 contract)", () => {
  const flags = { ...baseFlags, seam: path("seam-full.json"), expectedBundle: path("expected-bundle.js") };
  const capture = fixtureCapture({ deployedBundleSha: () => read("sha256sum-deployed-stale.txt") });
  const r = handleStatus({ detected: detectedAndroid, flags, env: {}, capture });
  assert.equal(r.ok, true);
  assert.equal(r.payload.bundleMatches, false);
  assert.equal(r.payload.bundleMatchesSource, "compared");
});

test("handleStatus: a locked device -> locked:true, still ok:true", () => {
  const flags = { ...baseFlags, seam: path("seam-full.json") };
  const capture = fixtureCapture({ lock: () => read("dumpsys-window-locked.txt") });
  const r = handleStatus({ detected: detectedAndroid, flags, env: {}, capture });
  assert.equal(r.ok, true);
  assert.equal(r.payload.locked, true);
});

test("handleStatus: a restarting app (just-started pid) -> restarting true", () => {
  const flags = { ...baseFlags, seam: path("seam-full.json") };
  const capture = fixtureCapture({ process: () => read("ps-restarting.txt") });
  const r = handleStatus({ detected: detectedAndroid, flags, env: {}, capture });
  assert.equal(r.ok, true);
  assert.equal(r.payload.pid, 20999);
  assert.equal(r.payload.restarting, true);
});

test("handleStatus: no pid at all -> restarting true, pid/startTime null + sources", () => {
  const flags = { ...baseFlags, seam: path("seam-full.json") };
  const capture = fixtureCapture({ process: () => read("ps-empty.txt") });
  const r = handleStatus({ detected: detectedAndroid, flags, env: {}, capture });
  assert.equal(r.ok, true);
  assert.equal(r.payload.pid, null);
  assert.equal(r.payload.pidSource, "no-process-found");
  assert.equal(r.payload.startTime, null);
  assert.equal(r.payload.startTimeSource, "no-pid");
  assert.equal(r.payload.restarting, true);
  assert.equal(r.payload.restartingSource, "no-pid-yet");
});

test("handleStatus: missing-field case -- no seam, no process, no bundle capture -> every optional field null + *Source, still ok:true", () => {
  const flags = { ...baseFlags };
  const capture = { adbDevices: () => null, simctlList: () => null };
  const r = handleStatus({ detected: detectedAndroid, flags, env: {}, capture });
  assert.equal(r.ok, true);
  assert.equal(r.payload.locked, null);
  assert.equal(r.payload.lockedSource, "not-captured");
  assert.equal(r.payload.pid, null);
  assert.equal(r.payload.pidSource, "not-captured");
  assert.equal(r.payload.bundleSha, null);
  assert.equal(r.payload.bundleShaSource, "not-captured");
  assert.equal(r.payload.expectedBundleSha, null);
  assert.equal(r.payload.expectedBundleShaSource, "no-expected-bundle-flag");
  assert.equal(r.payload.bundleMatches, null);
  assert.equal(r.payload.mode, null);
  assert.equal(r.payload.modeSource, "seam-file-absent");
});

// --- main(): status dispatch, envelope + exit code -----------------------------------

test("main: status --json wires handleStatus, exits 0, envelope has schema/subcommand/platform", () => {
  const capture = {
    adbDevices: () => read("adb-devices-one.txt"),
    simctlList: () => null,
    lock: () => read("dumpsys-window-unlocked.txt"),
    process: () => read("ps-steady.txt"),
    deployedBundleSha: () => read("sha256sum-deployed-match.txt"),
  };
  const r = main(["status", "--json", "--seam", path("seam-full.json"), "--expected-bundle", path("expected-bundle.js")], { env: {}, capture });
  assert.equal(r.exitCode, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.schema, "device/1");
  assert.equal(parsed.tool, "device");
  assert.equal(parsed.subcommand, "status");
  assert.equal(parsed.platform, "android");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.bundleMatches, true);
  assert.equal(parsed.restarting, false);
});

// --- shot's --status-json escape hatch still works unchanged (frozen contract) --------

test("main: shot --status-json still works unchanged now that status is real", () => {
  const statusPath = join(FIX, "status-steady.json");
  const capture = {
    adbDevices: () => null,
    simctlList: () => null,
    screenshot: () => ({ buffer: readFileSync(join(FIX, "shot-content.png")) }),
  };
  const r = main(["shot", "--json", "--status-json", statusPath], { env: {}, capture });
  assert.equal(r.exitCode, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.verdict, "content");
});
