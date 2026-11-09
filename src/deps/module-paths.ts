// src/deps/module-paths.ts — per-module file paths in package signatures
// (docs/PACKAGE-SIGNATURES.md §7, "module paths v1").
//
// A signature is built by bundling `require(<pkg>)` with Metro, so it holds
// every module Metro pulled in: the package's own files AND copies of other
// packages (undeclared dependencies, Node built-in polyfills such as
// `buffer`, `@babel/runtime` helpers, a transitive dependency not in the
// DB). Hash ownership can't separate the real owner from a package that
// embeds a copy: both match the same hashes. The file path can. Metro's
// source map records the source file of every generated line, and each
// minified `__d(...)` registration is one line ending in `},<id>,[deps]);`,
// so module id -> source file -> path below `node_modules/`.
//
// Build side: `modulePathsFromSourceMap` + `attachModulePaths` give each
// SigModule a `path` and each SigFunction the `moduleId` of the module
// whose factory (transitively) creates it. Match side: `foreignSets`
// (via `isOwnModulePath`) says which of a path-bearing file's modules and
// functions belong to another package. A file without `modulePaths` is
// never touched (back-compat: scores exactly as before).

import type { HbcModule } from "../parse/types.ts";
import type { DecodedFunction } from "../disasm/decode.ts";
import type { SigDbFile, SigFunction, SigModule } from "./sigdb-types.ts";
import { closureOwnership, directClosures } from "./closure-owner.ts";

/** `SigDbFile.modulePaths` value this code writes and understands. */
export const MODULE_PATHS_VERSION = 1;

// --- source map ----------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function decodeVlq(seg: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const ch of seg) {
    const digit = B64.indexOf(ch);
    if (digit < 0) throw new Error(`bad VLQ char ${ch}`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      out.push(value & 1 ? -(value >> 1) : value >> 1);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

export interface SourceMapLike {
  readonly sources: readonly string[];
  readonly mappings?: string;
  readonly perLine?: readonly (number | null | undefined)[];
  readonly sections?: readonly { readonly offset: { readonly line: number }; readonly map: SourceMapLike }[];
}

/** Dominant source index per generated line (null when a line has no mapping). */
export function sourcePerLine(map: SourceMapLike): (number | null)[] {
  if (map.perLine !== undefined) return Array.from(map.perLine, (x) => x ?? null);
  const lines = (map.mappings ?? "").split(";");
  let src = 0;
  return lines.map((line) => {
    if (line === "") return null;
    const counts = new Map<number, number>();
    for (const seg of line.split(",")) {
      if (seg === "") continue;
      const f = decodeVlq(seg);
      if (f.length >= 4) {
        src += f[1]!;
        counts.set(src, (counts.get(src) ?? 0) + 1);
      }
    }
    let best: number | null = null;
    let bestN = 0;
    for (const [s, n] of counts) if (n > bestN) [best, bestN] = [s, n];
    return best;
  });
}

/** Metro >= 0.8x may emit an INDEX source map (`sections`, one per module).
 *  Flatten it to the per-line shape `sourcePerLine` reads: each section
 *  starts at column 0 of its own generated line. */
export function flattenIndexMap(map: SourceMapLike): SourceMapLike {
  if (!Array.isArray(map.sections)) return map;
  const sources: string[] = [];
  const lines: (number | null)[] = [];
  for (const sec of map.sections) {
    const sub = flattenIndexMap(sec.map);
    const perLine = sourcePerLine(sub);
    perLine.forEach((src, i) => {
      if (src !== null) lines[sec.offset.line + i] = src + sources.length;
    });
    sources.push(...sub.sources);
  }
  return { sources, perLine: lines };
}

/** Module id -> raw source path (as the map records it), for every
 *  minified `__d(...)` registration in `bundleJs`. A module usually is one
 *  line but may span several; its source is the first mapped line's. */
export function moduleSourcesFromMap(rawMap: SourceMapLike, bundleJs: string): Map<number, string | null> {
  const map = flattenIndexMap(rawMap);
  const srcPerLine = sourcePerLine(map);
  const out = new Map<number, string | null>();
  let start = -1;
  bundleJs.split("\n").forEach((text, i) => {
    if (text.startsWith("__d(")) start = i;
    if (start < 0) return;
    const m = /\}\)?,(\d+),\[[\d,]*\]\);\s*$/.exec(text);
    if (m === null) return;
    let srcIdx: number | null = null;
    for (let j = start; j <= i && srcIdx === null; j++) srcIdx = srcPerLine[j] ?? null;
    start = -1;
    out.set(Number(m[1]), srcIdx === null ? null : (map.sources[srcIdx] ?? null));
  });
  return out;
}

/** Path below the project's `node_modules/` (`safe-buffer/index.js`,
 *  `safe-buffer/node_modules/buffer/index.js`), or null for a file outside
 *  `node_modules` (the build's own entry file). The FIRST `node_modules/`
 *  is the project's, so a nested copy keeps its parent's prefix. */
export function nodeModulesRelativePath(source: string | null): string | null {
  if (source === null) return null;
  const s = source.replace(/\\/g, "/");
  const idx = s.indexOf("node_modules/");
  return idx < 0 ? null : s.slice(idx + "node_modules/".length);
}

export function modulePathsFromSourceMap(rawMap: SourceMapLike, bundleJs: string): Map<number, string | null> {
  const out = new Map<number, string | null>();
  for (const [id, src] of moduleSourcesFromMap(rawMap, bundleJs)) out.set(id, nodeModulesRelativePath(src));
  return out;
}

// --- build side ----------------------------------------------------------

/** Give each module its `path` and each function the `moduleId` of the
 *  module whose factory creates it (transitively, through CreateClosure
 *  operands; the first factory to reach a function claims it). Modules
 *  the map doesn't name get `path: null`. */
export function attachModulePaths(
  mod: HbcModule,
  decodeFunction: (mod: HbcModule, index: number) => DecodedFunction,
  functions: readonly SigFunction[],
  modules: readonly SigModule[],
  paths: ReadonlyMap<number, string | null>,
): { functions: SigFunction[]; modules: SigModule[] } {
  // "first" policy: the first module (in registration order) to reach a
  // function claims it -- the stored meaning of SigFunction.moduleId.
  // Modules without a numeric id claim nothing but still bound the walk.
  const roots = modules.filter((m) => m.localModuleId !== null).map((m) => m.factoryFunctionIndex);
  const stops = new Set(modules.filter((m) => m.localModuleId === null).map((m) => m.factoryFunctionIndex));
  const idOf = new Map(modules.map((m) => [m.factoryFunctionIndex, m.localModuleId]));
  const { owner } = closureOwnership(roots, (i) => directClosures(mod, decodeFunction, i), "first", stops);
  const moduleOf = new Map<number, number>();
  for (const [fn, root] of owner) moduleOf.set(fn, idOf.get(root)!);
  return {
    functions: functions.map((f) => {
      const id = moduleOf.get(f.index);
      return id === undefined ? { ...f } : { ...f, moduleId: id };
    }),
    modules: modules.map((m) => ({ ...m, path: m.localModuleId === null ? null : (paths.get(m.localModuleId) ?? null) })),
  };
}

// --- match side ----------------------------------------------------------

/** True when `path` is `pkg`'s own file: directly under `<pkg>/`, not under
 *  a nested `node_modules/` and not under another package's directory.
 *  A null path (outside node_modules, or unknown) is neutral: own. */
export function isOwnModulePath(pkg: string, path: string | null | undefined): boolean {
  if (path === null || path === undefined) return true;
  if (!path.startsWith(`${pkg}/`)) return false;
  return !path.slice(pkg.length + 1).includes("node_modules/");
}

/** The npm package a node_modules-relative path belongs to: the name after
 *  its last `node_modules/` (`a/node_modules/@s/b/x.js` -> `@s/b`). */
export function packageOfPath(path: string): string {
  const i = path.lastIndexOf("node_modules/");
  const rest = i >= 0 ? path.slice(i + "node_modules/".length) : path;
  const seg = rest.split("/");
  return seg[0]!.startsWith("@") && seg.length > 1 ? `${seg[0]}/${seg[1]}` : seg[0]!;
}

/** sigdb-strip-embedded: function index -> the package that a foreign
 *  module's path names, for a path-bearing file's foreign functions (empty
 *  for a pathless file). DB-wide indexes count the copy as that package's
 *  occurrence, never the carrier's. */
export function foreignFunctionPackages(file: SigDbFile): ReadonlyMap<number, string> {
  const out = new Map<number, string>();
  const fs = foreignSets(file);
  if (fs.functions.size === 0) return out;
  const byId = new Map<number, string>();
  const byFactory = new Map<number, string>();
  for (const m of file.modules) {
    if (isOwnModulePath(file.package, m.path) || m.path === null || m.path === undefined) continue;
    const pkg = packageOfPath(m.path);
    byFactory.set(m.factoryFunctionIndex, pkg);
    if (m.localModuleId !== null) byId.set(m.localModuleId, pkg);
  }
  for (const f of file.functions) {
    if (!fs.functions.has(f.index)) continue;
    const pkg = byFactory.get(f.index) ?? (f.moduleId !== undefined ? byId.get(f.moduleId) : undefined);
    if (pkg !== undefined) out.set(f.index, pkg);
  }
  return out;
}

export interface ForeignSets {
  /** Function indices whose module is another package's file. */
  readonly functions: ReadonlySet<number>;
  /** Factory function indices of modules that are another package's file. */
  readonly factories: ReadonlySet<number>;
}

const EMPTY: ForeignSets = { functions: new Set(), factories: new Set() };
const cache = new WeakMap<SigDbFile, ForeignSets>();

/** Foreign modules/functions of a path-bearing file; empty for a file
 *  without `modulePaths` (old files score exactly as before). */
export function foreignSets(file: SigDbFile): ForeignSets {
  if (file.modulePaths === undefined || file.modulePaths < 1) return EMPTY;
  const hit = cache.get(file);
  if (hit !== undefined) return hit;
  const foreignIds = new Set<number>();
  const factories = new Set<number>();
  for (const m of file.modules) {
    if (isOwnModulePath(file.package, m.path)) continue;
    factories.add(m.factoryFunctionIndex);
    if (m.localModuleId !== null) foreignIds.add(m.localModuleId);
  }
  const functions = new Set<number>();
  for (const f of file.functions) if ((f.moduleId !== undefined && foreignIds.has(f.moduleId)) || factories.has(f.index)) functions.add(f.index);
  const out = { functions, factories };
  cache.set(file, out);
  return out;
}

/** corpus-path-recall (docs/PACKAGE-SIGNATURES.md §7 "Recovery through the
 *  module graph"): a path-bearing file's own modules that require another
 *  package's module ("wrappers"), the distinct eligible exact hashes of its
 *  own path-bearing modules' functions, and each wrapper's distinct
 *  eligible fuzzy hashes. Computed from the full file; `slimSigFile`
 *  stores the counts so a slimmed file is judged the same. */
export function viaDependencyCounts(file: SigDbFile, minInstr: number): {
  readonly wrappers: readonly SigModule[];
  readonly depsOf: (m: SigModule) => readonly SigModule[];
  readonly ownPathDistinct: number;
  readonly ownFuzzy: Readonly<Record<number, number>>;
} {
  const byId = new Map(file.modules.map((m) => [m.localModuleId, m]));
  const isOwnPath = (m: SigModule): boolean => typeof m.path === "string" && isOwnModulePath(file.package, m.path);
  const depsOf = (m: SigModule): SigModule[] =>
    (m.depIds ?? []).map((d) => byId.get(d)).filter((d): d is SigModule => d !== undefined && typeof d.path === "string" && !isOwnModulePath(file.package, d.path));
  if (file.modulePaths === undefined || file.modulePaths < 1) return { wrappers: [], depsOf, ownPathDistinct: 0, ownFuzzy: {} };
  const ownIds = new Set(file.modules.filter(isOwnPath).map((m) => m.localModuleId));
  const wrappers = file.modules.filter((m) => isOwnPath(m) && m.localModuleId !== null && depsOf(m).length > 0);
  const wrapperIds = new Set(wrappers.map((m) => m.localModuleId));
  const exact = new Set<string>();
  const fuzzy = new Map<number, Set<string>>();
  for (const f of file.functions) {
    if (f.instrCount < minInstr || f.moduleId === undefined || !ownIds.has(f.moduleId)) continue;
    exact.add(f.exactHash);
    if (!wrapperIds.has(f.moduleId)) continue;
    let set = fuzzy.get(f.moduleId);
    if (set === undefined) fuzzy.set(f.moduleId, (set = new Set()));
    set.add(f.fuzzyHash);
  }
  const ownFuzzy: Record<number, number> = {};
  for (const m of wrappers) ownFuzzy[m.localModuleId!] = fuzzy.get(m.localModuleId!)?.size ?? 0;
  return { wrappers, depsOf, ownPathDistinct: exact.size, ownFuzzy };
}
