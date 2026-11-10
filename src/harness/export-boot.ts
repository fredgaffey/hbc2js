// docs/specs/33-export-boot.md — the export boot proof. The ORIGINAL bundle
// and the EXPORTED tree (re-bundled offline, spec 29 §4.6) both boot under
// spec 31's recording stub host (`boot-equiv.ts`); each trace is projected
// onto the version-independent boot projection (§3) and compared. The
// original is the control: a stub-host gap shows on it first, and is then
// INCONCLUSIVE, never blamed on the export.
//
// L1 scope: phase B1 ("register"), export side in source mode. The factory
// probe arrives as `call __HBC_BOOT_PROBE__ [ev, id]` records: emitted by
// the prelude's wrapped `__d` factories on the original side (§4 a) and by
// the export registry's `r()` under `--instrument=modules` (§4 b).
import { deriveNativeManifest, overrideFor } from "./native-manifest.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBootSource, bootTrace } from "./boot-equiv.ts";
import type { BootTraceResult } from "./boot-equiv.ts";
import { findAllHermesVms, findHermesVm } from "./hermes-vm.ts";
import { findHermesc as findHermescVersion } from "./roundtrip.ts";
import type { Trace, TraceRecord } from "./trace.ts";

export const EXPORT_BOOT_SCHEMA = "export-boot/1" as const;
export type ExportBootVerdict = "EQUIVALENT" | "DIVERGENT" | "INCONCLUSIVE";
export type ExportBootPhase = "register" | "run";

/** §3 item 4's default `--first-native` window over the PROJECTED native
 *  calls (in-factory only). The stub host's own cap is lifted for this
 *  oracle: it counts out-of-factory calls too, which differ by construction
 *  (the export bundle also runs the installed RN's polyfills). */
export const DEFAULT_PROJECTED_NATIVE = 64;
/** §3 B2: the default `--horizon-ms`, in virtual ms. */
export const DEFAULT_HORIZON_MS = 1000;
const HOST_NATIVE_CAP = 1_000_000;

const NATIVE_FNS = new Set(["__turboModuleProxy", "nativeModuleProxy.get", "nativeCallSyncHook", "nativeLoggingHook", "__fbGenNativeModule"]);
const PROBE_FN = "__HBC_BOOT_PROBE__";

function isNativeFn(fn: string): boolean {
  return NATIVE_FNS.has(fn) || fn.startsWith("turboModule.") || fn.startsWith("nativeModule.");
}

/** The prelude JSON-encodes most arguments (`enc`); show a JSON string
 *  unquoted so a hand-built record (`["DeviceInfo"]`) and a recorded one
 *  (`["\"DeviceInfo\""]`) project identically. */
function plain(v: unknown): string {
  if (typeof v === "string") {
    if (v.startsWith('"')) {
      try {
        const p: unknown = JSON.parse(v);
        if (typeof p === "string") return p;
      } catch { /* not JSON: keep as is */ }
    }
    return v;
  }
  return String(v);
}

export interface ProjectOptions {
  /** Original module ids to drop (substituted ids, spec 29 §5). */
  readonly mask?: ReadonlySet<number>;
  /** Keep at most this many projected native calls. */
  readonly firstNative?: number;
}

/** §3: the boot projection. Entries are `enter <id>`, `exit <id>`,
 *  `throw <id>`, `registerComponent <key>`, and `native <fn> <args...>` for
 *  a native interaction made while a tracked, unmasked factory is on the
 *  stack. Raw Metro `__d`/`__r`, out-of-factory calls, log text, timers and
 *  timings never appear. */
export function projectBootTrace(trace: Trace | readonly TraceRecord[] | readonly unknown[], opts: ProjectOptions = {}): string[] {
  const records = (Array.isArray(trace) ? trace : (trace as Trace).records) as readonly { k?: string; fn?: string; args?: readonly unknown[] }[];
  const mask = opts.mask ?? new Set<number>();
  const cap = opts.firstNative ?? Number.POSITIVE_INFINITY;
  const out: string[] = [];
  const stack: { id: number; masked: boolean }[] = [];
  let tracked = 0;
  let natives = 0;
  for (const r of records) {
    if (r.k !== "call" || typeof r.fn !== "string") continue;
    const args = r.args ?? [];
    if (r.fn === PROBE_FN) {
      const ev = plain(args[0]);
      const id = Number(plain(args[1]));
      if (ev === "enter") {
        const masked = mask.has(id);
        stack.push({ id, masked });
        if (!masked) { tracked++; out.push(`enter ${id}`); }
      } else if (ev === "exit" || ev === "throw") {
        // Pop to the matching frame (a throw unwinds every frame above it).
        let i = stack.length - 1;
        while (i >= 0 && stack[i]!.id !== id) i--;
        if (i < 0) continue;
        for (const f of stack.splice(i)) if (!f.masked) tracked--;
        if (!mask.has(id)) out.push(`${ev} ${id}`);
      }
      continue;
    }
    if (r.fn === "registerComponent") {
      out.push(`registerComponent ${plain(args[0])}`);
      continue;
    }
    if (tracked > 0 && isNativeFn(r.fn) && natives < cap) {
      natives++;
      out.push(["native", r.fn, ...args.map(plain)].join(" "));
    }
  }
  return out;
}

export interface ExportBootOptions {
  readonly phase?: ExportBootPhase;
  readonly seed?: number;
  readonly horizonMs?: number;
  readonly firstNative?: number;
  readonly vm?: string;
  readonly timeoutMs?: number;
  /** Force the export side into source mode (default: bytecode when a
   *  `hermesc` + same-version VM pair exists). */
  readonly exportExec?: "source" | "bytecode";
  /** Repo whose node_modules supplies the offline Metro toolchain. */
  readonly repoRoot?: string;
}

export interface ExportBootDivergence {
  readonly index: number;
  readonly a: string | null;
  readonly b: string | null;
  /** The export's first factory throw (`throw <id>: <error>`) or top-level
   *  boot error, if any, even when the first mismatch came earlier. */
  readonly exportThrow?: string | null;
}

export interface ExportBootResult {
  readonly schema: typeof EXPORT_BOOT_SCHEMA;
  readonly verdict: ExportBootVerdict;
  readonly phase: ExportBootPhase;
  readonly appKeys: { readonly a: readonly string[]; readonly b: readonly string[] };
  readonly runApplication: { readonly a: string | null; readonly b: string | null };
  readonly factories: { readonly a: number; readonly b: number };
  readonly divergence: ExportBootDivergence | null;
  readonly masked: number;
  readonly exportExec: "source" | "bytecode";
  /** B2 only (empty / 0 in B1): created view names, never props, and the
   *  commit count (Paper root setChildren/manageChildren, Fabric completeRoot). */
  readonly views: { readonly a: readonly string[]; readonly b: readonly string[] };
  readonly commits: { readonly a: number; readonly b: number };
  readonly reason: string | null;
}

/** §3 B2: what the run window produced on one side. */
export interface RunObservation {
  readonly runApplication: string | null;
  readonly views: string[];
  readonly commits: number;
  /** First error that reached ErrorUtils or escaped a drained callback. */
  readonly fatal: string | null;
}

export function observeRun(trace: Trace | readonly TraceRecord[] | readonly unknown[]): RunObservation {
  const records = (Array.isArray(trace) ? trace : (trace as Trace).records) as readonly { k?: string; fn?: string; args?: readonly unknown[]; phase?: string; name?: string; message?: string }[];
  let runApplication: string | null = null;
  const views: string[] = [];
  let commits = 0;
  let fatal: string | null = null;
  for (const r of records) {
    if (r.k === "err" && r.phase === "run") { fatal ??= `${String(r.name)}: ${String(r.message)}`; continue; }
    if (r.k !== "call") continue;
    if (r.fn === "AppRegistry.runApplication") runApplication ??= plain(r.args?.[0]);
    else if (r.fn === "ui.view") views.push(plain(r.args?.[0]));
    else if (r.fn === "ui.commit") commits++;
  }
  return { runApplication, views, commits, fatal };
}

interface ExportManifestShape {
  readonly source?: { readonly hbcVersion?: number };
  readonly substitutions?: readonly { readonly boundaryModule: number; readonly replacedModules: readonly number[] }[];
}

/** Ids whose `EXPORT.json` row was substituted (spec 29 §5). */
export function substitutedIds(exportDir: string): Set<number> {
  const m = JSON.parse(readFileSync(join(exportDir, "EXPORT.json"), "utf8")) as ExportManifestShape;
  const ids = new Set<number>();
  for (const s of m.substitutions ?? []) {
    ids.add(s.boundaryModule);
    for (const id of s.replacedModules) ids.add(id);
  }
  return ids;
}

/** One VM for BOTH sides (source mode). The default discovery order starts
 *  at the oldest VM, whose parser predates BigInt literals that decompiled
 *  code can contain (`1n`), so prefer the VM of the bundle's own HBC
 *  version, else the newest one. */
export function pickBootVm(exportDir: string): string | undefined {
  const vms = findAllHermesVms();
  if (vms.length === 0) return undefined;
  let want: number | undefined;
  try {
    want = (JSON.parse(readFileSync(join(exportDir, "EXPORT.json"), "utf8")) as ExportManifestShape).source?.hbcVersion;
  } catch { /* no manifest: newest */ }
  const exact = vms.find((v) => v.hbcVersion === want);
  return (exact ?? vms.reduce((x, y) => (y.hbcVersion > x.hbcVersion ? y : x))).path;
}

export interface BootCompiler {
  readonly version: number;
  /** The pinned `hermesc` (spec 33 §1). */
  readonly hermesc: string;
  /** A VM of the same HBC version, to run its output with `hermes -b`. */
  readonly vm: string;
}

const COMPILER_VERSIONS = [84, 94, 96, 98, 99];

/** Spec 33 §1 (L2): the export side's compiler, a `hermesc` paired with a VM
 *  of the same HBC version. Prefers `version` (the bundle's own), else the
 *  newest pair found. Null when no pair exists: the export side then runs in
 *  source mode and the result says `exportExec:"source"`. */
export function findHermesc(version?: number): BootCompiler | null {
  const order = [...(version !== undefined ? [version] : []), ...[...COMPILER_VERSIONS].reverse()];
  for (const v of order) {
    const c = findHermescVersion(v);
    const vm = findHermesVm(v);
    if (c !== null && vm !== null) return { version: v, hermesc: c.path, vm: vm.path };
  }
  return null;
}

function manifestVersion(exportDir: string): number | undefined {
  try {
    return (JSON.parse(readFileSync(join(exportDir, "EXPORT.json"), "utf8")) as ExportManifestShape).source?.hbcVersion;
  } catch {
    return undefined;
  }
}

function defaultRepoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function errText(r: BootTraceResult): string {
  if (!r.ran) return r.why ?? "no boot trace";
  return r.bootError !== null ? `${r.bootError.name}: ${r.bootError.message}` : "did not reach the end of the top-level IIFE";
}

function enters(p: readonly string[]): number {
  return p.filter((e) => e.startsWith("enter ")).length;
}

function keys(p: readonly string[]): string[] {
  return p.filter((e) => e.startsWith("registerComponent ")).map((e) => e.slice("registerComponent ".length));
}

/** Spec 33 §1: `exportBootProof(original, exportDir, opts)`. Phase
 *  "register" is B1; "run" is B2 (B1 over the longer window, plus the
 *  runApplication key, view-name sequence and commits). */
export async function exportBootProof(original: string, exportDir: string, opts: ExportBootOptions = {}): Promise<ExportBootResult> {
  const phase = opts.phase ?? "register";
  const seed = opts.seed ?? 0;
  const vm = opts.vm ?? pickBootVm(exportDir);
  const traceOpts = { seed, firstNative: HOST_NATIVE_CAP, ...(vm !== undefined ? { vm } : {}), ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) };
  const projOpts = (mask?: ReadonlySet<number>): ProjectOptions => ({ firstNative: opts.firstNative ?? DEFAULT_PROJECTED_NATIVE, ...(mask !== undefined ? { mask } : {}) });
  const mask = substitutedIds(exportDir);
  const base = { schema: EXPORT_BOOT_SCHEMA, phase, runApplication: { a: null, b: null }, exportExec: "source" as const, views: { a: [] as string[], b: [] as string[] }, commits: { a: 0, b: 0 } };
  const run = phase === "run" ? { horizonMs: opts.horizonMs ?? DEFAULT_HORIZON_MS } : undefined;

  // The control first: if the original cannot boot here, nothing about the
  // export can be concluded, and the (slow) re-bundle is skipped.
  // Spec 31 §4.2 (L4): one native-module manifest, derived from the
  // original (plus its optional boot-native.json), for BOTH sides.
  const originalSource = acquireBootSource(original, { lenientEnv: true }).source;
  const natives = deriveNativeManifest(originalSource, overrideFor(original));
  const a = bootTrace(originalSource, { ...traceOpts, natives, wrapFactories: true, ...(run !== undefined ? { run } : {}) });
  const ra = observeRun(a.trace);
  const pa = projectBootTrace(a.trace, projOpts(mask));
  const maskedCount = projectBootTrace(a.trace).filter((e) => e.startsWith("enter ")).length - enters(pa);
  const inconclusive = (reason: string, pb: readonly string[] = []): ExportBootResult => ({
    ...base, verdict: "INCONCLUSIVE", appKeys: { a: keys(pa), b: keys(pb) }, factories: { a: enters(pa), b: enters(pb) }, divergence: null, masked: maskedCount, reason,
  });
  if (a.vm === null) return inconclusive(a.why ?? "no Hermes VM found");
  if (!a.reachedEnd) return inconclusive(`the original did not boot under the stub host (${errText(a)}): a stub-host gap (spec 31 §4.1), not evidence about the export`);
  const aThrow = pa.find((e) => e.startsWith("throw "));
  if (aThrow !== undefined) {
    const rec = a.trace.records.find((r) => r.k === "call" && r.fn === PROBE_FN && r.args[0] === "throw" && r.throws !== undefined);
    const why = rec !== undefined && rec.k === "call" ? `: ${String(rec.throws)}` : "";
    return inconclusive(`the original's factory ${aThrow.slice(6)} threw under the stub host${why}: a stub-host gap (spec 31 §4.1), not evidence about the export`);
  }
  if (keys(pa).length === 0) return inconclusive("the original registered no app key under the stub host");
  if (run !== undefined) {
    const gap = ra.runApplication === null ? "never reached runApplication" : ra.fatal !== null ? `hit a fatal after runApplication (${ra.fatal})` : ra.commits === 0 ? "made no UI commit" : null;
    if (gap !== null) return { ...inconclusive(`the original ${gap} under the stub host: a stub-host gap (spec 31 §4.1), not evidence about the export`), runApplication: { a: ra.runApplication, b: null }, views: { a: ra.views, b: [] }, commits: { a: ra.commits, b: 0 } };
  }

  const { offlineBundle } = await import("../export/offline-check.ts");
  let bundlePath: string;
  try {
    bundlePath = (await offlineBundle(exportDir, opts.repoRoot ?? defaultRepoRoot())).bundlePath;
  } catch (e) {
    return { ...inconclusive(""), verdict: "DIVERGENT", divergence: { index: 0, a: null, b: null }, reason: `the export does not bundle offline: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!existsSync(bundlePath)) return inconclusive(`offline bundle missing at ${bundlePath}`);
  // §1: the export side is compiled with the pinned hermesc (prelude
  // prepended first) and run with `hermes -b`; source mode without one. An
  // explicit `vm` override keeps both sides on that VM, in source mode.
  const compiler = opts.vm === undefined && opts.exportExec !== "source" ? findHermesc(manifestVersion(exportDir)) : null;
  const exportExec = compiler !== null ? "bytecode" as const : "source" as const;
  const bOpts = compiler !== null ? { ...traceOpts, vm: compiler.vm, hermesc: compiler.hermesc } : traceOpts;
  const b = bootTrace(readFileSync(bundlePath, "utf8"), { ...bOpts, natives, wrapFactories: false, ...(run !== undefined ? { run } : {}) });
  const rb = observeRun(b.trace);
  const pb = projectBootTrace(b.trace, projOpts());
  const runPart = run !== undefined ? { runApplication: { a: ra.runApplication, b: rb.runApplication }, views: { a: ra.views, b: rb.views }, commits: { a: ra.commits, b: rb.commits } } : {};
  const common = { ...base, ...runPart, exportExec, appKeys: { a: keys(pa), b: keys(pb) }, factories: { a: enters(pa), b: enters(pb) }, masked: maskedCount };
  if (!b.ran && compiler !== null && (b.why ?? "").startsWith("hermesc")) {
    // The export's own code does not compile to bytecode: a real failure.
    return { ...common, verdict: "DIVERGENT", divergence: { index: 0, a: null, b: null, exportThrow: b.why }, reason: b.why };
  }
  if (!b.ran) return { ...inconclusive(`the export side produced no boot trace: ${errText(b)}`, pb), exportExec };

  const bThrowRec = b.trace.records.find((r) => r.k === "call" && r.fn === PROBE_FN && r.args[0] === "throw");
  const exportThrow = bThrowRec !== undefined && bThrowRec.k === "call"
    ? `throw ${String(bThrowRec.args[1])}: ${String(bThrowRec.throws ?? "")}`
    : b.reachedEnd ? null : `threw ${errText(b)}`;
  // Debugging aid: both projections, one entry per line.
  const dump = process.env.HBC2JS_EXPORT_BOOT_DUMP;
  if (dump !== undefined && dump !== "") { writeFileSync(`${dump}.a.txt`, pa.join("\n")); writeFileSync(`${dump}.b.txt`, pb.join("\n")); }
  let i = 0;
  while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
  if (i < pa.length || i < pb.length) {
    const divergence = { index: i, a: pa[i] ?? null, b: pb[i] ?? null, exportThrow };
    return { ...common, verdict: "DIVERGENT", divergence, reason: `first boot-projection mismatch at entry ${i}: original ${divergence.a ?? "<end>"}, export ${divergence.b ?? "<end>"}${b.reachedEnd ? "" : ` (export threw: ${errText(b)})`}` };
  }
  if (!b.reachedEnd) {
    // The original booted under this host, so an export throw is real (§3).
    return { ...common, verdict: "DIVERGENT", divergence: { index: i, a: "end", b: `threw ${errText(b)}`, exportThrow }, reason: `the export threw where the original did not: ${errText(b)}` };
  }
  if (run !== undefined) {
    // §3 B2. The original rendered and committed under this host (checked
    // above), so every difference here is the export's.
    if (rb.fatal !== null) return { ...common, verdict: "DIVERGENT", divergence: { index: i, a: "run", b: `fatal ${rb.fatal}`, exportThrow: rb.fatal }, reason: `the export hit a fatal after runApplication where the original did not: ${rb.fatal}` };
    if (rb.runApplication !== ra.runApplication) return { ...common, verdict: "DIVERGENT", divergence: { index: i, a: `runApplication ${ra.runApplication}`, b: `runApplication ${rb.runApplication ?? "<never>"}` }, reason: `runApplication: original ${ra.runApplication}, export ${rb.runApplication ?? "never reached"}` };
    let v = 0;
    while (v < ra.views.length && v < rb.views.length && ra.views[v] === rb.views[v]) v++;
    if (v < ra.views.length || v < rb.views.length) return { ...common, verdict: "DIVERGENT", divergence: { index: v, a: ra.views[v] !== undefined ? `view ${ra.views[v]}` : null, b: rb.views[v] !== undefined ? `view ${rb.views[v]}` : null }, reason: `first view-name mismatch at view ${v}: original ${ra.views[v] ?? "<end>"}, export ${rb.views[v] ?? "<end>"}` };
    if (rb.commits === 0) return { ...common, verdict: "DIVERGENT", divergence: { index: v, a: "commit", b: null }, reason: "the export made no UI commit" };
  }
  return { ...common, verdict: "EQUIVALENT", divergence: null, reason: null };
}
