#!/usr/bin/env node
// Decompiler bug sweep, static half (docs/SWEEP-2026-11-24.md).
//
// Decompiles a whole bundle once and checks EVERY function of the output
// without running it. Each finding is attributed to the bytecode function
// whose `// fn#N` marker opens the enclosing emitted function body.
//
//   node tools/sweep/static.ts <app.hbc> --out <dir> [--app <label>] [--workers N]
//
// Writes <dir>/decompiled.js, <dir>/findings.jsonl (one finding per line:
// {app, hbc, fn, check, sig, detail}) and <dir>/summary.json.
//
// Checks (all signatures are shape-normalised so they cluster across apps):
//   PARSE        @babel/parser recoverable error (incl. undefined labels)
//   FREE         identifier read/written with no binding and not a host global
//   TDZ          let/const/class read textually before its declaration in the
//                same function body (not via a closure) -- always throws
//   NEVER-WRITTEN `let x;` that is read but has no write anywhere
//   READ-BEFORE-WRITE `let x;` read in straight-line code (no loop, no closure)
//                before every write to it in the same function
//   STUB         EM-* isolation stub (a function the emitter refused / scope-
//                check isolated)
//   WARN         decompile() diagnostic (W_* code)
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
import traverseMod from "@babel/traverse";
import { decompile, decompileParallel } from "../../src/decompile.ts";
import type { DecompileResult } from "../../src/decompile.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse: any = (traverseMod as any).default ?? traverseMod;

const HOST = new Set([
  "require", "module", "exports", "global", "globalThis", "__DEV__", "console",
  "window", "self", "process", "__dirname", "__filename", "arguments",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate",
  "clearImmediate", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
  "fetch", "XMLHttpRequest", "FormData", "Headers", "Request", "Response", "URL",
  "URLSearchParams", "AbortController", "AbortSignal", "Blob", "FileReader",
  "TextEncoder", "TextDecoder", "WebSocket", "performance", "navigator", "location",
  "nativeFabricUIManager", "HermesInternal", "__fbBatchedBridgeConfig", "__r", "__d",
  "nativeModuleProxy", "__turboModuleProxy", "RN$Bridgeless", "atob", "btoa",
  "structuredClone", "Event", "EventTarget", "DOMException", "crypto", "document", "print",
]);
const isGlobal = (n: string): boolean => HOST.has(n) || n in globalThis;
/** Names the ORIGINAL bundle source itself reads free (RN host globals such as
 *  `nativeRuntimeScheduler`); `--host-from <bundle.js>` adds them to HOST. */
export function addHostFrom(src: string): number {
  const ast = parse(src, { sourceType: "script", errorRecovery: true, allowReturnOutsideFunction: true });
  let n = 0;
  traverse(ast, { Program(p: { scope: { globals: Record<string, unknown> } }) { for (const k of Object.keys(p.scope.globals)) { HOST.add(k); n++; } } });
  return n;
}
/** Warning (code, reason) pairs that fire on almost every function and say
 *  nothing about a bug; counted in the summary histogram only. */
const NOISE = (sig: string): boolean => sig.startsWith("WARN:W_PASS_VERSION_SKIP") || /:no-[a-z]+-site$/.test(sig);

/** Shape-normalise an emitted name so `r3`/`r17` cluster together. */
export function nameShape(n: string): string {
  if (/^r\d+$/.test(n)) return "rN";
  if (/^a\d+$/.test(n)) return "aN";
  if (/^_e\d+_\d+$/.test(n)) return "_eN_N";
  if (/^_eD_\w+$/.test(n)) return "_eD_*";
  if (/^_fn\d+$/.test(n)) return "_fnN";
  if (/^L\d+$/.test(n)) return "LN";
  if (/^_[a-zA-Z]+\d+$/.test(n)) return n.replace(/\d+$/, "N");
  if (/^__hbc_/.test(n)) return n;
  return "<name>";
}
export function normMsg(m: string): string {
  return m.replace(/fn#\d+/g, "fn#N").replace(/\b_fn\d+\b/g, "_fnN").replace(/\b(r|a)\d+\b/g, "$1N")
    .replace(/\b_e\d+_\d+\b/g, "_eN_N").replace(/\d+/g, "N").replace(/"[^"]*"/g, '"…"').replace(/'[^']*'/g, "'…'").slice(0, 160);
}

export interface Finding {
  app: string; hbc: number; fn: number; check: string; sig: string; detail: string; line?: number;
}

/** Run every static check over one decompiled program. */
export function staticFindings(code: string, app: string, hbc: number): Finding[] {
  const out: Finding[] = [];
  const add = (fn: number, check: string, sig: string, detail: string, line?: number): void => {
    out.push({ app, hbc, fn, check, sig: `${check}:${sig}`, detail: detail.slice(0, 300), ...(line ? { line } : {}) });
  };
  const ast = parse(code, {
    sourceType: "script", errorRecovery: true, allowReturnOutsideFunction: true,
    plugins: ["jsx", "classProperties", "classPrivateProperties", "classPrivateMethods"],
  });
  // fn# markers, sorted by position.
  const marks: { pos: number; fn: number }[] = [];
  const stubs: { pos: number; text: string }[] = [];
  const comments = ast.comments ?? [];
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i]!;
    const m = /^\s*fn#(\d+)\b/.exec(c.value);
    if (m) marks.push({ pos: c.start ?? 0, fn: Number(m[1]) });
    // A stub's reason is printed as the following line comment(s).
    if (c.value.includes("ISOLATED FAILURE")) stubs.push({ pos: c.start ?? 0, text: [c.value, comments[i + 1]?.value ?? "", comments[i + 2]?.value ?? ""].join("\n") });
  }
  marks.sort((a, b) => a.pos - b.pos);
  const firstMarkAfter = (p: number): { pos: number; fn: number } | undefined => {
    let lo = 0, hi = marks.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (marks[mid]!.pos <= p) lo = mid + 1; else hi = mid; }
    return marks[lo];
  };
  // node -> fn index for marked functions; ranges for position lookup.
  const fnOf = new WeakMap<object, number>();
  const ranges: { s: number; e: number; fn: number }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markFn = (node: any): void => {
    const body = node.body;
    if (body?.type !== "BlockStatement") return;
    const m = firstMarkAfter(body.start);
    const limit = body.directives?.[0]?.start ?? body.body[0]?.start ?? body.end;
    if (m !== undefined && m.pos < limit) { fnOf.set(node, m.fn); ranges.push({ s: node.start, e: node.end, fn: m.fn }); }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fnAt = (p: any): number => {
    for (let q = p; q; q = q.parentPath) if (fnOf.has(q.node)) return fnOf.get(q.node)!;
    return -1;
  };
  const fnAtPos = (pos: number): number => {
    let best = -1, bestLen = Infinity;
    for (const r of ranges) if (r.s <= pos && pos < r.e && r.e - r.s < bestLen) { best = r.fn; bestLen = r.e - r.s; }
    return best;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctxShape = (p: any): string => {
    const parent = p.parentPath?.node;
    let s = parent ? `${parent.type}.${p.key}` : "?";
    if (parent?.type === "CallExpression" && parent.callee.type === "Identifier" && parent.callee.name.startsWith("__hbc_")) s = `${parent.callee.name}(arg${p.key})`;
    for (let q = p.parentPath; q && !q.isFunction(); q = q.parentPath) {
      if (q.isClassProperty() || q.isClassPrivateProperty()) { s += ":in-class-field"; break; }
      if (q.isOptionalMemberExpression() || q.isOptionalCallExpression()) { s += ":in-optional-chain"; break; }
      if (q.isCatchClause()) { s += q.node.param ? ":in-catch" : ":in-paramless-catch"; break; }
    }
    return s;
  };
  /** How an uninitialised read is used: `deref` throws a TypeError at run
   *  time if reached (member object, callee, `new`, spread, for-of source);
   *  `copy` only moves `undefined` along (often a dead copy Hermes itself has). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const useOf = (p: any): string => {
    const par = p.parentPath?.node; const k = p.key;
    if (!par) return "copy";
    if ((par.type === "MemberExpression" || par.type === "OptionalMemberExpression") && k === "object") return "deref";
    if ((par.type === "CallExpression" || par.type === "NewExpression") && k === "callee") return "deref";
    if (par.type === "SpreadElement" || ((par.type === "ForOfStatement" || par.type === "ForInStatement") && k === "right")) return "deref";
    return "copy";
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inLoopBelow = (p: any, stop: any): boolean => {
    for (let q = p.parentPath; q && q !== stop; q = q.parentPath) if (q.isLoop()) return true;
    return false;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ownerFn = (p: any): any => {
    for (let q = p.parentPath; q; q = q.parentPath) {
      if (q.isFunction() || q.isClassProperty() || q.isClassPrivateProperty() || q.isProgram()) return q;
    }
    return null;
  };

  traverse(ast, {
    Function: { enter(p: { node: object }) { markFn(p.node); } },
  });
  traverse(ast, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ReferencedIdentifier(p: any) {
      const n = p.node.name;
      if (p.parentPath.isUnaryExpression({ operator: "typeof" })) return;
      if (p.scope.getBinding(n) !== undefined || isGlobal(n)) return;
      if (p.isJSXIdentifier()) return;
      add(fnAt(p), "FREE", `${nameShape(n)}@${ctxShape(p)}`, n, p.node.loc?.start.line);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    AssignmentExpression(p: any) {
      const l = p.node.left;
      if (l.type !== "Identifier") return;
      if (p.scope.getBinding(l.name) !== undefined || isGlobal(l.name)) return;
      add(fnAt(p), "FREE", `${nameShape(l.name)}@assign-target${ctxShape(p).includes(":") ? ctxShape(p).slice(ctxShape(p).indexOf(":")) : ""}`, l.name);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Scope(p: any) {
      for (const [name, b] of Object.entries(p.scope.bindings) as [string, any][]) {
        if (b.scope !== p.scope) continue;
        const declStart = b.identifier.start;
        const declOwner = ownerFn(b.path);
        if (b.kind === "let" || b.kind === "const" || b.kind === "class") {
          for (const r of b.referencePaths) {
            if (r.node.start < declStart && ownerFn(r) === declOwner && b.kind !== "class") {
              add(fnAt(r), "TDZ", `${b.kind}:${nameShape(name)}@${ctxShape(r)}`, name, r.node.loc?.start.line);
              break;
            }
          }
        }
        if (b.kind !== "let" || !b.path.isVariableDeclarator() || b.path.node.init) continue;
        if (b.path.parentPath?.parentPath?.isFor?.() || b.path.parentPath?.parentPath?.isForXStatement?.()) continue;
        const reads = b.referencePaths as any[];
        const writes = b.constantViolations as any[];
        if (reads.length === 0) continue;
        if (writes.length === 0) {
          add(fnAt(reads[0]), "NEVER-WRITTEN", `${nameShape(name)}@${ctxShape(reads[0])}:${useOf(reads[0])}`, name, reads[0].node.loc?.start.line);
          continue;
        }
        const firstWrite = Math.min(...writes.map((w) => w.node.start));
        for (const r of reads) {
          if (r.node.start >= firstWrite) continue;
          if (ownerFn(r) !== declOwner) continue; // closure: runs later
          if (inLoopBelow(r, declOwner)) continue; // back edge may write first
          if (writes.some((w: any) => ownerFn(w) !== declOwner)) break; // a closure may write first
          add(fnAt(r), "READ-BEFORE-WRITE", `${nameShape(name)}@${ctxShape(r)}:${useOf(r)}`, name, r.node.loc?.start.line);
          break;
        }
      }
    },
  });
  for (const e of (ast as unknown as { errors?: { reasonCode?: string; message: string; pos: number }[] }).errors ?? []) {
    add(fnAtPos(e.pos), "PARSE", e.reasonCode ?? normMsg(e.message), e.message);
  }
  for (const s of stubs) {
    const fm = /fn#(\d+)/.exec(s.text) ?? /_fn(\d+)/.exec(s.text);
    const fn = fm ? Number(fm[1]) : fnAtPos(s.pos);
    const code = /\((E_[A-Z_]+)\)/.exec(s.text)?.[1] ?? /\b(E_[A-Z_]+)\b/.exec(s.text)?.[1] ?? "?";
    const reason = s.text.split("\n").slice(1).find((l) => l.trim().length > 0) ?? "";
    add(fn, "STUB", `${code}:${normMsg(reason.trim())}`, s.text.split("\n").slice(0, 3).join(" | "));
  }
  return out;
}

export function warnFindings(res: DecompileResult, app: string, hbc: number): Finding[] {
  return res.diagnostics.map((d) => ({
    app, hbc, fn: d.context.functionIndex ?? -1, check: "WARN",
    sig: `WARN:${d.code}${d.context.pass ? `:${d.context.pass}` : ""}${d.context.reason ? `:${d.context.reason}` : ""}`,
    detail: d.message.slice(0, 300),
  }));
}

/** `--dir <export tree>`: static checks over every module file of an
 *  `hbc2js export` tree (no whole-bundle decompile in memory -- the route for
 *  the 99k-function app). Export output carries no `// fn#` markers, so
 *  findings are attributed to the module file (fn -1, `module` = file). */
function dirMode(dir: string, outDir: string, app: string, hbc: number, argv: string[]): void {
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--host-from") addHostFrom(readFileSync(argv[i + 1]!, "utf8"));
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" && d === dir) continue; // the scaffold's own deps, if installed
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) files.push(p);
    }
  };
  walk(dir);
  const t0 = Date.now(); const all: Finding[] = []; let parseFail = 0;
  for (const f of files) {
    const rel = f.slice(dir.length + 1);
    let fs: Finding[];
    try { fs = staticFindings(readFileSync(f, "utf8"), app, hbc); } catch (e) {
      parseFail++; fs = [{ app, hbc, fn: -1, check: "PARSE", sig: "PARSE:fatal", detail: (e as Error).message }];
    }
    for (const x of fs) all.push({ ...x, module: rel } as Finding);
  }
  writeFileSync(join(outDir, "findings.jsonl"), all.map((f) => JSON.stringify(f)).join("\n") + "\n");
  const byCheck: Record<string, number> = {};
  for (const f of all) byCheck[f.check] = (byCheck[f.check] ?? 0) + 1;
  const summary = { app, input: dir, hbc, mode: "export-dir", files: files.length, functions: null, decompileMs: 0, totalMs: Date.now() - t0, parseFail, findings: byCheck };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const input = argv[0];
  const outDir = flag("--out");
  if ((!input && !argv.includes("--dir")) || !outDir) { console.error("usage: static.ts <app.hbc> --out <dir> [--app L] [--workers N] [--host-from bundle.js]..."); process.exit(2); }
  const app = flag("--app") ?? input;
  if (flag("--dir") !== undefined) return dirMode(flag("--dir")!, outDir, app, Number(flag("--hbc") ?? 0), argv);
  const workers = Number(flag("--workers") ?? "1");
  mkdirSync(outDir, { recursive: true });
  const bytes = new Uint8Array(readFileSync(input));
  const t0 = Date.now();
  let res: DecompileResult; let lenient = false;
  const run = (o: object): Promise<DecompileResult> => (workers > 1 ? decompileParallel(bytes, o, workers) : Promise.resolve(decompile(bytes, o)));
  try { res = await run({ resolveV98Ambiguity: true }); } catch (e) {
    console.error(`strict decompile failed (${(e as Error).message.slice(0, 200)}); retrying strictEnv:false`);
    lenient = true; res = await run({ resolveV98Ambiguity: true, strictEnv: false });
  }
  const hbc = res.module.header.version;
  const tDec = Date.now() - t0;
  writeFileSync(join(outDir, "decompiled.js"), res.code);
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--host-from") addHostFrom(readFileSync(argv[i + 1]!, "utf8"));
  const warns = warnFindings(res, app, hbc);
  const warnHist: Record<string, number> = {};
  for (const w of warns) warnHist[w.sig] = (warnHist[w.sig] ?? 0) + 1;
  const findings = [...staticFindings(res.code, app, hbc), ...warns.filter((w) => !NOISE(w.sig))];
  writeFileSync(join(outDir, "findings.jsonl"), findings.map((f) => JSON.stringify(f)).join("\n") + "\n");
  const byCheck: Record<string, number> = {}; const fnsByCheck: Record<string, Set<number>> = {};
  for (const f of findings) { byCheck[f.check] = (byCheck[f.check] ?? 0) + 1; (fnsByCheck[f.check] ??= new Set()).add(f.fn); }
  const summary = {
    app, input, hbc, lenientEnv: lenient, functions: res.module.functions.length, decompileMs: tDec, totalMs: Date.now() - t0,
    findings: byCheck, warnHistogram: Object.fromEntries(Object.entries(warnHist).sort((a, b) => b[1] - a[1])), functionsWith: Object.fromEntries(Object.entries(fnsByCheck).map(([k, v]) => [k, v.size])),
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
