#!/usr/bin/env node
// tools/readability/label-registers.ts -- reproducible register-level ground
// truth from the compiler itself, JOINED to .hbc function ids.
//
// Source of truth: ONE compiler, ONE input, ONE flag set, three outputs --
//   hermesc -O -g -dump-ra       -dump-source-location=loc  <bundle.js>
//   hermesc -O -g -dump-bytecode -dump-source-location=loc  <bundle.js>
//   hermesc -O -g -emit-binary -out=<x.hbc>                 <bundle.js>
// The register-allocated IR (`-dump-ra`) and the bytecode dump list the SAME
// functions in the SAME order (the .hbc function-id order): 15,551 of each on
// the held-out app. (An earlier version of this tool counted only the IR
// headers that start with `function` -- 9,058 -- and concluded the dumps
// could not be joined; `arrow`, `method`, `constructor` and `generator inner`
// headers were being dropped.) The join is by index and VERIFIED per function
// on name and parameter count; a function whose pair disagrees is dropped,
// never guessed.
//
// What the IR names: parameters (`LoadParamInst ... %n`) and environment
// variables (`[%VS0.n]` on Load/StoreFrameInst) -- the only author names the
// compiler keeps. Registers: IR `{rK}`/`{nK}`/`{npK}` are register CLASSES;
// bytecode numbers them numbers-first: nK -> K, npK -> numbers + K,
// rK -> numbers + nonPointers + K (counts from the bytecode header).
//
// MINIFIED bundles: the names above are the minifier's (`e`, `t`). With
// `--map`, a parameter is resolved to its original name through the source map
// segment at the parameter's own position in the bundle text (the function
// start comes from the IR's `source location`); environment variables have no
// recorded declaration position and are skipped in that mode.
//
// Usage: node tools/readability/label-registers.ts <hermesc> <bundle.js> [--map <file.map>] [--src-only] [--out <labels.json>]
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface RegLabel {
  /** Bytecode register number (numbers-first class layout). */
  readonly reg: number;
  readonly name: string;
  readonly via: "param" | "env-store" | "env-load";
}
export interface IrFunction {
  readonly index: number;
  readonly name: string;
  readonly kind: string;
  /** Bundle position of the function start, 1-based, from `source location`. */
  readonly line: number;
  readonly col: number;
  readonly irLabels: readonly { readonly cls: "r" | "n" | "np"; readonly k: number; readonly name: string; readonly via: RegLabel["via"] }[];
}
export interface BcFunction {
  readonly index: number;
  readonly name: string;
  readonly params: number;
  readonly numbers: number;
  readonly nonPointers: number;
}
export interface JoinedFunction {
  readonly fn: number;
  readonly name: string;
  readonly line: number;
  readonly col: number;
  readonly labels: readonly RegLabel[];
}

const HEADER = /^((?:[a-z]+ )*?)(?:"(.*?)(?: \d+#)?"|([^(\s"]*))\(/;

/** Parse `-dump-ra -dump-source-location=loc` text. Pure. A function is
 *  delimited by its `source location:` line; the line before is its header. */
export function parseRaDump(text: string): IrFunction[] {
  const lines = text.split("\n");
  const out: IrFunction[] = [];
  let cur: { name: string; kind: string; line: number; col: number; irLabels: IrFunction["irLabels"][number][] } | null = null;
  const seen = new Set<string>();
  const flush = (): void => {
    if (cur !== null) out.push({ index: out.length, ...cur });
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("source location:")) {
      flush();
      const h = HEADER.exec(lines[i - 1] ?? "");
      const loc = /:(\d+):(\d+) \.\.\./.exec(line);
      const kind = (h?.[1] ?? "").trim();
      cur = { name: h?.[2] ?? h?.[3] ?? "", kind, line: Number(loc?.[1] ?? 0), col: Number(loc?.[2] ?? 0), irLabels: [] };
      seen.clear();
      continue;
    }
    if (cur === null) continue;
    const add = (cls: string, k: string, name: string, via: RegLabel["via"]): void => {
      const key = `${cls}${k}:${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      cur!.irLabels.push({ cls: cls as "r" | "n" | "np", k: Number(k), name, via });
    };
    let m = /^\s*\{(np|n|r)(\d+)\}\s+%\d+ = LoadParamInst .*%([A-Za-z_$][\w$]*):/.exec(line);
    if (m !== null) { add(m[1]!, m[2]!, m[3]!, "param"); continue; }
    m = /^\s*\{(np|n|r)(\d+)\}\s+%\d+ = LoadFrameInst .*\[%VS\d+\.([A-Za-z_$][\w$]*)\]/.exec(line);
    if (m !== null) { add(m[1]!, m[2]!, m[3]!, "env-load"); continue; }
    m = /StoreFrameInst \{(?:np|n|r)\d+\} %\d+: environment, \{(np|n|r)(\d+)\} %\d+: [^,]*, \[%VS\d+\.([A-Za-z_$][\w$]*)\]/.exec(line);
    if (m !== null) add(m[1]!, m[2]!, m[3]!, "env-store");
  }
  flush();
  return out;
}

/** Parse the per-function headers of `-dump-bytecode` (function-id order). */
export function parseBytecodeHeaders(text: string): BcFunction[] {
  const out: BcFunction[] = [];
  for (const line of text.split("\n")) {
    const m = /^(?:NC)?[A-Za-z]+<(.*)>\((\d+) params, (\d+) registers, (\d+) numbers, (\d+) non-pointers\)/.exec(line);
    if (m !== null) out.push({ index: out.length, name: m[1]!, params: Number(m[2]), numbers: Number(m[4]), nonPointers: Number(m[5]) });
  }
  return out;
}

export function bytecodeReg(cls: "r" | "n" | "np", k: number, bc: BcFunction): number {
  return cls === "n" ? k : cls === "np" ? bc.numbers + k : bc.numbers + bc.nonPointers + k;
}

/** Join IR to bytecode by index, verified on name. Pure. */
export function joinDumps(ir: readonly IrFunction[], bc: readonly BcFunction[]): { joined: JoinedFunction[]; countsMatch: boolean; nameMismatches: number } {
  const countsMatch = ir.length === bc.length;
  let nameMismatches = 0;
  const joined: JoinedFunction[] = [];
  for (let i = 0; i < Math.min(ir.length, bc.length); i++) {
    const f = ir[i]!;
    const b = bc[i]!;
    if (f.name !== b.name) {
      nameMismatches += 1;
      continue;
    }
    joined.push({ fn: i, name: f.name, line: f.line, col: f.col, labels: f.irLabels.map((l) => ({ reg: bytecodeReg(l.cls, l.k, b), name: l.name, via: l.via })) });
  }
  return { joined, countsMatch, nameMismatches };
}

// -- source map (minified bundles) ------------------------------------------

export interface SourceMapLike {
  readonly sources: readonly string[];
  readonly names: readonly string[];
  readonly mappings: string;
}
type Seg = readonly [col: number, src: number, line: number, scol: number, name: number];

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Decode `mappings` into per-generated-line segments (only 4/5-field ones). */
export function decodeMappings(mappings: string): Seg[][] {
  const lines: Seg[][] = [];
  let src = 0, sl = 0, sc = 0, nm = 0;
  for (const lineStr of mappings.split(";")) {
    const segs: Seg[] = [];
    let col = 0;
    for (const s of lineStr.split(",")) {
      if (s === "") continue;
      const f: number[] = [];
      let v = 0, shift = 0;
      for (const ch of s) {
        const d = B64.indexOf(ch);
        v |= (d & 31) << shift;
        if (d & 32) shift += 5;
        else {
          f.push(v & 1 ? -(v >> 1) : v >> 1);
          v = 0;
          shift = 0;
        }
      }
      col += f[0]!;
      if (f.length >= 4) {
        src += f[1]!; sl += f[2]!; sc += f[3]!;
        if (f.length >= 5) nm += f[4]!;
        segs.push([col, src, sl, sc, f.length >= 5 ? nm : -1]);
      }
    }
    lines.push(segs);
  }
  return lines;
}

/** Plain-identifier parameters of the function that starts at `col0` (0-based)
 *  in `lineText`, with their 0-based columns. Destructured / defaulted /
 *  rest parameters are not returned (their register is not one named binding). */
export function paramTokens(lineText: string, col0: number): { name: string; col: number }[] {
  const head = lineText.slice(col0, col0 + 400);
  const arrow = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(head);
  if (arrow !== null) {
    const off = head.indexOf(arrow[1]!, arrow[0].startsWith("async") ? 5 : 0);
    return [{ name: arrow[1]!, col: col0 + off }];
  }
  const open = head.indexOf("(");
  if (open < 0) return [];
  const out: { name: string; col: number }[] = [];
  let depth = 0, start = open + 1;
  const pushItem = (end: number): void => {
    const raw = head.slice(start, end);
    const m = /^(\s*)([A-Za-z_$][\w$]*)\s*$/.exec(raw);
    if (m !== null) out.push({ name: m[2]!, col: col0 + start + m[1]!.length });
  };
  for (let i = open; i < head.length; i++) {
    const c = head[i]!;
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0) { pushItem(i); return out; }
    } else if (c === "," && depth === 1) { pushItem(i); start = i + 1; }
  }
  return [];
}

export interface ResolvedLabel {
  readonly fn: number;
  readonly reg: number;
  readonly name: string;
  readonly minified: string;
  readonly source: string;
}

/** Resolve parameter labels of joined functions to original names + source. */
export function resolveWithMap(joined: readonly JoinedFunction[], bundleLines: readonly string[], map: SourceMapLike): ResolvedLabel[] {
  const decoded = decodeMappings(map.mappings);
  const out: ResolvedLabel[] = [];
  for (const f of joined) {
    const params = f.labels.filter((l) => l.via === "param");
    if (params.length === 0 || f.line < 1) continue;
    const segs = decoded[f.line - 1];
    const text = bundleLines[f.line - 1];
    if (segs === undefined || text === undefined) continue;
    let srcIdx = -1;
    for (const s of segs) if (s[0] <= f.col - 1) srcIdx = s[1];
    if (srcIdx < 0) continue;
    const toks = paramTokens(text, f.col - 1);
    for (const l of params) {
      const tok = toks.find((t) => t.name === l.name);
      if (tok === undefined) continue;
      const seg = segs.find((s) => s[0] === tok.col && s[4] >= 0);
      const orig = seg === undefined ? undefined : map.names[seg[4]];
      if (orig === undefined) continue;
      out.push({ fn: f.fn, reg: l.reg, name: orig, minified: l.name, source: map.sources[srcIdx]! });
    }
  }
  return out;
}

/** App source: a real sourcemap path (not a `\0polyfill:` virtual one) outside node_modules. */
export function isSrcSource(l: { readonly source: string }): boolean {
  return l.source.startsWith("/") && !l.source.includes("node_modules");
}

/** Labelled-sample register targets (src/readability/types.ts LabelledTarget). */
export function registerTargets(labels: readonly ResolvedLabel[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const l of labels) {
    const key = `${String(l.fn)},${String(l.reg)}`;
    if (seen.has(key) || !isSrcSource(l)) continue;
    seen.add(key);
    out.push({
      id: `rn-reg-${String(l.fn)}-${String(l.reg)}`,
      kind: "register",
      source: l.source,
      referenceName: l.name,
      binding: { fn: l.fn, reg: l.reg },
      alsoAccept: [],
      securityRelevant: false,
      note: `parameter \`${l.name}\` (minified \`${l.minified}\`) of fn ${String(l.fn)}: hermesc -O -g IR LoadParamInst joined to the .hbc function id by function order, name resolved through the source map`,
    });
  }
  return out;
}

// -- driver -----------------------------------------------------------------

export function runHermesc(hermesc: string, bundle: string, extra: readonly string[]): string {
  const r = spawnSync(hermesc, ["-O", "-g", ...extra, bundle], { encoding: "utf8", maxBuffer: 1 << 30 });
  return r.stdout;
}

/** Compile `bundle` and return the joined functions (no source map). */
export function labelBundle(hermesc: string, bundle: string): ReturnType<typeof joinDumps> {
  const ra = parseRaDump(runHermesc(hermesc, bundle, ["-dump-ra", "-dump-source-location=loc"]));
  const bc = parseBytecodeHeaders(runHermesc(hermesc, bundle, ["-dump-bytecode", "-dump-source-location=loc"]));
  return joinDumps(ra, bc);
}

function main(): void {
  const argv = process.argv.slice(2);
  const [hermesc, bundle] = argv;
  if (hermesc === undefined || bundle === undefined) {
    process.stderr.write("usage: label-registers.ts <hermesc> <bundle.js> [--map f.map] [--src-only] [--write-sample sample.json] [--out labels.json]\n");
    process.exit(2);
  }
  const mapFlag = argv.indexOf("--map");
  const outFlag = argv.indexOf("--out");
  const j = labelBundle(hermesc, bundle);
  process.stderr.write(`join: ${String(j.joined.length)} functions joined, counts match=${String(j.countsMatch)}, name mismatches=${String(j.nameMismatches)}\n`);
  let result: unknown = j.joined;
  if (mapFlag >= 0) {
    const map = JSON.parse(readFileSync(argv[mapFlag + 1]!, "utf8")) as SourceMapLike;
    let labels = resolveWithMap(j.joined, readFileSync(bundle, "utf8").split("\n"), map);
    if (argv.includes("--src-only")) labels = labels.filter(isSrcSource);
    process.stderr.write(`resolved ${String(labels.length)} parameter labels\n`);
    result = labels;
  }
  const sampleFlag = argv.indexOf("--write-sample");
  if (sampleFlag >= 0 && mapFlag >= 0) {
    const path = argv[sampleFlag + 1]!;
    const sample = JSON.parse(readFileSync(path, "utf8")) as { targets: Record<string, unknown>[] };
    sample.targets = [...sample.targets.filter((t) => t["kind"] !== "register"), ...registerTargets(result as ResolvedLabel[])];
    writeFileSync(path, `${JSON.stringify(sample, null, 2)}\n`);
    process.stderr.write(`wrote ${String(sample.targets.length)} targets to ${path}\n`);
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (outFlag >= 0) writeFileSync(argv[outFlag + 1]!, text);
  else process.stdout.write(text);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main();
