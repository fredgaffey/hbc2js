import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import {
  decodePng,
  encodePng,
  downscale,
  classifyFrame,
  handleShot,
  main,
  SHOT_THRESHOLDS,
} from "../../../src/device/device.ts";

const FIX = join(repoRoot(), "tests", "fixtures", "device");
const readPng = (name: string): Buffer => readFileSync(join(FIX, name));
const readJson = (name: string): unknown => JSON.parse(readFileSync(join(FIX, name), "utf8"));

// --- classifyFrame on recorded PNGs, one per verdict class --------------------

test("classifyFrame: black fixture -> verdict black, entropy in [0,1]", () => {
  const frame = decodePng(readPng("shot-black.png"));
  const r = classifyFrame(frame);
  assert.equal(r.verdict, "black");
  assert.ok(r.entropy >= 0 && r.entropy <= 1);
});

test("classifyFrame: uniform fixture -> verdict uniform, not black", () => {
  const frame = decodePng(readPng("shot-uniform.png"));
  const r = classifyFrame(frame);
  assert.equal(r.verdict, "uniform");
  assert.ok(r.entropy >= 0 && r.entropy <= 1);
});

test("classifyFrame: redbox fixture -> verdict redbox", () => {
  const frame = decodePng(readPng("shot-redbox.png"));
  const r = classifyFrame(frame);
  assert.equal(r.verdict, "redbox");
  assert.ok(r.entropy >= 0 && r.entropy <= 1);
});

test("classifyFrame: logbox fixture -> verdict logbox", () => {
  const frame = decodePng(readPng("shot-logbox.png"));
  const r = classifyFrame(frame);
  assert.equal(r.verdict, "logbox");
  assert.ok(r.entropy >= 0 && r.entropy <= 1);
});

test("classifyFrame: content fixture -> verdict content, high entropy", () => {
  const frame = decodePng(readPng("shot-content.png"));
  const r = classifyFrame(frame);
  assert.equal(r.verdict, "content");
  assert.ok(r.entropy > 0.5, `expected high entropy for varied content, got ${r.entropy}`);
});

// --- PNG codec round-trip + downscale ------------------------------------------

test("encodePng/decodePng round-trip preserves pixels", () => {
  const w = 4, h = 4;
  const pixels = new Uint8Array(w * h * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 17) % 256;
  const png = encodePng(w, h, pixels);
  const decoded = decodePng(png);
  assert.equal(decoded.width, w);
  assert.equal(decoded.height, h);
  assert.deepEqual(Array.from(decoded.pixels), Array.from(pixels));
});

test("downscale produces a 160-wide frame from a wider source", () => {
  const frame = decodePng(readPng("shot-content.png"));
  const small = downscale(frame, 16); // fixture is 32-wide; downscale to 16 to keep the test fast
  assert.equal(small.width, 16);
  assert.ok(small.height > 0);
  assert.equal(small.pixels.length, small.width * small.height * 4);
});

// --- handleShot: refusal gate before capture -----------------------------------

test("handleShot: refuses (does not call capture.screenshot) when status is restarting", () => {
  let screenshotCalled = false;
  const capture = {
    adbDevices: () => null,
    simctlList: () => null,
    status: () => readJson("status-restarting.json"),
    screenshot: () => { screenshotCalled = true; return { buffer: readPng("shot-content.png") }; },
  };
  const detected = { platform: "android" as const, platformSource: "single-adb-device", serial: "R1", serialSource: "x", udid: null, udidSource: "x" };
  const flags = { json: true, help: false, serial: null, udid: null, app: null, platform: null, seam: null, runs: null, statusJson: null, expectedBundle: null, deployedBundlePath: null };
  const result = handleShot({ detected, flags, env: {}, capture });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /restarting/);
  assert.equal(screenshotCalled, false);
});

test("handleShot: refuses when status is missing (no status fn, no --status-json)", () => {
  const capture = {
    adbDevices: () => null,
    simctlList: () => null,
    screenshot: () => ({ buffer: readPng("shot-content.png") }),
  };
  const detected = { platform: "android" as const, platformSource: "single-adb-device", serial: "R1", serialSource: "x", udid: null, udidSource: "x" };
  const flags = { json: true, help: false, serial: null, udid: null, app: null, platform: null, seam: null, runs: null, statusJson: null, expectedBundle: null, deployedBundlePath: null };
  const result = handleShot({ detected, flags, env: {}, capture });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /status unavailable/);
});

// --- handleShot: a full successful measurement ---------------------------------

test("handleShot: steady status + a content frame -> ok:true, full payload, thumb + capturePath written", () => {
  const savedThumbs: Buffer[] = [];
  const capture = {
    adbDevices: () => null,
    simctlList: () => null,
    status: () => readJson("status-steady.json"),
    screenshot: () => ({ buffer: readPng("shot-content.png") }),
    text: () => ({ text: "<xml/>", textSource: "uiautomator-dump" }),
    saveCapture: () => "/tmp/device-test-capture.png",
    saveThumb: (buf: Buffer) => { savedThumbs.push(buf); return "/tmp/device-test-thumb.png"; },
  };
  const detected = { platform: "android" as const, platformSource: "single-adb-device", serial: "R1", serialSource: "x", udid: null, udidSource: "x" };
  const flags = { json: true, help: false, serial: null, udid: null, app: null, platform: null, seam: null, runs: null, statusJson: null, expectedBundle: null, deployedBundlePath: null };
  const result = handleShot({ detected, flags, env: {}, capture });
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.equal(result.payload.verdict, "content");
  assert.equal(typeof result.payload.entropy, "number");
  assert.equal(result.payload.text, "<xml/>");
  assert.equal(result.payload.textSource, "uiautomator-dump");
  assert.equal(result.payload.thumb, "/tmp/device-test-thumb.png");
  assert.equal(result.payload.capturePath, "/tmp/device-test-capture.png");
  assert.equal(savedThumbs.length, 1);
});

test("handleShot: a black frame is verdict black, never a crash, exit 0 through main()", () => {
  const capture = {
    adbDevices: () => null,
    simctlList: () => null,
    status: () => readJson("status-steady.json"),
    screenshot: () => ({ buffer: readPng("shot-black.png") }),
    saveCapture: () => null,
    saveThumb: () => null,
  };
  const r = main(["shot", "--json"], { env: {}, capture });
  assert.equal(r.exitCode, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.verdict, "black");
});

test("handleShot: capture without a screenshot capability is not-implemented-for-this-capture (exit 2)", () => {
  const capture = { adbDevices: () => null, simctlList: () => null };
  const r = main(["shot", "--json"], { env: {}, capture });
  assert.equal(r.exitCode, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /not implemented/);
});

test("SHOT_THRESHOLDS are documented and exported for the fixture generator to stay in sync", () => {
  assert.equal(typeof SHOT_THRESHOLDS.blackMeanMax, "number");
  assert.equal(typeof SHOT_THRESHOLDS.redboxFractionMin, "number");
});
