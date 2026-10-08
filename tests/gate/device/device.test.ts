// Every test feeds a RECORDED fixture through a pure function — no adb/simctl
// is ever run in the gate (spec §7). The one `main()` test injects a recorded
// capture, so no device is touched there either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "../../support/paths.ts";
import {
  parseAdbDevices,
  parseSimctlDevices,
  detectAndroidSerial,
  detectIosUdid,
  detectPlatform,
  refusalForStatus,
  makeEnvelope,
  main,
} from "../../../src/device/device.ts";

const FIX = join(repoRoot(), "tests", "fixtures", "device");
const CLI = join(repoRoot(), "src", "cli.ts");
const read = (name: string): string => readFileSync(join(FIX, name), "utf8");
const readJson = (name: string): unknown => JSON.parse(read(name));

// --- AC-P: platform detection --------------------------------------------------

test("parseAdbDevices keeps only the device rows, not the header", () => {
  const rows = parseAdbDevices(read("adb-devices-one.txt"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.serial, "FAKE0001");
  assert.equal(rows[0]?.state, "device");
});

test("parseSimctlDevices extracts udid + state for each simulator line", () => {
  const rows = parseSimctlDevices(read("simctl-list-booted.txt"));
  assert.equal(rows.length, 3);
  assert.ok(rows.some((r) => r.state === "Booted" && r.udid === "B2C3D4E5-2222-3333-4444-555566667777"));
});

test("detectAndroidSerial: one attached device -> that serial + single-adb-device", () => {
  const r = detectAndroidSerial(read("adb-devices-one.txt"));
  assert.deepEqual(r, { serial: "FAKE0001", serialSource: "single-adb-device" });
});

test("detectAndroidSerial: no attached device -> null + no-adb-device", () => {
  const r = detectAndroidSerial(read("adb-devices-none.txt"));
  assert.deepEqual(r, { serial: null, serialSource: "no-adb-device" });
});

test("detectAndroidSerial: two attached devices -> null + multiple-adb-devices", () => {
  const r = detectAndroidSerial(read("adb-devices-two.txt"));
  assert.deepEqual(r, { serial: null, serialSource: "multiple-adb-devices" });
});

test("detectIosUdid: one booted simulator -> that udid + single-booted-sim", () => {
  const r = detectIosUdid(read("simctl-list-booted.txt"));
  assert.deepEqual(r, { udid: "B2C3D4E5-2222-3333-4444-555566667777", udidSource: "single-booted-sim" });
});

test("detectIosUdid: no booted simulator -> null + no-booted-sim", () => {
  const r = detectIosUdid(read("simctl-list-none.txt"));
  assert.deepEqual(r, { udid: null, udidSource: "no-booted-sim" });
});

test("detectPlatform: adb device present, no booted sim -> android", () => {
  const r = detectPlatform({
    adbDevicesText: read("adb-devices-one.txt"),
    simctlListText: read("simctl-list-none.txt"),
  });
  assert.equal(r.platform, "android");
  assert.equal(r.platformSource, "single-adb-device");
  assert.equal(r.serial, "FAKE0001");
  assert.equal(r.udid, null);
});

test("detectPlatform: booted sim present, no adb device -> ios", () => {
  const r = detectPlatform({
    adbDevicesText: read("adb-devices-none.txt"),
    simctlListText: read("simctl-list-booted.txt"),
  });
  assert.equal(r.platform, "ios");
  assert.equal(r.platformSource, "single-booted-sim");
  assert.equal(r.udid, "B2C3D4E5-2222-3333-4444-555566667777");
  assert.equal(r.serial, null);
});

test("detectPlatform: neither present -> null platform, with *Source siblings for all three", () => {
  const r = detectPlatform({
    adbDevicesText: read("adb-devices-none.txt"),
    simctlListText: read("simctl-list-none.txt"),
  });
  assert.equal(r.platform, null);
  assert.equal(r.platformSource, "no-device-detected");
  assert.equal(r.serial, null);
  assert.equal(r.serialSource, "no-adb-device");
  assert.equal(r.udid, null);
  assert.equal(r.udidSource, "no-booted-sim");
});

test("detectPlatform: both present -> null platform + both-android-and-ios-present", () => {
  const r = detectPlatform({
    adbDevicesText: read("adb-devices-one.txt"),
    simctlListText: read("simctl-list-booted.txt"),
  });
  assert.equal(r.platform, null);
  assert.equal(r.platformSource, "both-android-and-ios-present");
});

test("detectPlatform: an explicit --serial pins android as flag-or-env", () => {
  const r = detectPlatform({ serial: "MYSERIAL123" });
  assert.deepEqual(r, {
    platform: "android", platformSource: "serial-flag-or-env",
    serial: "MYSERIAL123", serialSource: "flag-or-env",
    udid: null, udidSource: "not-ios",
  });
});

// --- AC-E: envelope ------------------------------------------------------------

test("makeEnvelope builds the schema/tool/subcommand/platform/ok/reason shell and merges payload", () => {
  const e = makeEnvelope({
    subcommand: "shot", platform: "android", platformSource: "single-adb-device",
    ok: true, reason: null, payload: { verdict: "content", entropy: 0.42 },
  });
  assert.equal(e.schema, "device/1");
  assert.equal(e.tool, "device");
  assert.equal(e.subcommand, "shot");
  assert.equal(e.platform, "android");
  assert.equal(e.platformSource, "single-adb-device");
  assert.equal(e.ok, true);
  assert.equal(e.reason, null);
  assert.equal(e["verdict"], "content");
  assert.equal(e["entropy"], 0.42);
});

// --- AC-R: refusal predicate + exit-code contract ------------------------------

test("refusalForStatus: a recorded restarting status refuses with a reason naming the pid", () => {
  const r = refusalForStatus(readJson("status-restarting.json"));
  assert.equal(r.refuse, true);
  assert.match(r.reason ?? "", /restarting/);
});

test("refusalForStatus: a recorded steady status does not refuse", () => {
  const r = refusalForStatus(readJson("status-steady.json"));
  assert.deepEqual(r, { refuse: false, reason: null });
});

test("refusalForStatus: a missing status refuses (cannot confirm not-restarting)", () => {
  assert.equal(refusalForStatus(undefined).refuse, true);
});

test("main: a not-yet-implemented subcommand exits 2 with ok:false + reason, over a recorded capture", () => {
  const capture = {
    adbDevices: () => read("adb-devices-one.txt"),
    simctlList: () => read("simctl-list-none.txt"),
  };
  const r = main(["shot", "--json"], { env: {}, capture });
  assert.equal(r.exitCode, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.subcommand, "shot");
  assert.equal(parsed.platform, "android");
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /not implemented/);
});

test("main: --help exits 0, no subcommand and an unknown subcommand exit 2", () => {
  const help = main(["--help"], { env: {}, capture: { adbDevices: () => null, simctlList: () => null } });
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /Usage:/);
  const none = main([], { env: {}, capture: { adbDevices: () => null, simctlList: () => null } });
  assert.equal(none.exitCode, 2);
  const bogus = main(["wat"], { env: {}, capture: { adbDevices: () => null, simctlList: () => null } });
  assert.equal(bogus.exitCode, 2);
});

test("hbc2js device --help: the CLI dispatches to the device tool, exits 0, prints usage", () => {
  const r = spawnSync(process.execPath, [CLI, "device", "--help"], { encoding: "utf8", shell: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage:/);
});
