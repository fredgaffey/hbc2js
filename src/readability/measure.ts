// src/readability/measure.ts -- spec 28 section 7 measurements computed from a
// committed recording alone (no model, no bundle): coverage, abstain rate and
// the proposals to grade against register-level labels.
import { parseReadabilityResult } from "./types.ts";
import type { LabelledSample } from "./types.ts";
import type { Confidence } from "../name-overlay/store.ts";
import type { Recording } from "../workers/backends/replay.ts";

export interface RecordedName {
  readonly name: string;
  readonly confidence: Confidence;
}

/** Every proposed name in the recording, keyed `"fn,reg"`. Later entries win. */
export function recordedNames(recording: Recording): Map<string, RecordedName> {
  const out = new Map<string, RecordedName>();
  for (const entry of Object.values(recording)) {
    const parsed = parseReadabilityResult(entry.text);
    if (!parsed.ok) continue;
    for (const n of parsed.result.names) {
      if (n.bindingId.kind !== "reg") continue;
      // A live range keys as "fn,reg,web"; web 1 (the range holding the
      // register's first def, e.g. a parameter's LoadParam) also answers for
      // the whole register "fn,reg", which is how register labels join.
      const w = n.bindingId.web;
      const key = w === undefined || w === 1 ? `${String(n.bindingId.fn)},${String(n.bindingId.reg)}` : `${String(n.bindingId.fn)},${String(n.bindingId.reg)},${String(w)}`;
      out.set(key, { name: n.name, confidence: n.confidence });
    }
  }
  return out;
}

export interface RecordingStats {
  readonly entries: number;
  /** Entries without `meta` (recorded before requests were logged). */
  readonly legacyEntries: number;
  readonly requested: number;
  readonly named: number;
  /** named / requested over entries that carry `meta`; undefined when none. */
  readonly coverage: number | undefined;
  readonly abstainEntries: number;
  readonly abstainWithoutReason: number;
  readonly unparseable: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/** `{fn -> nameable bindings}` (src/readability/nameable.ts), as committed in
 *  `<app>.nameable.json`: a number is a whole register, a `"R:W"` string one
 *  reg-split live range of register R (docs/RENAME.md). */
export type NameableMap = Readonly<Record<string, readonly (number | string)[]>>;

/** The `NameableMap` member a register binding id is counted under. */
export function nameableMember(id: { readonly reg: number; readonly web?: number }): string {
  return id.web === undefined ? String(id.reg) : `${String(id.reg)}:${String(id.web)}`;
}

export function recordingStats(recording: Recording, nameable?: NameableMap): RecordingStats {
  let legacy = 0, requested = 0, named = 0, abstain = 0, noReason = 0, bad = 0, tin = 0, tout = 0;
  const entries = Object.values(recording);
  for (const e of entries) {
    tin += e.cost?.tokensIn ?? 0;
    tout += e.cost?.tokensOut ?? 0;
    let raw: unknown;
    try {
      raw = JSON.parse(e.text.replace(/^[\s\S]*?```[A-Za-z]*\n/, "").replace(/\n?```[\s\S]*$/, ""));
    } catch {
      raw = undefined;
    }
    const parsed = parseReadabilityResult(e.text);
    if (!parsed.ok) {
      // A bare abstention parses as an error in strict mode but is still a
      // well-formed JSON object with abstained:true: count it as an
      // abstention without a reason, not as truncation.
      const o = raw as { abstained?: unknown; names?: unknown } | undefined;
      if (o !== undefined && o !== null && typeof o === "object" && (o.abstained === true || (Array.isArray(o.names) && o.names.length === 0))) {
        abstain += 1;
        noReason += 1;
      } else bad += 1;
    } else if (parsed.result.abstained) {
      abstain += 1;
    }
    if (e.meta === undefined) {
      legacy += 1;
      continue;
    }
    // With a nameable map the denominator is the registers the rendered
    // source binds to a local identifier; without one, the recorded request.
    const nm = nameable?.[String(e.meta.fn)];
    const universe = nm === undefined ? undefined : new Set(nm.map(String));
    requested += universe === undefined ? e.meta.requested : universe.size;
    if (parsed.ok) {
      const asked = new Set<string>();
      for (const n of parsed.result.names) {
        if (n.bindingId.kind !== "reg" || n.bindingId.fn !== e.meta.fn) continue;
        const member = nameableMember(n.bindingId);
        if (universe === undefined || universe.has(member)) asked.add(member);
      }
      named += universe === undefined ? Math.min(asked.size, e.meta.requested) : asked.size;
    }
  }
  return {
    entries: entries.length,
    legacyEntries: legacy,
    requested,
    named,
    coverage: requested > 0 ? named / requested : undefined,
    abstainEntries: abstain,
    abstainWithoutReason: noReason,
    unparseable: bad,
    tokensIn: tin,
    tokensOut: tout,
  };
}

/** Section 7 quality wiring: for each register label that carries a `binding`,
 *  the recording's proposal for that `{fn,reg}` (labels the recording did not
 *  name are absent, so they neither help nor hurt the high-confidence rate). */
export function proposalsForLabels(
  sample: LabelledSample,
  names: ReadonlyMap<string, RecordedName>,
): Map<string, RecordedName> {
  const out = new Map<string, RecordedName>();
  for (const t of sample.targets) {
    if (t.kind !== "register" || t.binding === undefined) continue;
    const p = names.get(`${String(t.binding.fn)},${String(t.binding.reg)}`);
    if (p !== undefined) out.set(t.id, p);
  }
  return out;
}
