import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseArgs, handleBurstShot, main, type Capture } from "../../../src/device/device.ts";

const FIX = join(repoRoot(), "tests", "fixtures", "device");
const readPng = (name: string): Buffer => readFileSync(join(FIX, name));
const readJson = (name: string): unknown => JSON.parse(readFileSync(join(FIX, name), "utf8"));

const detected = { platform: "android" as const, platformSource: "single-adb-device", serial: "R1", serialSource: "x", udid: null, udidSource: "x" };
const baseFlags = {
  json: true, help: false, serial: null, udid: null, app: null, platform: null,
  seam: null, runs: null, statusJson: null, expectedBundle: null, deployedBundlePath: null,
};

// --- parseArgs: actionable usage errors, never a silent no-op/clamp -----------

test("parseArgs: --burst non-numeric is an actionable error, burst stays null", () => {
  const { flags, errors } = parseArgs(["shot", "--burst", "abc", "--interval", "100"]);
  assert.equal(flags.burst, null);
  assert.ok(errors.some((e) => /--burst/.test(e) && /integer/.test(e)));
});

test("parseArgs: --burst 0 is out of range, not silently clamped to 1", () => {
  const { flags, errors } = parseArgs(["shot", "--burst", "0", "--interval", "100"]);
  assert.equal(flags.burst, null);
  assert.ok(errors.some((e) => /--burst/.test(e) && /between 1 and 500/.test(e)));
});

test("parseArgs: --burst 501 is out of range", () => {
  const { errors } = parseArgs(["shot", "--burst", "501", "--interval", "100"]);
  assert.ok(errors.some((e) => /--burst/.test(e)));
});

test("parseArgs: --interval -5 is rejected, not clamped to 0", () => {
  const { flags, errors } = parseArgs(["shot", "--burst", "3", "--interval", "-5"]);
  assert.equal(flags.interval, null);
  assert.ok(errors.some((e) => /--interval/.test(e) && /integer/.test(e)));
});

test("parseArgs: --burst without --interval is an actionable error", () => {
  const { errors } = parseArgs(["shot", "--burst", "3"]);
  assert.ok(errors.some((e) => /--interval/.test(e)));
});

test("parseArgs: --interval without --burst is an actionable error", () => {
  const { errors } = parseArgs(["shot", "--interval", "100"]);
  assert.ok(errors.some((e) => /--burst/.test(e)));
});

test("parseArgs: --burst/--interval on a non-shot subcommand is rejected", () => {
  const { errors } = parseArgs(["status", "--burst", "3", "--interval", "100"]);
  assert.ok(errors.some((e) => /only supported for 'device shot'/.test(e)));
});

test("parseArgs: valid --burst/--interval on shot parses cleanly", () => {
  const { flags, errors } = parseArgs(["shot", "--burst", "3", "--interval", "250"]);
  assert.equal(flags.burst, 3);
  assert.equal(flags.interval, 250);
  assert.deepEqual(errors, []);
});

test("main: a bad --burst is exit 2 with the flag named in stderr, never a silent no-op (the --function N bug's shape)", () => {
  const r = main(["shot", "--burst", "abc", "--interval", "100", "--json"], { env: {}, capture: { adbDevices: () => null, simctlList: () => null } });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /--burst/);
  assert.equal(r.stdout, "");
});

// --- handleBurstShot: refusal gate, once, before any frame --------------------

test("handleBurstShot: refuses (no frames captured) when status is restarting", () => {
  let calls = 0;
  const capture: Capture = {
    adbDevices: () => null, simctlList: () => null,
    status: () => readJson("status-restarting.json"),
    screenshot: () => { calls++; return { buffer: readPng("shot-content.png") }; },
  };
  const flags = { ...baseFlags, burst: 3, interval: 100 };
  const result = handleBurstShot({ detected, flags, env: {}, capture });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /restarting/);
  assert.equal(calls, 0);
});

// --- handleBurstShot: N frames, honest elapsed/drift accounting on a fake clock

function fakeClockCapture(captureDurations: number[]): { capture: Capture; clockLog: number[] } {
  let clock = 0;
  let frameIndex = 0;
  const clockLog: number[] = [];
  const capture: Capture = {
    adbDevices: () => null, simctlList: () => null,
    status: () => readJson("status-steady.json"),
    now: () => clock,
    sleep: (ms: number) => { clock += ms; },
    screenshot: () => {
      // Simulate the capture itself taking real time (the injected clock is
      // the only clock this test ever advances -- never a real wait).
      clock += captureDurations[frameIndex] ?? 0;
      clockLog.push(clock);
      frameIndex++;
      return { buffer: readPng("shot-content.png") };
    },
  };
  return { capture, clockLog };
}

test("handleBurstShot: N frames returned, one verdict + thumb each", () => {
  const { capture } = fakeClockCapture([10, 10, 10]);
  const flags = { ...baseFlags, burst: 3, interval: 100 };
  const result = handleBurstShot({ detected, flags, env: {}, capture });
  assert.equal(result.ok, true);
  const frames = result.payload.frames as Array<Record<string, unknown>>;
  assert.equal(frames.length, 3);
  for (const f of frames) {
    assert.equal(f.ok, true);
    assert.equal(f.verdict, "content");
  }
  assert.equal(result.payload.burst, 3);
  assert.equal(result.payload.intervalMs, 100);
});

test("handleBurstShot: fast captures -> elapsedMs reports the REQUESTED interval (capture time absorbed into the sleep)", () => {
  const { capture } = fakeClockCapture([5, 5, 5]);
  const flags = { ...baseFlags, burst: 3, interval: 100 };
  const result = handleBurstShot({ detected, flags, env: {}, capture });
  const frames = result.payload.frames as Array<Record<string, unknown>>;
  assert.equal(frames[0]?.elapsedMs, null);
  assert.equal(frames[0]?.elapsedMsSource, "first-frame");
  assert.equal(frames[1]?.elapsedMs, 100);
  assert.equal(frames[1]?.drifted, false);
  assert.equal(frames[2]?.elapsedMs, 100);
  assert.equal(frames[2]?.drifted, false);
});

test("handleBurstShot: a slow capture -> elapsedMs reports the REAL (larger) gap and drifted:true, never the requested interval", () => {
  // Frame 0's own capture takes 400ms against a 100ms requested interval:
  // frame 1 must start ~400ms after frame 0, not ~100ms, and must say so.
  const { capture } = fakeClockCapture([400, 5, 5]);
  const flags = { ...baseFlags, burst: 3, interval: 100 };
  const result = handleBurstShot({ detected, flags, env: {}, capture });
  const frames = result.payload.frames as Array<Record<string, unknown>>;
  assert.equal(frames[1]?.elapsedMs, 400);
  assert.equal(frames[1]?.drifted, true);
  assert.equal(frames[1]?.requestedIntervalMs, 100);
  // frame 0's own capture was slow but frame 1's capture is fast again, so
  // frame 2 should be back to the requested spacing.
  assert.equal(frames[2]?.elapsedMs, 100);
  assert.equal(frames[2]?.drifted, false);
});

test("handleBurstShot: a capture failure mid-burst is reported on that frame only; the burst still attempts every remaining frame", () => {
  let n = 0;
  const capture: Capture = {
    adbDevices: () => null, simctlList: () => null,
    status: () => readJson("status-steady.json"),
    now: () => 0, sleep: () => {},
    screenshot: () => {
      n++;
      if (n === 3) return null; // frame index 2 fails to produce a frame
      return { buffer: readPng("shot-content.png") };
    },
  };
  const flags = { ...baseFlags, burst: 5, interval: 10 };
  const result = handleBurstShot({ detected, flags, env: {}, capture });
  assert.equal(result.ok, true); // the burst as a whole still ran
  const frames = result.payload.frames as Array<Record<string, unknown>>;
  assert.equal(frames.length, 5);
  assert.equal(frames[2]?.ok, false);
  assert.match(String(frames[2]?.reason), /no frame produced/);
  assert.equal(n, 5); // every frame was still attempted, none skipped
  for (const i of [0, 1, 3, 4]) assert.equal(frames[i]?.ok, true);
});

test("handleBurstShot: no screenshot capability -> not-implemented, same reason shape as single-shot", () => {
  const capture: Capture = { adbDevices: () => null, simctlList: () => null };
  const flags = { ...baseFlags, burst: 3, interval: 100 };
  const result = handleBurstShot({ detected, flags, env: {}, capture });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /not implemented/);
});

// --- main() dispatch: --json envelope, and human-mode N verdict lines --------

test("main: shot --burst --json -> one envelope with a frames array of length N", () => {
  const { capture } = fakeClockCapture([5, 5, 5, 5]);
  const r = main(["shot", "--burst", "4", "--interval", "50", "--json"], { env: {}, capture });
  assert.equal(r.exitCode, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.frames.length, 4);
  assert.equal(parsed.burst, 4);
  assert.equal(parsed.intervalMs, 50);
});

test("main: shot --burst human mode prints exactly N frame lines", () => {
  const { capture } = fakeClockCapture([5, 5, 5]);
  const r = main(["shot", "--burst", "3", "--interval", "50"], { env: {}, capture });
  assert.equal(r.exitCode, 0);
  const frameLines = r.stdout.split("\n").filter((l) => l.startsWith("frame "));
  assert.equal(frameLines.length, 3);
});
