# 08 — Segregation: split tree → real project layout

**This is a tool spec, not a pass-ladder rung.** Passes (`docs/specs/passes/`)
rewrite one function's AST for readability and never touch the file/module
graph. Segregation runs *after* `--split` (and after `hbc2js deps`) and only
ever moves/renames files and rewrites `require()` specifiers — it never
touches a function body. It belongs alongside `06-harness.md`/`07-pass-
ladder.md` as its own top-level component, hence `08-segregation.md`, not
`docs/specs/passes/19-segregation.md`. It is D17i stage 3 ("name / find on
npm" generalised to "name everything").

Self-contained: this spec does not require reading `src/deps/classify.ts` or
`src/split/index.ts` to use, only to implement — their public shapes are
restated below where segregation depends on them.

## 0. Where this sits in the pipeline

```
bytecode --split--> module_<id>.js × N + MODULES.json      (src/split, existing)
              \
               `--> hbc2js deps` --> DepsReport (moduleOwnership,
                    classification: ModuleClassification[])  (src/deps, existing)
                                              |
                                              v
                                   hbc2js segregate            (NEW, this spec)
                                              |
                                              v
                     src/…  (app code, named)             +  node_modules/<pkg>/…
                     SEGREGATION.json (id -> new path)     +  SCREENS.md (D19)
```

Segregation is a **separate stage**, not folded into `--split`: D17i's whole
point is that later stages must never block earlier wins, and naming/screen-
detection heuristics will keep changing long after isolate+classify are
stable. Proposed CLI: `hbc2js segregate <input>` where `<input>` is either
raw bytecode (runs isolate → classify → name end-to-end, calling `--split`
and `deps` internally) or an existing `--split --out <dir>` directory (reuses
its `MODULES.json` + a `deps` run's `DepsReport` passed via `--deps-report
<file>`, so re-running segregation after tweaking a naming heuristic doesn't
re-decompile). `--out <dir>` for the segregated tree, default alongside the
split tree.

## 1. Input

- The `--split` tree: `MODULES.json` (`{ hbcVersion, moduleCount, entry,
  modules: [{ id, file, factoryFunctionIndex, deps: number[] }] }`) plus one
  `module_<id>.js` per Metro module, each a `function factory(...) {…}`
  wrapped in `__d(factory, id, deps)`, with `require('./module_<id>.js')`
  calls already rewritten to resolve by id (`src/split/index.ts`
  `SplitResult`/`SplitModuleInfo`).
- `DepsReport.classification` (`src/deps/classify.ts` `ClassificationReport`,
  built by `classifyInventory`): one `ModuleClassification` per module —
  `classification: "library" | "custom" | "unknown"`, `signal`, `confidence`
  (0..1), `recurrenceCount`, `libraryPackageHint: string | null`. This is
  the isolate→**classify** verdict (D17i stage 2); segregation reads it,
  never recomputes it.
- `DepsReport.moduleOwnership`: `{ localModuleId, factoryFunctionIndex,
  package, version }[]` — modules **named** by the deps pipeline (D17i
  stage 3, match/guess/confirm already implemented). Segregation's own
  naming work is therefore only for: (a) `library`-classified modules with
  no `moduleOwnership` entry ("anonymous library", D17h tier 2), and (b)
  `custom`-classified modules (app code — the interesting case, no prior
  naming exists for these at all).
- The module's own decompiled JS text (or AST, if segregation runs before
  `emitModule`'s text is discarded — see 3.4) — used to extract naming/
  screen/navigator/store signals.

## 2. Output layout

```
<out>/
  package.json                 # name from AppRegistry.registerComponent
                                # resolution (2.1); dependencies from
                                # DepsReport.moduleOwnership + confirmed vers.
  node_modules/
    <pkg>/                     # one dir per DISTINCT named package
      package.json             #   {name, version} synthesised (already
      index.js …               #   partly implemented, DEPS.md "For the M6
                                #   emitter")
    _vendor/
      <contentHash8>/index.js  # anonymous LIBRARY modules (classify.ts
                                # "library", no moduleOwnership hit) — kept
                                # OUT of src/ so it doesn't pollute the
                                # app-code view, grouped by content hash so
                                # identical anonymous vendor code (e.g. the
                                # same polyfill duplicated by two libs)
                                # collapses to one dir. Open question 6.4.
  src/
    index.js                   # entry module (MODULES.json "entry")
    App.js                     # registerComponent's resolved app name,
                                # when distinct from index.js (2.1)
    screens/<Name>Screen.js    # 3.2
    navigation/<Name>.js       # 3.1
    store/<name>Slice.js       # 3.3
    components/<Name>.js       # 3.4 component signal
    module_<id>.js             # CUSTOM module, no naming signal fired —
                                # fallback (2.2), never dropped
    _unclassified/module_<id>.js  # classification === "unknown" (never
                                # silently placed in src/ OR node_modules/,
                                # see §4 "no silent loss")
  SEGREGATION.json             # id -> new path, per-module signal +
                                # confidence used, for audit (§5)
  SCREENS.md                   # D19: navigator route name -> screen file
                                # -> components rendered
```

### 2.1 Naming algorithm (deterministic)

Applied per module, **in this priority order**, first hit wins; every step
reads only the current module's decompiled text/AST plus (where noted) one
level of its `deps` via `MODULES.json`/`SplitModuleInfo.deps` — segregation
never does a general points-to analysis:

1. **Entry** — `id === MODULES.json.entry` → `src/index.js`, always,
   regardless of any other signal.
2. **App-registration name** — the entry module (or whichever module calls
   `<x>.registerComponent(name, factory)` where `<x>` resolves to the
   `AppRegistry` import) — resolve `name`: if it's a string literal, use it
   directly; if (the common case, confirmed on `rn-template-0.72`
   module_0.js/module_434.js) it's `require(dep).name` where `dep` is a
   module whose entire body is `{name: "<Lit>", ...}` (an inlined
   `app.json`), resolve one require-hop and take the literal. Result names
   `src/App.js` (the registered component) and seeds `package.json`'s
   `"name"`. Confidence 0.95 (literal), 0.8 (one-hop resolve).
3. **`displayName` assignment** — `X.displayName = "Foo"` anywhere in the
   module → `Foo` (component; routed through 3.4's directory rule).
   Confidence 0.9.
4. **Default export identifier** — `module.exports = Foo` /
   `exports.default = Foo` where `Foo` is a `function Foo(...)`/`class
   Foo` declared in the same module → `Foo`. Confidence 0.7 (Hermes/Metro
   sometimes renames locals under minification even in "readable" output;
   lower than displayName because a declared name is weaker evidence of
   the *intended* export name than an explicit `.displayName`).
5. **`createSlice({ name: "foo", … })`** → `foo` (routed to
   `store/fooSlice.js`, 3.3). Confidence 0.9 (literal object key).
6. **Route/screen name from a navigator config** (3.2) → `<Name>Screen`.
   Confidence per 3.2.
7. **Fallback** — `module_<id>.js`, unchanged from the split tree. The
   file's header comment (already emitted by `splitProject`) gains one more
   line: the classify.ts `signal`/`confidence` that kept it unnamed, so an
   analyst can see *why* (e.g. `// segregation: custom, no naming signal
   (confidence 0.0)`) rather than a silent miss.

**Confidence floor.** A name is only applied when its step's confidence is
above a floor (default 0.6, `--min-name-confidence`); below the floor, the
module keeps `module_<id>.js` even though a candidate name exists, on the
theory that a wrong name actively misleads an analyst (a numeric fallback
never does). The candidate name and its confidence are still recorded in
`SEGREGATION.json`.

**Collisions.** Two modules resolving to the same candidate name (e.g. two
different libraries both export a component called `Button`) are
disambiguated deterministically, never by run order: sort colliding modules
by their *module id* (stable for a given bytecode + split run), keep the
first as `<Name>.js`, and suffix the rest `<Name>.2.js`, `<Name>.3.js`, …
Numeric suffixes are the accepted stopgap (open question 6.2 asks whether
the maintainers want something more stable across incremental re-runs, since module
ids can shift when a new decompiler run adds/removes an upstream module).

**Identity is never lost.** Every renamed file keeps its module id in the
header comment (`// hbc2js segregate -- Metro module <id> (was module_<id>.js)`)
so `SEGREGATION.json` and the file agree without needing to parse
`require()` calls to recover it.

### 2.2 Directory routing

The naming signal that fired also decides the directory: registerComponent
→ `src/`, displayName/default-export-of-a-component → `src/components/`
(3.4 upgrades this to `src/screens/` if the same module is also reachable
from a navigator route, 3.2), `createSlice`/store detection → `src/store/`,
navigator detection (3.1) → `src/navigation/`. A module can only be filed
once; screen beats generic component (more specific signal wins).

## 3. Segregation signals

Each signal states what it reads and its confidence. All signals are
evaluated against a module already classified `custom` by `classify.ts`
(library-classified modules never get screen/navigator/store treatment —
they're either named via `moduleOwnership` or bucketed into
`node_modules/_vendor/`).

### 3.1 Navigator detection (confidence 0.9 named / 0.6 unnamed / 0.6 shape-alone)
A CUSTOM module contains a call `create<X>Navigator(...)` (`X` ∈
`Stack|Native­Stack|BottomTab|Drawer|Material­TopTab|…`, i.e. any
`Create[A-Za-z]*Navigator`-shaped callee) whose callee resolves, via the
module's `deps`, to a required module that either (a) has a
`moduleOwnership` entry whose `package` matches `^@react-navigation/` —
confidence 0.9 — or (b) is itself `library`-classified with no name, i.e.
only the call-name pattern is evidence — confidence 0.6. **Reads:** the
module's decompiled text (grep for the call name) + `MODULES.json`'s `deps`
array to resolve the callee's require edge to `moduleOwnership`/
`classification`.

**Deps confirms, it does not gate.** A `--deps-report` is a *confirming* signal only: with no deps report at all (so a first, named `src/screens/` tree needs no slow `deps` run), the call/config shape ALONE still names the module — confidence 0.6, the same floor as the "unnamed library-classified" tier above, still clearing `MIN_NAME_CONFIDENCE`. When a deps report *is* present but simply doesn't confirm this particular call (none of its deps resolve to `@react-navigation/*` or a library), the call is still rejected — a real classify.ts verdict that didn't confirm is stronger negative evidence than no verdict at all. Implemented in `src/split/segregate.ts`'s `detectNavigator`/`nameCustomModules` (`hasClassificationData` flag).

### 3.2 Screen detection (confidence 0.85 literal route / 0.5 dynamic)
Given a navigator module (3.1), the object/array literal passed as route
config — either `<Navigator>.Screen` JSX children (post jsx-recover pass) or
the `createXNavigator({ RouteName: { screen: Component } })`-shaped config
object (pre-jsx-recover, older API) — is walked for `{ name: "<Lit>",
component: <Ident> }` pairs. `<Ident>` is resolved to a required module via
the navigator module's own `deps`/require-call sites (`SplitModuleInfo`
tracks `requireRewrites`, i.e. which require calls in this file were
resolved to which module id). That target module is named `<Lit>Screen`
(2.1 step 6) and filed `src/screens/`. **Reads:** navigator module's
decompiled AST (needs real parsing, not grep, to walk the config
object/JSX tree — this is the one signal that can't be a regex) + its
require edges. Confidence drops to 0.5 when the route's `component` value
is not a bare identifier resolvable to one require target (e.g. computed,
or a `React.lazy(() => import(...))`-shaped indirection) — the screen is
still flagged in `SEGREGATION.json` as "route detected, target module
unresolved" for manual follow-up rather than silently dropped.

**Both config shapes are implemented, deps-free, in `traceModuleOrigins`**
(`src/split/segregate.ts`, regex-driven linear scan, not a real AST walk —
see its own doc comment): the pre-jsx-recover `{ RouteName: Component }`
registry (`routeObjRegs`) and the post-jsx-recover
`{ name: "<Lit>", component: <ref> }` props shape (`jsxScreenPending`,
gated on the module itself also matching 3.1's navigator call shape, to
keep the same "given a navigator module" framing and limit false positives
from an unrelated `.name =`/`.component =` pair elsewhere in a large
module). Neither shape's target resolution (`moduleOriginByReg`) needs a
`--deps-report` — the classification guard that used to require a
screen's *target* module be `classify.ts`-confirmed `custom` now only
applies when a deps report was actually supplied (`hasClassificationData`);
with none, a resolved literal-route hit is accepted on its own.

### 3.3 Store/slice detection (confidence 0.9 slice name / 0.4 zustand)
`createSlice({ name: "foo", … })` (Redux Toolkit) → CUSTOM, filed
`src/store/fooSlice.js`, confidence 0.9 (2.1 step 5). `configureStore(...)`/
`createStore(...)` → the module itself is `src/store/index.js` regardless
of any other signal (root store wins directly, no name to extract).
Zustand's `create(...)` is far weaker evidence on its own (`create` is a
generic identifier) — only counted when the callee resolves via `deps` to a
module named/hinted `zustand` (`moduleOwnership.package === "zustand"` or
`libraryPackageHint === "zustand"`); confidence 0.4 even then, since
zustand stores have no equivalent to `createSlice`'s literal `name` field to
extract — the module is filed `src/store/` but keeps its `module_<id>.js`
name unless another naming signal (displayName-style, e.g. a named
`useFooStore` export) also fires.

### 3.4 Components vs utils (confidence 0.9 jsx-recovered / 0.6 raw createElement)
A CUSTOM module is a **component** if its default export's body contains a
`jsx` AST node (post jsx-recover pass, `docs/specs/passes/08-jsx-recovery.md`)
or, pre-pass, a `React.createElement`/`jsx()` call tree, AND the export's
identifier (from 2.1 step 3 or 4) is capitalised (React convention).
Confidence 0.9 with the jsx-recover pass already run (structural, not
textual), 0.6 on the raw-call pattern alone (ambiguous with any factory
function that happens to call something named `createElement`). A CUSTOM
module that is not classified a component is filed `src/` flat (not a
positive "util" signal — there is no `isUtil` heuristic, only "failed the
component test"), one directory level up from `src/components/`, so a false
non-component reads as "unsorted app code", never as a wrong claim.

## 4. Correctness — segregation changes zero semantics

Segregation only ever: moves a file, renames it, and rewrites the string
argument of `require(...)` calls that target a moved module (and the
generated `require.resolve`-style dispatcher, if the loader uses one instead
of literal paths — see `src/split/index.ts`'s header comment on the
`__d`/`__r` polyfill). **The bytes between a factory function's `{` and `}`
are never touched.** This makes two independent equivalence proofs cheap
rather than requiring a full re-verification:

1. **Structural proof (new, cheap).** A segregation-diff test: for every
   module, `emittedBody(before) === emittedBody(after)` where
   `emittedBody` strips the file's header comment and any `require(...)`
   call's string-literal argument (the only two things segregation is
   allowed to change) before comparing. This is a byte-diff test, not a
   re-run of the harness — O(files), no VM trace needed.
2. **Behavioural proof (reuse, cheap).** `tools/e2e/boot-split.mjs` already
   proves the un-segregated `--split` tree resolves `require()` edges all
   the way to `AppRegistry.registerComponent` under Node (D19's existing
   smoke boot). Point the same script at the segregated tree (its only
   input is a directory + an entry file) — since no function body changed,
   this re-run is a **resolver equivalence check**, not a semantics check:
   if it still reaches `registerComponent`, every `require()` specifier
   segregation rewrote still resolves correctly. No new harness machinery.

The recompile round-trip (`src/harness`) and the VM trace/fuzz equivalence
checks are **unaffected by segregation and do not need to re-run** — they
operate per function on the CFG/bytecode, upstream of and blind to file
layout; segregation runs strictly after those checks have already passed on
the pre-segregation split tree.

**No silent loss (§2 `_unclassified/`, `_vendor/`).** Every module ends up
somewhere under `<out>/` — `unknown`-classified modules are never guessed
into `src/` or `node_modules/`; they get their own clearly-labelled bucket
so a wrong classification is visible as "uncategorised", never silently
merged into either bucket.

## 5. Metrics

Reuses `classify.ts`'s `ClassificationSummary` (already reports library-vs-
custom **by instruction weight**, DEPS.md "Classification" §) for the
headline number; segregation's own report (`SEGREGATION.json`) adds:

| Metric | Definition | Measured today (rn-template-0.72, HBC 94, 435 modules) |
|---|---|---|
| % modules → `node_modules/` (by count) | `library` modules / total | classify.ts corpus-free: 41.1% by weight (D17j, DEPS.md) |
| % modules → `node_modules/` named vs `_vendor/` | `moduleOwnership` hits / library modules | 2/435 named today (`react-native`, `react`, per DEPS.md seed run) |
| % app modules with a meaningful name | (custom modules named by 2.1 steps 1–6) / custom modules | **not yet measurable pre-implementation**; rn-template's only strong signal in the committed fixture is the entry module (registerComponent, step 2) — the template ships no screens/store, so this number will be near-floor (1/~250 custom modules) until measured on a router-heavy fixture |
| Screens detected | count of 3.2 hits | **0** on `rn-template-0.72` — confirmed by inspection (`grep -lE 'createStackNavigator\|createBottomTabNavigator\|createNativeStackNavigator'` on the split tree: 0 files) — this fixture is the bare RN template with no navigation, so 0 is the *correct* answer, not a signal miss |
| Navigators detected | count of 3.1 hits | 0 (same reason) |
| Stores detected | count of 3.3 hits | 0 (`createStore\|useSelector\|combineReducers`: 0 files; `StyleSheet.create`: 0 files — no redux, confirming the template has no app-level styling/state layer beyond the bare entry component) |
| registerComponent resolved | entry app name recovered | **1/1** — `HelloHermes072`, resolved through one require-hop from `module_434.js` (`{name: "HelloHermes072", displayName: "HelloHermes072"}`), exactly the "one-hop resolve" case 2.1 step 2 anticipates |

`rn-template-0.72` is the wrong fixture to validate screens/navigators/
stores on — it is deliberately minimal. `react-navigation-example-0.85.3`
(fetched via `tests/fixtures/bundles/*/fetch.sh`, already used by the deps
sweep per `docs/DEPS.md`'s seed-run table: 1,782 modules, HBC 98, real
`@react-navigation/{native,stack}` usage) is the right fixture to add these
metrics against; it is the acceptance fixture for screen/navigator detection.

## 6. Staging + open questions

### Milestone 4 — stores, component/util split, `SCREENS.md` generation
3.3, 3.4, and the D19 `SCREENS.md` index (route name → screen file →
components rendered) built from milestone 3's output.

