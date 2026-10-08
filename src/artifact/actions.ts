// The candidate action-type STRING universe is a naming convention
// (SCREAMING_SNAKE_CASE, the textbook redux constant shape) scoped to
// strings that co-occur with at least one of the three signals above --
// never a bundle-wide grep for the shape alone (same discipline as
// `screens.ts`'s `SCREEN_NAME_RE`). A namespaced "ducks" convention
// (`"todos/add"`) is not covered -- flagged, not attempted.
import type { ArtifactService } from "./service.ts";
import { CAPS } from "./service.ts";

export type ActionRefEvidence = "type-write-cooccurrence" | "type-get-cooccurrence" | "dispatch-name-cooccurrence";

export interface ActionRef {
  readonly module: number | null;
  readonly fn: number;
  readonly evidence: ActionRefEvidence;
}

export interface ActionRow {
  /** The action-type string itself (a naming-convention candidate, not
   *  proven to be a real redux action type -- see the module doc comment). */
  readonly value: string;
  readonly sid: number;
  /** Exactly one unambiguous creator, or `null` -- see `creatorNote`. */
  readonly creator: ActionRef | null;
  /** > 1 candidate creator function; empty unless ambiguous. */
  readonly creatorCandidates: readonly ActionRef[];
  readonly creatorNote: string;
  readonly reducers: readonly ActionRef[];
  /** Every function this pass found dispatching this value. */
  readonly dispatchSites: readonly ActionRef[];
}

export interface ActionsResult {
  readonly note: string;
  readonly actions: readonly ActionRow[];
  readonly totalActions: number;
  readonly truncatedActions: boolean;
}

export const ACTIONS_NOTE =
  "heuristic recovery, not proof, and weaker than `screens`'s tiers: every " +
  "field is CO-OCCURRENCE within one function of two independently-true " +
  "facts (a literal string, and a property name this format records " +
  "separately) -- this format has no dataflow from a string's identity to " +
  "the property it is later written or compared under, so no field here " +
  "is ever a proven link, and \"reducers\" are never proven switch/case " +
  "sites (this format has no control-flow signal at all).";

/** SCREAMING_SNAKE_CASE, the textbook redux action-type constant shape
 *  (`INCREMENT`, `ADD_TODO`) -- a naming convention, never proof. A
 *  namespaced "ducks" shape (`"todos/add"`) is not covered (module doc
 *  comment). Length-capped for the same reason `screens.ts`'s
 *  `SCREEN_NAME_RE` is: guards against an unrelated long
 *  constant-shaped string that happens to be all caps. */
const ACTION_TYPE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const MAX_ACTION_TYPE_LEN = 60;

function isActionTypeShaped(s: string): boolean {
  return s.length <= MAX_ACTION_TYPE_LEN && ACTION_TYPE_RE.test(s);
}

export function actions(svc: ArtifactService, opts: { readonly all?: boolean } = {}): ActionsResult {
  const nameBySid = new Map<number, string>();
  for (const s of svc.allStrings()) if ("v" in s) nameBySid.set(s.sid, s.v);

  // fn -> set of literal sids it mentions anywhere in its own body.
  const literalSidsByFn = new Map<number, Set<number>>();
  // fn sets keyed by the structural signal they carry.
  const typeWriteFns = new Set<number>();
  const typeGetFns = new Set<number>();
  const dispatchGetFns = new Set<number>();

  for (const u of svc.allStringUses()) {
    const name = nameBySid.get(u.sid);
    if (u.role === "literal") {
      const set = literalSidsByFn.get(u.fn) ?? new Set<number>();
      set.add(u.sid);
      literalSidsByFn.set(u.fn, set);
      continue;
    }
    if (name === undefined) continue;
    if ((u.role === "property-key" || u.role === "property-put") && name === "type") {
      typeWriteFns.add(u.fn);
    } else if (u.role === "property-get" && name === "type") {
      typeGetFns.add(u.fn);
    } else if (u.role === "property-get" && name === "dispatch") {
      dispatchGetFns.add(u.fn);
    }
  }

  // Candidate action-type sids: action-type-shaped literals that co-occur,
  // in the SAME function, with at least one of the three signals above --
  // never a bundle-wide grep for the naming convention alone.
  const signalFns = new Set<number>([...typeWriteFns, ...typeGetFns, ...dispatchGetFns]);
  const candidateSids = new Map<number, string>(); // sid -> value
  for (const fn of signalFns) {
    for (const sid of literalSidsByFn.get(fn) ?? []) {
      const v = nameBySid.get(sid);
      if (v !== undefined && isActionTypeShaped(v)) candidateSids.set(sid, v);
    }
  }

  const refsFor = (fns: ReadonlySet<number>, sid: number, evidence: ActionRefEvidence): ActionRef[] => {
    const out: ActionRef[] = [];
    for (const fn of fns) {
      if ((literalSidsByFn.get(fn) ?? new Set()).has(sid)) out.push({ module: svc.moduleOfFn(fn), fn, evidence });
    }
    out.sort((a, b) => a.fn - b.fn);
    return out;
  };

  const rows: ActionRow[] = [];
  for (const [sid, value] of candidateSids) {
    const creatorCandidates = refsFor(typeWriteFns, sid, "type-write-cooccurrence");
    const reducers = refsFor(typeGetFns, sid, "type-get-cooccurrence");
    const dispatchSites = refsFor(dispatchGetFns, sid, "dispatch-name-cooccurrence");

    let creator: ActionRef | null = null;
    let creatorNote: string;
    let reportedCandidates: readonly ActionRef[] = [];
    if (creatorCandidates.length === 1) {
      creator = creatorCandidates[0]!;
      creatorNote = "unambiguous: exactly one function writes a \"type\" property and mentions this value";
    } else if (creatorCandidates.length > 1) {
      reportedCandidates = creatorCandidates;
      creatorNote = `ambiguous: ${creatorCandidates.length} functions write a "type" property and mention this value`;
    } else {
      creatorNote = "no function found that writes a \"type\" property and mentions this value";
    }

    rows.push({ value, sid, creator, creatorCandidates: reportedCandidates, creatorNote, reducers, dispatchSites });
  }

  rows.sort((a, b) => a.value.localeCompare(b.value) || a.sid - b.sid);

  const cap = opts.all === true ? rows.length : CAPS.actions;
  return {
    note: ACTIONS_NOTE,
    actions: rows.slice(0, cap),
    totalActions: rows.length,
    truncatedActions: rows.length > cap,
  };
}
