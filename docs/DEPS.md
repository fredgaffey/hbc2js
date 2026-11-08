# `hbc2js deps` — npm dependency extraction

Implements D17/D17a/D17b (`docs/DECISIONS.md`). Identifies which npm
packages are inside a compiled Metro/Hermes bundle (or an `.apk` containing
one), using bytecode fingerprinting first and evidence-scored guessing
second — never by executing any package's code.

## Usage

```sh
hbc2js deps <bundle.hbc|app.apk> [--out <dir>] [--confirm] [--confirm-cache] [--offline] \
  [--sigdb <dir>] [--no-shared-db] [--min-instr <n>] [--json] [--exhaustive]
```

- `<bundle.hbc|app.apk>` — a compiled Hermes bundle, or an Android APK
  containing one at the usual `assets/index.android.bundle` (or
  `assets/*.hbc`) path. Plain-JS (non-Hermes) bundles are not implemented
  yet (D18 — a future frontend); the CLI reports a clear error rather than
  guessing.
- `--out <dir>` — the decompile-project output directory. When at least one
  dependency is confirmed with confidence, `<dir>/package.json` is written
  (merged into an existing one) with a `dependencies` map. The project-local
  signature DB also lives under here: `<dir>/.hbc2js/sigdb/`. When the input
  is an `.apk`, this single flag also drives the native side end to end
  (spec 27 §L9, closing the §L8 gap): the APK's native tables are ingested
  into `<dir>/native/*.jsonl` (the same `ingestNative`/`buildNativeTables`
  reader `check-native` verifies — see `docs/TOOLCHAIN.md`), then the L8
  reconstruction hook reads those tables straight back out and writes
  `<dir>/.env`, folds native-only dependencies into `<dir>/package.json`,
  and emits one `<dir>/native-todo/<Module>/` interface-skeleton stub per
  first-party native module. A bare `.hbc` input is unchanged: no
  `<dir>/native/` directory is written, and the reconstruction hook is a
  silent no-op. Re-running `deps <apk> --out <dir>` is idempotent, and a
  native-ingestion problem is reported to stderr without failing the
  JS-side run (native is optional-by-construction — spec 27 §1.4).
- `--confirm` — run the npm confirm stage (§4 below). Requires network.
- `--confirm-cache` — also write `--confirm`-built signatures into the user
  cache, which later runs read. Off by default (corpus-confirm-precision).
- `--offline` — skip npm registry search and the confirm stage entirely; the
  match and guess stages still run against whatever signature DB is
  reachable locally.
- `--sigdb <dir>` — override the project-local DB directory outright
  (instead of `<out>/.hbc2js/sigdb`). It keeps the layer name `project`
  (dedup priority and report `layer` fields unchanged) but is marked
  `filterable` in `resolveDbLayers`, so it honours the evidence-directed
  candidate filter like the user/shared layers (SIGDB1: a 27 GB bulk DB given
  here previously loaded every file and exhausted the heap). The default
  `<out>/.hbc2js/sigdb` project layer, being this project's own small
  `--confirm` output, still loads in full.
- `--no-shared-db` — don't consult `tools/pkgsig/db` (this repo's starter
  set); useful to measure how much this task's own curated data is doing.
- `--min-instr <n>` — FLIRT-style minimum-instruction floor before a
  function hash is trusted at all (default 8, per
  `docs/PACKAGE-SIGNATURES.md` §2.4).
- `--json` — machine-readable `DepsReport` (see `src/deps/report.ts`) on
  stdout instead of the human table.
- `--exhaustive` — score every signature file in every DB layer (the only
  behaviour before QUEUE item 22a). Default is now **evidence-directed**
  matching — see "Evidence-directed matching" below.

## Pipeline

1. **Module inventory** (`src/deps/inventory.ts`, `src/deps/dscan.ts`):
   parse the bytecode (never decompile it) and find every
   `__d(factory, id, deps)` registration structurally, by pattern-matching
   the `global` function's own decoded instructions. This recovers, for
   every Metro module: its factory function index, local numeric module id,
   ordered dependency-id array, nested closures, and the full set of
   string-literal constants used anywhere in the module — all for free,
   before any signature lookup.
   The registration global may carry a `__METRO_GLOBAL_PREFIX__`
   (`<prefix>__d`), and the two-argument `__d(factory, id)` form is
   accepted with unknown deps. When the `global` function registers
   nothing, the functions it creates directly are scanned too (one
   level): this finds bundles whose body is wrapped in an IIFE and lazy
   definers that switch on a module id (corpus-B4). Re.Pack/webpack chunk
   bundles (`webpackChunk_*` module objects) and scope-hoisted bundles
   with no module system are not recognised and still report
   `totalModules: 0`.
2. **Match** (`src/deps/match.ts`, `src/deps/db.ts`): score every signature
   DB entry (across the three layers below) against the target's own
   per-function exact/fuzzy/string-set hashes and per-module factory hashes.
   Confidence tiers (`docs/PACKAGE-SIGNATURES.md` §5.4):

   | Tier | Condition |
   |---|---|
   | High | `moduleExactHits >= 3` (`STRONG_MODULE_HIT_COUNT`); or, for packages with **≥3 non-baseline hashed modules** (`TINY_PACKAGE_MODULE_TOTAL`), `moduleExactHits >= 2` **and** module coverage ≥5% **and** overall exact-function coverage ≥10%; or, for **tiny** packages (<3 modules), ≥5 exact-matched functions totalling ≥150 instructions; or overall exact-function coverage ≥90% (any package size) |
   | Medium | overall fuzzy coverage ≥50%, or exactly 1–2 module-exact hits |
   | Low | any exact/fuzzy hit at all, below Medium's floor |
   | None | zero hits after the `--min-instr` floor |

   **Cross-package hash ambiguity (2026-08-31, §6.7 below).** Every exact
   hit counted above (`exactHits`, `moduleExactHits`) must also be
   *unambiguous*: a hash claimed by **≥20 distinct non-baseline package
   names** anywhere in the loaded DB is excluded from every package's own
   count, full stop — shared evidence that broad is not proof for any one
   claimant. Found necessary only once the 32,708-signature bulk DB (D17c)
   was layered in: whole families of npm packages that share near-identical
   generated boilerplate (the `ljharb` ES-shim family — `is-weakref`,
   `is-finalizationregistry`, `hasown`, `is-data-descriptor`, ... — plus, more
   pervasively, Babel's own runtime helpers, byte-identical across a huge
   fraction of all Babel/TS-compiled npm packages) independently reached
   "high" off dozens of hits that, on inspection, every sibling package
   claimed identically, producing many simultaneous false "confirmed"
   dependencies. The threshold is 20, not
   a smaller number: a real, *legitimate* multi-package dependency chain
   (Metro has no export-level tree-shaking, so `@react-navigation/stack`'s
   own signature genuinely still contains code shared with
   `react-native-gesture-handler`/`react-native-reanimated`/
   `react-native-safe-area-context`/`@react-navigation/native`, all real
   dependencies bundled together) measured up to 7 distinct package names
   sharing one hash even in the small curated starter DB alone — an earlier
   cutoff of 3 was tried and destroyed that real signature entirely
   (`moduleExactHits` 292→0, tier high→low, on a dependency
   `react-navigation-example`'s own ground truth confirms is present). 20
   sits clear of both measured populations: comfortably above the largest
   legitimate chain found (7), far below the smallest measured
   boilerplate-family collision (55, measured on the bulk DB).

   **Threshold rationale (2026-08-30 tightening, `src/deps/match.ts`,
   `docs/PACKAGE-SIGNATURES.md` §6.6).** The pre-fix "high" rule
   (`moduleExactHits >= 1 && moduleCoverage >= 5%`) let a package with very
   few total modules reach "high" off a **single** coincidentally-matching
   module — measured live on `react-navigation-example-0.85.3` with the
   fixed bulk signature DB layered in: `js-md5` (2 total modules) hit 1/2 =
   50% coverage, `@emotion/react` (16–17 total modules) hit 1/16 ≈ 6%, both
   comfortably over the old flat 5% floor from one lone hash collision
   (FLIRT's classic single-collision risk, §1.2/§3.4). The fix requires
   **independent, multi-hit evidence, sized to the package**:
   - `STRONG_MODULE_HIT_COUNT = 3` — three or more independently-matching
     modules is strong evidence regardless of package size (unchanged).
   - `MIN_MODULE_HITS_FOR_COVERAGE_PATH = 2`, `MIN_MODULE_COVERAGE = 0.05`,
     `MIN_EXACT_FUNCTION_COVERAGE_FOR_COVERAGE_PATH = 0.10` — the
     percentage-of-modules path now needs *two* independent module hits,
     never one, **and** a non-trivial slice of the package's own function
     set (not just its module count) to have matched. Raising the hit floor
     from 1 to 2 alone eliminates both measured false positives (each had
     exactly 1 module hit); the function-coverage leg is defense in depth
     against a similar two-hit coincidence in a function-rich package.
   - `TINY_PACKAGE_MODULE_TOTAL = 3` — below this many total hashed modules,
     the percentage-of-modules path is disabled outright: a percentage of 1
     or 2 modules isn't statistically meaningful. Tiny packages instead need
     `MIN_TINY_PACKAGE_EXACT_FUNCTION_HITS = 5` exact-matched functions
     totalling `MIN_TINY_PACKAGE_EXACT_FUNCTION_INSTR = 150` instructions —
     several sizeable functions matching exactly is not plausibly a
     coincidence, whereas one is — or `HIGH_EXACT_FUNCTION_COVERAGE = 0.9`
     (near-total package match, any size). `tests/gate/deps/match.test.ts`
     has both the two regression cases (js-md5/@emotion don't reach "high"
     off their real, single-hit collision) and two positive controls (the
     same two packages, given genuine multi-hit/broad-coverage evidence,
     still do) — see `tests/fixtures/sigdb/tiny-package-collision/` for the
     real signature files the collision was reproduced from.

   Per-module ownership is by exact factory hash, falling back to the
   factory's fuzzy hash **and** full string set together (≥8 instructions
   and ≥1 string, or ≥16 instructions; keys claimed by more than one real
   package never attribute) — this is what survives `hermesc -g`'s
   different register allocation (`ownerBasis` records which). Debug-only
   instructions (`AsyncBreakCheck`, `Debugger`) are elided from every hash.

   **Version-tolerant matching: the `fuzzy-only` tier (2026-08-31, issue
   #14/F1).** The two ownership bases above both still require the module's
   exact hash (or its fuzzy hash + full string set) to appear in the DB
   verbatim — brittle against version drift, since a signature DB rarely
   has the *exact* library version an app shipped (D17c's bulk DB has
   `react-native` at 0.70.6/0.72.8/0.76.5 for HBC96, for example, never a version the app may actually ship). `ownerBasis` gets a third value, `"fuzzy-only"`: a module whose
   factory has **no** exact or fuzzy+strings match falls back to its bare
   opcode-sequence (fuzzy) hash *alone* — most of a library's functions
   don't change source between adjacent minor/patch versions, so their
   mnemonic sequence (every operand, including string/bigint content,
   already stripped) is often identical even when the exact hash and string
   set are not. Far more collision-prone than the other two bases (stripping
   every literal throws away the strongest disambiguating signal), so it
   carries two independent safeguards:
   1. **Package-level trust gate** — only from a package whose own score
      already reached medium/high confidence some other way (real exact-hash
      evidence, or broad fuzzy coverage); an isolated fuzzy collision from a
      package with zero other evidence never attributes a module by itself.
   2. **Size floor** — a factory below `MIN_FUZZY_ONLY_FACTORY_INSTR` (24)
      instructions is never trusted this way, larger than the fuzzy+strings
      fallback's own 16-instruction floor since there is no string-set
      corroboration to lean on.

   A key claimed by more than one distinct non-baseline package is still
   never trusted, exactly like `fuzzy+strings`. This tier is *not* headlined
   as separately from "matched" in `attribution` (both feed
   `matchedInstrWeight`/`matchedModules` alike — see the by-weight metric
   below), but `attribution.matchedInstrWeightByBasis` breaks the weight out
   by basis so a report can see how much of "matched" rests on it.

   Only **High**-tier, non-baseline matches are reported as `confirmedDeps`.
   `react-foundation`/`react-native-foundation` (baseline artifacts that
   exist to be *subtracted* from other packages' signatures, never real npm
   packages themselves) are aliased back to `react`/`react-native` when no
   separate non-baseline file exists for that HBC version —
   `metro-toolchain-empty` has no npm equivalent and is dropped entirely.

3. **Guess** (`src/deps/guess.ts`, `src/deps/native-modules.ts`,
   `src/deps/apk.ts`): for every module the match stage left unattributed,
   collect weighted evidence:

   | Clue | Weight | Notes |
   |---|---|---|
   | `NativeModules.X`/`TurboModuleRegistry.get('X')` name, found as a string constant | 0.75 | Near-unique — curated in `native-modules.ts`. Version-independent, unlike a hash: this is often the *only* signal that still works once an app's actual library version has drifted from the signature DB's pinned version. |
   | Known third-party SDK URL/API host | 0.40 | e.g. `api.stripe.com` -> `@stripe/stripe-react-native` |
   | Package-name string literal (curated name, `native-modules.ts`/host-map values) | 0.30 | A bare match (`"react-native-gesture-handler"` as a whole string) carries no version and, alone, is too generic to report (any code can contain a popular package's name). A `name@version`-shaped single literal (`"react-native-gesture-handler@2.14.0"`) carries a version and is the stronger, self-corroborating form — see the `hint` tier below. |
   | APK evidence (manifest permission, bundled `.so` name, asset file) | 0.20 | Only available for `.apk` input |
   | Dependency-edge propagation | up to 0.50, `0.2 * identified-dep-count` | Only fires when depOwners agree unanimously **and** either ≥2 deps are identified or ≥50% of the module's declared deps are — a single coincidental hit is deliberately not enough (this threshold was tightened after an early version attributed thousands of an app's own modules to "react-foundation" off a 1-in-7 dependency coincidence). Baseline-package owners never seed this clue. |
   | npm registry search fallback | 0.15 per hit | Network, `--offline` disables it; only tried when there's a name lead (a native-module-derived guess or a package-name-shaped string) |

   Guessed candidates are aggregated per package (not per module) in the
   report, and pass the precision rules in `src/deps/report.ts`
   before being listed: a low-tier DB score is not evidence, a medium one
   counts only with an exact hit, anything reported needs ≥2 independent
   evidence kinds and confidence ≥0.5, npm-search never stands alone, and a
   package the DB scored explicitly negative (a signature at this HBC
   version with no exact function or module hit) is vetoed. What was
   weighed and dropped is in `suppressedGuesses` (`--json`). Anything already in `confirmedDeps` is excluded from the guessed
   list.

   **`hint` tier.**
   The ≥2-independent-kinds rule above correctly kills the false positives
   F1 found, but it also throws out every module whose *only* evidence is a
   single, highly specific clue — the common case once an app's actual
   library version has drifted far enough from the signature DB that no
   second corroborating hit ever fires (most third-party dependencies show up as exactly one native-module
   name and nothing else). `src/deps/report.ts` now files a
   single-evidence-kind candidate as a `hint` — a new `DepsReport.hintedDeps`
   array, `src/deps/types.ts`'s `DepTier` — instead of silently suppressing
   it, but **only** when that one kind is high-specificity
   (`isHintEligibleEvidence`, `src/deps/guess.ts`): a curated native-module
   name, a curated API-host constant, or a package-name string literal that
   itself carries a version (the versioned row above). A bare package-name
   string with no version, an APK hint, a dependency-edge, or an npm-search
   hit are explicitly **not** eligible alone — those stay suppressed exactly
   as before, since none of them individually rules out coincidence the way
   a curated name/host/versioned-string match does. A `hint` is reported for
   visibility only: never merged into `package.json` (`packageJsonDependencies`
   only ever reads `confirmedDeps`), never counted in
   `attribution.percentAttributed`, and vetoed the same way a guess is if
   the DB scored the package explicitly negative or it's already confirmed.
   `tools/deps-truth.mjs` scores hint precision separately from guessed
   (`s.hinted`) — reported, not gated, same as guessed-tier precision,
   except on `rn-template-0.72` where `tests/gate/deps/truth.test.ts`
   asserts zero hint false positives (that fixture has no third-party
   dependencies at all, so any hint there would be one).

   Measured 2026-08-30 (offline, shared DB only — adding this tier changes
   *only* which suppressed candidates move to `hintedDeps`; `confirmedDeps`
   and `guessedDeps` are byte-identical before/after on both fixtures below,
   verified directly against a pre-hint-tier copy of `report.ts`, satisfying
   the D17d gate):

   | App | Hints | False positives (by name) |
   |---|---|---|
   | `rn-template-0.72` (release + `-g`) | 0 | 0 |
   | `react-navigation-example-0.85.3` | 1 (`react-native-pager-view`, via `RNCViewPager`) | 0 — this is one of the app's 9 real dependencies, previously either mis-tiered as "guessed" or silently suppressed depending on which precision-rule vintage produced a given number in this doc's older tables |

   What this tier does: a lone single-evidence-kind candidate that would
   otherwise have been silently suppressed now shows up in `hintedDeps` when
   its one kind is high-specificity, and `confirmedDeps`/`guessedDeps` are
   byte-identical with and without this tier's promotion logic.

4. **Confirm** (`src/deps/confirm.ts`, `--confirm` only): for the
   best-ranked guessed candidate per module, `npm pack <pkg>@<version>` (a
   plain tarball download — **never** `npm install`, so the candidate's own
   install-time scripts never run), extract by hand into a scratch RN
   project pinned to the target's detected RN version, bundle with Metro,
   compile with the matching `tools/hermesc/v<N>`, fingerprint, and match
   against the target. A candidate that clears the confirm minimum-evidence
   rule (below, "Confirm minimum evidence") has its signature written into
   the **project-local** DB (`<out>/.hbc2js/sigdb`, never the `--sigdb`
   directory), and into the **user cache** (`~/.cache/hbc2js/sigdb`) only
   under `--confirm-cache`. A candidate that fails to bundle/compile/match is recorded (not
   retried) in `<scratch>/confirm-failures.json`. Downloads are rate-limited
   (500ms between candidates by default). When a candidate's version has to
   be resolved by "nearest npm release by date" (no version evidenced),
   `nearestVersionByDateDetailed` prefers the nearest **stable** release over
   a nightly/prerelease and only falls back to the nearest prerelease — with
   the pick flagged (`usedPrereleaseVersion`) on the `ConfirmResult` — when a
   package has shipped no stable release at all.

   *Speed (CONFSPEED1).* Measured on an RN 0.76.5 scratch: `--reset-cache`
   made every Metro run re-transform all of React Native (10-19 s per
   candidate vs 2.3-5.5 s without; npm install 1.5-3.7 s, hermesc 0.4-4 s), so
   Metro now keeps its content-keyed transform cache (verdict-neutral). A built
   candidate's raw (pre-baseline-subtraction) fingerprint is also cached under
   `<user-cache>/confirm-fp/` keyed by package@version + hbc + hash scheme + RN
   version, so a re-confirm (new target, wiped project DB) does no npm, Metro
   or hermesc work. Not done: batching many candidates into one bundle (it
   would mix shared dependencies into every signature and change verdicts) and
   a parallel worker pool (needs one scratch project per worker).

5. **Report** (`src/deps/report.ts`): the human table / `--json` shape, plus
   `<out>/package.json` when confident. `DepsReport.moduleOwnership` is the
   module-id -> package mapping the M6 emitter needs (see "For M6" below).

## Evidence-directed matching
Before this task, step 2 above (`match`) always loaded and JSON-parsed
**every** signature file in every DB layer (`db.ts`'s `loadSignatures`) up
front, then scored the whole target function set against every one of
them — with the D17c bulk DB layered in (tens of thousands of signature files) this was by far the slowest operation in the product.

**Design.** `src/deps/candidates.ts` adds a candidate-derivation pass that
runs before any signature file is read: a single, cheap walk over the
bundle's own module string constants (already recovered structurally by
`inventory.ts` — no extra bytecode parsing) builds one evidence text blob,
then every candidate package name available in a DB layer — derived purely
from its filename (`<pkg>@<version>__hbc<N>.json`, no JSON parsing needed to
know a package's name — `packageNameFromSigFilename`) — is tested for
whether it occurs as a literal, case-insensitive substring anywhere in that
text: a `node_modules/<pkg>/...` path fragment, a quoted `require`-shaped
string, a deprecation-notice sentence naming the package
(`"...install it from 'react-native-foo' instead"`), a version banner, or
simply the name occurring inside a longer identifier (`ReactNative` contains
`react-native`). A second, scope-level pass catches a scoped package whose
own full name doesn't survive verbatim but a sibling under the same scope's
does (measured: `@react-navigation/native` doesn't appear verbatim in
`react-navigation-example`'s strings, but `@react-navigation/stack` does,
and the bare `@react-navigation/` prefix does too — evidently from a third
string the local DB has no signature for).

Matching thousands of candidate names against the evidence text one
`String.prototype.includes` call at a time would be O(patterns x text
length) — worse than useless at 32k patterns. `findCandidatesInText` is a
small Aho-Corasick automaton instead: O(total pattern length + text length +
match count), independent of how many candidate names exist. `db.ts`'s
`loadSignatures` gained an optional `{ candidates }` filter (omitted —
every caller before this task — is byte-for-byte the old exhaustive
behaviour); `listJsonFiles` skips any non-baseline file whose
filename-derived package name isn't in the candidate set. Baselines
(`_baselines/*`, foundational subtraction data, not named npm packages) and
the small `project`-local layer (explicit `--confirm` results) are always
loaded in full regardless of candidates.

**Default and `--exhaustive`.** `hbc2js deps` now runs evidence-directed by
default; `--exhaustive` (`runDeps({ exhaustive: true })`) restores the exact
previous behaviour — every existing test that constructs its own DB via
`loadSignatures(layers)` with no options is completely unaffected (that
call shape still means "load everything"; only `runDeps`'s own default
changed). One existing sweep test
(`tests/sweep/deps/corpus.test.ts`) needs the scope-prefix pass above to
still find all 9 of `react-navigation-example`'s known dependencies by
default — see below.

**Correctness bar (measured 2026-09-03).** `tests/gate/deps/candidates.test.ts`
runs both paths (default evidence-directed vs `--exhaustive`) against
`rn-template-0.72` and diffs `moduleAttributions`: **zero divergences** on
every module both paths attribute, and the `confirmedDeps` package sets are
identical (`react`, `react-native`). `tests/sweep/deps/corpus.test.ts`
(react-navigation-example-0.85.3, run directly, not via a diff) confirms all
9 known dependencies at "high" by default — same recall as `--exhaustive`
gave before this task; no recall drop was needed or shipped on either
committed correctness-bar fixture. `evidence-directed N vs exhaustive M`
attributions on `react-navigation-example-0.85.3`: identical, 9 confirmed
either way (`react`, `react-native`, `@react-navigation/stack`,
`@react-navigation/native`, `react-native-gesture-handler`,
`react-native-reanimated`, `react-native-screens`, `react-native-safe-area-context`,
`@react-native-async-storage/async-storage`).

**Wall-time (shared 41-file starter DB only — the D17c 32,708-signature
bulk DB was not used for this table):**

| Bundle | `--exhaustive` | default (evidence-directed) |
|---|---|---|
| `rn-template-0.72` | 0.39s | 0.35s |
| `react-navigation-example-0.85.3` | 0.82s | 0.87s |

At 41 signature files, load time is not the bottleneck for either path
(noise-level difference, sometimes negative) — this is expected and
doesn't demonstrate the fix; the premise of evidence-directed matching is that the cost is
in the DB's *file count*, not in matching a small starter set.


## Signature DB layering (D17b)

Lookup order, first hit per `package@version`+HBC-version wins:

1. **project-local** — `<out>/.hbc2js/sigdb/` (or `--sigdb <dir>`). Written
   by `--confirm`; committing this with a decompilation project makes its
   results reproducible offline for anyone who checks it out later.
2. **user cache** — `~/.cache/hbc2js/sigdb/` (respects `XDG_CACHE_HOME`).
3. **shared** — `tools/pkgsig/db/` in this repo (or the installed npm
   package — it ships alongside `dist/`, see `package.json`'s `files`).
   Disabled by `--no-shared-db`.

One JSON file format across all three layers (schema 2 —
`src/deps/sigdb-types.ts`), so a project-local signature can be copied
straight into the shared set (see "Contributing a signature upstream"
below).

### The D17c bulk DB (fetch, layering, and a real data-hygiene bug)

`tools/pkgsig/fetch-db.sh` fetches the D17c bulk signature DB (built on a build host, `docs/DECISIONS.md` D17c — ~2,000 packages across HBC 94/96/98/99,
32,708 signatures as of the first `2026-08-30` build) and unpacks it into a
local directory in the same schema-2 format as every other layer:

```sh
# From a public URL, once one exists:
HBC2JS_SIGDB_SOURCE=https://.../sigdb-20260830-partial.tar.zst \
  tools/pkgsig/fetch-db.sh [dest-dir]
# Straight from the build host (scp), before anything is published:
HBC2JS_SIGDB_SOURCE=$HBC2JS_REMOTE_HOST:<bulk-dir>/dist/sigdb-20260830-partial.tar.zst \
  tools/pkgsig/fetch-db.sh [dest-dir]
```

`dest-dir` defaults to the user-cache layer (`~/.cache/hbc2js/sigdb`), so a
plain `hbc2js deps <bundle>` picks it up automatically once fetched; pass an
explicit `dest-dir` and `--sigdb <dest-dir>` (or point it at
`<out>/.hbc2js/sigdb` before running `deps`) to layer it as project-local
instead, ahead of the shared starter set.

**Data hygiene, found measuring this task's baseline (2026-08-31, issue
#14).** The first archive (`sigdb-20260830-partial.tar.zst`, a partial/
interrupted build per its own filename) has 353 of its 32,708 files
(1.1%) with baseline subtraction (`docs/PACKAGE-SIGNATURES.md` §5.2)
silently skipped — `subtractedBaselines: []` on a non-baseline package,
meaning its function set is still an essentially-unsubtracted copy of
Metro's runtime plus, when the build scaffold pulled it in, all of
react/react-native. Verified directly: `@amplitude/react-native@2.17.0`'s
hbc94 file carries 4,244 functions, of which 4,150 exact-hash-match the
committed `rn-template-0.72` fixture — a fixture with **no** dependency on
`@amplitude/react-native` at all. Unfiltered, layering this archive turned a
clean 2-confirmed-dependency report into 134 "confirmed" dependencies, 133
of them false, entirely from a handful of contaminated files winning
exact-hash collisions against every large bundle's own react-native code —
exactly the failure mode `tools/pkgsig/bulk/baseline-subtract.mjs`'s own
header describes; these particular files just never went through it.

`fetch-db.sh` always runs `tools/pkgsig/filter-unsubtracted.mjs` on the
destination directory after extracting, which quarantines any such file into
`dest-dir/_rejected-unsubtracted/` (kept for audit, never read by
`loadSignatures` — it only reads `<dir>/*.json` and `<dir>/_baselines/*.json`)
before the DB is considered ready. Run it by hand against any existing sigdb
directory with `node tools/pkgsig/filter-unsubtracted.mjs <dir>`; it's
idempotent. This is deliberately *not* a change to `src/deps/db.ts`'s
`loadSignatures` itself — dozens of gate tests construct minimal
hand-written `SigDbFile` fixtures that don't bother populating
`subtractedBaselines` (irrelevant to what they test), and a cold
`--confirm` run with no baseline files reachable in any DB layer yet can
legitimately produce the same empty-array shape without being contaminated
data — so the check belongs at bulk-archive ingestion time, not as a
blanket load-time policy.

(CONSOLIDATION 28: this quarantine is a hard, unconditional check — `fetch-db.sh`
has no flag to skip it — covered directly by `tests/gate/tools/filter-unsubtracted.test.ts`.)

Even after quarantining those 353 files, layering all ~32,000 remaining
ones exposed a second, distinct problem — see "Cross-package hash
ambiguity" above (§6.7): whole families of npm packages sharing
near-identical generated boilerplate independently reaching "high"
confidence off the same shared evidence. Both fixes are necessary together;
neither alone was sufficient (measured: unsubtracted-file quarantine alone
still left 6 real false positives on `rn-template-0.72`; the ambiguity threshold alone, without quarantining first, would
still be scoring against contaminated function sets).

## Evidence-weight rationale and known limitations

- **Hash matching is HBC-version *and* library-version sensitive.**
  `docs/PACKAGE-SIGNATURES.md` §5.6 found that a signature DB built from a
  2026-era RN/react-navigation release attributes under 1% of the modules of some
  shipped apps, because their actual bytecode — though tagged
  the same HBC major version — comes from a considerably older library
  release. The guess stage's native-module clue is the practical fix: it
  survives version drift completely, since native-module names essentially
  never change across a package's history.
- **`react-foundation`/`react-native-foundation` baseline files are not
  npm packages.** They exist purely so every *other* package's signature
  file can have Metro's shared runtime/polyfill functions subtracted out of
  it (`docs/PACKAGE-SIGNATURES.md` §5.2) — attributing an app's own
  first-party code to "react-foundation" via a weak dependency-edge
  coincidence is exactly the failure mode the tightened threshold above
  guards against.
- **Confidence never crosses into code substitution here.** `hbc2js deps`
  only ever reports; deciding whether to emit `require("pkg")` in place of
  decompiled code is M6's call, gated on `DepsReport.moduleOwnership`
  (confirmed-tier only).
- **Object-prototype safety**: every string-keyed lookup table this stage
  uses (`native-modules.ts`, the URL-host map, the APK asset-hint map) is a
  real `Map`, not a plain object literal — a bundle's own string constants
  are untrusted input, and a plain-object lookup keyed by a string like
  `"hasOwnProperty"` or `"constructor"` would silently return an
  `Object.prototype` member instead of `undefined` (`tests/gate/deps/guess.test.ts`
  has the regression test).

## `DepsReport` JSON schema (issue #14's open Q)

`--json` prints `DepsReport` (`src/deps/report.ts`) verbatim. Field names a
prior consumer got wrong by guessing (`.name` instead of `.package`,
`.strings` instead of `.topStrings`) are exactly why this section exists —
read this before writing a `--json` consumer rather than re-deriving the
shape from the human table.

| Field | Type | Meaning |
|---|---|---|
| `input` | `string` | The path passed on the CLI. |
| `hbcVersion` | `number` | Parsed Hermes bytecode version (never guessed from the RN version — the reverse). |
| `totalFunctions`, `totalModules` | `number` | Whole-bundle counts from the module inventory. |
| `reactNativeVersion` | `string \| null` | Best-guess RN version, from the highest-confidence matched `react-native`/`react-native-foundation` signature; `null` if none matched at all. |
| `reactNativeVersionConsistentWithHbc` | `boolean \| null` | F4 (issue #14): `null` when `reactNativeVersion` is `null` (nothing to reconcile) or the parsed `hbcVersion` has no documented RN range; otherwise whether `reactNativeVersion` falls inside the range `docs/TOOLCHAIN.md`'s table documents for this `hbcVersion` (e.g. HBC96 → RN 0.72.x-0.81.x, widened from 0.73.x-0.81.x 2026-09-18 -- see "RN version reconciliation (F4)" below). |
| `reactNativeVersionExpectedRange` | `string \| null` | Human-readable RN range for this `hbcVersion` (populated whenever one is known, not only on a mismatch), e.g. `"RN 0.72.x-0.81.x"`. |
| `confirmedDeps` | `ConfirmedDep[]` | `{ package, version, confidence, modulesCovered, moduleTotal, source }` — `package` (not `.name`), High-tier or `--confirm`-verified. Written into `package.json`. |
| `guessedDeps` | `GuessedDep[]` | `{ package, version, confidence, modules, evidence }` — evidence-scored leads clearing the precision rules (≥2 independent evidence kinds, confidence ≥0.5). Never written into `package.json`. |
| `hintedDeps` | `HintedDep[]` | `{ package, version, confidence, evidenceKind, evidence }` — single-evidence-kind leads kept only when that one kind is high-specificity. Reported for visibility only. |
| `suppressedGuesses` | `SuppressedGuess[]` | `{ package, confidence, evidence, reason }` — what the precision rules weighed and dropped, and why. |
| `unattributedModules` | `UnattributedModule[]` | `{ localModuleId, factoryFunctionIndex, instrCount, topStrings }` — `topStrings` (not `.strings`), the module's first 8 string constants; likely first-party app code. |
| `moduleOwnership` | `ModuleOwnership[]` | `{ localModuleId, factoryFunctionIndex, package, version }` — flat module→package map, **confirmed-tier owners only** (the M6 contract, see below). |
| `attribution.totalModules`/`matchedModules`/`guessedModules`/`unattributedModules`/`percentAttributed` | `number` | Module-**count** attribution (pre-existing). |
| `attribution.totalInstrWeight`/`matchedInstrWeight`/`guessedInstrWeight`/`hintedInstrWeight`/`unattributedInstrWeight` | `number` | F2 (issue #14): the same split, summed by `instrCount` instead of counted — see "By-instruction-weight metric" below. |
| `attribution.matchedInstrWeightByBasis` | `{ exact, fuzzyStrings, fuzzyOnly }` | `matchedInstrWeight` broken out by `ModuleAttribution.ownerBasis` — how much of "matched" rests on the version-tolerant `fuzzy-only` tier. |
| `attribution.percentAttributedByWeight` | `number` | By-weight mirror of `percentAttributed` (matched+guessed). |
| `attribution.percentVerifiedByWeight` | `number` | **The headline number.** Matched (signature-verified, any basis) only, by weight — excludes guessed/hinted deliberately, since only a real signature match ever justifies code substitution (D17a). |
| `nativeChannel` | `{ deps: NativeChannelDep[] } \| null` | spec 27 §L7: the second, native-side ("literal package name") identification channel, merged against `confirmedDeps`/`guessedDeps`/`hintedDeps` above and de-duplicated by npm package name. `null` when the input was not an `.apk`, or the `.apk` had no readable native side (native ingestion never fails a deps run — §1.4). Each `NativeChannelDep` is `{ package, channel: "both" \| "native-only", evidence, nativeModuleCount }` — `evidence` is `["native-package","js-fingerprint"]` when this same package was also found by the JS-fingerprint channel above, `["native-package"]` alone for `channel:"native-only"` (a lib the JS side missed entirely — the IDEAS doc's "deps recall is partial" tail). A first-party (app-namespace) native module, or one under no curated third-party prefix, is never resolved to an npm package here at all (`src/native/native-deps.ts`'s `nativePackageForImplClass`). |

Two related, but distinct, module-level shapes exist below `DepsReport`
(reachable via `matchInventory`/`buildReport` directly, not part of
`DepsReport` itself): `MatchReport.moduleAttributions` (`src/deps/match.ts`)
is the *raw* per-module match-stage result (`owners`, `ownerBasis`,
`instrCount`, ...) for every module, matched or not; `DepsReport`'s own
`moduleOwnership` is the much narrower, M6-facing filtered view (confirmed
packages only). Don't conflate `moduleAttributions.owners` (raw hash-match
package@version strings, can be empty, ambiguous, or baseline-aliased) with
`moduleOwnership` (already resolved to one package/version per module,
confirmed-tier only).

### By-instruction-weight metric (F2)

Module-**count** attribution (`percentAttributed`) can look healthy while
the bundle's actual bytecode is barely touched — a real app's modules vary
hugely in size, and a handful of huge unmatched app modules (or a handful of
tiny matched ones) skew a raw count arbitrarily. `attribution`'s `*InstrWeight` fields
(above) sum `ModuleAttribution.instrCount` — already computed by the match
stage — instead of counting modules 1:1, giving the same
matched/guessed/hinted/unattributed split weighted by how much bytecode each
category actually represents. `percentVerifiedByWeight` is the number to
headline: what fraction of the bundle's real bytecode is hash-verified
library code a future M6 pass could actually strip.

`tools/deps-truth.mjs`'s `scoreAgainstTruth` mirrors this at the
*known-library-module* granularity too (`perModuleByWeight`, alongside the
pre-existing module-count `perModule`) — recall over the instructions truth
says belong to a real dependency, not just their count — and
`formatScore`/the human CLI table (`formatReportText`) both print the
headline weight line.

### RN version reconciliation (F4)

`detectReactNativeVersion` (`src/deps/report.ts`) picks the best-confidence
matched `react-native`/`react-native-foundation` signature's version — but
exact-hash matching against a *near-but-wrong* version, sampled because the
signature DB doesn't have the app's real one, can outrank the truth on raw
`exactCoverage` alone. `HBC_TO_RN_RANGE`
(`src/deps/report.ts`, from `docs/TOOLCHAIN.md`'s own version table) gives
each HBC version's documented RN release range; `detectReactNativeVersion`
now prefers a range-consistent candidate over an inconsistent one when both
are tied at the same confidence tier, and `reconcileReactNativeVersion`
always reports whether the version actually picked is consistent —
surfaced as `reactNativeVersionConsistentWithHbc`/`reactNativeVersionExpectedRange`
in `DepsReport` and as an inline `WARNING` line in both the human table
(`formatReportText`) and `tools/deps-truth.mjs`'s score output when it
isn't. This never silently fixes a wrong match — an inconsistent version can
still be the best (or only) evidence available and is still reported, just
flagged.

**Range.** `HBC_TO_RN_RANGE`'s HBC96 entry is `RN 0.72.x-0.81.x`: RN apps routinely pin `hermes-engine`/`hermesc` independently of the `react-native` npm version (Gradle/Podfile overrides are routine), so a HBC96 bundle built against react-native@0.72.x is a normal toolchain combination, not a wrong match. `tests/gate/deps/rn-version-range.test.ts` covers every documented HBC-to-RN pairing.

## For the M6 emitter (D19)

`DepsReport.moduleOwnership` (also reachable via
`matchInventory`+`buildReport`, or the whole pipeline via `runDeps`, all
exported from `src/index.ts`) is a flat array of
`{ localModuleId, factoryFunctionIndex, package, version }` — one entry per
Metro module confidently owned by a package in `confirmedDeps`. M6 should
skip emitting a `src/module_<id>.js` file for any id present here, and
instead ensure that package/version pair is in the emitted `package.json`'s
`dependencies` (already handled automatically when going through the CLI's
`--out` flag; call `packageJsonDependencies(report)` directly when embedding
`runDeps` programmatically).

`hbc2js export`'s `--substitute safe` (docs/specs/29-export.md §5,
`src/export/substitute.ts`) goes one step further than "skip the file": when
a package's module-graph boundary is unambiguous (exactly one module in
`own(P)` receives an edge from outside `own(P)`), it deletes every module in
`own(P)` from the export tree and rewrites the one boundary edge to a real
`require("<package>")`, using this same `moduleOwnership` field plus
`index/modules.json`'s `DepEdge[]` graph (§7.1) — no new deps-side data, an
export-side boundary analysis over what `moduleOwnership` already reports.
`ConfirmedDep.confidence` is a `ConfidenceTier` string here (`"high"` always,
by this file's own "only High-tier ... are reported" rule above); §5.2's
literal "confidence >= 0.8" is checked against a tier -> score mapping
(`src/export/substitute.ts`'s `tierConfidenceScore`) rather than a field this
report exposes directly.

## Ground truth (D17d)

`tools/deps-truth.mjs <bundle.hbc> <bundle.map> --bundle-js <bundle.js>
[--write-truth deps-truth.json] [--also-hbc <debug.hbc>]` derives per-module
truth from Metro's source map (`--sourcemap-output`): each minified `__d(...)`
line ends in `},<id>,[deps]);`, the map gives that line's source path, and
`node_modules/<pkg>/package.json` gives the version. The compact
`deps-truth.json` (module id → package@version, direct deps from the app's
package.json, transitive edges, .hbc sha256s) is what a fixture commits;
`tools/deps-truth.mjs <bundle.hbc> deps-truth.json` scores a report:
precision/recall for the confirmed and guessed tiers, per-module accuracy,
false positives and misses by name. Gate: `tests/gate/deps/truth.test.ts`
(confirmed-tier false positives must be 0 on release *and* `-g`); sweep:
`tests/sweep/deps/truth-react-navigation.test.ts` (skips until that
fixture's map/truth exist locally — its fetch.sh clones the react-navigation
monorepo and runs `pnpm install` + `expo export`, which is not cheap; add
`--source-maps` to the export and run the truth tool on the result).

**Sha pin drift (2026-09-28, J1 housekeeping).** A local re-fetch had
regenerated `react-navigation-example.hbc` (release, `-O`) without
regenerating `deps-truth.json`, so `hbcSha256Matches` failed for that variant
with a bare, message-less `assert.ok`. The fix was to re-pin
`deps-truth.json`'s `hbcSha256s["react-navigation-example.hbc"]` to the
file's actual sha256 (a local, gitignored artifact like the rest of this
fixture), because the source JS it is compiled from is unchanged and so the
module/package truth data is unaffected: the re-measured numbers below match
the previous run to within rounding, and confirmed-tier precision is still
100%, which it would not be if the scored `.hbc` and the map-derived truth
had come apart.

`hermesc -O` is deterministic here. **The provenance of this fixture is
what is actually unreliable, and it is worse than a stale pin** — three
facts to know before touching it:
- `fetch.sh` clones `react-navigation/react-navigation` with `--depth 1`
  at whatever `main` happens to be (BUILD.md: "or later — repo moves"), so
  re-running it does **not** restore this fixture; it builds a *different*
  app version. The map, the truth file and both `.hbc`s must then be
  regenerated together in that same run. Never re-pin a sha alone after a
  `fetch.sh` run — that would score a new bundle against old truth.
- BUILD.md's "Sizes, timing, hashes" table is **stale for all three
  artifacts** (it records bundle `07b00f6d…`, release `a8a42a70…`, debug
  `145ae44c…`; on disk they are `cf281f2f…`, `f103dd81…`, `349bc937…`), so
  that table cannot be used to validate a regenerated fixture.
- The sha the truth file previously pinned for the release build
  (`c8f81016…`) is **unexplained**: it is not what this bundle compiles to
  with this compiler, and the hermesc binary (dated before both builds) did
  not change between them. Most likely it is a snapshot from an earlier
  fixture generation. The debug pin was never broken, and the truth's debug
  pin matches the on-disk debug build, which is why the truth data itself is
  still trusted.

`tools/deps-truth.mjs`
now exports `shaGuardMessage(score, truthPath)` for an actionable failure
message (names the file, the truth file, and points at `fetch.sh`/`BUILD.md`)
instead of an opaque assertion; `tests/gate/deps/truth-sha-guard.test.ts`
regression-tests it against the committed `rn-template-0.72` fixture. With
the pin fixed, `react-navigation-example.hbc` (release) measures again: 75
truth packages (60 direct), confirmed 10 reported (precision 100%, recall
13.3% of all / 16.7% of direct), guessed 0, per-module by instruction weight
34.2% correct / 3.8% via dependent / 27.3% wrong / 34.8% unattributed, 59.8%
of all bundle instructions attributed overall — matching the debug (`-g`)
build's numbers to within rounding, as expected since both come from the
same source bundle.

Fixture: `tests/fixtures/bundles/rn-template-0.72/truth/` (a rebuild of the
template with the map; `BUILD.md` has the recipe). Numbers, 2026-08-30:

| | before (1b679a3) | after |
|---|---|---|
| release: confirmed | react-native@0.72.17, react@18.2.0 (precision 100%, direct recall 100%) | same |
| release: guessed | 12 packages, **0 true** (stack, react-redux, native, async-storage, toolkit, axios, immer, lodash, moment, gesture-handler, reanimated, zustand) | 0 reported, 1 suppressed (`--json` lists it) |
| release: per-module | 424/435 attributed | 334/432 library modules correct (77.3%), 51 attributed to the package that depends on them, 40 wrong, 7 unattributed; 0 app modules attributed |
| `-g`: confirmed | **none**, rn=null, 3.7% attributed, npm-search junk | react-native@0.72.17, react@18.2.0, rn=0.72.17, 0 guessed |
| `-g`: per-module | 0 | 325 correct (75.2%), 48 via dependent, 40 wrong, 19 unattributed; 0 disagreements with the release build |

Recall over *all* 20 truth packages is 10% by construction: the DB
fingerprints `react-native` with its dependencies bundled (minus the three
baselines), so `@babel/runtime`, `invariant`, `prop-types`, `scheduler`, ...
are reported under `react-native` (the "via dependent" column). The 40
"wrong" modules are `@babel/runtime`/`prop-types` helpers attributed to
`react-native` while truth says another dependent, 4 `react` modules owned by
the `react-native` signature, and 1 RN module the `@react-navigation/stack`
signature still contains (baseline-subtraction gap). The `-g` residue (19
unattributed) is string-less factories under 16 instructions, where the
fuzzy+string fallback is deliberately not trusted.

## Real-world measurement

The fixture numbers in "Ground truth (D17d)" above are a controlled baseline:
a small app built from source with an exact dependency tree. They are
the right numbers for regression-testing `hbc2js deps`, and they are
optimistic about real-world performance: published apps carry patched
dependencies, workspace-internal forks and generated code, and a store
bundle comes from a toolchain this tool does not control. The real-world
numbers below lead; per-app counts are in `docs/METRICS.md`.

Three open-source apps were rebuilt from the upstream version matching
the store APK and scored against Metro source-map truth (`tools/deps-truth.mjs`),
offline against db-v3:

| app | truth packages (direct) | own build: confirmed / precision / recall | store bundle: confirmed / precision / recall | recall gap |
|---|---|---|---|---|
| bluesky-social/social-app | 198 (198) | 44 / 68.2% / 15.2% | 37 / 67.6% / 12.6% | -2.6 pt |
| rainbow-me/rainbow | 518 (211) | 136 / 64.7% / 17.0% | 121 / 64.5% / 15.1% | -1.9 pt |
| MetaMask/metamask-mobile | 749 (306) | 172 / 72.7% / 16.7% | 144 / 70.8% / 13.6% | -3.1 pt |

- Real-world recall is 13.6% to 17.0% of true dependencies, far below
  the fixture's. The own-build to store gap is small (1.9 to 3.1 points); the large gap is
  fixture to real app, which is signature coverage: these apps have 198 to 749
  true dependencies and db-v3 has no usable signature for most of them.
- `--confirm` added 0 to 4 confirmed packages per measurement across six
  measurements (three apps, own build and store). Recall never moved and
  precision dropped slightly in five of six. The remaining 79 to 85% recall gap is a
  signature-coverage problem, not a confirm-stage problem.
- A separate `--confirm` sweep over real bundles saw `react-native bundle`
  candidate-build failures on 10 to 48% of candidates per app, and timed
  out on 3 apps at the 900 s cap. The precision proxy over the wider corpus was not run.
- 27-APK sweep: 22 apps have a Hermes bundle, 18 give a module inventory
  (mean 292 confirmed and 13 guessed dependencies per app, about 22 s each,
  offline); 5 have no Hermes bundle; 4 report `totalModules: 0`
  (docs/BUGS.md `corpus-B4`).

Harness defects found by this measurement are fixed with tests
`corpus-B1` (bundle entries over 64 MiB), `corpus-B3` (`deps-truth.mjs`
silently scored 0 truth packages for `__d((function...),id,[deps])`
wrappers) and `corpus-B5` (custom-named `assets/*.bundle`).

### Confirm minimum evidence (corpus-confirm-precision)

On real apps `--confirm` added false positives and no recall (one app went
from 72 to 209 unique confirmed packages; the additions were generic names
like `name`, `focus`, `atob`, `i`, each matching 1-3 modules). The cause:
a bare string in the bundle equal to a DB package name (`guess.ts` 3b,
`knownPackages`) proposes the package; confirm builds it and scores it
alone against the target, so `match.ts`'s ambiguity gate never fires; and
confirm accepted the "medium" tier, which is one module-factory hit. A hit
could also be a module of the candidate's own bundled dependency tree that
the match stage already attributed to that dependency. A confirm now needs
tier "high" and at least 3 module factories (`confirmMinimumEvidence`,
`src/deps/confirm.ts`) that exact-match the target, weigh at least 16
instructions, are not baseline- or dependency-flagged, and sit on target
modules no db-match package already owns. One or two such hits are enough
only when the guess evidence includes a native-module, url-host or
`name@version` string. A bare package-name string does not count, because
that is how the junk got proposed. Anything else stays guessed. Confirm also
wrote its signatures into the `--sigdb` directory it was scoring against
(the project layer is that directory when `--sigdb` is given) and into the
user cache, which every later run reads. So one app's run changed the next
app's report: db-v3 grew from 71,571 to 72,266 files during a corpus run.
It now writes only to `<out>/.hbc2js/sigdb`, and to the user cache only
under `--confirm-cache`. Regression tests:
`tests/gate/deps/corpus-confirm-precision.test.ts`.

### Next deps items (loss categories)

Misses (in truth, not in `confirmedDeps`) fall into three categories. The scorer
does not yet tag misses by cause, so the sizes below are by inspection.

1. **No signature in db-v3.** The large majority of misses (for example, the
   MetaMask run: 306 direct dependencies, 172 confirmed, most of the gap being
   workspace-internal packages and polyfills with no published tarball).
   Next: a monorepo-aware signature source that fingerprints packages
   from a workspace checkout (`packages/<name>`), as `deps-truth.mjs --root`
   already resolves them for truth.
2. **Proposed but not confirmed.** Real evidence below the confirmed bar
   (14 to 29 guessed and 9 to 17 hinted per ground-truth app). Next: re-examine the
   Medium/Low tier thresholds (`docs/PACKAGE-SIGNATURES.md` 5.4) against this
   real population; they were tuned on the fixture.
3. **Lost at the confirm bar.** Smallest: `--confirm` never moved recall.
   Least urgent.

Order: first make `deps-truth.mjs` tag each miss with its category;
then the workspace signature source; then the threshold re-tuning.

## Shared DB size

`tools/pkgsig/db` is ~16 MB as of this task (40 signature files + baselines,
`docs/PACKAGE-SIGNATURES.md` §5.3/§5.5) — comfortably under the ~40 MB
budget. If a single package's signature file grows unusually large (e.g. a
package that transitively re-includes a lot of code none of the three
foundation baselines cover, `docs/PACKAGE-SIGNATURES.md` §5.3's own
`@react-navigation/stack`@HBC98 example at 1.4 MB), note why in the commit
rather than silently letting the budget creep.

## Classification (D17h/D17j/D17i stage 2): library vs custom code, WITHOUT naming
Naming a dependency (package@version, everything above) is the hard, slow
problem — real recall depends on the signature DB having this exact
toolchain's builds. D17h ships a separate, easier capability: classify each
Metro module as third-party LIBRARY (ignorable) vs the app's OWN "custom"
code *without* naming the package at all. This is `src/deps/classify.ts`
(`classifyInventory`/`classifyModule`), wired additively into `runDeps`
(`DepsRunResult.classification`, `DepsReport.classification`, printed as a
headline line in `formatReportText`) — it does not touch match/guess/confirm
and can run even when the signature DB is empty.

**D17j (2026-08-31) reframed which signals are PRIMARY.** D17h's original
design leaned on cross-app recurrence against a multi-bundle "commonality
index" — real, but useless on a brand-new app the tool has never built an
index for, and (below) still weak even with one. D17j adds two signals
that work from evidence **inside a single bundle**, no corpus required, and
promotes them to primary; cross-app recurrence is kept as a bonus on top.

**Signals, in priority order:**

0. **Cross-app recurrence (bonus, D17h).** Per-*function* exact bytecode
   hash (the same hash `match.ts`'s signature DB uses, masking the Metro
   dependency-map index per `sig-normalise.ts`) looked up in a "commonality
   index" of hash -> count of DISTINCT contributing bundles, gated by a
   FLIRT-style `minInstr` floor (default 8). A module is library when a
   majority (default ≥50%) of its own instruction weight comes from
   functions whose hash recurs in ≥2 distinct bundles. Silent (never fires)
   on an empty/absent index — the normal state for a brand-new app.
1. **`node_modules`/bare package-path evidence (primary, D17j, strong).**
   A `node_modules/<pkg>/...` substring, or a bare (prefix-stripped)
   `<pkg>/lib|dist|src|.../*.js` package-relative path, in the module's own
   string constants (`libraryPathEvidence`, extracts the package name).
   `pkg@x.y.z`/`pkg vN.N.N`-shaped version-banner strings score the same
   tier (`package-name-version-string`). **Measured silent on both
   committed release fixtures** (`rn-template-0.72`,
   `react-navigation-example-0.85.3`) — Metro strips `node_modules/`-shaped
   require paths from optimised/release output, so this signal in practice
   fires mainly on `-g`/debug builds, source-mapped bundles, and libraries
   that self-embed a version banner.
2. **App-vocabulary presence (primary, D17j, the key idea).** The app's
   OWN vocabulary — derived straight from the bundle itself
   (`deriveAppVocabulary`), no cross-app corpus needed:
   - Any string independently recognisable as app-specific **by shape**,
     regardless of how often it recurs: a reverse-DNS/scoped bundle id
     (`com.example.myapp`), a `Screen`/`Route`/`Navigator`-suffixed
     identifier, an asset path, or a URL (the hostname itself is added to
     the vocabulary, not just the one concrete URL string, so a different
     path on the same host still matches).
   - Any other string that recurs across several distinct modules
     (≥3 by default) without being near-ubiquitous (≤15% of all modules) —
     the shape a shared route name, UI-copy constant, or API path prefix
     takes — **after** excluding generic JS/library boilerplate: known
     error-message shapes, and (the dominant real-world source of noise,
     found by measuring on `rn-template-0.72`) bare identifier-shaped
     tokens (`render`, `forwardRef`, `componentWillUnmount`, `__detach`,
     ...) and well-known JS/React/RN globals (`Array`, `Reflect`,
     `HermesInternal`, `Component`, ...) — these recur in nearly every
     module of nearly every bundle because they're common surface, not
     because they say anything about one particular app.
   A module whose strings hit the vocabulary is CUSTOM.
3. **Structural shape (D17j, weakest, last-checked).** ≥2 functions,
   ≤75 avg instructions/function — only consulted once app-vocabulary has
   already been ruled out for the module, so every one of its strings is
   already known not to be app-specific/vocabulary. (An earlier version
   also capped the module's raw string *count* at ≤2 on the theory that
   library modules have few strings; measured false on large bundles —
   median 16 string constants per module even in pure react-native runtime
   code — and dropped: string *content*, already vetted above, is the
   signal, not string count.)

**Combination rule:** a module is **LIBRARY** if node_modules-evidence OR
(no app-vocab AND generic structural shape); **CUSTOM** if app-vocab is
present; else **UNKNOWN** — doubt is reported honestly rather than defaulted
either way, now that app-vocabulary gives a real positive way to decide
CUSTOM. (D17h's original design defaulted "no signal" to `app`; D17j
replaces that default with `unknown` since a real positive CUSTOM signal
now exists.) Each classification also carries a `confidence` (0..1, string
evidence ~0.85-0.95, app-vocabulary scaled by how many distinct tokens
matched, structural-shape ~0.35) and a `libraryPackageHint` (the package
name extracted from node_modules/version-banner evidence, when present —
a hint only, not run through `guess.ts`/`match.ts` naming/confirmation).

**Commonality index** (`tools/pkgsig/commonality-index.json`, regenerated by
`tools/pkgsig/build-commonality-index.mjs`): hash + distinct-bundle-count
only, never bundle content or a bundle identifier — safe to commit (D16).
Built from one bundle per distinct app: the two committed open-source C3
fixtures (`rn-template-0.72`, `react-navigation-example-0.85.3`, debug/
`noopt`/`truth` build-variant copies of the same app deliberately excluded
so they don't inflate "cross-app" recurrence).

**Measured (2026-08-31): library-vs-custom % by weight, WITHOUT any
cross-app corpus** (`classifyInventory(inventory, EMPTY_COMMONALITY_INDEX)`
— i.e. D17j's primary signals alone, exactly what a brand-new app with no
commonality index gets on first run), vs. the OLD D17h recurrence-primary
number (cross-app corpus) and naming's own `percentVerifiedByWeight`:

| Bundle | HBC | naming verified-by-weight | OLD classify (cross-app corpus) | **NEW classify, corpus-free** |
|---|---|---|---|---|
| `rn-template-0.72` | 94 | 98.6% | 1.2% | **41.1%** |
| `react-navigation-example-0.85.3` | 98 | 59.8% | 1.7% | **26.5%** |

Both bundles moved up substantially, corpus-free (the old figures needed a
cross-app index; the new ones need none). `rn-template`'s jump (1.2% → 41.1%) is almost entirely
`structural-shape` (38,008 of its ~92k total instructions) — app-vocabulary
correctly stayed silent on library modules once the bare-identifier/known-
global exclusions above were added (before that fix, an earlier iteration
of app-vocabulary measured 90%+ **custom** on this bundle, i.e. it was
calling most of react-native's own runtime "custom" — fixed by
tightening `isGenericBoilerplate` rather than by loosening the signal's
reach).

**Honest false-positive-risk read.** `rn-template` is ~98.6%-library by
naming ground truth, so its measured 41.1%-library / ~53%-custom split
means roughly half the bundle is still library code labelled CUSTOM by this
signal set — the residual, known cause is `SCREEN_OR_ROUTE_RE`
(`Screen`/`Route`/`Navigator`-suffixed identifiers): real for an app's own
screen components, but react-navigation's *own internal* type/prop names
use the identical shape (`StackNavigator`, `NavigationRoute`, ...), so a
navigation-heavy bundle's own library code gets mistaken for app vocabulary
by the very heuristic meant to find it. This is the direction D17h always
considered safe to be wrong in (library code showing up as "custom" only
means an analyst reviews a bit more code, never that real app code goes
missing) — the reverse (real app code called LIBRARY) risks silently
hiding something real, and neither node_modules-path nor structural-shape
can ever fire on a module app-vocabulary already claimed, by construction
of the combination rule — but it does mean the corpus-free "% library"
number above should be read as a **floor**, not a ceiling: real
library-vs-custom precision needs either the bonus cross-app-recurrence
signal (which subsumes this case correctly since react-navigation's own
code, being byte-identical across the apps that ship it, recurs) or a
tighter app-vocabulary/screen-name heuristic — noted here rather than
chased further under this task's time box.

**Stage 3** (naming the classified-library modules, D17i point 3) can now
scope its work to exactly the modules this stage marks `library` — the
`guess`/`confirm` machinery already exists (`src/deps/guess.ts`/
`confirm.ts`); what it needs next is to be pointed at
`classification.modules.filter(m => m.classification === "library")`
instead of match's `unattributedModules`.

## Contributing a signature upstream

A project-local DB uses the exact same file format as the shared one. To
promote a `--confirm`-produced signature: copy
`<out>/.hbc2js/sigdb/<pkg>@<version>__hbc<N>.json` into `tools/pkgsig/db/`
(or run `hbc2js deps --confirm --sigdb tools/pkgsig/db <bundle>` directly
against it) — but **only for public npm package code**. Never copy anything
whose provenance traces back to an application.s own (non-npm) code.

## Adding a vendor module to the native-module hint registry

`NATIVE_MODULE_TO_PACKAGE` (`src/deps/native-modules.ts`) is the curated
`NativeModules.X`/`TurboModuleRegistry.get('X')` name -> npm package map the
guess stage's strongest single clue (0.75 evidence weight, §"Guess" above)
depends on. It is hand-curated, not derived from any signature DB, and not
exhaustive by design -- extend it whenever a real native module is found
missing. To add one:

1. Find the module's real bridge-registered name. This is the string its
   native side's `getName()` (Android) or `RCT_EXPORT_MODULE()`/explicit
   name argument (iOS) returns -- **not** the class name, and not always the
   package's own npm name. Get it from the package's own public source (its
   Android `getName()` method or iOS `RCT_EXPORT_MODULE`), or, for a
   specific app under investigation, from that app's own decoded APK
   (`apktool d`, then the `getName()` method body of the matching
   `*Module.smali`/`*ViewManager.smali` file) -- **never commit the decoded
   APK or any bundle-specific string extracted from it**; only the resulting
   generic `name -> package` mapping (independently true for every app using
   that package, not specific to the one that prompted the search) belongs
   in this file, exactly like every existing entry.
2. Add one `Name: "npm-package-name"` line to `NATIVE_MODULE_TO_PACKAGE`, in
   the thematic cluster it fits (or a new one), with a one-line comment
   citing how it was verified if it's not obvious from the name.
3. A package can register more than one bridge name (a `NativeModule` and
   one or more `ViewManager`s, or a different name per platform) -- map
   every name variant you find to the same package; duplicate keys pointing
   at the same value are fine and expected (see `RNDateTimePicker`/
   `RNDatePicker`, or `RNBiometrics`/`ReactNativeBiometrics` below).
4. Add or extend a `tests/gate/deps/*.test.ts` case asserting the new
   entries (`tests/gate/deps/native-modules-registry.test.ts` is a template).
   A registry change with no test is a silent, unverifiable claim.
5. Never delete an existing entry on a hunch that it's wrong -- if real
   evidence contradicts it (as `RNBiometrics` was, below), add the corrected
   entry alongside it and record which one the evidence actually supports,
   rather than guessing and removing.

### Inventory hash audit
`src/deps/inventory.ts`'s `InventoryModule.exactHash`/`fuzzyHash`/
`factoryStringSetHash` cover only the module's own FACTORY function, never
its nested closures (a Metro factory is very often just
`module.exports = function X(...) {...}` — the interesting logic lives in
the nested closure `X`, not the factory's own bytecode). Fixed:

- `InventoryModule` gained `factoryOnly: true` (a first-class marker on the
  three factory-only fields, not just a doc comment) and `fuzzyHashSet` (a
  new whole-function-set fuzzy hash, the fuzzy-tier analogue of the
  already-whole-set `stringSetHash`/`SigModule.functionSetHash`). Neither
  field changes what any EXISTING field computes — both are additive, so no
  shipped sigdb input changed.
- `seams.ts`'s local `fuzzySetOf` helper (recomputed the same thing by hand
  every call) was deleted; `tierOf` now compares `fuzzyHashSet` directly,
  the same single-hash-equality shape `stringSetHash`'s "exact" tier
  already used. Behaviour unchanged — `tests/gate/tooling/seams.test.ts`
  stays green.

**Consumer audit — every matching path in `src/deps/**`/`tools/pkgsig/**`
that reads `InventoryModule.exactHash`/`.fuzzyHash`/`.factoryStringSetHash`
or `SigModule.factoryExactHash`/`.factoryFuzzyHash`:**

| Path | Trusts a factory-only hash ALONE? | Wrong identification observed on rn-template? |
| --- | --- | --- |
| `src/deps/match.ts` `scorePackage` (`moduleExactHits`, package-level tier) | Factory-only, but gated by `isUnambiguous`/`hashOwnerNames` (>=20 distinct owners excluded) AND combined with function-level exact/fuzzy coverage across the WHOLE package before a tier is assigned — never alone. | No. `confirmedDeps` on rn-template is exactly `{react, react-native}`, matching the fixture's known ground truth (docs/DEPS.md `## Ground truth (D17d)`). |
| `src/deps/confirm.ts` `subtractBaseline` (`factoryIsBaseline` flag) | Factory-only, but this is a "is this factory a KNOWN TOOLCHAIN BOILERPLATE wrapper" flag, not a third-party package identification — a different, lower-risk semantic (the module is kept either way, never dropped or attributed to a package by this). | N/A — not a package-identification path. |
| `src/deps/confirm.ts` `computeBaselineHashes`, `tools/pkgsig/bulk/baseline-subtract.mjs` | No — whole per-function set (`SigFunction.exactHash`), not module/factory-scoped. | N/A |
| `src/deps/classify.ts` (`functionHashesForCommonality`, `classifyModule`'s `ModuleFunctionSample`) | No — whole per-function set via `ModuleInventory.functions`/`functionIndices`, library-vs-custom classification never reads `InventoryModule.exactHash`/`.fuzzyHash`/`.factoryStringSetHash` directly. | N/A |
| `src/deps/guess.ts`, `src/deps/db.ts`, `src/deps/dscan.ts` | No — no reference to these three fields at all. | N/A |
| `tools/pkgsig/d17f-build-exact-db.mjs` | Delegates to `confirm.ts` (above); no direct use. | N/A |

Held-out fixture (`tests/fixtures/bundles/react-navigation-example-0.85.3`)
was not run for the ORIGINAL 2026-09-18 audit that opened this row (it
requires `fetch.sh`'s network clone + `pnpm install` + `expo export`, out of
scope for that audit) — it IS now measured, by G4b, as part of
resolving this row (see the table row above): the fixture's own committed
`.hbc` is what exposed e7c83bfa's real bug in the first place.

**Follow-up: RESOLVED, see the table row above (G4c, 2026-09-28, correcting
G4b's own threshold the same day).**

### Guess stage on the held-out app

The D17a guess/confirm design
proposed 0 candidates on `react-navigation-example.hbc` (release), against
65 truth packages left unconfirmed. Diagnosed with `deps-truth.json` as
oracle before changing anything (a throwaway analysis script, not
committed): of the 65, **25 have every one of their truth modules already
attributed to a DIFFERENT package by the match stage** (the G4-series
factory-hash-collision problem documented above, e.g.
`react-native-gesture-handler`'s modules being claimed by
`@react-navigation/stack`) — `guess.ts` never sees these at all, since it
only scans `matchReport.unattributedModules`; this is the match stage's own
open problem, not the guess stage's, and out of scope here. The remaining
**40 have at least one genuinely unattributed module.** Of those 40, before
this fix, `guess.ts`'s four clue sources (native-module name, URL/API host,
package-name string, dependency edge) produced a package-level candidate
for only 2: `react-native-pager-view` (native-module `RNCViewPager`,
already curated) and `react-native-worklets` (a real db-match at `medium`
tier, but a single evidence kind, so suppressed — see below). Root causes
for the other 38, checked directly against their own bundle content:

1. **Bug, fixed this landing:** the curated `NATIVE_MODULE_TO_PACKAGE` map
   (`src/deps/native-modules.ts`) had zero entries for the Expo SDK, despite
   Expo being one of the most common RN toolchains and this fixture being an
   Expo app. Nine names — `ExpoFetchModule`, `ExpoAsset`, `ExpoBlurView`/
   `ExpoBlurTargetView`, `ExponentConstants`, `ExpoFontLoader`/
   `ExpoFontUtils`, `ExpoLinking`, `ExpoSplashScreen` — were observed live in
   the fixture's own release `.hbc`, each co-located in the same small
   factory function as a `requireNativeModule`/`requireOptionalNativeModule`/
   `requireNativeViewManager` call (not just a string that happens to match),
   and are independently verifiable against each package's own public
   source. Added (`tests/gate/deps/native-modules-registry.test.ts`, new
   test). Measured effect: `hinted` 1 -> 6 packages (all still 100%
   precision), and because `expo`'s and `expo-font`'s own factory functions
   ALSO separately carry a bare `"expo"`/`"expo-font"` string literal
   (`package-name-string`, a second independent evidence kind, since a
   package's own name now being in `NATIVE_MODULE_TO_PACKAGE.values()`
   automatically makes it `package-name-string`-eligible too, `guess.ts`'s
   `CURATED_PACKAGE_NAMES`), those two packages cleared the report's
   "≥2 independent kinds" precision bar and reached the actual `guessed`
   tier: **`guessed` 0 -> 2 reported, precision 100.0% (unchanged),
   recall-of-remaining 0.0% -> 3.1%** (measured via
   `HBC2JS_TIER=sweep node --test tests/sweep/deps/truth-react-navigation.test.ts`,
   both the release and debug `.hbc` variants). `confirmed`-tier precision
   and recall are untouched (still 10 reported, 100%, 13.3%/16.7%).
2. **Design limit, not fixed:** `matchReport.packages` (the loaded
   signature DB) has only 16 entries on this fixture — no signature file
   exists at all for `expo-modules-core`, any `@tanstack/*`,
   `react-native-tab-view`, most of `@react-navigation/*`'s own
   sub-packages, `react-native-drawer-layout`, `semver`,
   `@ungap/structured-clone`, `@expo/react-native-action-sheet`, any
   `@react-native-vector-icons/*`, any `@expo-google-fonts/*`, or a dozen
   smaller transitive packages (`invariant`, `nullthrows`, `hoist-non-react-statics`,
   `@babel/runtime`, `react-is`, `nanoid`, `use-latest-callback`, `warn-once`,
   `query-string`, `decode-uri-component`, `filter-obj`, `split-on-first`,
   `fast-deep-equal`, `escape-string-regexp`, `use-sync-external-store`,
   `react-freeze`, `standard-navigation`, `whatwg-url-minimum`,
   `abort-controller`). `db-match` evidence is structurally unavailable for
   an unfingerprinted package; growing signature DB coverage is separate,
   ongoing fingerprinting work (`tools/pkgsig/**`), not a guess-stage bug.
   These packages are also pure-JS with no native module, no known curated
   URL host, and — checked directly — no bare literal matching their own
   package name anywhere in their own unattributed modules, so no clue
   source in `guess.ts`'s current vocabulary can name them without either a
   DB fingerprint or a new heuristic broad enough to collide constantly
   (e.g. treating any bare kebab-case-shaped string as a package-name guess
   on its own — already deliberately rejected: `PACKAGE_NAME_LIKE` seeds an
   npm-search query only, never a standalone candidate, precisely because it
   is not specific enough). A generic shared helper (a Babel helper,
   `regenerator-runtime`, a polyfill) is this same limit's sibling case: it
   is evidence of nothing package-specific by construction, not a missed
   heuristic.
3. **Design limit, not fixed:** the `dependency-edge` clue actively
   misfires on this fixture's `@react-navigation/*` family — e.g. module
   1130 (`@react-navigation/routers`) guesses `@react-navigation/native`
   because all 3 of its identified dependencies happen to already be
   claimed by `native` (a real G4-series factory-hash collision, not a
   coincidence). These wrong guesses never reach the report because
   `report.ts`'s `addGuess` silently drops any candidate whose package name
   is already in `confirmedDeps` — which every one of these mis-pointed
   edges happens to be here — so today's 100% guessed-tier precision is
   partly a lucky byproduct of that filter, not proof the clue is sound for
   a tightly-coupled monorepo family. Recorded here rather than patched:
   the correct fix is on the match-stage collision this rides on (the G4
   table row above), not a guess-stage heuristic.

Regression test: `tests/gate/deps/native-modules-registry.test.ts`'s new
"2026-09-28 J2 audit" case (fails before the `native-modules.ts` change,
passes after — the nine names resolved to `undefined` beforehand). No
change to `src/deps/guess.ts` or `src/deps/report.ts` was needed or made —
the whole fix is the curated map, per D17a's own design (a specific,
verifiable name is evidence; a generic one is not).

### Where dependency recall is actually lost
Three items in a row concluded that dependency recall was capped by
signature-DB coverage. J2 saw only 16 signature entries load. J7 measured a
0.0 blind-vs-informed gap and named coverage as the lever. J4 then BUILT the
coverage - 2,159 packages, 71,300 dependency-subtracted signature files - and
recall did not move at all.

`tools/deps/candidate-coverage-probe.mjs` separates the two questions those
items conflated, per truth package: is a signature present in the loaded DB at
all, and did the package ever become a match CANDIDATE. On rn-template's
RELEASE build `index.android.hbc` against its committed truth file:

| | count |
|---|---|
| DB universe (J4's v2 build) | 2,161 packages |
| candidates actually derived | 88 |
| truth packages | 20 |
| **present in the DB universe** | **18 of 20** |
| of those, became candidates | 7 |
| **in the DB but never proposed as a candidate** | **11** |
| genuinely absent from the DB | **2** (`@babel/runtime`, `@react-native/assets-registry`) |

The 11 never proposed: `nullthrows`, `stacktrace-parser`,
`regenerator-runtime`, `event-target-shim`, `base64-js`, `whatwg-fetch`,
`abort-controller`, `@react-native/normalize-colors`, `memoize-one`,
`@react-native/virtualized-lists`, `use-sync-external-store`.

**So candidate derivation loses 11 packages where missing coverage loses 2.**
That is the number the J-lane was missing, and it is why building more
coverage changed nothing: `src/deps/candidates.ts` only proposes a package
whose NAME appears literally in the bundle text, and a minified release bundle
does not contain the string "base64-js" anywhere.

**The fix direction, designed but NOT implemented.** J4's v2 signature files
record each package's own npm dependencies in `subtractedDependencies`. So
once a package IS literally evidenced (react-native always is), its recorded
dependencies can be added as candidates with no string evidence of their own
names at all - which is exactly the set of 11 above. A test encoding this was
drafted against `deriveCandidatePackages` but the implementation was never
written, so **nothing here is landed and the 11 are still unproposed**.

**The constraint that makes this non-trivial, and the reason it is not a
one-liner:** confirmed-tier precision is 100% today and expanding the candidate
set is exactly how that gets lost. Adding a package's declared dependencies as
candidates is defensible because the dependency edge is recorded fact rather
than a guess, but every added candidate is another chance for a
factory-hash collision to be scored - and a contaminated signature once turned
a clean 2-dependency report into 134 confirmed with 133 false
(`tools/pkgsig/filter-unsubtracted.mjs`). Any landing here must report
precision alongside recall on both truth fixtures.

**LANDED (2026-09-29, closes the item above).** `deriveCandidatePackages`
now does exactly the one-level expansion described above: after the literal
string-evidence pass (before scope-prefix corroboration runs, so this never
stacks two inference steps), every DIRECTLY-evidenced package's own
`subtractedDependencies` are read (only the small number of on-disk
signature files whose OWN filename already names that package - never a
directory-wide scan) and their package names are added as candidates too.
`tools/deps/candidate-coverage-probe.mjs` had a broken relative import
(`./src/deps/...` from `tools/deps/`, resolving to a nonexistent
`tools/deps/src/`) - fixed in the same commit; it now reproduces the
baseline above exactly, confirming the fix, not just the diagnostic, is
correct.

Measured on both truth fixtures, release builds only (`index.android.hbc`,
`react-navigation-example.hbc` - never the `.debug.hbc` variant):

| | rn-template-0.72 `index.android.hbc` | react-navigation-example-0.85.3 `react-navigation-example.hbc` |
|---|---|---|
| candidates derived, before -> after | 88 -> 131 | 124 -> 213 |
| truth packages in DB that became a candidate, before -> after | 7/18 -> 18/18 (all 11 recovered) | 20/46 -> 35/46 (15 of 26 recovered; 11 remain unproposed, listed below - none are recorded dependencies of a directly-evidenced package on this bundle) |
| confirmed count, before -> after | 2 -> 2 (unchanged) | 10 -> 12 (`whatwg-url-minimum`, `hoist-non-react-statics` newly confirmed) |
| confirmed-tier precision, before -> after | 100% -> 100% (`falsePositives: []` both) | 100% -> 100% (`falsePositives: []` both) |
| recall-of-all / recall-of-direct, before -> after | 10.0%/100.0% -> 10.0%/100.0% (unchanged) | 13.3%/16.7% -> 16.0%/20.0% |
| probe: in DB but never proposed, before -> after | 11 -> 0 | 26 -> 11 (`react-is`, `query-string`, `decode-uri-component`, `fast-deep-equal`, `escape-string-regexp`, `expo-status-bar`, `expo-blur`, `react-native-pager-view`, `@tanstack/react-query`, `@tanstack/query-core`, `standard-navigation`) |

Acceptance was "recall rises on at least one fixture with precision still
100% on both" - satisfied on react-navigation-example, unchanged (not
regressed) on rn-template. rn-template's own confirmed/recall did not move
even though all 18 of its in-DB truth packages are now candidates: getting
loaded and scored is necessary but not sufficient for the match stage's own
confirm threshold (S1-S4), which this task did not touch. **Also verified
directly, unaffected:** the six rn-template `own(P)` boundary modules
(`react` 6-boundary, `react-native` 17-boundary, both already failing S2 for
an unrelated multi-entry reason) produce byte-identical `hbc2js export
--substitute safe --json` `unresolved`/`counts` output before and after this
change; the held-out fixture's `substitutedPackages` count is also unchanged
(0 -> 0 on this worktree's current baseline, which does not match the 1
this doc's G4d entry measured earlier - a pre-existing drift already
flagged there, not caused by this landing) with one additional
`ambiguous-owner` informational row (3 -> 4, purely transparency, since
loading more signatures gives the ambiguity check more claimants to
report - it never gates `substitutedPackages`).

Regression test: `tests/gate/deps/candidates.test.ts` "CAND: deriveCandidatePackages
adds a literally-evidenced package's own recorded npm dependencies
(subtractedDependencies) as candidates, even with zero string evidence of
the dependency's own name" - a synthetic 3-file signature DB (host, leaf
dependency, unrelated package) proving the leaf becomes a candidate and the
unrelated package does not.

**The 3.1% is NOT independent evidence, and the holdout is partly spent.** The nine Expo names were found by inspecting
the held-out app's own bundle and were then measured on that same app, so
this landing tuned the curated registry on the holdout and reported the
improvement against it. That is the same circularity J4's acceptance criteria rule out (the fingerprint population must be chosen
independently of the truth files; "the held-out react-navigation app is the
genuine holdout: its truth file is never used to choose the population").
Precision is not at risk here — the nine mappings are real Expo SDK facts,
verifiable from each package's own source, and would be correct on any app —
but `guessed` 0 -> 2 and `hinted` 1 -> 6 measure *coverage that was copied
off the measuring stick*, not a heuristic that generalises. Two consequences
to respect downstream:
- Do not quote 3.1% recall-of-remaining as a generalisation result, and do
  not use it as the J2 baseline that J4/J7 improve on. The honest baseline
  for native-module-hint coverage is "unknown until measured on an app whose
  contents did not choose the registry".
- To make it independent, populate `NATIVE_MODULE_TO_PACKAGE`'s Expo entries
  from Expo's own published module names (the SDK's packages each declare
  their native module name in their own source) with no fixture consulted,
  then re-measure this fixture. That is follow-up work, not done here.
This does not argue for reverting the entries: a curated registry SHOULD
know the Expo SDK, and finding the gap via the fixture is a legitimate way
to notice it. It argues only that the resulting number is not a measurement.

#### Why exact-version signatures miss
The v2 DB holds the exact truth version at hbc94 for the refused packages of
rn-template's RELEASE `truth/index.android.hbc` (RN 0.72.17), yet they score
0 exact / ~0 fuzzy hits. Probe: `tools/deps/sig-mismatch-probe.mjs` (usage
in its header; `--bundle index.android.bundle --hermesc tools/hermesc/v94/hermesc`
recompiles each package's own modules, cut verbatim from the app's Metro
bundle, as a small standalone bundle - a stand-in for the bulk scaffold).
Two compounding causes, both in how signatures are BUILT, not in matching:

1. **Operand-width opcodes are bundle-context dependent (cause c).** Hermes
   picks `GetByIdShort`/`PutNewOwnByIdShort` (8-bit string id) vs
   `GetById`/`PutNewOwnById` (16-bit) - and `*Long`/`*LongIndex` above that -
   from the string/function TABLE INDEX, i.e. from how big the whole bundle
   is. The mnemonic is in both the exact and the fuzzy hash, so the same
   source compiled in the ~80-module scaffold and in a 435-module app hashes
   differently on both tiers. Evidence on `truth/index.android.hbc`: the small
   recompile reproduces the signature residual (regenerator-runtime 21/22,
   whatwg-fetch 36/37, event-target-shim 24/25, deprecated-rn-prop-types
   11/14; the unreproduced one is the scaffold's `global`), so source and
   flags agree ((a),(b),(e) ruled out for these); the paired app function
   has the same instruction count and string set, and the ONLY opcode
   differences are `GetByIdShort->GetById` / `PutNewOwnByIdShort->PutNewOwnById`
   (regenerator's 209-instr IIFE: 4 + 7). Across the 16 packages the app's
   functions matching the small compile go **344 -> 629 of 630** when width
   variants are folded to one mnemonic (jump `*Long` left alone).
2. **Baseline subtraction removes exactly the functions that match (cause d).**
   The `react-native-foundation@0.72.17` baseline is an RN app bundle, so it
   already contains RN's own npm dependencies. Every width-STABLE function of
   those packages hashes identically in scaffold and foundation and is
   subtracted; only width-SENSITIVE ones survive (regenerator 126 raw -> 22).
   The residual is therefore precisely the set guaranteed not to match an
   app of RN size. On `truth/index.android.hbc`, 100% of the app's functions
   are in the baseline union for 14/16 packages (normalize-colors 11/14,
   virtualized-lists 245/250).

Per-cause, 16 refused packages on `truth/index.android.hbc` (react-native
itself excluded): (d) all 16; (c) explains the surviving residual for 9
(stacktrace-parser, regenerator, event-target-shim, base64-js, whatwg-fetch,
normalize-colors, deprecated-rn-prop-types, prop-types, memoize-one); 5 have
no package function left at all (invariant, nullthrows, abort-controller,
use-sync-external-store: residual = scaffold global/entry only; react: 0 of
131); (a) wrong entry for 1: promise's signature is `require("promise")` ->
`lib/*` (11 modules) while RN imports `promise/setimmediate/*` (3 modules),
6/48 reproduced, 13 fuzzy-only hits are the near-identical lib twins;
virtualized-lists' scaffold pulls in all of react-native (4,165 raw), its
residual is RN-context noise (1/27 reproduced). (b) and (e): 0.

**Recommended fix (two parts, both needed).** (1) Fold operand-width
variants in `sig-normalise.ts`/`fingerprint.ts` exact and fuzzy text (a
sigdb format change: bump schema, `--refingerprint` the DB from its
hbc-cache on a build host). Alone it moves rn-template ~0 - folded residuals collapse
INTO the baseline - but it fixes ~45% of functions (286/630 here) that
currently cannot match any large app for every package. (2) Subtract from a
package only functions the baseline owns through a DIFFERENT package (the
foundation build's module->package attribution), or keep foundation-shared
functions flagged, like `factoryIsBaseline`, as matchable evidence. With
both, 15 of the 16 should carry full exact coverage (promise also needs
sub-path entries, e.g. every `exports`/file the foundation imports).
Confidence high for (c)/(d) (reproduced offline); recall movement projected.

#### Hash scheme 2: width folding + ownership-aware subtraction
**Design.** (1) `sig-normalise.ts` `foldOperandWidth` drops a `Short` /
`Long` / `LongIndex` suffix (Hermes' own MIT `BytecodeList.def` naming) from
every opcode WITHOUT an `addr` operand, in both the exact and fuzzy text; jump
`*Long` variants stay (their width is the function-local jump distance). The
operand values those widths encode are table indices and never entered the
hash. (2) `build-baselines.mjs` now records `owner` per baseline function
(Metro source map -> `__d()` module -> npm package, `truthFromMap`, which
learned Metro's INDEX maps and multi-line modules for RN 0.87;
`baseline-owners.ts` spreads a module's owner over every closure it creates).
`subtractBaseline` (both `confirm.ts` and the bulk twin) keeps a baseline
function only when EVERY recorded owner is the package being fingerprinted;
another package's, unowned (polyfills, global, pre-LB1 baselines) or
two-owner functions are subtracted exactly as before. Chosen over "keep
shared functions flagged as matchable evidence" because a flag keeps the RN
polyfills/runtime that every scaffold contains, and those would match every
RN app for every package; ownership keeps only code the foundation itself
attributes to that package, so the only new evidence is the package's own
code. (3) Format: `SigDbFile.hashScheme: 2`. `loadSignatures` drops a
package's scheme-1 entries once any scheme-2 entry of it is loaded (J4-style,
applied before J4's rule); scheme-1 files of OTHER packages still load but
are scored only against the target's scheme-1 hashes (`FingerprintResult.
legacyExactHashes`, "1:"-prefixed keys in every `match.ts` map). A plain
union of both schemes was tried first and measured WRONG: scheme-1 files
still hold width-shifted copies of RN code their scheme-1 baselines could not
subtract, and folded target hashes matched them (stack / gesture-handler /
reanimated "confirmed" on rn-template - caught by `robustness.test.ts`).
The sqlite layer has no scheme column yet and refuses scheme-2 writes; the
commonality index is version 3 (a version-2 index loads empty). The
committed shared DB (`tools/pkgsig/db`, scheme 1, v1) is left as is: its
22 entries are exactly the bulk entries with NO compiled `.hbc` in the build host's
`hbc-cache` (built before the cache existed), so they cannot be
re-fingerprinted offline; under the per-package supersede rule a scheme-2
DB hides them wherever it has another version of the package.

**Measured** (a build host; candidate-closure DB: every hbc-cache version of every
blind candidate of both fixtures plus their npm dependency closure, 644 hbc94
+ 1068 hbc98 files, `tools/deps/lb1-candidate-closure.mjs`, then J4
`dep-subtract.mjs` offline; before = the v2 bulk DB; both runs also load the
committed shared DB; scored by `scoreAgainstTruth`; ceiling = truth package
with a signature at that HBC version AND derived as a candidate):

| bundle | confirmed | falsePositives | recall all / direct | ceiling | bar losses |
|---|---|---|---|---|---|
| rn-template `index.android.hbc`, before | 2 | [] | 10.0% / 100% | 18/20 | 16 |
| rn-template `index.android.hbc`, after | 13 | [] | 65.0% / 100% | 18/20 | 5 (invariant, nullthrows, scheduler, memoize-one, use-sync-external-store) |
| rn-template `index.android.debug.hbc`, after | 11 | [] | 55.0% / 100% | 18/20 | 7 |
| react-navigation-example.hbc, before | 12 | [] | 16.0% / 20.0% | 33/75 | 21 |
| react-navigation-example.hbc, after | 15 | ["event-target-shim"] | 18.7% / 23.3% | 32/75 | 18 |

The one "false positive" is a TRUTH defect, not a signature one:
`event-target-shim` IS in the held-out app (module 206,
`node_modules/event-target-shim/dist/event-target-shim.mjs`, pulled in by
`abort-controller`), but the committed `deps-truth.json` was generated by the
pre-fix `truthFromMap`, which skipped the 8 multi-line `__d()` modules; the
fixed generator adds exactly those 8 modules and one package,
`event-target-shim` (docs/BUGS.md). Against corrected truth the held-out run
is 15/15 correct, recall 19.7% (before 15.8%). The held-out app loses 3
packages it had (react-native-gesture-handler, react-native-screens,
react-native-safe-area-context): their matching versions (3.0.2 / 4.26.2 /
5.7.0) are among the 22 with no compiled `.hbc`, so the partial scheme-2 DB
supersedes them - a rollout gotcha, not a matching one: a package must be
re-fingerprinted for all its versions or none. The six rn-template modules
(152/192/223/225/414/429) attribute to `react`, `ambiguousOwnerHash` false,
identically before and after under this DB (their G4 refusal is measured
against the committed shared DB, which this change leaves on scheme 1).
Full-DB refingerprint: build owner baselines per (scaffold, hbc) with
`build-baselines.mjs`, then `build-one.mjs ... --refingerprint` over every
hbc-cache entry (1,712 jobs took 29 s at `xargs -P 30`, so ~71.5k is ~20 min
on a build host), then `dep-subtract.mjs <raw> <out> --cache-dir <dep-cache>` (no
registry fetches for these packages: 0 dep-cache misses).

#### Scheme-2 rollout
The whole bulk DB was re-fingerprinted under hash scheme 2 on a build host into
`db-v3` (28 GB, 71,571 files; `db-v3-raw` is the pre-J4 twin,
`db-v2` and `db` were not touched). Steps and numbers:

1. **Gap fill.** The committed shared DB has 40 package entries; **21** of
   them (not 22: the earlier count included a baseline) had no compiled
   `.hbc` in `hbc-cache` (`@react-navigation/{material-top-tabs 8.0.0-alpha.49,
   native 8.0.0-alpha.44, stack 6.4.1 x2 + 8.0.0-alpha.53}`, `@reduxjs/toolkit
   1.9.7` x2, `axios 1.20.0` x2, `immer 10.2.0` x2, `react-native-gesture-handler
   2.32.0` x2 + 3.0.2, `react-native-reanimated 4.5.3`, `react-native-safe-area-context
   5.7.0`, `react-native-screens 4.26.2`, `react-redux 8.1.3` x2, `zustand 4.5.7`
   x2). Built with `build-one.mjs` (non-refingerprint, 8 scaffold-slot
   copies, registry `npm install`): 14 first time, **7 failed for two build-one
   limitations** and were rebuilt with a scratch variant (uncommitted) that
   (a) appends the package's peer dependencies to the `npm install` line
   (`build-one` uses `--legacy-peer-deps`, so `@react-navigation/native`,
   `react-native-worklets` etc. are never installed and Metro cannot resolve
   them: `@react-navigation/stack` x3, `material-top-tabs`, `reanimated`) and
   (b) raises hermesc's `spawnSync` `maxBuffer` (axios x2 died with
   `ENOBUFS`). All 21 then compiled and are in `hbc-cache`. **Follow-up:
   build-one should take these two fixes**; until then any peer-heavy package
   is a silent hole in a from-scratch rebuild.
2. **Refingerprint.** Baselines rebuilt (owner-annotated, 4 x 3 files, from
   scaffold-slot copies). 71,571 `hbc-cache` jobs, `xargs -P 30`: 71,542 ok
   and 29 failed on the first pass, all `timed out waiting for index lock`
   (contention on `db-v3-raw/.index.lock`); the 29 were re-run serially, all
   ok, so **71,571 / 71,571 ok**. Wall time was **80 min, not the ~20 min
   estimated** (heavy host load; the 1,712-job measurement
   did not scale linearly). `dep-subtract.mjs` (copy of `dep-cache`): 186 s,
   22,278 packages, 71,571 files written, 21,430 skipped (no dependencies),
   1,121 unresolved dependency edges over 731 package@versions (mostly `npm:`
   aliases and range misses; those files are written with the dependencies
   that DID resolve). 103 `dep-cache` entries were fetched from the registry
   (the registry cost of the 21 gap packages' closure).
3. **Truth.** `tools/deps-truth.mjs` `truthFromMap` (fixed) was re-run on the
   held-out fixture's source map (the fixture's map + bundle are the only
   inputs; the original workspace tree is gone). It adds modules 54, 206, 231,
   249, 1108, 1166, 1262, 1281 (1773 -> 1781) and exactly one package,
   `event-target-shim` (75 -> 76). `react-native-drawer-layout` / `-tab-view`
   and the 10 `@react-navigation/*` workspace packages are unchanged.
   `versions`, `direct` (null) and `transitiveOf` are package.json-derived and
   cannot be recomputed from a map alone: they are carried over from the old
   file, plus one hand-added edge, `event-target-shim` <- `abort-controller`
   (abort-controller declares it as a dependency). The old file is kept as
   `deps-truth.pre-sigfix.json` beside it (both gitignored).
   **rn-template's truth was NOT regenerated**: its source map is not on disk
   anywhere and rebuilding it from the registry gives different transitive
   versions and a different `.hbc` sha (its BUILD.md); the file is unchanged
   and its 20 packages carry no multi-line-module gap that any measurement
   has exposed (0 false positives, below).
4. **Measured** (a build host, `XDG_CACHE_HOME` -> `db-v3`, blind `runDeps` +
   `scoreAgainstTruth`, sha pins matched; ceiling = truth package with a
   signature at that HBC version AND derived as a candidate):

| bundle | confirmed | falsePositives | recall all / direct | ceiling | bar losses | no signature | in DB, never a candidate |
|---|---|---|---|---|---|---|---|
| rn-template `index.android.hbc` | 13 | [] | 65.0% / 100% | 18/20 | 5 (invariant, nullthrows, scheduler, memoize-one, use-sync-external-store) | 2 | 0 |
| rn-template `index.android.debug.hbc` | 11 | [] | 55.0% / 100% | 18/20 | 7 (the 5 + promise, abort-controller) | 2 | 0 |
| react-navigation-example.hbc, NEW truth (76) | 15 | [] | 19.7% / 23.3% | 34/76 | 19 | 31 | 11 |
| react-navigation-example.debug.hbc, NEW truth | 15 | [] | 19.7% / 23.3% | 34/76 | 19 | 31 | 11 |
| react-navigation-example.hbc, OLD truth (75) | 15 | ["event-target-shim"] | 18.7% / 23.3% | 33/75 | 19 | 31 | 11 |

   Held-out bar losses: react-native-gesture-handler, invariant,
   @react-native/normalize-colors, nullthrows, stacktrace-parser, promise,
   base64-js, @react-native/virtualized-lists, memoize-one, react-native-worklets,
   react-native-is-edge-to-edge, @react-native-async-storage/async-storage,
   @react-navigation/core, @react-navigation/routers, nanoid,
   react-native-safe-area-context, use-sync-external-store,
   react-native-screens, react-freeze. In the DB but never a candidate: react-is,
   query-string, decode-uri-component, fast-deep-equal, escape-string-regexp,
   expo-status-bar, expo-blur, react-native-pager-view, @tanstack/react-query,
   @tanstack/query-core, standard-navigation. Against the corrected truth
   the held-out run is 15/15 correct. The full-DB numbers equal the
   candidate-closure numbers of the table above (confirmed 13 / 11 / 15), so
   the closure was a faithful stand-in; the 3 packages the partial DB lost
   (gesture-handler, screens, safe-area-context) are back as candidates
   (ceiling 32 -> 34, +event-target-shim) but still lose at the confirm bar,
   which is the next lever, not coverage. Extraction side:
   `hbc2js export --substitute safe` on the held-out release file substitutes
   **4** packages (flow-enums-runtime, regenerator-runtime, scheduler,
   whatwg-fetch; 2m28 on a build host).

**BUILDONE1 (fix for the two build-one holes above).** `build-one.mjs` now takes
its npm/`maxBuffer` decisions from `tools/pkgsig/bulk/install-plan.mjs`: strict
`npm install --ignore-scripts` first (installs peer dependencies), and
`--legacy-peer-deps` only as a fallback when strict resolution fails -- the same
policy as `confirm.ts installCandidate`, chosen over the scratch variant's
explicit-peer-list env var because it needs no per-package knowledge. All piped
children (npm, metro, hermesc) get a 1 GiB `maxBuffer` (axios `ENOBUFS`). Verified
on a build host (hbc98, fresh ScaffoldRN87 copy): `@react-navigation/stack 6.4.1` and
`axios 1.20.0` both build ok. Residual: a package whose strict install fails
still loses its peers via the fallback. Tests: `tests/gate/deps/buildone.test.ts`.

### Informed confirm mode (`hbc2js deps --known`)

A blind-vs-informed benchmark compares: BLIND is today's `hbc2js deps` (no candidate list given);
INFORMED is given the app's own true candidate list (names + versions, from
a package.json or lockfile — never the truth/oracle file used to score it)
and only has to CONFIRM each one. Two premises were checked before building
anything.

**Premise 1 (cached tarball set) — moot, see premise 2.** Premise 2 made a
tarball cache unnecessary for what's actually deliverable offline (below),
so no tarball-caching fixture prep was done.

**Premise 2 (ordering inversion) — CONFIRMED, worse than suspected, and is
this item's headline finding.** `src/deps/confirm.ts`'s existing `--confirm`
stage (D17a stage 4) does NOT literally read J4's bulk signature DB — it
fingerprints a candidate fresh, on demand, every run. But it is structurally
incapable of running offline at this fixture's scale regardless: `installCandidate`
and `ensureScratchProject` (`src/deps/confirm.ts`) call bare `npm install`
with no injectable local registry/cache — confirming ONE candidate needs a
full scratch RN scaffold (`react-native@<version>`, `@react-native-community/cli`,
`@react-native/metro-config`, `react`, all resolved from the registry) PLUS
the candidate's own FULL transitive dependency tree resolved from the
registry, THEN a real Metro bundle + `hermesc` compile. There is no
"--offline / --cache-dir" escape hatch anywhere in that file. Populating a
local mirror for this is not "cache N tarballs" (premise 1's framing) — it's
mirroring npm registry metadata plus every transitive dependency of 75+20
packages, open-ended and unbounded by the truth list's own size. That is
out of scope for one item and was not attempted.

**What was built instead, and why it's honest, not a dodge.** A new,
genuinely offline informed path: `hbc2js deps --known <file>`
(`src/deps/known.ts` parses the input; `runInformedDeps`, `src/deps/index.ts`)
restricts `loadSignatures`'s existing evidence-directed candidate filter
(`candidates.ts`) to the GIVEN package names instead of a
bundle-string scan, then runs the exact same `matchInventory`/`buildReport`
scoring the blind path uses. A match can therefore never be attributed to a
package outside the given list — informed precision is **100% by
construction**, not something that needed tuning to hit. Per known package,
the verdict is `confirmed` (tier high, same bar `confirmedDeps` always
used), `refused` (a signature loaded and scored but stayed below the bar —
real and rare: `react-native-worklets` on the held-out app, medium tier),
or `not-found` (no signature file for that package name in ANY loaded DB
layer, at any version — the D17a-stage-4-shaped gap this item exists to
surface). This deliberately does NOT go through `confirm.ts`'s `--confirm`
stage at all; it's a different, narrower, always-offline confirm path.

**Measured, offline, both fixtures (`tests/gate/deps/informed-confirm.test.ts`,
`tests/sweep/deps/informed-vs-blind-react-navigation.test.ts`):**

| fixture | truth pkgs (direct) | blind confirmed | informed confirmed | informed refused | informed not-found | gap (informed - blind), recall of all |
|---|---|---|---|---|---|---|
| rn-template-0.72, `index.android.hbc` | 20 (2) | 2 | 2 | 0 | 18 | 0.0 points |
| react-navigation-example.hbc (release) | 75 (60) | 10 | 10 | 1 | 64 | 0.0 points |
| react-navigation-example.debug.hbc | 75 (60) | 10 | 10 | 1 | 64 | 0.0 points |

**The gap is 0.0 points on every fixture measured — informed mode, built the
way it's actually deliverable offline today, confirms exactly what blind
already confirms, nothing more.** This is not informed mode being useless;
it is direct, measured proof of premise 2: even GIVEN the true candidate
list, this tool can only confirm a candidate whose signature already exists
in a loaded DB layer, and today only ~16-20% of either fixture's truth
packages have one (18/20 and 64/75 are `not-found`, not `refused` — the DB
was never asked to score them because no signature file for their names
exists at all). Growing DB coverage (J4's job) is the only lever that would
move this gap; this item's own scope (candidate-restricted scoring) cannot,
by design.

**What the 0.0 gap does and does not establish.
J7 is PARTIAL against its own acceptance, not closed.** Read carefully,
because this number is the yardstick J4 and J6 are specified to be measured
against and it is easy to draw the opposite conclusion from it.

*Established, and genuinely useful:* under the signature coverage that
exists today, knowing the app's true dependency list adds **nothing**. Blind
mode's evidence-directed DB filter (the bundle-string scan) is
already loading every signature that could match — the informed filter,
driven by the true names instead, found not one additional package. So the
blind filter is exonerated: it is not where recall is lost. Recall is lost
because 64/75 (held-out release `.hbc`) and 18/20 (rn-template
`index.android.hbc`) truth packages have **no signature file in any DB layer
at all**. That is a real result and it does point at J4.

*NOT established:* the informed ceiling this item set out to measure. Informed mode was specified as the D17a **confirm stage** — fingerprint
each given candidate on demand from its own tarball (no registry). That mechanism was not built, for a sound reason recorded above
(`confirm.ts`'s `installCandidate`/`ensureScratchProject` need a full scratch
RN scaffold plus each candidate's whole transitive tree from the registry,
then a Metro bundle and a hermesc compile, per candidate). What shipped
instead restricts the *existing* DB load to the known names, so it can only
ever confirm a package that is **already fingerprinted**. Therefore:
- 0.0 is a **floor under today's coverage**, not a ceiling. Do not read it as
  "dependency knowledge buys nothing" — it buys nothing *yet*, because the
  tool cannot act on the knowledge for an unfingerprinted package.
- The informed ceiling and J4's payoff are close to the same quantity
  (fingerprint-on-demand is J4's bulk build done lazily), so J4 cannot be
  scored against this 0.0 as if it were an independent target.
- Measuring the real ceiling needs a confirm path that fingerprints one
  package offline from a tarball without scaffolding a whole RN app. That is
  the concrete follow-up, and it is a prerequisite for J7's acceptance
  ("informed recall is the ceiling the blind path is chasing") to be met.

**Reconstruction ceiling (`hbc2js export --substitute safe`, informed vs
blind `depsReport`, `--tier flat` for speed):** identical between blind and
informed on both fixtures — rn-template: 0 substitutions either way (429
vendor / 2 app / 4 unclassified modules; blocked by `multi-entry-package`
and `ambiguous-owner`, the same S1-S4 boundary reasons regardless of confirm
tier). Held-out app (release): **1 substitution either way**
(`@react-native-async-storage/async-storage`, 6 modules) — this corrects
an earlier figure of "ZERO" predates the 8d landing above;
1 is the current, measured number. 1251 vendor / 345 app / 180 unclassified
modules; blocked by 7 `multi-entry-package` + 5 `ambiguous-owner` rows (the
per-package boundary shapes — react-native 165 boundary modules,
`@react-navigation/stack` 69, etc. — are not re-derived here). **The J6 vendored-count gap does not move
between blind and informed because the blocker isn't recall at all — every
package informed confirms beyond blind (none, on these two fixtures) would
still need to clear S1-S4's boundary analysis, which is J6's problem, not
J2/J4's.** The fourth number asked for — bytes of app code
exported vs bytes of ORIGINAL app source — was not measured: neither
fixture retains its original source tree locally (rn-template was built in
a scratch dir outside this repo per its own BUILD.md and only the compiled
`.hbc`/`.bundle` were copied in; the held-out app's `fetch.sh` clones an
unpinned upstream HEAD and re-running it would score a DIFFERENT app
against this fixture's truth) — getting it needs
new fixture prep (re-scaffolding rn-template at its pinned 0.72.17 version,
which IS reproducible, unlike the held-out app) left to a follow-up.

### Bulk sigdb v2: dependency-aware subtraction
**The mechanism (I6, folded into this item).** A package's raw fingerprint
always included every function its own npm dependencies contribute too —
`baseline-subtract.mjs` only ever subtracted the toolchain/react/react-native
baseline, never a package's OTHER dependencies — which is the documented
root cause of the false "ambiguity" the G4 series. **Verified against
the live npm registry, not assumed:** the actual mechanism is
`peerDependencies`, not `dependencies` — `@react-navigation/stack@8.0.0-
alpha.53`'s `dependencies` field is only `{use-latest-callback,
@react-navigation/elements}`; `@react-navigation/native` is a
`peerDependencies` entry. Metro bundles a resolved peer exactly like a
regular dependency (the bulk build's own scaffold resolves peers into
`node_modules` too), so a subtraction pass reading only `dependencies`
missed the dominant real case — a first attempt at this task found exactly
that (stack's `subtractedDependencies` came back empty on a real run).
`tools/pkgsig/bulk/dep-subtract.mjs` fetches `dependencies` +
`peerDependencies` + `optionalDependencies` (never `devDependencies` — not
bundled) for every in-DB `package@version`, resolves each declared range
against the other in-DB versions of that dependency, topologically sorts so
a dependency is always processed before its dependent, and subtracts each
resolved dependency's own (already-subtracted) function hash set. **Directly
measured, real data:** `@react-navigation/stack@8.0.0-alpha.53__hbc98`
totalFunctions 5805 → 4721 (1084 functions removed, 123/1186 modules
flagged `factoryIsDependency`), `subtractedDependencies` correctly names
`react-native`, `react-native-screens`, `@react-navigation/native`,
`react-native-gesture-handler`, `react-native-safe-area-context` — all five
are real `peerDependencies` entries, not fabricated.

**v1/v2 compatibility.** `SigDbFile.subtractedDependencies?: string[]`
(`src/deps/sigdb-types.ts`) is the on-disk v2 marker, present (possibly
`[]`) on every file this pipeline writes, absent on every pre-J4 file.
`src/deps/db.ts`'s `loadSignatures` now treats the mere presence of a v2
entry for a package name (any version, any layer) as superseding every v1
entry for that same package, even across layers — otherwise a fetched v2
release could still lose match collisions to a contaminated v1 copy sitting
in, say, the repo's own committed `tools/pkgsig/db/` starter set. Test-first:
`tests/gate/deps/db.test.ts` gained a case proving this (fails against the
old `loadSignatures`, passes after).

**The population (chosen independently of the fixtures).** Rather than a fresh scrape, this landing
reused and fixed the D17c bulk build already run on
a build host (`docs/specs/15-sigdb-schema.md`'s own ground truth):
round 1's static ~3,000-package "most relevant to React Native apps" list
(`tools/pkgsig/bulk/packages.json`, hand-curated, not fixture-derived) plus
round 2b's registry-driven top-N-by-downloads list ("Round 2b" above,
`candidates.mjs --registry`) — together 2,159 distinct package names /
71,300 signature files, genuinely independent of either truth fixture.
Round 2's small 92-package addition DID read this repo's own truth fixtures
(`candidates.mjs`'s source (a) — see that file's header) — checked package
by package against the held-out fixture's 75 truth packages: all but 4
(`@react-native/assets-registry`, `@react-native/normalize-colors`,
`@react-native/virtualized-lists`, and half of `nullthrows`'s two reasons)
were ALREADY in round 1's independent list, so round 2's read of the
truth file did not put them there — the whole `@react-navigation/*` family
needed for this fixture, for instance, was already in round 1 before round
2 ever ran. Those 4 packages are real `@react-native`-scoped subpackages
any reasonable "RN ecosystem" list would include regardless; none of them
end up confirmed either way in the measurement below, so this residual
overlap does not affect the reported numbers. Additionally: this task
merged the repo's own committed 40-file curated starter set
(`tools/pkgsig/db/`, exact-version-pinned against both fixtures already)
into the bulk build's input **before** running dependency-subtraction, so
cross-set dependency edges (e.g. the held-out fixture's exact
`@react-navigation/stack@8.0.0-alpha.53`, which round 1/2b never
fingerprinted at all) resolve too — this merge is itself fixture-informed
(the curated set exists because two prior tasks pinned exact fixture
versions), so the exact-version stack/native/material-top-tabs entries in
the measurement below are not "independent of the fixtures" in the same
sense as the 2,159-package bulk population is; recorded here rather than
silently blended in.

**A second, real, pre-existing bug this measurement surfaced (not
introduced by this task): 353 of the 71,300 bulk files never had baseline
subtraction run at all** (`subtractedBaselines: []`, `totalFunctions ==
rawFunctionCount`) — exactly the documented issue-#14 finding under "The
D17c bulk DB" above, this time hit fresh by working directly
against the bulk build directory instead of through `fetch-db.sh` (which always
runs `filter-unsubtracted.mjs` after extracting an archive — this
work never extracted an archive, it read the build directory directly, so it
never got that automatic quarantine). First symptom: layering the raw
bulk-v2 DB against `rn-template-0.72` dropped confirmed-tier precision from
100% to 22.2% (`@react-native-clipboard/clipboard@1.11.1__hbc94` alone
carries all 4,201 unsubtracted functions — react-native's own core modules
exact-hash-collided against it). Fixed by running
`node tools/pkgsig/filter-unsubtracted.mjs <dir>` against the v2 output
before use (quarantined exactly 353 files, restoring 100% precision) —
**anyone building or rebuilding this bulk DB directly (not via
`fetch-db.sh`) must run this quarantine step explicitly; it is not implicit
in `dep-subtract.mjs` itself** (deliberately — quarantine is an ingestion-
time policy per that script's own header, not a `loadSignatures` policy).

**Measured, offline, both fixtures, `tools/deps-truth.mjs`, v2 DB layered as
the user-cache directory (`XDG_CACHE_HOME`) — the realistic fetch-on-demand
deployment shape, not `--sigdb`'s always-exhaustive project-layer load,
which would `JSON.parse` all 71,300/~28 GB of files per run:**

| | rn-template-0.72 before | after | held-out (release) before | after |
|---|---|---|---|---|
| confirmed (count) | 2, 100% precision | 2, 100% precision | 10, 100% precision | 10, 100% precision |
| recall (of all / of direct) | 10.0% / 100% | **10.0% / 100%** (unchanged) | 13.3% / 16.7% | **13.3% / 16.7%** (unchanged) |
| per-module correct (count) | 334/432 (77.3%) | 333/432 (77.1%) | 407/1547 (26.3%) | 403/1547 (26.1%) |
| per-module wrong, by instr weight | 2684/92227 (2.9%) | 2752/92227 (3.0%) | 81080/292497 (27.7%) | **81049/292497 (27.7%)** (unchanged) |

**Acceptance NOT met, reported plainly rather than padded.** The
targets (held-out direct recall 17%→≥80%, wrong-by-weight 27%→<5%,
rn-template recall 10%→≥80%) are not reached — confirmed-tier recall does
not move at all on either fixture, and wrong-by-weight barely moves (and on
rn-template moves very slightly the wrong way — new bulk-DB coverage can
introduce a new tied/losing collision even when correctly subtracted; not
chased further, one module's worth of noise). Root-caused, not left a
mystery:
1. **Recall is capped by candidate derivation and match-confidence
   thresholds, not by contamination.** Probed directly (`matchReport.packages`
   for the held-out fixture's specific misses): `nullthrows`, `base64-js`,
   `abort-controller`, `memoize-one`, `stacktrace-parser`, `whatwg-fetch` —
   present in the v2 DB (confirmed: 20 versions each) — never even become a
   candidate at all, because their package-name string never appears
   literally anywhere in the bundle's own strings
   (`src/deps/candidates.ts`'s evidence-text scan — a
   pre-existing, out-of-scope limitation for tiny/generic packages with no
   distinctive string trace). Others (`invariant`, `promise`, `scheduler`)
   DO load but only reach `none`/`low` tier — present, but not confirmable
   at the fingerprinted version(s). Growing the DB's package COVERAGE, which
   is what this task did, cannot fix either limitation; J4's own scope
   (dependency-aware subtraction) was never going to move this number, and
   in retrospect the acceptance target should not have been set against a
   lever this task doesn't pull.
2. **Wrong-by-weight on the held-out fixture is dominated by a DIFFERENT,
   already-diagnosed mechanism dependency-aware subtraction correctly does
   NOT touch.** The G4d Gotcha above found `react-native-gesture-handler`'s
   collision with `@react-navigation/stack` is a shared generic Babel/
   regenerator-runtime helper, not true containment — confirmed again here:
   modules 2/4/5 (truth `react-native-gesture-handler`, reported
   `@react-navigation/stack`, basis `exact`) are UNCHANGED before/after this
   task's fix, because that collision was never a declared-dependency edge
   to begin with (subtracting stack's real peer deps, which this task does
   correctly, cannot remove code stack and gesture-handler each
   independently inline). This fixture's wrong-mass is apparently dominated
   by this second mechanism, not the first — a different root-cause mix
   than first assumed.

**J7 prerequisite, checked first as instructed (answer: no missing
prerequisite).** `tools/pkgsig/bulk/build-one.mjs` already fingerprints one
package properly and does NOT share `confirm.ts`'s unbounded-install
problem: it runs `npm install <pkg>@<version> --ignore-scripts` in a shared
scaffold slot (resolving the FULL transitive tree, including peers once
npm/the app's own install would resolve them), then a real Metro bundle +
`hermesc` compile — this is exactly what a correct offline single-package
fingerprint needs, and is the reason this task could reuse the existing
71,300-file build at all rather than needing new infrastructure. `confirm.ts`
instead uses `npm pack` (grabs only the target's own tarball, never its
dependencies), which is the actual defect J7 found. **Closing J7 for real is
wiring `confirm.ts`'s informed-confirm path to `build-one.mjs`'s
install-and-bundle approach instead of `npm pack`** — not attempted here,
follow-up.

**Expensify (J3): measured 2026-11-08.** The bundling attempt that previously
failed (react-native-worklets/watchman race) was made to work by retrying
`react-native bundle` until it succeeds (each run leaves more `.worklets/`
files); recipe, pinned commit `12a92bd3...` and hashes in
`tests/fixtures/bundles/expensify-app-0.86.0/BUILD.md`, truth in that
directory's `deps-truth.json` (288 packages, 91 direct, from the source map
via `tools/deps-truth.mjs`). Blind offline `runDeps` + `scoreAgainstTruth`
against db-v3 on our own hermesc-98 build of that bundle (sha pin matched),
same columns as the held-out table above:

| bundle | confirmed | falsePositives | recall all / direct | ceiling | bar losses | no signature | in DB, never a candidate |
|---|---|---|---|---|---|---|---|
| expensify-app.hbc (own build) | 155 (83 TP) | 72 | 28.8% / 27.5% | 97/288 | 27 | 154 | 37 |

Confirmed-tier precision is 53.5% here (react-navigation: 15/15), so a
threshold change that looks safe on react-navigation must also be checked
against these 72 false positives (e.g. `safe-buffer`, `process`, `uuid`,
`readable-stream`, `d3-*`, `victory-*`, `core-js`, `util`, `url`, `assert`;
many are version-less polyfill/utility names or packages whose code is
shared with a differently-named truth package). Version mismatches: 251
(confirmed lists many versions of one package). Guessed tier: 9 reported,
3 correct. The bundle is not byte-reproducible (95-byte delta between
builds), so truth is pinned to one `.hbc` sha.

**Offline false positives on J3, by mechanism (corpus-offline-precision,
2026-11-08).** For each of the 72 false positives above, the target modules
its signature matched were looked up in the J3 truth (source map), to see
which package really owns them:

| mechanism | FPs | examples | status |
|---|---|---|---|
| module hits on J4 dependency-flagged modules (`factoryIsDependency`) counted as the package's own | 14 | `victory-stack` (130 module hits, 0 function hits, all lodash/d3), `victory-chart/-pie/-shared-events`, `d3`, `d3-contour`, `util`, `bl` | fixed |
| signature embeds a copy of another package that is in the app, not removed by dependency subtraction (undeclared dependency, Node built-in polyfill, or a transitive dependency) | 46 | `buffer`+`ieee754` copy: `safe-buffer`, `sax`, `obuf`, `encoding`; es-shim chain (`es-errors`, `call-bind`...): `assert`, `is-typed-array`, `url`; `@babel/runtime` helpers: `bucket`, `plaid`, `vaul`; lodash: `dagre`, `victory-core`, `cubic` | open (BUGS) |
| react-native code left in the signature (baseline gap) | 2 | `@react-native-firebase/auth`, `/firestore` | open |
| matched code the truth places in app code or in another package's generated code | 10 | `uuid`, `process`, `stackframe`, `swiper`, `culori` | open |

The fix: `scorePackage` (`src/deps/match.ts`) no longer counts a module
flagged `factoryIsDependency` as a module hit, and the two fuzzy module
indexes skip it as well. `dep-subtract.mjs` already removes such a
module's factory function and keeps the module only so the module graph
stays complete. The module still counts in `moduleTotal`. Removing it
there too was measured and rejected: some packages then dropped below
three modules and qualified for the tiny-package path, which added
`react-shallow-renderer` as a false positive on react-navigation-example.
Result: Expensify 155 confirmed / 72 FP / recall 28.8% became 139 / 58 /
28.1% (precision 53.5% to 58.3%). Three true packages were lost (`css-tree`,
`htmlparser2`, `d3-time`): their only module evidence was on modules that
were flagged as dependency code. react-navigation-example stayed at
17 confirmed, 0 FP, recall 22.4%. The 46 remaining embedded copies can't
be told apart from the real package by hash ownership: `buffer` (true) and
`safe-buffer` (false) match the same 72 functions. Two other rules were
measured and rejected because they cost recall: a lower ambiguity cutoff
(`AMBIGUOUS_OWNER_THRESHOLD` 4: Expensify 20 FP but 74 TP; react-navigation
recall 22.4% to 18.4%) and requiring the package's entry module to match
(drops 27 of 83 Expensify TPs and 12 of 17 react-navigation TPs). Per-module
file paths in signatures (extraction plan step 1) are the fix for that
mechanism.

**Shipping.** Per D17c, the DB itself is never committed — the v2 build
lives on a build host in `db-v2` (dependency-subtracted,
353-file-quarantined) and is packaged the same way round 1's first archive
was, via `tools/pkgsig/bulk/assemble.sh` pointed at a wrapper dir
(`HBC2JS_BULK_DIR=<bulk-v2-dir>`, `db` symlinked to `db-v2`) — this
never touches or replaces the v1 archives already referenced above.
`tools/pkgsig/fetch-db.sh` is unchanged (it already runs
`filter-unsubtracted.mjs` unconditionally on whatever it unpacks, so a v2
archive fetched through it is safe by construction even without the
by-hand quarantine step this task needed working directly against the
build directory). Fetch it the same way as any other remote-hosted archive:
`HBC2JS_SIGDB_SOURCE=$HBC2JS_REMOTE_HOST:<bulk-v2-dir>/dist/sigdb-<date>-partial.tar.zst
tools/pkgsig/fetch-db.sh` — once fetched into the user-cache layer, v2's
per-package supersede rule means every affected package's contaminated v1
signature (wherever it lives, including this repo's own committed starter
set) stops being read automatically.

- `tests/gate/deps/inventory.test.ts` — module-graph recovery against the
  committed `rn-template-0.72` fixture.
- `tests/gate/deps/db.test.ts` — layering precedence and the on-disk format.
- `tests/gate/deps/match.test.ts` — the offline gate check: react +
  react-native must resolve at High confidence, lodash must not; plus the
  D17d tiny-package-collision regression (`js-md5`/`@emotion/react` must not
  reach High off one coincidental module hit, but must still reach it given
  genuine multi-hit evidence) against the committed
  `tests/fixtures/sigdb/tiny-package-collision/` real signature files.
- `tests/gate/deps/ambiguous-attribution.test.ts` — G4b's regression,
  rewritten by G4c for the set-identity rule: a synthetic module whose only
  evidence is a factory exact hash shared by two distinct real packages is
  STILL attributed (blind `owners[0]` pick, `moduleOwnership` unaffected —
  the earlier `>1`-threshold refusal, commit e7c83bfa, is gone) but IS
  flagged `ambiguousOwnerHash` (G4c: 2 distinct package NAMES is already
  ambiguous, not gated on `AMBIGUOUS_OWNER_THRESHOLD`); a 20-package fixture
  is still flagged too (many claimants is a special case of "more than
  one"); and a new case proves a hash shared by several VERSIONS of the
  SAME package is NOT flagged — own(P) must still substitute it.
- `tests/gate/export/substitute-ambiguous.test.ts` — G4b's other half,
  unchanged by G4c (its assertions fabricate `ambiguousOwnerHash` directly
  on `ModuleOwnership`, independent of how match.ts computes it): a module
  flagged `ambiguousOwnerHash` is excluded from `own(P)`
  (`src/export/substitute.ts`) without sinking the rest of its package's
  substitution, and the exclusion is a real, named `unresolved` row (kind
  `ambiguous-owner`), never silently dropped.
- `tests/gate/deps/guess.test.ts` — evidence-scoring unit tests, including
  the `Object.prototype`-pollution regression test and the versioned/bare
  `package-name-string` clue plus `isHintEligibleEvidence` (`hint` tier).
- `tests/gate/deps/apk.test.ts` — APK-hint mapping unit tests.
- `tests/gate/deps/precision.test.ts` — the guess-aggregation precision
  rules, plus the `hint`-tier promotion rules (native-module/url-host alone,
  versioned vs. bare package-name-string, dependency-edge/apk/db-match never
  qualify alone, DB-negative veto and confirmed-package exclusion apply to
  hints too, and a hinted module is dropped from the printed unattributed
  list without affecting `attribution.unattributedModules`).
- `tests/gate/deps/robustness.test.ts` — `-g` build: AsyncBreakCheck elision,
  same confirmed deps/RN version as release, ≥95% of its module attribution.
- `tests/gate/deps/truth.test.ts` — D17d ground truth on the template
  (release and `-g`): confirmed-tier false positives = 0, hint-tier false
  positives = 0 (asserted, not just reported, on this fixture since it has
  no third-party dependencies at all).
- `tests/gate/deps/confirm.test.ts` — `confirmCandidates`'s pure helpers
  (dedup, baseline subtraction, RN-version-from-baseline-filename fallback,
  nearest-by-date version resolution) plus an end-to-end run against a
  stubbed `npm`/`npx` (no network): write-back + D17b layering.
- `tests/gate/cli/deps.test.ts` — the `hbc2js deps` CLI end-to-end
  (text/`--json`/`--out`/error handling).
- `tests/gate/deps/classify.test.ts` — D17h/D17j/D17i stage 2
  classification (27 tests): each signal in isolation (recurrence
  at/above/below threshold, minInstr floor, majority-of-weight fraction
  gate, node_modules-path + package-name extraction incl. scoped packages,
  bare package-relative path incl. its own route-path false-positive
  guard, package-name-version-string, `deriveAppVocabulary`'s
  frequency-window and shape-distinctive inclusion and generic-boilerplate
  exclusion, structural-shape + app-vocabulary preempting it, node_modules
  evidence winning over a vocabulary coincidence, the custom/unknown
  defaults), `buildCommonalityIndex`/`mergeCommonalityIndexes`'s
  distinct-bundle counting, and three integration checks against the real
  `rn-template-0.72` fixture (a self-built commonality index recovers its
  own eligible functions; the real committed
  `tools/pkgsig/commonality-index.json` produces a well-formed report,
  skipped gracefully if that file is ever absent from a checkout; a fully
  corpus-free run — `EMPTY_COMMONALITY_INDEX` — still derives a non-empty
  app vocabulary and classifies every module, D17j's own claim).
- `tests/sweep/deps/corpus.test.ts` — the seed-run corpus, skipped
  (INCONCLUSIVE) when its inputs are absent.
- `tests/sweep/deps/truth-react-navigation.test.ts` — D17d on
  react-navigation-example, skipped until its map/truth are generated.
- `tests/sweep/deps/confirm-react-navigation.test.ts` — `--confirm` against
  react-navigation-example with a real npm registry, `--no-shared-db`;
  skipped (INCONCLUSIVE) without the sweep tier or the fixture's
  `.hbc`/`deps-truth.json`. Numbers: "`--confirm` precision/recall" above.
- `tests/gate/deps/known.test.ts` — `parseKnownDeps` shape parsing (J7),
  no fixture needed.
- `tests/gate/deps/informed-confirm.test.ts` — blind vs informed on
  rn-template-0.72 (committed fixture, gate tier). `tests/sweep/deps/informed-vs-blind-react-navigation.test.ts`
  — the same, held-out app, sweep-gated + skips (INCONCLUSIVE) if the
  gitignored fixture isn't seeded locally. Numbers: "Informed confirm mode"
  above.
