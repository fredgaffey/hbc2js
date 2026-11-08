// src/deps/sigdb-types.ts — the D17/D17b signature-DB file format (schema 2),
// promoted from the shape `tools/pkgsig/build-db.mjs` wrote by hand
// (docs/PACKAGE-SIGNATURES.md §5.3). One JSON file per `package@version` x
// HBC version, `<pkg>@<version>__hbc<N>.json` (`@scope/name` packages use
// `__` in place of `/`).

export interface SigFunction {
  readonly index: number;
  readonly name: string;
  readonly paramCount: number;
  readonly instrCount: number;
  readonly exactHash: string;
  readonly fuzzyHash: string;
  readonly stringSetHash: string;
  readonly stringCount: number;
  readonly owner?: string | null;
  /** Module paths v1 (src/deps/module-paths.ts): `localModuleId` of the
   *  module whose factory (transitively) creates this function. Absent on
   *  files without `modulePaths` and on functions outside every module. */
  readonly moduleId?: number;
}

export interface SigModule {
  readonly factoryFunctionIndex: number;
  readonly localModuleId: number | null;
  readonly depCount: number | null;
  readonly depIds: readonly number[] | null;
  readonly factoryExactHash: string | null;
  readonly factoryFuzzyHash: string | null;
  readonly nestedFunctionCount: number;
  /** Not in the JSON files (recomputed at fingerprint time); the sqlite layer
   *  keeps it when present (rev 3). Present on the
   *  in-memory result from `fingerprintModule` for callers (e.g. `guess.ts`)
   *  that need the actual nested indices, not just a count. */
  readonly nestedFunctionIndices?: readonly number[];
  readonly functionSetHash: string;
  readonly factoryIsBaseline: boolean;
  /** J4 (docs/DECISIONS.md D17c, dependency-aware subtraction): true when
   *  this module's factory hash matched a function in one of the package's
   *  own npm dependencies' (already-subtracted) signature — the dependency
   *  contamination `tools/pkgsig/bulk/dep-subtract.mjs` fixes, parallel to
   *  `factoryIsBaseline`. Optional/absent on every pre-J4 (v1) file. */
  readonly factoryIsDependency?: boolean;
  /** Module paths v1: this module's source file below the build project's
   *  `node_modules/` (`safe-buffer/index.js`; a nested copy keeps its
   *  parent's prefix, `safe-buffer/node_modules/buffer/index.js`), or null
   *  when outside node_modules / unknown. Only on `modulePaths` files. */
  readonly path?: string | null;
}

export interface SigProvenance {
  readonly packageSha256: string | null;
  readonly metroVersion: string | null;
  readonly reactNativeVersion: string | null;
  readonly hermescVersion: number;
  readonly hermescRnEra: string | null;
  readonly repoCommit: string | null;
  readonly builtAt: string;
}

export interface SigDbFile {
  readonly schema: 2;
  readonly package: string;
  readonly version: string;
  readonly hbcVersion: number;
  readonly totalFunctions: number;
  readonly rawFunctionCount: number;
  readonly subtractedBaselines: readonly string[];
  readonly functions: readonly SigFunction[];
  readonly modules: readonly SigModule[];
  readonly toolchainBaseline: boolean;
  readonly provenance: SigProvenance;
  /** J4 (docs/DECISIONS.md D17c; docs/specs/15-sigdb-schema.md): relative
   *  paths (sibling sigdb filenames, `<pkg>@<version>__hbc<N>.json`) of
   *  this package's own direct npm dependencies whose (already
   *  baseline-and-dependency-subtracted) function hash set was ALSO
   *  subtracted out of this file, fixing the contamination where a
   *  package's raw fingerprint contained its dependencies' code too (e.g.
   *  `@react-navigation/stack`'s raw fingerprint contained
   *  `@react-navigation/native`'s modules). Present (possibly `[]`, when a
   *  package has no in-DB dependencies to subtract) on every file written
   *  by `dep-subtract.mjs` — this is the v2 on-disk marker. **Absent**
   *  (`undefined`) on every pre-J4 (v1) file — `src/deps/db.ts`'s
   *  `loadSignatures` uses presence-of-this-field to decide that a v2 file
   *  for a package supersedes every v1 file for that same package, even at
   *  a different version, per docs/DECISIONS.md D17c's v1/v2
   *  compatibility rule (v2 never equals v1 for the same package, so
   *  loading both would let contaminated v1 entries keep winning
   *  collisions). */
  readonly subtractedDependencies?: readonly string[];
  /** LB1 (docs/DEPS.md "Hash scheme 2"): 2 = exact/fuzzy hashes computed
   *  with operand-width variants folded (`SIG_HASH_SCHEME`) AND baseline
   *  subtraction ownership-aware. Absent = scheme 1 (pre-LB1). A package
   *  with any scheme-2 entry supersedes its scheme-1 entries in
   *  `loadSignatures`. */
  readonly hashScheme?: number;
  /** Module paths v1 (docs/PACKAGE-SIGNATURES.md §7): present (= 1) when
   *  every module carries `path` and functions carry `moduleId`. Matching
   *  then scores the package on its OWN files only. Absent = no paths:
   *  scored exactly as before. */
  readonly modulePaths?: number;
  /** Bulk-build marker (`build-one.mjs`): 1 on every file built after the
   *  D17c foundation-subtraction fix. Absent on older files. */
  readonly bulkBuildFixVersion?: number;
  /** deps-slim-sigs, in-memory only (`slim-sigs.ts`): this record was
   *  prefiltered against one match target; `eligible`/`moduleTotal` are the
   *  counts `scorePackage` would compute from the full file at `minInstr`. */
  readonly slim?: {
    readonly minInstr: number;
    readonly eligible: number;
    readonly moduleTotal: number;
    readonly distinctEligible?: number;
    /** corpus-path-recall: distinct eligible exact hashes of the functions
     *  in own path-bearing modules, and per own module that requires another
     *  package's module, its distinct eligible fuzzy hashes (by
     *  localModuleId) — what `promoteViaDependency` needs from the
     *  functions slimming drops. */
    readonly ownPathDistinct?: number;
    readonly ownFuzzy?: Readonly<Record<number, number>>;
  };
}

export interface SigDbIndexEntry {
  readonly package: string;
  readonly version: string;
  readonly hbcVersion: number;
  readonly path: string;
  readonly totalFunctions: number;
  readonly isBaseline: boolean;
}

export interface SigDbIndex {
  readonly schema: 1;
  entries: SigDbIndexEntry[];
}
