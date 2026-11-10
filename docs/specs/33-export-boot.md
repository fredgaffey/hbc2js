# 33 — Export boot proof: the exported tree starts the app the way the original does

**Status: SPEC.** New subsystem. Acceptance tests ship as `todo` in
`tests/gate/export-boot/`; implementation is L1–L4 (§7). Builds on spec 29
(export tree, `--instrument=modules`) and spec 31 (`equiv --boot`, stub host).
Spec 29 §8 left booting out of scope; this spec owns it.

## 0. Problem

`hbc2js export` produces a tree that installs and bundles (spec 29 §4.6), but
nobody has run it. "Bundles" proves sources transform and resolve; it does not
prove that the same module factories run, in the same order, without throwing,
and that the app registers and starts under the same app key. That is the
finish line, and it needs evidence a gate can produce on every push.

## 1. Choice: headless, under the Hermes VM, against the original as control

Run the **original** and the **exported** app under the real Hermes VM behind
spec 31's recording stub host, project both traces onto a version-independent
**boot projection** (§3), and compare. The original is the control: it runs
under the same stub host, seed and VM, so any stub-host gap shows up on both
sides and cannot be reported as an export bug.

- Original side: the original Metro bundle JS (`index.android.bundle`;
  `decompile()` of the `.hbc` when there is no JS source, flagged as in spec 31).
- Export side: `export --instrument=modules --substitute none` -> `offlineBundle`
  (spec 29 §4.6) -> prelude + bundle concatenated -> **compiled with the pinned
  `hermesc`** -> `hermes -b`. Compiling *after* concatenation is how the
  prelude gets into the bytecode path (spec 31 §1's no-prelude limit applies to
  an already-compiled `.hbc`, not to source we compile ourselves). With no
  `hermesc`, source mode is used and the result reports `exportExec:"source"`.
- Surface: `hbc2js equiv --boot <original> <export-dir>`. When `<b>` is a
  directory holding `EXPORT.json`, `equiv --boot` switches to this projection.
  Library: `src/harness/export-boot.ts` `exportBootProof(original, exportDir, opts)`.

## 2. Rejected alternative: emulator + adb (also as an optional rung)

An emulator boot (install APK, compare logcat or JS traces) is the most faithful
check, but no gate node has a device. It takes minutes per cycle, depends on
timing (logcat interleaving, cold-start jitter), and needs a host APK built
for each RN version. In the gate it would be skipped everywhere. As a "manual
rung" it would be a second definition of "boots" with its own comparison and
fixtures, and that one would go stale. The device tool (spec 30) is still the
manual instrument for looking at a real screen. It is not part of the proof and
its output never feeds a verdict.

## 3. What "boots" means

Phase **B1 (register)** passes iff all of these hold, with the same seed:

1. Both sides reach end of the top-level IIFE (`EndRecord`), with no `ErrRecord`.
2. The **factory sequence** matches exactly: the ordered `enter id` / `exit id`
   events, keyed by the *original* module id (export keeps it, spec 29 §4.4).
   Every entered factory exits without throwing. This catches missing
   run-before-main modules, eager edges that were dropped or added, and
   reordering.
3. The ordered list of `AppRegistry.registerComponent` keys is identical and
   non-empty.
4. Native interactions (`__turboModuleProxy`, `nativeModuleProxy.get`,
   `nativeCallSyncHook`, `nativeLoggingHook` level) **made while a tracked
   factory is on the stack** match in order, up to `--first-native`.

Phase **B2 (run)**: after B1, the host drives
`AppRegistry.runApplication(key, {rootTag: 1, initialProps: {}})` for the first
registered key, the way that RN version's real host does: `RN$AppRegistry` when
it is defined, otherwise `__fbBatchedBridge.callFunctionReturnFlushedQueue`.
Then it drains timers, microtasks and rAF on the virtual clock up to a horizon
`--horizon-ms` (default 1000 *virtual* ms; this is the brief's "first N ms",
counted on the virtual clock so the result is deterministic). B2 passes iff
`runApplication` is reached on both sides with the same key, no fatal reaches
`ErrorUtils`, items 2 and 4 still match over the longer window, and the ordered
**view-name sequence** of `nativeFabricUIManager.createNode` (or
`UIManager.createView`) matches, with at least one `completeRoot`/commit on each
side. Only view names are compared, never props, because props carry app text.

**Not in the projection.** These are excluded on both sides, by one symmetric
rule:

- Raw Metro `__d`/`__r` records. Metro ids and registration order differ by
  construction in a re-bundle.
- Anything that runs outside a tracked factory: Metro polyfills, and the
  installed RN's run-before-main modules on the export side.
- Log text, and timing values (`__HBC_BOOT_TIMING__` `dt`).

**Masking.** Ids whose `EXPORT.json` row is substituted (spec 29 §5) are
removed from the original side's projection and counted in `masked`. The gate
uses `--substitute none`, so `masked` is 0 there.

**Verdicts.** These differ from spec 31 on purpose:

- **EQUIVALENT**: the phase passes.
- **DIVERGENT**: the first projection mismatch, or the *export* threw while the
  original did not. Since the original booted under this stub host, an export
  throw is a real failure, not a stub gap.
- **INCONCLUSIVE**: the *original* threw (a stub-host gap; fix §4.1 of spec 31),
  no VM was found, or a cap was hit. Never PASS.

Exit codes are the same as `equiv`'s (0/1/2/3). JSON `schema: "export-boot/1"`
adds `phase`, `appKeys{a,b}`, `runApplication{a,b}`, `factories{a,b}`,
`masked`, and `exportExec` to spec 31's object.

## 4. Host-stub contract

This is spec 31 §4.1 unchanged, plus three additions:

- (a) The prelude wraps the factory argument of the trapped `__d` on the
  original side so it emits `enter`/`exit`.
- (b) The export registry's `r()` (spec 29 §4.5, under `--instrument=modules`)
  calls `globalThis.__HBC_BOOT_PROBE__(ev, id)` when that hook is defined. The
  prelude defines it, and on a device it stays undefined.
- (c) For B2 only: the virtual-clock drain from `sandbox.ts` (spec 31 records
  schedules only), and recording `nativeFabricUIManager` methods that return
  opaque node handles.

The host must let the bundle install `__fbBatchedBridge`/`RN$AppRegistry`
itself, and only observe them. Native-module methods return recording stubs.
Any code path that depends on a native return value therefore takes the stub
path on *both* sides, which is fine because only the difference is compared.

## 5. Fixtures

- `rn-template-0.72` (committed `index.android.bundle` + `index.android.hbc`):
  B1 and B2, every gate run.
- `react-navigation-example-0.85.3` (`fetch.sh`, HBC v98, bridgeless): B1 and
  B2, sweep tier (`requireSweep`). Source mode on the original side makes the
  missing v98 VM a non-blocker (spec 31 §1). Export side: the v98 `hermesc`.

## 6. Out of scope

- Pixels and visual parity. Assets (spec 29 P-74).
- Real native-module behaviour.
- Network.
- iOS.
- APK packaging, install, signing, emulator and device runs (§2).
- Comparing boot *timing*.
- Correctness of `--substitute safe` beyond masking. A real npm package needs
  `npm install` and cannot bundle offline.
- Anything after the B2 horizon: navigation, user input.

## 7. Implementation landings (estimate: 4)

1. **L1.** Probe hook (§4 a, b), the projection, and B1 compare on rn-template
   in source mode (tests 1–6).
2. **L2.** The `hermesc` compile path for the export side, plus `equiv --boot`
   with an export directory, JSON, and exit codes (tests 7–8).
3. **L3.** B2: drive `runApplication`, the clock drain, and Fabric stubs
   (test 9).
4. **L4.** Held-out app sweep, plus any stub-host additions recorded in spec 31
   §4.2 (test 10).

Expected first finding: export's `index.js` (spec 29 §4.1) requires only the
entry module. The original ends with `__r(<InitializeCore>); __r(0)`, so B1
should diverge at the first `enter` until run-before-main is carried over.

**L1 findings (2026-11-10).** The prediction was half right. The export's
`index.js` required the entry module's *file* only, which registers it
(`__hbc.define`) and runs no factory at all, so the exported tree booted
nothing; it now registers and runs the original's whole top-level `__r`
sequence (`__hbc.r(48); __hbc.r(0)` on rn-template). Two more export bugs
surfaced behind it: 136 of 435 readable modules registered a hoisted
`__hbc_*` runtime helper as their factory (`wrapReadableModule` took the
first function declaration), and the offline check bundled a pre-0.73 tree
with bare `metro-config` defaults, which carry no RN polyfills, so
`global.ErrorUtils` was missing (the RN CLI always adds them; the check now
does too). The stub host needed one addition, on both sides:
`getConstants()` returns an object (DeviceInfo gets fixed `Dimensions`), not
undefined. The original now boots cleanly (107 factories, key
`HelloHermes072`); its own factory throw is treated as INCONCLUSIVE, like a
top-level throw. One divergence remains, and it is a decompile gap, not an
export one: the zero-yield `function* () {}` that RN's module 87 probes with
`hasNativeConstructor` is not recovered to `function*`, so the export
polyfills `regeneratorRuntime` and enters module 82 (docs/BUGS.md). With
that function hand-patched, B1 is EQUIVALENT, so test 1 stays `todo` on that
row and tests 2 to 6 are real. Source mode uses one VM for both sides, the
one matching the bundle's HBC version: the default oldest VM (v84) cannot
parse the BigInt literals decompiled code may contain.

**L1 gap closed (2026-11-10).** The zero-yield generator is now recovered
(docs/BUGS.md export-boot L1, Resolved; construct fixture
`395-generator-no-yield`): module 87's `function* () {}` decompiles to
`function*`, and test 1 is a real test with B1 EQUIVALENT on rn-template.

**L2 (2026-11-10).** The export side is compiled: `findHermesc(version)`
pairs a `hermesc` with a same-version VM (the export's own HBC version first,
else the newest pair), `bootTrace({hermesc})` compiles prelude + bundle with
`-emit-binary` and runs `hermes -b`. No pair, an explicit `--vm`, or
`exportExec:"source"` keeps source mode. A `hermesc` compile failure of the
export is DIVERGENT (the export does not build), not INCONCLUSIVE. rn-template
B1 is EQUIVALENT in bytecode mode (v94; 107 factories each side). `equiv
--boot <original> <export-dir>` switches on `EXPORT.json`, accepts `--phase`,
`--horizon-ms`, `--export-exec`, and prints `export-boot/1` with `--json`.
`offlineBundle` now uses a silent Metro reporter (the banner went to stdout and
broke the JSON) and no watchman (a recrawling watchman cost ~85 s per bundle).

**L3 (2026-11-10).** B2 runs in the same prelude, behind `bootTrace({run:
{horizonMs}})` (absent: B1 and spec 31 traces are unchanged). The host
records the first registered key, then calls `RN$AppRegistry.runApplication`
when the bundle defined it, else
`__fbBatchedBridge.callFunctionReturnFlushedQueue("AppRegistry",
"runApplication", …)`, and observes `AppRegistry.runApplication` itself (the
`registerComponent` hook wraps it too). Timers, intervals, immediates,
microtasks, rAF/idle (next 16 ms frame) and the native `Timing` module's
`createTimer` (fired through `JSTimers.callTimers`) keep their callbacks and
drain on the virtual clock up to the horizon, one macrotask per real VM turn
so the engine's own Promise jobs settle in between. The global ErrorUtils
handler records fatals (`err` phase `run`). UI managers record `ui.view <name>`
for `createView`/`createNode` and `ui.commit` for a Paper
`setChildren`/`manageChildren` on root tag 1 or a Fabric `completeRoot`;
view configs are minimal and node handles opaque. An original that never
reaches `runApplication`, hits a fatal, or commits nothing is INCONCLUSIVE.
One stub gap, fixed on both sides: 0.72's PaperUIManager spreads
`{...NativeUIManager}` at module-eval time, which copied only the methods
read so far, so render found no `setChildren`; the UIManager stub now has its
whole method table up front. rn-template B2 is EQUIVALENT (bytecode export:
key `HelloHermes072`, 99 views, 1 commit, 246 factories each side).

**react-navigation-example by hand (2026-11-10, after L3).** B1 is
INCONCLUSIVE: the original stops on stub-host gaps before it registers its app
key, so nothing about the export is concluded yet. Two gaps are closed on both
sides: a JSI library's `<X>TurboModule.installTurboModule()` now installs a
recording `globalThis.__<x>ModuleProxy` whose methods return opaque host
objects (react-native-worklets), and `ExpoModulesCore.installModules()`
installs a `globalThis.expo` with extendable base classes. With those the
original runs 839 factories (from 485). The next gap (factory 1059, expo
constants) is structural: `nativeModuleProxy` answers every name with a
module, so *optional* native modules (`requireOptionalNativeModule
('ExpoUpdates')`, `NativeModules.EXDevLauncher`) look present and their
constants are functions, and `JSON.parse` of one throws. The fix is a
present/absent native-module list in the stub host (L4, spec 31 §4.2), not a
per-module patch. Test 10 stays `todo`.

**L4, part 1 (2026-11-10).** The stub host now has a native-module presence
manifest (`src/harness/native-manifest.ts`, spec 31 §4.2): present modules
answer with a recording stub whose manifest constants are readable as
properties and from `getConstants()`; absent ones are `undefined` on
`nativeModuleProxy`, `null` from `__turboModuleProxy`, and `undefined` on
`expo.modules`, as on a device where they are not linked. It is derived once
from the original and handed to both sides. With it the held-out original
boots clean: B1 1568 factories, keys `LogBox`, `main`; B2 reaches
`runApplication("main")` (the host now skips RN's own `LogBox` surface,
which registers first) with 1 view and 1 commit. Three export bugs surfaced
and are fixed, each with an `export-boot L4` test: a non-enumerable own
define (v98+ class methods) was rendered non-writable, so MessageQueue's
constructor bind threw (fixture `396-class-method-writable`); `--tier flat`
modules called `__hbc_*` helpers that `helpers.js` did not install; and the
boot timer called the app's `performance` polyfill (a TurboModule call the
original never makes). B1 is still DIVERGENT, on a decompile gap: module 991
fn#11865 loads slot 0 of an environment read out of another environment's
slot, which renders as an `__hbc_unresolved_env` marker and throws under
module 193 (whatwg-fetch); the export enters 85 factories to the original's 1568. Test 10 stays `todo`.

**L4, part 2 (2026-11-10).** Three more fixes, and the held-out app proves.
(1) The module-991 decompile gap is closed: the environment graph tracks a
*closure* held in an environment slot the way it tracks an environment, so
`GetClosureEnvironment` on the value loaded back out of the slot resolves
(fixture `400-inlined-closure-env`). (2) The split's startup scan missed the
app entry: `hermesc -O` materialises the entry id `0` into a register once,
inside a labelled block, and the top-level-only scan dropped the final
`__r(0)`, so the export never ran its entry; the scan now follows a register
set inside a nested block (`tests/gate/split/entry-nested-const.test.ts`).
(3) The `--instrument=modules` timing ring flushed every 256 entries through
`console.log`, a `nativeLoggingHook` call the original never makes, so B1
diverged at the 256th module; the registry stays silent while
`__HBC_BOOT_PROBE__` is defined (`instrument-silent-under-probe.test.ts`).
With those B1 was EQUIVALENT (1568 factories) and B2 died in the run phase
with `TypeError: target is not callable` in React's `prepareFreshStack`:
`root.cancelPendingCommit` was undefined, not null. The cause was a bare v98
`Construct`. Where the optimiser knows the callee of `new`, it allocates
`this` itself (`GetById "prototype"` + `NewObjectWithParent`), moves it
into the frame's `this` slot, and, having proved the constructor returns no
object, keeps using that register with no `SelectObject`. `Construct` runs
the callee *on* that object (BytecodeList.def: "the first argument 'this' is
assumed to be created with CreateThis"); the decompiler lowered it as
`Reflect.construct`, a fresh allocation, so `FiberRootNode` initialised an
object nobody kept. That shape (same block, the stand-in read only by the
moves, callee unchanged since its prototype was read) now lowers to
`this-slot = new C(…)`, every register still holding the stand-in takes the
result, and the `Construct` destination becomes `undefined` (fixture
`410-construct-prebuilt-this`, which needs a ctor too large to inline and
two call sites; v99 emits a different call there). Result, flat tier with
`--substitute none --lenient-env`: B1 and B2 EQUIVALENT (`main`, 1586
factories, 1 view, 1 commit each side). Test 10 is real (sweep tier). It
exports with `--lenient-env`: 87 `__hbc_unresolved_env` markers remain in
the held-out export, and none is reached by boot.
