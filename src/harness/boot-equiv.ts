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
import { join } from "node:path";
import { decompile } from "../decompile.ts";
import { findAllHermesVms, runHermes } from "./hermes-vm.ts";
import type { HermesRunResult, HermesVm } from "./hermes-vm.ts";
import { TRACE_VERDICT, compareTraces } from "./compare.ts";
import type { TraceComparison, TraceVerdict } from "./compare.ts";
import type { ErrRecord, Trace, TraceRecord } from "./trace.ts";

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
export function acquireBootSource(inputPath: string): AcquiredBootSource {
  if (inputPath.endsWith(".hbc")) {
    const bytes = readFileSync(inputPath);
    const result = decompile(new Uint8Array(bytes));
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
  const t = s.trim();
  return t.length > 300 ? t.slice(0, 300) + "…" : t;
}

/** The recording stub-host prelude (spec §4.1) as Hermes source, plus the
 *  `__d`/`__r`/`__c`/`__registerSegment` set-traps (spec §5) that intercept
 *  Metro's require runtime the moment the bundle assigns it onto
 *  `globalThis`. Everything the prelude owns lives inside one IIFE so it
 *  cannot collide with a top-level `var` the bundle itself declares; only the
 *  specific global names spec §4.1 lists, plus the two boot-orchestration
 *  hooks `__hbcBootEnd`/`__hbcBootErr`, are left on `globalThis`. */
function buildPrelude(seed: number, firstNative: number, wrapFactories: boolean): string {
  return `
(function () {
  "use strict";
  var __hbcSeed = ${JSON.stringify(seed)};
  var __hbcFirstNative = ${JSON.stringify(firstNative)};
  var __hbcNativeCount = 0;
  var __hbcNativeLimited = false;
  var __hbcRealPrint = globalThis.print;
  var __hbcWrapFactories = ${JSON.stringify(wrapFactories)};

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
  function hostStub(name) {
    var backing = Object.create(null);
    return new Proxy(backing, {
      get: function (t, p) {
        if (p === Symbol.toPrimitive) return function () { return "[hoststub " + name + "]"; };
        if (p === Symbol.toStringTag) return "HostStub";
        if (typeof p === "symbol") return undefined;
        if (p === "then") return undefined;
        if (p in t) return t[p];
        var child = function () {
          if (nativeGate()) callRecord(name + "." + String(p), [], undefined);
          // Spec 33 L1 stub-host addition (spec 31 §4.2): getConstants()
          // returns an object (see hostConstants), not undefined.
          if (p === "getConstants") return hostConstants(name);
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

  globalThis.nativeLoggingHook = function (msg, level) {
    // msg is not recorded: it carries app text (spec §5 table).
    if (nativeGate()) callRecord("nativeLoggingHook", [enc(level)], undefined);
  };

  globalThis.__turboModuleProxy = function (name) {
    if (nativeGate()) callRecord("__turboModuleProxy", [enc(name)], undefined);
    return hostStub("turboModule." + String(name));
  };

  globalThis.nativeModuleProxy = new Proxy(Object.create(null), {
    get: function (t, p) {
      if (typeof p === "symbol") return undefined;
      if (nativeGate()) callRecord("nativeModuleProxy.get", [String(p)], undefined);
      if (p in t) return t[p];
      var stub = hostStub("nativeModule." + String(p));
      t[p] = stub;
      return stub;
    },
    has: function () {
      return true;
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
  function schedule(name, delay) {
    var id = ++__hbcTimerSeq;
    callRecord(name, [enc(delay)], undefined);
    return id;
  }
  globalThis.setTimeout = function (_fn, delay) { return schedule("setTimeout", delay); };
  globalThis.clearTimeout = function (id) { callRecord("clearTimeout", [enc(id)], undefined); };
  globalThis.setInterval = function (_fn, delay) { return schedule("setInterval", delay); };
  globalThis.clearInterval = function (id) { callRecord("clearInterval", [enc(id)], undefined); };
  globalThis.setImmediate = function (_fn) { return schedule("setImmediate", 0); };
  globalThis.clearImmediate = function (id) { callRecord("clearImmediate", [enc(id)], undefined); };
  globalThis.queueMicrotask = function (_fn) { callRecord("queueMicrotask", [], undefined); };
  globalThis.requestAnimationFrame = function (_fn) { return schedule("requestAnimationFrame", 0); };
  globalThis.cancelAnimationFrame = function (id) { callRecord("cancelAnimationFrame", [enc(id)], undefined); };
  globalThis.requestIdleCallback = function (_fn) { return schedule("requestIdleCallback", 0); };
  globalThis.cancelIdleCallback = function (id) { callRecord("cancelIdleCallback", [enc(id)], undefined); };

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
            return o.apply(this, arguments);
          };
        })(orig);
        w.__hbcBootWrapped = true;
        t.registerComponent = w;
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

  function wrapMetro(name, fn) {
    if (name === "__d") {
      return function (factory, id, deps) {
        callRecord("__d", [enc(id), deps === undefined ? "[]" : enc(deps)], undefined);
        return fn(wrapFactory(factory, id), id, deps);
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

  globalThis.__hbcBootEnd = function () {
    emit({ k: "end" });
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

function buildBootSource(bundleSource: string, seed: number, firstNative: number, wrapFactories: boolean): string {
  return `${buildPrelude(seed, firstNative, wrapFactories)}\ntry {\n${bundleSource}\n__hbcBootEnd();\n} catch (__hbcE) {\n__hbcBootErr(__hbcE);\n}\n`;
}

const NO_VM_MESSAGE = "no Hermes VM found (tools/hermesc/v<N>/hermes or tools/hermes-vm/v<N>/bin/hermes); the boot oracle runs entirely in source mode, so any discovered VM works regardless of its own HBC version";

/** Boots one bundle source under the stub host and returns its trace (spec
 *  §8). Always concatenates the prelude with `bundleSource`; runs
 *  `hermes <file.js>` in source mode, or, with `opts.hermesc` (spec 33 L2),
 *  compiles that concatenation and runs `hermes -b` on the result. */
export function bootTrace(bundleSource: string, opts: BootTraceOptions = {}): BootTraceResult {
  const seed = opts.seed ?? 0;
  const firstNative = opts.firstNative ?? DEFAULT_FIRST_NATIVE;
  const timeout = opts.timeoutMs ?? 10000;
  const vm = resolveVm(opts.vm);
  if (vm === null) {
    return { trace: { kind: "full", records: [] }, reachedEnd: false, bootError: null, vm: null, ran: false, why: NO_VM_MESSAGE };
  }

  const dir = mkdtempSync(join(tmpdir(), "hbc2js-boot-equiv-"));
  let raw: HermesRunResult;
  try {
    const file = join(dir, "boot.js");
    writeFileSync(file, buildBootSource(bundleSource, seed, firstNative, opts.wrapFactories ?? true));
    if (opts.hermesc !== undefined) {
      const hbc = join(dir, "boot.hbc");
      const c = spawnSync(opts.hermesc, ["-emit-binary", `-out=${hbc}`, file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: Math.max(timeout, 120000) });
      if (c.status !== 0) {
        const why = `hermesc could not compile the prelude+bundle: ${excerpt(c.stderr !== "" ? c.stderr : String(c.error ?? c.status))}`;
        return { trace: { kind: "full", records: [] }, reachedEnd: false, bootError: null, vm, ran: false, why };
      }
      raw = runHermes(vm.path, hbc, { timeout, bytecode: true });
    } else raw = runHermes(vm.path, file, { timeout, bytecode: false });
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
    why: ran ? null : `hermes produced no boot trace at all: ${excerpt(raw.stderr !== "" ? raw.stderr : raw.stdout)}`,
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
