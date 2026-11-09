// src/readability/binding-hints.ts -- naming-skill v6 context: for every
// requested binding, the line that defines it, a few lines that use it and the
// callees it is passed to, each with the 1-based line number in the printed
// `source`. Pure string work over the already-rendered function body, so it
// adds no analysis pass and the evidence is exactly what the model can see.
import { registerIdent, shortForm } from "../name-overlay/id.ts";

export interface BindingHint {
  /** Short form echoed from the request, e.g. `{7,1}` or `{7,2,2}`. */
  readonly id: string;
  readonly ident: string;
  /** `L<n>: <line>` of the first assignment, or `""` when none is printed. */
  readonly def: string;
  readonly uses: readonly string[];
  readonly flowsInto: readonly string[];
  /** Skill v9: every parameter (`aN`, `arguments[N]`) copied into the
   *  binding. A copy at the def line is bare (`a1`); a later copy into a
   *  reused register carries its line (`a4 (L51)`). The parameter is the
   *  value the author named, so the skill names the binding for it. */
  readonly params: readonly string[];
}

const MAX_USES = 3;
const MAX_LINE = 120;
const NESTED_OPEN = /(\bfunction\b[^{]*|=>\s*)\{\s*$/;

function count(line: string, ch: string): number {
  let n = 0;
  for (const c of line) if (c === ch) n += 1;
  return n;
}

/** Line indices (0-based) that belong to function `fn`'s own body, i.e. not
 *  to a nested closure (whose `rN` are other registers). Falls back to every
 *  line when the header is not found. */
function ownLines(lines: readonly string[], fn: number): number[] {
  const header = lines.findIndex((l) => new RegExp(`\\bfunction\\s+_fn${String(fn)}\\b`).test(l));
  if (header < 0) return lines.map((_, i) => i);
  const own: number[] = [];
  let depth = 0;
  let nestedAt: number | null = null; // depth at which the nested closure opened
  for (let i = header; i < lines.length; i++) {
    const l = lines[i]!;
    const opens = count(l, "{");
    const closes = count(l, "}");
    if (nestedAt === null) {
      if (i > header && NESTED_OPEN.test(l)) nestedAt = depth;
      else own.push(i);
    }
    depth += opens - closes;
    if (nestedAt !== null && depth <= nestedAt) nestedAt = null;
    if (i > header && depth <= 0) break;
  }
  return own;
}

function show(n: number, line: string): string {
  const t = line.trim();
  return `L${String(n)}: ${t.length > MAX_LINE ? `${t.slice(0, MAX_LINE)}...` : t}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Hints for `targets` (all in function `fn`) over the printed `source`. */
export function bindingHints(
  source: string,
  fn: number,
  targets: readonly { readonly fn: number; readonly reg: number; readonly web?: number }[],
): BindingHint[] {
  const lines = source.split("\n");
  const own = ownLines(lines, fn);
  return targets.map((t) => {
    const ident = registerIdent({ kind: "reg", ...t } as Parameters<typeof registerIdent>[0]);
    const id = shortForm({ kind: "reg", ...t } as Parameters<typeof shortForm>[0]);
    const word = new RegExp(`(?<![\\w$])${escapeRe(ident)}(?![\\w$])`);
    const assign = new RegExp(`(?<![\\w$])${escapeRe(ident)}\\s*=[^=>]`);
    const fromParam = new RegExp(`(?<![\\w$.])${escapeRe(ident)}\\s*=\\s*(a\\d+|arguments\\[\\d+\\])\\s*;`);
    let def = "";
    const uses: string[] = [];
    const flows: string[] = [];
    const params: string[] = [];
    for (const i of own) {
      const l = lines[i]!;
      // A bare declaration list (`let r0, r1;`) is skipped; a declaration
      // with an initialiser (`let r3 = a1;`) is the binding's def.
      if (!word.test(l) || (/^\s*let\s/.test(l) && !assign.test(l))) continue;
      const p = fromParam.exec(l);
      if (p !== null) params.push(def === "" ? p[1]! : `${p[1]!} (L${String(i + 1)})`);
      if (def === "" && assign.test(l)) def = show(i + 1, l);
      else if (uses.length < MAX_USES) uses.push(show(i + 1, l));
      const call = new RegExp(`([A-Za-z_$][\\w$.]*)\\([^()]*(?<![\\w$])${escapeRe(ident)}(?![\\w$])`).exec(l);
      if (call !== null && !flows.includes(call[1]!)) flows.push(call[1]!);
    }
    return { id, ident, def, uses, flowsInto: flows, params };
  });
}
