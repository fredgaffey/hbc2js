#!/usr/bin/env node
// tools/pkgsig/bulk/dep-subtract.mjs — J4 (docs/DECISIONS.md D17c):
// dependency-aware subtraction, the contamination fix folded into this
// item (formerly tracked separately as I6).
//
// This file has two halves:
//   1. Pure, network-free functions (subtractDependencySignatures,
//      resolveDependencyVersion, topoSortPackages) -- unit-tested by
//      test-dep-subtract.mjs, no `src/**` import, no filesystem/network.
//   2. `run(dbDir, outDir, opts)` -- the orchestration driver: for every
//      package@version already in `dbDir`, fetch its declared npm
//      `dependencies` from the registry (network -- run this on the remote build node, same
//      as build-one.mjs's own installs), resolve each declared range
//      against the OTHER package versions already fingerprinted in
//      `dbDir`, topologically sort so a dependency is always processed
//      before its dependent, and write a new file per package@version+hbc
//      into `outDir` with `subtractedDependencies` populated -- the v2
//      on-disk marker `src/deps/db.ts`'s `loadSignatures` uses to
//      supersede v1 entries for that package (docs/specs/15-sigdb-schema.md;
//      see also `src/deps/sigdb-types.ts`'s field doc-comment).
//
// `outDir` is always SEPARATE from `dbDir` -- v1 is read-only input here,
// never mutated in place, matching "ship v2 as a NEW release, never by
// editing v1" (this task's binding revision 3... err 2).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// ---------------------------------------------------------------------
// 1. Pure functions
// ---------------------------------------------------------------------

/**
 * Subtract every dependency's function hash set out of a package's raw
 * (already baseline-subtracted) function/module set. `deps` is an array of
 * `{ key, hashes: Set<exactHash> }`, one per direct npm dependency already
 * present (and itself already subtracted) in the DB. Mirrors
 * `baseline-subtract.mjs`'s `subtractBaseline` shape exactly: functions
 * whose hash is in ANY dependency's set are dropped; a module whose
 * factory hash matches is KEPT (graph stays complete for `__d()`
 * anchoring) but flagged `factoryIsDependency: true`.
 */
export function subtractDependencySignatures(rawFunctions, rawModules, deps) {
  const union = new Set();
  for (const d of deps) for (const h of d.hashes) union.add(h);
  const functions = rawFunctions.filter((f) => !union.has(f.exactHash));
  const modules = rawModules.map((m) => ({
    ...m,
    factoryIsDependency: m.factoryExactHash !== null && union.has(m.factoryExactHash),
  }));
  const removedCount = rawFunctions.length - functions.length;
  return { functions, modules, removedCount };
}

/**
 * Pick the highest `available` version satisfying `range` (a package.json
 * dependency range string), or `null` when none does. Lazily imports
 * `semver` (an existing project dependency, `node_modules/semver`) so this
 * module stays importable in the pure-function unit test without any
 * extra setup.
 */
export function resolveDependencyVersion(range, available) {
  const semver = requireSemver();
  let best = null;
  for (const v of available) {
    if (!semver.valid(v)) continue;
    if (!semver.satisfies(v, range, { includePrerelease: true })) continue;
    if (best === null || semver.gt(v, best)) best = v;
  }
  return best;
}

// Lazy `require("semver")` (an existing project dependency,
// `node_modules/semver`) via `createRequire`, so this pure function stays
// callable from a plain ESM unit test with no top-level await and no
// import-resolution cost paid by callers that never use it.
let _semver;
function requireSemver() {
  if (_semver === undefined) _semver = createRequire(import.meta.url)("semver");
  return _semver;
}

/**
 * Topological sort of a package dependency graph, `{ [pkgKey]: depKey[] }`
 * (edges point from a package to its dependencies). Returns an array of
 * keys with every dependency appearing before its dependents. A cycle
 * (e.g. mutual peer deps) is broken, not thrown -- each node is still
 * visited exactly once (Tarjan-style DFS post-order with a visiting-set
 * cycle guard, not Kahn's, specifically so a cycle degrades gracefully
 * instead of leaving nodes permanently blocked on each other).
 */
export function topoSortPackages(edges) {
  const order = [];
  const done = new Set();
  const visiting = new Set();
  function visit(key) {
    if (done.has(key) || visiting.has(key)) return; // cycle: stop recursing, key gets ordered by whoever visits it first up the stack
    visiting.add(key);
    for (const dep of edges[key] ?? []) visit(dep);
    visiting.delete(key);
    done.add(key);
    order.push(key);
  }
  for (const key of Object.keys(edges)) visit(key);
  return order;
}

// ---------------------------------------------------------------------
// 2. Orchestration (network + filesystem; run on the remote build node)
// ---------------------------------------------------------------------

function safeName(p) {
  return p.replace(/\//g, "__");
}

/** `<safeName>@<version>__hbc<N>.json` -> `{ name, version, hbcVersion }`, or null. */
function parseSigFilename(filename) {
  const m = /^(.+)@([^@]+)__hbc(\d+)\.json$/.exec(filename);
  if (m === null) return null;
  return { name: m[1].replace(/__/g, "/"), version: m[2], hbcVersion: Number(m[3]) };
}

/** Scans `dbDir` (flat, excluding `_baselines/` and `index*.json`) and
 *  returns `{ byNameVersion: Map<"name@version", {hbcVersions:number[], files:Map<hbc,path>}>, names: Set<string> }`. */
function scanDb(dbDir) {
  const byNameVersion = new Map();
  for (const filename of readdirSync(dbDir)) {
    if (!filename.endsWith(".json") || filename.startsWith("index")) continue;
    const parsed = parseSigFilename(filename);
    if (parsed === null) continue;
    const key = `${parsed.name}@${parsed.version}`;
    let entry = byNameVersion.get(key);
    if (entry === undefined) {
      entry = { name: parsed.name, version: parsed.version, files: new Map() };
      byNameVersion.set(key, entry);
    }
    entry.files.set(parsed.hbcVersion, join(dbDir, filename));
  }
  return byNameVersion;
}

/** Pure: the three registry-doc fields Metro can actually end up bundling,
 *  merged into one flat `{name: range}` map. Extracted from
 *  `fetchDependencies` so this exact merge -- the fix for the real
 *  peerDependencies contamination case above -- is unit-testable without
 *  network. Later fields win on a name collision (arbitrary; a package
 *  declaring the same name in two of these three fields with conflicting
 *  ranges would be unusual). */
export function mergeDependencyFields(doc) {
  return { ...(doc.dependencies ?? {}), ...(doc.peerDependencies ?? {}), ...(doc.optionalDependencies ?? {}) };
}

async function fetchDependencies(name, version, cacheDir) {
  const cachePath = cacheDir === undefined ? null : join(cacheDir, `${safeName(name)}@${version}.deps.json`);
  if (cachePath !== null && existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, "utf8"));
  }
  const url = `https://registry.npmjs.org/${name.startsWith("@") ? name.replace("/", "%2f") : name}/${version}`;
  let deps = {};
  try {
    const res = await fetch(url);
    if (res.ok) deps = mergeDependencyFields(await res.json());
  } catch {
    deps = {}; // best-effort: no network / not-found -> treat as "no known dependencies"
  }
  if (cachePath !== null) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(deps));
  }
  return deps;
}

/**
 * Run dependency-aware subtraction over every package@version in `dbDir`,
 * writing subtracted files into `outDir` (created if needed; `dbDir` is
 * never modified). `opts.concurrency` bounds simultaneous registry
 * fetches (default 24). `opts.cacheDir`, when given, caches each
 * package@version's resolved `dependencies` doc on disk so a re-run (e.g.
 * after a partial failure) doesn't re-fetch the registry.
 *
 * Returns a summary: `{ packagesProcessed, filesWritten, filesSkippedNoDeps, unresolvedDependencies: [{name,version,dep,range}] }`.
 */
export async function run(dbDir, outDir, opts = {}) {
  const concurrency = opts.concurrency ?? 24;
  const byNameVersion = scanDb(dbDir);
  const names = new Set([...byNameVersion.values()].map((e) => e.name));

  // Fetch every package@version's declared dependencies, concurrency-bounded.
  const entries = [...byNameVersion.values()];
  const depsOf = new Map(); // "name@version" -> {depName: range}
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= entries.length) return;
      const e = entries[i];
      const deps = await fetchDependencies(e.name, e.version, opts.cacheDir);
      depsOf.set(`${e.name}@${e.version}`, deps);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));

  // Resolve each declared dependency range against the OTHER versions of
  // that same package already in the DB, restricted to dependencies whose
  // package NAME is also in the DB at all (opts.unresolvedDependencies
  // reports the rest for transparency -- contamination from a dependency
  // we never fingerprinted just isn't fixable yet, and is left as-is
  // rather than silently pretended-clean).
  const versionsByName = new Map();
  for (const e of byNameVersion.values()) {
    if (!versionsByName.has(e.name)) versionsByName.set(e.name, []);
    versionsByName.get(e.name).push(e.version);
  }
  const resolvedDepKey = new Map(); // "name@version" -> {depKey: "depName@depVersion"}
  const unresolvedDependencies = [];
  for (const [key, deps] of depsOf) {
    const [name, version] = splitKey(key);
    const resolved = {};
    for (const [depName, range] of Object.entries(deps)) {
      const available = versionsByName.get(depName);
      if (available === undefined) continue; // dependency never fingerprinted at all -- not fixable here
      const v = resolveDependencyVersion(range, available);
      if (v === null) {
        unresolvedDependencies.push({ name, version, dep: depName, range });
        continue;
      }
      resolved[depName] = v;
    }
    resolvedDepKey.set(key, resolved);
  }

  // Topo-sort ONLY over edges that resolved to an in-DB dependency.
  const edges = {};
  for (const [key, resolved] of resolvedDepKey) {
    edges[key] = Object.entries(resolved).map(([depName, depVersion]) => `${depName}@${depVersion}`);
  }
  const order = topoSortPackages(edges);

  // Memory: of ~2,159 packages, the overwhelming majority (generic top-npm
  // packages with no RN-ecosystem interdependency, e.g. "abbrev") are never
  // any OTHER in-DB package's dependency -- their hash set never needs to
  // outlive their own write. Retaining every package's cleaned hash set for
  // the whole run (71,300 files, ~28 GB of raw JSON) OOM'd a first attempt
  // at a 4 GB default V8 heap; caching only the sets someone will actually
  // read fixes it without raising --max-old-space-size.
  const neededAsDependency = new Set();
  for (const resolved of resolvedDepKey.values()) for (const [n, v] of Object.entries(resolved)) neededAsDependency.add(`${n}@${v}`);

  mkdirSync(outDir, { recursive: true });
  const cleanedHashesByHbc = new Map(); // hbcVersion -> Map<"name@version", Set<hash>>  (only for keys in neededAsDependency)
  let filesWritten = 0;
  let filesSkippedNoDeps = 0;

  for (const key of order) {
    const entry = byNameVersion.get(key);
    if (entry === undefined) continue; // shouldn't happen; defensive
    const resolved = resolvedDepKey.get(key) ?? {};
    const depKeys = Object.entries(resolved).map(([n, v]) => `${n}@${v}`);
    for (const [hbcVersion, path] of entry.files) {
      let byPkg = cleanedHashesByHbc.get(hbcVersion);
      if (byPkg === undefined) {
        byPkg = new Map();
        cleanedHashesByHbc.set(hbcVersion, byPkg);
      }
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const depSets = [];
      const subtractedDependencies = [];
      for (const dk of depKeys) {
        const hashes = byPkg.get(dk);
        if (hashes === undefined) continue; // that dependency has no build at this hbc version -- skip, not fixable for this hbc
        depSets.push({ key: dk, hashes });
        subtractedDependencies.push(`${safeName(dk.slice(0, dk.lastIndexOf("@")))}@${dk.slice(dk.lastIndexOf("@") + 1)}__hbc${hbcVersion}.json`);
      }
      const { functions, modules, removedCount } = subtractDependencySignatures(raw.functions, raw.modules, depSets);
      if (removedCount === 0 && subtractedDependencies.length === 0) filesSkippedNoDeps++;
      const out = {
        ...raw,
        totalFunctions: functions.length,
        functions,
        modules,
        subtractedDependencies,
      };
      if (neededAsDependency.has(key)) byPkg.set(key, new Set(functions.map((f) => f.exactHash)));
      const outName = `${safeName(entry.name)}@${entry.version}__hbc${hbcVersion}.json`;
      writeFileSync(join(outDir, outName), JSON.stringify(out));
      filesWritten++;
    }
  }

  return { packagesProcessed: order.length, filesWritten, filesSkippedNoDeps, unresolvedDependencies, dbPackageNames: names.size };
}

function splitKey(key) {
  const i = key.lastIndexOf("@");
  return [key.slice(0, i), key.slice(i + 1)];
}

// CLI entry point: node dep-subtract.mjs <dbDir> <outDir> [--cache-dir <dir>] [--concurrency N]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const [dbDir, outDir] = args.filter((a) => !a.startsWith("--"));
  const cacheIdx = args.indexOf("--cache-dir");
  const cacheDir = cacheIdx >= 0 ? args[cacheIdx + 1] : undefined;
  const concIdx = args.indexOf("--concurrency");
  const concurrency = concIdx >= 0 ? Number(args[concIdx + 1]) : undefined;
  if (!dbDir || !outDir) {
    console.error("usage: dep-subtract.mjs <dbDir> <outDir> [--cache-dir <dir>] [--concurrency N]");
    process.exit(2);
  }
  const summary = await run(dbDir, outDir, { cacheDir, concurrency });
  console.log(JSON.stringify(summary, null, 1));
}
