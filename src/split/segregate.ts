// src/split/segregate.ts — D17i stage 3, "milestone 1" (docs/specs/08-
// segregation.md §6): move an already-`--split` module tree into a real
// project layout — `node_modules/<pkg>/` for library-classified modules,
// `src/` for custom-classified ones, `_unclassified/` for anything
// `classify.ts` couldn't call either way (§4 "no silent loss") — and
// "milestone 2": name the `src/` modules from single-module signals (§2.1
// steps 1-5: entry, App-registration, displayName, default-export
// identifier, createSlice) instead of leaving every custom module
// `module_<id>.js`.
//
// Segregation changes zero semantics (spec §4): the only bytes this module
// ever rewrites are (a) a `require(...)` call's string-literal argument
// when the target module moved, (b) a renamed file's header comment (one
// line prepended, never touching the factory body itself), and (c) the
// loader `index.js`'s own bookkeeping (module registration `require()` list
// + the `Module._load` interception, now a MODULES.json-driven id->path map
// instead of a `module_<id>.js` filename regex, since milestone 2 gives
// modules free-form names/directories) — never a factory function's body.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClassificationReport, ModuleClassKind } from "../deps/classify.ts";
import type { DepsReport, ModuleOwnership } from "../deps/report.ts";

export type SegregationBucket = "src" | "node_modules" | "unclassified";

export interface SegregatedModuleInfo {
  readonly id: number;
  readonly originalFile: string;
  /** Path of the module's file, relative to the segregated tree's root
   *  (posix separators, e.g. `"src/App.js"`, `"src/store/counterSlice.js"`,
   *  `"src/module_5.js"` (no naming signal), `"node_modules/react-
   *  native/module_2.js"`, `"node_modules/_vendor/module_9.js"`). */
  readonly newPath: string;
  readonly bucket: SegregationBucket;
  readonly classification: ModuleClassKind | null;
  readonly package: string | null;
  /** Milestone 2 (§2.1): which naming step fired, if any (`null` for
   *  node_modules/unclassified modules and for `src/` modules with no
   *  signal above the confidence floor — those keep `module_<id>.js`). */
  readonly nameSignal: string | null;
  readonly nameConfidence: number | null;
}

/** §2.1 naming candidate for a single `src/`-bucket module: a step fired on
 *  the module's own decompiled text (plus, for `app-registration`, a cheap
 *  pattern check rather than a verified require-hop — see `detectAppRegistration`)
 *  and produced a base name plus the sub-directory it routes to (2.2). Not
 *  yet collision-resolved or floor-checked — `nameCustomModules` does both. */
interface NameCandidate {
  readonly baseName: string;
  readonly dir: "src" | "src/store" | "src/screens" | "src/navigation";
  readonly confidence: number;
  readonly signal: string;
}

const MIN_NAME_CONFIDENCE = 0.6; // spec §2.1 "Confidence floor", default; --min-name-confidence not wired yet (no caller passes a different value)

function detectAppRegistration(text: string): { confidence: number } | null {
  if (!text.includes("AppRegistry") || !text.includes(".registerComponent(")) return null;
  const call = /\.registerComponent\(\s*([^,]+),/.exec(text);
  if (call === null) return null;
  const arg = call[1]!.trim();
  if (/^(['"]).*\1$/.test(arg)) return { confidence: 0.95 }; // literal name argument
  // One-hop resolve shape confirmed on rn-template-0.72 module_0.js (spec
  // §2.1 step 2): `<v> = require("./module_N.js"); <v> = <v>.name;` feeding
  // the call — pattern-matched here, not content-verified against the
  // target module's text (milestone-2 scope simplification: the *file*
  // segregation names is always `App.js` regardless of the resolved
  // literal, which only ever seeds `package.json`'s `"name"` — not
  // implemented this milestone — so verifying the literal buys nothing yet).
  const hopRe = /(\w+)\s*=\s*require\((['"])\.\/module_\d+\.js\2\);\s*\n\s*\1\s*=\s*\1\.name;/;
  if (hopRe.test(text)) return { confidence: 0.8 };
  return null;
}

function detectDisplayName(text: string): { name: string; confidence: number } | null {
  const m = /\.displayName\s*=\s*(['"])([^'"]+)\1/.exec(text);
  return m === null ? null : { name: m[2]!, confidence: 0.9 };
}

function detectDefaultExportIdentifier(text: string): { name: string; confidence: number } | null {
  const declared = new Set<string>();
  for (const m of text.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1]!);
  for (const m of text.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)\b/g)) declared.add(m[1]!);
  declared.delete("factory"); // src/split/index.ts's own wrapper name, never a source identifier
  for (const m of text.matchAll(/\.exports(?:\.default)?\s*=\s*([A-Za-z_$][\w$]*)\s*;/g)) {
    const ident = m[1]!;
    if (declared.has(ident)) return { name: ident, confidence: 0.7 };
  }
  return null;
}

function detectCreateSlice(text: string): { name: string; confidence: number } | null {
  const m = /createSlice\(\s*\{[^}]*\bname:\s*(['"])([^'"]+)\1/.exec(text);
  return m === null ? null : { name: m[2]!, confidence: 0.9 };
}

/** §3.3 "the module itself is `src/store/index.js` regardless of any other
 *  signal" for `configureStore(...)`/`createStore(...)` (Redux's root-store
 *  constructors, as opposed to `createSlice`'s per-slice call). Confidence
 *  0.8: strong call-name evidence, one step below `createSlice`'s literal
 *  `name:` field (nothing to verify the call is actually Redux's, but the
 *  identifier pair is distinctive enough in practice). Milestone-3 scope:
 *  single-module only (the split store case §3.3 gestures at — one dep
 *  calling `configureStore` on reducers assembled in *other* modules — is
 *  not attempted; `SEGREGATION.json`'s recorded confidence/signal makes
 *  the gap visible rather than guessing at it, same "no silent loss" spirit
 *  as §4). */
function detectStoreRoot(text: string): { confidence: number } | null {
  return /\b(?:configureStore|createStore)\s*\(/.test(text) ? { confidence: 0.8 } : null;
}

// ---------------------------------------------------------------------------
// Milestone 3 (§3.1/3.2): navigator + screen detection. Real AST walking is
// what the spec calls for ("the one signal that can't be a regex", §3.2) —
// out of budget here, so this is a documented, narrower approximation: a
// single linear scan over the module's *own* decompiled text that tracks,
// per register, whether its current value originated from `require()`-ing
// one of this module's `deps` (MODULES.json's per-module dependency-id
// list, dependencyMap-index order). Confirmed against a real fixture
// (react-navigation-example-0.85.3, HBC 98): every split module's factory
// uses the fixed 7-param signature `factory(a1..a7)` (global, require,
// importDefault, importAll, module, exports, dependencyMap — src/split's
// own convention, `src/split/rewrite.ts`'s `params[1]`/`params[params.length
// - 1]`), so the require-param/dependencyMap-param names are hardcoded
// rather than re-derived per module.
const REQUIRE_PARAM_NAME = "a2";
const DEPMAP_PARAM_NAME = "a7";

/** Route/screen-descriptor object keys (react-navigation's `Navigator`
 *  config shape, both the static-config and dynamic `{screen, options}`
 *  entry shapes) — an object literal whose keys are *all* drawn from this
 *  set is a per-route descriptor, not the outer route-name -> target map
 *  §3.2 is after (both decompile to the same `{k: null, ...}` shape; this
 *  is the only way to tell them apart without a real parser + react-
 *  navigation's own type shapes). */
const ROUTE_DESCRIPTOR_KEYS = new Set(["screen", "component", "options", "initialParams", "path", "linking", "getComponent", "if", "layout", "navigationKey"]);

interface RouteKeyAssignment {
  readonly key: string;
  /** Resolved eagerly, at the point in the linear scan the `<objReg>.<key>
   *  = <valReg>;` assignment is seen — register reuse later in a large
   *  module (e.g. `r3` rebound to a *different* required module a few
   *  statements later) must not retroactively change what an *earlier*
   *  assignment resolved to, so this can't be a `valReg` string resolved
   *  in a second pass after the whole module has been scanned (that was
   *  this function's first, buggy shape: every key ended up resolving to
   *  whatever `valReg`'s reused register held *last*, not what it held at
   *  assignment time). */
  readonly targetId: number | undefined;
}

const TRACE_STMT_RE =
  /(?<reqTarget>[A-Za-z_$][\w$]*)\s*=\s*require\((['"])\.\/module_(?<reqId>\d+)\.js\2\)\s*;|(?<paramAliasTarget>[A-Za-z_$][\w$]*)\s*=\s*(?<paramSrc>a\d+)\s*;|(?<idxTarget>[A-Za-z_$][\w$]*)\s*=\s*(?<idxBase>[A-Za-z_$][\w$]*)\[(?:(?<idxNum>\d+)|(?<idxRegRef>[A-Za-z_$][\w$]*))\]\s*;|(?<numLitTarget>[A-Za-z_$][\w$]*)\s*=\s*(?<numLitVal>\d+)\s*;|(?<objTarget>[A-Za-z_$][\w$]*)\s*=\s*\{(?<objBody>(?:\s*[A-Za-z_$][\w$]*\s*:\s*null\s*,?)+)\}\s*;|(?<emptyObjTarget>[A-Za-z_$][\w$]*)\s*=\s*\{\}\s*;|(?<litTarget>[A-Za-z_$][\w$]*)\s*=\s*(?<litQuote>['"])(?<litVal>[^'"]*)\k<litQuote>\s*;|(?<keyCallObj>[A-Za-z_$][\w$]*)\.(?<keyCallName>component)\s*=\s*(?<keyCallFn>[A-Za-z_$][\w$]*)\((?<keyCallArg>[A-Za-z_$][\w$]*)\)\.(?<keyCallProp>[A-Za-z_$][\w$]*)\s*;|(?<reflectTarget>[A-Za-z_$][\w$]*)\s*=\s*Reflect\.apply\(\s*(?<reflectFn>[A-Za-z_$][\w$]*)\s*,\s*[A-Za-z_$][\w$]*\s*,\s*\[\s*(?<reflectArg>[A-Za-z_$][\w$]*)\s*\]\s*\)\s*;|(?<callTarget>[A-Za-z_$][\w$]*)\s*=\s*(?<callFn>[A-Za-z_$][\w$]*)\((?<callArg>[A-Za-z_$][\w$]*)\)\s*;|(?<keyObj>[A-Za-z_$][\w$]*)\.(?<keyName>[A-Za-z_$][\w$]*)\s*=\s*(?<keyVal>[A-Za-z_$][\w$]*)\s*;|(?<propBracketTarget>[A-Za-z_$][\w$]*)\s*=\s*(?<propBracketBase>[A-Za-z_$][\w$]*)\[(?<propBracketQuote>['"])default\k<propBracketQuote>\]\s*;|(?<propTarget>[A-Za-z_$][\w$]*)\s*=\s*(?<propBase>[A-Za-z_$][\w$]*)\.(?<propName>[A-Za-z_$][\w$]*)\s*;|(?<adjReg>[A-Za-z_$][\w$]*)\s*=\s*(?<adjSlot>_e\d+_\d+)\s*;\s*(?<adjObj>[A-Za-z_$][\w$]*)\.(?<adjKey>name|component)\s*=\s*\k<adjReg>\s*;|(?<envAliasTarget>_e\d+_\d+)\s*=\s*(?<envAliasSrc>[A-Za-z_$][\w$]*)\s*;|(?<envAliasTarget2>[A-Za-z_$][\w$]*)\s*=\s*(?<envAliasSrc2>_e\d+_\d+)\s*;/g;

/** Single left-to-right pass over `text` tracking, per register, which of
 *  this module's `deps` (in dependencyMap-index order) it currently traces
 *  back to (`moduleOriginByReg`), plus every `<objReg>.<key> = <valReg>`
 *  assignment seen where `objReg` was created as a route-name registry
 *  literal (`{Key1: null, Key2: null, ...}` with no
 *  `ROUTE_DESCRIPTOR_KEYS`-only keys, i.e. capitalised route names, not a
 *  `{screen, options}` descriptor) — `keyAssignments`. A `{screen: ...}`
 *  descriptor's own `.screen = <ref>` assignment is folded into
 *  `moduleOriginByReg` under the *descriptor's own* register, so resolving
 *  a route through one descriptor hop (`Home: {screen: Foo}`) and resolving
 *  a route straight to a required module (`NativeStack: requiredModule`)
 *  are the same lookup at the call site. Best-effort: register reuse in a
 *  large module can stomp an earlier binding (no scope/liveness tracking),
 *  so a route can come back unresolved even when the source has a genuine
 *  target — never a false positive in the cases checked, only missed
 *  positives (§3.2 "still flagged... unresolved" spirit, though this
 *  implementation doesn't separately surface the miss). */
function traceModuleOrigins(
  text: string,
  deps: readonly number[],
  scanJsxScreenProps: boolean,
  scanRouteConfigFactory: boolean,
  consumedByNavigator: boolean,
): { moduleOriginByReg: Map<string, number>; keyAssignments: readonly RouteKeyAssignment[] } {
  const paramAlias = new Map<string, "require" | "depmap">([
    [REQUIRE_PARAM_NAME, "require"],
    [DEPMAP_PARAM_NAME, "depmap"],
  ]);
  const depIndexByReg = new Map<string, number>();
  const moduleOriginByReg = new Map<string, number>();
  // 2026-09-03 (lazyRequire fix-wave, appgen triple d4e1aacf818f482d,
  // "tabs" router): resolves a `_eNNNN_M` closure-capture slot straight
  // from a self-contained `<reg> = require(<dep>); [<reg> = <reg>["default"
  // ]|.default;] <slot> = <reg>;` statement RUN, independent of this scan's
  // own left-to-right register tracking. Needed because Hermes inlines a
  // trivial `function loadFoo() { return require('./Foo').default; } const
  // Foo = loadFoo();` IIFE at module top level (no separate function
  // survives at all in the decompiled text), leaving the require + interop-
  // default hop + env-slot write at the *end* of the outer function body,
  // textually AFTER the nested `<Nav.Screen component={Foo} />`-building
  // closure that reads the slot back out -- a single forward pass over the
  // whole file text (this scan's only mode outside `scanRouteConfigFactory`
  // 's own warm-up rerun, see below) never sees the write in time to
  // resolve the read.
  const ENV_SLOT_ORIGIN_RE =
    /(?<reg>[A-Za-z_$][\w$]*)\s*=\s*require\((['"])\.\/module_(?<id>\d+)\.js\2\)\s*;\s*(?:\k<reg>\s*=\s*\k<reg>(?:\[(['"])default\4\]|\.default)\s*;\s*)?(?<slot>_e\d+_\d+)\s*=\s*\k<reg>\s*;/g;
  const envSlotOrigin = new Map<string, number>();
  if (scanJsxScreenProps) {
    for (const m of text.matchAll(ENV_SLOT_ORIGIN_RE)) {
      envSlotOrigin.set(m.groups!.slot!, Number(m.groups!.id));
    }
  }
  const numLitByReg = new Map<string, number>();
  const routeObjRegs = new Set<string>();
  const keyAssignments: RouteKeyAssignment[] = [];
  const stringLitByReg = new Map<string, string>();
  const jsxScreenPending = new Map<string, { name?: string; targetId?: number }>();
  const jsxScreenHits: RouteKeyAssignment[] = [];
  function flushJsxScreenPending(reg: string): void {
    const pending = jsxScreenPending.get(reg);
    if (pending?.name !== undefined && pending.targetId !== undefined) jsxScreenHits.push({ key: pending.name, targetId: pending.targetId });
    jsxScreenPending.delete(reg);
  }

  function runScan(): void {
    for (const m of text.matchAll(TRACE_STMT_RE)) {
    const g = m.groups!;
    if (g.reqTarget !== undefined) {
      moduleOriginByReg.set(g.reqTarget, Number(g.reqId));
    } else if (g.paramAliasTarget !== undefined) {
      const kind = paramAlias.get(g.paramSrc!);
      if (kind !== undefined) paramAlias.set(g.paramAliasTarget, kind);
    } else if (g.idxTarget !== undefined) {
      if (paramAlias.get(g.idxBase!) === "depmap") {
        // `idxNum` is the one-statement literal-bracket form (`r20[3]`);
        // `idxRegRef` is the two-statement form above (`r3[r]` where `r`
        // was set by a prior `r = 3;`) -- both resolve to the same depmap
        // index, just reached through a different register history.
        const idx = g.idxNum !== undefined ? Number(g.idxNum) : numLitByReg.get(g.idxRegRef!);
        if (idx !== undefined && idx >= 0 && idx < deps.length) depIndexByReg.set(g.idxTarget, idx);
      }
    } else if (g.numLitTarget !== undefined) {
      numLitByReg.set(g.numLitTarget, Number(g.numLitVal));
    } else if (g.objTarget !== undefined) {
      const keys = Array.from(g.objBody!.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*null/g)).map((k) => k[1]!);
      const looksLikeRouteNames = keys.length >= 2 && keys.every((k) => /^[A-Z]/.test(k));
      if (looksLikeRouteNames && !keys.every((k) => ROUTE_DESCRIPTOR_KEYS.has(k)) && (scanJsxScreenProps || scanRouteConfigFactory || consumedByNavigator))
        routeObjRegs.add(g.objTarget);
      if (scanJsxScreenProps) flushJsxScreenPending(g.objTarget); // register reused for the next screen (or an unrelated object) -- flush any complete pending pair first, then drop the rest
    } else if (g.emptyObjTarget !== undefined) {
      if (scanJsxScreenProps) flushJsxScreenPending(g.emptyObjTarget); // same reset/flush, for the JSX-props shape's own `obj = {};` starting point
    } else if (g.litTarget !== undefined) {
      if (scanJsxScreenProps) stringLitByReg.set(g.litTarget, g.litVal!);
    } else if (g.callTarget !== undefined) {
      const idx = depIndexByReg.get(g.callArg!);
      if (paramAlias.get(g.callFn!) === "require" && idx !== undefined) moduleOriginByReg.set(g.callTarget, deps[idx]!);
    } else if (g.reflectTarget !== undefined) {
      const idx = depIndexByReg.get(g.reflectArg!);
      if (scanRouteConfigFactory && paramAlias.get(g.reflectFn!) === "require" && idx !== undefined) moduleOriginByReg.set(g.reflectTarget, deps[idx]!);
    } else if (g.envAliasTarget !== undefined || g.envAliasTarget2 !== undefined) {
      if (scanRouteConfigFactory) {
        const target = g.envAliasTarget ?? g.envAliasTarget2!;
        const src = g.envAliasSrc ?? g.envAliasSrc2!;
        const kind = paramAlias.get(src);
        if (kind !== undefined) paramAlias.set(target, kind);
        const idx = depIndexByReg.get(src);
        if (idx !== undefined) depIndexByReg.set(target, idx);
        const origin = moduleOriginByReg.get(src);
        if (origin !== undefined) moduleOriginByReg.set(target, origin);
      }
    } else if (g.adjReg !== undefined) {
      // 2026-09-03 (lazyRequire fix-wave, appgen triple d4e1aacf818f482d,
      // "tabs" router): the two-adjacent-statements shape Hermes actually
      // produces for an inlined `function loadFoo() { return
      // require('./Foo').default; } const Foo = loadFoo();` top-level IIFE
      // -- `<reg> = _eNNNN_M;` immediately followed by `<obj>.name =
      // <reg>;`/`<obj>.component = <reg>;`, no statement in between.
      // Resolves straight from `envSlotOrigin` (computed once above), fed
      // into the SAME `jsxScreenPending` accumulation the `keyObj`/`keyName`
      // branch below uses for the ordinary (non-env-slot) case.
      //
      // Deliberately NOT a general "`<reg> = _eNNNN_M;` sets
      // `moduleOriginByReg` for `<reg>`, checked wherever `<reg>` is read
      // later" rule (tried first, reverted): `<reg>` is an ordinary,
      // reused-by-name register just like every other one this scan's own
      // doc comment already warns about, and once forwarded its origin has
      // no way to be invalidated by a later untraceable reassignment of the
      // same register (an object literal with a computed key, e.g. `r7 =
      // {["if"]: null, screens: null};`, matches none of this scan's
      // tracked shapes, so `moduleOriginByReg` for `r7` would keep the
      // stale forwarded value) -- confirmed regression: react-navigation-
      // example's own module 1621 reused `r7` for both an env-slot read
      // (importing the whole `react-native` barrel, module 6, for an
      // unrelated purpose) and, dozens of statements later, an untracked
      // object literal that fed a real `.Supported = r7;` route
      // assignment, which then wrongly inherited module 6's stale origin.
      // Requiring the read and the `.name=`/`.component=` use to be the
      // immediately next statement (this alternative's whole point) removes
      // that staleness window by construction -- no persistent
      // `moduleOriginByReg` entry for `<reg>` is ever created via an env
      // slot, so nothing can go stale.
      if (scanJsxScreenProps) {
        const origin = envSlotOrigin.get(g.adjSlot!);
        if (origin !== undefined) {
          const pending = jsxScreenPending.get(g.adjObj!) ?? {};
          if (g.adjKey === "name") {
            const lit = stringLitByReg.get(g.adjReg!);
            if (lit !== undefined) pending.name = lit;
          } else {
            pending.targetId = origin;
          }
          jsxScreenPending.set(g.adjObj!, pending);
        }
      }
    } else if (g.keyObj !== undefined) {
      if (routeObjRegs.has(g.keyObj) && /^[A-Z]/.test(g.keyName!)) keyAssignments.push({ key: g.keyName!, targetId: moduleOriginByReg.get(g.keyVal!) });
      if (scanRouteConfigFactory && /^[A-Z]/.test(g.keyName!) && !ROUTE_CONFIG_FACTORY_NAME_RE.test(g.keyName!)) {
        const origin = moduleOriginByReg.get(g.keyVal!);
        if (origin !== undefined) keyAssignments.push({ key: g.keyName!, targetId: origin });
      }
      if (g.keyName === "screen") {
        const origin = moduleOriginByReg.get(g.keyVal!);
        if (origin !== undefined) moduleOriginByReg.set(g.keyObj, origin);
      }
      if (scanRouteConfigFactory && g.keyName === "component") {
        // Forwards a descriptor object's own `.component = <resolved>;`
        // origin onto the descriptor register itself, exactly parallel to
        // the `.screen =` case above (a `{screen: Foo}` descriptor and a
        // `{component: Foo}` descriptor are the same shape under two
        // different react-navigation config conventions) -- gated on
        // `scanRouteConfigFactory` rather than shared with `.screen =`
        // unconditionally, since `component` alone (unlike `screen`) is
        // common enough as an unrelated prop name elsewhere that the extra
        // gate is worth keeping.
        const origin = moduleOriginByReg.get(g.keyVal!);
        if (origin !== undefined) moduleOriginByReg.set(g.keyObj, origin);
      }
      if (scanJsxScreenProps && (g.keyName === "name" || g.keyName === "component")) {
        const pending = jsxScreenPending.get(g.keyObj) ?? {};
        if (g.keyName === "name") {
          const lit = stringLitByReg.get(g.keyVal!);
          if (lit !== undefined) pending.name = lit;
        } else {
          const origin = moduleOriginByReg.get(g.keyVal!);
          if (origin !== undefined) pending.targetId = origin;
        }
        jsxScreenPending.set(g.keyObj, pending);
      }
    } else if (g.keyCallObj !== undefined) {
      const idx = depIndexByReg.get(g.keyCallArg!);
      if (paramAlias.get(g.keyCallFn!) === "require" && idx !== undefined && scanJsxScreenProps) {
        const origin = deps[idx]!;
        const pending = jsxScreenPending.get(g.keyCallObj) ?? {};
        pending.targetId = origin;
        jsxScreenPending.set(g.keyCallObj, pending);
      }
    } else if (g.propBracketTarget !== undefined) {
      const origin = moduleOriginByReg.get(g.propBracketBase!);
      if (origin !== undefined) moduleOriginByReg.set(g.propBracketTarget, origin);
    } else if (g.propTarget !== undefined) {
      const origin = moduleOriginByReg.get(g.propBase!);
      if (origin !== undefined) moduleOriginByReg.set(g.propTarget, origin);
    }
    }
  }

  // 2026-09-03 (lazyRequire fix-wave): NOT widened to `scanJsxScreenProps`
  // -- the inlined-loader env-slot read/write ordering problem this rerun
  // exists for is instead handled by the self-contained `envSlotOrigin`
  // regex above (computed once, no shared-state second pass needed);
  // widening this particular rerun to every `scanJsxScreenProps` module was
  // tried and reverted (see `envSlotOrigin`'s own comment) -- it reran this
  // whole scan's ordinary <reg>-tracking too, not just env slots, and that
  // is what regressed react-navigation-example's pinned navigator count.
  if (scanRouteConfigFactory) runScan(); // warm-up pass, see comment above -- populates env-slot aliases regardless of text order, discarded below
  routeObjRegs.clear();
  keyAssignments.length = 0;
  stringLitByReg.clear();
  jsxScreenPending.clear();
  jsxScreenHits.length = 0;
  runScan(); // real pass -- paramAlias/depIndexByReg/moduleOriginByReg from the warm-up (if any) carry over; every output collection above was just reset

  if (scanJsxScreenProps) {
    for (const pending of jsxScreenPending.values()) {
      if (pending.name !== undefined && pending.targetId !== undefined) jsxScreenHits.push({ key: pending.name, targetId: pending.targetId });
    }
  }
  return { moduleOriginByReg, keyAssignments: keyAssignments.concat(jsxScreenHits) };
}

interface ScreenHit {
  readonly routeName: string;
  readonly targetId: number;
  readonly confidence: number;
  readonly sourceId: number;
}

const ROUTE_CONFIG_FACTORY_NAME_RE = /routeConfig|[A-Za-z]*NavigationRoutes/;
function looksLikeRouteConfigFactory(text: string): boolean {
  if (new RegExp(`//\\s*fn#\\d+\\s+"(?:${ROUTE_CONFIG_FACTORY_NAME_RE.source})"`).test(text)) return true;
  return new RegExp(`[A-Za-z_$][\\w$]*\\.(?:${ROUTE_CONFIG_FACTORY_NAME_RE.source})\\s*=`).test(text);
}

function detectRouteConfigConsumer(text: string): boolean {
  return /\.entries\(/.test(text) && new RegExp(`\\.(?:${ROUTE_CONFIG_FACTORY_NAME_RE.source})\\b`).test(text);
}

/** §3.2, resolved via `traceModuleOrigins`: every route-registry key this
 *  module's text assigns whose value resolves to another module in `deps`
 *  is a screen hit — confidence 0.85 (spec's "literal route" tier; every
 *  hit here comes from a literal object key, never a computed one, so
 *  there is no lower-confidence "dynamic" case to distinguish in this
 *  implementation). */
function detectScreenHits(id: number, text: string, deps: readonly number[], consumedByNavigator: boolean): ScreenHit[] {
  const scanJsxScreenProps = detectNavigatorKind(text).length > 0;
  const scanRouteConfigFactory = looksLikeRouteConfigFactory(text);
  const { keyAssignments } = traceModuleOrigins(text, deps, scanJsxScreenProps, scanRouteConfigFactory, consumedByNavigator);
  const hits: ScreenHit[] = [];
  for (const a of keyAssignments) {
    if (a.targetId !== undefined) hits.push({ routeName: a.key, targetId: a.targetId, confidence: 0.85, sourceId: id });
  }
  return hits;
}

/** §3.1: a `create<X>Navigator(...)`/`createStaticNavigation(...)`-shaped
 *  call name (grep, per spec's own "reads: the module's decompiled text
 *  (grep for the call name)") plus at least one of this module's `deps`
 *  resolving (via `ownershipByModule`/`classByModule`, never re-derived) to
 *  `@react-navigation/*`. Deliberately looser than resolving the exact
 *  callee's require edge (`traceModuleOrigins` above, used for §3.2's
 *  route walk) — a 2000+-line real `App.tsx` reuses registers so heavily
 *  across unrelated code that pinning the *specific* call's origin register
 *  is unreliable; "this module both calls a Navigator factory and requires
 *  a react-navigation package" is the evidence the spec's own text
 *  describes checking for, and is enough to not be confused with an
 *  unrelated `createFooNavigator`-named local helper (the `deps` check is
 *  exactly the guard against that false positive). */
function detectNavigatorKind(text: string): readonly string[] {
  const kinds: string[] = [];
  for (const m of text.matchAll(/\.create([A-Za-z]+?)Navigator\b/g)) kinds.push(m[1]!);
  if (/\.createStaticNavigation\b/.test(text)) kinds.push("Static");
  if (kinds.length === 0 && detectRouteConfigConsumer(text)) kinds.push("");
  return kinds;
}

function moduleOwnsOrConsumesRouteConfig(text: string, deps: readonly number[]): boolean {
  if (detectRouteConfigConsumer(text)) return true;
  const scanJsxScreenProps = detectNavigatorKind(text).length > 0;
  // 2026-09-02 (generalization-sweep brief): `consumedByNavigator` fixed
  // `false` here -- this function has no reverse-dependency graph to check
  // (only `deps`, this module's own forward requires), and its job is
  // narrower than `detectScreenHits`'s ("does THIS module's own text show
  // ownership", used only to decide whether a bare-factory-reexport module
  // should still count as a navigator, §3.1) -- widening it would let the
  // one-hop consumer gate re-open exactly the shape-match-anywhere risk
  // this brief closes, for a check that doesn't need it (every fixture this
  // function's own tests pin already shows ownership in its OWN text).
  const { keyAssignments } = traceModuleOrigins(text, deps, scanJsxScreenProps, looksLikeRouteConfigFactory(text), false);
  return keyAssignments.length > 0;
}

function looksLikeBareFactoryReexportShape(text: string): boolean {
  const functionCount = (text.match(/\bfunction\s+[A-Za-z_$][\w$]*\s*\(/g) ?? []).length;
  return functionCount <= 1; // just the module's own top-level `factory(...)`, no nested closures
}

function detectNavigator(
  deps: readonly number[],
  text: string,
  ownershipByModule: ReadonlyMap<number, ModuleOwnership>,
  classByModule: ReadonlyMap<number, ModuleClassKind>,
  hasClassificationData: boolean,
): { kind: string; confidence: number } | null {
  const kinds = detectNavigatorKind(text);
  if (kinds.length === 0) return null;
  if (looksLikeBareFactoryReexportShape(text) && !moduleOwnsOrConsumesRouteConfig(text, deps)) return null;
  let confidence: number | null = null;
  for (const d of deps) {
    const pkg = ownershipByModule.get(d)?.package;
    if (pkg !== undefined && /^@react-navigation\//.test(pkg)) { confidence = 0.9; break; }
    if (classByModule.get(d) === "library") confidence = confidence ?? 0.6;
  }
  if (confidence !== null) return { kind: kinds[0]!, confidence };
  if (!hasClassificationData) return { kind: kinds[0]!, confidence: 0.6 };
  return null;
}

function nameCandidateFor(
  text: string,
  isEntry: boolean,
  bestScreenHit: { routeName: string; confidence: number } | null,
  navigator: { kind: string; confidence: number } | null,
  navigatorRouteNames: readonly string[] = [],
): NameCandidate | null {
  const appReg = detectAppRegistration(text);
  if (isEntry) {
    if (appReg !== null) return { baseName: "App", dir: "src", confidence: appReg.confidence, signal: "app-registration (entry module also calls registerComponent, §6 milestone-2 note)" };
    return { baseName: "index", dir: "src", confidence: 1.0, signal: "entry" };
  }
  if (appReg !== null) return { baseName: "App", dir: "src", confidence: appReg.confidence, signal: "app-registration" };
  if (bestScreenHit !== null) {
    const base = bestScreenHit.routeName;
    const baseName = /Screen$/.test(base) ? base : `${base}Screen`;
    return { baseName, dir: "src/screens", confidence: bestScreenHit.confidence, signal: `screen-route (route "${bestScreenHit.routeName}", §3.2)` };
  }
  const displayName = detectDisplayName(text);
  if (displayName !== null) return { baseName: displayName.name, dir: "src", confidence: displayName.confidence, signal: "displayName" };
  const defaultExport = detectDefaultExportIdentifier(text);
  if (defaultExport !== null) return { baseName: defaultExport.name, dir: "src", confidence: defaultExport.confidence, signal: "default-export-identifier" };
  const slice = detectCreateSlice(text);
  if (slice !== null) return { baseName: `${slice.name}Slice`, dir: "src/store", confidence: slice.confidence, signal: "createSlice" };
  const storeRoot = detectStoreRoot(text);
  if (storeRoot !== null) return { baseName: "index", dir: "src/store", confidence: storeRoot.confidence, signal: "store-root (configureStore/createStore, §3.3)" };
  if (navigator !== null) {
    const prefix = commonRoutePrefix(navigatorRouteNames);
    if (prefix !== null) {
      const baseName = /Navigator$/.test(prefix) ? prefix : `${prefix}Navigator`;
      return { baseName, dir: "src/navigation", confidence: navigator.confidence, signal: `navigator (route-set prefix "${prefix}", §3.1)` };
    }
    const role = navigatorRouteNames.length > 0 ? roleNameForRoutes(navigatorRouteNames, navigator.kind) : null;
    if (role !== null) {
      return { baseName: role, dir: "src/navigation", confidence: navigator.confidence, signal: `navigator (route-set role "${role}", §3.1)` };
    }
    const baseName = navigator.kind === "" ? "Navigator" : /Navigator$/.test(navigator.kind) ? navigator.kind : `${navigator.kind}Navigator`;
    const signal = navigator.kind === "" ? "navigator (destructured Navigator/Screen JSX usage, §3.1)" : `navigator (create${navigator.kind}Navigator-shaped call, §3.1)`;
    return { baseName, dir: "src/navigation", confidence: navigator.confidence, signal };
  }
  return null;
}

function commonRoutePrefix(routeNames: readonly string[]): string | null {
  if (routeNames.length === 0) return null;
  let prefix = routeNames[0]!;
  for (const name of routeNames.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix === "") return null;
  }
  for (let k = prefix.length; k > 0; k--) {
    const candidate = prefix.slice(0, k);
    const isBoundary = routeNames.every((n) => n.length === k || /[A-Z0-9]/.test(n[k] ?? ""));
    if (isBoundary) return candidate.length >= 3 ? candidate : null;
  }
  return null;
}

/** The leading "domain word" of a single route name, for `roleNameForRoutes`
 *  below: an all-caps abbreviation run immediately followed by a
 *  capitalised word (`"URL"` from `"URLParser"`, needs >= 2 letters so a
 *  single leading capital doesn't count as its own abbreviation), or
 *  failing that the first capitalised camelCase word (`"Profile"` from
 *  `"ProfileEdit"`, `"Home"` from `"Home"`, needs >= 3 letters — same
 *  degenerate-short-name floor `commonRoutePrefix` already applies to its
 *  own prefix). `null` for a route name with no usable leading word (not
 *  expected on real react-navigation route names, always PascalCase, but
 *  must not throw on anything unanticipated). */
function domainToken(name: string): string | null {
  const abbrev = /^[A-Z]+(?=[A-Z][a-z])/.exec(name);
  if (abbrev !== null && abbrev[0].length >= 2) return abbrev[0];
  const word = /^[A-Z][a-z0-9]*/.exec(name);
  if (word !== null && word[0].length >= 3) return word[0];
  return null;
}

function roleNameForRoutes(routeNames: readonly string[], kind: string): string | null {
  const MIN_ROLE_ROUTES = 4;
  if (routeNames.length < MIN_ROLE_ROUTES) return null;
  const counts = new Map<string, number>();
  let usable = 0;
  for (const name of routeNames) {
    const token = domainToken(name);
    if (token === null) continue;
    usable++;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  if (usable === 0) return null;
  let bestToken: string | null = null;
  let bestCount = 0;
  for (const name of routeNames) {
    const token = domainToken(name);
    if (token === null) continue;
    const count = counts.get(token)!;
    if (count > bestCount) { bestCount = count; bestToken = token; }
  }
  if (bestToken !== null && bestCount * 2 >= routeNames.length) {
    return /Navigator$/.test(bestToken) ? bestToken : `${bestToken}Navigator`;
  }
  return /tab/i.test(kind) ? "MainTabNavigator" : "RootNavigator";
}

function nameCustomModules(
  srcModules: readonly { id: number; text: string }[],
  entryId: number | null,
  depsByModuleId: ReadonlyMap<number, readonly number[]>,
  ownershipByModule: ReadonlyMap<number, ModuleOwnership>,
  classByModule: ReadonlyMap<number, ModuleClassKind>,
): Map<number, { path: string; signal: string; confidence: number } | null> {
  // No classification data at all (no `--deps-report`, i.e. `classByModule`
  // is empty) -- §3.1/3.2's deps-based guards below only ever *narrow*
  // results when there is something to narrow with, never manufacture one.
  const hasClassificationData = classByModule.size > 0;
  // 2026-09-02 (generalization-sweep brief): every module id that is a
  // *direct* dependency of some module in `srcModules` whose own text shows
  // navigator evidence (`detectNavigatorKind`/`detectRouteConfigConsumer`)
  // -- `detectScreenHits`'s `consumedByNavigator` parameter, computed once
  // here rather than per module (`traceModuleOrigins` has no reverse-
  // dependency graph of its own to consult). One hop only, see
  // `traceModuleOrigins`'s own comment on this parameter for why not a
  // transitive closure.
  const navigatorConnectedIds = new Set<number>();
  for (const m of srcModules) {
    if (detectNavigatorKind(m.text).length > 0 || detectRouteConfigConsumer(m.text)) {
      for (const dep of depsByModuleId.get(m.id) ?? []) navigatorConnectedIds.add(dep);
    }
  }
  // Milestone 3 (§3.2): every screen hit any src-bucket module's route
  // registry produced, keyed by *target* module id — a target can in
  // principle be claimed by more than one registry (e.g. re-exported under
  // two route names); kept deterministic by highest confidence, then
  // lowest source module id, then route name, never run order.
  const hitsByTarget = new Map<number, ScreenHit[]>();
  const routeNamesBySource = new Map<number, string[]>();
  for (const m of srcModules) {
    for (const hit of detectScreenHits(m.id, m.text, depsByModuleId.get(m.id) ?? [], navigatorConnectedIds.has(m.id))) {
      if (hasClassificationData && classByModule.get(hit.targetId) !== "custom") continue;
      const list = hitsByTarget.get(hit.targetId);
      if (list === undefined) hitsByTarget.set(hit.targetId, [hit]);
      else list.push(hit);
      const srcList = routeNamesBySource.get(hit.sourceId);
      if (srcList === undefined) routeNamesBySource.set(hit.sourceId, [hit.routeName]);
      else srcList.push(hit.routeName);
    }
  }
  const bestScreenHitByTarget = new Map<number, { routeName: string; confidence: number }>();
  for (const [targetId, hits] of hitsByTarget) {
    hits.sort((a, b) => b.confidence - a.confidence || a.sourceId - b.sourceId || a.routeName.localeCompare(b.routeName));
    bestScreenHitByTarget.set(targetId, { routeName: hits[0]!.routeName, confidence: hits[0]!.confidence });
  }

  for (const m of srcModules) {
    if (!detectRouteConfigConsumer(m.text)) continue;
    const names: string[] = routeNamesBySource.get(m.id) ?? [];
    for (const dep of depsByModuleId.get(m.id) ?? []) {
      const depNames = routeNamesBySource.get(dep);
      if (depNames !== undefined) names.push(...depNames);
    }
    if (names.length > 0) routeNamesBySource.set(m.id, names);
  }

  const raw = new Map<number, NameCandidate | null>();
  for (const m of srcModules) {
    const navigator = detectNavigator(depsByModuleId.get(m.id) ?? [], m.text, ownershipByModule, classByModule, hasClassificationData);
    raw.set(m.id, nameCandidateFor(m.text, m.id === entryId, bestScreenHitByTarget.get(m.id) ?? null, navigator, routeNamesBySource.get(m.id) ?? []));
  }

  const byPath = new Map<string, number[]>();
  for (const [id, cand] of raw) {
    if (cand === null || cand.confidence < MIN_NAME_CONFIDENCE) continue;
    const path = cand.dir === "src" ? `src/${cand.baseName}.js` : `${cand.dir}/${cand.baseName}.js`;
    const list = byPath.get(path);
    if (list === undefined) byPath.set(path, [id]);
    else list.push(id);
  }

  const finalPathById = new Map<number, string>();
  for (const [path, ids] of byPath) {
    ids.sort((a, b) => a - b); // id-ordered collision suffixing (spec §2.1 "Collisions"; open Q 6.2: ordinal vs. hash — default ordinal)
    ids.forEach((id, i) => {
      if (i === 0) { finalPathById.set(id, path); return; }
      const dot = path.lastIndexOf(".js");
      finalPathById.set(id, `${path.slice(0, dot)}.${i + 1}${path.slice(dot)}`);
    });
  }

  const result = new Map<number, { path: string; signal: string; confidence: number } | null>();
  for (const [id, cand] of raw) {
    const path = finalPathById.get(id);
    result.set(id, path === undefined || cand === null ? null : { path, signal: cand.signal, confidence: cand.confidence });
  }
  return result;
}

export interface SegregateResult {
  /** Every file to write, keyed by path relative to the segregated tree's
   *  root — module files, the rewritten `index.js` loader, and the
   *  annotated `MODULES.json`. */
  readonly files: ReadonlyMap<string, string>;
  readonly modules: readonly SegregatedModuleInfo[];
}

interface SplitModulesJson {
  readonly hbcVersion: number;
  readonly moduleCount: number;
  readonly entry: number | null;
  readonly modules: readonly { id: number; file: string; factoryFunctionIndex: number; deps: readonly number[] }[];
}

const REQUIRE_RE = /require\((['"])\.\/module_(\d+)\.js\1\)/g;

/** The exact `Module._load` interception block `buildLoaderIndexJs`
 *  (src/split/index.ts) always emits — literal source text, not a JS
 *  RegExp value. Milestone 1 could get away with loosening this to a
 *  filename-suffix match (`/module_(\d+)\.js$/`) because every module kept
 *  its `module_<id>.js` name, just in a new directory. Milestone 2 gives
 *  `src/` modules free-form names (`App.js`, `store/counterSlice.js`, ...),
 *  so recovering a module id from the request string by filename no longer
 *  works at all — this whole block is replaced (see `buildPathMapLoadBlock`
 *  below) with a static id->absolute-path map built from the same
 *  `idToNewPath` this module already computes, resolved once against
 *  `index.js`'s own directory (the segregated tree's root). */
const LOADER_LOAD_BLOCK = [
  `var __hbc_split_Module = require("module");`,
  `var __hbc_split_origLoad = __hbc_split_Module._load;`,
  `__hbc_split_Module._load = function (request, parent, isMain) {`,
  `  var m = /^\\.\\/module_(\\d+)\\.js$/.exec(request);`,
  `  if (m) return __r(Number(m[1]));`,
  `  return __hbc_split_origLoad.apply(this, arguments);`,
  `};`,
].join("\n");

function buildPathMapLoadBlock(modules: readonly { id: number; file: string }[], idToNewPath: ReadonlyMap<number, string>): string {
  const lines: string[] = [];
  lines.push(`var __hbc_split_path = require("path");`);
  lines.push(`var __hbc_split_Module = require("module");`);
  lines.push(`var __hbc_split_origLoad = __hbc_split_Module._load;`);
  lines.push(`var __hbc_split_idByAbsPath = new Map();`);
  for (const m of modules) {
    const target = idToNewPath.get(m.id);
    if (target === undefined) continue;
    lines.push(`__hbc_split_idByAbsPath.set(__hbc_split_path.join(__dirname, ${JSON.stringify(target)}), ${m.id});`);
  }
  lines.push(`__hbc_split_Module._load = function (request, parent, isMain) {`);
  lines.push(`  if (parent && typeof request === "string" && request.charAt(0) === ".") {`);
  lines.push(`    var __hbc_resolved = __hbc_split_path.resolve(__hbc_split_path.dirname(parent.filename), request);`);
  lines.push(`    var __hbc_id = __hbc_split_idByAbsPath.get(__hbc_resolved);`);
  lines.push(`    if (__hbc_id !== undefined) return __r(__hbc_id);`);
  lines.push(`  }`);
  lines.push(`  return __hbc_split_origLoad.apply(this, arguments);`);
  lines.push(`};`);
  return lines.join("\n");
}

function packageDirName(pkg: string): string {
  // Scoped packages (`@scope/name`) become a two-level `node_modules/`
  // directory, same as npm itself — no sanitisation needed beyond that,
  // `pkg` comes from `moduleOwnership.package`, already a valid npm name.
  return pkg;
}

/** Posix-relative require specifier from `fromPath` (a file's own new path,
 *  relative to the segregated tree root) to `toPath` (another file's new
 *  path), always `./`- or `../`-prefixed. */
function relativeRequire(fromPath: string, toPath: string): string {
  const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const fromParts = fromDir === "" ? [] : fromDir.split("/");
  const toParts = toPath.split("/");
  let i = 0;
  while (i < fromParts.length && i < toParts.length - 1 && fromParts[i] === toParts[i]) i++;
  const ups = fromParts.length - i;
  const downs = toParts.slice(i);
  const rel = [...Array(ups).fill(".."), ...downs].join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function rewriteRequireStrings(content: string, ownPath: string, idToNewPath: ReadonlyMap<number, string>): string {
  return content.replace(REQUIRE_RE, (whole, quote: string, idStr: string) => {
    const id = Number(idStr);
    const target = idToNewPath.get(id);
    if (target === undefined) return whole; // unreachable in practice: every id in MODULES.json has a bucket
    const spec = relativeRequire(ownPath, target);
    return `require(${quote}${spec}${quote})`;
  });
}

/** Rewrites the `--split` loader's `index.js` (src/split/index.ts
 *  `buildLoaderIndexJs`) to (a) require every module from its new path and
 *  (b) recognise a require request for a moved module regardless of its
 *  new directory (see `LOADER_INTERCEPT_RE_SOURCE`). Structural changes to
 *  the loader's own bookkeeping, not a module factory body — outside the
 *  scope of the §4.1 byte-diff proof, which is about `module_<id>.js`
 *  files only. */
function rewriteLoaderIndexJs(original: string, modules: readonly { id: number; file: string }[], idToNewPath: ReadonlyMap<number, string>): string {
  let out = original;
  for (const m of modules) {
    const target = idToNewPath.get(m.id);
    if (target === undefined) continue;
    const oldReq = `require('./${m.file}');`;
    const newReq = `require('./${target}');`;
    out = out.split(oldReq).join(newReq);
  }
  if (!out.includes(LOADER_LOAD_BLOCK)) throw new Error("segregate: index.js did not contain the expected Module._load interception pattern");
  return out.split(LOADER_LOAD_BLOCK).join(buildPathMapLoadBlock(modules, idToNewPath));
}

export function segregateSplitTree(splitFiles: ReadonlyMap<string, string>, deps: DepsReport | null): SegregateResult {
  const modulesJsonText = splitFiles.get("MODULES.json");
  if (modulesJsonText === undefined) throw new Error("segregate: split tree has no MODULES.json");
  const modulesJson = JSON.parse(modulesJsonText) as SplitModulesJson;

  const classification: ClassificationReport | null = deps?.classification ?? null;
  const classByModule = new Map<number, ModuleClassKind>();
  if (classification !== null) {
    for (const c of classification.modules) if (c.localModuleId !== null) classByModule.set(c.localModuleId, c.classification);
  }
  const ownershipByModule = new Map<number, ModuleOwnership>();
  if (deps !== null) {
    for (const o of deps.moduleOwnership) if (o.localModuleId !== null) ownershipByModule.set(o.localModuleId, o);
  }

  const idToNewPath = new Map<number, string>();
  const infos: SegregatedModuleInfo[] = [];
  for (const m of modulesJson.modules) {
    const cls = classByModule.get(m.id) ?? null;
    const owner = ownershipByModule.get(m.id);
    let bucket: SegregationBucket;
    let newPath: string;
    let pkg: string | null = null;
    if (owner !== undefined) {
      bucket = "node_modules";
      pkg = owner.package;
      newPath = `node_modules/${packageDirName(pkg)}/module_${m.id}.js`;
    } else if (cls === "library") {
      bucket = "node_modules";
      newPath = `node_modules/_vendor/module_${m.id}.js`;
    } else if (cls === "custom") {
      bucket = "src";
      newPath = `src/module_${m.id}.js`;
    } else {
      bucket = "unclassified";
      newPath = `_unclassified/module_${m.id}.js`;
    }
    idToNewPath.set(m.id, newPath);
    infos.push({ id: m.id, originalFile: m.file, newPath, bucket, classification: cls, package: pkg, nameSignal: null, nameConfidence: null });
  }
  infos.sort((a, b) => a.id - b.id);

  // Milestone 2 (§2.1 steps 1-5): name every `src`-bucket module from its
  // own decompiled text (plus entry-ness from MODULES.json) — never
  // node_modules modules.
  const srcTexts: { id: number; text: string }[] = [];
  for (const info of infos) {
    if (info.bucket !== "src" && info.bucket !== "unclassified") continue;
    const text = splitFiles.get(info.originalFile);
    if (text === undefined) throw new Error(`segregate: split tree has no file for module ${info.id} (${info.originalFile})`);
    srcTexts.push({ id: info.id, text });
  }
  const depsByModuleId = new Map<number, readonly number[]>(modulesJson.modules.map((m) => [m.id, m.deps]));
  const namesById = nameCustomModules(srcTexts, modulesJson.entry, depsByModuleId, ownershipByModule, classByModule);
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i]!;
    if (info.bucket !== "src" && info.bucket !== "unclassified") continue;
    const named = namesById.get(info.id) ?? null;
    if (named === null) continue;
    idToNewPath.set(info.id, named.path);
    infos[i] = { ...info, bucket: "src", newPath: named.path, nameSignal: named.signal, nameConfidence: named.confidence };
  }

  const files = new Map<string, string>();
  for (const info of infos) {
    const original = splitFiles.get(info.originalFile);
    if (original === undefined) throw new Error(`segregate: split tree has no file for module ${info.id} (${info.originalFile})`);
    const rewritten = rewriteRequireStrings(original, info.newPath, idToNewPath);
    const withHeader =
      info.nameSignal === null
        ? rewritten
        : `// hbc2js segregate -- Metro module ${info.id} (was module_${info.id}.js; named via ${info.nameSignal}, confidence ${info.nameConfidence!.toFixed(2)})\n${rewritten}`;
    files.set(info.newPath, withHeader);
  }

  const originalIndexJs = splitFiles.get("index.js");
  if (originalIndexJs === undefined) throw new Error("segregate: split tree has no index.js");
  files.set("index.js", rewriteLoaderIndexJs(originalIndexJs, modulesJson.modules, idToNewPath));

  files.set(
    "MODULES.json",
    JSON.stringify(
      {
        ...modulesJson,
        modules: modulesJson.modules.map((m) => {
          const info = infos.find((i) => i.id === m.id)!;
          return { ...m, segregated: { path: info.newPath, bucket: info.bucket, classification: info.classification, package: info.package, nameSignal: info.nameSignal, nameConfidence: info.nameConfidence } };
        }),
      },
      null,
      2,
    ) + "\n",
  );

  // Every other file in the split tree (there are none today besides the
  // three above — `splitProject` only ever emits module files, `index.js`,
  // `MODULES.json`) is intentionally not carried forward unmodified: if a
  // future split-tree gains a new top-level file this throws loudly at the
  // caller instead of silently shipping something segregation never
  // reasoned about.
  for (const [name] of splitFiles) {
    if (name === "index.js" || name === "MODULES.json") continue;
    if (!infos.some((i) => i.originalFile === name)) {
      throw new Error(`segregate: split tree has an unexpected top-level file ${name} segregation does not know how to place`);
    }
  }

  return { files, modules: infos };
}

/** Reads a `--split`-written directory (top-level files only —
 *  `writeSplitResult`/`splitProject` never nest) into the
 *  `Map<string, string>` `segregateSplitTree` expects. */
export function readSplitDir(splitDir: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(splitDir)) {
    files.set(name, readFileSync(join(splitDir, name), "utf8"));
  }
  return files;
}

export function writeSegregateResult(result: SegregateResult, outDir: string): void {
  for (const [relPath, content] of result.files) {
    const dest = join(outDir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
}
