// src/deps/match.ts — the D17a "match" stage: score every layered signature
// DB entry against a target bundle's module inventory, with confidence
// tiers, and attribute each `__d()` module to its best-owning package.
// Promoted + adapted from `tools/pkgsig/match.mjs` v2
// (docs/PACKAGE-SIGNATURES.md §5.4).

import type { LoadedSig } from "./db.ts";
import type { ModuleInventory } from "./inventory.ts";
import type { SigDbFile } from "./sigdb-types.ts";
import { foreignSets } from "./module-paths.ts";

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
  readonly demotion?: { readonly rule: "few-distinct" | "container" | "embedded" | "twin"; readonly by?: string };
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

function scorePackage(entry: LoadedSig, target: ModuleInventory, targetExact: Set<string>, targetFuzzy: Set<string>, targetStringHash: Set<string>, minInstr: number, hashOwnerNames: ReadonlyMap<string, ReadonlySet<string>>, targetCopies: ReadonlyMap<string, number>): { readonly score: PackageScore; readonly hitKeys: ReadonlySet<string> } | null {
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
      hitKeys.add(schemeKey(pkg, m.factoryExactHash));
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

  let tier: ConfidenceTier;
  if (strongModuleSignal || strongFunctionSignal) tier = "high";
  else if (fuzzyCoverage >= 0.5 || moduleExactHits >= 1) tier = "medium";
  else if (exactHits + fuzzyOnlyHits > 0) tier = "low";
  else tier = "none";
  let demotion: PackageScore["demotion"];
  // A package whose whole eligible code has fewer distinct hashes needs
  // them all (a one-function package fully matched stays high).
  const distinctEligible = pkg.slim?.distinctEligible ?? new Set(eligible.map((f) => f.exactHash)).size;
  if (tier === "high" && !pkg.toolchainBaseline && hitKeys.size < Math.min(MIN_DISTINCT_EVIDENCE_HASHES, distinctEligible)) {
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
  return { score, hitKeys };
}

interface ScoredEntry {
  readonly entry: LoadedSig;
  score: PackageScore;
  readonly hitKeys: ReadonlySet<string>;
}

// corpus-precision-forks: demote a "high" package whose evidence another
// explanation covers (docs/DEPS.md "Forks, embedded copies and repeated
// hashes"). Rules, in order, each over the packages still "high":
//  - container: EXPLAINED_EVIDENCE_SHARE of the target functions carrying
//    its hit hashes sit in target modules with more than
//    CONTAINER_SIZE_RATIO x the package's whole function count — a copy
//    inlined in another package's pre-built dist file (process and
//    stackframe in react-devtools-core's backend.js);
//  - embedded: that share of its distinct hit hashes are also hits of
//    another high package's OWN files (path-bearing signature, so those
//    files really are that package's), which has EMBEDDED_HOST_SIZE_RATIO
//    x more — oboe in react-native-blob-util, jszip in localforage. A
//    pathless host is not trusted: its signature may still hold its
//    dependencies' code (d3-zoom holds d3-ease);
//  - twin: two packages whose hit sets each cover that share of the
//    other's (punycode / punycode.js: one source, two names). One is
//    kept: a declared dependency of another high package, else the
//    path-bearing one, else the one with more distinct hits, else the
//    first by name.
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
    const whole = Math.max(s.entry.file.totalFunctions ?? 0, s.entry.file.rawFunctionCount ?? 0, s.score.eligibleFunctions);
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
  for (const s of twins) for (const d of s.entry.file.subtractedDependencies ?? []) dependedOn.add(d.slice(0, d.lastIndexOf("@") > 0 ? d.lastIndexOf("@") : d.length));
  const rank = (s: ScoredEntry): readonly number[] => [dependedOn.has(s.score.package) ? 1 : 0, (s.entry.file.modulePaths ?? 0) >= 1 ? 1 : 0, s.hitKeys.size];
  const better = (a: ScoredEntry, b: ScoredEntry): boolean => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! > rb[i]!;
    return a.score.package < b.score.package;
  };
  for (const s of twins) {
    if (s.score.tier !== "high") continue;
    for (const q of twins) {
      if (q === s || q.score.tier !== "high" || q.score.package === s.score.package) continue;
      const n = shared(s.hitKeys, q.hitKeys);
      if (n < EXPLAINED_EVIDENCE_SHARE * s.hitKeys.size || n < EXPLAINED_EVIDENCE_SHARE * q.hitKeys.size) continue;
      if (better(s, q)) demote(q, "twin", s.score.package);
      else {
        demote(s, "twin", q.score.package);
        break;
      }
    }
  }
  return scored;
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
  for (const s of demoteExplained(scoredEntries, inventory, legacyExact)) {
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
