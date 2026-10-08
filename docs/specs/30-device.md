# 30 — `device`: one JSON line instead of a screenshot, a guess, or a device cycle

**Status: SPEC.** Shared skeleton and cross-cutting
acceptance tests land with this spec.
The three subcommand verdict/measurement halves land as impl items: T3b
(`shot`), T4 (`status`), T6 (`time`). This spec is the contract they slot
into.

## 0. Problem

RN host-app debugging sessions spend most of their tokens on questions a tool
can answer in one line. Reading a screenshot to decide black vs RedBox vs
LogBox vs real content costs 1-2k tokens each. A UI dump taken while the app
is restarting silently returns the *previous* process's tree and reads as
"the fix did nothing". A device is locked, or the deployed bundle is stale,
and the session re-discovers it by hand. Cold-start timing is hand-rolled and
conflates time-to-first-render with time-to-usable. Each is a measurement a committed, tested tool should make
once and print.

## 1. Choice

One committed module, `src/device/device.ts`, wired as `hbc2js device
shot|status|time`. It lives in this repo (not in any one app's own tree) so
it is committed, tested and reviewed. The app and device identity (Android
package + serial, iOS bundle id + simulator udid, both generalised behind a
single `--app` flag) arrives from flags or env and is **never hard-coded** —
nothing app-derived is committed. Every subcommand prints exactly one JSON
object on stdout under `--json` (human text otherwise), and follows the
lane-wide rules:

- **Exit non-zero only when it could not measure** — a real verdict (even
  `black`, even a stale bundle) exits 0; a refusal or a usage/identity failure
  exits 2. The verdict lives in the JSON, never in the exit code (same contract
  as `hbc2js check-bundle`).
- **Never guess.** A field the tool could not obtain is `null` with a `*Source`
  sibling naming why (`entropy: null, entropySource: "capture-failed"`). Every
  nullable field in every contract below has its `*Source` sibling.

The parse/verdict/predicate half is a set of **pure functions** (text or bytes
in, a plain object out) that the command wires filesystem and stdout I/O
around — the same split `src/tooling` uses for the static lane tools. Those
pure functions are exported so the impl items and the gate tests import them.

## 2. Rejected alternative

**Per-app shell scripts.** Rejected:
they are untested and duplicated; each would
duplicate platform detection and the restart-refusal predicate; and — the
deciding reason — they would hard-code an app identity (package name / bundle id),
breaking the "nothing app-derived is committed" rule. Also rejected: **hard-coding the package /
bundle id anywhere in the device tool**, for the same reason; identity is a
flag or an env var, always.

## 3. Subcommand surface and shared flags

```
hbc2js device shot   [flags]   # capture a frame, classify it
hbc2js device status [flags]   # lock / bundle-sha / mode-seed-env / pid / restarting
hbc2js device time  --runs N [flags]   # cold-launch timing medians
```

Shared flags (all optional; identity may instead come from env):

| flag | env | meaning |
|---|---|---|
| `--json` | — | one JSON object on stdout (human text otherwise) |
| `--serial <s>` | `HBC2JS_DEVICE_SERIAL` | Android device serial (`adb -s`) |
| `--udid <u>` | `HBC2JS_DEVICE_UDID` | iOS simulator udid (`simctl`) |
| `--app <id>` | `HBC2JS_DEVICE_APP` | application identity: Android package id or iOS bundle id |
| `--package <id>` | — | alias for `--app` (Android) |
| `--bundle-id <id>` | — | alias for `--app` (iOS) |
| `--platform android\|ios` | `HBC2JS_DEVICE_PLATFORM` | override auto-detection |
| `--seam <path>` | `HBC2JS_DEVICE_SEAM` | optional app-provided status file |
| `--runs <N>` | — | `time` only: number of cold launches |

### 3.1 Platform detection

A flag/env `--serial` pins Android; `--udid` pins iOS; `--platform` forces the
choice. Otherwise the tool auto-detects from recorded-parseable command text:

- **Android** via `adb devices -l`: exactly one line in state `device` gives
  that serial (`platformSource: "single-adb-device"`); zero →
  `"no-adb-device"`; more than one → `"multiple-adb-devices"` (ambiguous, no
  serial).
- **iOS** via `xcrun simctl list devices`: exactly one `(Booted)` line gives
  its udid (`"single-booted-sim"`); zero → `"no-booted-sim"`; more than one →
  `"multiple-booted-sims"`.

If exactly one platform resolves, that is the platform. If both resolve →
`platform: null, platformSource: "both-android-and-ios-present"` (caller must
pass `--platform`). If neither → `platform: null, platformSource:
"no-device-detected"`. The `serial`/`serialSource`/`udid`/`udidSource` siblings
are always present. The parsers (`parseAdbDevices`, `parseSimctlDevices`) and
the resolver (`detectAndroidSerial`, `detectIosUdid`, `detectPlatform`) are
pure: they take the command's text, so the gate tests run them on recorded
fixtures with no device attached.

## 4. The JSON envelope

Every subcommand's object shares an envelope, built by the exported
`makeEnvelope`:

```json
{ "schema": "device/1", "tool": "device", "subcommand": "shot",
  "platform": "android", "platformSource": "single-adb-device",
  "ok": true, "reason": null, "...": "subcommand payload fields" }
```

`ok` is `true` iff the subcommand measured; `reason` is `null` unless it
refused or could not measure (then `ok:false` and the process exits 2).

## 5. The three contracts (field by field)

Every nullable field carries a `*Source` sibling. The verdict/measurement of
these fields is the impl item's job; this spec fixes the field list and null
rule so the three impls agree.

### 5.1 `shot` (impl T3b)

| field | type | note |
|---|---|---|
| `verdict` | `"black"\|"uniform"\|"redbox"\|"logbox"\|"content"\|null` | `black` = uniform ~0 luminance; `uniform` = single colour, not black; `redbox`/`logbox` = the RN error/warn overlay colour signatures (impl documents thresholds); `content` = none of these |
| `entropy` | number 0-1 \| null | normalised frame entropy the verdict is derived from |
| `text` | string \| null | Android: `uiautomator` dump; iOS: accessibility dump if available, else `null` with `textSource` |
| `thumb` | path \| null | a 160-px-wide downscale of the frame |
| `capturePath` | path \| null | the captured PNG; names *which* capture path produced the frame (a black frame from `screencap` is a verdict, never "app crashed" — Gotcha) |

### 5.2 `status` (impl T4)

| field | type | note |
|---|---|---|
| `locked` | boolean \| null | device lock state |
| `bundleSha` | string \| null | sha256 of the *deployed* bundle |
| `expectedBundleSha` | string \| null | sha256 of the just-built bundle (path flag); `bundleMatches` derives from the pair |
| `bundleMatches` | boolean \| null | deployed == expected |
| `mode` / `seed` / `env` | string \| null | read from the app-provided status file (`--seam`), never invented |
| `pid` | number \| null | the app process id |
| `startTime` | string \| null | process start time |
| `restarting` | boolean \| null | pid changed within the last N seconds, or no pid yet (a dump now would read the previous process) |

### 5.3 `time` (impl T6)

Per metric a median and a spread over `--runs N` real cold launches
(force-stop, clear from recents, launch). Markers come from the host app, not
from the device tool.

| field | type | note |
|---|---|---|
| `runs` | number | requested run count |
| `launch` / `launchSpread` | number ms \| null | launch marker median and spread |
| `firstContentCommit` / `firstContentCommitSpread` | number ms \| null | first content commit |
| `interactive` / `interactiveSpread` | number ms \| null | interactive; a run that cannot see the interactive marker reports `interactive: null`, **never** the first-render number ("time-to-usable, never time-to-first-render") |
| `perRun` | array \| null | raw per-run `{launch, firstContentCommit, interactive}` timestamps |

## 6. Refusal semantics — one shared predicate

`shot` and `time` must not capture while the app is restarting: the frame or
the markers would come from the previous process. Both call the exported pure
predicate `refusalForStatus(status)` on a `status` object and refuse (exit 2,
`ok:false`, `reason` set) when it returns `{refuse:true}`:

- `status.restarting === true` → refuse (`reason` names the pid).
- `status` is missing/unusable → refuse (cannot confirm not-restarting).
- otherwise → `{refuse:false, reason:null}`.

The predicate is pure and shared so `shot` and `time` refuse identically; the
gate tests exercise it on a recorded restarting `status` and a recorded steady
one.

## 7. The recorded-fixture test pattern

Fixtures live under `tests/fixtures/device/`: recorded device output —
`adb devices -l` text, `xcrun simctl list devices` text, recorded `status`
JSON, and (for T3b) representative PNGs per verdict class. A gate test feeds a
recorded blob through the same pure parse/verdict/predicate function the
command uses and asserts the result. **The capture half — actually shelling to
`adb`/`simctl` — is verified by hand by the runner on a connected device or
simulator and is NEVER exercised in the gate** (no CI node has a device; a
simulator is not present in CI). This is why every classifier is a pure
function of already-captured bytes/text: the expensive, non-reproducible half
is isolated at the edge.

## 8. Acceptance criteria

The cross-cutting criteria (this spec's skeleton) ship green now, as
`tests/gate/device/device.test.ts`:

- **AC-P (platform detection).** `detectAndroidSerial` on a recorded one-device
  `adb devices -l` → that serial + `single-adb-device`; on none → `null` +
  `no-adb-device`; on two → `null` + `multiple-adb-devices`. `detectIosUdid` on
  a recorded booted `simctl list` → that udid + `single-booted-sim`; on none →
  `null` + `no-booted-sim`. `detectPlatform` picks the single resolving
  platform, returns `null` + a `*Source` when neither or both resolve, and an
  explicit `--serial` pins android with `flag-or-env`.
- **AC-E (envelope).** `makeEnvelope` produces `schema:"device/1"`, `tool`,
  `subcommand`, `platform`, `platformSource`, `ok`, `reason`, and merges the
  payload.
- **AC-R (refusal).** `refusalForStatus` on a recorded restarting `status` →
  `{refuse:true}` with a reason; on a steady one → `{refuse:false}`. `main`
  routes a not-yet-measurable subcommand to exit 2 with `ok:false` and a
  `reason` (never a faked measurement).

Each remaining criterion becomes an executable recorded-fixture gate test when
its impl item lands (so the gate stays green and `docs/test-count-baseline.json`
only ever rises):

- **AC-shot (T3b).** Recorded PNGs, one per verdict class, classify to
  `black`/`uniform`/`redbox`/`logbox`/`content` with the documented thresholds;
  `entropy` in 0-1; `text`/`thumb`/`capturePath` populated or `null` with a
  `*Source`; a black frame is `verdict:"black"`, not a crash; exit 0.
- **AC-status (T4).** `locked`, `bundleSha` vs `expectedBundleSha` →
  `bundleMatches`, `mode`/`seed`/`env` from the seam file, `pid`/`startTime`,
  `restarting`; each null-or-`*Source`; exit 0.
- **AC-time (T6).** `--runs N` yields `launch`/`firstContentCommit`/
  `interactive` medians + spreads with `perRun`; a missing interactive marker
  gives `interactive:null` not the first-render number; refuses (exit 2) when
  `status.restarting`.

## 9. What the impl items must honour

- Import the pure functions from `src/device/device.ts`
  (`detectPlatform`, `refusalForStatus`, `makeEnvelope`, the parsers); do not
  re-derive platform detection or the envelope.
- Replace the subcommand's not-implemented handler (which today returns
  `ok:false, reason:"...not implemented..."`, exit 2) with the real classifier.
  Keep the null+`*Source` rule for every field.
- `shot` and `time` must call `status` (or accept a `status` object) and gate on
  `refusalForStatus` before capturing.
- Fixtures go under `tests/fixtures/device/`; add the executable
  criterion above as a recorded-fixture gate test and bump the baseline in the
  same commit. Never exercise real capture in the gate.
