// docs/specs/31-equiv-boot.md — `equiv --boot`: a whole-bundle boot-trace
// oracle. A new MODE of this harness, not a new tool (see the spec's §0-§1).
//
// Mechanism (spec §1, §3.2): the Hermes CLI has no injectable prelude for the
// `-b` (bytecode) path, and the stub host below must run *before* the
// bundle's top-level IIFE. So this always runs `hermes <file.js>` in SOURCE
// mode on `preludeSource + "\n" + bundleSource` — never `hermes -b`, even
// when the input was originally a `.hbc` (in which case `decompile()` stands
// in for the missing source, flagged `sourceKind:"decompiled"`).
//
// The prelude has no out-of-band channel back to this process (source mode
// only has stdout/stderr), so it JSON-encodes each `trace.ts` record onto one
// `print()` line prefixed with `TRACE_PREFIX`, and `bootTrace` parses that
// NDJSON-shaped stream back into `TraceRecord`s — the same one-record-per-line
// contract `runner.ts` already uses for the Node sandbox's child process.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { decompile } from "../decompile.ts";
import { NO_VM_HELP, findAllHermesVms, runHermes } from "./hermes-vm.ts";
import type { HermesRunResult, HermesVm } from "./hermes-vm.ts";
import { TRACE_VERDICT, compareTraces } from "./compare.ts";
import type { TraceComparison, TraceVerdict } from "./compare.ts";
import type { ErrRecord, Trace, TraceRecord } from "./trace.ts";
import { PROMISE_METHODS, type NativeManifest } from "./native-manifest.ts";

/** §3, §5: default cap on recorded native-module interactions per side. */
export const DEFAULT_FIRST_NATIVE = 64;

/** The line prefix the prelude's `emit` uses so its NDJSON trace lines are
 *  distinguishable, on the real stdout, from anything the bundle itself
 *  prints via a stub the prelude did not route through `emit` (there should
 *  be none, but a stray `print()` call in bundle code must never be
 *  mistaken for a trace record). */
const TRACE_PREFIX = "@@HBCBOOT@@";

export type BootSourceKind = "bundle-js" | "decompiled";

export interface AcquiredBootSource {
  readonly source: string;
  readonly sourceKind: BootSourceKind;
}

/** Spec §8 "source acquisition": `.hbc` goes through `decompile()` (lower
 *  fidelity, flagged); `.js`/`.bundle` passes through unchanged (faithful —
 *  it is the Metro combined-bundle text itself). */
export function acquireBootSource(inputPath: string, opts: { readonly lenientEnv?: boolean } = {}): AcquiredBootSource {
  if (inputPath.endsWith(".hbc")) {
    const bytes = readFileSync(inputPath);
    // Spec 33 apps: an HBC-only original (no Metro text shipped) with
    // unresolved environment reads decompiles with markers when asked; a
    // marker reached at boot throws, which the proof reads as INCONCLUSIVE.
    const result = decompile(new Uint8Array(bytes), opts.lenientEnv === true ? { strictEnv: false } : {});
    return { source: result.code, sourceKind: "decompiled" };
  }
  return { source: readFileSync(inputPath, "utf8"), sourceKind: "bundle-js" };
}

export interface BootTraceOptions {
  readonly seed?: number;
  readonly firstNative?: number;
  /** Override VM discovery (`--vm <path>`); source mode, so the HBC version
   *  of the VM is irrelevant (spec §1 item 1). */
  readonly vm?: string;
  readonly timeoutMs?: number;
  /** Spec 33 §4(a): wrap every factory the trapped `__d` registers so it
   *  reports `enter`/`exit`/`throw` through `__HBC_BOOT_PROBE__`. Default
   *  true (the original side). The export side of `export-boot.ts` passes
   *  false: there `__d` carries Metro's re-bundle ids, and the export's own
   *  registry calls the probe with original ids instead (§4(b)). */
  readonly wrapFactories?: boolean;
  /** Spec 33 §1 (L2): compile prelude+bundle with this `hermesc` and run the
   *  result with `hermes -b` instead of source mode. Compiling *after*
   *  concatenation is how the prelude reaches the bytecode path (the no-
   *  prelude limit above applies to an already-compiled `.hbc`). `vm` must
   *  then be a VM of the same HBC version as this compiler. */
  readonly hermesc?: string;
  /** Spec 33 §3 B2: after the boot, drive runApplication and drain the
   *  virtual clock to `horizonMs`. Absent: B1 / spec 31 behaviour. */
  readonly run?: BootRunOptions;
  /** Spec 31 §4.2 / spec 33 L4: the native-module presence manifest
   *  (`native-manifest.ts`). Absent: the open host, where every name is a
   *  present module with no constants beyond `hostConstants`. A comparison
   *  passes the SAME manifest (derived from the original) to both sides. */
  readonly natives?: NativeManifest;
  /** Where to resolve Babel from when the source needs class-syntax
   *  lowering (an export tree's directory); hbc2js's own install otherwise. */
  readonly lowerFrom?: string;
}

export interface BootRunOptions {
  readonly horizonMs: number;
}

export interface BootTraceResult {
  readonly trace: Trace;
  /** True iff the trace contains an `EndRecord` — the bundle's top-level IIFE
   *  ran to completion under the stub host (spec §4.1's "natural stopping
   *  point"). */
  readonly reachedEnd: boolean;
  /** Set iff the boot threw before `EndRecord` — the `ErrRecord{phase:"boot"}`
   *  the prelude emitted from its outer `catch`. */
  readonly bootError: { readonly name: string; readonly message: string } | null;
  /** Null when no Hermes VM could be discovered at all (HA-05: never a
   *  silent fallback to another engine). */
  readonly vm: HermesVm | null;
  /** False when the Hermes process could not be made to run the prelude+
   *  source at all (e.g. a syntax error in the concatenated file) — distinct
   *  from `reachedEnd === false`, which means it ran but the *bundle* threw. */
  readonly ran: boolean;
  /** Human-readable reason, set whenever `vm === null` or `ran === false`. */
  readonly why: string | null;
  readonly raw?: HermesRunResult;
  /** True when the bundle's class private members were lowered first
   *  because the parsing engine lacks them (see `lowerClassSyntax`). */
  readonly lowered?: boolean;
}

function resolveVm(override: string | undefined): HermesVm | null {
  if (override !== undefined) return { hbcVersion: 0, path: override };
  const vms = findAllHermesVms();
  return vms[0] ?? null;
}

function parseTraceLines(stdout: string): TraceRecord[] {
  const out: TraceRecord[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(TRACE_PREFIX)) continue;
    try {
      out.push(JSON.parse(line.slice(TRACE_PREFIX.length)) as TraceRecord);
    } catch {
      // A partial/truncated final line is expected on a timeout kill.
    }
  }
  return out;
}

function excerpt(s: string): string {
  // Hermes prints compiler warnings (undeclared globals in the prelude) before
  // the error that matters; start the excerpt at the first error.
  const err = s.search(/^.*: error: /m);
  const t = (err > 0 ? s.slice(err) : s).trim();
  return t.length > 300 ? t.slice(0, 300) + "…" : t;
}

/** The recording stub-host prelude (spec §4.1) as Hermes source, plus the
 *  `__d`/`__r`/`__c`/`__registerSegment` set-traps (spec §5) that intercept
 *  Metro's require runtime the moment the bundle assigns it onto
 *  `globalThis`. Everything the prelude owns lives inside one IIFE so it
 *  cannot collide with a top-level `var` the bundle itself declares; only the
 *  specific global names spec §4.1 lists, plus the two boot-orchestration
 *  hooks `__hbcBootEnd`/`__hbcBootErr`, are left on `globalThis`. */
function buildPrelude(seed: number, firstNative: number, wrapFactories: boolean, run: BootRunOptions | null, natives: NativeManifest | null): string {
  return `
(function () {
  "use strict";
  // Spec 31 §4.2 (L4): present native modules -> their constants; null is
  // the open host (every name present).
  var __hbcNatives = ${JSON.stringify(natives === null ? null : natives.present)};
  function present(n) { return __hbcNatives === null || Object.prototype.hasOwnProperty.call(__hbcNatives, n); }
  // Spec 33 apps stub-host addition (spec 31 §4.2): Android's Hermes ships
  // \`Intl\`; the host VMs here are built without it. An empty namespace lets
  // an app's formatjs polyfills (\`defineProperty(Intl, 'Locale', …)\`)
  // install themselves at module eval, as they would on a device that
  // lacks the piece they polyfill.
  // \`getCanonicalLocales\` is the one primitive those polyfills build on
  // (a structurally valid tag comes back as itself).
  if (typeof globalThis.Intl === "undefined") {
    // Hermes's own Intl (Android) also has Collator, DateTimeFormat and
    // NumberFormat, which apps construct at render time; deterministic
    // en-US/UTC stand-ins, identical on both sides.
    var canon = function (l) { return l === undefined ? [] : (Array.isArray(l) ? l : [l]).map(String); };
    var intlClass = function (resolved, methods) {
      var C = function (locales, options) {
        if (!(this instanceof C)) return new C(locales, options);
        this.__o = options || {};
      };
      C.supportedLocalesOf = function (l) { return canon(l); };
      C.prototype.resolvedOptions = function () { var r = {}; for (var k in this.__o) r[k] = this.__o[k]; for (var j in resolved) r[j] = resolved[j]; return r; };
      for (var m in methods) C.prototype[m] = methods[m];
      return C;
    };
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var fmtDate = function (d) { var t = d === undefined ? new Date(0) : new Date(d); return isNaN(t.getTime()) ? "Invalid Date" : (t.getUTCMonth() + 1) + "/" + t.getUTCDate() + "/" + t.getUTCFullYear() + ", " + pad(t.getUTCHours()) + ":" + pad(t.getUTCMinutes()); };
    globalThis.Intl = {
      getCanonicalLocales: canon,
      Collator: intlClass({ locale: "en-US", usage: "sort", sensitivity: "variant" }, { compare: function (a, b) { a = String(a); b = String(b); return a < b ? -1 : a > b ? 1 : 0; } }),
      NumberFormat: intlClass({ locale: "en-US", numberingSystem: "latn" }, {
        format: function (n) { return String(n); },
        formatToParts: function (n) { return [{ type: "integer", value: String(n) }]; },
      }),
      DateTimeFormat: intlClass({ locale: "en-US", calendar: "gregory", numberingSystem: "latn", timeZone: "UTC" }, {
        format: fmtDate,
        formatToParts: function (d) { return [{ type: "literal", value: fmtDate(d) }]; },
      }),
    };
  }
  var __hbcPromises = ${JSON.stringify(PROMISE_METHODS)};
  function consts(n) { return __hbcNatives !== null && Object.prototype.hasOwnProperty.call(__hbcNatives, n) ? __hbcNatives[n] : null; }
  // Spec 33 §3 B2 / §4(c): null in B1 (schedules are only recorded, as in
  // spec 31); in B2 the host keeps callbacks and drains them on the virtual
  // clock after driving runApplication.
  var __hbcRun = ${JSON.stringify(run)};
  var __hbcRealSetTimeout = typeof globalThis.setTimeout === "function" ? globalThis.setTimeout : null;
  var __hbcKeys = [];
  var __hbcQueue = [];
  var __hbcMicro = [];
  var __hbcSeed = ${JSON.stringify(seed)};
  var __hbcFirstNative = ${JSON.stringify(firstNative)};
  var __hbcNativeCount = 0;
  var __hbcNativeLimited = false;
  var __hbcRealPrint = globalThis.print;
  var __hbcWrapFactories = ${JSON.stringify(wrapFactories)};
  // Debug aid (HBC2JS_BOOT_STACK=1): a factory throw's record carries the
  // error's stack too, to locate the throwing source line. Off by default so
  // traces stay byte-identical across runs.
  var __hbcThrowStack = ${JSON.stringify(process.env.HBC2JS_BOOT_STACK === "1")};

  function emit(rec) {
    var line;
    try {
      line = JSON.stringify(rec);
    } catch (e) {
      line = JSON.stringify({ k: "err", phase: "boot", name: "TraceEncodeError", message: String(e) });
    }
    __hbcRealPrint("${TRACE_PREFIX}" + line);
  }

  function enc(v) {
    try {
      if (v === undefined) return "undefined";
      if (typeof v === "function") return "[Function]";
      var s = JSON.stringify(v);
      return s === undefined ? String(v) : s;
    } catch (e) {
      try {
        return String(v);
      } catch (e2) {
        return "<unencodable>";
      }
    }
  }

  function callRecord(fn, args, throwsVal) {
    emit({ k: "call", fn: fn, args: args, ret: undefined, throws: throwsVal });
  }

  // First-N native-interaction cap (spec §3, §5): everything routed through
  // this gate counts against it; \`__d\`/\`__r\`/timers never do.
  function nativeGate() {
    if (__hbcNativeCount >= __hbcFirstNative) {
      if (!__hbcNativeLimited) {
        __hbcNativeLimited = true;
        emit({ k: "limit", why: "first-native" });
      }
      return false;
    }
    __hbcNativeCount++;
    return true;
  }

  // A recording stand-in for a native-module-shaped object: every property
  // read returns a further recording no-op function (so chained/optional
  // native-module access never throws), and every write is a \`hostset\`.
  // Spec 33 L3 stub-host addition (spec 31 §4.2): RN 0.72's PaperUIManager
  // builds its UIManager as \`{...NativeUIManager}\` at module-eval time, and
  // spreading a lazy stub copies only the methods read so far, so render
  // later found no \`setChildren\`. A real native module has its whole method
  // table up front; the UIManager stub now does too (no records: the
  // methods are only materialised, not called).
  var UI_MANAGER_METHODS = ["getConstants", "createView", "updateView", "setChildren", "manageChildren", "removeSubviewsFromContainerWithID", "replaceExistingNonRootView", "measure", "measureInWindow", "measureLayout", "measureLayoutRelativeToParent", "findSubviewIn", "dispatchViewManagerCommand", "setJSResponder", "clearJSResponder", "configureNextLayoutAnimation", "blur", "focus", "getConstantsForViewManager", "getDefaultEventTypes", "lazilyLoadView", "setLayoutAnimationEnabledExperimental", "sendAccessibilityEvent", "showPopupMenu", "dismissPopupMenu"];
  // \`jsi\`: a JSI host object (installed by installTurboModule below); its
  // methods return further opaque host objects (serializables, runtime
  // holders), never undefined, as the native side does.
  function expoStub() {
    var classes = Object.create(null);
    var others = Object.create(null);
    return new Proxy(Object.create(null), {
      get: function (t, p) {
        if (typeof p === "symbol" || p === "then") return undefined;
        if (/^[A-Z]/.test(p)) {
          if (!(p in classes)) {
            var C = function () {};
            C.prototype.addListener = function () { return { remove: function () {} }; };
            C.prototype.removeListener = function () {};
            C.prototype.removeAllListeners = function () {};
            C.prototype.emit = function () {};
            C.prototype.listenerCount = function () { return 0; };
            classes[p] = C;
          }
          return classes[p];
        }
        if (p === "modules" && __hbcNatives !== null) {
          if (!("modules" in others)) others.modules = expoModules();
          return others.modules;
        }
        if (!(p in others)) others[p] = hostStub("expo." + p, true);
        return others[p];
      },
      has: function () { return true; },
    });
  }
  // \`globalThis.expo.modules\` under a manifest: present names only.
  function expoModules() {
    var made = Object.create(null);
    return new Proxy(Object.create(null), {
      get: function (t, p) {
        if (typeof p === "symbol" || !present(p)) return undefined;
        if (!(p in made)) made[p] = hostStub("expo.modules." + p, true, consts(p));
        return made[p];
      },
      has: function (t, p) { return typeof p === "string" && present(p); },
    });
  }
  // \`fnLike\`: a startup JSI global's values (manifest \`jsiGlobals\`) may be
  // host functions (reanimated 2's makeShareable(worklet), then called), so
  // the stub and what its methods return are callable, recording the call.
  function hostStub(name, jsi, cs, fnLike) {
    var backing = fnLike === true ? function () {} : Object.create(null);
    // Stub-host addition (spec 31 §4.2): a device's native module carries
    // its constants as OWN enumerable properties, so \`{ ...NativeModule }\`
    // and Object.keys see them (expo-constants builds \`Constants\` by
    // spreading ExponentConstants; served only through \`get\` they spread to
    // {} and \`executionEnvironment\` read undefined). A per-stub copy.
    if (cs) for (var ck in cs) if (Object.prototype.hasOwnProperty.call(cs, ck) && ck !== "getConstants") backing[ck] = cs[ck] === undefined ? undefined : JSON.parse(JSON.stringify(cs[ck]));
    var proxy = new Proxy(backing, {
      apply: function () {
        if (nativeGate()) callRecord(name + "()", [], undefined);
        return hostStub(name + "()", true, undefined, true);
      },
      get: function (t, p) {
        if (p === Symbol.toPrimitive) return function () { return "[hoststub " + name + "]"; };
        if (p === Symbol.toStringTag) return "HostStub";
        if (typeof p === "symbol") return undefined;
        if (p === "then") return undefined;
        if (p in t) return t[p];
        // Manifest constants read as properties (legacy bridge modules and
        // Expo modules expose them so); getConstants() returns them too.
        if (cs && p !== "getConstants" && Object.prototype.hasOwnProperty.call(cs, p)) return cs[p];
        var child = function () {
          if (nativeGate()) callRecord(name + "." + String(p), [], undefined);
          if (__hbcRun !== null) {
            var hooked = runHook(name, String(p), Array.prototype.slice.call(arguments));
            if (hooked !== null) return hooked.v;
          }
          // Spec 33 L1 stub-host addition (spec 31 §4.2): getConstants()
          // returns an object (see hostConstants), not undefined.
          if (p === "getConstants") return cs ? JSON.parse(JSON.stringify(cs)) : hostConstants(name);
          // Spec 33 apps stub-host addition (spec 31 §4.2): a device's
          // promise methods (PROMISE_METHODS) resolve, on both sides.
          var pmod = __hbcPromises[name.slice(name.lastIndexOf(".") + 1)];
          if (pmod && Object.prototype.hasOwnProperty.call(pmod, p)) return Promise.resolve(pmod[p]);
          // Spec 33 stub-host addition (spec 31 §4.2): a JSI library's
          // \`<X>TurboModule.installTurboModule()\` (worklets, reanimated)
          // natively installs \`globalThis.__<x>ModuleProxy\`, which the
          // library reads next; stand in a recording stub for it.
          if (p === "installTurboModule") {
            var m = /\.([A-Za-z]+?)(?:TurboModule|Module)$/.exec(name);
            if (m !== null) {
              var g = "__" + m[1].charAt(0).toLowerCase() + m[1].slice(1) + "ModuleProxy";
              if (globalThis[g] === undefined) globalThis[g] = hostStub(g, true);
            }
          }
          // Likewise expo-modules-core's \`ExpoModulesCore.installModules()\`
          // installs the JSI \`globalThis.expo\`: capitalised members are
          // extendable base classes (EventEmitter, NativeModule, SharedObject,
          // ...) with no-op listener methods; the rest are JSI host stubs.
          if (p === "installModules" && /ExpoModulesCore$/.test(name) && globalThis.expo === undefined) globalThis.expo = expoStub();
          // react-native-nitro-modules: \`NitroModules.install()\` installs the
          // JSI \`globalThis.NitroModulesProxy\` (createHybridObject, box, ...),
          // which the library reads back at once (spec 33 apps).
          if (p === "install" && /\.NitroModules$/.test(name) && globalThis.NitroModulesProxy === undefined) globalThis.NitroModulesProxy = hostStub("NitroModulesProxy", true);
          if (jsi === true) return hostStub(name + "." + String(p) + "()", true, undefined, fnLike);
          return undefined;
        };
        t[p] = child;
        return child;
      },
      set: function (t, p, v) {
        if (typeof p !== "symbol") emit({ k: "hostset", o: name, p: String(p), v: enc(v) });
        t[p] = v;
        return true;
      },
      has: function () {
        return true;
      },
    });
    if (/UIManager$/.test(name) && name !== "nativeFabricUIManager") for (var m = 0; m < UI_MANAGER_METHODS.length; m++) void proxy[UI_MANAGER_METHODS[m]];
    return proxy;
  }

  // Spec 33 §4(c), B2 only: the recording UI-manager stubs and the native
  // Timing module. View NAMES are recorded, never props (they carry app
  // text). A Paper commit is a setChildren/manageChildren on the root tag;
  // a Fabric commit is completeRoot. Node handles are opaque objects.
  // getConstantsForViewManager/getViewManagerConfig return a minimal view
  // config (no NativeProps), so requireNativeComponent resolves on both
  // sides alike. Returns null when the call is not hooked.
  var __hbcRootTag = 1;
  function viewConfig() {
    return { NativeProps: {}, bubblingEventTypes: {}, directEventTypes: {}, Commands: {}, Constants: {} };
  }
  function runHook(name, p, a) {
    if (/UIManager$/.test(name) || name === "nativeFabricUIManager") {
      if (p === "createView" || p === "createNode") {
        emit({ k: "call", fn: "ui.view", args: [String(a[1])], ret: undefined, throws: undefined });
        return { v: p === "createNode" ? { __hbcNode: a[0] } : undefined };
      }
      if (p === "cloneNode" || p === "cloneNodeWithNewChildren" || p === "cloneNodeWithNewProps" || p === "cloneNodeWithNewChildrenAndProps") return { v: { __hbcNode: a[0] !== null && typeof a[0] === "object" ? a[0].__hbcNode : undefined } };
      if (p === "createChildSet") return { v: [] };
      if (p === "appendChildToSet") { if (Array.isArray(a[0])) a[0].push(a[1]); return { v: undefined }; }
      if (p === "completeRoot" || ((p === "setChildren" || p === "manageChildren") && a[0] === __hbcRootTag)) {
        emit({ k: "call", fn: "ui.commit", args: [p], ret: undefined, throws: undefined });
        return { v: undefined };
      }
      if (p === "getConstantsForViewManager" || p === "getViewManagerConfig") return { v: viewConfig() };
      return null;
    }
    if (/Timing$/.test(name)) {
      if (p === "createTimer") {
        var d = Number(a[1]) || 0;
        __hbcQueue.push({ id: ++__hbcTimerSeq, at: __hbcVirtualNow + Math.max(0, d), rn: a[0], fn: null, args: [], every: a[3] === true ? Math.max(1, d) : 0, dead: false });
        return { v: undefined };
      }
      if (p === "deleteTimer") {
        for (var i = 0; i < __hbcQueue.length; i++) if (__hbcQueue[i].rn === a[0]) __hbcQueue[i].dead = true;
        return { v: undefined };
      }
    }
    return null;
  }

  // Spec 33 L1 stub-host addition (spec 31 §4.2). RN reads native-module
  // constants unguarded at module-eval time (0.72: PaperUIManager reads
  // .ViewManagerNames, Dimensions reads DeviceInfo's .Dimensions.screen), so
  // a getConstants() returning undefined made those modules throw on BOTH
  // sides. Fixed, app-independent values; an unknown module gets {}.
  function hostConstants(name) {
    var dims = function () { return { width: 1080, height: 2340, scale: 2.75, fontScale: 1, densityDpi: 440 }; };
    if (/DeviceInfo$/.test(name)) return { Dimensions: { window: dims(), screen: dims(), windowPhysicalPixels: dims(), screenPhysicalPixels: dims() } };
    return {};
  }

  globalThis.global = globalThis;
  // Stub-host addition (spec 31 §4.2): JSI globals a native package installs
  // at startup (manifest \`jsiGlobals\`, reanimated 2's
  // \`__reanimatedModuleProxy\`, corpus a08) are recording host objects.
  var __hbcJsiGlobals = ${JSON.stringify(natives === null ? [] : (natives.jsiGlobals ?? []))};
  for (var __hbcJi = 0; __hbcJi < __hbcJsiGlobals.length; __hbcJi++) if (globalThis[__hbcJsiGlobals[__hbcJi]] === undefined) globalThis[__hbcJsiGlobals[__hbcJi]] = hostStub(__hbcJsiGlobals[__hbcJi], true, undefined, true);

  // VM stand-in (spec 31 §4.2): the Hermes RN ships since 0.74 has a native
  // UTF-8 TextEncoder that bundles read bare (Expo's runtime builds
  // TextDecoder/TextEncoderStream on it); the standalone Hermes CLIs used
  // here may lack it. Installed only when absent, identically on both sides.
  if (typeof globalThis.TextEncoder === "undefined") {
    var __hbcUtf8 = function (str, out, max) {
      var read = 0, written = 0;
      for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i), units = 1;
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
          var d = str.charCodeAt(i + 1);
          if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); units = 2; }
        }
        if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
        var bytes = c < 0x80 ? [c] : c < 0x800 ? [0xc0 | (c >> 6), 0x80 | (c & 63)] : c < 0x10000 ? [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)] : [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
        if (written + bytes.length > max) break;
        for (var b = 0; b < bytes.length; b++) out[written++] = bytes[b];
        read += units;
        i += units - 1;
      }
      return { read: read, written: written };
    };
    var HbcTextEncoder = function TextEncoder() {};
    Object.defineProperty(HbcTextEncoder.prototype, "encoding", { configurable: true, get: function () { return "utf-8"; } });
    HbcTextEncoder.prototype.encode = function encode(input) {
      var str = input === undefined ? "" : String(input);
      var tmp = [];
      __hbcUtf8(str, tmp, Infinity);
      return new Uint8Array(tmp);
    };
    HbcTextEncoder.prototype.encodeInto = function encodeInto(input, dest) {
      return __hbcUtf8(String(input), dest, dest.length);
    };
    Object.defineProperty(globalThis, "TextEncoder", { configurable: true, writable: true, enumerable: false, value: HbcTextEncoder });
  }

  globalThis.nativeLoggingHook = function (msg, level) {
    // msg is not recorded: it carries app text (spec §5 table).
    if (nativeGate()) callRecord("nativeLoggingHook", [enc(level)], undefined);
  };

  globalThis.__turboModuleProxy = function (name) {
    if (nativeGate()) callRecord("__turboModuleProxy", [enc(name)], undefined);
    if (!present(String(name))) return null;
    return hostStub("turboModule." + String(name), false, consts(String(name)));
  };

  globalThis.nativeModuleProxy = new Proxy(Object.create(null), {
    get: function (t, p) {
      if (typeof p === "symbol") return undefined;
      if (nativeGate()) callRecord("nativeModuleProxy.get", [String(p)], undefined);
      if (p in t) return t[p];
      if (!present(p)) return undefined;
      var stub = hostStub("nativeModule." + String(p), false, consts(p));
      t[p] = stub;
      return stub;
    },
    has: function (t, p) {
      return typeof p === "string" && present(p);
    },
  });

  globalThis.nativeCallSyncHook = function () {
    if (nativeGate()) callRecord("nativeCallSyncHook", [], undefined);
    return undefined;
  };

  globalThis.nativeFabricUIManager = hostStub("nativeFabricUIManager");
  globalThis.__fbBatchedBridge = hostStub("__fbBatchedBridge");

  var __hbcVirtualNow = 0;
  globalThis.nativePerformanceNow = function () {
    return __hbcVirtualNow;
  };
  globalThis.performance = { now: function () { return __hbcVirtualNow; } };

  globalThis.__fbGenNativeModule = function () {
    if (nativeGate()) callRecord("__fbGenNativeModule", [], undefined);
    return undefined;
  };

  // Timers/rAF/idle-callback are recorded as *schedules only* (spec §4.1's
  // "no view host / no renderer / no screen" stopping point means end-of-IIFE
  // is reached before any of these would ever fire): none of them actually
  // invokes its callback. This is a deliberate simplification of
  // sandbox.ts's full virtual-clock drain model — boot never needs the clock
  // to advance, only to observe what got scheduled and in what order.
  var __hbcTimerSeq = 0;
  // B2 (spec 33 §4(c)): the callback is kept with its virtual due time; a
  // frame (rAF, idle) is due at the next 16 ms boundary.
  function schedule(name, delay, fn, args, every, frame) {
    var id = ++__hbcTimerSeq;
    callRecord(name, [enc(delay)], undefined);
    if (__hbcRun !== null && typeof fn === "function") {
      var d = Math.max(0, Number(delay) || 0);
      var at = frame ? (Math.floor(__hbcVirtualNow / 16) + 1) * 16 : __hbcVirtualNow + d;
      __hbcQueue.push({ id: id, at: at, rn: undefined, fn: fn, args: args, every: every ? Math.max(1, d) : 0, dead: false });
    }
    return id;
  }
  function unschedule(name, id) {
    callRecord(name, [enc(id)], undefined);
    for (var i = 0; i < __hbcQueue.length; i++) if (__hbcQueue[i].id === id && __hbcQueue[i].rn === undefined) __hbcQueue[i].dead = true;
  }
  function rest(a, n) { return Array.prototype.slice.call(a, n); }
  globalThis.setTimeout = function (fn, delay) { return schedule("setTimeout", delay, fn, rest(arguments, 2), false, false); };
  globalThis.clearTimeout = function (id) { unschedule("clearTimeout", id); };
  globalThis.setInterval = function (fn, delay) { return schedule("setInterval", delay, fn, rest(arguments, 2), true, false); };
  globalThis.clearInterval = function (id) { unschedule("clearInterval", id); };
  globalThis.setImmediate = function (fn) { return schedule("setImmediate", 0, fn, rest(arguments, 1), false, false); };
  globalThis.clearImmediate = function (id) { unschedule("clearImmediate", id); };
  globalThis.queueMicrotask = function (fn) {
    callRecord("queueMicrotask", [], undefined);
    if (__hbcRun !== null && typeof fn === "function") __hbcMicro.push(fn);
  };
  globalThis.requestAnimationFrame = function (fn) { return schedule("requestAnimationFrame", 0, fn, [], false, true); };
  globalThis.cancelAnimationFrame = function (id) { unschedule("cancelAnimationFrame", id); };
  globalThis.requestIdleCallback = function (fn) { return schedule("requestIdleCallback", 0, fn, [], false, true); };
  globalThis.cancelIdleCallback = function (id) { unschedule("cancelIdleCallback", id); };

  function out(ch) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      var parts = [];
      for (var i = 0; i < args.length; i++) {
        try {
          parts.push(String(args[i]));
        } catch (e) {
          parts.push("<unstringifiable>");
        }
      }
      var encoded = [];
      for (var j = 0; j < args.length; j++) encoded.push(enc(args[j]));
      emit({ k: "out", ch: ch, s: parts.join(" "), a: encoded });
    };
  }
  globalThis.console = {
    log: out("console.log"),
    info: out("console.info"),
    warn: out("console.warn"),
    error: out("console.error"),
    debug: out("console.debug"),
    trace: out("console.trace"),
  };

  // __d/__r/__c/__registerSegment are bundle-defined (Metro's require
  // runtime assigns them onto globalThis at the top of the IIFE, spec §5),
  // never host-provided. A set-trap on each intercepts the assignment and
  // substitutes a recording wrapper before delegating.
  // Spec 33 §4: the factory probe. Called with original module ids: by the
  // wrapped factories below (original side), or by an exported tree's
  // registry under --instrument=modules (export side). On "exit" the
  // module's exports are offered so an AppRegistry-shaped object gets its
  // registerComponent observed (spec 33 §3 item 3). Only own DATA
  // properties are inspected: a getter (RN's lazy index re-exports) would
  // run a require out of order.
  function ownData(o, k) {
    var d = Object.getOwnPropertyDescriptor(o, k);
    return d !== undefined && "value" in d ? d.value : undefined;
  }
  function hookRegister(x) {
    try {
      if (x === null || (typeof x !== "object" && typeof x !== "function")) return;
      var targets = [x, ownData(x, "default"), ownData(x, "AppRegistry")];
      for (var i = 0; i < targets.length; i++) {
        var t = targets[i];
        if (t === null || (typeof t !== "object" && typeof t !== "function")) continue;
        var orig = ownData(t, "registerComponent");
        if (typeof orig !== "function" || orig.__hbcBootWrapped === true) continue;
        var w = (function (o) {
          return function (key) {
            emit({ k: "call", fn: "registerComponent", args: [enc(key)], ret: undefined, throws: undefined });
            __hbcKeys.push(String(key));
            return o.apply(this, arguments);
          };
        })(orig);
        w.__hbcBootWrapped = true;
        t.registerComponent = w;
        // B2: observe the host reaching runApplication (spec 33 §3).
        var origRun = ownData(t, "runApplication");
        if (typeof origRun === "function" && origRun.__hbcBootWrapped !== true) {
          var wr = (function (o) {
            return function (key) {
              emit({ k: "call", fn: "AppRegistry.runApplication", args: [enc(key)], ret: undefined, throws: undefined });
              return o.apply(this, arguments);
            };
          })(origRun);
          wr.__hbcBootWrapped = true;
          t.runApplication = wr;
        }
      }
    } catch (e) {
      // A frozen exports object stays unobserved; the key list then differs
      // on both sides alike, never silently on one.
    }
  }
  // On "throw" the third argument is the error: recorded as the call's
  // \`throws\` text for diagnosis; the projection never reads it.
  globalThis.__HBC_BOOT_PROBE__ = function (ev, id, extra) {
    var exportsObj = extra;
    var thrown = undefined;
    if (ev === "throw") {
      exportsObj = undefined;
      try {
        thrown = extra !== null && typeof extra === "object" ? String(extra.name) + ": " + String(extra.message) : String(extra);
        if (__hbcThrowStack && extra !== null && typeof extra === "object" && extra.stack !== undefined) thrown += "\\n" + String(extra.stack);
      } catch (e) {
        thrown = "<unstringifiable>";
      }
    }
    emit({ k: "call", fn: "__HBC_BOOT_PROBE__", args: [String(ev), id], ret: undefined, throws: thrown });
    if (ev === "exit") hookRegister(exportsObj);
  };
  function wrapFactory(factory, id) {
    if (!__hbcWrapFactories || typeof factory !== "function") return factory;
    return function (g, rq, iD, iA, mod) {
      var probe = globalThis.__HBC_BOOT_PROBE__;
      probe("enter", id);
      var ret;
      try {
        ret = factory.apply(this, arguments);
      } catch (e) {
        probe("throw", id, e);
        throw e;
      }
      probe("exit", id, mod !== null && mod !== undefined ? mod.exports : undefined);
      return ret;
    };
  }

  // String module ids (a custom createModuleIdFactory; corpus a10): the
  // static scan (src/deps/dscan.ts numberRegistrations) numbers them by first
  // registration among string-id registrations; number them the same way, in
  // __d call order, so the probe reports the ids the export uses.
  var __hbcStrIds = new Map();
  function probeId(id) {
    if (typeof id !== "string") return id;
    if (!__hbcStrIds.has(id)) __hbcStrIds.set(id, __hbcStrIds.size);
    return __hbcStrIds.get(id);
  }
  function wrapMetro(name, fn) {
    if (name === "__d") {
      return function (factory, id, deps) {
        callRecord("__d", [enc(id), deps === undefined ? "[]" : enc(deps)], undefined);
        return fn(wrapFactory(factory, probeId(id)), id, deps);
      };
    }
    if (name === "__r") {
      return function (id) {
        try {
          var ret = fn(id);
          callRecord("__r", [enc(id)], undefined);
          return ret;
        } catch (e) {
          var msg = e !== null && typeof e === "object" && e.message !== undefined ? String(e.message) : String(e);
          var nm = e !== null && typeof e === "object" && e.name !== undefined ? String(e.name) : "Thrown";
          callRecord("__r", [enc(id)], nm + ": " + msg);
          throw e;
        }
      };
    }
    // __c / __registerSegment: observed only, never recorded as a distinct
    // trace-record kind (spec §5's table has no row for them) — just
    // delegate once trapped, so trapping all four uniformly never loses the
    // assignment.
    return fn;
  }
  function trapAssign(name) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      get: function () {
        return undefined;
      },
      set: function (fn) {
        var wrapped = wrapMetro(name, fn);
        Object.defineProperty(globalThis, name, { configurable: true, enumerable: true, writable: true, value: wrapped });
      },
    });
  }
  trapAssign("__d");
  trapAssign("__r");
  trapAssign("__c");
  trapAssign("__registerSegment");

  var __hbcEnded = false;
  globalThis.__hbcBootEnd = function () {
    __hbcEnded = true;
    emit({ k: "end" });
  };

  // Spec 33 §3 B2: drive runApplication the way the RN version's host does,
  // then drain microtasks, timers, rAF and native Timing timers on the
  // virtual clock up to the horizon. Each macrotask runs in its own real
  // turn (the VM's own setTimeout), so the engine's Promise jobs settle
  // between them, identically on both sides.
  function errFields(e) {
    if (e !== null && typeof e === "object") return { name: e.name !== undefined ? String(e.name) : "Error", message: e.message !== undefined ? String(e.message) : "" };
    return { name: "Thrown", message: String(e) };
  }
  function runErr(e, fatal) {
    var f = errFields(e);
    // \`stack\` is for diagnosis only; the projection never reads it.
    var stack = "";
    try { stack = e !== null && typeof e === "object" && e.stack !== undefined ? String(e.stack).slice(0, 800) : ""; } catch (x) { /* none */ }
    emit({ k: "err", phase: "run", name: f.name, message: f.message, fatal: fatal, stack: stack });
  }
  function guarded(fn, args) {
    try {
      fn.apply(undefined, args);
    } catch (e) {
      runErr(e, true);
    }
  }
  var __hbcSteps = 0;
  function finish(why) {
    emit({ k: "call", fn: "__hbcRunEnd", args: [enc(__hbcVirtualNow), why], ret: undefined, throws: undefined });
  }
  function step() {
    while (__hbcMicro.length > 0) guarded(__hbcMicro.shift(), []);
    var best = null;
    for (var i = 0; i < __hbcQueue.length; i++) {
      var t = __hbcQueue[i];
      if (t.dead) continue;
      if (best === null || t.at < best.at || (t.at === best.at && t.id < best.id)) best = t;
    }
    if (best === null || best.at > __hbcRun.horizonMs) return "drained";
    if (++__hbcSteps > 100000) return "step-cap";
    if (best.at > __hbcVirtualNow) __hbcVirtualNow = best.at;
    if (best.every > 0) best.at += best.every;
    else best.dead = true;
    if (best.rn !== undefined) {
      var rnId = best.rn;
      guarded(function () { globalThis.__fbBatchedBridge.callFunctionReturnFlushedQueue("JSTimers", "callTimers", [[rnId]]); }, []);
    } else guarded(best.fn, best.args);
    return null;
  }
  function loop() {
    var done = step();
    if (done !== null) { finish(done); return; }
    if (__hbcRealSetTimeout !== null) __hbcRealSetTimeout(loop, 0);
    else loop();
  }
  globalThis.__hbcRunApp = function () {
    if (__hbcRun === null || !__hbcEnded) return;
    // Spec 33 L4: RN registers its own "LogBox" surface (opened only for the
    // LogBox overlay, never as the app's main component); a real host runs
    // the app's key, so the first registered key that is not LogBox.
    var key = undefined;
    for (var ki = 0; ki < __hbcKeys.length && key === undefined; ki++) if (__hbcKeys[ki] !== "LogBox") key = __hbcKeys[ki];
    if (key === undefined) key = __hbcKeys[0];
    if (key === undefined) { runErr(new Error("no registered app key"), true); return; }
    var EU = globalThis.ErrorUtils;
    if (EU !== null && typeof EU === "object" && typeof EU.setGlobalHandler === "function") {
      try { EU.setGlobalHandler(function (e, isFatal) { runErr(e, isFatal !== false); }); } catch (e) { /* unobserved on both sides */ }
    }
    var params = { rootTag: __hbcRootTag, initialProps: {} };
    var reg = globalThis.RN$AppRegistry;
    if (reg !== null && reg !== undefined && typeof reg.runApplication === "function") {
      callRecord("host.runApplication", [enc(key), "RN$AppRegistry"], undefined);
      guarded(function () { reg.runApplication(key, params); }, []);
    } else {
      callRecord("host.runApplication", [enc(key), "__fbBatchedBridge"], undefined);
      guarded(function () { globalThis.__fbBatchedBridge.callFunctionReturnFlushedQueue("AppRegistry", "runApplication", [key, params]); }, []);
    }
    loop();
  };
  globalThis.__hbcBootErr = function (e) {
    var name = "Thrown";
    var message = "";
    if (e !== null && typeof e === "object") {
      name = e.name !== undefined ? String(e.name) : e.constructor !== undefined && e.constructor.name !== undefined ? String(e.constructor.name) : "Error";
      message = e.message !== undefined ? String(e.message) : "";
    } else {
      message = typeof e === "string" ? e : String(e);
    }
    emit({ k: "err", phase: "boot", name: name, message: message });
  };

  emit({ k: "meta", v: 1, engine: "hermes", seed: __hbcSeed });
})();
`;
}

function buildBootSource(bundleSource: string, seed: number, firstNative: number, wrapFactories: boolean, run: BootRunOptions | null, natives: NativeManifest | null): string {
  const drive = run !== null ? "__hbcRunApp();\n" : "";
  return `${buildPrelude(seed, firstNative, wrapFactories, run, natives)}\ntry {\n${bundleSource}\n__hbcBootEnd();\n} catch (__hbcE) {\n__hbcBootErr(__hbcE);\n}\n${drive}`;
}

const NO_VM_MESSAGE = NO_VM_HELP;

// --- 0.1.2: class syntax the executing engine lacks --------------------
// An HBC v98/v99 original decompiles to classes with private members
// (`#e`), and the prebuilt VMs/compilers that exist (classic Hermes,
// HBC <= 96) reject both at parse time (classic Hermes has no `class` at
// all: Metro's preset lowered classes for it). Hermes >= v98 supports them natively on the device,
// so the faithful move is to keep the program's meaning and change only how
// private state is stored and how classes are wired: Babel's spec-mode
// lowering (WeakMap / WeakSet brand checks, `#x in o` included; ES5
// constructor functions, as Metro emits for classic Hermes), applied identically to BOTH sides of a
// comparison, and only when the engine that parses the source cannot.

const PRIVATE_SYNTAX = /(?<![\w$'"`\\])#[A-Za-z_$][\w$]*\s*(?:[=;(}]|in\b)|\.#[A-Za-z_$]|(?<![\w$.])class\s*(?:[A-Za-z_$][\w$]*\s*)?(?:extends\b|\{)/;
const syntaxCache = new Map<string, boolean>();

/** Whether `exe` (a `hermes` VM run in source mode, or a `hermesc`) parses
 *  class private members. Probed once per binary. */
export function classSyntaxSupported(exe: string, kind: "vm" | "hermesc"): boolean {
  const key = `${kind}:${exe}`;
  const hit = syntaxCache.get(key);
  if (hit !== undefined) return hit;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-syntax-probe-"));
  let ok = false;
  try {
    const f = join(dir, "p.js");
    writeFileSync(f, "class A { #a = 1; #m() { return this.#a; } static has(o) { return #a in o; } }\nnew A();\n");
    const args = kind === "vm" ? [f] : ["-emit-binary", `-out=${join(dir, "p.hbc")}`, f];
    ok = spawnSync(exe, args, { encoding: "utf8", timeout: 30000 }).status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  syntaxCache.set(key, ok);
  return ok;
}

const LOWER_PLUGINS = [
  "@babel/plugin-transform-class-static-block",
  "@babel/plugin-transform-private-property-in-object",
  "@babel/plugin-transform-private-methods",
  "@babel/plugin-transform-class-properties",
  "@babel/plugin-transform-classes",
];

/** Lowers classes and their private members (and static blocks, when that plugin is
 *  installed) with Babel resolved from `fromDir` (an export tree's own
 *  node_modules, which a bundled export always has), else from hbc2js's own
 *  install. Text with no private syntax comes back unchanged. Null when
 *  lowering is needed but no `@babel/core` + plugins can be resolved. */
export function lowerClassSyntax(source: string, fromDir: string | undefined): string | null {
  if (!PRIVATE_SYNTAX.test(source)) return source;
  // `fromDir` first (absolute: createRequire rejects relative paths), which
  // walks up to the nearest node_modules; hbc2js's own install last.
  const requirers = [...(fromDir !== undefined ? [createRequire(join(resolve(fromDir), "package.json"))] : []), createRequire(import.meta.url)];
  for (const req of requirers) {
    let core: { transformSync: (code: string, o: object) => { code?: string | null } | null };
    try {
      core = req("@babel/core") as typeof core;
    } catch {
      continue;
    }
    const plugins: unknown[] = [];
    let missing = false;
    for (const name of LOWER_PLUGINS) {
      try {
        plugins.push(req(name));
      } catch {
        if (name !== LOWER_PLUGINS[0]) missing = true;
      }
    }
    if (missing) continue;
    const out = core.transformSync(source, { babelrc: false, configFile: false, compact: true, comments: false, sourceType: "script", plugins });
    if (out?.code != null) return out.code;
  }
  return null;
}

/** Boots one bundle source under the stub host and returns its trace (spec
 *  §8). Always concatenates the prelude with `bundleSource`; runs
 *  `hermes <file.js>` in source mode, or, with `opts.hermesc` (spec 33 L2),
 *  compiles that concatenation and runs `hermes -b` on the result. */
export function bootTrace(bundleSourceIn: string, opts: BootTraceOptions = {}): BootTraceResult {
  let bundleSource = bundleSourceIn;
  const seed = opts.seed ?? 0;
  const firstNative = opts.firstNative ?? DEFAULT_FIRST_NATIVE;
  const timeout = opts.timeoutMs ?? 10000;
  const vm = resolveVm(opts.vm);
  if (vm === null) {
    return { trace: { kind: "full", records: [] }, reachedEnd: false, bootError: null, vm: null, ran: false, why: NO_VM_MESSAGE };
  }

  // The engine that parses the concatenated source: hermesc when compiling,
  // else the VM in source mode.
  let lowered = false;
  if (PRIVATE_SYNTAX.test(bundleSource) && !classSyntaxSupported(opts.hermesc ?? vm.path, opts.hermesc !== undefined ? "hermesc" : "vm")) {
    const low = lowerClassSyntax(bundleSource, opts.lowerFrom);
    if (low === null) {
      const why = `${opts.hermesc ?? vm.path} cannot parse class private members (#x) and no @babel/core with the class-properties / private-methods / private-property-in-object plugins could be resolved to lower them (install them in the export tree or beside the bundle (\`npm install\` there${opts.lowerFrom !== undefined ? `; searched upward from ${opts.lowerFrom}` : ""}), use a Hermes >= v98 VM via --vm, or build one: tools/build-hermes-vm.sh 98)`;
      return { trace: { kind: "full", records: [] }, reachedEnd: false, bootError: null, vm, ran: false, why };
    }
    bundleSource = low;
    lowered = true;
  }

  const dir = mkdtempSync(join(tmpdir(), "hbc2js-boot-equiv-"));
  let raw: HermesRunResult;
  try {
    const file = join(dir, "boot.js");
    writeFileSync(file, buildBootSource(bundleSource, seed, firstNative, opts.wrapFactories ?? true, opts.run ?? null, opts.natives ?? null));
    if (opts.hermesc !== undefined) {
      const hbc = join(dir, "boot.hbc");
      const c = spawnSync(opts.hermesc, ["-w", "-emit-binary", `-out=${hbc}`, file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: Math.max(timeout, 120000) });
      if (c.status !== 0) {
        const why = `hermesc could not compile the prelude+bundle: ${excerpt(c.stderr !== "" ? c.stderr : String(c.error ?? c.status))}`;
        return { trace: { kind: "full", records: [] }, reachedEnd: false, bootError: null, vm, ran: false, why };
      }
      raw = runHermes(vm.path, hbc, { timeout, bytecode: true, memoryLimitMb: bootVmMemoryMb() });
    } else raw = runHermes(vm.path, file, { timeout, bytecode: false, quiet: true, memoryLimitMb: bootVmMemoryMb() });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const records = parseTraceLines(raw.stdout);
  if (raw.timedOut) records.push({ k: "limit", why: "timeout" });
  const reachedEnd = records.some((r) => r.k === "end");
  const bootErrRec = records.find((r): r is ErrRecord => r.k === "err" && r.phase === "boot");
  const ran = records.length > 0;
  return {
    trace: { kind: "full", records },
    reachedEnd,
    bootError: bootErrRec !== undefined ? { name: bootErrRec.name, message: bootErrRec.message } : null,
    vm,
    ran,
    lowered,
    why: ran ? null : `hermes produced no boot trace at all: ${noTraceReason(raw)}`,
    raw,
  };
}

export interface BootComparison {
  readonly verdict: TraceVerdict;
  readonly why: string;
  /** Null when the verdict was decided without ever comparing the two traces
   *  (no VM, a run that produced no trace at all, or one side not reaching
   *  `EndRecord` — spec §7 criterion 5: never DIVERGENT from "one side
   *  couldn't boot", that is always INCONCLUSIVE). */
  readonly cmp: TraceComparison | null;
}

/** Wraps `compareTraces` (spec §8): reused completely unchanged for the case
 *  where both sides reached `EndRecord`. Boot adds exactly one extra rule on
 *  top, ahead of the comparison: a side that threw before `EndRecord` is a
 *  stub-host gap for *that* input, not evidence about the two bundles'
 *  relationship, so it is INCONCLUSIVE rather than being compared record for
 *  record (spec §7 criterion 5). */
export function compareBootTraces(a: BootTraceResult, b: BootTraceResult): BootComparison {
  if (a.vm === null || b.vm === null) {
    return { verdict: TRACE_VERDICT.INCONCLUSIVE, why: a.why ?? b.why ?? "no Hermes VM found", cmp: null };
  }
  if (!a.ran || !b.ran) {
    const why = !a.ran ? (a.why ?? "the first side produced no boot trace") : (b.why ?? "the second side produced no boot trace");
    return { verdict: TRACE_VERDICT.INCONCLUSIVE, why: `boot run failed: ${why}`, cmp: null };
  }
  if (!a.reachedEnd || !b.reachedEnd) {
    const side = !a.reachedEnd && !b.reachedEnd ? "both sides" : !a.reachedEnd ? "the first side" : "the second side";
    const err = !a.reachedEnd ? a.bootError : b.bootError;
    return {
      verdict: TRACE_VERDICT.INCONCLUSIVE,
      why: `${side} threw before reaching the end of the bundle's top-level IIFE${err !== null ? `: ${err.name}: ${err.message}` : ""} (a stub-host gap, not a measured difference)`,
      cmp: null,
    };
  }
  const cmp = compareTraces(a.trace, b.trace);
  return { verdict: cmp.verdict, why: cmp.why, cmp };
}

/** The boot VM's address-space cap in MiB: \`HBC2JS_BOOT_VM_MEMORY_MB\`
 *  (0 = uncapped), default 16384. One pathological decompile once drove the
 *  original side past 22 GB and into the kernel OOM killer; capped, it fails
 *  alone and the verdict says why (noTraceReason). */
export function bootVmMemoryMb(): number {
  const v = process.env.HBC2JS_BOOT_VM_MEMORY_MB;
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 16384;
}

/** Why a VM run left no trace, never an empty string: the exit status or
 *  signal (a kernel OOM kill is a bare SIGKILL with no output), the timeout
 *  flag, and the tail of whatever it printed. */
export function noTraceReason(raw: { readonly timedOut: boolean; readonly status?: number | null; readonly signal?: string | null; readonly stdout: string; readonly stderr: string }): string {
  const parts: string[] = [];
  if (raw.timedOut) parts.push("timed out");
  if (raw.signal !== undefined && raw.signal !== null) parts.push(`killed by ${raw.signal}${raw.signal === "SIGKILL" ? " (out of memory? check the kernel log)" : ""}`);
  if (raw.status !== undefined && raw.status !== null) parts.push(`exit status ${raw.status}`);
  if (/\bOOM\b|out of memory|Cannot allocate memory/i.test(raw.stderr)) parts.push(`ran out of memory (VM cap ${bootVmMemoryMb()} MiB, HBC2JS_BOOT_VM_MEMORY_MB)`);
  const out = raw.stderr !== "" ? raw.stderr : raw.stdout;
  parts.push(out.trim() === "" ? "no output" : `output tail: ${out.trim().slice(-400)}`);
  return parts.join("; ");
}
