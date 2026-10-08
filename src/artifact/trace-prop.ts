// **v1 is an index query, not dataflow.** This walks `string-uses.jsonl`'s
// already-computed `(sid, fn, role, n)` rows (role `property-put` ->
// "write", `property-get` -> "read") plus `calls.jsonl`'s `kind:"method"`
// rows whose `via` names this property ("call" -- currently only the
// four JSX-factory names, `jsx`/`jsxs`/`jsxDEV`/`createElement`, ever get
// that kind, docs/specs/10-artifact-format.md §2.2; a general "resolve any
// `obj.method()` receiver" classification is future work, not this item's
// scope). It answers "where does this property name appear, and as what" --
// it NEVER proves that the value a write stores is the value a read
// observes (that needs points-to/dataflow this repo does not have for
// arbitrary object properties). `TRACE_PROP_NOTE` below is carried on every
// result and printed by the CLI's own header, not only in the docs, because
// a terminal dump is read on its own.
import type { ArtifactService } from "./service.ts";
import { CAPS } from "./service.ts";
import type { ModuleEntry } from "./schema.ts";

export type TracePropKind = "write" | "read" | "call";

export interface TracePropRow {
  readonly module: number | null;
  readonly fn: number;
  readonly kind: TracePropKind;
  readonly n: number;
}

export interface TracePropResult {
  readonly name: string;
  readonly found: boolean;
  readonly note: string;
  readonly rows: readonly TracePropRow[];
  readonly total: number;
  readonly truncated: boolean;
}

export const TRACE_PROP_NOTE =
  "v1 is an index query over string-uses.jsonl/calls.jsonl, not dataflow: " +
  "it lists every place this property name is written, read, or (narrowly) " +
  "called through -- it never proves a value written at one site reaches a " +
  "read at another.";

const KIND_ORDER: Record<TracePropKind, number> = { write: 0, read: 1, call: 2 };

/** A load-order rank per module id, DEPENDENCY-FIRST, following only
 *  `kind:"eager"` edges (§2.6: `require()` calls in the module's own
 *  factory body, run at the requiring module's init -- never `lazy`, which
 *  is deferred to a closure that may never run and so proves nothing about
 *  load order). Post-order DFS: every eager dependency is pushed onto
 *  `order` before the module that depends on it, so a smaller rank always
 *  means "loads no later than". A module with no recorded entry (should not
 *  happen for a real artifact, but the walker refuses rather than throws)
 *  gets no rank and sorts last, alongside `module: null` rows. A cycle
 *  (never expected from Metro's own require graph, but defended against
 *  rather than assumed away) is broken by the `visiting` guard below: a
 *  back-edge is simply not re-descended into. */
function eagerLoadOrderRank(modules: readonly ModuleEntry[]): ReadonlyMap<number, number> {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const rank = new Map<number, number>();
  const visiting = new Set<number>();

  function visit(id: number): void {
    if (rank.has(id) || visiting.has(id)) return;
    visiting.add(id);
    const m = byId.get(id);
    if (m !== undefined) {
      for (const d of m.deps) {
        if (d.kind === "eager") visit(d.id);
      }
    }
    visiting.delete(id);
    if (!rank.has(id)) rank.set(id, rank.size);
  }

  for (const m of modules) visit(m.id);
  return rank;
}

export function traceProp(svc: ArtifactService, name: string, opts: { readonly module?: number; readonly all?: boolean } = {}): TracePropResult {
  const sids = new Set(svc.allStrings().filter((s): s is { readonly sid: number; readonly v: string } => "v" in s && s.v === name).map((s) => s.sid));

  if (sids.size === 0) {
    return { name, found: false, note: TRACE_PROP_NOTE, rows: [], total: 0, truncated: false };
  }

  const rows: TracePropRow[] = [];
  for (const u of svc.allStringUses()) {
    if (!sids.has(u.sid)) continue;
    if (u.role !== "property-get" && u.role !== "property-put") continue;
    rows.push({ module: svc.moduleOfFn(u.fn), fn: u.fn, kind: u.role === "property-put" ? "write" : "read", n: u.n });
  }
  for (const c of svc.allCalls()) {
    if (c.kind !== "method" || c.via !== name) continue;
    rows.push({ module: svc.moduleOfFn(c.caller), fn: c.caller, kind: "call", n: 1 });
  }

  const scoped = opts.module === undefined ? rows : rows.filter((r) => r.module === opts.module);

  const rank = eagerLoadOrderRank(svc.allModules());
  const rankOf = (m: number | null): number => (m === null ? Number.POSITIVE_INFINITY : rank.get(m) ?? Number.POSITIVE_INFINITY);
  scoped.sort((a, b) => rankOf(a.module) - rankOf(b.module) || a.fn - b.fn || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  const cap = opts.all === true ? scoped.length : CAPS.traceProp;
  return {
    name,
    found: true,
    note: TRACE_PROP_NOTE,
    rows: scoped.slice(0, cap),
    total: scoped.length,
    truncated: scoped.length > cap,
  };
}
