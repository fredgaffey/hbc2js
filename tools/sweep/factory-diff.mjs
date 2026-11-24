#!/usr/bin/env node
// Decompiler bug sweep, differential half: module-factory isolation run.
//
//   node tools/sweep/factory-diff.mjs --b <decompiled.js> [--a <original bundle.js>]
//        --out <dir> [--app L] [--hbc N] [--calls] [--timeout ms] [--only id,id]
//
// Loads each side in its own Node `vm` context behind a prelude that pins
// `__d` / `__r` to capturing stubs, so running the bundle text only REGISTERS
// its Metro module factories. Every factory is then run in isolation against
// a deterministic stub host: `require`/`importDefault`/`importAll` return a
// memoised, callable, constructable "anything" Proxy keyed by the dependency
// id, so both sides see byte-identical inputs. Recorded per module: whether
// the factory threw (error class), and the shape of `module.exports` (typeof,
// own keys, typeof of each key). With `--calls`, every exported function is
// also called once with no arguments and the outcome class recorded.
//
// With `--a` (the original Metro bundle text, when the fixture ships it) the
// two records are compared per module id; without it (HBC-only apps) the
// decompiled side alone is reported for errors no stub can explain
// (ReferenceError, timeouts). Findings: <dir>/factory-findings.jsonl in the
// static sweep's {app, hbc, fn, check, sig, detail} schema plus `module`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const PRELUDE = String.raw`(function (g) {
  var factories = [];
  var d = function (factory, id, deps) { factories.push([factory, id, deps]); };
  var cache = new Map(); var tags = new WeakMap();
  function mk(tag) {
    if (tag.length > 120) tag = "<deep>";
    var hit = cache.get(tag); if (hit) return hit;
    var t = function () {};
    var p = new Proxy(t, {
      get: function (t, k) {
        if (k === Symbol.toPrimitive) return function (h) { return h === "number" ? 0 : "[stub]"; };
        if (k === Symbol.iterator) return function* () {};
        if (k === "__esModule") return true; // interop helpers pass the stub through untouched
        if (typeof k === "symbol" || k === "then" || k === "$$typeof") return undefined;
        if (k === "length") return 0;
        if (k === "name") return tag;
        return mk(tag + "." + k);
      },
      apply: function () { return mk(tag + "()"); },
      construct: function () { return mk("new " + tag); },
      set: function () { return true; },
      has: function () { return false; },
      deleteProperty: function () { return true; },
    });
    cache.set(tag, p); tags.set(p, tag); return p;
  }
  var r = function (id) { return mk("r" + id); };
  g.__sweep_id = function (i) { return factories[i][1]; };
  Object.defineProperty(g, "__d", { get: function () { return d; }, set: function () {} });
  Object.defineProperty(g, "__r", { get: function () { return r; }, set: function () {} });
  g.nativePerformanceNow = function () { return 0; };
  // RN host globals a factory may touch at init: stubs, identical on both sides.
  ["nativeModuleProxy", "__turboModuleProxy", "nativeFabricUIManager", "XMLHttpRequest", "FormData", "WebSocket",
   "Blob", "FileReader", "fetch", "Headers", "Request", "Response", "__fbBatchedBridgeConfig", "nativeRuntimeScheduler",
   "RN$Bridgeless", "requestAnimationFrame", "cancelAnimationFrame", "performance", "navigator", "DebuggerInternal",
   "nativeCallSyncHook", "nativeFlushQueueImmediate", "__fbGenNativeModule", "nativeLoggingHook", "nativeTraceBeginSection",
   "nativeTraceEndSection", "setImmediate", "clearImmediate", "__REACT_DEVTOOLS_GLOBAL_HOOK__", "ErrorUtils", "location",
   "document", "window", "self"].forEach(function (n) { if (!(n in g)) g[n] = n === "window" || n === "self" ? g : mk("G." + n); });
  g.print = function () {};
  // vm contexts have no timers; deterministic no-op stand-ins (callbacks never run).
  var tid = 0;
  ["setTimeout", "setInterval", "setImmediate", "requestIdleCallback"].forEach(function (n) { g[n] = function () { return ++tid; }; });
  ["clearTimeout", "clearInterval", "clearImmediate", "cancelIdleCallback"].forEach(function (n) { g[n] = function () {}; });
  g.queueMicrotask = function () {};
  function errClass(e) {
    if (e && typeof e === "object" && typeof e.constructor === "function") return e.constructor.name || "Object";
    return "throw:" + typeof e;
  }
  function errMsg(e) { try { return String(e && e.message).slice(0, 160); } catch (x) { return "?"; } }
  function ty(v) { if (v !== null && (typeof v === "object" || typeof v === "function") && tags.has(v)) return "stub"; return v === null ? "null" : typeof v; }
  function shape(e) {
    var s = { type: ty(e) };
    if (s.type === "stub") { s.tag = tags.get(e); return s; }
    if (e === null || (typeof e !== "object" && typeof e !== "function")) return s;
    var keys; try { keys = Object.keys(e).sort(); } catch (x) { s.keys = "throws"; return s; }
    s.nkeys = keys.length; s.keys = {};
    for (var i = 0; i < keys.length && i < 300; i++) {
      var v; try { v = ty(e[keys[i]]); } catch (x) { v = "get-throws:" + errClass(x); }
      s.keys[keys[i]] = v;
    }
    return s;
  }
  var exportsOf = [];
  function run(i) {
    var f = factories[i]; var module = { exports: {} }; var out = { id: f[1] };
    var src = ""; try { src = Function.prototype.toString.call(f[0]); } catch (x) {}
    var m = /fn#(\d+)/.exec(src); out.fn = m ? Number(m[1]) : -1;
    try {
      f[0](g, function (id) { return mk("m" + id); }, function (id) { return mk("d" + id); },
           function (id) { return mk("a" + id); }, module, module.exports, f[2]);
    } catch (e) { out.threw = errClass(e); out.msg = errMsg(e); try { out.stack = String(e.stack).split("\n").slice(1, 4).join(" | "); } catch (x) {} }
    exportsOf[i] = module.exports;
    out.shape = shape(module.exports);
    return JSON.stringify(out);
  }
  function calls(i) {
    var e = exportsOf[i]; var res = {};
    var fns = [];
    if (typeof e === "function" && !tags.has(e)) fns.push(["<module>", e]);
    if (e && (typeof e === "object" || typeof e === "function") && !tags.has(e)) {
      var ks = Object.keys(e).sort();
      for (var j = 0; j < ks.length && j < 100; j++) {
        var v; try { v = e[ks[j]]; } catch (x) { continue; }
        if (typeof v === "function" && !tags.has(v)) fns.push([ks[j], v]);
      }
    }
    for (var k = 0; k < fns.length; k++) {
      try { var rv = fns[k][1](); res[fns[k][0]] = "ret:" + ty(rv); if (rv && typeof rv.then === "function" && !tags.has(rv)) rv.then(null, function () {}); }
      catch (x) { res[fns[k][0]] = "throw:" + errClass(x) + (errClass(x) === "ReferenceError" ? ":" + errMsg(x) : ""); }
    }
    return JSON.stringify(res);
  }
  g.__sweep = { count: function () { return factories.length; }, run: run, calls: calls };
})(this);`;

/** Load one side and return per-module records keyed by module id. */
export function runSide(src, { timeout = 2000, calls = false, only } = {}) {
  const ctx = vm.createContext({});
  vm.runInContext(PRELUDE, ctx);
  let loadError = null;
  try { vm.runInContext(src, ctx, { timeout: 120000 }); } catch (e) { loadError = String(e?.message ?? e).slice(0, 300); }
  const n = vm.runInContext("__sweep.count()", ctx);
  const recs = new Map();
  for (let i = 0; i < n; i++) {
    let rec;
    try { rec = JSON.parse(vm.runInContext(`__sweep.run(${i})`, ctx, { timeout })); } catch (e) {
      const id = vm.runInContext(`(function(){try{return __sweep_id(${i})}catch(e){return null}})()`, ctx);
      rec = { id: id ?? `#${i}`, timeout: /timed out/.test(String(e?.message)), hostErr: String(e?.message ?? e).slice(0, 160) };
    }
    if (only && !only.has(String(rec.id))) continue;
    if (calls && !rec.timeout && rec.hostErr === undefined) {
      try { rec.calls = JSON.parse(vm.runInContext(`__sweep.calls(${i})`, ctx, { timeout })); } catch (e) { rec.calls = { "<timeout>": String(e?.message).slice(0, 80) }; }
    }
    recs.set(String(rec.id), rec);
  }
  return { loadError, count: n, recs };
}

process.on("unhandledRejection", () => {});
process.on("uncaughtException", (e) => { process.stderr.write(`[factory-diff] async: ${String(e?.message ?? e).slice(0, 120)}\n`); });

/** The property name a TypeError message names, if any -- identifier names in
 *  the rest of the message differ between original and decompiled text. */
const msgKey = (m) => /\((?:reading|setting) '([^']*)'\)/.exec(m ?? "")?.[1];
const keyDiff = (a, b) => Object.keys(a ?? {}).filter((k) => !(k in (b ?? {})));

/** Compare two sides' records; returns findings (sig clusters by kind). */
export function compareSides(A, B, app, hbc) {
  const out = [];
  const add = (rec, check, kind, detail) => out.push({ app, hbc, fn: rec?.fn ?? -1, module: rec?.id, check, sig: `${check}:${kind}`, detail: String(detail).slice(0, 300) });
  for (const [id, b] of B.recs) {
    const a = A?.recs.get(id);
    if (b.timeout && !a?.timeout) { add(b, "FACTORY", "timeout-only-decompiled", b.hostErr); continue; }
    if (A === null) {
      if (b.threw === "ReferenceError") add(b, "FACTORY", "throws-ReferenceError", b.msg);
      for (const [k, v] of Object.entries(b.calls ?? {})) if (v.startsWith("throw:ReferenceError")) add(b, "CALL", "throws-ReferenceError", `${k}: ${v}`);
      continue;
    }
    if (a === undefined) { add(b, "FACTORY", "module-only-in-decompiled", id); continue; }
    if (a.timeout || a.hostErr) continue;
    if (b.hostErr && !b.timeout) { add(b, "FACTORY", "host-error", b.hostErr); continue; }
    if ((a.threw ?? "") !== (b.threw ?? "")) {
      add(b, "FACTORY", a.threw === undefined ? `throws-only-decompiled:${b.threw}` : b.threw === undefined ? `throws-only-original:${a.threw}` : `throw-class:${a.threw}->${b.threw}`, `orig=${a.threw ?? "-"}:${a.msg ?? ""} | dec=${b.threw ?? "-"}:${b.msg ?? ""}`);
      continue; // a different throw point makes the shape diff noise
    }
    const ka = msgKey(a.msg), kb = msgKey(b.msg);
    if (a.threw && ka !== undefined && kb !== undefined && ka !== kb) { add(b, "FACTORY", `throw-site-differs:${a.threw}`, `orig=${a.msg} | dec=${b.msg}`); continue; }
    const sa = a.shape, sb = b.shape;
    if (sa.type !== sb.type) { add(b, "FACTORY", `exports-type:${sa.type}->${sb.type}`, `${sa.tag ?? ""} ${sb.tag ?? ""}`); continue; }
    if (sa.type === "stub" && sa.tag !== sb.tag) add(b, "FACTORY", "exports-stub-tag", `${sa.tag} -> ${sb.tag}`);
    const miss = keyDiff(sa.keys, sb.keys), extra = keyDiff(sb.keys, sa.keys);
    if (miss.length) add(b, "FACTORY", "export-keys-missing", miss.slice(0, 10).join(","));
    if (extra.length) add(b, "FACTORY", "export-keys-extra", extra.slice(0, 10).join(","));
    for (const k of Object.keys(sa.keys ?? {})) {
      if (k in (sb.keys ?? {}) && sa.keys[k] !== sb.keys[k]) add(b, "FACTORY", `export-key-type:${sa.keys[k]}->${sb.keys[k]}`, k);
    }
    for (const [k, va] of Object.entries(a.calls ?? {})) {
      const vb = b.calls?.[k];
      if (vb === undefined) continue;
      const ca = va.split(":").slice(0, 2).join(":"), cb = vb.split(":").slice(0, 2).join(":");
      if (ca !== cb) add(b, "CALL", `${ca}->${cb}`, `${k}: ${va} | ${vb}`);
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const bPath = flag("--b"), aPath = flag("--a"), outDir = flag("--out");
  if (!bPath || !outDir) { console.error("usage: factory-diff.mjs --b <decompiled.js> [--a <bundle.js>] --out <dir> [--app L] [--hbc N] [--calls] [--timeout ms] [--only ids]"); process.exit(2); }
  const opts = { timeout: Number(flag("--timeout") ?? 2000), calls: argv.includes("--calls"), only: flag("--only") ? new Set(flag("--only").split(",")) : undefined };
  const app = flag("--app") ?? bPath, hbc = Number(flag("--hbc") ?? 0);
  mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const A = aPath ? runSide(readFileSync(aPath, "utf8"), opts) : null;
  const B = runSide(readFileSync(bPath, "utf8"), opts);
  const findings = compareSides(A, B, app, hbc);
  writeFileSync(join(outDir, "factory-findings.jsonl"), findings.map((f) => JSON.stringify(f)).join("\n") + (findings.length ? "\n" : ""));
  if (argv.includes("--dump")) writeFileSync(join(outDir, "factory-records.json"), JSON.stringify({ a: A && [...A.recs], b: [...B.recs] }));
  const hist = {};
  for (const f of findings) hist[f.sig] = (hist[f.sig] ?? 0) + 1;
  const summary = {
    app, original: aPath ?? null, ms: Date.now() - t0,
    modules: { original: A?.count ?? null, decompiled: B.count },
    loadError: { original: A?.loadError ?? null, decompiled: B.loadError },
    threw: { original: A ? [...A.recs.values()].filter((r) => r.threw).length : null, decompiled: [...B.recs.values()].filter((r) => r.threw).length },
    findings: findings.length, histogram: Object.fromEntries(Object.entries(hist).sort((x, y) => y[1] - x[1])),
  };
  writeFileSync(join(outDir, "factory-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}
