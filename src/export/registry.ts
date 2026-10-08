// src/export/registry.ts — docs/specs/29-export.md §4.4: the Metro-compatible
// `__d`/`__r` module registry and the runtime-helper prelude, as two real
// files in the export tree (`src/_hbc/registry.js`, `src/_hbc/helpers.js`).
// Derived from `buildLoaderIndexJs` (`src/split/index.ts`) minus the
// `Module._load` patch, which does not exist under Metro (§4.4's whole
// reason for being) — the shape (`__d`, `__r`, `importDefault`/`importAll`)
// is unchanged, so a cycle behaves exactly as the un-exported split tree's
// own loader already proved it does.
import { helperPrelude } from "../runtime/helpers.ts";

export function buildRegistryJs(substitutions: ReadonlyMap<number, string> = new Map(), instrument: boolean = false): string {
  const lines: string[] = [];
  lines.push(`// hbc2js export -- Metro-compatible module registry (docs/specs/29-export.md §4.4).`);
  lines.push(`// Same __d/__r shape as the --split tree's own loader (src/split/index.ts`);
  lines.push(`// buildLoaderIndexJs), minus the Module._load patch: Metro resolves`);
  lines.push(`// require() statically, so every dependency edge is a literal require()`);
  lines.push(`// call in the requiring file instead (src/export/rewrite.ts).`);
  lines.push(`//`);
  lines.push(`// __hbc_substituted (docs/specs/29-export.md §5, src/export/substitute.ts):`);
  lines.push(`// one entry per substituted package's boundary module id -- "r(id)" below`);
  lines.push(`// redirects to a real npm require() instead of the (deleted) local module`);
  lines.push(`// entry. This is where §5.2's call-form rewrite actually happens: it runs`);
  lines.push(`// at the exact original call site and time (an eager caller still calls`);
  lines.push(`// it at module-eval time, a lazy caller still calls it from inside its own`);
  lines.push(`// closure), so the eager/lazy deferral is preserved without rewriting any`);
  lines.push(`// call-site text (src/export/substitute.ts's own implementation note). Each`);
  lines.push(`// entry's require() call is a LITERAL string (never a variable): Metro's`);
  lines.push(`// dependency collector walks the whole module AST for require() calls with`);
  lines.push(`// a string-literal argument regardless of nesting, so this stays statically`);
  lines.push(`// resolvable even though the dispatch (which id) is a runtime lookup.`);
  lines.push(`"use strict";`);
  lines.push(``);
  lines.push(`var __hbc_registry = new Map();`);
  lines.push(`var __hbc_instances = new Map();`);
  lines.push(`var __hbc_substituted = {`);
  for (const [id, pkg] of substitutions) {
    lines.push(`  ${JSON.stringify(String(id))}: function () { return require(${JSON.stringify(pkg)}); },`);
  }
  lines.push(`};`);
  lines.push(``);
  if (instrument) {
    lines.push(`// --instrument=modules: per-module boot timing.`);
    lines.push(`// See this file's own doc comment above for the ring-buffer/flush contract.`);
    lines.push(`var __hbc_now = (function () {`);
    lines.push(`  if (typeof globalThis.performance === "object" && globalThis.performance !== null && typeof globalThis.performance.now === "function") {`);
    lines.push(`    return function () { return globalThis.performance.now(); };`);
    lines.push(`  }`);
    lines.push(`  return function () { return Date.now(); };`);
    lines.push(`})();`);
    lines.push(`var __HBC_BOOT_RING_CAPACITY__ = 256;`);
    lines.push(`globalThis.__HBC_BOOT_TIMINGS__ = globalThis.__HBC_BOOT_TIMINGS__ || [];`);
    lines.push(`function __hbc_flushBootTimings() {`);
    lines.push(`  var ring = globalThis.__HBC_BOOT_TIMINGS__;`);
    lines.push(`  for (var i = 0; i < ring.length; i++) console.log("__HBC_BOOT_TIMING__ " + JSON.stringify(ring[i]));`);
    lines.push(`  ring.length = 0;`);
    lines.push(`}`);
    lines.push(`globalThis.__hbcFlushBootTimings = __hbc_flushBootTimings;`);
    lines.push(``);
  }
  lines.push(`function define(factory, id, deps) {`);
  lines.push(`  __hbc_registry.set(id, { factory: factory, deps: deps || [] });`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function importDefault(id) {`);
  lines.push(`  var ns = r(id);`);
  lines.push(`  return ns && ns.__esModule ? ns : { default: ns };`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function importAll(id) {`);
  lines.push(`  var ns = r(id);`);
  lines.push(`  if (ns && ns.__esModule) return ns;`);
  lines.push(`  var copy = {};`);
  lines.push(`  if (ns) for (var key in ns) if (Object.prototype.hasOwnProperty.call(ns, key)) copy[key] = ns[key];`);
  lines.push(`  copy.default = ns;`);
  lines.push(`  return copy;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function r(id) {`);
  lines.push(`  var subFactory = __hbc_substituted[id];`);
  lines.push(`  if (subFactory !== undefined) return subFactory();`);
  lines.push(`  var inst = __hbc_instances.get(id);`);
  lines.push(`  if (inst !== undefined) return inst.exports;`);
  lines.push(`  var entry = __hbc_registry.get(id);`);
  lines.push(`  if (entry === undefined) throw new Error("hbc2js export registry: module " + id + " is not registered");`);
  lines.push(`  var mod = { id: id, exports: {} };`);
  lines.push(`  __hbc_instances.set(id, mod);`); // cache before running: tolerates circular deps
  lines.push(`  var requireFn = function (depId) { return r(depId); };`);
  lines.push(`  requireFn.importDefault = importDefault;`);
  lines.push(`  requireFn.importAll = importAll;`);
  if (instrument) {
    lines.push(`  var __hbc_t0 = __hbc_now();`);
    lines.push(`  entry.factory(globalThis, requireFn, importDefault, importAll, mod, mod.exports, entry.deps);`);
    lines.push(`  var __hbc_dt = __hbc_now() - __hbc_t0;`);
    lines.push(`  var __hbc_ring = globalThis.__HBC_BOOT_TIMINGS__;`);
    lines.push(`  __hbc_ring.push({ id: id, t0: __hbc_t0, dt: __hbc_dt });`);
    lines.push(`  if (__hbc_ring.length >= __HBC_BOOT_RING_CAPACITY__) __hbc_flushBootTimings();`);
  } else {
    lines.push(`  entry.factory(globalThis, requireFn, importDefault, importAll, mod, mod.exports, entry.deps);`);
  }
  lines.push(`  return mod.exports;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`module.exports = { define: define, r: r, importDefault: importDefault, importAll: importAll };`);
  lines.push(``);
  return lines.join("\n");
}

/** `src/_hbc/helpers.js` — the `__hbc_b_*` runtime helpers `helpersUsed`
 *  names (`SplitResult.helpersUsed`, exposed by `splitProject` for exactly
 *  this reuse), assigned onto `globalThis` so a module body's free
 *  references to them (unchanged by export, same as `--split`) keep
 *  resolving. Written as its own file (not inlined into `registry.js`) so a
 *  bundle with zero helper usage still produces a real, near-empty file
 *  rather than a conditional branch in `registry.js`'s own shape. */
export function buildHelpersJs(helpersUsed: readonly string[]): string {
  const lines: string[] = [];
  lines.push(`// hbc2js export -- runtime helper prelude (docs/specs/29-export.md §4.4).`);
  lines.push(`// Installs every __hbc_b_* helper a module body in this tree references as a`);
  lines.push(`// free global, same set src/runtime/helpers.ts's helperPrelude() computed for`);
  lines.push(`// the un-exported --split tree's own index.js.`);
  lines.push(`"use strict";`);
  lines.push(``);
  const prelude = helperPrelude(helpersUsed);
  if (prelude.names.length > 0) {
    lines.push(`Object.assign(globalThis, (function () {`);
    lines.push(prelude.code);
    lines.push(`  return { ${prelude.names.map((n) => `${n}: ${n}`).join(", ")} };`);
    lines.push(`})());`);
  } else {
    lines.push(`// No runtime helper is used anywhere in this tree.`);
  }
  lines.push(``);
  return lines.join("\n");
}
