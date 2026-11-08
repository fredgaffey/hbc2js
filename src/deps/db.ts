// src/deps/db.ts — the D17b layered signature-DB: project-local -> user
// cache -> shared, one file format across all three so a project DB can be
// contributed upstream by copying (docs/DECISIONS.md D17b).
//
// Lookup order (first hit wins for a given package@version+hbcVersion):
//   1. project-local: `<outDir>/.hbc2js/sigdb/` (or `--sigdb <dir>`), written
//      by `hbc2js deps --confirm` so a decompilation project's results are
//      reproducible offline.
//   2. user cache: `~/.cache/hbc2js/sigdb/` (respects `XDG_CACHE_HOME`).
//   3. shared: `tools/pkgsig/db/` in this repo (the D17/T8 starter set),
//      disabled by `--no-shared-db`.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { packageNameFromSigFilename } from "./candidates.ts";
import { hexHash, insertFingerprint, newShapeCache, openSigDb, type ShapeCache } from "./sigdb-sql.ts";
import type { SigDbFile, SigDbIndex, SigDbIndexEntry } from "./sigdb-types.ts";

export type DbLayerName = "project" | "user" | "shared";

export interface DbLayer {
  readonly name: DbLayerName;
  readonly dir: string;
  /** True for an explicit `--sigdb <dir>`: may be a huge bulk DB, so it
   *  honours the candidate filter. The genuine project layer stays false. */
  readonly filterable?: boolean;
}

export interface DbLayerOptions {
  /** Decompile output directory; project-local DB lives at `<outDir>/.hbc2js/sigdb`. */
  readonly outDir?: string;
  /** Overrides the project-local directory outright. */
  readonly sigdb?: string;
  readonly noSharedDb?: boolean;
}

/** `<repo-or-package-root>/tools/pkgsig/db` — works both from `src/deps/db.ts`
 *  (dev, `src/deps` -> repo root is two levels up) and from the built
 *  `dist/deps/db.js` (an npm install ships `tools/pkgsig/db` alongside
 *  `dist/`, see `package.json`'s `files`), since both sit two levels below
 *  the package root. */
export function defaultSharedDbDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "tools", "pkgsig", "db");
}

export function userCacheDbDir(): string {
  const base = process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.length > 0 ? process.env.XDG_CACHE_HOME : join(homedir(), ".cache");
  return join(base, "hbc2js", "sigdb");
}

export function projectDbDir(opts: DbLayerOptions): string {
  if (opts.sigdb !== undefined) return opts.sigdb;
  return join(opts.outDir ?? ".", ".hbc2js", "sigdb");
}

export function resolveDbLayers(opts: DbLayerOptions): DbLayer[] {
  const layers: DbLayer[] = [
    { name: "project", dir: projectDbDir(opts), filterable: opts.sigdb !== undefined },
    { name: "user", dir: userCacheDbDir() },
  ];
  if (!opts.noSharedDb) layers.push({ name: "shared", dir: defaultSharedDbDir() });
  return layers;
}

export interface LoadedSig {
  readonly file: SigDbFile;
  readonly layer: DbLayerName;
  readonly path: string;
}

function listJsonFiles(dir: string, candidates?: ReadonlySet<string>): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir)) {
    if (name === "index.json") continue;
    if (!name.endsWith(".json")) continue;
    // Evidence-directed filtering (`candidates.ts`): when a
    // candidate set is given, skip any non-baseline file whose own
    // filename-derived package name isn't in it — this is what turns
    // "read and JSON.parse every signature file" into "read only the ones
    // the bundle's own strings gave a reason to check". `candidates`
    // undefined (the default for every existing caller of `loadSignatures`)
    // preserves the exact previous exhaustive behaviour.
    if (candidates !== undefined) {
      const pkg = packageNameFromSigFilename(name);
      if (pkg === null || !candidates.has(pkg)) continue;
    }
    files.push(join(dir, name));
  }
  // Baselines are foundational subtraction data (react/react-native/metro
  // "empty app" noise floors), not named npm packages a bundle's strings
  // could ever give evidence for — always loaded in full, regardless of
  // candidates, same as before this task.
  const baselines = join(dir, "_baselines");
  if (existsSync(baselines)) {
    for (const name of readdirSync(baselines)) {
      if (name.endsWith(".json")) files.push(join(baselines, name));
    }
  }
  return files;
}

function keyOf(f: SigDbFile): string {
  return `${f.package}@${f.version}__hbc${f.hbcVersion}`;
}

// docs/specs/15-sigdb-schema.md §4 write-path dispatch: a path ending in
// `.sqlite` is a sigdb v3 SQLite file (per `src/deps/sigdb-sql.ts`), any
// other path is a legacy JSON layer directory — unchanged behaviour. This
// is the one dispatch point both `writeSignature` call sites (`confirm.ts`,
// `tools/pkgsig/bulk/build-one.mjs`) share, per the spec's "both callers
// change minimally" note.
const SQLITE_SUFFIX = ".sqlite";

// One open `DatabaseSync` + shape-intern cache per sqlite path for this
// process's lifetime — `openSigDb` rejects being re-applied to an existing
// file (§9 A1), and reopening per call would also throw away the intern
// cache's dedupe benefit across a run's many `writeSignature` calls.
const sqliteWriteHandles = new Map<string, { db: DatabaseSync; cache: ShapeCache }>();

function sqliteWriteHandleFor(path: string): { db: DatabaseSync; cache: ShapeCache } {
  let handle = sqliteWriteHandles.get(path);
  if (handle === undefined) {
    mkdirSync(dirname(path), { recursive: true });
    handle = { db: openSigDb(path), cache: newShapeCache() };
    sqliteWriteHandles.set(path, handle);
  }
  return handle;
}

/** Reads every fingerprint out of a sigdb v3 SQLite file as `SigDbFile`
 *  objects, for `loadSignatures`'s DB-layer fallback (§4 "Read side" —
 *  full parity with the §6 candidate-probe query is implementation step 6
 *  in the spec's own plan; this is the minimal read needed so a layer
 *  written via `writeSignature(..., ".sqlite")` is served back, not the
 *  optimized probe). Quarantined fingerprints (§12 "quarantine-as-column")
 *  are never served, matching the old quarantine-by-moving-files
 *  behaviour. Deliberately does not reuse `tools/pkgsig/sigdb/import-json.mjs`'s
 *  `reconstructFingerprint` — that reader is kept independent of every other
 *  writer/reader pair on purpose (§12 review item 6, `sigdb-sql.ts`'s own
 *  header); this is a third, ordinary consumer, not a validator. */
function loadSqliteSignatures(dbPath: string): SigDbFile[] {
  const db = openSigDb(dbPath);
  const fps = db
    .prepare(
      `SELECT f.fp_id, f.hbc_version, f.source_schema, f.total_functions, f.raw_function_count,
              f.toolchain_baseline, f.package_sha256, f.metro_version, f.react_native_version,
              f.hermesc_version, f.hermesc_rn_era, f.repo_commit, f.built_at,
              f.hash_scheme, f.module_paths, pv.version AS pv_version, p.name AS pkg_name
       FROM fingerprints f
       JOIN package_versions pv ON pv.pv_id = f.pv_id
       JOIN packages p ON p.pkg_id = pv.pkg_id
       WHERE f.quarantined IS NULL`,
    )
    .all() as Array<{
    fp_id: number;
    hbc_version: number;
    source_schema: number;
    total_functions: number;
    raw_function_count: number;
    toolchain_baseline: number;
    package_sha256: string | null;
    metro_version: string | null;
    react_native_version: string | null;
    hermesc_version: number;
    hermesc_rn_era: string | null;
    repo_commit: string | null;
    built_at: string;
    hash_scheme: number | null;
    module_paths: number | null;
    pv_version: string;
    pkg_name: string;
  }>;

  return fps.map((fp) => {
    const subtractedBaselines = (
      db.prepare(`SELECT baseline_ref FROM fingerprint_baselines WHERE fp_id = ? ORDER BY ordinal`).all(fp.fp_id) as Array<{ baseline_ref: string }>
    ).map((r) => r.baseline_ref);

    const functions = (
      db
        .prepare(
          `SELECT ff.fn_index AS idx, s.exact_hash, s.fuzzy_hash, s.string_set_hash, s.name,
                  s.param_count, s.instr_count, s.string_count, ff.module_id
           FROM fingerprint_functions ff JOIN function_shapes s ON s.shape_id = ff.shape_id
           WHERE ff.fp_id = ? ORDER BY ff.fn_index`,
        )
        .all(fp.fp_id) as Array<{
        idx: number;
        exact_hash: Uint8Array;
        fuzzy_hash: Uint8Array;
        string_set_hash: Uint8Array;
        name: string;
        param_count: number;
        instr_count: number;
        string_count: number;
        module_id: number | null;
      }>
    ).map((r) => ({
      index: r.idx,
      name: r.name,
      paramCount: r.param_count,
      instrCount: r.instr_count,
      exactHash: hexHash(r.exact_hash),
      fuzzyHash: hexHash(r.fuzzy_hash),
      stringSetHash: hexHash(r.string_set_hash),
      stringCount: r.string_count,
      ...(r.module_id != null ? { moduleId: r.module_id } : {}),
    }));

    const modules = (
      db.prepare(`SELECT * FROM modules WHERE fp_id = ? ORDER BY module_ordinal`).all(fp.fp_id) as Array<{
        factory_function_index: number;
        local_module_id: number | null;
        dep_count: number | null;
        dep_ids: string | null;
        factory_exact_hash: Uint8Array | null;
        factory_fuzzy_hash: Uint8Array | null;
        nested_function_count: number;
        function_set_hash: Uint8Array;
        factory_is_baseline: number;
        path: string | null;
      }>
    ).map((r) => ({
      factoryFunctionIndex: r.factory_function_index,
      localModuleId: r.local_module_id,
      depCount: r.dep_count,
      depIds: r.dep_ids != null ? (JSON.parse(r.dep_ids) as number[]) : null,
      factoryExactHash: r.factory_exact_hash != null ? hexHash(r.factory_exact_hash) : null,
      factoryFuzzyHash: r.factory_fuzzy_hash != null ? hexHash(r.factory_fuzzy_hash) : null,
      nestedFunctionCount: r.nested_function_count,
      functionSetHash: hexHash(r.function_set_hash),
      factoryIsBaseline: !!r.factory_is_baseline,
      ...(fp.module_paths != null ? { path: r.path ?? null } : {}),
    }));

    return {
      schema: fp.source_schema as 2,
      ...(fp.hash_scheme != null ? { hashScheme: fp.hash_scheme } : {}),
      ...(fp.module_paths != null ? { modulePaths: fp.module_paths } : {}),
      package: fp.pkg_name,
      version: fp.pv_version,
      hbcVersion: fp.hbc_version,
      totalFunctions: fp.total_functions,
      rawFunctionCount: fp.raw_function_count,
      subtractedBaselines,
      functions,
      modules,
      toolchainBaseline: !!fp.toolchain_baseline,
      provenance: {
        packageSha256: fp.package_sha256,
        metroVersion: fp.metro_version,
        reactNativeVersion: fp.react_native_version,
        hermescVersion: fp.hermesc_version,
        hermescRnEra: fp.hermesc_rn_era,
        repoCommit: fp.repo_commit,
        builtAt: fp.built_at,
      },
    };
  });
}

export interface LoadSignaturesOptions {
  /** Evidence-directed candidate set (`candidates.ts`): when
   *  given, `user`/`shared` layers only load a non-baseline signature file
   *  whose own package name is in this set (baselines always load in full
   *  — see `listJsonFiles`). The `project` layer always loads in full
   *  regardless — it's small (this project's own `--confirm` results) and
   *  explicit, not something string-evidence should gate. Omitted (every
   *  existing caller before this task) preserves the exact previous
   *  exhaustive behaviour. */
  readonly candidates?: ReadonlySet<string>;
  /** Bundle HBC version (corpus-remeasure2-brex-oom): `matchInventory` only
   *  scores files of this HBC version, so JSON files of any other version
   *  are parsed transiently and only their supersession metadata (package,
   *  hash scheme, v2-ness) is kept, never the full signature. The v1/v2 and
   *  hash-scheme supersession below sees exactly the same sets as before, so
   *  the returned entries of this version are identical. Omitted: all load. */
  readonly hbcVersion?: number;
  /** Filled with the package names of the entries dropped by `hbcVersion`
   *  (callers that treat "a signature exists for this package" as known). */
  readonly otherHbcPackages?: Set<string>;
}

/**
 * Load every signature file across the given layers, in priority order,
 * deduplicating by `package@version` x HBC version so a project-local
 * confirmation shadows a stale shared/user-cache copy rather than being
 * matched twice.
 */
export function loadSignatures(layers: readonly DbLayer[], opts: LoadSignaturesOptions = {}): LoadedSig[] {
  const seen = new Set<string>();
  const out: LoadedSig[] = [];
  const stubs = new Set<LoadedSig>();
  for (const layer of layers) {
    // §4 layer detection: a `sigdb.sqlite` in the layer directory (or the
    // layer dir itself naming a `.sqlite` file, for callers that pass one
    // directly) is served from the DB; otherwise fall back to the JSON
    // layer unchanged — existing JSON-only callers see no behaviour change.
    const sqlitePath = layer.dir.endsWith(SQLITE_SUFFIX) ? (existsSync(layer.dir) ? layer.dir : null) : (() => {
      const candidate = join(layer.dir, "sigdb.sqlite");
      return existsSync(candidate) ? candidate : null;
    })();
    if (sqlitePath !== null) {
      for (const file of loadSqliteSignatures(sqlitePath)) {
        const key = keyOf(file);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ file, layer: layer.name, path: sqlitePath });
      }
      continue;
    }
    const candidates = layer.name === "project" && layer.filterable !== true ? undefined : opts.candidates;
    for (const path of listJsonFiles(layer.dir, candidates)) {
      let file: SigDbFile;
      try {
        file = JSON.parse(readFileSync(path, "utf8")) as SigDbFile;
      } catch {
        continue;
      }
      const key = keyOf(file);
      if (seen.has(key)) continue;
      seen.add(key);
      if (opts.hbcVersion !== undefined && file.hbcVersion !== opts.hbcVersion && !file.toolchainBaseline) {
        const stub = { package: file.package, hbcVersion: file.hbcVersion, version: file.version, toolchainBaseline: false, ...(file.hashScheme !== undefined ? { hashScheme: file.hashScheme } : {}), ...(file.subtractedDependencies !== undefined ? { subtractedDependencies: [] } : {}) } as unknown as SigDbFile;
        const entry = { file: stub, layer: layer.name, path };
        stubs.add(entry);
        opts.otherHbcPackages?.add(file.package);
        out.push(entry);
        continue;
      }
      out.push({ file, layer: layer.name, path });
    }
  }
  // J4 v1/v2 compatibility (docs/DECISIONS.md D17c): a package with at
  // least one v2 (dependency-subtracted, `subtractedDependencies` present)
  // entry loaded ANYWHERE across the given layers supersedes every v1
  // entry for that same package name, even at a different version and even
  // when the v1 copy lives in a different layer — the exact-key `seen`
  // dedup above only shadows same `package@version+hbcVersion` collisions,
  // which is not enough: a fetched v2 release for `@react-navigation/stack`
  // must hide the repo's own committed v1 `tools/pkgsig/db/` copy at a
  // different version too, so contaminated v1 entries can never keep
  // winning collisions. Baselines (`toolchainBaseline: true`) are never
  // superseded — they aren't "a package" in this sense and are always
  // reloaded regardless of which generation of a real package sits beside
  // them.
  //
  // LB1 hash scheme (same shape, applied first): a package with any
  // hash-scheme-2 (width-folded, ownership-aware-subtracted) entry drops
  // every older-scheme entry of that package name. Older-scheme entries of
  // OTHER packages still load and are scored against the target's own
  // scheme-1 hashes (`matchInventory`), never against scheme-2 ones.
  const scheme2Packages = new Set(out.filter((l) => (l.file.hashScheme ?? 1) >= 2 && !l.file.toolchainBaseline).map((l) => l.file.package));
  const current = scheme2Packages.size === 0 ? out : out.filter((l) => l.file.toolchainBaseline || (l.file.hashScheme ?? 1) >= 2 || !scheme2Packages.has(l.file.package));
  const v2Packages = new Set(current.filter((l) => l.file.subtractedDependencies !== undefined && !l.file.toolchainBaseline).map((l) => l.file.package));
  const result = v2Packages.size === 0 ? current : current.filter((l) => l.file.toolchainBaseline || l.file.subtractedDependencies !== undefined || !v2Packages.has(l.file.package));
  return stubs.size === 0 ? result : result.filter((l) => !stubs.has(l));
}

/** Write (or overwrite) one signature file into `dir` and update its
 *  `index.json` manifest. Used by the confirm stage (project-local + user
 *  cache) and by whoever seeds/rebuilds the shared DB.
 *
 *  §4 write-path dispatch: when `dir` ends in `.sqlite`, this instead opens
 *  (or reuses, per-process) that sigdb v3 file and writes via
 *  `insertFingerprint` — the JSON-writing code below is untouched, so both
 *  outputs stay available (JSON remains ground truth per §8/§12 non-goals).
 *  Returns `dir` itself in that case (there is no per-file path — the DB is
 *  its own index). */
export function writeSignature(dir: string, db: SigDbFile): string {
  if (dir.endsWith(SQLITE_SUFFIX)) {
    const { db: sqlDb, cache } = sqliteWriteHandleFor(dir);
    insertFingerprint(sqlDb, db, cache);
    return dir;
  }
  const outDir = db.toolchainBaseline ? join(dir, "_baselines") : dir;
  mkdirSync(outDir, { recursive: true });
  const safeName = db.package.replace(/\//g, "__");
  const outPath = join(outDir, `${safeName}@${db.version}__hbc${db.hbcVersion}.json`);
  writeFileSync(outPath, JSON.stringify(db));
  updateIndex(dir, {
    package: db.package,
    version: db.version,
    hbcVersion: db.hbcVersion,
    path: relative(dir, outPath),
    totalFunctions: db.totalFunctions,
    isBaseline: db.toolchainBaseline,
  });
  return outPath;
}

function updateIndex(dbDir: string, entry: SigDbIndexEntry): void {
  mkdirSync(dbDir, { recursive: true });
  const indexPath = join(dbDir, "index.json");
  let index: SigDbIndex = { schema: 1, entries: [] };
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, "utf8")) as SigDbIndex;
    } catch {
      index = { schema: 1, entries: [] };
    }
  }
  index.entries = index.entries.filter((e) => !(e.package === entry.package && e.version === entry.version && e.hbcVersion === entry.hbcVersion));
  index.entries.push(entry);
  index.entries.sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : a.hbcVersion - b.hbcVersion));
  writeFileSync(indexPath, JSON.stringify(index, null, 1));
}
