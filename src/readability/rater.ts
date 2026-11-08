// src/readability/rater.ts -- the lenient, deterministic offline rater for the
// spec 28 section 7 accuracy measurement. The strict `ReferenceNameRater`
// (exact after case/underscore normalisation + alsoAccept) stays as the
// stricter number; this one adds two documented rules and nothing else:
//   1. Role-qualified containment: the author name, split into camelCase /
//      snake_case words, is a CONTIGUOUS run of whole words of the proposal
//      (`props` <- `drawerProps`, `name` <- `screenName`; NOT `name` <-
//      `filenameParts`).
//   2. Abbreviation expansion: both sides' words are canonicalised through
//      ABBREVIATIONS below (`e`/`evt`/`event`, `i`/`idx`/`index`, ...) first;
//      other words lose one trailing plural `s` (`screens` ~ `screen`).
// Misleading: a security-relevant target that fails both rules.
import { normaliseName, ReferenceNameRater } from "./types.ts";
import type { LabelledSample, LabelledTarget, QualityRater, RaterVerdict } from "./types.ts";
import type { Confidence } from "../name-overlay/store.ts";

/** word -> canonical word. Small, committed, extended only with evidence. */
export const ABBREVIATIONS: Readonly<Record<string, string>> = {
  e: "event", evt: "event", ev: "event",
  i: "index", idx: "index", ix: "index",
  cb: "callback", fn: "function", func: "function",
  props: "props", prop: "props", properties: "props",
  opts: "options", opt: "options", option: "options",
  params: "params", param: "params", parameters: "params", parameter: "params", args: "params", arg: "params",
  ctx: "context", cfg: "config", conf: "config", configuration: "config",
  err: "error", req: "request", res: "response", resp: "response",
  val: "value", arr: "array", obj: "object", str: "string", num: "number",
  msg: "message", el: "element", elem: "element", ref: "reference",
  acc: "accumulator", accum: "accumulator", cur: "current", curr: "current",
  prev: "previous", nav: "navigation", btn: "button", tmp: "temp",
};

/** Split `drawerProps`, `route_name`, `HTMLParser2` into lower-case words. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== "")
    .map((w) => w.toLowerCase());
}

function singular(w: string): string {
  return w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

function canon(words: readonly string[]): string[] {
  return words.map((w) => singular(ABBREVIATIONS[w] ?? w));
}

function containsRun(hay: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((w, j) => hay[i + j] === w)) return true;
  }
  return false;
}

/** A single-letter author name (a, b, e, i) carries no intent a proposal could
 *  be held to (the source map confirms the AUTHOR wrote it, but it is a
 *  placeholder); such labels are reported separately, not graded. */
export function isRateableLabel(target: LabelledTarget): boolean {
  return normaliseName(target.referenceName).length > 1;
}

export class LenientNameRater implements QualityRater {
  readonly id = "lenient-name";
  private readonly strict = new ReferenceNameRater();
  rate(target: LabelledTarget, proposedName: string): RaterVerdict {
    const base = this.strict.rate(target, proposedName);
    if (base.verdict === "accurate") return base;
    const hay = canon(nameWords(proposedName));
    for (const ref of [target.referenceName, ...target.alsoAccept]) {
      if (containsRun(hay, canon(nameWords(ref)))) {
        return { verdict: "accurate", rationale: `${proposedName} contains ${ref}` };
      }
    }
    return base;
  }
}

export interface RaterCounts {
  readonly n: number;
  readonly exact: number;
  readonly lenient: number;
  readonly excludedSingleLetter: number;
}

/** Accuracy of recorded proposals under both raters. `high` counts only
 *  high-confidence proposals; `all` every proposal that hits a label. */
export function rateHighConfidence(
  sample: LabelledSample,
  proposals: ReadonlyMap<string, { readonly name: string; readonly confidence: Confidence }>,
): { readonly high: RaterCounts; readonly all: RaterCounts } {
  const strict = new ReferenceNameRater();
  const lenient = new LenientNameRater();
  const acc = { high: [0, 0, 0, 0], all: [0, 0, 0, 0] };
  for (const t of sample.targets) {
    const p = proposals.get(t.id);
    if (p === undefined) continue;
    const buckets = p.confidence === "high" ? [acc.high, acc.all] : [acc.all];
    if (!isRateableLabel(t)) {
      for (const b of buckets) b[3]! += 1;
      continue;
    }
    for (const b of buckets) {
      b[0]! += 1;
      if (strict.rate(t, p.name).verdict === "accurate") b[1]! += 1;
      if (lenient.rate(t, p.name).verdict === "accurate") b[2]! += 1;
    }
  }
  const mk = (b: number[]): RaterCounts => ({ n: b[0]!, exact: b[1]!, lenient: b[2]!, excludedSingleLetter: b[3]! });
  return { high: mk(acc.high), all: mk(acc.all) };
}
