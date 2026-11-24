// docs/specs/35-agent-harness.md Part 1 -- evidence labels. One helper; labels
// are attached where a reply is built, never reconstructed in an adapter.
//   observed: decoded directly from the file
//   derived:  a deterministic, checkable computation over observed facts
//   inferred: a heuristic or model guess (provenance.backend names a model)

export const EVIDENCE_LABELS = ["observed", "derived", "inferred"] as const;
export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];

export interface EvidenceUnknown {
  readonly field: string;
  readonly reason: string;
}

export interface EvidenceProvenance {
  readonly producer: "hbc2js";
  readonly version: string;
  readonly input?: { readonly sha256: string };
  readonly passes?: string;
  readonly backend?: string;
}

export interface Evidence {
  readonly labels: Readonly<Record<string, EvidenceLabel>>;
  readonly unknowns: readonly EvidenceUnknown[];
  readonly limitations: readonly string[];
  readonly provenance: EvidenceProvenance;
}

export interface EvidenceSpec {
  readonly labels: Readonly<Record<string, EvidenceLabel>>;
  readonly unknowns?: readonly EvidenceUnknown[];
  readonly limitations?: readonly string[];
  readonly provenance: EvidenceProvenance;
}

/** True when `key` (a top-level field name or a JSON pointer) resolves in `reply`. */
function resolves(reply: unknown, key: string): boolean {
  if (!key.startsWith("/")) return typeof reply === "object" && reply !== null && Object.prototype.hasOwnProperty.call(reply, key);
  let cur: unknown = reply;
  for (const raw of key.slice(1).split("/")) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof cur !== "object" || cur === null || !Object.prototype.hasOwnProperty.call(cur, part)) return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return true;
}

/** Problems with `reply.evidence`, empty when valid: legal labels, every key present. */
export function validateEvidence(reply: unknown): string[] {
  const ev = (reply as { evidence?: Evidence } | null)?.evidence;
  if (ev === undefined || typeof ev !== "object" || ev === null) return ["reply has no evidence block"];
  const out: string[] = [];
  for (const [k, v] of Object.entries(ev.labels ?? {})) {
    if (!(EVIDENCE_LABELS as readonly string[]).includes(v)) out.push(`label for ${k} is not a legal label: ${String(v)}`);
    if (!resolves(reply, k)) out.push(`label key ${k} is not present in the reply`);
  }
  for (const u of ev.unknowns ?? []) if (!resolves(reply, u.field)) out.push(`unknown field ${u.field} is not present in the reply`);
  if (ev.provenance?.producer !== "hbc2js") out.push("provenance.producer must be hbc2js");
  return out;
}

/** Returns a copy of `reply` with an `evidence` block; throws on an illegal label or a key the reply lacks. */
export function withEvidence<T extends object>(reply: T, spec: EvidenceSpec): T & { evidence: Evidence } {
  const out = {
    ...reply,
    evidence: { labels: { ...spec.labels }, unknowns: [...(spec.unknowns ?? [])], limitations: [...(spec.limitations ?? [])], provenance: { ...spec.provenance } },
  };
  const problems = validateEvidence(out);
  if (problems.length > 0) throw new Error(`invalid evidence: ${problems.join("; ")}`);
  return out;
}

/** Label every top-level field of an object reply with `label`, except `overrides`. */
export function labelAll(reply: object, label: EvidenceLabel, overrides: Readonly<Record<string, EvidenceLabel>> = {}): Record<string, EvidenceLabel> {
  const out: Record<string, EvidenceLabel> = {};
  for (const k of Object.keys(reply)) out[k] = overrides[k] ?? label;
  return out;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
