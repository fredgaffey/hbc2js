// src/deps/match.ts — the D17a "match" stage: score every layered signature
// DB entry against a target bundle's module inventory, with confidence
// tiers, and attribute each `__d()` module to its best-owning package.
// Promoted + adapted from `tools/pkgsig/match.mjs` v2
// (docs/PACKAGE-SIGNATURES.md §5.4).

import type { LoadedSig } from "./db.ts";
import type { ModuleInventory } from "./inventory.ts";
import type { SigDbFile } from "./sigdb-types.ts";
import { foreignSets, isOwnModulePath, viaDependencyCounts } from "./module-paths.ts";

export type ConfidenceTier = "high" | "medium" | "low" | "none";

export interface PackageScore {
  readonly package: string;
  readonly version: string;
  readonly hbcVersion: number;
  readonly layer: LoadedSig["layer"];
  readonly isBaseline: boolean;
  readonly eligibleFunctions: number;
  readonly exactHits: number;
  readonly fuzzyOnlyHits: number;
  readonly stringCorroborated: number;
  readonly exactCoverage: number;
  readonly fuzzyCoverage: number;
  readonly moduleExactHits: number;
  readonly moduleTotal: number;
  readonly tier: ConfidenceTier;
  /** Set when a precision rule (corpus-precision-forks, docs/DEPS.md
   *  "Forks, embedded copies and repeated hashes") lowered a would-be
   *  "high" score to "medium": `few-distinct` (the hits are fewer than
   *  MIN_DISTINCT_EVIDENCE_HASHES distinct hashes), `container` (the hits
   *  sit inside target modules far larger than the whole package),
   *  `embedded` (the hits are a subset of another confirmed, path-bearing
   *  package's own files), `twin` (the same hits as another confirmed
   *  package, which was kept). `by` names the other package. */
  readonly demotion?: { readonly rule: "few-distinct" | "container" | "scattered" | "embedded" | "twin" | "inlined" | "bundled-dist"; readonly by?: string };
  /** Set when corpus-path-recall's module-graph rule (`promoteViaDependency`,
   *  docs/PACKAGE-SIGNATURES.md §7 "Recovery through the module graph")
   *  raised a path-bearing package to "high": an app module shaped like one
   *  of its own files requires the module of `by`, its signature's own
   *  dependency. `edge: "exact"`: the own code is all present by exact hash
   *  and the required module is the dependency's exact module; `"fuzzy"`:
   *  the own file matches by mnemonic shape and `by` is a confirmed package
   *  whose evidence sits in the required module. */
  readonly viaDependency?: { readonly by: string; readonly edge: "exact" | "fuzzy" };
  /** Set by `relabelForks` (corpus-fork-relabel, `src/deps/fork-relabel.ts`):
   *  the bundle names `package`, a fork or rename of this package with no
   *  confirmed signature of its own, and nothing names this one, so the
   *  report names the fork. `evidence` quotes the strings that named it. */
  readonly fork?: { readonly package: string; readonly rule: "scoped-copy" | "own-scope" | "affix"; readonly evidence: readonly string[] };
}

export interface ModuleAttribution {
  readonly localModuleId: number | null;
  readonly factoryFunctionIndex: number;
  readonly depCount: number | null;
  readonly nestedFunctionCount: number;
  readonly instrCount: number;
  readonly stringConstants: readonly string[];
  readonly owners: readonly string[];
  readonly ownerBasis: "exact" | "fuzzy+strings" | "fuzzy-only" | null;
  /** True when `ownerBasis === "exact"` AND this module's factory hash is
   *  claimed by more than one distinct non-baseline PACKAGE NAME — a
   *  set-identity check, not a count threshold (G4c, 2026-09-28, superseding
   *  G4b's own `>= AMBIGUOUS_OWNER_THRESHOLD` rule below). Uses the same
   *  `hashOwnerNames` evidence `scorePackage`'s `isUnambiguous` builds (see
   *  the doc comment there), which is already deduplicated by PACKAGE NAME
   *  across every version of that package (`entry.file.package`, no
   *  version suffix) — so several sigdb entries for different versions of
   *  the SAME package (e.g. `react@18.2.0` and `react@18.3.1`) contribute
   *  exactly one name to the set and do NOT make this flag true; only a
   *  claimant whose package NAME differs does. This is deliberately not
   *  `AMBIGUOUS_OWNER_THRESHOLD` (20): that number is calibrated for
   *  `scorePackage`'s AGGREGATE package-level tier scoring, where real
   *  multi-package dependency chains routinely share small boilerplate
   *  functions across up to ~7 sibling packages and a strict `>1` would
   *  drown real evidence in noise (docs/DEPS.md). A single MODULE FACTORY's
   *  own hash is a much bigger, more specific unit of code — matching a
   *  totally different package's factory byte-for-byte is rare and, when it
   *  happens (the original six rn-template modules, `react` vs
   *  `react-native`'s near-identical shared polyfills), is real ambiguity
   *  that must not be resolved by a coin flip. `owners`/`ownerBasis`
   *  themselves are UNCHANGED by this flag (still the blind `owners[0]`
   *  pick downstream, `moduleOwnership`'s membership is untouched) — an
   *  earlier landing (commit e7c83bfa) instead gated `owners` themselves at
   *  this same `>1` rule and measured it destroy half of `moduleOwnership`
   *  on the held-out react-navigation-example app; the bug there was the
   *  GATE'S LOCATION (refusing the attribution itself), not this rule.
   *  `false` when `ownerBasis !== "exact"` or there are no owners at all.
   *  Consumed by `src/export/substitute.ts`'s `own(P)` construction (via
   *  `report.ts`'s `ModuleOwnership.ambiguousOwnerHash`), which is the one
   *  place a wrong per-module pick can actually cause harm (silently
   *  vendoring one package's file as another's `require("P")` boundary):
   *  own(P) excludes a flagged module, it never sinks the rest of P. */
  readonly ambiguousOwnerHash: boolean;
}

/** §6.7 (`docs/PACKAGE-SIGNATURES.md`): a hash claimed by this many or more
 *  distinct non-baseline package names is shared boilerplate, not evidence
 *  for any one of them — used ONLY by `scorePackage`'s `isUnambiguous`
 *  below, for AGGREGATE package-level tier scoring. `ModuleAttribution`/
 *  `ModuleOwnership`'s `ambiguousOwnerHash` field (per-MODULE-FACTORY,
 *  consumed by `src/export/substitute.ts`'s `own(P)`) stopped reusing this
 *  number as of G4c (2026-09-28) — it needs a strict set-identity rule
 *  ("every claimant is the same package"), not this threshold; see that
 *  field's own doc comment (`src/deps/match.ts` above) for why the two
 *  purposes need different numbers. Still exported: `tests/gate/deps/
 *  ambiguous-attribution.test.ts` and `docs/specs/15-sigdb-schema.md`'s §12
 *  probe both read it as a convenient "many distinct packages" fixture
 *  size / scoring-tier constant, unrelated to the own(P) rule. */
export const AMBIGUOUS_OWNER_THRESHOLD = 20;

export interface MatchReport {
  readonly hbcVersion: number;
  readonly totalFunctions: number;
  readonly totalModules: number;
  readonly packagesChecked: number;
  readonly packages: readonly PackageScore[];
  readonly moduleAttributions: readonly ModuleAttribution[];
  readonly unattributedModules: readonly ModuleAttribution[];
}

const BASELINE_NAME = /^(metro-toolchain-empty|react-foundation|react-native-foundation)$/;

// Confidence-tier thresholds (docs/DEPS.md "Confidence tiers" table has the
// prose rationale keyed to these same names; docs/PACKAGE-SIGNATURES.md
// §6.6 is the measured false-positive this tightening fixes).
//
// `js-md5`/`@emotion/react` cleared the old "high" tier
// (`moduleExactHits >= 1 && moduleCoverage >= 0.05`) off a *single*
// coincidentally-matching module each: js-md5 (2 total modules) hit 1/2 =
// 50% coverage, @emotion/react (16-17 total modules) hit 1/16 ≈ 6% — both
// comfortably over the flat 5% floor despite being one lone hash collision.
// The fix has two independent legs, either of which alone would have
// stopped these two real cases, kept together for defense in depth:
//
//  1. The coverage-percentage path now needs *at least two* independent
//     module hits, never one — a single hit is FLIRT's classic
//     single-collision risk (§1.2/§3.4) regardless of what percentage that
//     one hit happens to represent of a small package's module count. It
//     also now requires a minimum fraction of the package's own *functions*
//     (not just modules) to have matched, so two module-level coincidences
//     in an otherwise-unmatched, function-rich package still don't clear it.
//  2. Genuinely tiny packages (few enough total modules that "two hits" may
//     not even be reachable) get a size-appropriate alternate path instead:
//     several sizeable functions exact-matching, not one. A tiny package
//     that matches most/all of its modules can still reach "high" via
//     STRONG_MODULE_HIT_COUNT or HIGH_EXACT_FUNCTION_COVERAGE below; this
//     leg exists only to give real-but-tiny packages a route to "high" that
//     doesn't require reaching that near-total bar.
const STRONG_MODULE_HIT_COUNT = 3;
const MIN_MODULE_HITS_FOR_COVERAGE_PATH = 2;
const MIN_MODULE_COVERAGE = 0.05;
const MIN_EXACT_FUNCTION_COVERAGE_FOR_COVERAGE_PATH = 0.1;
/** Below this many total (non-baseline, hashed) modules, the coverage-percentage
 *  path is disabled outright — matching 1 or 2 out of only 1 or 2 modules is
 *  not statistically distinguishable from a single coincidental hash collision. */
const TINY_PACKAGE_MODULE_TOTAL = 3;
// corpus-residual-fp (docs/DEPS.md "Residual offline false positives on
// J3"): an exact hash the TARGET holds this many times or more is generic
// code — an ES-module boilerplate factory, an empty module, a transpiler
// helper inlined into many dist files — and is evidence for no package, so
// neither a function hit nor a module hit counts it. The DB-side check
// (AMBIGUOUS_OWNER_THRESHOLD) cannot see this: only the candidate packages
// are loaded. Two copies stay evidence (a package installed twice), and so
// does a hash the package itself repeats, up to twice its own count
// (react-native holds many identical small functions of its own).
// Toolchain baselines (react / react-native foundation) are exempt: their
// generic code is what they are for, and the react / react-native verdicts
// rest on it.
// Measured on Expensify (db-v4-paths-partial): FP 30 to 10, TP 89 to 87; 4
// keeps one more TP and six more FPs.
export const TARGET_GENERIC_COPIES = 3;
const HIGH_EXACT_FUNCTION_COVERAGE = 0.9;
/** Tiny-package fallback: several exact-matched functions with real bulk
 *  (instruction-count) mass, never one — "never a single tiny function"
 *  (docs/PACKAGE-SIGNATURES.md §6.6). */
const MIN_TINY_PACKAGE_EXACT_FUNCTION_HITS = 5;
const MIN_TINY_PACKAGE_EXACT_FUNCTION_INSTR = 150;

// --- version-tolerant "fuzzy-only" module attribution (docs/PACKAGE-SIGNATURES.md
// §6.7, added 2026-08-31 for issue #14/F1: exact-hash matching is brittle
// against a *near-but-wrong* library version — a real HBC96 (RN 0.73.x)
// bundle matched react-native@0.72.17 at only 88/422 modules because the
// bulk DB's nearest hbc96 react-native build (0.70.6/0.72.8) isn't the exact
// version shipped. Most of a library's functions don't change source
// between adjacent minor versions, so their bare opcode-sequence (fuzzy
// hash, every operand incl. string/bigint content stripped) is often
// byte-identical even when the exact hash (which is sensitive to any
// literal drift) is not. `fuzzy+strings` above already exploits this but
// additionally requires the *string set* to match too, which real version
// drift routinely breaks (a changed error message, an added log constant,
// even one bumped internal version string invalidates the whole set). This
// tier drops that requirement — bare fuzzy-hash agreement only — which is
// far more collision-prone (stripping literals throws away the strongest
// disambiguating signal), so it carries two independent safeguards neither
// of which alone reintroduces the tiny-package false positives fixed above:
//   1. **Package-level trust gate**: only packages whose overall score
//      already reached "medium" or "high" confidence some other way (a real
//      exact-hash hit, or broad fuzzy coverage) may seed this index at all —
//      an isolated fuzzy collision from a package with zero other evidence
//      never attributes a module by itself.
//   2. **Size floor**: a factory below `MIN_FUZZY_ONLY_FACTORY_INSTR`
//      instructions is never trusted this way — larger than `fuzzy+strings`'
//      own 16-instruction fallback floor, since there is no string-set
//      corroboration to lean on here (FLIRT's minimum-length rationale,
//      docs/PACKAGE-SIGNATURES.md §1.2, applied more strictly for a weaker
//      signal).
// A key claimed by more than one distinct non-baseline package is still
// never trusted, same as `fuzzy+strings`. Reported with its own
// `ownerBasis` ("fuzzy-only") so `src/deps/report.ts` can headline it
// separately from exact/fuzzy+strings "verified" coverage rather than
// silently blending it in.
const MIN_FUZZY_ONLY_FACTORY_INSTR = 24;

// corpus-precision-forks (docs/DEPS.md "Forks, embedded copies and
// repeated hashes"). A "high" score must rest on at least this many
// DISTINCT exact hashes: a package that repeats one boilerplate factory
// dozens of times (core-js, deferred, dfa, asynckit, openai) otherwise
// collects as many module hits from a single shape the app also has.
// corpus-recall-bar (docs/DEPS.md "Bar losses: tiny packages"): a tiny
// package whose own module factory exact-matches (a factory of at least
// minInstr instructions, not an empty re-export) and at least this share
// of whose eligible functions exact-match is high, below the 5-function
// floor. Measured: 20+ true tiny packages on Expensify sit at 0.5-0.86
// with a factory hit; the closest false one with a factory hit is 0.25.
export const TINY_PACKAGE_MIN_EXACT_COVERAGE = 0.5;
export const MIN_DISTINCT_EVIDENCE_HASHES = 3;
// A target module holding more than this many times the package's whole
// function count is a container (another package's pre-built dist file):
// hits inside it are not the package's own module.
export const CONTAINER_SIZE_RATIO = 4;
// Share of a package's evidence that must be explained (by a container,
// by another confirmed package's own files, or by a twin) to demote it.
export const EXPLAINED_EVIDENCE_SHARE = 0.9;
// `embedded`: the explaining package must have at least this many times
// as many distinct hit hashes (it is the larger file the copy sits in).
const EMBEDDED_HOST_SIZE_RATIO = 2;
// corpus-precision-residual (`scattered`): a hit hash is anchored when a
// target module holding it holds at least 2 of the package's distinct hit
// hashes and they are at least this share of that module's functions (or
// the module is all hits, or holds 5 hits of one own file; see
// demoteExplained). A real copy is a module made mostly of the package's
// own functions.
export const ANCHOR_DENSITY = 0.1;
// corpus-precision-bundled-dist (`bundled-dist`): an own file of at least
// this many functions is a pre-built dist bundle. When EXPLAINED_EVIDENCE_SHARE
// of the package's hit hashes come from such files and every target module
// holding each of them is under 1/CONTAINER_SIZE_RATIO of that file, the hits
// are the libraries the bundle inlined (@babel/standalone's yallist,
// semver, buffer), not the file: one source file is one target module.
export const BUNDLED_DIST_MIN_FUNCTIONS = 200;

function tierRank(t: ConfidenceTier): number {
  return { high: 3, medium: 2, low: 1, none: 0 }[t];
}

// LB1: map-key prefix isolating hash-scheme-1 DB files (see matchInventory).
export const LEGACY_PREFIX = "1:";
export function schemeKey(file: SigDbFile, hash: string): string {
  return (file.hashScheme ?? 1) >= 2 ? hash : LEGACY_PREFIX + hash;
}

function buildIndex<K extends "exactHash" | "fuzzyHash" | "stringSetHash">(functions: ModuleInventory["functions"], key: K): Set<string> {
  const s = new Set<string>();
  for (const fn of functions) s.add(fn[key]);
  return s;
}

function scorePackage(entry: LoadedSig, target: ModuleInventory, targetExact: Set<string>, targetFuzzy: Set<string>, targetStringHash: Set<string>, minInstr: number, hashOwnerNames: ReadonlyMap<string, ReadonlySet<string>>, targetCopies: ReadonlyMap<string, number>): { readonly score: PackageScore; readonly hitKeys: ReadonlySet<string>; readonly distinctEligible: number } | null {
  const pkg: SigDbFile = entry.file;
  if (pkg.hbcVersion !== target.hbcVersion) return null;
  // corpus-embedded-copy (module paths v1, docs/PACKAGE-SIGNATURES.md §7):
  // a path-bearing file is scored on its OWN files only — a module whose
  // path is another package's file (nested copy, hoisted undeclared
  // dependency, @babel/runtime helper) is neither a hit nor in the
  // denominators. Empty for files without paths (scored as before).
  const foreign = foreignSets(pkg);
  if (pkg.slim !== undefined && pkg.slim.minInstr !== minInstr) throw new Error(`slim signature prefiltered for minInstr ${pkg.slim.minInstr}, matched with ${minInstr}`);
  const eligible = pkg.functions.filter((f) => f.instrCount >= minInstr && !foreign.functions.has(f.index));
  const eligibleCount = pkg.slim !== undefined ? pkg.slim.eligible : eligible.length;
  if (eligibleCount === 0) return null;

  // Calibrated, not guessed: an early cutoff of 3 was tried and measured
  // wrong. `react-navigation-example`'s own real dependency cluster
  // (`@react-navigation/stack` genuinely depends on, and Metro genuinely
  // co-bundles, `react-native-gesture-handler` + `react-native-reanimated` +
  // `react-native-safe-area-context` + `@react-navigation/native` — a real
  // 3-5-package chain, no tree-shaking) legitimately shares hashes across up
  // to **7** distinct package names in the curated starter DB alone
  // (measured directly: `react-native-reanimated`'s own 3,454 functions'
  // ambiguity-size histogram tops out at 7, with the bulk of its real
  // signature at exactly 3) — a cutoff of 3 destroyed that package's entire
  // signal (moduleExactHits 292->0, exactHits 1722->6, tier high->low) for
  // a real dependency this fixture's own ground truth confirms is present.
  // The bulk-DB false-positive family this check exists to catch (`hasown`/
  // `is-weakref`/`is-finalizationregistry`/... — dozens of `ljharb` ES-shim
  // siblings sharing generated boilerplate, plus the even more pervasive
  // case of Babel's own runtime helpers, which by design are byte-identical
  // across a huge fraction of all Babel/TS-compiled npm packages) measures
  // 55-79+ distinct package names per hash — nowhere near a real dependency
  // chain's size. The threshold sits well clear of both measured
  // populations: comfortably above the largest legitimate multi-package
  // chain found (7) and far below the smallest measured boilerplate-family
  // collision (55). Module-level scope (`export const` above this function)
  // so `moduleAttributions`'s `ambiguousOwnerHash` flag and
  // `src/export/substitute.ts`'s `own(P)` gate reuse the identical number.
  // TARGET_GENERIC_COPIES: generic when the target holds the hash at least
  // that often AND more than twice as often as this package itself does.
  const ownCopies = new Map<string, number>();
  for (const f of pkg.functions) if (!foreign.functions.has(f.index)) ownCopies.set(schemeKey(pkg, f.exactHash), (ownCopies.get(schemeKey(pkg, f.exactHash)) ?? 0) + 1);
  const isGenericInTarget = (hash: string): boolean => {
    const n = targetCopies.get(hash) ?? 0;
    return !pkg.toolchainBaseline && n >= TARGET_GENERIC_COPIES && n > 2 * (ownCopies.get(hash) ?? 0);
  };
  const isUnambiguous = (hash: string): boolean => (hashOwnerNames.get(hash)?.size ?? 1) < AMBIGUOUS_OWNER_THRESHOLD && !isGenericInTarget(hash);

  let exactHits = 0;
  let exactHitInstrSum = 0;
  let fuzzyOnlyHits = 0;
  let stringCorroborated = 0;
  const hitKeys = new Set<string>();
  for (const fn of eligible) {
    const exactKey = schemeKey(pkg, fn.exactHash);
    if (targetExact.has(exactKey)) {
      if (!isUnambiguous(exactKey)) continue; // shared with >=1 other distinct package — not this package's own evidence
      hitKeys.add(exactKey);
      exactHits++;
      exactHitInstrSum += fn.instrCount;
      continue;
    }
    if (targetFuzzy.has(schemeKey(pkg, fn.fuzzyHash))) {
      fuzzyOnlyHits++;
      if (targetStringHash.has(fn.stringSetHash)) stringCorroborated++;
    }
  }

  let moduleExactHits = 0;
  let substantiveModuleHits = 0;
  const factoryInstr = new Map(pkg.functions.map((f) => [f.index, f.instrCount]));
  for (const m of pkg.modules) {
    // corpus-offline-precision: a J4 dependency-flagged module is the
    // dependency's code (dep-subtract.mjs keeps the module only for graph
    // anchoring), never this package's own module hit. It stays in
    // `moduleTotal` below: dropping it there too would turn some packages
    // into "tiny" ones and unlock the tiny-package path (measured: adds
    // react-shallow-renderer as a false positive on react-navigation-example).
    if (m.factoryIsBaseline || m.factoryIsDependency === true || foreign.factories.has(m.factoryFunctionIndex)) continue;
    if (m.factoryExactHash !== null && targetExact.has(schemeKey(pkg, m.factoryExactHash)) && isUnambiguous(schemeKey(pkg, m.factoryExactHash))) {
      moduleExactHits++;
      // An empty or re-export factory (under minInstr) is a module hit but
      // not distinct evidence for the precision rules below.
      if ((factoryInstr.get(m.factoryFunctionIndex) ?? 0) >= minInstr) {
        hitKeys.add(schemeKey(pkg, m.factoryExactHash));
        substantiveModuleHits++;
      }
    }
  }
  const moduleTotal = pkg.slim !== undefined ? pkg.slim.moduleTotal : pkg.modules.filter((m) => !m.factoryIsBaseline && m.factoryExactHash !== null && !foreign.factories.has(m.factoryFunctionIndex)).length;

  const exactCoverage = exactHits / eligibleCount;
  const fuzzyCoverage = (exactHits + fuzzyOnlyHits) / eligibleCount;

  // A single coincidentally-matching module is not "high" confidence for the
  // whole package — the FLIRT-style single-hash-collision risk
  // (docs/PACKAGE-SIGNATURES.md §1.2/§3.4/§5.4/§6.6). Require either several
  // independent module hits, or (for packages too small to ever reach that)
  // several sizeable exact-matched functions — never one coincidental hit of
  // either kind, regardless of what percentage it happens to represent of a
  // small package's own module count.
  const moduleCoverage = moduleTotal === 0 ? 0 : moduleExactHits / moduleTotal;
  const isTinyPackage = moduleTotal < TINY_PACKAGE_MODULE_TOTAL;
  const strongModuleSignal =
    moduleExactHits >= STRONG_MODULE_HIT_COUNT ||
    (!isTinyPackage &&
      moduleExactHits >= MIN_MODULE_HITS_FOR_COVERAGE_PATH &&
      moduleCoverage >= MIN_MODULE_COVERAGE &&
      exactCoverage >= MIN_EXACT_FUNCTION_COVERAGE_FOR_COVERAGE_PATH);
  const strongFunctionSignal =
    exactCoverage >= HIGH_EXACT_FUNCTION_COVERAGE ||
    (isTinyPackage && exactHits >= MIN_TINY_PACKAGE_EXACT_FUNCTION_HITS && exactHitInstrSum >= MIN_TINY_PACKAGE_EXACT_FUNCTION_INSTR);
  const distinctEligible = pkg.slim?.distinctEligible ?? new Set(eligible.map((f) => f.exactHash)).size;
  const enoughDistinct = hitKeys.size >= Math.min(MIN_DISTINCT_EVIDENCE_HASHES, distinctEligible);
  // corpus-recall-bar: only with enough distinct hashes; otherwise it would
  // turn a plain medium into a few-distinct demotion, which the path-recall
  // edge rule then skips (call-bound, es-shim-unscopables).
  const tinyCoverageSignal = isTinyPackage && substantiveModuleHits >= 1 && exactCoverage >= TINY_PACKAGE_MIN_EXACT_COVERAGE && enoughDistinct;

  let tier: ConfidenceTier;
  if (strongModuleSignal || strongFunctionSignal || tinyCoverageSignal) tier = "high";
  else if (fuzzyCoverage >= 0.5 || moduleExactHits >= 1) tier = "medium";
  else if (exactHits + fuzzyOnlyHits > 0) tier = "low";
  else tier = "none";
  let demotion: PackageScore["demotion"];
  // A package whose whole eligible code has fewer distinct hashes needs
  // them all (a one-function package fully matched stays high).
  if (tier === "high" && !pkg.toolchainBaseline && !enoughDistinct) {
    tier = "medium";
    demotion = { rule: "few-distinct" };
  }

  const score: PackageScore = {
    package: pkg.package,
    version: pkg.version,
    hbcVersion: pkg.hbcVersion,
    layer: entry.layer,
    isBaseline: pkg.toolchainBaseline,
    eligibleFunctions: eligibleCount,
    exactHits,
    fuzzyOnlyHits,
    stringCorroborated,
    exactCoverage,
    fuzzyCoverage,
    moduleExactHits,
    moduleTotal,
    tier,
    ...(demotion === undefined ? {} : { demotion }),
  };
  return { score, hitKeys, distinctEligible };
}

interface ScoredEntry {
  readonly entry: LoadedSig;
  score: PackageScore;
  readonly hitKeys: ReadonlySet<string>;
  readonly distinctEligible: number;
}

// corpus-precision-forks: demote a "high" package whose evidence another
// explanation covers (docs/DEPS.md "Forks, embedded copies and repeated
// hashes"). Rules, in order, each over the packages still "high":
//  - container: EXPLAINED_EVIDENCE_SHARE of the target functions carrying
//    its hit hashes sit in target modules with more than
//    CONTAINER_SIZE_RATIO x the package's whole function count — a copy
//    inlined in another package's pre-built dist file (process and
//    stackframe in react-devtools-core's backend.js);
//  - scattered (corpus-precision-residual): fewer than
//    MIN_DISTINCT_EVIDENCE_HASHES of its distinct hit hashes are anchored —
//    held by a target module that holds at least 2 of them, at least
//    ANCHOR_DENSITY of that module's functions, or all of its functions
//    (one-function modules: gopd inside define-properties), or at least
//    MIN_TINY_PACKAGE_EXACT_FUNCTION_HITS from one of the package's own
//    files (tslib: 7 of tslib.js in its 87-function module). Small helpers each alone
//    in an unrelated app module (ai, ky), tiny factory shapes matching app
//    modules of 1-3 functions (culori, swiper), or a few dozen among the
//    500 functions of another package's single file (lodash-es inside
//    lodash/lodash.js) are not a copy: a real copy is a module made mostly
//    of the package's functions. A package whose every distinct eligible
//    hash is hit (one-function packages: cross-fetch) is exempt;
//  - embedded: that share of its distinct hit hashes are also hits of
//    another high package's OWN files (path-bearing signature, so those
//    files really are that package's), which has EMBEDDED_HOST_SIZE_RATIO
//    x more — oboe in react-native-blob-util, jszip in localforage. A
//    pathless host is not trusted: its signature may still hold its
//    dependencies' code (d3-zoom holds d3-ease);
//  - twin: two packages whose hit sets each cover that share of the
//    other's (punycode / punycode.js: one source, two names), at least
//    one of them path-bearing. Two pathless files with the same hits may
//    be a package and its dependent whose signature still holds its code
//    (event-target-shim / abort-controller), so both stay. One is kept:
//    the path-bearing one (its hits are its own files), else a declared
//    dependency of another high package, else the one with more distinct
//    hits, else the first by name.
//    One-sided too: a package whose hits that share covers, inside a
//    path-bearing package with more hits that outranks it (fork
//    source-map-js: 40 hits, all among source-map's 46, too few of them
//    for mutual cover and under the embedded ratio).
function demoteExplained(scored: readonly ScoredEntry[], inventory: ModuleInventory, legacyExact: readonly string[]): readonly ScoredEntry[] {
  const high = (): ScoredEntry[] => scored.filter((s) => s.score.tier === "high" && !s.score.isBaseline && s.hitKeys.size > 0);
  const demote = (s: ScoredEntry, rule: NonNullable<PackageScore["demotion"]>["rule"], by?: string): void => {
    s.score = { ...s.score, tier: "medium", demotion: by === undefined ? { rule } : { rule, by } };
  };
  if (high().length === 0) return scored;
  const moduleSize = new Map<number, number>();
  for (const m of inventory.modules) for (const i of m.functionIndices ?? []) moduleSize.set(i, m.functionIndices.length); // hand-built inventories may omit it
  const occurrences = new Map<string, number[]>();
  const addOcc = (k: string, i: number): void => {
    const a = occurrences.get(k);
    if (a === undefined) occurrences.set(k, [i]);
    else a.push(i);
  };
  inventory.functions.forEach((f, i) => addOcc(f.exactHash, i));
  legacyExact.forEach((h, i) => addOcc(LEGACY_PREFIX + h, i));

  for (const s of high()) {
    // Path-bearing: the builder bundle's toolchain/runtime modules are
    // separate unowned files, so rawFunctionCount overstates the package
    // (async-lock 21 vs 98, corpus-precision-rainbow-mm). Pathless: keep the
    // larger, conservative size.
    const raw = (s.entry.file.modulePaths ?? 0) >= 1 ? 0 : (s.entry.file.rawFunctionCount ?? 0);
    const whole = Math.max(s.entry.file.totalFunctions ?? 0, raw, s.score.eligibleFunctions);
    let all = 0;
    let inside = 0;
    for (const k of s.hitKeys) {
      for (const i of occurrences.get(k) ?? []) {
        all++;
        if ((moduleSize.get(i) ?? 0) > CONTAINER_SIZE_RATIO * whole) inside++;
      }
    }
    if (all > 0 && inside >= EXPLAINED_EVIDENCE_SHARE * all) demote(s, "container");
  }
  const moduleOf = new Map<number, number>();
  inventory.modules.forEach((m, mi) => {
    for (const i of m.functionIndices ?? []) moduleOf.set(i, mi);
  });
  for (const s of high()) {
    if (s.hitKeys.size >= s.distinctEligible) continue;
    const keysIn = new Map<number, Set<string>>();
    for (const k of s.hitKeys) {
      for (const i of occurrences.get(k) ?? []) {
        const m = moduleOf.get(i);
        if (m === undefined) continue;
        let set = keysIn.get(m);
        if (set === undefined) keysIn.set(m, (set = new Set()));
        set.add(k);
      }
    }
    if (keysIn.size === 0) continue; // hand-built inventory without modules: nothing to judge
    // The package's own file(s) each hit hash comes from (pathless files
    // carry no module ids: one file).
    const filesOf = new Map<string, Set<number>>();
    for (const fn of s.entry.file.functions) {
      const k = schemeKey(s.entry.file, fn.exactHash);
      if (!s.hitKeys.has(k)) continue;
      let set = filesOf.get(k);
      if (set === undefined) filesOf.set(k, (set = new Set()));
      set.add(fn.moduleId ?? -1);
    }
    const anchored = new Set<string>();
    for (const [m, set] of keysIn) {
      const size = inventory.modules[m]!.functionIndices.length || 1;
      let anchors = (set.size >= 2 && set.size >= ANCHOR_DENSITY * size) || set.size >= size;
      if (!anchors && set.size >= MIN_TINY_PACKAGE_EXACT_FUNCTION_HITS) {
        const perFile = new Map<number, number>();
        for (const k of set) for (const f of filesOf.get(k) ?? []) perFile.set(f, (perFile.get(f) ?? 0) + 1);
        anchors = Math.max(0, ...perFile.values()) >= MIN_TINY_PACKAGE_EXACT_FUNCTION_HITS;
      }
      if (anchors) for (const k of set) anchored.add(k);
    }
    if (anchored.size < MIN_DISTINCT_EVIDENCE_HASHES) demote(s, "scattered");
  }
  const shared = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
    let n = 0;
    for (const k of a) if (b.has(k)) n++;
    return n;
  };
  const hosts = high();
  for (const s of hosts) {
    const host = hosts.find((q) => q !== s && q.score.tier === "high" && q.score.package !== s.score.package && (q.entry.file.modulePaths ?? 0) >= 1 && q.hitKeys.size >= EMBEDDED_HOST_SIZE_RATIO * s.hitKeys.size && shared(s.hitKeys, q.hitKeys) >= EXPLAINED_EVIDENCE_SHARE * s.hitKeys.size);
    if (host !== undefined) demote(s, "embedded", host.score.package);
  }
  const twins = high();
  const dependedOn = new Set<string>();
  const depName = (d: string): string => d.slice(0, d.lastIndexOf("@") > 0 ? d.lastIndexOf("@") : d.length);
  for (const s of twins) for (const d of s.entry.file.subtractedDependencies ?? []) dependedOn.add(depName(d));
  const pathBearing = (s: ScoredEntry): boolean => (s.entry.file.modulePaths ?? 0) >= 1;
  const rank = (s: ScoredEntry): readonly number[] => [pathBearing(s) ? 1 : 0, dependedOn.has(s.score.package) ? 1 : 0, s.hitKeys.size];
  const better = (a: ScoredEntry, b: ScoredEntry): boolean => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! > rb[i]!;
    return a.score.package < b.score.package;
  };
  for (const s of twins) {
    if (s.score.tier !== "high") continue;
    for (const q of twins) {
      if (q === s || q.score.tier !== "high" || q.score.package === s.score.package || (!pathBearing(s) && !pathBearing(q))) continue;
      const n = shared(s.hitKeys, q.hitKeys);
      const sCovered = n >= EXPLAINED_EVIDENCE_SHARE * s.hitKeys.size;
      const qCovered = n >= EXPLAINED_EVIDENCE_SHARE * q.hitKeys.size;
      // One-sided (corpus-twin-sourcemap): a fork whose hits all sit inside
      // a path-bearing original's larger set (source-map-js in source-map).
      const sInQ = sCovered && !qCovered && q.hitKeys.size > s.hitKeys.size && pathBearing(q) && better(q, s);
      const qInS = qCovered && !sCovered && s.hitKeys.size > q.hitKeys.size && pathBearing(s) && better(s, q);
      if (!(sCovered && qCovered) && !sInQ && !qInS) continue;
      if (sCovered && qCovered ? better(s, q) : qInS) demote(q, "twin", s.score.package);
      else {
        demote(s, "twin", q.score.package);
        break;
      }
    }
  }
  // inlined (corpus-mm-precision-inlined): a declared dependency P of a
  // path-bearing package Q whose hits all sit in target modules holding one
  // of Q's own files, next to Q code P's signature does not hold. One target
  // module is one source file, so it is Q's file and P is inlined in it (a
  // dist build), not installed: installed, P has modules of its own.
  const inlinedHosts = high().filter((q) => pathBearing(q) && (q.entry.file.subtractedDependencies ?? []).length > 0);
  if (inlinedHosts.length > 0) {
    const ownKeysByModule = new Map<ScoredEntry, Map<number, Set<string>[]>>(); // target module -> per own file, Q's hit keys in it
    for (const q of inlinedHosts) {
      const f = q.entry.file;
      const own = new Set(f.modules.filter((m) => typeof m.path === "string" && isOwnModulePath(f.package, m.path)).map((m) => m.localModuleId));
      const perFile = new Map<number, Set<string>>();
      for (const fn of f.functions) {
        const k = schemeKey(f, fn.exactHash);
        if (fn.moduleId === undefined || !own.has(fn.moduleId) || !q.hitKeys.has(k)) continue;
        let set = perFile.get(fn.moduleId);
        if (set === undefined) perFile.set(fn.moduleId, (set = new Set()));
        set.add(k);
      }
      const byModule = new Map<number, Set<string>[]>();
      for (const keys of perFile.values()) {
        const inM = new Map<number, Set<string>>();
        for (const k of keys) {
          for (const i of occurrences.get(k) ?? []) {
            const m = moduleOf.get(i);
            if (m === undefined) continue;
            let set = inM.get(m);
            if (set === undefined) inM.set(m, (set = new Set()));
            set.add(k);
          }
        }
        for (const [m, set] of inM) {
          const list = byModule.get(m);
          if (list === undefined) byModule.set(m, [set]);
          else list.push(set);
        }
      }
      ownKeysByModule.set(q, byModule);
    }
    for (const s of high()) {
      const hosts = inlinedHosts.filter((q) => q.score.package !== s.score.package && q.score.tier === "high" && (q.entry.file.subtractedDependencies ?? []).some((d) => depName(d) === s.score.package));
      if (hosts.length === 0) continue;
      const sigKeys = new Set(s.entry.file.functions.map((fn) => schemeKey(s.entry.file, fn.exactHash)));
      let all = 0;
      let inside = 0;
      let by: string | undefined;
      for (const k of s.hitKeys) {
        for (const i of occurrences.get(k) ?? []) {
          all++;
          const m = moduleOf.get(i);
          if (m === undefined) continue;
          const q = hosts.find((h) => (ownKeysByModule.get(h)!.get(m) ?? []).some((set) => {
            let foreign = 0;
            for (const x of set) if (!sigKeys.has(x)) foreign++;
            return foreign >= MIN_DISTINCT_EVIDENCE_HASHES;
          }));
          if (q !== undefined) {
            inside++;
            by ??= q.score.package;
          }
        }
      }
      if (all > 0 && by !== undefined && inside >= EXPLAINED_EVIDENCE_SHARE * all) demote(s, "inlined", by);
    }
  }
  // bundled-dist (corpus-precision-bundled-dist): last, so it changes no
  // earlier rule's input. Path-bearing signatures only: a pathless file
  // lumps every module together, so its "file size" is the package's.
  for (const s of high()) {
    if ((s.entry.file.modulePaths ?? 0) < 1) continue;
    // A slimmed file has dropped most functions: its own file sizes come
    // precomputed (slim-sigs.ts).
    const ownSize = new Map<number, number>();
    const pre = s.entry.file.slim?.fileSizes;
    if (pre !== undefined) for (const [id, n] of Object.entries(pre)) ownSize.set(Number(id), n);
    else for (const fn of s.entry.file.functions) if (fn.moduleId !== undefined) ownSize.set(fn.moduleId, (ownSize.get(fn.moduleId) ?? 0) + 1);
    const fileOf = new Map<string, number>(); // smallest own file holding the hash
    for (const fn of s.entry.file.functions) {
      const k = schemeKey(s.entry.file, fn.exactHash);
      if (!s.hitKeys.has(k) || fn.moduleId === undefined) continue;
      const n = ownSize.get(fn.moduleId)!;
      fileOf.set(k, Math.min(fileOf.get(k) ?? Infinity, n));
    }
    let oversized = 0;
    for (const k of s.hitKeys) {
      const own = fileOf.get(k);
      if (own === undefined || own < BUNDLED_DIST_MIN_FUNCTIONS) continue;
      const largest = Math.max(0, ...(occurrences.get(k) ?? []).map((i) => moduleSize.get(i) ?? Infinity));
      if (largest > 0 && CONTAINER_SIZE_RATIO * largest < own) oversized++;
    }
    if (oversized >= EXPLAINED_EVIDENCE_SHARE * s.hitKeys.size) demote(s, "bundled-dist");
  }
  return scored;
}

/** Package directory of a node_modules-relative path (`@s/p/x.js` -> `@s/p`,
 *  `p/node_modules/q/i.js` -> `q`). */
function packageOfPath(path: string): string {
  const tail = path.slice(path.lastIndexOf("node_modules/") >= 0 ? path.lastIndexOf("node_modules/") + "node_modules/".length : 0);
  const parts = tail.split("/");
  return parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

// corpus-path-recall (docs/PACKAGE-SIGNATURES.md §7 "Recovery through the
// module graph"): a path-bearing package is scored on its own files only, so
// a true package whose own file is small (hoist-non-react-statics: three
// functions) or built differently from the signature (abort-controller: the
// app resolves dist/*.mjs, the signature dist/*.js) is lost even though the
// code it requires is in the app. Its signature's module graph says which
// dependency module each own file requires; the app's module graph says the
// same of each app module. A package that is not "high" and was not demoted
// becomes "high" when, for one own file S (path under the package, with a
// dependency edge to another package D's module S_D), an app module T
//  - exact: has S's exact factory hash, every distinct eligible own hash of
//    the package is a hit (hitKeys covers distinctEligible, at least
//    MIN_DISTINCT_EVIDENCE_HASHES - 1 of them), and T requires an app module
//    whose factory exact hash is S_D's; or
//  - fuzzy: D is a "high" package (before this rule: no chaining), T's
//    eligible functions match at least MIN_DISTINCT_EVIDENCE_HASHES distinct
//    fuzzy hashes of S's own eligible functions, which are half of S's and
//    half of T's, and T requires an app module holding at least
//    MIN_DISTINCT_EVIDENCE_HASHES of D's hit hashes (where D's confirmed code
//    is).
// An impostor matched only through its copy of D (safe-buffer through
// buffer) has no app module shaped like its own file, so it never qualifies:
// the edge only credits a module the app holds, never the copy.
function promoteViaDependency(scored: readonly ScoredEntry[], inventory: ModuleInventory, minInstr: number, targetCopies: ReadonlyMap<string, number>): void {
  const highByName = new Map<string, ScoredEntry[]>();
  for (const s of scored) {
    if (s.score.tier !== "high" || s.score.isBaseline) continue;
    const list = highByName.get(s.score.package) ?? [];
    list.push(s);
    highByName.set(s.score.package, list);
  }
  const tById = new Map<number, ModuleInventory["modules"][number]>();
  const tByFactory = new Map<string, ModuleInventory["modules"][number][]>();
  for (const m of inventory.modules) {
    if (m.localModuleId !== null) tById.set(m.localModuleId, m);
    if (m.exactHash === null) continue;
    const list = tByFactory.get(m.exactHash) ?? [];
    list.push(m);
    tByFactory.set(m.exactHash, list);
  }
  const fuzzyIndex = new Map<string, Set<ModuleInventory["modules"][number]>>();
  const eligibleFuzzy = (m: ModuleInventory["modules"][number]): Set<string> => {
    const out = new Set<string>();
    for (const i of m.functionIndices ?? []) {
      const f = inventory.functions[i];
      if (f !== undefined && f.instrCount >= minInstr) out.add(f.fuzzyHash);
    }
    return out;
  };
  const tFuzzy = new Map<ModuleInventory["modules"][number], Set<string>>();
  for (const m of inventory.modules) {
    const set = eligibleFuzzy(m);
    tFuzzy.set(m, set);
    for (const h of set) {
      let s = fuzzyIndex.get(h);
      if (s === undefined) fuzzyIndex.set(h, (s = new Set()));
      s.add(m);
    }
  }
  const depsOf = (m: ModuleInventory["modules"][number]): ModuleInventory["modules"][number][] =>
    (m.depIds ?? []).map((d) => tById.get(d)).filter((x): x is ModuleInventory["modules"][number] => x !== undefined);
  const holdsHits = (m: ModuleInventory["modules"][number], hits: readonly ScoredEntry[]): boolean =>
    hits.some((d) => {
      let n = 0;
      const seen = new Set<string>();
      for (const i of m.functionIndices ?? []) {
        const h = inventory.functions[i]?.exactHash;
        if (h !== undefined && d.hitKeys.has(h) && !seen.has(h)) {
          seen.add(h);
          n++;
        }
      }
      return n >= MIN_DISTINCT_EVIDENCE_HASHES;
    });
  for (const s of scored) {
    const file = s.entry.file;
    if (s.score.tier === "high" || s.score.demotion !== undefined || s.score.isBaseline || (file.modulePaths ?? 0) < 1 || (file.hashScheme ?? 1) < 2) continue;
    // Counts over the full file (a slimmed file carries them precomputed:
    // slimming drops the functions that are not in the app).
    const graph = viaDependencyCounts(file, minInstr);
    const ownPathDistinct = file.slim?.ownPathDistinct ?? graph.ownPathDistinct;
    const ownFuzzyCount = (id: number): number => file.slim?.ownFuzzy?.[id] ?? graph.ownFuzzy[id] ?? 0;
    // exact form: every distinct eligible hash of the own path-bearing
    // functions is a hit (the pathless prelude and entry stub say nothing).
    const ownPathIds = new Set(file.modules.filter((m) => typeof m.path === "string" && isOwnModulePath(file.package, m.path)).map((m) => m.localModuleId));
    const ownHit = new Set(file.functions.filter((f) => f.instrCount >= minInstr && f.moduleId !== undefined && ownPathIds.has(f.moduleId) && s.hitKeys.has(schemeKey(file, f.exactHash))).map((f) => f.exactHash));
    const complete = ownPathDistinct >= MIN_DISTINCT_EVIDENCE_HASHES - 1 && ownHit.size >= ownPathDistinct;
    let found: PackageScore["viaDependency"];
    for (const own of graph.wrappers) {
      if (found !== undefined) break;
      const depMods = graph.depsOf(own);
      if (complete && own.factoryExactHash !== null) {
        for (const t of tByFactory.get(own.factoryExactHash) ?? []) {
          const tDeps = depsOf(t);
          const d = depMods.find((sd) => sd.factoryExactHash !== null && (targetCopies.get(sd.factoryExactHash) ?? 0) < TARGET_GENERIC_COPIES && tDeps.some((td) => td.exactHash === sd.factoryExactHash));
          if (d !== undefined) {
            found = { by: packageOfPath(d.path!), edge: "exact" };
            break;
          }
        }
        if (found !== undefined) break;
      }
      // fuzzy form: an app module shaped like this own file requires a
      // confirmed dependency's code.
      const total = ownFuzzyCount(own.localModuleId!);
      if (total < MIN_DISTINCT_EVIDENCE_HASHES) continue;
      const confirmedDeps = depMods.map((d) => packageOfPath(d.path!)).filter((p) => p !== file.package && highByName.has(p));
      if (confirmedDeps.length === 0) continue;
      const ownFuzzy = new Set<string>();
      for (const f of file.functions) if (f.moduleId === own.localModuleId && f.instrCount >= minInstr) ownFuzzy.add(f.fuzzyHash);
      const counts = new Map<ModuleInventory["modules"][number], number>();
      for (const h of ownFuzzy) for (const t of fuzzyIndex.get(h) ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const [t, n] of counts) {
        if (n < MIN_DISTINCT_EVIDENCE_HASHES || n < 0.5 * total || n < 0.5 * (tFuzzy.get(t)?.size ?? 0)) continue;
        const tDeps = depsOf(t);
        const by = confirmedDeps.find((p) => tDeps.some((td) => holdsHits(td, highByName.get(p)!)));
        if (by !== undefined) {
          found = { by, edge: "fuzzy" };
          break;
        }
      }
    }
    if (found !== undefined) s.score = { ...s.score, tier: "high", viaDependency: found };
  }
}

export interface MatchOptions {
  /** FLIRT-style minimum-instruction floor before a hash is trusted at all. */
  readonly minInstr?: number;
}

export function matchInventory(inventory: ModuleInventory, dbs: readonly LoadedSig[], opts: MatchOptions = {}): MatchReport {
  const minInstr = opts.minInstr ?? 8;
  const targetExact = buildIndex(inventory.functions, "exactHash");
  const targetFuzzy = buildIndex(inventory.functions, "fuzzyHash");
  // LB1 hash-scheme isolation: a scheme-1 (pre-width-folding) DB file is
  // scored ONLY against the target's scheme-1 hashes, under a "1:" key
  // prefix (`schemeKey`) so no map below can ever pair a scheme-1 DB hash
  // with a scheme-2 target hash. (A union was tried and measured wrong:
  // scheme-1 files were baseline-subtracted with scheme-1 hashes, so they
  // still hold width-shifted copies of RN code that folded target hashes
  // then matched -- stack / gesture-handler / reanimated "confirmed" on
  // rn-template.)
  const legacyExact = inventory.legacyExactHashes ?? inventory.functions.map((f) => f.exactHash);
  const legacyFuzzy = inventory.legacyFuzzyHashes ?? inventory.functions.map((f) => f.fuzzyHash);
  for (const h of legacyExact) targetExact.add(LEGACY_PREFIX + h);
  for (const h of legacyFuzzy) targetFuzzy.add(LEGACY_PREFIX + h);
  const targetStringHash = buildIndex(inventory.functions, "stringSetHash");
  // How many target functions carry each exact hash (TARGET_GENERIC_COPIES).
  const targetCopies = new Map<string, number>();
  for (const h of inventory.functions.map((f) => f.exactHash)) targetCopies.set(h, (targetCopies.get(h) ?? 0) + 1);
  for (const h of legacyExact) targetCopies.set(LEGACY_PREFIX + h, (targetCopies.get(LEGACY_PREFIX + h) ?? 0) + 1);

  const eligibleDbs = dbs.filter((d) => d.file.hbcVersion === inventory.hbcVersion);

  // Reverse index for per-module attribution: which package(s)' own function
  // set contains a given exact hash. A module can still be named even if its
  // package's overall coverage is low.
  const hashOwners = new Map<string, string[]>();
  // Package-NAME-only view of the same evidence (2026-08-31, §6.7 above):
  // which distinct non-baseline packages claim a given exact hash, ignoring
  // version — the ambiguity signal `scorePackage` needs. Built in the same
  // pass as `hashOwners` so it's complete (every eligible DB visited) before
  // any package is scored in pass 2 below; baseline files are excluded since
  // they legitimately overlap with everything by design (that's the whole
  // point of a baseline) and are handled through `BASELINE_ALIAS`, not this.
  const hashOwnerNames = new Map<string, Set<string>>();
  // Fallback index for module factories whose exact hash differs only by
  // register allocation (release vs `-g` builds of the same source): the
  // factory's mnemonic-only fuzzy hash *and* its full string set must both
  // match, and the factory must be big enough (instruction and string
  // count) that the pair is not a trivial-module collision — a bare
  // `module.exports = require(dep#)` re-export has no strings and the same
  // mnemonics in every package. Keys claimed by more than one distinct
  // non-baseline package are ambiguous and never attribute.
  const fallbackEligible = (instrCount: number, stringCount: number): boolean => instrCount >= minInstr && (stringCount >= 1 || instrCount >= 16);
  const fuzzyStringOwners = new Map<string, string[]>();
  // Per-entry function-by-index, built once here and reused in pass 3 below
  // (fuzzy-only owners) rather than rebuilt — this loop already visits every
  // entry's full function list once, and a real bulk DB has tens of
  // thousands of entries.
  const fnByIndexByEntry = new Map<LoadedSig, Map<number, SigDbFile["functions"][number]>>();
  for (const entry of eligibleDbs) {
    const owner = `${entry.file.package}@${entry.file.version}`;
    const fnByIndex = new Map(entry.file.functions.map((f) => [f.index, f]));
    fnByIndexByEntry.set(entry, fnByIndex);
    // Module paths v1: a path-bearing file never claims another package's
    // file, so a hash both own and copied is attributed to its owner.
    const foreign = foreignSets(entry.file);
    for (const fn of entry.file.functions) {
      if (foreign.functions.has(fn.index)) continue;
      const exactKey = schemeKey(entry.file, fn.exactHash);
      let owners = hashOwners.get(exactKey);
      if (owners === undefined) {
        owners = [];
        hashOwners.set(exactKey, owners);
      }
      owners.push(owner);
      if (!entry.file.toolchainBaseline) {
        let names = hashOwnerNames.get(exactKey);
        if (names === undefined) {
          names = new Set();
          hashOwnerNames.set(exactKey, names);
        }
        names.add(entry.file.package);
      }
    }
    for (const m of entry.file.modules) {
      if (m.factoryIsBaseline || m.factoryIsDependency === true || m.factoryFuzzyHash === null || foreignSets(entry.file).factories.has(m.factoryFunctionIndex)) continue;
      const factory = fnByIndex.get(m.factoryFunctionIndex);
      if (factory === undefined || !fallbackEligible(factory.instrCount, factory.stringCount)) continue;
      const key = `${schemeKey(entry.file, m.factoryFuzzyHash)}|${factory.stringSetHash}`;
      let owners = fuzzyStringOwners.get(key);
      if (owners === undefined) {
        owners = [];
        fuzzyStringOwners.set(key, owners);
      }
      if (!owners.includes(owner)) owners.push(owner);
    }
  }

  // Pass 2: score every package now that `hashOwnerNames` is complete —
  // ambiguity-aware, so a package's own tier never rests on evidence another
  // distinct package equally claims (§6.7 above).
  const packages: PackageScore[] = [];
  const scoreByOwner = new Map<string, PackageScore>();
  const scoredEntries: ScoredEntry[] = [];
  for (const entry of eligibleDbs) {
    const scored = scorePackage(entry, inventory, targetExact, targetFuzzy, targetStringHash, minInstr, hashOwnerNames, targetCopies);
    if (scored === null) continue;
    scoredEntries.push({ entry, ...scored });
  }
  const afterDemotion = demoteExplained(scoredEntries, inventory, legacyExact);
  promoteViaDependency(afterDemotion, inventory, minInstr, targetCopies);
  for (const s of afterDemotion) {
    packages.push(s.score);
    scoreByOwner.set(`${s.entry.file.package}@${s.entry.file.version}`, s.score);
  }
  packages.sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || b.exactCoverage - a.exactCoverage);

  // Pass 3: version-tolerant "fuzzy-only" index (see the constant's doc
  // comment above), populated only from packages whose own score (now known
  // from pass 2) already cleared medium/high some other way.
  const fuzzyOnlyOwners = new Map<string, string[]>();
  for (const entry of eligibleDbs) {
    const owner = `${entry.file.package}@${entry.file.version}`;
    const score = scoreByOwner.get(owner);
    if (score === undefined || score.isBaseline || (score.tier !== "high" && score.tier !== "medium")) continue;
    const fnByIndex = fnByIndexByEntry.get(entry)!;
    for (const m of entry.file.modules) {
      if (m.factoryIsBaseline || m.factoryIsDependency === true || m.factoryFuzzyHash === null || foreignSets(entry.file).factories.has(m.factoryFunctionIndex)) continue;
      const factory = fnByIndex.get(m.factoryFunctionIndex);
      if (factory === undefined || factory.instrCount < MIN_FUZZY_ONLY_FACTORY_INSTR) continue;
      const fuzzyKey = schemeKey(entry.file, m.factoryFuzzyHash);
      let owners = fuzzyOnlyOwners.get(fuzzyKey);
      if (owners === undefined) {
        owners = [];
        fuzzyOnlyOwners.set(fuzzyKey, owners);
      }
      if (!owners.includes(owner)) owners.push(owner);
    }
  }

  const moduleAttributions: ModuleAttribution[] = inventory.modules.map((m) => {
    // LB1: scheme-2 owners under the factory's scheme-2 hash, scheme-1
    // owners under its prefixed scheme-1 hash; both claim the module.
    const legacyKey = m.exactHash === null ? null : LEGACY_PREFIX + (m.legacyExactHash ?? m.exactHash);
    const both = <T,>(get: (k: string) => readonly T[] | undefined, a: string | null, b: string | null): T[] => [...new Set([...(a === null ? [] : (get(a) ?? [])), ...(b === null ? [] : (get(b) ?? []))])];
    let owners: string[] = both((k) => hashOwners.get(k), m.exactHash, legacyKey);
    let ownerBasis: ModuleAttribution["ownerBasis"] = owners.length > 0 ? "exact" : null;
    if (owners.length === 0 && m.fuzzyHash !== null && m.factoryStringSetHash !== null) {
      const factoryInstr = inventory.functions[m.factoryFunctionIndex]?.instrCount ?? 0;
      if (fallbackEligible(factoryInstr, m.factoryStringCount)) {
        const candidates = both((k) => fuzzyStringOwners.get(`${k}|${m.factoryStringSetHash}`), m.fuzzyHash, LEGACY_PREFIX + (m.legacyFuzzyHash ?? m.fuzzyHash));
        const distinctPackages = new Set(candidates.map((o) => o.slice(0, o.lastIndexOf("@"))).filter((p) => !BASELINE_NAME.test(p)));
        if (candidates.length > 0 && distinctPackages.size <= 1) {
          owners = candidates;
          ownerBasis = "fuzzy+strings";
        }
      }
    }
    if (owners.length === 0 && m.fuzzyHash !== null) {
      const factoryInstr = inventory.functions[m.factoryFunctionIndex]?.instrCount ?? 0;
      if (factoryInstr >= MIN_FUZZY_ONLY_FACTORY_INSTR) {
        const candidates = both((k) => fuzzyOnlyOwners.get(k), m.fuzzyHash, LEGACY_PREFIX + (m.legacyFuzzyHash ?? m.fuzzyHash));
        const distinctPackages = new Set(candidates.map((o) => o.slice(0, o.lastIndexOf("@"))).filter((p) => !BASELINE_NAME.test(p)));
        if (candidates.length > 0 && distinctPackages.size <= 1) {
          owners = candidates;
          ownerBasis = "fuzzy-only";
        }
      }
    }
    // Set-identity, not a threshold (G4c, 2026-09-28) — see
    // `ambiguousOwnerHash`'s own doc comment above. `hashOwnerNames` is
    // already deduplicated by package NAME (version-insensitive), so `> 1`
    // here means "at least one claimant is a genuinely different package",
    // never "several versions of the same package". Still never gates
    // `owners`/`ownerBasis` themselves the way an earlier landing
    // (e7c83bfa) tried.
    const ambiguousOwnerHash = ownerBasis === "exact" && both((k) => [...(hashOwnerNames.get(k) ?? [])], m.exactHash, legacyKey).length > 1;
    return {
      localModuleId: m.localModuleId,
      factoryFunctionIndex: m.factoryFunctionIndex,
      depCount: m.depCount,
      nestedFunctionCount: m.nestedFunctionIndices.length,
      instrCount: m.instrCount,
      stringConstants: m.stringConstants,
      owners,
      ownerBasis,
      ambiguousOwnerHash,
    };
  });
  const unattributedModules = moduleAttributions.filter((m) => m.owners.length === 0).sort((a, b) => b.instrCount - a.instrCount);

  return {
    hbcVersion: inventory.hbcVersion,
    totalFunctions: inventory.totalFunctions,
    totalModules: inventory.modules.length,
    packagesChecked: dbs.length,
    packages,
    moduleAttributions,
    unattributedModules,
  };
}
