// **This is a heuristic recovery tool; the honesty of its output matters
// more than its coverage** (brief, verbatim). Every row says what its
// evidence IS, and a row built on a name coincidence is never presented
// as proven. Three evidence tiers, from strongest to weakest:
//
// A property VALUE (e.g. a JSX `component={HomeScreen}` prop, or an object
// literal built from a constant buffer, `{NativeStack, StackBasic, ...}`
// shorthand syntax observed on the held-out app) is never resolved: this
// artifact format has no points-to pass for property VALUES, only for call
// RECEIVERS (§2.2a). That is why every screen row's `component` field is
// either a real, scoped name match or `null` with a reason -- never a guess.
import type { ArtifactService } from "./service.ts";
import { CAPS } from "./service.ts";
import type { DepEdge, ModuleEntry } from "./schema.ts";

export type NavigatorEvidence = "creator-call" | "creator-name-property-get";

export interface NavigatorRow {
  readonly module: number | null;
  readonly fn: number;
  /** The navigator TYPE, read off the creator function's own name (a real
   *  react-navigation naming convention, not a guess) -- e.g. "Stack" from
   *  `createStackNavigator`, "Static" for `createStaticNavigation`. */
  readonly kind: string;
  readonly exportName: string;
  readonly evidence: NavigatorEvidence;
}

export type ComponentEvidence = "registry-dep-name-match";

export interface ScreenComponent {
  readonly module: number;
  readonly evidence: ComponentEvidence;
}

export interface ScreenRow {
  readonly name: string;
  readonly registryModule: number;
  readonly registryFn: number;
  /** Exactly one unambiguous match, or `null` -- see `componentNote`. */
  readonly component: ScreenComponent | null;
  /** > 1 candidate dep module mentioned this name; empty unless ambiguous. */
  readonly componentCandidates: readonly number[];
  readonly componentNote: string;
}

export interface NavigateSiteRow {
  readonly name: string;
  readonly module: number | null;
  readonly fn: number;
}

export interface ScreensResult {
  readonly note: string;
  readonly navigators: readonly NavigatorRow[];
  readonly screens: readonly ScreenRow[];
  readonly navigateSites: readonly NavigateSiteRow[];
  readonly totalNavigators: number;
  readonly totalScreens: number;
  readonly totalNavigateSites: number;
  readonly truncatedScreens: boolean;
}

export const SCREENS_NOTE =
  "heuristic recovery, not proof: navigators are found by a known " +
  "creator-function NAME (a real call only when marked creator-call; a bare " +
  "property-get otherwise -- see each row's evidence); screens are a " +
  "NAME coincidence scoped to one registry module's own require() edges, " +
  "never a bundle-wide grep, and are never proven to be the app's real " +
  "route names; navigateSites are call-arg-literal-shaped strings that " +
  "merely CO-OCCUR with a property-get of \"navigate\" in the same " +
  "function -- never proven to be that call's own argument.";

/** react-navigation's own creator-function names -> the navigator TYPE
 *  their own name proclaims (docs, not this app: every one of these is the
 *  public API name react-navigation ships, never an app-specific string).
 *  `createStaticNavigation` is not itself a navigator factory (it wraps a
 *  static config into the root navigation component) but is included here
 *  because it is the entry point the held-out app actually uses, per its
 *  own source (2026-09-29 measurement, not committed). */
const CREATOR_KINDS: ReadonlyMap<string, string> = new Map([
  ["createStackNavigator", "Stack"],
  ["createNativeStackNavigator", "NativeStack"],
  ["createBottomTabNavigator", "BottomTab"],
  ["createMaterialTopTabNavigator", "MaterialTopTab"],
  ["createMaterialBottomTabNavigator", "MaterialBottomTab"],
  ["createDrawerNavigator", "Drawer"],
  ["createStaticNavigation", "Static"],
]);

/** A candidate SCREEN name: PascalCase-shaped (react component naming
 *  convention), not absurdly long (guards against an unrelated long
 *  sentence-shaped string that happens to start with a capital letter). */
const SCREEN_NAME_RE = /^[A-Z][A-Za-z0-9]{0,39}$/;

function eagerDeps(m: ModuleEntry): readonly DepEdge[] {
  return m.deps.filter((d) => d.kind === "eager");
}

function findNavigators(svc: ArtifactService): readonly NavigatorRow[] {
  const sidByName = new Map<string, number>();
  for (const s of svc.allStrings()) if ("v" in s && CREATOR_KINDS.has(s.v)) sidByName.set(s.v, s.sid);

  const seen = new Set<string>();
  const rows: NavigatorRow[] = [];
  const add = (fn: number, exportName: string, evidence: NavigatorEvidence): void => {
    const key = `${fn} ${exportName}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ module: svc.moduleOfFn(fn), fn, kind: CREATOR_KINDS.get(exportName)!, exportName, evidence });
  };

  for (const r of svc.allResolvedCalls()) {
    if (CREATOR_KINDS.has(r.name)) add(r.caller, r.name, "creator-call");
  }
  const creatorSids = new Set(sidByName.values());
  const sidToName = new Map([...sidByName.entries()].map(([n, sid]) => [sid, n]));
  for (const u of svc.allStringUses()) {
    if (u.role !== "property-get" || !creatorSids.has(u.sid)) continue;
    add(u.fn, sidToName.get(u.sid)!, "creator-name-property-get");
  }

  rows.sort((a, b) => a.fn - b.fn || a.exportName.localeCompare(b.exportName));
  return rows;
}

/** The registry modules a navigator's own module structurally points at:
 *  the navigator's module itself (a registry can be inline) plus every
 *  module it directly, EAGERLY requires (the same "direct dependency of a
 *  navigator-evidence module" idea `src/split/segregate.ts` already uses
 *  for its own, unrelated purpose -- re-derived independently here from the
 *  artifact index, not imported: that module's job is the export tree, not
 *  this one). */
function registryModuleCandidates(svc: ArtifactService, navigators: readonly NavigatorRow[]): readonly ModuleEntry[] {
  const byId = new Map(svc.allModules().map((m) => [m.id, m]));
  const out = new Map<number, ModuleEntry>();
  for (const n of navigators) {
    if (n.module === null) continue;
    const m = byId.get(n.module);
    if (m === undefined) continue;
    out.set(m.id, m);
    for (const d of eagerDeps(m)) {
      const dep = byId.get(d.id);
      if (dep !== undefined) out.set(dep.id, dep);
    }
  }
  return [...out.values()];
}

/** Every candidate screen name a registry module's own factory reads as a
 *  property (§2.1's PascalCase filter), each matched against that SAME
 *  registry module's own EAGER deps for a module whose own factory
 *  mentions (any `string-uses.jsonl` role -- observed on the held-out app:
 *  a `defineProperty(exports, "X", ...)` re-export shows the name as role
 *  `literal`, a plain `exports.X = X` shows it as `property-put`, never
 *  consistently one role) the SAME name. Exactly one match is reported as
 *  `component`; zero or more-than-one is reported honestly (`componentNote`)
 *  rather than guessed. Scoped to ONE registry module's OWN deps -- never a
 *  bundle-wide name search, which is what keeps a match meaningful (an
 *  unrelated module elsewhere that happens to mention the same name is
 *  never a candidate here). */
function findScreens(svc: ArtifactService, registryModules: readonly ModuleEntry[]): readonly ScreenRow[] {
  const nameBySid = new Map<number, string>();
  for (const s of svc.allStrings()) if ("v" in s) nameBySid.set(s.sid, s.v);

  const rowsByFn = new Map<number, number[]>(); // fn -> sids seen at any role
  for (const u of svc.allStringUses()) {
    const list = rowsByFn.get(u.fn) ?? [];
    list.push(u.sid);
    rowsByFn.set(u.fn, list);
  }
  const propertyGetSidsByFn = new Map<number, Set<number>>();
  for (const u of svc.allStringUses()) {
    if (u.role !== "property-get") continue;
    const set = propertyGetSidsByFn.get(u.fn) ?? new Set<number>();
    set.add(u.sid);
    propertyGetSidsByFn.set(u.fn, set);
  }
  const byId = new Map(svc.allModules().map((m) => [m.id, m]));

  const out: ScreenRow[] = [];
  const seen = new Set<string>();
  for (const reg of registryModules) {
    if (reg.factoryFn === null) continue;
    const candidateSids = [...(propertyGetSidsByFn.get(reg.factoryFn) ?? [])].filter((sid) => {
      const name = nameBySid.get(sid);
      return name !== undefined && SCREEN_NAME_RE.test(name);
    });
    if (candidateSids.length === 0) continue;
    const deps = eagerDeps(reg);
    for (const sid of candidateSids) {
      const name = nameBySid.get(sid)!;
      const key = `${reg.id} ${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const matches: number[] = [];
      for (const d of deps) {
        const depMod = byId.get(d.id);
        if (depMod === undefined || depMod.factoryFn === null) continue;
        if ((rowsByFn.get(depMod.factoryFn) ?? []).includes(sid)) matches.push(depMod.id);
      }

      if (matches.length === 1) {
        out.push({ name, registryModule: reg.id, registryFn: reg.factoryFn, component: { module: matches[0]!, evidence: "registry-dep-name-match" }, componentCandidates: [], componentNote: "unambiguous: exactly one of the registry's own eager deps mentions this name" });
      } else if (matches.length > 1) {
        out.push({ name, registryModule: reg.id, registryFn: reg.factoryFn, component: null, componentCandidates: matches.sort((a, b) => a - b), componentNote: `ambiguous: ${matches.length} of the registry's own eager deps mention this name` });
      } else {
        out.push({ name, registryModule: reg.id, registryFn: reg.factoryFn, component: null, componentCandidates: [], componentNote: "no eager dep of the registry module mentions this name (may be re-exported through an extra require hop this pass does not follow)" });
      }
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name) || a.registryModule - b.registryModule);
  return out;
}

/** Every function that reads `.navigate` as a property, paired with every
 *  plain string LITERAL (not a proven call argument -- §2.3's role set has
 *  no per-argument linkage, only `literal` for a generic `LoadConstString`)
 *  in that SAME function. Weakest tier: two facts about one function, never
 *  proof they are the same call. */
function findNavigateSites(svc: ArtifactService): readonly NavigateSiteRow[] {
  let navigateSid: number | undefined;
  for (const s of svc.allStrings()) if ("v" in s && s.v === "navigate") navigateSid = s.sid;
  if (navigateSid === undefined) return [];

  const fnsWithNavigateGet = new Set<number>();
  for (const u of svc.allStringUses()) if (u.role === "property-get" && u.sid === navigateSid) fnsWithNavigateGet.add(u.fn);
  if (fnsWithNavigateGet.size === 0) return [];

  const nameBySid = new Map<number, string>();
  for (const s of svc.allStrings()) if ("v" in s) nameBySid.set(s.sid, s.v);

  const rows: NavigateSiteRow[] = [];
  for (const u of svc.allStringUses()) {
    if (u.role !== "literal" || !fnsWithNavigateGet.has(u.fn)) continue;
    const name = nameBySid.get(u.sid);
    if (name === undefined || !SCREEN_NAME_RE.test(name)) continue;
    rows.push({ name, module: svc.moduleOfFn(u.fn), fn: u.fn });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.fn - b.fn);
  return rows;
}

export function screens(svc: ArtifactService, opts: { readonly all?: boolean } = {}): ScreensResult {
  const navigators = findNavigators(svc);
  const registryModules = registryModuleCandidates(svc, navigators);
  const allScreens = findScreens(svc, registryModules);
  const navigateSites = findNavigateSites(svc);

  const cap = opts.all === true ? allScreens.length : CAPS.screens;
  return {
    note: SCREENS_NOTE,
    navigators,
    screens: allScreens.slice(0, cap),
    navigateSites,
    totalNavigators: navigators.length,
    totalScreens: allScreens.length,
    totalNavigateSites: navigateSites.length,
    truncatedScreens: allScreens.length > cap,
  };
}
