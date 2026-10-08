import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import {
  parseTimingMarkers,
  medianOf,
  spreadOf,
  aggregateTimingRuns,
  handleTime,
  main,
  TIMING_MARKER_NAMES,
  DEFAULT_TIME_RUNS,
} from "../../../src/device/device.ts";

const FIX = join(repoRoot(), "tests", "fixtures", "device");
const read = (name: string): string => readFileSync(join(FIX, name), "utf8");
const path = (name: string): string => join(FIX, name);

const baseFlags = {
  json: true, help: false, serial: null, udid: null, app: null,
  platform: null, seam: null, runs: null, statusJson: null,
  expectedBundle: null, deployedBundlePath: null,
} as any;
const detectedAndroid = {
  platform: "android" as const, platformSource: "single-adb-device",
  serial: "R1", serialSource: "x", udid: null, udidSource: "x",
};

const ANDROID_RUNS = [
  read("device-time-logcat-run1.txt"),
  read("device-time-logcat-run2.txt"),
  read("device-time-logcat-run3-missing-interactive.txt"),
  read("device-time-logcat-run4.txt"),
  read("device-time-logcat-run5.txt"),
];

// --- pure: TIMING_MARKER_NAMES ---------------------------------------------------

test("TIMING_MARKER_NAMES: the three phases, in order", () => {
  assert.deepEqual(TIMING_MARKER_NAMES, ["launch", "firstContentCommit", "interactive"]);
});

// --- pure: parseTimingMarkers -----------------------------------------------------

test("parseTimingMarkers: a recorded logcat run with all three markers", () => {
  const r = parseTimingMarkers(ANDROID_RUNS[0]);
  assert.deepEqual(r, { launch: 800, firstContentCommit: 1200, interactive: 1800 });
});

test("parseTimingMarkers: a run missing the interactive marker -> interactive:null, never a fallback", () => {
  const r = parseTimingMarkers(ANDROID_RUNS[2]);
  assert.deepEqual(r, { launch: 900, firstContentCommit: 1400, interactive: null });
});

test("parseTimingMarkers: format-agnostic -- an os_log run parses the same way as logcat", () => {
  const r = parseTimingMarkers(read("device-time-oslog-run1.txt"));
  assert.deepEqual(r, { launch: 798, firstContentCommit: 1190, interactive: 1761 });
});

test("parseTimingMarkers: an os_log run missing the interactive marker -> interactive:null", () => {
  const r = parseTimingMarkers(read("device-time-oslog-run2-missing-interactive.txt"));
  assert.deepEqual(r, { launch: 812, firstContentCommit: 1230, interactive: null });
});

test("parseTimingMarkers: no markers at all -> all three null", () => {
  const r = parseTimingMarkers("nothing interesting here\n");
  assert.deepEqual(r, { launch: null, firstContentCommit: null, interactive: null });
});

// --- pure: medianOf / spreadOf -----------------------------------------------------

test("medianOf: odd count, even count, empty", () => {
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([1, 2, 3, 4]), 2.5);
  assert.equal(medianOf([]), null);
});

test("spreadOf: min-max range; single value is 0; empty is null", () => {
  assert.equal(spreadOf([780, 800, 820, 850, 900]), 120);
  assert.equal(spreadOf([42]), 0);
  assert.equal(spreadOf([]), null);
});

// --- pure: aggregateTimingRuns ------------------------------------------------------

test("aggregateTimingRuns: 5 runs, one missing interactive -> medians+spreads honest, interactive never backfilled", () => {
  const perRun = ANDROID_RUNS.map((text) => parseTimingMarkers(text));
  const agg = aggregateTimingRuns(perRun);
  assert.equal(agg.launch, 820);
  assert.equal(agg.launchSpread, 120);
  assert.equal(agg.launchSource, "median-of-5-of-5-runs");
  assert.equal(agg.firstContentCommit, 1250);
  assert.equal(agg.firstContentCommitSpread, 250);
  assert.equal(agg.firstContentCommitSource, "median-of-5-of-5-runs");
  assert.equal(agg.interactive, 1810);
  assert.equal(agg.interactiveSpread, 150);
  assert.equal(agg.interactiveSource, "median-of-4-of-5-runs");
  assert.equal(agg.perRun?.length, 5);
  assert.equal(agg.perRun?.[2]?.interactive, null);
});

test("aggregateTimingRuns: zero runs -> every field null, perRun null", () => {
  const agg = aggregateTimingRuns([]);
  assert.equal(agg.launch, null);
  assert.equal(agg.launchSpread, null);
  assert.equal(agg.launchSource, "no-runs-with-marker");
  assert.equal(agg.interactive, null);
  assert.equal(agg.perRun, null);
});

test("aggregateTimingRuns: a phase missing from every run -> null median, no-runs-with-marker", () => {
  const agg = aggregateTimingRuns([{ launch: null, firstContentCommit: 100, interactive: null }]);
  assert.equal(agg.launch, null);
  assert.equal(agg.launchSource, "no-runs-with-marker");
  assert.equal(agg.interactive, null);
  assert.equal(agg.interactiveSource, "no-runs-with-marker");
});

// --- handleTime: refusal-before-capture (spec §6, same predicate as shot) -----------

test("handleTime: refuses (no capture attempted) when status says restarting", () => {
  let called = false;
  const capture = {
    adbDevices: () => null,
    simctlList: () => null,
    coldLaunchRuns: () => { called = true; return ANDROID_RUNS; },
    status: () => JSON.parse(read("status-restarting.json")),
  };
  const r = handleTime({ detected: detectedAndroid, flags: baseFlags, env: {}, capture });
  assert.equal(r.ok, false);
  assert.match(r.reason as string, /restart/i);
  assert.equal(called, false);
});

test("handleTime: no coldLaunchRuns capability -> not-implemented-for-this-capture, exit-worthy reason", () => {
  const capture = { adbDevices: () => null, simctlList: () => null, status: () => JSON.parse(read("status-steady.json")) };
  const r = handleTime({ detected: detectedAndroid, flags: baseFlags, env: {}, capture });
  assert.equal(r.ok, false);
  assert.match(r.reason as string, /not implemented/);
});

test("handleTime: full success over 5 recorded runs -> runs + medians + spreads + perRun", () => {
  const capture = {
    adbDevices: () => null,
    simctlList: () => null,
    status: () => JSON.parse(read("status-steady.json")),
    coldLaunchRuns: (n: number) => { assert.equal(n, 5); return ANDROID_RUNS; },
  };
  const flags = { ...baseFlags, runs: 5 };
  const r = handleTime({ detected: detectedAndroid, flags, env: {}, capture });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
  assert.equal(r.payload.runs, 5);
  assert.equal(r.payload.launch, 820);
  assert.equal(r.payload.interactive, 1810);
  assert.equal(r.payload.interactiveSource, "median-of-4-of-5-runs");
  assert.equal((r.payload.perRun as unknown[]).length, 5);
});

test("handleTime: --runs omitted -> DEFAULT_TIME_RUNS is requested from capture.coldLaunchRuns", () => {
  const capture = {
    adbDevices: () => null,
    simctlList: () => null,
    status: () => JSON.parse(read("status-steady.json")),
    coldLaunchRuns: (n: number) => { assert.equal(n, DEFAULT_TIME_RUNS); return ANDROID_RUNS.slice(0, DEFAULT_TIME_RUNS); },
  };
  const r = handleTime({ detected: detectedAndroid, flags: baseFlags, env: {}, capture });
  assert.equal(r.ok, true);
  assert.equal(r.payload.runs, DEFAULT_TIME_RUNS);
});

test("handleTime: capture returns no runs -> ok:false, could-not-measure reason", () => {
  const capture = {
    adbDevices: () => null,
    simctlList: () => null,
    status: () => JSON.parse(read("status-steady.json")),
    coldLaunchRuns: () => [],
  };
  const r = handleTime({ detected: detectedAndroid, flags: baseFlags, env: {}, capture });
  assert.equal(r.ok, false);
  assert.match(r.reason as string, /capture failed/);
});

// --- main(): time dispatch, envelope, exit codes -------------------------------------

test("main: time --json wires handleTime, exits 0, envelope has schema/subcommand/platform + payload", () => {
  const capture = {
    adbDevices: () => read("adb-devices-one.txt"),
    simctlList: () => null,
    status: () => JSON.parse(read("status-steady.json")),
    coldLaunchRuns: () => ANDROID_RUNS,
  };
  const r = main(["time", "--json", "--runs", "5"], { env: {}, capture });
  assert.equal(r.exitCode, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.schema, "device/1");
  assert.equal(parsed.tool, "device");
  assert.equal(parsed.subcommand, "time");
  assert.equal(parsed.platform, "android");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.runs, 5);
  assert.equal(parsed.interactive, 1810);
  assert.equal(parsed.interactiveSource, "median-of-4-of-5-runs");
});

test("main: time refuses (exit 2) when --status-json says restarting", () => {
  const capture = {
    adbDevices: () => read("adb-devices-one.txt"),
    simctlList: () => null,
    coldLaunchRuns: () => ANDROID_RUNS,
  };
  const r = main(["time", "--json", "--status-json", path("status-restarting.json")], { env: {}, capture });
  assert.equal(r.exitCode, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason as string, /restart/i);
});
