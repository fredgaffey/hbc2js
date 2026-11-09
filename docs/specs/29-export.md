# 29 — `hbc2js export`: a bundle becomes a React Native project tree

**Status: 6d LANDED (2026-09-19).** The offline build proof:
`tests/gate/export/build.test.ts` (sweep-gated) exports the held-out
react-navigation-example-0.85.3 app (`--tier flat --substitute none`) and
bundles it with Metro's own programmatic API (`loadConfig`/`runBuild` --
`@react-native-community/cli` is not installed, so `npx react-native bundle`
cannot be used), resolving node_modules from this repo's own pinned
devDependencies (a symlink plus an explicit `watchFolders` entry for the
symlink's real target -- Metro reports a watched file's realpath, which must
itself be inside a watched root or every transform fails "Failed to get the
SHA-1 for"), no npm install, no network. This is what caught a real bug, not
a hypothetical one: `buildIndexJs` (`src/export/boilerplate.ts`) hardcoded
`require("./src/index.js")` for the entry module, which was only ever
correct by coincidence (when the entry module happened to be named
`index.js` by the name-overlay heuristic) -- on the held-out app the real
entry module's own bucket is `vendor` (`moduleOwnership` attributes it to
`react-native`, a known granularity-problem case, 6c's own Gotchas), so its
real path is `src/_vendor/react-native/module_986.js` and the hardcoded
require resolved nothing at all. Fixed by threading the entry module's real
`ExportModuleInfo.path` through `buildIndexJs`; a new `unresolved` kind,
`entry-module-path-unknown`, covers the (unobserved) case where the entry
module's id resolves but its path does not (substituted away). `--substitute
safe` (the CLI default) is not used by the build-proof test: it correctly
redirects two of the held-out app's packages
(`react-native-gesture-handler`, `@react-native-async-storage/async-storage`)
to their real npm names, but this repo's own devDependencies do not include
either (an install-side proof, not this test's job) -- `--substitute none`
keeps the tree self-contained under `src/_vendor`, which is what makes an
install-free, network-free assertion possible at all. Measured: export+build
9.9s wall (React Native template tree, ~10s per this test's own timing);
the Metro build step alone (excluding export) is ~0.6s; output bundle
9.68 MB. 

Previously: 6c LANDED (2026-09-18). `src/export/substitute.ts`'s
`planSubstitutions` implements §5's S1-S4 boundary analysis for real, over
the same `DepEdge[]` graph §7.1 already built (`ModuleEntry.deps`, no second
analysis) and `DepsReport.moduleOwnership`. `--substitute` defaults to
`safe` (was the only unimplemented CLI option; `none` is still the §5.3
escape hatch, unconditionally the empty plan). Measured: on rn-template,
`react-native` is the only package with `own(P)` nonempty and it correctly
REFUSES (13 boundary modules, `multi-entry-package`) — zero substitutions,
matching the spec's own "a bundle that builds needs no dependency
substitution at all" framing (§0); on the held-out
react-navigation-example-0.85.3, 2 packages substitute cleanly
(`react-native-gesture-handler`, own(P) size 1, zero leaks;
`@react-native-async-storage/async-storage`, own(P) size 6) and 7 packages
refuse as `multi-entry-package` (`react-native` itself, `react`, both
`@react-navigation/*` families, `react-native-screens`). One real
implementation deviation from §5.2's literal text, documented in
`src/export/substitute.ts`: the call-site rewrite
("eager edge -> hoisted `var _P = require('P')`; lazy edge -> inline
`require('P')` at the call site") assumes a literal `require(...)` call
exists at the call site, which is true only at `--tier flat`
(`src/split/rewrite.ts`'s literal text) and never at `--tier passes`/`jsx`
(the pass ladder's copy-propagation already resolves the require to a direct
call on the require PARAMETER before any such text exists — the same
tier-dependent shape 6a's Gotcha found for ordinary requires). Substitution
is implemented instead as an id-level redirect inside the shared registry
file (`src/export/registry.ts`'s `__hbc.r`, `__hbc_substituted`, one literal
`require("<package>")` per substituted package so Metro's static resolver
still sees it) — behaviourally equivalent (same call site, same call time,
so eager/lazy deferral is preserved automatically) and uniform across every
tier, at the cost of not producing the literal per-call-site text the spec's
prose describes. `tests/gate/export/substitutions.test.ts` gained a
non-vacuous held-out-app case (sweep-gated, `--tier flat` for speed):
asserts a real substitution happens, names it
(`react-native-gesture-handler`), and asserts the registry's redirect is a
literal (Metro-resolvable) `require()` call, not a dynamic one.

Previously: 6b LANDED (2026-09-18). `src/export/index.ts` now runs ONE flat
(no-passes) `splitProject` call for parse+analysis and renders every module
individually off `SplitResult.analysis` (`src/export/tiers.ts`'s
`renderModuleTiered` -> `renderModuleReadable`, lane item 4) instead of one
whole-bundle pass-ladder emit: §7.2's `rendersJsx`-driven per-module tier
selection (`--tier jsx` renders `jsx` only for a module the index tags
`rendersJsx`, `passes` for the rest — no module pays for `jsx-recover`
unless it can use it) and §7.3's three-rung fallback ladder (readable render
-> the flat `--split` text -> the empty-factory stub for an unreachable
factory) are both real: a per-function or per-pass failure downgrades only
that module (never aborts the whole export), and `EXPORT.json`'s
`modules[].tier`/`tierDowngradeReason`/`unresolved[]` record exactly which
rung each module landed on and why (`src/export/manifest.ts`'s
`buildExportManifest`, which also asserts the §6 coverage invariant
internally, not only in the gate test). `modules[].eagerDeps`/`lazyDeps` are
now real counts off `index/modules.json`'s `DepEdge[]` (§7.1 point 3), not a
placeholder. `--substitute none` is still the only behaviour (`substitute`
itself is `src/export/substitute.ts`, not written yet — the
manifest's `substitutions` array is always empty and `dependencies` covers
every confirmed package). All 16 acceptance tests under `tests/gate/export/`
pass (1 sweep-gated); `manifest.test.ts` gained two tests exercising §7.2 and
§7.3 directly (the held-out committed fixture, rn-template, renders every
module cleanly at tier `passes`/`jsx` with no natural downgrade to exercise
end-to-end, so the fallback-ladder rungs are exercised as a forced-failure
unit case against a real `ModuleAnalysis`, same approach
`tests/gate/emit/scoped-decompile.test.ts` already uses for the render
function underneath). Remaining implementation: `--substitute safe`.

This is a tool spec, not a pass-ladder rung. Like spec 08 it never touches the
bytes between a factory function's `{` and `}` — it decides *which file each
module lands in*, *what specifier each dependency edge is written as*, and
*what boilerplate surrounds the tree*. Every semantic guarantee the pass ladder
and the harness already give a module body survives export unchanged.

## 0. Finish line, and what this spec is NOT

**Finish line for the implementation of this spec:** on the held-out fixture
`tests/fixtures/bundles/react-navigation-example-0.85.3`,

```
hbc2js export react-navigation-example.debug.hbc --out /tmp/exported
cd /tmp/exported && npm install && npx react-native bundle \
  --entry-file index.js --platform android --dev false --bundle-output /tmp/out.bundle
```

both succeed. **Booting the result on a device or emulator is explicitly a
later spec** — see §8.

That choice of finish line is deliberate and it is what makes the whole design
tractable: *a bundle that builds needs no dependency substitution at all*. A
tree in which every one of the bundle's modules is vendored locally, with only
the RN toolchain installed from npm, satisfies the finish line. Substitution
(§5) is therefore built on top of a tree that is already known to build, never
as a precondition for it, and its failure mode is always "fall back to the
vendored module", never "the tree no longer builds".

## 1. Where this sits in the pipeline

```
bundle.hbc
   |
   |-- splitProject (src/split/index.ts)          module_<id>.js x N + MODULES.json
   |-- buildSemanticIndexes (src/artifact/*)      index/modules.json: DepEdge[] (eager/lazy,
   |                                              spec 10 §2.6), rendersJsx, fnOwnership
   |-- runDeps (src/deps/*)                       DepsReport: confirmedDeps, moduleOwnership
   |-- segregateSplitTree (src/split/segregate.ts) id -> bucket + name (spec 08)
   |-- renderModuleReadable (src/split/render-module.ts)  per-module readable render (lane item 4)
   |
   v
hbc2js export  (THIS SPEC)
   |
   v  a directory `npm install` and `npx react-native bundle` accept
```

`export` **calls** those five; it reimplements none of them. In particular it
performs exactly ONE `splitProject` parse+analysis for the whole run and feeds
every per-module render off that same `SplitResult.analysis` (never re-parse per module).

## 2. CLI

```
hbc2js export <bundle.hbc> --out <dir> [options]

  --out <dir>              required; the project tree root
  --overwrite              allow a non-empty --out (default: refuse, spec 10 §1.3)
  --tier passes|flat|jsx   per-module render tier ceiling (default: passes)
  --names <overlay>        naming overlay applied at render (docs/RENAME.md)
  --deps-report <file>     reuse a previous `hbc2js deps --json` report instead
                           of re-running deps (the expensive stage)
  --substitute none|safe   library-module substitution policy (§5; default: safe)
  --app-name <name>        override the recovered AppRegistry name (§4.2)
  --rn-version <x.y.z>     override the detected React Native version (§4.3)
  --instrument=modules     wrap every module factory's execution with a boot
                           timer (§4.5); default:
                           off, output byte-for-byte unchanged
  --json                   print the export manifest to stdout instead of a
                           human summary (stderr keeps the progress lines)
```

Exit codes and error taxonomy follow `src/errors.ts` as every other verb does.
`export` never partially writes: it builds the whole file map in memory and
writes it in one pass, exactly like `writeSegregateResult`.

## 3. Directory layout

```
<out>/
  package.json            # §4.3 dependencies (exact pins) + scripts
  app.json                # §4.2 {"name": <registerComponent name>, "displayName": ...}
  babel.config.js         # module.exports = {presets: ["module:@react-native/babel-preset"]}
  metro.config.js         # @react-native/metro-config defaults, unmodified
  index.js                # §4.1 the RN entry: boots the registry, runs the entry module
  .gitignore              # node_modules/, *.bundle, .metro-*
  EXPORT.json             # §6 the manifest: every substitution, every unresolved item
  src/
    _hbc/
      registry.js         # §4.4 the Metro-compatible __d/__r module registry
      helpers.js          # §4.4 the runtime helpers split emits (__hbc_b_*)
    index.js              # the entry module (MODULES.json "entry")
    App.js                # spec 08 §2.1 step 2, when distinct from the entry
    screens/<Name>.js     # spec 08 §3.2
    navigation/<Name>.js  # spec 08 §3.1
    store/<name>.js       # spec 08 §3.3
    components/<Name>.js  # spec 08 §3.4
    module_<id>.js        # app module with no naming signal (spec 08 fallback)
    _vendor/
      <pkg>/module_<id>.js    # library module owned by a named package, NOT substituted
      _anon/module_<id>.js    # anonymous library module (classify "library", no owner)
    _unclassified/module_<id>.js   # classification "unknown" (spec 08 §4 no silent loss)
```

### 3.1 `node_modules/` is never written by `export`

Spec 08's segregated tree puts library modules under `node_modules/<pkg>/`.
An **export tree must not**: `npm install` owns that directory, and it will
merge decompiled files into a real installed package, or silently shadow one.
`export` therefore **re-roots** segregate's buckets:

| segregate path (spec 08 §2) | export path |
|---|---|
| `node_modules/<pkg>/module_N.js` | `src/_vendor/<pkg>/module_N.js` |
| `node_modules/_vendor/module_N.js` | `src/_vendor/_anon/module_N.js` |
| `src/...` | `src/...` (unchanged) |
| `_unclassified/module_N.js` | `src/_unclassified/module_N.js` |

Spec 08 is unchanged by this: the re-rooting is a pure path rewrite `export`
owns, applied to `SegregatedModuleInfo.newPath` after `segregateSplitTree`
returns.

### 3.2 Module id to path mapping — one function, one source of truth

`exportPathForModule(id)` is the only place a module id becomes a path:

1. `SegregatedModuleInfo.newPath` for `id`, re-rooted per §3.1.
2. If segregate produced no entry for `id` (it cannot today, spec 08 §4
   guarantees coverage; belt and braces): `src/_unclassified/module_<id>.js`,
   with an `unresolved` manifest row.

Every dependency specifier in every emitted file, every manifest `path`, and
`index.js`'s own entry reference is computed from this one map — a specifier
is a POSIX relative path from the requiring file's directory to the target,
always beginning `./` or `../` (Metro requires that; a bare specifier is a
package name and would be resolved out of `node_modules/`).

## 4. Boilerplate, and how the tree actually loads

### 4.1 `index.js` (project root)

```js
// hbc2js export -- React Native entry point.
require("./src/_hbc/helpers.js");   // installs __hbc_b_* on globalThis
var __hbc = require("./src/_hbc/registry.js");  // installs __d / __r
require("./src/_vendor/react-native/module_48.js");  // run-before-main (spec 33 L1)
require("./src/module_986.js");     // the entry module's REAL export-tree path,
                                     // whatever bucket it landed in -- never a
                                     // literal "./src/index.js" guess (queue
                                     // item 6d, build-proof: that path is only
                                     // ever right by coincidence, e.g. when the
                                     // name-overlay heuristic separately named
                                     // some other module `index.js`)
__hbc.r(48);                        // a file require only REGISTERS; factories run
__hbc.r(986);                       // in the original's top-level __r order
```

The decompiled entry module's own body is what calls
`AppRegistry.registerComponent(name, factory)` — `export` does not synthesise a
second registration, which would double-register the app. When the entry module
could not be resolved (`MODULES.json.entry === null`), `index.js` is emitted
with the registry boot only plus a loud header comment, and an `unresolved`
manifest row of kind `no-entry-module` is written. When the entry module id
*is* resolved but its export-tree path is not (it was substituted away —
possible in principle, not observed on either measured fixture), the same
registry-boot-only shape is emitted with a `entry-module-path-unknown` row
instead. The tree still builds in both cases; it would not boot.

### 4.2 `app.json`

`name` is, in priority order: `--app-name`; the `registerComponent` app name
spec 08 §2.1 step 2 already recovers (measured 1/1 on rn-template:
`HelloHermes072`); otherwise `DecompiledApp`. `displayName` mirrors `name`.
The manifest records `app.nameSource` as `flag` | `registerComponent` |
`fallback`, so a fallback name is never mistaken for a recovered one.
`index.js`'s registration must agree with `app.json`'s `name` or the RN host
finds no component — the acceptance test in §9 checks exactly that agreement.

### 4.3 `package.json` and where versions come from

Two disjoint groups, with two different provenances, both recorded per package
in the manifest:

- **`dependencies`** — from `DepsReport.confirmedDeps` only (`{package,
  version}`, confirmed tier, the M6 contract in `docs/DEPS.md` "For the M6
  emitter"), via the existing `packageJsonDependencies(report)`. Versions are
  **exact pins** (`"0.72.17"`, never `^`/`~`): the bundle is evidence for one
  build, and a caret would install a different one. `guessedDeps`/`hintedDeps`
  are NEVER written into `package.json` (DEPS.md's own rule); they land in the
  manifest's `unresolved` list with kind `guessed-not-installed`, visible and
  actionable, never silently applied.
- **`devDependencies`** — the build toolchain, which is *not derivable from the
  bundle at all*: `@react-native/babel-preset`, `@react-native/metro-config`,
  `@react-native-community/cli`, `metro`/`metro-react-native-babel-*` (per RN
  minor), `@babel/core`. These come from a static table
  `TOOLCHAIN_FOR_RN` keyed by React Native minor version, sourced from the
  official RN template for that minor and cross-checked against
  `docs/TOOLCHAIN.md`'s HBC-to-RN table. The RN version itself is
  `--rn-version`, else `DepsReport.reactNativeVersion`; if that is `null` the
  export picks the newest RN minor whose `HBC_TO_RN_RANGE` entry contains the
  bundle's `hbcVersion` and records `reactNative.source: "hbc-range"` plus an
  `unresolved` row. `reactNativeVersionConsistentWithHbc` is copied into the
  manifest verbatim — a `false` there is a warning line on stderr, never a
  refusal to export. Table maintenance is manual.

`scripts` are the RN template's (`start`, `android`, `ios`, plus a `bundle`
script spelling out the §0 command so the finish line is one `npm run bundle`).
`private: true`. No lockfile is written.

### 4.4 The registry: making a Metro-built tree behave like a Metro bundle

The split tree's own `index.js` loader is **Node-only** — it patches
`Module._load` to map `require("./module_N.js")` onto `__r(N)`
(`src/split/index.ts` `buildLoaderIndexJs`). Metro has no `Module._load`, and
Metro resolves `require()` **statically**: every dependency edge must appear in
the requiring file as `require("<string literal>")` or Metro will not put the
target in the bundle. This is the single hardest constraint in the spec and it
dictates the file shape.

Each exported module file is:

```js
// hbc2js export -- module 4111 (tier: passes; source fn#1234; app)
var __hbc = require("../_hbc/registry.js");
function factory(global, require, importDefault, importAll, module, exports, dependencyMap) {
  ...unchanged decompiled body, whose dependency calls read require('./module_72.js')...
}
__hbc.define(factory, 4111, [72, 1710]);
// dependency registration edges (Metro resolves these statically):
require("./components/Button.js");
require("../_vendor/@babel/runtime/module_72.js");
```

Rules that make this correct:

1. **`__hbc.define` runs before any registration `require`.** In a registration
   cycle A -> B -> A, B's re-entry into A returns A's not-yet-populated CJS
   exports — harmless, because a registration require is evaluated for its side
   effect only and its return value is discarded. Since every file's `define`
   has run by the time any factory runs, `__r` never sees an unregistered id.
2. **The body's own `require('./module_N.js')` calls are rewritten to
   `__hbc.r(N)`** — a numeric id call, so module-level cycles behave exactly as
   they do under Metro (the exports object exists before the factory runs, a
   cycle sees a partial object), which is exactly what the original bundle did.
   `src/split/rewrite.ts` already produced those literal call sites; export
   rewrites them one more time and records the count.
3. **Registration requires are emitted for eager AND lazy edges alike** (§7.1):
   registration is a `__d` call, it never runs a factory, so it costs nothing
   and it is what makes Metro include the file. Laziness is preserved by `__r`,
   not by where the `require` sits.
4. `src/_hbc/registry.js` is a ~40-line file (`__d`, `__r`, the `importDefault`
   / `importAll` interop helpers `buildLoaderIndexJs` already emits) with the
   `Module._load` patch deleted. `src/_hbc/helpers.js` holds the `__hbc_b_*`
   runtime helpers split reports in `helpersUsed`, assigned onto `globalThis`
   so module bodies keep referring to them as free names, unchanged.

### 4.5 `--instrument=modules`: per-module boot timing

A pure add-on, off by default: it only changes `src/_hbc/registry.js`
(`buildRegistryJs`'s `instrument` parameter), never a per-module file, and
never `entry.factory`'s arguments/return value. `r(id)` (§4.4) is the ONE
place every registered factory actually runs, so wrapping it there times
every module exactly once. A clock read straddles the unchanged
`entry.factory(...)` call; the elapsed time is pushed as `{id, t0, dt}` onto
the `globalThis.__HBC_BOOT_TIMINGS__` ring buffer (capacity 256, then
auto-flushed; also flushable on demand via `globalThis.
__hbcFlushBootTimings()`). Clock: `globalThis.performance.now()` when
present, else `Date.now()` -- never a Node-only API a bundled RN tree cannot
rely on. Flush target is `console.log("__HBC_BOOT_TIMING__ " +
JSON.stringify(record))` lines ONLY -- Metro's runtime `require()` only
accepts a numeric dependency-map id once bundled, so no code inside the tree
can safely open a real file; "to file" is achieved by the operator
capturing the console/logcat/os_log stream outside the runtime, the same
convention as the device tool's own `HBC2JS_DEVICE_MARKER` lines.
`tools/perf/summarize-modules.mjs <dump> <EXPORT.json>` reads that captured
stream (marker-prefixed or bare JSON lines, either accepted) and joins each
id to a package through the SAME run's own `EXPORT.json` `modules[]` array
(`owner`, falling back to `bucket` for an app-tree module, `"unknown"` only
for an id absent from the index entirely) -- not the P2.1 `modules.json`/
`functions.jsonl` artifact stack (spec 10), which carries no package field
at all; EXPORT.json is the right join here.

### 4.6 Offline bundling check: the installed toolchain, the tree unchanged

An exported tree names the toolchain of the app it came from (§4.3): an RN 0.72
app gets `metro-react-native-babel-preset` 0.77 / metro 0.76 in
`babel.config.js` and `package.json`. This repo pins one toolchain (RN 0.85.3),
so the offline check (`src/export/offline-check.ts`, used by the gate) cannot
resolve those names and Metro dies at "Cannot find module
metro-react-native-babel-preset". Choice: the tree stays faithful to the
original app (a user who installs it themselves gets the original toolchain),
and only the check is redirected: Metro's `transformer.babelTransformerPath`
points at `offline-babel-transformer.cjs`, which runs the installed
`@react-native/metro-babel-transformer` with an empty `projectRoot`, so the
tree's own `babel.config.js` is ignored and the installed
`@react-native/babel-preset` is used. No file in the tree is written or
changed, and there is no CLI flag. Rejected: pinning a second toolchain per RN
minor (heavy, more dependencies, more upkeep). Proof: the RN 0.72 template
exports and bundles offline (`tests/gate/export/build.test.ts`, sweep tier).
Limit: this proves the tree's sources transform and resolve, not that the
original toolchain would; that is a property of the original app's own pins.

## 5. Library substitution — real imports where the evidence supports one

### 5.1 The granularity problem, stated honestly

`DepsReport.moduleOwnership` names the **package** that owns a module
(`{localModuleId, package, version}`). It does not name the **file within that
package** — the signature DB stores per-module bytecode hashes, not source
paths (spec 15's schema has no module sub-path column). So "module 72 is
`@babel/runtime`" cannot be turned into `require("@babel/runtime/helpers/
interopRequireDefault")` by lookup: the sub-path is simply not known.

Substitution is therefore **defined on the package boundary, not on the
module**, and refuses whenever the boundary is ambiguous.

### 5.2 The rule

Let `own(P)` be the module ids `moduleOwnership` attributes to package `P`.
Over `index/modules.json`'s `DepEdge` graph, let the **boundary targets**
`B(P) = { v in own(P) : some edge u -> v with u not in own(P) }`.

Package `P` is substituted iff ALL of:

- **S1** `P` is in `confirmedDeps` with `confidence >= 0.8` (the threshold;
  `--substitute none` disables substitution entirely).
- **S2** `|B(P)| === 1` — the app enters `P` at exactly one module, so that
  module is `P`'s public root and `require("P")` is a faithful replacement for
  every edge into it.
- **S3** `own(P)` is closed: no edge from inside `own(P)` leaves to a module
  outside `own(P)` that is not itself owned by a substituted package. (A
  library reaching back into app code is a bundler artefact we must not drop.)
- **S4** `P` is not `react-native` or `react` when the bundle's own RN version
  is unknown — substituting the framework on a guessed version is the one
  substitution that can silently change everything.

`own(P)`'s **membership** is never gated on `moduleOwnership`'s
`ambiguousOwnerHash` flag (`src/deps/match.ts`/`src/deps/report.ts` — true
when a module's owning factory hash is claimed by more than one distinct
PACKAGE NAME, any version of the same package counting as one name). An
EXACT factory-hash collision means the two candidates' bytes are
byte-identical, so deleting an ambiguous module that is not in `B(P)` (an
**interior** module — nothing outside `own(P)` ever references it directly,
by this section's own definition of boundary) changes nothing observable no
matter which claimant truly wrote it: it is safe to delete alongside the
rest of `P`. The only place a wrong pick is real is **S2's own boundary
module**: if the single module `B(P)` names is itself ambiguous, picking `P`
for it is not safe evidence, because a wrong pick there misdirects
`require(P)` itself. So the actual rule is: **S2 additionally fails if its
sole boundary module carries `ambiguousOwnerHash`** — `P` is left fully
vendored (nothing deleted, nothing redirected) rather than substituted on a
coin-flip pick of what its public root even is. Every module of `own(P)`
that carries `ambiguousOwnerHash` — boundary or interior, and regardless of
whether `P` goes on to substitute or refuses for some unrelated S1/S2/S3/S4
reason — is reported as one `unresolved` row, kind `ambiguous-owner`, purely
for transparency; only a boundary hit actually blocks substitution.
(Two earlier landings tried gating all of `own(P)`'s membership on this
flag: one reused `scorePackage`'s own `AMBIGUOUS_OWNER_THRESHOLD`, calibrated
for aggregate package-level scoring, and measured it never fire in practice;
the other excluded every ambiguous module regardless of boundary/interior
and measured it flag 525 of 1033 modules on the held-out
react-navigation-example app — mostly real, correctly-attributed
`@react-navigation/*` code whose fingerprint collision with a sibling
package is dependency-fingerprint contamination during signature harvest
(`tools/pkgsig/filter-unsubtracted.mjs`'s documented failure mode: a
package's harvested signature legitimately contains its own dependencies'
code too), not evidence the module itself is unsafe to delete. See
docs/DEPS.md's consumer-audit row for the full measurement, including the
one real, earned refusal this rule still produces on that fixture
(`react-native-gesture-handler`'s sole module is a generic Babel/
regenerator-runtime helper, also its own boundary, genuinely shared with
three unrelated packages).

When `P` substitutes:

- every edge `u -> v` with `v in B(P)` has its specifier rewritten from a
  relative path to the bare package name `"P"`;
- every file in `own(P)` is **deleted from the tree**;
- the body-level call is rewritten by edge kind (§7.1): an **eager** edge
  becomes a hoisted `var _P = require("P");` at the top of `u` with the call
  site reading `_P`; a **lazy** edge becomes an inline `require("P")` at the
  call site, preserving the deferral the original had;
- one `substitutions` manifest row records package, version, confidence,
  boundary module id, every replaced module id, and the number of rewritten
  edges.

When `P` does not substitute, **nothing happens**: its modules stay vendored
under `src/_vendor/<pkg>/`, the tree still builds, and one `unresolved` row
records the reason (`multi-entry-package` with `|B(P)|`, `low-confidence` with
the score, `not-closed`, or `framework-version-unknown`). `P` still appears in
`package.json` `dependencies` if it is confirmed — an installed-but-unused
dependency is harmless and keeps the dependency list honest about what the app
was built against.

### 5.3 Why this is safe to get wrong

Substitution is the only stage that can change behaviour, so it is the only
stage with an escape hatch: `--substitute none` produces a tree that is
byte-for-byte the vendored tree, and the acceptance tests (§9) assert that the
`none` tree and the `safe` tree contain the same module id set modulo the
manifest's `replacedModules` — i.e. nothing is ever lost, only replaced.

## 6. `EXPORT.json` — the manifest

Written at the tree root. `hbc2js-export/1`.

```json
{
  "schema": "hbc2js-export/1",
  "producer": { "hbc2js": "<pkg version>", "git": "<sha|null>", "ts": "<iso>",
                "options": { "tier": "passes", "substitute": "safe", "names": null } },
  "source": { "bundleSha256": "...", "bytes": 1234567, "hbcVersion": 96,
              "moduleCount": 435, "entryModule": 434 },
  "app": { "name": "HelloHermes072", "nameSource": "registerComponent" },
  "reactNative": { "version": "0.72.17", "source": "deps-confirmed",
                   "consistentWithHbc": true, "expectedRange": "RN 0.72.x-0.81.x" },
  "dependencies": { "react-native": { "version": "0.72.17", "kind": "dependency",
                                      "source": "deps-confirmed", "confidence": 0.94 } },
  "modules": [
    { "id": 434, "path": "src/index.js", "bucket": "app", "tier": "passes",
      "tierDowngradeReason": null, "rendersJsx": true, "owner": null,
      "eagerDeps": 3, "lazyDeps": 0 }
  ],
  "substitutions": [
    { "package": "react", "version": "18.2.0", "confidence": 0.91,
      "boundaryModule": 5, "replacedModules": [5, 6, 7], "edgesRewritten": 41,
      "forms": { "eager": 40, "lazy": 1 } }
  ],
  "unresolved": [
    { "kind": "multi-entry-package", "package": "@babel/runtime",
      "moduleIds": [72, 241], "detail": "3 boundary modules; sub-path unknown" }
  ],
  "counts": { "modules": 435, "app": 250, "vendor": 180, "unclassified": 5,
              "substitutedPackages": 1, "substitutedModules": 3,
              "tiers": { "passes": 430, "flat": 5, "jsx": 0, "stub": 0 },
              "unresolved": 4 },
  "leftOut": ["android/", "ios/", "assets", "lockfile", "typescript", "sourcemaps"]
}
```

**The coverage invariant (asserted in §9).** Every module id in `MODULES.json`
appears **exactly once** across `modules[].id` and the union of
`substitutions[].replacedModules`, and those two sets are disjoint. Nothing is
dropped, nothing is counted twice. `unresolved[].kind` is a closed set:
`multi-entry-package`, `low-confidence`, `not-closed`,
`framework-version-unknown`, `guessed-not-installed`, `anonymous-library`,
`unclassified-module`, `no-readable-render`, `no-entry-module`,
`entry-module-path-unknown`, `asset-bytes-missing`, `native-module`,
`ambiguous-owner`.

## 7. What the upstream index work is actually used for

### 7.1 Eager vs lazy edges (lane item 5, spec 10 §2.6 `DepEdge`)

Three uses, all real, none decorative:

1. **Substitution call form** (§5.2): eager -> hoisted `var _P = require("P")`,
   lazy -> inline `require("P")` at the call site. This is what keeps a
   deliberately deferred import deferred after substitution; collapsing both to
   a hoisted require would change startup work.
2. **Boot-reachability reporting**: the eager-only transitive closure from the
   entry module is the set of modules that run at startup. The manifest's
   `counts` carries its size; a later spec can use it for code splitting.
3. Manifest `modules[].eagerDeps`/`lazyDeps` per module, so the tree is
   auditable without re-running the index.

Edges with `site: null` are treated as eager (spec 10 §2.6's own safe default).

### 7.2 `rendersJsx` (lane item 1)

1. It selects the `jsx` render tier: under `--tier jsx`, exactly the modules
   tagged `rendersJsx` are rendered through the `jsx-recover` rung and the rest
   through `passes`; running jsx-recover on a module that renders no JSX is
   wasted work. Under the default `--tier passes` no module gets it.
2. It feeds spec 08 §3.4's component/util routing (`src/components/` vs a flat
   `src/` file) rather than the name grep the pack's Gotchas warn against.
3. It is copied into `modules[].rendersJsx`, so the manifest answers "which
   files are UI" without a second analysis.

**D20 note.** D20 says JSX output is not runnable JS and the faithfulness
guards are off for it. That rationale is about *hbc2js's own harness*, which
runs emitted files under plain Node. An export tree is compiled by
`@react-native/babel-preset`, which compiles JSX — so JSX files are buildable
*here*. The default tier is nevertheless `passes`, and `--tier jsx` is opt-in
and recorded per module in the manifest, because the guard that would catch a
jsx-recover bug does not run.

### 7.3 Modules with no readable render

`renderModuleReadable` can fail (structurer bailout, budget, a pathological
function). The tree must still be complete, so every module goes through a
**fallback ladder**, and every downgrade is recorded:

| step | source | manifest `tier` |
|---|---|---|
| 1 | `renderModuleReadable` at the requested tier | `jsx` / `passes` |
| 2 | the flat `--split` text for that module (already in hand; no passes) | `flat` + `tierDowngradeReason` |
| 3 | split's own empty-factory stub for an unreachable factory | `stub` + an `unresolved` row |

A module is never omitted and never left as a dangling id. Each file's header
comment names its tier, so the tier is visible in the tree as well as the
manifest (the rule lane item 4 set for `readable/module_N.js`).

## 8. Explicitly out of scope

Listed here so nobody reads an omission as an oversight; each is also in the
manifest's `leftOut`.

- **Booting.** Running the exported app on a device or emulator. The bundle
  builds; whether it boots is spec 33 (headless boot proof).
- **The native host projects** `android/` and `ios/`. The user supplies them
  (`npx react-native init` at the pinned version, then copy this tree over its
  JS half). Reconstructing them is spec 27's territory.
- **Assets.** A `.hbc` contains the `AssetRegistry.registerAsset({...})`
  metadata modules but not one byte of any image or font. The export therefore
  *builds* (those modules are plain JS) and, at boot, shows missing images. One
  `asset-bytes-missing` unresolved row per registered asset. Extracting assets
  from an APK is native-side work.
- **TypeScript, source maps, ESLint/Prettier config, Jest config, Flow.**
- **Symbol-level exports/imports.** Edges stay id-level and CJS; no ESM
  rewriting, no named-export recovery (spec 10 §6 says the index does not have
  it either).
- **Tree shaking, code splitting, dead-module pruning.** The eager closure
  (§7.1) is reported, not acted on.
- **Native modules.** A first-party native module's JS seam is exported as
  ordinary app code that calls `NativeModules.X`; the native half does not
  exist and the call fails at boot, not at build. One `native-module`
  unresolved row each, from `index/native.jsonl`.
- **The LLM naming layer.** `--names <overlay>` is applied when given; export
  never invokes a model.

## 9. Acceptance tests

Shipped with this spec, under `tests/gate/export/`. Each file guards itself
with `const IMPLEMENTED = existsSync(<repo>/src/export/index.ts)` and passes
`{ skip: !IMPLEMENTED }` — so they are skipped-by-design today and become live
the moment the export implementation lands, with no test-count churn. All of them run on
`rn-template-0.72` (committed, small); the held-out
`react-navigation-example-0.85.3` case is sweep-gated (`HBC2JS_TIER=sweep`).

| file | asserts |
|---|---|
| `tree-layout.test.ts` | the §3 tree exists on rn-template: `package.json`, `app.json`, `babel.config.js`, `metro.config.js`, `index.js`, `src/`, `EXPORT.json`; **no `node_modules/` directory is written** (§3.1); `node --check` passes on every emitted `.js` at the default tier; `index.js` boots the registry before the entry; `app.json`'s `name` is the same string the tree registers. |
| `manifest.test.ts` | `EXPORT.json` is `hbc2js-export/1` with every §6 field; the **coverage invariant** (every `MODULES.json` id exactly once across `modules[]` and `substitutions[].replacedModules`, the two disjoint); every `unresolved[].kind` is in the closed set; `counts` agree with the arrays they summarise; every `modules[].path` exists on disk and every `modules[].tier` is one of the four. |
| `substitutions.test.ts` | every `substitutions[].package` is a key of `package.json`'s `dependencies` AND appears in the deps report's `confirmedDeps` at `confidence >= 0.8`; every bare (non-relative) `require()` specifier in every emitted file names a package in `dependencies` or `devDependencies`; every relative specifier resolves to a file that exists; `--substitute none` and `--substitute safe` yield the same module id set modulo `replacedModules` (§5.3). |

Not a gate test, because it needs the network and minutes: `tools/e2e/
export-build.mjs` runs the §0 finish line (`npm install` with a warm cache,
then `npx react-native bundle`) against a freshly exported held-out app and
prints the bundle size. It is run by hand and not asserted in the gate.

## 10. Implementation plan

Three worker-sized items. Each ends with a tree that builds; none of them is
allowed to leave the tree in a state where a later item is required for it to
build.

- **6a — the buildable vendored tree.** §2 CLI, §3 layout, §4 boilerplate and
  registry. No manifest beyond a stub, no substitution (`--substitute none` is
  the only behaviour). Unskips `tree-layout.test.ts`. Delivers the §0 finish
  line for the vendored case.
- **6b — the manifest and the render tiers.** §6 `EXPORT.json` in full, §7.2
  tier selection, §7.3 fallback ladder. Unskips `manifest.test.ts`.
- **6c — substitution.** §5 boundary analysis, edge rewriting, the
  `substitutions`/`unresolved` rows. Unskips `substitutions.test.ts`; re-runs
  the finish-line tool with `--substitute safe`.

## 11. Open questions

| row | question |
|---|---|
| P-68 | Is "`npm install` + `npx react-native bundle` succeed" the right finish line, or does this spec own booting too? |
| P-69 | Offline install: commit a lockfile / a vendored npm cache (repo size), or keep the install check out of the gate in `tools/e2e/`? |
| P-70 | Where does `TOOLCHAIN_FOR_RN` come from and who maintains it? The build toolchain's versions are not in the bundle. |
| P-71 | Is `--substitute safe` the right default, and is the single-boundary-module rule (S2) too strict for packages like `@babel/runtime` and `lodash` that are legitimately entered at many sub-paths? |
| P-72 | Does spec 08 keep emitting `node_modules/`, with export re-rooting it (this spec), or should segregate gain a `--vendor-dir` so there is one layout? |
| P-73 | May `--tier jsx` become the default for `rendersJsx` modules, given babel compiles JSX in an export tree and D20's "not runnable JS" rationale is about hbc2js's own Node-based guards? |
| P-74 | Assets: accept "builds, boots with missing images", or add an APK-side asset extraction step so the exported tree is visually complete? |
