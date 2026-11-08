// tools/passes/private-fields-refusals.ts -- classify why `private-fields`
// (src/passes/private-fields/{match,index}.ts) does not fold a class's
// `Symbol("#name")` candidates, for the docs/BUGS.md 2026-09-01 row
// `diff:GetOwnPrivateBySym/GetByVal` (M5 ladder, class rungs).
//
// Why a tool and not a diagnostic: `private-fields` refuses silently and
// per-name (PL-05), and one `W_PASS_REFUSED` per refused name across a real
// bundle's thousands of classes would drown the diagnostics stream. This
// script instead wraps `privateFields.match` for one whole-bundle decompile
// (the same technique as `tools/passes/ctor-this-refusals.ts`) and, for every
// function that has a candidate, independently re-derives *why* the fold
// failed using the rung's own exported helpers (`findClass`, `findCandidates`,
// `ctorBody`, `foldInBody`) -- never by copying or guessing at hermes-dec's
// behaviour, only by re-running this codebase's own MIT-licensed matcher
// logic with instrumentation.
//
//   node --max-old-space-size=8192 tools/passes/private-fields-refusals.ts \
//     <bundle.hbc> [--corpus <roundtrip-corpus .json>] [--bucket <substring>]
//     [--show <reason>[:N]]
//
// With `--corpus`/`--bucket` (a `tools/e2e/roundtrip-corpus.ts --out` report
// and the round-trip bucket substring), only functions whose module owns at
// least one bucket hit are classified -- how this reproduces the
// `diff:GetOwnPrivateBySym/GetByVal` row's numbers.
//
// Output is aggregate counts plus up to 3 identifier-free `--show <reason>`
// samples (a one-line shape description, never a bundle-derived name), so it
// is safe to quote in docs.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Expr, Stmt } from "../../src/emit/ast.ts";
import { walk } from "../../src/passes/ast.ts";
import { privateFields } from "../../src/passes/private-fields/index.ts";
import { ctorBody, findCandidates, findClass, foldInBody, foldOne } from "../../src/passes/private-fields/match.ts";
import { printProgram } from "../../src/emit/print.ts";
import { foldAll } from "../../src/passes/inline-new/match.ts";
import { splitProject } from "../../src/split/index.ts";

interface Refusal {
  readonly reason: string;
  /** One line, identifier-free: e.g. "static: install on non-this receiver". */
  readonly detail: string;
  readonly functionIndex: number;
  /** defining-body-escape only: inline-new's refusal codes on this frame. */
  readonly inlineNew?: string;
  readonly why?: readonly string[];
  readonly mention?: string;
}

function isIdent(e: Expr): e is Extract<Expr, { k: "ident" }> {
  return e.k === "ident";
}

/** `Object.defineProperty(<target>, <key>, {value, writable:true,
 *  enumerable:false, configurable:false})` anywhere in `body` whose key is
 *  (directly, no register-alias chase -- this is a classifier, not a rewrite)
 *  `envName`, and whose target is not the literal `this`. This is the shape
 *  `ctor-this`'s R12 comment (`src/passes/private-fields/match.ts`) already
 *  names as unsafe to fold: a stand-in object (`Object.create(new.target
 *  .prototype)`-style polymorphic construction) receiving the class's own
 *  private-field brand outside the real constructor. */
function installsOnForeignReceiver(body: readonly Stmt[], envName: string): boolean {
  let found = false;
  walk(body, {
    expr: (e) => {
      if (e.k !== "call" || e.callee.k !== "member" || e.callee.computed) return;
      if (e.callee.obj.k !== "ident" || e.callee.obj.name !== "Object") return;
      if (e.callee.prop.k !== "lit" || e.callee.prop.text !== "defineProperty") return;
      if (e.args.length !== 3) return;
      const key = e.args[1]!;
      if (!isIdent(key) || key.name !== envName) return;
      const desc = e.args[2]!;
      if (desc.k !== "object" || desc.props.length !== 4) return;
      const target = e.args[0]!;
      if (target.k === "this") return; // recognised, safe shape -- not this refusal
      found = true;
    },
  });
  return found;
}

/** Every private-symbol candidate in `before` that has a recovered class in
 *  scope, and why it did (or did not) fold -- re-deriving `foldOne`'s own
 *  decision tree one step at a time so each refusal gets its real cause
 *  instead of one opaque "refused". */
function diagnose(before: readonly Stmt[], functionIndex: number, fnBody?: readonly Stmt[]): readonly Refusal[] {
  const out: Refusal[] = [];
  const candidates = findCandidates(before);
  if (candidates.length === 0) return out;
  let classCount = 0;
  walk(before, { expr: (e) => { if (e.k === "class") classCount++; } });
  const cls = findClass(before);
  if (cls === null) {
    const reason = classCount === 0 ? "no-class-in-scope" : "ambiguous-multiple-classes";
    for (const _c of candidates) out.push({ reason, detail: `${candidates.length} candidate(s), ${classCount} class node(s)`, functionIndex });
    return out;
  }
  const ctor = ctorBody(cls);
  for (const c of candidates) {
    if (ctor === null) {
      out.push({ reason: "no-constructor-member", detail: "class has no constructor method", functionIndex });
      continue;
    }
    const ctorOut = foldInBody(ctor, c.envName, c.displayName, true);
    if (ctorOut === null) {
      out.push({ reason: "ctor-escape", detail: "constructor body has an unrecognised reference to the candidate", functionIndex });
      continue;
    }
    if (ctorOut.initExpr === null) {
      out.push({ reason: "ctor-no-install", detail: "constructor never installs the candidate on `this`", functionIndex });
      continue;
    }
    let escapedMember: { readonly kind: string; readonly isStatic: boolean; readonly foreign: boolean } | null = null;
    for (const m of cls.members) {
      if (m.value === null || m.value.k !== "func") continue;
      const isCtorMember = m.kind === "method" && !m.static && m.key.k === "ident" && m.key.name === "constructor";
      if (isCtorMember) continue;
      const out2 = foldInBody(m.value.body, c.envName, c.displayName, false);
      if (out2 === null) {
        escapedMember = { kind: m.kind, isStatic: m.static, foreign: installsOnForeignReceiver(m.value.body, c.envName) };
        break;
      }
    }
    if (escapedMember !== null) {
      const reason = escapedMember.foreign
        ? escapedMember.isStatic
          ? "static-member-installs-on-foreign-receiver"
          : "instance-member-installs-on-foreign-receiver"
        : escapedMember.isStatic
          ? "static-member-other-escape"
          : "instance-member-other-escape";
      out.push({ reason, detail: `${escapedMember.kind}${escapedMember.isStatic ? " (static)" : ""}`, functionIndex });
      continue;
    }
    // R-PF1, the last gate `foldOne` applies: the defining frame itself still
    // mentions the symbol (or the register it reached its env slot through)
    // after the fold, so the name cannot be retired. The dominant shape is
    // hermesc INLINING a construction of this very class into the defining
    // frame, which installs the field by symbol on an object that never ran
    // the real constructor.
    if (foldOne(before, c, { fnBody, list: before }) === null) {
      // Sub-shape, identifier-free: is the surviving mention the INLINED
      // construction R-PF1 exists for (`Reflect.construct(...)` in the
      // defining frame plus a symbol-keyed install on a non-`this` receiver
      // there), or something else this rung has not looked at yet?
      const inlined = installsOnForeignReceiver(before, c.envName) || (c.regName !== null && installsOnForeignReceiver(before, c.regName));
      let construct = false;
      walk(before, { expr: (e) => { if (e.k === "call" && e.callee.k === "member" && !e.callee.computed && e.callee.obj.k === "ident" && e.callee.obj.name === "Reflect") construct = true; } });
      const survClass = (): string => {
        const k = new Set<string>();
        for (const m of cls.members) {
          if (m.value === null || m.value.k !== "func") continue;
          const isCtor = m.kind === "method" && !m.static && m.key.k === "ident" && m.key.name === "constructor";
          const o = foldInBody(m.value.body, c.envName, c.displayName, isCtor);
          if (o === null) continue;
          let loop = false, fn = false, other = false;
          const sv = (n: unknown, inLoop: boolean, inFn: boolean): void => {
            if (Array.isArray(n)) { for (const x of n) sv(x, inLoop, inFn); return; }
            if (n === null || typeof n !== "object") return;
            const q = n as { k?: string; name?: string };
            if (q.k === "ident" && q.name === c.envName) { if (inFn) fn = true; else if (inLoop) loop = true; else other = true; }
            for (const x of Object.values(q)) if (x !== null && typeof x === "object") sv(x, inLoop || (q.k !== undefined && ["while", "do-while", "for", "for-in", "for-of"].includes(q.k)), inFn || q.k === "func");
          };
          sv(o.body, false, false);
          if (loop) k.add("loop"); if (fn) k.add("fn"); if (other) k.add("other");
        }
        return `class-surv:${[...k].sort().join("+") || "none"}`;
      };
      const locClass = (): string => {
        const out: string[] = [];
        const v = (n: unknown, inClass: boolean, depth: number): void => {
          if (Array.isArray(n)) { for (const x of n) v(x, inClass, depth); return; }
          if (n === null || typeof n !== "object") return;
          const o = n as { k?: string; name?: string };
          if (o.k === "ident" && o.name === c.envName) out.push(`${inClass ? "class" : "frame"}@${Math.min(depth, 1)}`);
          for (const x of Object.values(o)) if (x !== null && typeof x === "object") v(x, inClass || o.k === "class", o.k === "func" ? depth + 1 : depth);
        };
        v(fnBody ?? before, false, 0);
        return [...new Set(out)].sort().join("+");
      };
      // Why `inline-new` (which ran before this rung) left the inlined
      // construction in place: re-run its matcher on this frame and collect
      // its counted R-IN codes plus the header-shaped statements it skipped
      // before any code applies (spec 24 section 9.3).
      const why = new Set<string>();
      foldAll(fnBody ?? before, (r) => why.add(`${r.code}: ${r.reason}`), (w) => why.add(`skip ${w}`));
      const code = why.size === 0 ? `no-header ${locClass()} ${survClass()}` : [...why].map((w) => w.split(":")[0]!.replace(/ \(.*$/, "")).sort().join("+");
      // Every printed line of the frame that names the slot or the register.
      const names = [c.envName, c.regName].filter((n): n is string => n !== null);
      const re = new RegExp(`\\b(${names.join("|")})\\b`);
      // Where the surviving mentions sit: inside the class node or not, and
      // how many function boundaries deep (0 = the defining frame itself).
      const where = new Map<string, number>();
      const visit = (n: unknown, inClass: boolean, depth: number): void => {
        if (Array.isArray(n)) { for (const x of n) visit(x, inClass, depth); return; }
        if (n === null || typeof n !== "object") return;
        const o = n as { k?: string; name?: string };
        if (o.k === "ident" && (o.name === c.envName || o.name === c.regName)) { const key = `${inClass ? "class" : "frame"}@${depth}`; where.set(key, (where.get(key) ?? 0) + 1); }
        const ic = inClass || o.k === "class";
        const d = o.k === "func" ? depth + 1 : depth;
        for (const v of Object.values(o)) if (v !== null && typeof v === "object") visit(v, ic, d);
      };
      visit(fnBody ?? before, false, 0);
      // Inside the class: which member bodies still mention the slot after
      // `foldInBody` returned (it does not descend into loops or nested
      // functions), and under what kind of node.
      const surv = new Set<string>();
      for (const m of cls.members) {
        if (m.value === null || m.value.k !== "func") continue;
        const isCtor = m.kind === "method" && !m.static && m.key.k === "ident" && m.key.name === "constructor";
        const o = foldInBody(m.value.body, c.envName, c.displayName, isCtor);
        if (o === null) continue;
        const sv = (n: unknown, ctxk: string): void => {
          if (Array.isArray(n)) { for (const x of n) sv(x, ctxk); return; }
          if (n === null || typeof n !== "object") return;
          const q = n as { k?: string; name?: string };
          if (q.k === "ident" && q.name === c.envName) surv.add(`${m.static ? "static " : ""}${isCtor ? "ctor" : "member"}:${ctxk}`);
          const nk = q.k === "func" ? (ctxk === "" ? "func" : `${ctxk}>func`) : q.k !== undefined && ["while", "do-while", "for", "for-in", "for-of"].includes(q.k) && !ctxk.includes("loop") ? (ctxk === "" ? "loop" : `${ctxk}>loop`) : ctxk;
          for (const x of Object.values(q)) if (x !== null && typeof x === "object") sv(x, nk);
        };
        sv(o.body, "");
      }
      // Outside the class, below the frame: the first printed line per function.
      const outside: string[] = [];
      const ov = (n: unknown, inClass: boolean, depth: number): void => {
        if (Array.isArray(n)) { for (const x of n) ov(x, inClass, depth); return; }
        if (n === null || typeof n !== "object") return;
        const q = n as { k?: string; name?: string };
        if (q.k === "func" && !inClass && depth === 0 && (JSON.stringify(q).includes(`"${c.envName}"`))) outside.push(printProgram([q.k === "func" && "params" in q && "body" in q && (q as { name?: unknown }).name !== undefined ? (q as unknown as Stmt) : (q as unknown as Stmt)]).split("\n").filter((l) => l.includes(c.envName)).slice(0, 3).map((l) => l.trim().slice(0, 120)).join(" / "));
        for (const x of Object.values(q)) if (x !== null && typeof x === "object") ov(x, inClass || q.k === "class", q.k === "func" ? depth + 1 : depth);
      };
      ov(fnBody ?? before, false, 0);
      const loc = `surv[${[...surv].sort().join(",")}] outside[${outside.join(" || ").slice(0, 300)}] ` + [...where].sort().map(([k, v]) => `${k}:${v}`).join(",");
      if (process.env.PF_DUMP !== undefined && Number(process.env.PF_DUMP) === functionIndex) writeFileSync(`${process.env.PF_DUMP_DIR ?? "."}/fn${functionIndex}-${c.displayName.replace(/\W/g, "")}.js`, printProgram(fnBody ?? before));
      const mention = `loc ${loc}\n    ` + printProgram(fnBody ?? before).split("\n").filter((l) => re.test(l)).map((l) => l.trim().slice(0, 160)).slice(0, 12).join("\n    ");
      out.push({ reason: "defining-body-escape", detail: `foreign install in defining frame: ${inlined ? "yes" : "no"}; Reflect.construct there: ${construct ? "yes" : "no"}`, functionIndex, inlineNew: code, why: [...why], mention });
      continue;
    }
    out.push({ reason: "folded", detail: `#${c.displayName.length} char name`, functionIndex });
  }
  return out;
}

/** Runs one whole-bundle decompile with passes on, spying on
 *  `privateFields.match` only to keep the pipeline's own fold decision (so
 *  this tool's independent `diagnose` can be cross-checked against it), and
 *  collecting `diagnose(before, ctx.functionIndex)` for every function the
 *  driver visits. */
export function classify(bytes: Uint8Array, moduleName: string): readonly Refusal[] {
  const records: Refusal[] = [];
  const spy = privateFields as unknown as { match: typeof privateFields.match };
  const original = spy.match;
  spy.match = (before, ctx) => {
    records.push(...diagnose(before, ctx.functionIndex, ctx.fnBody));
    return original(before, ctx);
  };
  try {
    splitProject(bytes, { moduleName, passes: {} });
  } finally {
    spy.match = original;
  }
  return records;
}

interface CorpusReport {
  readonly modes: RecordModes;
}
type RecordModes = Record<string, { readonly results: readonly { readonly fn: number; readonly module: number; readonly bucket: string }[] } | undefined>;

function corpusModules(path: string, bucket: string): { readonly moduleOf: Map<number, number>; readonly hot: Set<number>; readonly hits: number } {
  const report = JSON.parse(readFileSync(path, "utf8")) as CorpusReport;
  const moduleOf = new Map<number, number>();
  const hot = new Set<number>();
  let hits = 0;
  for (const mode of Object.values(report.modes)) {
    for (const r of mode?.results ?? []) {
      moduleOf.set(r.fn, r.module);
      if (bucket.length > 0 && r.bucket.includes(bucket)) {
        hot.add(r.module);
        hits++;
      }
    }
  }
  return { moduleOf, hot, hits };
}

function histogram(rows: readonly Refusal[]): string {
  const byReason = new Map<string, number>();
  for (const r of rows) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  const sorted = [...byReason.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out = [`\n## ${rows.length} candidate(s) classified`, "", "| reason | count |", "|---|---|"];
  for (const [k, n] of sorted) out.push(`| \`${k}\` | ${n} |`);
  return out.join("\n");
}

function samples(rows: readonly Refusal[], reason: string, n: number): string {
  const matches = rows.filter((r) => r.reason === reason).slice(0, n);
  const out = [`\n### --show ${reason} (${matches.length} of ${rows.filter((r) => r.reason === reason).length})`];
  for (const m of matches) out.push(`- fn#${m.functionIndex}: ${m.detail}`);
  return out.join("\n");
}

async function main(argv: readonly string[]): Promise<void> {
  const positional: string[] = [];
  let corpus: string | undefined;
  let bucket = "";
  let show: string | undefined;
  let inlineNewTable = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--corpus") corpus = String(argv[++i]);
    else if (a === "--bucket") bucket = String(argv[++i]);
    else if (a === "--show") show = String(argv[++i]);
    else if (a === "--inline-new") inlineNewTable = true;
    else positional.push(a);
  }
  const bundle = positional[0];
  if (bundle === undefined) throw new Error("usage: private-fields-refusals.ts <bundle.hbc> [--corpus <json>] [--bucket <substring>] [--show <reason>]");
  const all = classify(new Uint8Array(readFileSync(bundle)), basename(bundle));
  process.stdout.write(`# private-fields refusal classification -- ${basename(bundle)}\n`);
  process.stdout.write(histogram(all) + "\n");
  let rowsForShow = all;
  if (corpus !== undefined) {
    const { moduleOf, hot, hits } = corpusModules(corpus, bucket);
    process.stdout.write(`\n(bucket \`${bucket}\`: ${hits} function(s) in ${hot.size} module(s))\n`);
    const hotRows = all.filter((r) => hot.has(moduleOf.get(r.functionIndex) ?? -1));
    process.stdout.write(histogram(hotRows).replace("candidate(s) classified", "candidate(s) in a bucket module") + "\n");
    rowsForShow = hotRows;
  }
  if (show !== undefined) process.stdout.write(samples(rowsForShow, show, 3) + "\n");
  if (inlineNewTable) {
    const esc = rowsForShow.filter((r) => r.inlineNew !== undefined);
    const byCode = new Map<string, Refusal[]>();
    for (const r of esc) byCode.set(r.inlineNew!, [...(byCode.get(r.inlineNew!) ?? []), r]);
    const out = [`\n## inline-new on the ${esc.length} defining-body-escape frame(s)`, "", "| inline-new outcome | count |", "|---|---|"];
    const sorted = [...byCode].sort((a, b) => b[1].length - a[1].length);
    for (const [k, rs] of sorted) out.push(`| \`${k}\` | ${rs.length} |`);
    for (const [k, rs] of sorted) {
      out.push(`\n### ${k}`);
      for (const r of rs.slice(0, 3)) out.push(`- fn#${r.functionIndex}: ${(r.why ?? []).join(" | ")}\n  mention: ${r.mention}`);
    }
    process.stdout.write(out.join("\n") + "\n");
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`private-fields-refusals: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
}
