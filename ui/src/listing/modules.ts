// ui/src/listing/modules.ts — the left pane's tree shape, as pure functions
// so the gate can reason about them without a browser. Spec 22 §3.2: the
// module tree groups third-party packages (`node_modules/<pkg>`) apart from
// the app's own modules, because in a large bundle 90% of the modules are
// someone else's and collapsing them is the first thing an analyst does.
import type { FunctionListRow, ModuleEntry, SegregationPage, SegregationRow } from "./wire.ts";
import type { ModuleSourceFn } from "../contracts.ts";

export type GroupKind = "screens" | "navigation" | "app" | "pkg" | "unclassified" | "other";

export interface ModuleGroup {
  /** Stable key for React and for the open/closed set. */
  readonly key: string;
  readonly label: string;
  readonly kind: GroupKind;
  readonly modules: readonly ModuleEntry[];
  readonly defaultOpen?: boolean;
}

/** `node_modules/@scope/name/...` -> `@scope/name`; `node_modules/name/...`
 *  -> `name`; anything else -> null. Tolerates leading `./`, `../` and
 *  Windows separators (Metro emits both on different platforms). */
export function packageOf(file: string): string | null {
  const norm = file.replace(/\\/g, "/");
  const i = norm.lastIndexOf("node_modules/");
  if (i < 0) return null;
  const rest = norm.slice(i + "node_modules/".length).split("/").filter((s) => s.length > 0);
  if (rest.length === 0) return null;
  const head = rest[0]!;
  if (head.startsWith("@")) return rest.length > 1 ? `${head}/${rest[1]!}` : head;
  return head;
}

/** The group a module belongs to. App modules all land in one `src/` group;
 *  each package gets its own. Unknown/empty paths get `(no path)`. */
export function groupKeyOf(file: string | null): { readonly key: string; readonly label: string; readonly kind: GroupKind } {
  if (file === null || file.trim() === "") return { key: "other", label: "(no path)", kind: "other" };
  const pkg = packageOf(file);
  if (pkg !== null) return { key: `pkg:${pkg}`, label: `node_modules/${pkg}`, kind: "pkg" };
  return { key: "app", label: "src/", kind: "app" };
}

/** Group + sort: the app's own modules first, then packages alphabetically,
 *  then the unknown-path bucket. Modules inside a group sort by path. */
export function groupModules(rows: readonly ModuleEntry[]): readonly ModuleGroup[] {
  const byKey = new Map<string, { label: string; kind: GroupKind; modules: ModuleEntry[] }>();
  for (const m of rows) {
    const g = groupKeyOf(m.file);
    let bucket = byKey.get(g.key);
    if (bucket === undefined) {
      bucket = { label: g.label, kind: g.kind, modules: [] };
      byKey.set(g.key, bucket);
    }
    bucket.modules.push(m);
  }
  const rank: Record<GroupKind, number> = { screens: 0, navigation: 0, app: 0, pkg: 1, other: 2, unclassified: 2 };
  return [...byKey.entries()]
    .map(([key, b]) => ({
      key,
      label: b.label,
      kind: b.kind,
      modules: [...b.modules].sort((a, c) => a.file.localeCompare(c.file) || a.id - c.id),
    }))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.label.localeCompare(b.label));
}

/** `fn` rows bucketed by owning module, each bucket sorted by fn id. Rows
 *  with `module === null` are dropped: they belong to no module row. */
export function functionsByModule(rows: readonly FunctionListRow[]): ReadonlyMap<number, readonly FunctionListRow[]> {
  const out = new Map<number, FunctionListRow[]>();
  for (const r of rows) {
    if (r.module === null) continue;
    const bucket = out.get(r.module);
    if (bucket === undefined) out.set(r.module, [r]);
    else bucket.push(r);
  }
  for (const bucket of out.values()) bucket.sort((a, b) => a.fn - b.fn);
  return out;
}

/** The label a function row shows: its name, or `fn N` when the bundle
 *  stripped it (minified bundles strip most of them). */
export function fnLabel(row: { readonly fn: number; readonly name: string | null }): string {
  return row.name !== null && row.name !== "" ? row.name : `fn ${row.fn}`;
}

/** The module path, shortened for the tree: the part after the group prefix. */
export function moduleLabel(m: ModuleEntry): string {
  const pkg = packageOf(m.file);
  if (pkg === null) return m.file === "" ? `module ${m.id}` : m.file;
  const norm = m.file.replace(/\\/g, "/");
  const marker = `node_modules/${pkg}/`;
  const i = norm.lastIndexOf(marker);
  return i < 0 ? norm : norm.slice(i + marker.length);
}

export const SCREENS_PREFIX = "src/screens/";
export const NAVIGATION_PREFIX = "src/navigation/";

/** Group keys, in the order the tree shows them. Packages sort alphabetically
 *  between `app` and `unclassified`. */
export const SCREENS_KEY = "seg:screens";
export const NAVIGATION_KEY = "seg:navigation";
export const APP_KEY = "seg:app";
export const UNCLASSIFIED_KEY = "seg:unclassified";

/** Last path segment: `src/screens/HomeScreen.js` -> `HomeScreen.js`. */
export function basenameOf(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i < 0 ? norm : norm.slice(i + 1);
}

/** The row's primary label in the tree: the basename of its recovered path,
 *  falling back to the flat-tree label when the module has no segregation
 *  row (a module added since the server cached its segregation). The `id` is
 *  never lost — `LeftPane` renders `module_<id>` beside this as a dim
 *  secondary label. */
export function moduleLabelSegregated(m: ModuleEntry, info: SegregationRow | undefined): string {
  return info === undefined ? moduleLabel(m) : basenameOf(info.path);
}

/** `SegregationRow`s by module id — built once per fetch, read per row. */
export function segregationById(seg: SegregationPage | null): ReadonlyMap<number, SegregationRow> {
  const out = new Map<number, SegregationRow>();
  if (seg !== null) for (const r of seg.modules) out.set(r.id, r);
  return out;
}

/** Which group a segregated module belongs in. `node_modules` modules with no
 *  identified package land in one `_vendor` group (that is exactly the
 *  directory `segregate.ts` puts them in). */
function segGroupOf(info: SegregationRow): { readonly key: string; readonly label: string; readonly kind: GroupKind } {
  if (info.bucket === "unclassified") return { key: UNCLASSIFIED_KEY, label: "Unclassified", kind: "unclassified" };
  if (info.bucket === "node_modules") {
    const pkg = info.package ?? packageOf(info.path) ?? "_vendor";
    return { key: `pkg:${pkg}`, label: `node_modules/${pkg}`, kind: "pkg" };
  }
  if (info.path.startsWith(SCREENS_PREFIX)) return { key: SCREENS_KEY, label: "Screens", kind: "screens" };
  if (info.path.startsWith(NAVIGATION_PREFIX)) return { key: NAVIGATION_KEY, label: "Navigation", kind: "navigation" };
  return { key: APP_KEY, label: "App", kind: "app" };
}

const SEG_RANK: Record<GroupKind, number> = { screens: 0, navigation: 1, app: 2, pkg: 3, other: 4, unclassified: 5 };

export function groupModulesSegregated(rows: readonly ModuleEntry[], seg: SegregationPage | null): readonly ModuleGroup[] {
  if (seg === null) return groupModules(rows);
  const byId = segregationById(seg);
  const byKey = new Map<string, { label: string; kind: GroupKind; modules: ModuleEntry[] }>();
  const labelFor = new Map<number, string>();
  for (const m of rows) {
    const info = byId.get(m.id);
    const g = info === undefined ? { key: UNCLASSIFIED_KEY, label: "Unclassified", kind: "unclassified" as GroupKind } : segGroupOf(info);
    labelFor.set(m.id, moduleLabelSegregated(m, info));
    let bucket = byKey.get(g.key);
    if (bucket === undefined) {
      bucket = { label: g.label, kind: g.kind, modules: [] };
      byKey.set(g.key, bucket);
    }
    bucket.modules.push(m);
  }
  return [...byKey.entries()]
    .map(([key, b]) => ({
      key,
      label: b.label,
      kind: b.kind,
      defaultOpen: b.kind === "screens" || b.kind === "navigation",
      modules: [...b.modules].sort((a, c) => (labelFor.get(a.id) ?? "").localeCompare(labelFor.get(c.id) ?? "") || a.id - c.id),
    }))
    .sort((a, b) => SEG_RANK[a.kind] - SEG_RANK[b.kind] || a.label.localeCompare(b.label));
}

/** The keys `LeftPane` opens on first paint. */
export function defaultOpenGroups(groups: readonly ModuleGroup[]): readonly string[] {
  return groups.filter((g) => g.defaultOpen === true).map((g) => g.key);
}

/** Filters the tree to the groups/modules matching `query` (case-insensitive
 *  substring over the group label and each module's own label): a group whose
 *  LABEL matches keeps all of its modules, otherwise it keeps only the
 *  matching ones and is dropped when none match. Empty/blank query = no
 *  filtering, same array back. The query string itself comes from the top
 *  bar's search store — this never keeps its own. */
export function filterGroups(
  groups: readonly ModuleGroup[],
  query: string,
  labelOf: (m: ModuleEntry) => string,
): readonly ModuleGroup[] {
  const q = query.trim().toLowerCase();
  if (q === "") return groups;
  const out: ModuleGroup[] = [];
  for (const g of groups) {
    if (g.label.toLowerCase().includes(q)) {
      out.push(g);
      continue;
    }
    const modules = g.modules.filter((m) => labelOf(m).toLowerCase().includes(q));
    if (modules.length > 0) out.push({ ...g, modules });
  }
  return out;
}

/** One row of the flattened tree — what the keyboard cursor and the
 *  virtualizer both walk. */
export type TreeRow =
  | { readonly kind: "group"; readonly key: string; readonly label: string; readonly count: number; readonly open: boolean }
  | { readonly kind: "module"; readonly key: string; readonly module: ModuleEntry; readonly count: number; readonly open: boolean; readonly depth: number }
  | { readonly kind: "fn"; readonly key: string; readonly row: ModuleSourceFn; readonly depth: number }
  /** A screen -> screen navigation arrow (spec 26 L4), emitted under an open
   *  screen module by `flattenTree`'s `extras.rowsAfter`. `confidence` is the
   *  server's own provenance: `"by-name"` edges are drawn dashed, exactly as
   *  the by-name xref candidates are. */
  | {
      readonly kind: "nav";
      readonly key: string;
      readonly from: number;
      readonly to: number;
      readonly label: string;
      readonly confidence: "points-to" | "by-name";
      readonly depth: number;
    };

/** Optional per-module hooks the screens tree (`./screens.ts`) supplies: an
 *  indentation depth (a sub-screen sits under its parent screen) and extra
 *  rows to emit inside an open module (its navigation arrows). Absent = the
 *  flat behaviour every other group has always had. */
export interface TreeExtras {
  readonly depthOf?: (m: ModuleEntry) => number | undefined;
  readonly rowsAfter?: (m: ModuleEntry) => readonly TreeRow[];
}

/** `groups` (already the source of truth for what filtering/segregation
 *  produced — `filterGroups`'s output is a legal input here, same shape)
 *  flattened into the rows the virtualizer renders. A group's modules are
 *  skipped entirely when the group is closed, and a module's functions are
 *  skipped when the module is closed, so a fully-collapsed 4,500-module tree
 *  is still only ~a few hundred rows (one per group + top-level module). */
export function flattenTree(
  groups: readonly ModuleGroup[],
  openGroups: ReadonlySet<string>,
  openModules: ReadonlySet<string>,
  functionsOf: (moduleId: number) => readonly ModuleSourceFn[],
  extras: TreeExtras = {},
): readonly TreeRow[] {
  const out: TreeRow[] = [];
  for (const g of groups) {
    const groupOpen = openGroups.has(g.key);
    out.push({ kind: "group", key: g.key, label: g.label, count: g.modules.length, open: groupOpen });
    if (!groupOpen) continue;
    for (const m of g.modules) {
      const key = `m:${m.id}`;
      const moduleOpen = openModules.has(key);
      const fns = functionsOf(m.id);
      const depth = extras.depthOf?.(m) ?? 1;
      out.push({ kind: "module", key, module: m, count: fns.length, open: moduleOpen, depth });
      if (!moduleOpen) continue;
      for (const r of extras.rowsAfter?.(m) ?? []) out.push(r);
      for (const r of fns) out.push({ kind: "fn", key: `f:${r.fn}`, row: r, depth: depth + 1 });
    }
  }
  return out;
}

/** The row index of a module selection, or -1 when it is not present in the
 *  flattened rows (its group is closed). `LeftPane` uses this to
 *  `virtualizer.scrollToIndex` when the selection changes via the jump list
 *  or the search dropdown. */
export function indexOfModuleRow(rows: readonly TreeRow[], moduleId: number): number {
  return rows.findIndex((r) => r.kind === "module" && r.module.id === moduleId);
}

/** The row index of a function selection, or -1 when it is not present (its
 *  module, or its module's group, is closed). */
export function indexOfFnRow(rows: readonly TreeRow[], fn: number): number {
  return rows.findIndex((r) => r.kind === "fn" && r.row.fn === fn);
}
