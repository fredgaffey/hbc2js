// tools/pkgsig/bulk/transplant-lib.mjs — the pure parts of the module-paths
// rebuild (docs/PACKAGE-SIGNATURES.md §7 "Rebuilding a DB with paths"):
// job planning for rebuild-paths.sh and the old-file/fresh-fingerprint
// path transplant used by transplant-multi.mjs, plus the job-level work-dir
// lifecycle (`withWorkDir`, `runBundleJob`) that owns every `sigpaths-*`
// temp dir. Only the work-dir helpers touch the filesystem.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** RN scaffold family for a hermesc version (worker.sh: hbc98/99 build in
 * ScaffoldRN87, hbc94/96 in ScaffoldRN72). */
export const FAMILY_OF_HBC = { 94: "72", 96: "72", 98: "87", 99: "87" };

/** Signature basename `<pkg>@<ver>__hbc<N>.json` -> { pkgVer, hbc } or null. */
export function parseSigFileName(name) {
  const m = /^(.+)__hbc(\d+)\.json$/.exec(name);
  return m ? { pkgVer: m[1], hbc: Number(m[2]) } : null;
}

/** Group signature files into jobs: one Metro bundle per package@version
 * per RN family, every not-yet-done hbc file of that family compiled from
 * it. Returns [{ family, pkgVer, files }] sorted by family then pkgVer;
 * files already in `done` are dropped, empty jobs too. */
export function planJobs(names, done = new Set()) {
  const groups = new Map();
  for (const name of names) {
    const p = parseSigFileName(name);
    if (!p || done.has(name)) continue;
    const family = FAMILY_OF_HBC[p.hbc];
    if (family === undefined) continue;
    const key = `${family}\0${p.pkgVer}`;
    if (!groups.has(key)) groups.set(key, { family, pkgVer: p.pkgVer, files: [] });
    groups.get(key).files.push(name);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, files: g.files.sort() }))
    .sort((a, b) => (a.family === b.family ? (a.pkgVer < b.pkgVer ? -1 : a.pkgVer > b.pkgVer ? 1 : 0) : a.family < b.family ? 1 : -1));
}

/** Copy module paths and function module ids from a fresh path-bearing
 * fingerprint (`fresh`: { modules, functions } from attachModulePaths)
 * onto an old signature file without changing anything else. A module is
 * matched by same id + factory hash, else by a unique factory hash; a
 * function by same index + exact hash, else by an exact hash that only
 * one fresh module holds. Unmatched modules get `path: null` (neutral),
 * unmatched functions no `moduleId`. */
export function transplantPaths(old, fresh) {
  const freshById = new Map(fresh.modules.map((m) => [m.localModuleId, m]));
  const freshByHash = new Map();
  for (const m of fresh.modules) if (m.factoryExactHash) freshByHash.set(m.factoryExactHash, freshByHash.has(m.factoryExactHash) ? null : m);
  const idMap = new Map(); // fresh module id -> old module id
  let modMiss = 0;
  const modules = old.modules.map((m) => {
    let f = freshById.get(m.localModuleId);
    if (!f || f.factoryExactHash !== m.factoryExactHash) f = m.factoryExactHash ? freshByHash.get(m.factoryExactHash) ?? null : null;
    if (!f) { modMiss++; return { ...m, path: null }; }
    idMap.set(f.localModuleId, m.localModuleId);
    return { ...m, path: f.path ?? null };
  });
  const freshFnByIndex = new Map(fresh.functions.map((f) => [f.index, f]));
  const freshFnByHash = new Map();
  for (const f of fresh.functions) if (f.moduleId !== undefined) freshFnByHash.set(f.exactHash, freshFnByHash.has(f.exactHash) && freshFnByHash.get(f.exactHash) !== f.moduleId ? null : f.moduleId);
  let fnMiss = 0;
  const functions = old.functions.map((f) => {
    const g = freshFnByIndex.get(f.index);
    let mid = g && g.exactHash === f.exactHash ? g.moduleId : freshFnByHash.get(f.exactHash);
    mid = mid === undefined || mid === null ? undefined : idMap.get(mid);
    if (mid === undefined) { fnMiss++; const { moduleId: _x, ...rest } = f; return rest; }
    return { ...f, moduleId: mid };
  });
  return { modules, functions, modMiss, fnMiss, ok: old.modules.length > 0 && modMiss / old.modules.length <= 0.5 };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

/** Remove `sigpaths-<pid>-*` dirs under `tmpRoot` whose creating process is
 * gone (SIGKILL/OOM/timeout kills skip every `finally`). Dirs of live pids
 * and legacy unnumbered `sigpaths-XXXXXX` dirs are never touched. */
export function sweepStaleWorkDirs(tmpRoot = tmpdir()) {
  let n = 0;
  for (const name of readdirSync(tmpRoot)) {
    const m = /^sigpaths-(\d+)-/.exec(name);
    if (!m || pidAlive(Number(m[1]))) continue;
    rmSync(join(tmpRoot, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    n++;
  }
  return n;
}

/** Run `fn(work)` with a fresh `sigpaths-<pid>-*` dir under `tmpRoot`; the
 * dir this call created (and only it) is removed on success, throw and early
 * return. The rm retries (Metro workers may still be writing) and never
 * throws, so it cannot skip the caller's remaining cleanup. */
export function withWorkDir(fn, { tmpRoot = tmpdir() } = {}) {
  try { sweepStaleWorkDirs(tmpRoot); } catch {}
  const work = mkdtempSync(join(tmpRoot, `sigpaths-${process.pid}-`));
  const onSignal = (sig) => { cleanup(); process.exit(128 + (sig === "SIGINT" ? 2 : 15)); };
  const cleanup = () => { try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} };
  process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal);
  try { return fn(work); } finally {
    process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal);
    cleanup();
  }
}

/** The job: install, bundle once in a work dir, run `perFile` for each file,
 * clean up. `deps`: { install(), bundle(work) -> bundle ctx, perFile(file,
 * work, ctx) -> result fields (may throw), cleanup() }. Returns one result
 * per file; a bundle failure marks every file `bundle: ...`. */
export function runBundleJob(files, deps, { tmpRoot } = {}) {
  const why = (e) => String(e?.message ?? e).slice(0, 200) + " :: " + String(e?.stderr ?? "").slice(-400);
  const results = [];
  try {
    withWorkDir((work) => {
      deps.install();
      const ctx = deps.bundle(work);
      for (const file of files) {
        const res = { file, ok: false };
        results.push(res);
        try { Object.assign(res, deps.perFile(file, work, ctx)); } catch (e) { res.reason = why(e); }
      }
    }, { tmpRoot });
  } catch (e) {
    results.length = 0;
    for (const f of files) results.push({ file: f, ok: false, reason: "bundle: " + why(e) });
  } finally {
    try { deps.cleanup?.(); } catch {}
  }
  return results;
}
