// Subcommand dispatch, platform detection, the JSON envelope, the exit-code
// contract and the restart-refusal predicate, plus the three subcommands'
// verdict/measurement halves (shot/status/time).
//
// Everything a test or a caller needs is a PURE function: text/bytes in, a
// plain object out. The capture half (shelling to adb/simctl) is the only
// impure edge and is NEVER exercised in the gate (spec §7). App identity
// (Android package / iOS bundle id / device serial) comes ONLY from flags or
// env, never hard-coded — this tool ships in this repo precisely so it never
// couples to any one app.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { inflateSync, deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SCHEMA = "device/1";
export type Subcommand = "shot" | "status" | "time";
export const SUBCOMMANDS: readonly string[] = ["shot", "status", "time"];

const USAGE = `Usage: hbc2js device <shot|status|time> [flags]

  shot     capture a frame and classify it (black|uniform|redbox|logbox|content)
  status   lock / deployed-bundle-sha / mode-seed-env / pid / restarting
  time     --runs N cold-launch timing medians (launch, first content, interactive)

Shared flags (identity may also come from env):
  --json                 one JSON object on stdout (human text otherwise)
  --serial <s>           Android device serial      (env HBC2JS_DEVICE_SERIAL)
  --udid <u>             iOS simulator udid          (env HBC2JS_DEVICE_UDID)
  --app <id>             application identity (Android package id or iOS
                         bundle id)                  (env HBC2JS_DEVICE_APP)
  --package <id>         alias for --app (Android)
  --bundle-id <id>       alias for --app (iOS)
  --platform android|ios override auto-detection      (env HBC2JS_DEVICE_PLATFORM)
  --seam <path>          host app seam file           (env HBC2JS_DEVICE_SEAM)
  --runs <N>             time only: number of cold launches
  --burst <N>            shot only: capture N frames from one command
                         (1-500; requires --interval)
  --interval <ms>        shot only: requested spacing between frames
                         (0-60000ms; requires --burst; a slow capture still
                         reports its REAL elapsed time, per frame, never the
                         requested spacing)
  --status-json <path>   shot/time only: a recorded status object to gate on
                         (env HBC2JS_DEVICE_STATUS_JSON; a permanent escape
                         hatch for hand debugging -- \`shot\`'s default
                         capture.status() also shells out to real \`status\`
                         measurement)
  --expected-bundle <path>       status only: local path to the just-built
                                  bundle; hashed directly
                                  (env HBC2JS_DEVICE_EXPECTED_BUNDLE)
  --deployed-bundle-path <path>  status only: path of the deployed bundle on
                                  the device / inside the app container
                                  (env HBC2JS_DEVICE_DEPLOYED_BUNDLE_PATH)
  -h, --help             this message

Exit code: 0 when it measured (a verdict, even "black", exits 0); 2 when it
could not measure (bad usage, no device, or a refusal). See docs/specs/30-device.md.`;

export type Platform = "android" | "ios";

export interface AdbDeviceRow {
  serial: string;
  state: string;
  info: string;
}

export interface SimctlDeviceRow {
  name: string;
  udid: string;
  state: string;
}

// --- pure: parse recorded `adb devices -l` ------------------------------------

/** Parse `adb devices -l` text into `{serial, state, info}` rows. */
export function parseAdbDevices(text: string | null | undefined): AdbDeviceRow[] {
  const out: AdbDeviceRow[] = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("List of devices")) continue;
    if (line.startsWith("*")) continue; // adb daemon chatter
    const m = line.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) continue;
    out.push({ serial: m[1] as string, state: m[2] as string, info: m[3] ?? "" });
  }
  return out;
}

/** Parse `xcrun simctl list devices` text into `{name, udid, state}` rows. */
export function parseSimctlDevices(text: string | null | undefined): SimctlDeviceRow[] {
  const out: SimctlDeviceRow[] = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^(.*?)\s+\(([0-9A-Fa-f-]{36})\)\s+\((\w+)\)\s*$/);
    if (!m) continue;
    out.push({ name: m[1] as string, udid: m[2] as string, state: m[3] as string });
  }
  return out;
}

// --- pure: identity / platform detection --------------------------------------

export interface DetectAndroidSerialResult {
  serial: string | null;
  serialSource: string;
}

/** Resolve the Android serial from recorded `adb devices -l` text. */
export function detectAndroidSerial(adbDevicesText: string | null | undefined): DetectAndroidSerialResult {
  const ready = parseAdbDevices(adbDevicesText).filter((d) => d.state === "device");
  if (ready.length === 1) return { serial: (ready[0] as AdbDeviceRow).serial, serialSource: "single-adb-device" };
  if (ready.length === 0) return { serial: null, serialSource: "no-adb-device" };
  return { serial: null, serialSource: "multiple-adb-devices" };
}

export interface DetectIosUdidResult {
  udid: string | null;
  udidSource: string;
}

/** Resolve the booted-simulator udid from recorded `simctl list devices` text. */
export function detectIosUdid(simctlListText: string | null | undefined): DetectIosUdidResult {
  const booted = parseSimctlDevices(simctlListText).filter((d) => d.state === "Booted");
  if (booted.length === 1) return { udid: (booted[0] as SimctlDeviceRow).udid, udidSource: "single-booted-sim" };
  if (booted.length === 0) return { udid: null, udidSource: "no-booted-sim" };
  return { udid: null, udidSource: "multiple-booted-sims" };
}

export interface DetectPlatformOptions {
  platform?: string | null;
  serial?: string | null;
  udid?: string | null;
  adbDevicesText?: string | null;
  simctlListText?: string | null;
}

export interface DetectedPlatform {
  platform: Platform | null;
  platformSource: string;
  serial: string | null;
  serialSource: string;
  udid: string | null;
  udidSource: string;
}

/**
 * Decide the target platform and identity. Explicit `serial`/`udid` (flag or
 * env) pin the platform; `platform` forces the choice; otherwise auto-detect
 * from the recorded `adbDevicesText` / `simctlListText`. Always returns
 * platform + serial + udid each with a `*Source` sibling.
 */
export function detectPlatform(opts: DetectPlatformOptions = {}): DetectedPlatform {
  const {
    platform: platformFlag = null,
    serial: serialFlag = null,
    udid: udidFlag = null,
    adbDevicesText = null,
    simctlListText = null,
  } = opts;

  if (serialFlag) {
    return {
      platform: "android", platformSource: "serial-flag-or-env",
      serial: serialFlag, serialSource: "flag-or-env",
      udid: null, udidSource: "not-ios",
    };
  }
  if (udidFlag) {
    return {
      platform: "ios", platformSource: "udid-flag-or-env",
      serial: null, serialSource: "not-android",
      udid: udidFlag, udidSource: "flag-or-env",
    };
  }

  const android = adbDevicesText === null
    ? { serial: null, serialSource: "adb-not-run" }
    : detectAndroidSerial(adbDevicesText);
  const ios = simctlListText === null
    ? { udid: null, udidSource: "simctl-not-run" }
    : detectIosUdid(simctlListText);

  if (platformFlag === "android") {
    return { platform: "android", platformSource: "platform-flag", ...android, udid: null, udidSource: "not-ios" };
  }
  if (platformFlag === "ios") {
    return { platform: "ios", platformSource: "platform-flag", serial: null, serialSource: "not-android", ...ios };
  }

  const hasAndroid = android.serial !== null;
  const hasIos = ios.udid !== null;
  if (hasAndroid && !hasIos) return { platform: "android", platformSource: "single-adb-device", ...android, ...ios };
  if (hasIos && !hasAndroid) return { platform: "ios", platformSource: "single-booted-sim", ...android, ...ios };
  if (hasAndroid && hasIos) return { platform: null, platformSource: "both-android-and-ios-present", ...android, ...ios };
  return { platform: null, platformSource: "no-device-detected", ...android, ...ios };
}

// --- pure: restart-refusal predicate ------------------------------------------

export interface RefusalResult {
  refuse: boolean;
  reason: string | null;
}

/**
 * Shared predicate `shot` and `time` gate on before capturing: a frame or a
 * marker taken while the app is restarting reads the PREVIOUS process. Refuses
 * when the status says restarting, or when the status is missing/unusable.
 */
export function refusalForStatus(status: unknown): RefusalResult {
  if (!status || typeof status !== "object") {
    return { refuse: true, reason: "status unavailable: cannot confirm the app is not restarting" };
  }
  const s = status as Record<string, unknown>;
  if (s.restarting === true) {
    const pid = s.pid == null ? "none" : s.pid;
    return { refuse: true, reason: `app is restarting (pid ${String(pid)}); a capture now would read the previous process` };
  }
  return { refuse: false, reason: null };
}

// --- pure: JSON envelope ------------------------------------------------------

export interface Envelope {
  schema: string;
  tool: string;
  subcommand: string;
  platform: Platform | null;
  platformSource: string;
  ok: boolean;
  reason: string | null;
  [key: string]: unknown;
}

export interface EnvelopeInput {
  subcommand: string;
  platform?: Platform | null;
  platformSource?: string;
  ok: boolean;
  reason?: string | null;
  payload?: Record<string, unknown>;
}

/** Build the shared subcommand envelope (spec §4). Payload merges on top. */
export function makeEnvelope({ subcommand, platform = null, platformSource = "unknown", ok, reason = null, payload = {} }: EnvelopeInput): Envelope {
  return { schema: SCHEMA, tool: "device", subcommand, platform, platformSource, ok, reason, ...payload };
}

// --- arg parsing --------------------------------------------------------------

export interface Flags {
  json: boolean;
  help: boolean;
  serial: string | null;
  udid: string | null;
  app: string | null;
  platform: string | null;
  seam: string | null;
  runs: number | null;
  statusJson: string | null;
  expectedBundle: string | null;
  deployedBundlePath: string | null;
  // H7: burst capture (`device shot --burst N --interval <ms>`). Optional so
  // every pre-existing Flags object literal (tests included) still
  // typechecks without naming these two; `parseArgs` always sets them.
  burst?: number | null;
  interval?: number | null;
}

export interface ParsedArgs {
  subcommand: string | null;
  flags: Flags;
  errors: string[];
}

/** Parse argv (already sliced past node + script) into subcommand + flags. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Flags = {
    json: false, help: false,
    serial: null, udid: null, app: null,
    platform: null, seam: null, runs: null, statusJson: null,
    expectedBundle: null, deployedBundlePath: null,
    burst: null, interval: null,
  };
  const errors: string[] = [];
  let subcommand: string | null = null;
  let sawBurst = false, sawInterval = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (subcommand === null && !a.startsWith("-")) { subcommand = a; continue; }
    switch (a) {
      case "--json": flags.json = true; break;
      case "-h": case "--help": flags.help = true; break;
      case "--serial": flags.serial = argv[++i] ?? null; break;
      case "--udid": flags.udid = argv[++i] ?? null; break;
      case "--app": flags.app = argv[++i] ?? null; break;
      case "--package": flags.app = argv[++i] ?? null; break; // alias (Android)
      case "--bundle-id": flags.app = argv[++i] ?? null; break; // alias (iOS)
      case "--platform": flags.platform = argv[++i] ?? null; break;
      case "--seam": flags.seam = argv[++i] ?? null; break;
      case "--runs": flags.runs = Number(argv[++i]); break;
      case "--status-json": flags.statusJson = argv[++i] ?? null; break;
      case "--expected-bundle": flags.expectedBundle = argv[++i] ?? null; break;
      case "--deployed-bundle-path": flags.deployedBundlePath = argv[++i] ?? null; break;
      case "--burst": {
        sawBurst = true;
        const raw = argv[++i];
        const n = raw === undefined ? NaN : Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 500) {
          errors.push(`--burst must be an integer between 1 and 500 (got ${JSON.stringify(raw ?? null)})`);
        } else {
          flags.burst = n;
        }
        break;
      }
      case "--interval": {
        sawInterval = true;
        const raw = argv[++i];
        const n = raw === undefined ? NaN : Number(raw);
        if (!Number.isInteger(n) || n < 0 || n > 60000) {
          errors.push(`--interval must be an integer between 0 and 60000 (milliseconds; got ${JSON.stringify(raw ?? null)})`);
        } else {
          flags.interval = n;
        }
        break;
      }
      default:
        errors.push(a.startsWith("-") ? `unknown flag: ${a}` : `unexpected argument: ${a}`);
    }
  }
  if (sawBurst && !sawInterval) errors.push("--burst requires --interval <ms>");
  if (sawInterval && !sawBurst) errors.push("--interval requires --burst <N> (device shot only)");
  if (sawBurst && subcommand !== null && subcommand !== "shot") {
    errors.push(`--burst/--interval are only supported for 'device shot' (got subcommand '${subcommand}')`);
  }
  return { subcommand, flags, errors };
}

// --- pure: minimal PNG codec (no runtime dependency; T3b) ---------------------
//
// Decodes/encodes just enough PNG to classify a screencap/simctl frame and
// write a downscaled thumbnail: 8-bit, non-interlaced, colour type 2 (RGB) or
// 6 (RGBA) — what `adb exec-out screencap -p` and `xcrun simctl io screenshot`
// both produce. Anything else (16-bit, palette, interlaced) throws; that is a
// capture-classified-as-failure, never a silent guess.

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export interface Frame {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Decode a PNG buffer into `{width, height, pixels}` (pixels: RGBA Uint8Array). */
export function decodePng(buf: Buffer | Uint8Array): Frame {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) {
    throw new Error("decodePng: expected a Buffer/Uint8Array");
  }
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG (bad signature)");
  }
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idatChunks: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = bytes.subarray(dataStart, dataStart + length);
    offset = dataStart + length + 4; // skip data + CRC
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (only 8-bit supported)`);
  if (interlace !== 0) throw new Error("unsupported PNG interlace mode (only non-interlaced supported)");
  if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported PNG colour type ${colorType} (only RGB/RGBA supported)`);
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * 4);
  const prevRow = new Uint8Array(stride);
  let rowStart = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rowStart] as number;
    const rowData = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const out = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (out[x - channels] as number) : 0;
      const b = prevRow[x] as number;
      const c = x >= channels ? (prevRow[x - channels] as number) : 0;
      const rawX = rowData[x] as number;
      let value: number;
      switch (filterType) {
        case 0: value = rawX; break;
        case 1: value = (rawX + a) & 0xff; break;
        case 2: value = (rawX + b) & 0xff; break;
        case 3: value = (rawX + Math.floor((a + b) / 2)) & 0xff; break;
        case 4: value = (rawX + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`unsupported PNG filter type ${filterType}`);
      }
      out[x] = value;
    }
    for (let x = 0; x < width; x++) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      pixels[di] = out[si] as number;
      pixels[di + 1] = out[si + 1] as number;
      pixels[di + 2] = out[si + 2] as number;
      pixels[di + 3] = channels === 4 ? (out[si + 3] as number) : 255;
    }
    prevRow.set(out);
    rowStart += 1 + stride;
  }
  return { width, height, pixels };
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] as number;
    for (let k = 0; k < 8; k++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : (crc >>> 1);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Encode `{width, height, pixels}` (RGBA) into a PNG buffer (colour type 6, filter none). */
export function encodePng(width: number, height: number, pixels: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = pixels[y * stride + x] as number;
  }
  const idatData = deflateSync(raw);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idatData),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Nearest-neighbour downscale to `targetWidth`, preserving aspect ratio. */
export function downscale(frame: Frame, targetWidth: number): Frame {
  const { width, height, pixels } = frame;
  if (targetWidth >= width) return frame;
  const scale = targetWidth / width;
  const targetHeight = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(targetWidth * targetHeight * 4);
  for (let ty = 0; ty < targetHeight; ty++) {
    const sy = Math.min(height - 1, Math.floor(ty / scale));
    for (let tx = 0; tx < targetWidth; tx++) {
      const sx = Math.min(width - 1, Math.floor(tx / scale));
      const si = (sy * width + sx) * 4;
      const di = (ty * targetWidth + tx) * 4;
      out[di] = pixels[si] as number;
      out[di + 1] = pixels[si + 1] as number;
      out[di + 2] = pixels[si + 2] as number;
      out[di + 3] = pixels[si + 3] as number;
    }
  }
  return { width: targetWidth, height: targetHeight, pixels: out };
}

// --- pure: frame classification (T3b, spec §5.1) ------------------------------
export interface ShotThresholds {
  readonly blackMeanMax: number;
  readonly uniformStddevMax: number;
  readonly darkLuminanceMax: number;
  readonly logboxDarkFractionMin: number;
  readonly logboxRedAccentMin: number;
  readonly redboxFractionMin: number;
  readonly redRMin: number;
  readonly redDelta: number;
}

export const SHOT_THRESHOLDS: ShotThresholds = Object.freeze({
  blackMeanMax: 3,
  uniformStddevMax: 2,
  darkLuminanceMax: 40,
  logboxDarkFractionMin: 0.6,
  logboxRedAccentMin: 0.02,
  redboxFractionMin: 0.5,
  redRMin: 150,
  redDelta: 60,
});

export type Verdict = "black" | "uniform" | "redbox" | "logbox" | "content";

export interface ClassifyFrameResult {
  verdict: Verdict;
  entropy: number;
}

/** Classify a decoded frame (`{width, height, pixels}`, RGBA) -> `{verdict, entropy}`. */
export function classifyFrame(frame: Frame): ClassifyFrameResult {
  const { width, height, pixels } = frame;
  const n = width * height;
  if (n === 0) return { verdict: "content", entropy: 0 };
  const t = SHOT_THRESHOLDS;
  const lum = new Float64Array(n);
  let sum = 0;
  let redCount = 0;
  let darkCount = 0;
  for (let i = 0; i < n; i++) {
    const r = pixels[i * 4] as number, g = pixels[i * 4 + 1] as number, b = pixels[i * 4 + 2] as number;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum[i] = l;
    sum += l;
    if (l <= t.darkLuminanceMax) darkCount++;
    if (r >= t.redRMin && r - g >= t.redDelta && r - b >= t.redDelta) redCount++;
  }
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = (lum[i] as number) - mean;
    variance += d * d;
  }
  variance /= n;
  const stddev = Math.sqrt(variance);
  const redFraction = redCount / n;
  const darkFraction = darkCount / n;

  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < n; i++) {
    const bin = Math.max(0, Math.min(255, Math.round(lum[i] as number)));
    hist[bin] = (hist[bin] as number) + 1;
  }
  let entropyBits = 0;
  for (const c of hist) {
    if (c === 0) continue;
    const p = c / n;
    entropyBits -= p * Math.log2(p);
  }
  const entropy = entropyBits / 8; // log2(256 bins) = 8

  let verdict: Verdict;
  if (stddev <= t.uniformStddevMax) {
    verdict = mean <= t.blackMeanMax ? "black" : "uniform";
  } else if (redFraction >= t.redboxFractionMin) {
    verdict = "redbox";
  } else if (darkFraction >= t.logboxDarkFractionMin && redFraction >= t.logboxRedAccentMin) {
    verdict = "logbox";
  } else {
    verdict = "content";
  }
  return { verdict, entropy };
}

// --- pure: status parse/derive functions (T4, spec §5.2) ----------------------
//
// `status` never shells out itself in these functions -- they take already-
// captured text (recorded fixtures in the gate, the capture edge's output for
// real use) and derive the field. Two functions below (`readSeamFile`,
// `computeExpectedBundleSha`) do read a LOCAL file directly (the seam path /
// the just-built bundle path, both given by flag) -- that is ordinary,
// deterministic file I/O, not a device capture, so it stays here and is
// exercised on real fixture files in the gate; only shelling to adb/simctl
// (or reading something off the DEVICE) goes through the injectable
// `capture` object below and is never run in the gate (spec §7).

/** How recently a pid must have started to be considered still restarting
 * (spec §5.2: "pid changed within the last N seconds, or no pid yet"). This
 * tool is a stateless one-shot command with no memory of a previous
 * invocation, so "changed" is read as "this pid's own observed age is under
 * the window" -- honest because it is a direct observation (the process's own
 * elapsed time), never a guess about a prior pid it never saw. Chosen to
 * comfortably exceed the adb/simctl round-trip latency (~1-2s) while still
 * catching a just-launched app before its JS thread has stabilised. */
export const RESTARTING_WINDOW_SECONDS = 10;

/** Parse a `ps`-style elapsed-time field: bare seconds, `MM:SS`, `HH:MM:SS`,
 * or `DD-HH:MM:SS` (the two families `adb shell ps -o ETIME` / BSD `ps -o
 * etime=` both produce, module the leading `DD-`). Returns seconds, or `null`
 * if unparseable. */
export function parseEtime(str: unknown): number | null {
  if (str == null) return null;
  const s = String(str).trim();
  const m = s.match(/^(?:(\d+)-)?(?:(\d+):)?(?:(\d+):)?(\d+)$/);
  if (!m) return null;
  const [, days, a, b, c] = m;
  let hours = 0, minutes = 0;
  const seconds = Number(c);
  if (a !== undefined && b !== undefined) { hours = Number(a); minutes = Number(b); }
  else if (a !== undefined) { minutes = Number(a); }
  const dayPart = days !== undefined ? Number(days) : 0;
  if (days !== undefined && (a === undefined || b === undefined)) return null; // DD-HH:MM:SS only
  return dayPart * 86400 + hours * 3600 + minutes * 60 + seconds;
}

export interface ProcessInfo {
  pid: number | null;
  etimeSeconds: number | null;
}

/** Parse one recorded "PID ETIME NAME" process line (the capture edge already
 * filters to the target app's single line) into `{pid, etimeSeconds}`. Blank
 * or unparseable text -> both `null` (no process found -- never a guess). */
export function parseProcessInfo(text: string | null | undefined): ProcessInfo {
  const line = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return { pid: null, etimeSeconds: null };
  const m = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
  if (!m) return { pid: null, etimeSeconds: null };
  const pid = Number(m[1]);
  const etimeSeconds = parseEtime(m[2]);
  if (!Number.isFinite(pid) || etimeSeconds === null) return { pid: null, etimeSeconds: null };
  return { pid, etimeSeconds };
}

export interface LockInfo {
  locked: boolean | null;
  lockedSource: string;
}

/** Parse recorded `adb shell dumpsys window` text for the device lock state.
 * `mDreamingLockscreen=true|false` is the field used (taken from dumpsys output). `null` text (nothing captured, e.g. iOS has no
 * lock-capture wired) or no matching line -> `null` + a distinct source for
 * each case (never guessed). */
export function parseLockInfo(text: string | null | undefined): LockInfo {
  if (text == null) return { locked: null, lockedSource: "lock-not-captured" };
  const m = String(text).match(/mDreamingLockscreen=(true|false)/);
  if (!m) return { locked: null, lockedSource: "lock-state-not-found" };
  return { locked: m[1] === "true", lockedSource: "dumpsys-window-mDreamingLockscreen" };
}

export interface Sha256Result {
  sha: string | null;
  shaSource: string;
}

/** Parse recorded `sha256sum`/`shasum -a 256` output (`<hex>  <path>`) into
 * the hex sha. */
export function parseSha256sumOutput(text: string | null | undefined): Sha256Result {
  if (text == null) return { sha: null, shaSource: "sha-not-captured" };
  const m = String(text).match(/\b([0-9a-fA-F]{64})\b/);
  if (!m) return { sha: null, shaSource: "sha256sum-output-unparseable" };
  return { sha: (m[1] as string).toLowerCase(), shaSource: "sha256sum-output" };
}

export interface SeamFields {
  mode: string | null;
  modeSource: string;
  seed: string | null;
  seedSource: string;
  env: string | null;
  envSource: string;
}

export function parseSeamFile(text: string | null | undefined): SeamFields {
  if (text == null) {
    return {
      mode: null, modeSource: "seam-file-unparseable",
      seed: null, seedSource: "seam-file-unparseable",
      env: null, envSource: "seam-file-unparseable",
    };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return {
      mode: null, modeSource: "seam-file-unparseable",
      seed: null, seedSource: "seam-file-unparseable",
      env: null, envSource: "seam-file-unparseable",
    };
  }
  const field = (key: string): { value: string | null; source: string } => {
    const val = obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
    return val != null
      ? { value: String(val), source: "seam-file" }
      : { value: null, source: "seam-file-missing-field" };
  };
  const mode = field("mode");
  const seed = field("seed");
  const env = field("env");
  return {
    mode: mode.value, modeSource: mode.source,
    seed: seed.value, seedSource: seed.source,
    env: env.value, envSource: env.source,
  };
}

/** Read the seam file off disk (a local, deterministic read -- the path
 * itself came from `--seam`/`HBC2JS_DEVICE_SEAM`) and parse it. No path ->
 * all three `null` + `seam-file-absent`. */
export function readSeamFile(seamPath: string | null | undefined): SeamFields {
  if (!seamPath) {
    return {
      mode: null, modeSource: "seam-file-absent",
      seed: null, seedSource: "seam-file-absent",
      env: null, envSource: "seam-file-absent",
    };
  }
  let text: string;
  try {
    text = readFileSync(seamPath, "utf8");
  } catch {
    return {
      mode: null, modeSource: "seam-file-absent",
      seed: null, seedSource: "seam-file-absent",
      env: null, envSource: "seam-file-absent",
    };
  }
  return parseSeamFile(text);
}

export interface DeriveRestartingResult {
  restarting: boolean | null;
  restartingSource: string;
}

/** Derive `restarting` from a directly-observed pid + its own elapsed age
 * (spec §5.2). No pid -> `true` ("no pid yet"). A pid whose age could not be
 * observed -> `null` (never a false `false` -- the contract requires never
 * reporting not-restarting when it could not actually observe the pid). */
export function deriveRestarting(pid: number | null, etimeSeconds: number | null, windowSeconds: number = RESTARTING_WINDOW_SECONDS): DeriveRestartingResult {
  if (pid == null) return { restarting: true, restartingSource: "no-pid-yet" };
  if (etimeSeconds == null) return { restarting: null, restartingSource: "etime-unavailable" };
  if (etimeSeconds < windowSeconds) {
    return { restarting: true, restartingSource: `pid-age-${etimeSeconds}s-lt-${windowSeconds}s` };
  }
  return { restarting: false, restartingSource: `pid-stable-${etimeSeconds}s` };
}

/** `startTime` = `nowMs` minus the process's own observed elapsed age, as an
 * ISO string. `etimeSeconds` unavailable -> `null`. `nowMs` is injectable so
 * this is deterministic in a test. */
export function computeStartTime(etimeSeconds: number | null, nowMs: number = Date.now()): string | null {
  if (etimeSeconds == null) return null;
  return new Date(nowMs - etimeSeconds * 1000).toISOString();
}

export interface BundleMatchResult {
  bundleMatches: boolean | null;
  bundleMatchesSource: string;
}

/** `bundleMatches` = `bundleSha === expectedBundleSha`, both required. Either
 * missing -> `null` with a source naming which one. */
export function deriveBundleMatch(bundleSha: string | null, expectedBundleSha: string | null): BundleMatchResult {
  if (bundleSha == null) return { bundleMatches: null, bundleMatchesSource: "no-deployed-sha" };
  if (expectedBundleSha == null) return { bundleMatches: null, bundleMatchesSource: "no-expected-sha" };
  return { bundleMatches: bundleSha === expectedBundleSha, bundleMatchesSource: "compared" };
}

export interface ExpectedBundleShaResult {
  expectedBundleSha: string | null;
  expectedBundleShaSource: string;
}

/** sha256 of the just-built bundle: a LOCAL file read (path from
 * `--expected-bundle`/`HBC2JS_DEVICE_EXPECTED_BUNDLE`), hashed directly --
 * not a device capture, so this runs for real in the gate against a fixture
 * file. */
export function computeExpectedBundleSha(expectedBundlePath: string | null | undefined): ExpectedBundleShaResult {
  if (!expectedBundlePath) {
    return { expectedBundleSha: null, expectedBundleShaSource: "no-expected-bundle-flag" };
  }
  try {
    const buf = readFileSync(expectedBundlePath);
    const sha = createHash("sha256").update(buf).digest("hex");
    return { expectedBundleSha: sha, expectedBundleShaSource: "local-file-sha256" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { expectedBundleSha: null, expectedBundleShaSource: `expected-bundle-read-failed: ${message}` };
  }
}

// --- shared handler/capture types ----------------------------------------------

export interface CaptureContext {
  platform: Platform | null;
  serial: string | null;
  udid: string | null;
  app?: string | null;
}

export interface ScreenshotResult {
  buffer: Buffer;
  capturePath?: string;
  capturePathSource?: string;
}

export interface TextResult {
  text: string | null;
  textSource: string;
}

/** The one impure edge: everything here shells out to adb/simctl or touches
 * the filesystem/device. Injectable so every test can feed recorded text
 * with no device attached (spec §7). `adbDevices`/`simctlList` are always
 * called by `main()`; everything else is optional and feature-tested with a
 * `typeof capture.x === "function"` guard. */
export interface Capture {
  adbDevices: () => string | null;
  simctlList: () => string | null;
  screenshot?: (ctx: CaptureContext) => ScreenshotResult | null;
  text?: (ctx: CaptureContext) => TextResult;
  saveCapture?: (buf: Buffer) => string | null;
  saveThumb?: (buf: Buffer) => string | null;
  lock?: (ctx: CaptureContext) => string | null;
  process?: (ctx: CaptureContext) => string | null;
  deployedBundleSha?: (ctx: CaptureContext) => string | null;
  coldLaunchRuns?: (runs: number, ctx: CaptureContext) => string[];
  status?: () => unknown;
  // H7 (`shot --burst`): injectable clock + blocking sleep so burst timing is
  // testable off a fake counter, never real wall-clock (spec's own "never
  // exercised in the gate with a real device" convention extends to time
  // itself here). Defaults: `Date.now`, and a real blocking sleep.
  now?: () => number;
  sleep?: (ms: number) => void;
}

export interface HandlerArgs {
  detected: DetectedPlatform;
  flags: Flags;
  env: NodeJS.ProcessEnv;
  capture: Capture;
}

export interface HandlerResult {
  ok: boolean;
  reason: string | null;
  payload: Record<string, unknown>;
}

/**
 * `status`'s verdict/measurement half (spec §5.2). Pure apart from the
 * injected `capture` object (`lock`/`process`/`deployedBundleSha`), which
 * does all device-shelling I/O; never exercised in the gate with a real
 * device (spec §7). Unlike `shot` (which cannot do anything at all without a
 * `screenshot` function), `status`'s payload is well-defined even when every
 * capture function and every path flag is absent: every field it could not
 * obtain is `null` with a `*Source` sibling naming why, and that full-null
 * report IS the measurement (an "I could observe nothing" status is still
 * informative to the caller, and matches the already-committed
 * `status-restarting.json` fixture's `ok:true` with almost everything null).
 * `status` therefore always returns `ok:true` -- there is no capture shape
 * known where it should refuse outright.
 */
export function handleStatus({ detected, flags, env, capture }: HandlerArgs): HandlerResult {
  const ctx: CaptureContext = {
    platform: detected.platform, serial: detected.serial, udid: detected.udid,
    app: flags.app ?? env.HBC2JS_DEVICE_APP ?? null,
  };

  let locked: boolean | null = null, lockedSource = "not-captured";
  const lockFn = capture.lock;
  if (typeof lockFn === "function") {
    const r = parseLockInfo(lockFn(ctx));
    locked = r.locked; lockedSource = r.lockedSource;
  }

  let pid: number | null = null, pidSource = "not-captured", etimeSeconds: number | null = null;
  const processFn = capture.process;
  if (typeof processFn === "function") {
    const r = parseProcessInfo(processFn(ctx));
    pid = r.pid; etimeSeconds = r.etimeSeconds;
    pidSource = pid == null ? "no-process-found" : "process-list";
  }
  const startTime = pid == null ? null : computeStartTime(etimeSeconds);
  const startTimeSource = pid == null ? "no-pid" : (startTime == null ? "no-etime" : "now-minus-etime");
  const { restarting, restartingSource } = deriveRestarting(pid, etimeSeconds);

  let bundleSha: string | null = null, bundleShaSource = "not-captured";
  const deployedBundleShaFn = capture.deployedBundleSha;
  if (typeof deployedBundleShaFn === "function") {
    const r = parseSha256sumOutput(deployedBundleShaFn(ctx));
    bundleSha = r.sha; bundleShaSource = r.shaSource;
  }
  const expectedBundlePath = flags.expectedBundle ?? env.HBC2JS_DEVICE_EXPECTED_BUNDLE ?? null;
  const expected = computeExpectedBundleSha(expectedBundlePath);
  const match = deriveBundleMatch(bundleSha, expected.expectedBundleSha);

  const seamPath = flags.seam ?? env.HBC2JS_DEVICE_SEAM ?? null;
  const seam = readSeamFile(seamPath);

  return {
    ok: true,
    reason: null,
    payload: {
      locked, lockedSource,
      bundleSha, bundleShaSource,
      expectedBundleSha: expected.expectedBundleSha, expectedBundleShaSource: expected.expectedBundleShaSource,
      bundleMatches: match.bundleMatches, bundleMatchesSource: match.bundleMatchesSource,
      mode: seam.mode, modeSource: seam.modeSource,
      seed: seam.seed, seedSource: seam.seedSource,
      env: seam.env, envSource: seam.envSource,
      pid, pidSource,
      startTime, startTimeSource,
      restarting, restartingSource,
    },
  };
}

// --- capture edge (the only impure part; never run in the gate) ---------------

function safeRun(file: string, args: readonly string[]): string | null {
  const r = spawnSync(file, args, { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

function safeRunBuffer(file: string, args: readonly string[]): Buffer | null {
  const r = spawnSync(file, args, { maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

function saveBuffer(buf: Buffer, prefix: string): string {
  const path = join(tmpdir(), `hbc2js-device-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  writeFileSync(path, buf);
  return path;
}

function defaultScreenshot({ platform, serial, udid }: CaptureContext): ScreenshotResult | null {
  if (platform === "android") {
    const args = serial ? ["-s", serial, "exec-out", "screencap", "-p"] : ["exec-out", "screencap", "-p"];
    const buf = safeRunBuffer("adb", args);
    if (!buf || buf.length === 0) return null;
    return { buffer: buf, capturePathSource: "adb-exec-out-screencap" };
  }
  if (platform === "ios") {
    const path = join(tmpdir(), `hbc2js-device-simctl-shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    const target = udid ?? "booted";
    const r = spawnSync("xcrun", ["simctl", "io", target, "screenshot", path], { encoding: "utf8" });
    if (r.error || r.status !== 0) return null;
    try {
      const buf = readFileSync(path);
      return { buffer: buf, capturePath: path, capturePathSource: "simctl-io-screenshot" };
    } catch {
      return null;
    }
  }
  return null;
}

function defaultText({ platform, serial }: CaptureContext): TextResult {
  if (platform === "android") {
    const args = serial
      ? ["-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"]
      : ["exec-out", "uiautomator", "dump", "/dev/tty"];
    const out = safeRun("adb", args);
    if (out && out.includes("<?xml")) return { text: out, textSource: "uiautomator-dump" };
    return { text: null, textSource: "uiautomator-failed" };
  }
  if (platform === "ios") {
    return { text: null, textSource: "no-ios-accessibility-dump" };
  }
  return { text: null, textSource: "unknown-platform" };
}

// --- capture edge for status (T4; impure, never run in the gate) --------------

function defaultLock({ platform, serial }: CaptureContext): string | null {
  if (platform === "android") {
    const args = serial ? ["-s", serial, "shell", "dumpsys", "window"] : ["shell", "dumpsys", "window"];
    return safeRun("adb", args);
  }
  return null; // iOS: simulators have no queryable lock-screen state
}

function defaultProcess({ platform, serial, udid, app }: CaptureContext): string | null {
  if (platform === "android") {
    if (!app) return null;
    const shellCmd = `ps -A -o PID,ETIME,NAME | grep ${app}`;
    const args = serial ? ["-s", serial, "shell", shellCmd] : ["shell", shellCmd];
    return safeRun("adb", args);
  }
  if (platform === "ios") {
    if (!app) return null;
    const target = udid ?? "booted";
    const listOut = safeRun("xcrun", ["simctl", "spawn", target, "launchctl", "list"]);
    if (!listOut) return null;
    const line = listOut.split(/\r?\n/).find((l) => l.includes(app));
    if (!line) return null;
    const pid = line.trim().split(/\s+/)[0];
    if (!pid || pid === "-") return null;
    const etimeOut = safeRun("ps", ["-o", "etime=", "-p", pid]);
    if (!etimeOut) return null;
    return `${pid} ${etimeOut.trim()} ${app}`;
  }
  return null;
}

function defaultDeployedBundleSha({ platform, serial, udid, app }: CaptureContext, deployedBundlePath: string | null): string | null {
  if (!deployedBundlePath) return null;
  if (platform === "android") {
    const shellCmd = `sha256sum ${deployedBundlePath}`;
    const args = serial ? ["-s", serial, "shell", shellCmd] : ["shell", shellCmd];
    return safeRun("adb", args);
  }
  if (platform === "ios") {
    if (!app) return null;
    const target = udid ?? "booted";
    const containerOut = safeRun("xcrun", ["simctl", "get_app_container", target, app, "data"]);
    if (!containerOut) return null;
    const fullPath = join(containerOut.trim(), deployedBundlePath);
    return safeRun("shasum", ["-a", "256", fullPath]);
  }
  return null;
}

function defaultColdLaunchRuns(runs: number, { platform, serial, udid, app }: CaptureContext): string[] {
  const logs: string[] = [];
  for (let i = 0; i < runs; i++) {
    if (platform === "android") {
      const s = serial ? ["-s", serial] : [];
      if (app) {
        spawnSync("adb", [...s, "shell", "am", "force-stop", app]);
      }
      safeRun("adb", [...s, "logcat", "-c"]);
      if (app) {
        spawnSync("adb", [...s, "shell", "monkey", "-p", app, "-c", "android.intent.category.LAUNCHER", "1"]);
      }
      logs.push(safeRun("adb", [...s, "logcat", "-d"]) ?? "");
    } else if (platform === "ios") {
      if (app) {
        spawnSync("xcrun", ["simctl", "terminate", udid ?? "booted", app]);
        spawnSync("xcrun", ["simctl", "launch", udid ?? "booted", app]);
      }
      logs.push(safeRun("xcrun", ["simctl", "spawn", udid ?? "booted", "log", "show", "--last", "30s"]) ?? "");
    } else {
      logs.push("");
    }
  }
  return logs;
}

function blockingSleepMs(ms: number): void {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function defaultCapture(flags: Partial<Flags> = {}, env: NodeJS.ProcessEnv = process.env): Capture {
  const cap: Capture = {
    adbDevices: () => safeRun("adb", ["devices", "-l"]),
    simctlList: () => safeRun("xcrun", ["simctl", "list", "devices"]),
    screenshot: defaultScreenshot,
    text: defaultText,
    saveCapture: (buf: Buffer) => saveBuffer(buf, "shot"),
    saveThumb: (buf: Buffer) => saveBuffer(buf, "thumb"),
    lock: defaultLock,
    process: defaultProcess,
    deployedBundleSha: (ctx: CaptureContext) => defaultDeployedBundleSha(ctx, flags.deployedBundlePath ?? env.HBC2JS_DEVICE_DEPLOYED_BUNDLE_PATH ?? null),
    coldLaunchRuns: defaultColdLaunchRuns,
    now: () => Date.now(),
    sleep: blockingSleepMs,
  };
  // `shot`/`time` call `capture.status()` (no args) to gate on
  // `refusalForStatus` -- wire it to a real measurement via the same
  // detect+handleStatus path `main()` uses, so a real device no longer needs
  // `--status-json` to unblock `shot`. `--status-json`/`HBC2JS_DEVICE_STATUS_JSON`
  // stay a permanent escape hatch (checked first in `readStatusForShot`) for
  // hand debugging or a recorded status when no live capture is wired.
  cap.status = () => {
    const serial = flags.serial ?? env.HBC2JS_DEVICE_SERIAL ?? null;
    const udid = flags.udid ?? env.HBC2JS_DEVICE_UDID ?? null;
    const platform = flags.platform ?? env.HBC2JS_DEVICE_PLATFORM ?? null;
    const detected = detectPlatform({
      platform, serial, udid,
      adbDevicesText: serial ? null : cap.adbDevices(),
      simctlListText: udid ? null : cap.simctlList(),
    });
    const result = handleStatus({ detected, flags: flags as Flags, env, capture: cap });
    return result.ok ? result.payload : null;
  };
  return cap;
}

// --- shot (T3b) ----------------------------------------------------------------

function readStatusForShot(flags: Flags, env: NodeJS.ProcessEnv, capture: Capture): unknown {
  const path = flags.statusJson ?? env.HBC2JS_DEVICE_STATUS_JSON ?? null;
  if (path) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }
  const statusFn = capture.status;
  if (typeof statusFn === "function") {
    try {
      return statusFn();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * `shot`'s verdict/measurement half (spec §5.1). Pure apart from the injected
 * `capture` object, which does all filesystem/process I/O; never exercised in
 * the gate with a real device (spec §7). A `capture` lacking a `screenshot`
 * function cannot take a shot at all — reported as not-implemented-for-this-
 * capture, same shape as the pre-implementation skeleton stub, never a faked
 * measurement.
 */
export function handleShot({ detected, flags, env, capture }: HandlerArgs): HandlerResult {
  if (typeof capture.screenshot !== "function") {
    return {
      ok: false,
      reason: "shot: not implemented for this capture (no screenshot capability provided; " +
        "spec docs/specs/30-device.md impl item T3b)",
      payload: {},
    };
  }

  const status = readStatusForShot(flags, env, capture);
  const refusal = refusalForStatus(status);
  if (refusal.refuse) {
    return { ok: false, reason: refusal.reason, payload: {} };
  }

  return captureFrame(detected, capture);
}

/**
 * The one-frame capture -> decode -> classify -> thumbnail -> text half of
 * `shot`, factored out of `handleShot` (H7) so `handleBurstShot` can call it
 * once per frame without re-running the refusal gate (which the burst runs
 * ONCE, up front -- see its own doc comment for why).
 */
function captureFrame(detected: DetectedPlatform, capture: Capture): HandlerResult {
  const shotCapture = (capture.screenshot as NonNullable<Capture["screenshot"]>)({ platform: detected.platform, serial: detected.serial, udid: detected.udid });
  if (!shotCapture || !shotCapture.buffer) {
    return {
      ok: false,
      reason: "capture failed: no frame produced (screencap/simctl screenshot returned nothing)",
      payload: {},
    };
  }

  let frame: Frame;
  try {
    frame = decodePng(shotCapture.buffer);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `capture failed: could not decode PNG (${message})`, payload: {} };
  }

  const { verdict, entropy } = classifyFrame(frame);

  let capturePath: string | null = shotCapture.capturePath ?? null;
  let capturePathSource: string | null = capturePath ? (shotCapture.capturePathSource ?? "capture") : null;
  const saveCaptureFn = capture.saveCapture;
  if (!capturePath && typeof saveCaptureFn === "function") {
    try {
      const saved = saveCaptureFn(shotCapture.buffer);
      if (saved) {
        capturePath = saved;
        capturePathSource = shotCapture.capturePathSource ?? "saved-capture";
      }
    } catch {
      // fall through: capturePath stays null
    }
  }
  if (!capturePath) capturePathSource = "not-saved";

  let thumb: string | null = null;
  let thumbSource = "no-thumb-sink";
  const saveThumbFn = capture.saveThumb;
  if (typeof saveThumbFn === "function") {
    try {
      const small = downscale(frame, 160);
      const png = encodePng(small.width, small.height, small.pixels);
      const saved = saveThumbFn(png);
      thumb = saved ?? null;
      thumbSource = thumb ? "downscaled-160w" : "save-failed";
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      thumbSource = `thumb-failed: ${message}`;
    }
  }

  const textFn = capture.text;
  const textResult: TextResult = typeof textFn === "function"
    ? textFn({ platform: detected.platform, serial: detected.serial, udid: detected.udid })
    : { text: null, textSource: "no-text-capture" };

  return {
    ok: true,
    reason: null,
    payload: {
      verdict,
      verdictSource: "frame-classification",
      entropy,
      entropySource: "frame-luminance-histogram",
      text: textResult.text ?? null,
      textSource: textResult.textSource ?? "unknown",
      thumb,
      thumbSource,
      capturePath,
      capturePathSource,
    },
  };
}

export function handleBurstShot({ detected, flags, env, capture }: HandlerArgs): HandlerResult {
  if (typeof capture.screenshot !== "function") {
    return {
      ok: false,
      reason: "shot: not implemented for this capture (no screenshot capability provided; " +
        "spec docs/specs/30-device.md impl item T3b)",
      payload: {},
    };
  }

  const status = readStatusForShot(flags, env, capture);
  const refusal = refusalForStatus(status);
  if (refusal.refuse) {
    return { ok: false, reason: refusal.reason, payload: {} };
  }

  const burst = flags.burst ?? 1;
  const intervalMs = flags.interval ?? 0;
  const now = capture.now ?? (() => Date.now());
  const sleep = capture.sleep ?? blockingSleepMs;

  const frames: Record<string, unknown>[] = [];
  let previousStart: number | null = null;
  for (let i = 0; i < burst; i++) {
    const frameStart = now();
    const elapsedMs = previousStart === null ? null : frameStart - previousStart;
    previousStart = frameStart;

    let frameResult: HandlerResult;
    try {
      frameResult = captureFrame(detected, capture);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      frameResult = { ok: false, reason: `capture failed: frame ${i} threw (${message})`, payload: {} };
    }

    frames.push({
      index: i,
      ok: frameResult.ok,
      reason: frameResult.reason,
      elapsedMs,
      elapsedMsSource: i === 0 ? "first-frame" : "measured-frame-start-to-frame-start",
      requestedIntervalMs: intervalMs,
      drifted: elapsedMs !== null && elapsedMs > intervalMs,
      ...frameResult.payload,
    });

    if (i < burst - 1) {
      const captureElapsedMs = now() - frameStart;
      const sleepFor = Math.max(0, intervalMs - captureElapsedMs);
      sleep(sleepFor);
    }
  }

  return {
    ok: true,
    reason: null,
    payload: { burst, intervalMs, frames },
  };
}

// --- time (T6) -------------------------------------------------------------
//
// The three phases are named markers the HOST APP prints on the console
// during a cold launch: `HBC2JS_DEVICE_MARKER <phase> <elapsedMs>`, one line
// per phase per run, `<elapsedMs>` an integer number of milliseconds SINCE
// THE PROCESS'S OWN COLD START as the host measures it on-device (recommended:
// Android `SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime()`;
// iOS a `systemUptime`/`mach_absolute_time()` diff against a timestamp taken
// at the very top of `application:didFinishLaunchingWithOptions:`). Because
// the value is already relative and computed on-device, `parseTimingMarkers`
// needs no external "t0" and no host/device clock alignment: it just extracts
// the three numbers straight out of already-captured logcat/os_log text,
// whatever surrounding prefix that platform's log tool adds. If a marker line
// appears more than once in one run's log, the FIRST occurrence wins.
export const TIMING_MARKER_NAMES: readonly string[] = ["launch", "firstContentCommit", "interactive"];

// Cold launches are expensive (force-stop, clear from recents, launch, wait
// for markers) -- 5 is enough for a median+range to mean something without
// making a hand-run take minutes; `--runs N` overrides it.
export const DEFAULT_TIME_RUNS = 5;

export type TimingMarkers = Record<string, number | null>;

/**
 * Pure. Extracts the three phase markers from one already-captured run's
 * logcat/os_log text. A phase whose marker line never appears is `null` --
 * NEVER backfilled from another phase (spec's "time-to-usable, never
 * time-to-first-render": a run that never became interactive must say so).
 */
export function parseTimingMarkers(logText: string | null | undefined, markerNames: readonly string[] = TIMING_MARKER_NAMES): TimingMarkers {
  const text = logText ?? "";
  const result: TimingMarkers = {};
  for (const name of markerNames) {
    const re = new RegExp(`HBC2JS_DEVICE_MARKER\\s+${name}\\s+(\\d+)`);
    const m = text.match(re);
    result[name] = m ? Number(m[1]) : null;
  }
  return result;
}

/** Pure. Median of a plain array of numbers; `null` when the array is empty. */
export function medianOf(values: readonly number[] | null | undefined): number | null {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
}

/**
 * Pure. Spread statistic: min-max range (chosen because `--runs` is typically small since each run is a
 * real cold launch, where IQR/MAD would have too few samples to mean
 * anything; min-max is the plain "worst case minus best case" a runner can
 * read off the terminal without doing more arithmetic). `null` when empty,
 * `0` for a single value.
 */
export function spreadOf(values: readonly number[] | null | undefined): number | null {
  if (!values || values.length === 0) return null;
  return Math.max(...values) - Math.min(...values);
}

export interface AggregatedTiming {
  perRun: TimingMarkers[] | null;
  [key: string]: unknown;
}

/**
 * Pure. Aggregates N runs' `{launch, firstContentCommit, interactive}`
 * (each ms|null, from `parseTimingMarkers`) into the `time` payload shape
 * (spec §5.3): a median + a spread per phase, each with a `*Source` naming
 * how many of the N runs actually had that marker, plus the raw `perRun`
 * array. A phase with zero non-null values across all runs reports
 * `null`/`null`/"no-runs-with-marker" -- honest, never averaged over nothing.
 */
export function aggregateTimingRuns(perRun: readonly TimingMarkers[] | null | undefined): AggregatedTiming {
  const runs = perRun ?? [];
  const out: AggregatedTiming = { perRun: runs.length > 0 ? [...runs] : null };
  for (const phase of TIMING_MARKER_NAMES) {
    const values = runs
      .map((r) => r[phase])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    out[phase] = medianOf(values);
    out[`${phase}Spread`] = spreadOf(values);
    out[`${phase}Source`] = values.length > 0
      ? `median-of-${values.length}-of-${runs.length}-runs`
      : "no-runs-with-marker";
  }
  return out;
}

/**
 * `time`'s verdict/measurement half (spec §5.3). Pure apart from the injected
 * `capture` object (`capture.coldLaunchRuns(n, ctx) -> string[]`, one raw
 * logcat/os_log text per run), never exercised in the gate with a real device
 * (spec §7). Gates on `refusalForStatus` the SAME way `shot` does, via the
 * same `--status-json`/`HBC2JS_DEVICE_STATUS_JSON`/`capture.status()` path
 * (`readStatusForShot`) -- one refusal gate, not a second one.
 */
export function handleTime({ detected, flags, env, capture }: HandlerArgs): HandlerResult {
  const coldLaunchRunsFn = capture.coldLaunchRuns;
  if (typeof coldLaunchRunsFn !== "function") {
    return {
      ok: false,
      reason: "time: not implemented for this capture (no cold-launch capability provided; " +
        "spec docs/specs/30-device.md impl item T6)",
      payload: {},
    };
  }

  const status = readStatusForShot(flags, env, capture);
  const refusal = refusalForStatus(status);
  if (refusal.refuse) {
    return { ok: false, reason: refusal.reason, payload: {} };
  }

  const runs = Number.isFinite(flags.runs) && (flags.runs as number) > 0 ? Math.floor(flags.runs as number) : DEFAULT_TIME_RUNS;
  const ctx: CaptureContext = {
    platform: detected.platform, serial: detected.serial, udid: detected.udid,
    app: flags.app ?? env.HBC2JS_DEVICE_APP ?? null,
  };

  let logs: string[];
  try {
    logs = coldLaunchRunsFn(runs, ctx);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `capture failed: cold launch runs threw (${message})`, payload: {} };
  }
  if (!Array.isArray(logs) || logs.length === 0) {
    return {
      ok: false,
      reason: "capture failed: no cold-launch runs produced (coldLaunchRuns returned nothing)",
      payload: {},
    };
  }

  const perRun = logs.map((logText) => parseTimingMarkers(logText));
  const agg = aggregateTimingRuns(perRun);

  return {
    ok: true,
    reason: null,
    payload: { runs, ...agg },
  };
}

// --- main ---------------------------------------------------------------------

interface RunOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function emit(envelope: Envelope, json: boolean, exitCode: number): RunOutput {
  const stdout = json
    ? JSON.stringify(envelope) + "\n"
    : `device ${envelope.subcommand}: platform=${envelope.platform ?? "unknown"} ok=${envelope.ok}` +
      (envelope.reason ? ` reason=${envelope.reason}` : "") + "\n";
  return { exitCode, stdout, stderr: "" };
}

export interface MainOptions {
  env?: NodeJS.ProcessEnv;
  capture?: Capture;
}

/**
 * Run the device tool. Returns `{exitCode, stdout, stderr}` rather than
 * writing/exiting, so it is fully testable offline; the CLI wrapper
 * (`src/cli.ts`) does the real I/O. `capture` is injectable so a test can
 * feed recorded device text without adb.
 */
export function main(argv: readonly string[], opts: MainOptions = {}): RunOutput {
  const env = opts.env ?? process.env;
  const { subcommand, flags, errors } = parseArgs(argv);
  const capture = opts.capture ?? defaultCapture(flags, env);

  if (flags.help || subcommand === "help") {
    return { exitCode: 0, stdout: USAGE + "\n", stderr: "" };
  }
  if (errors.length > 0) {
    return { exitCode: 2, stdout: "", stderr: errors.join("\n") + "\n\n" + USAGE + "\n" };
  }
  if (subcommand === null) {
    return { exitCode: 2, stdout: "", stderr: "hbc2js device: no subcommand\n\n" + USAGE + "\n" };
  }
  if (!SUBCOMMANDS.includes(subcommand)) {
    return { exitCode: 2, stdout: "", stderr: `hbc2js device: unknown subcommand '${subcommand}'\n\n` + USAGE + "\n" };
  }

  const serial = flags.serial ?? env.HBC2JS_DEVICE_SERIAL ?? null;
  const udid = flags.udid ?? env.HBC2JS_DEVICE_UDID ?? null;
  const platform = flags.platform ?? env.HBC2JS_DEVICE_PLATFORM ?? null;

  const detected = detectPlatform({
    platform, serial, udid,
    adbDevicesText: serial ? null : capture.adbDevices(),
    simctlListText: udid ? null : capture.simctlList(),
  });

  if (subcommand === "shot") {
    const result = (flags.burst != null)
      ? handleBurstShot({ detected, flags, env, capture })
      : handleShot({ detected, flags, env, capture });
    const envelope = makeEnvelope({
      subcommand,
      platform: detected.platform,
      platformSource: detected.platformSource,
      ok: result.ok,
      reason: result.reason,
      payload: result.payload,
    });
    // Burst's human-mode output is "N verdict lines from one command" (H7's
    // done criterion) -- one line per frame -- rather than the generic
    // single-line summary every other subcommand's human mode uses; `--json`
    // still emits the one envelope object, `frames` array included.
    if (flags.burst != null && result.ok && !flags.json) {
      const frames = (result.payload.frames as Array<Record<string, unknown>>) ?? [];
      const lines = frames.map((f) => {
        if (!f.ok) return `frame ${f.index}: FAILED reason=${f.reason}`;
        const elapsed = f.elapsedMs === null ? "n/a" : `${f.elapsedMs}ms`;
        const drift = f.drifted ? " DRIFT(requested " + f.requestedIntervalMs + "ms)" : "";
        return `frame ${f.index}: verdict=${f.verdict} elapsedMs=${elapsed}${drift} thumb=${f.thumb ?? "none"}`;
      });
      const header = `device shot --burst ${result.payload.burst}: platform=${detected.platform ?? "unknown"} ok=true\n`;
      return { exitCode: 0, stdout: header + lines.join("\n") + "\n", stderr: "" };
    }
    return emit(envelope, flags.json, result.ok ? 0 : 2);
  }

  if (subcommand === "status") {
    const result = handleStatus({ detected, flags, env, capture });
    const envelope = makeEnvelope({
      subcommand,
      platform: detected.platform,
      platformSource: detected.platformSource,
      ok: result.ok,
      reason: result.reason,
      payload: result.payload,
    });
    return emit(envelope, flags.json, result.ok ? 0 : 2);
  }

  if (subcommand === "time") {
    const result = handleTime({ detected, flags, env, capture });
    const envelope = makeEnvelope({
      subcommand,
      platform: detected.platform,
      platformSource: detected.platformSource,
      ok: result.ok,
      reason: result.reason,
      payload: result.payload,
    });
    return emit(envelope, flags.json, result.ok ? 0 : 2);
  }

  const envelope = makeEnvelope({
    subcommand,
    platform: detected.platform,
    platformSource: detected.platformSource,
    ok: false,
    reason: `${subcommand}: not implemented yet in the device tool ` +
      `(spec docs/specs/30-device.md)`,
  });
  return emit(envelope, flags.json, 2);
}

// --- script entry -------------------------------------------------------------

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { exitCode, stdout, stderr } = main(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}
