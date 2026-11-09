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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBootSource, bootTrace } from "./boot-equiv.ts";
import type { BootTraceResult } from "./boot-equiv.ts";
import { findAllHermesVms } from "./hermes-vm.ts";
import type { Trace, TraceRecord } from "./trace.ts";

export const EXPORT_BOOT_SCHEMA = "export-boot/1" as const;
export type ExportBootVerdict = "EQUIVALENT" | "DIVERGENT" | "INCONCLUSIVE";
export type ExportBootPhase = "register" | "run";

/** §3 item 4's default `--first-native` window over the PROJECTED native
 *  calls (in-factory only). The stub host's own cap is lifted for this
 *  oracle: it counts out-of-factory calls too, which differ by construction
 *  (the export bundle also runs the installed RN's polyfills). */
export const DEFAULT_PROJECTED_NATIVE = 64;
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
  readonly reason: string | null;
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

/** Spec 33 §1: `exportBootProof(original, exportDir, opts)`. L1 implements
 *  phase B1 ("register"); "run" is accepted but compared as B1 until L3. */
export async function exportBootProof(original: string, exportDir: string, opts: ExportBootOptions = {}): Promise<ExportBootResult> {
  const phase = opts.phase ?? "register";
  const seed = opts.seed ?? 0;
  const vm = opts.vm ?? pickBootVm(exportDir);
  const traceOpts = { seed, firstNative: HOST_NATIVE_CAP, ...(vm !== undefined ? { vm } : {}), ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) };
  const projOpts = (mask?: ReadonlySet<number>): ProjectOptions => ({ firstNative: opts.firstNative ?? DEFAULT_PROJECTED_NATIVE, ...(mask !== undefined ? { mask } : {}) });
  const mask = substitutedIds(exportDir);
  const base = { schema: EXPORT_BOOT_SCHEMA, phase, runApplication: { a: null, b: null }, exportExec: "source" as const };

  // The control first: if the original cannot boot here, nothing about the
  // export can be concluded, and the (slow) re-bundle is skipped.
  const a = bootTrace(acquireBootSource(original).source, { ...traceOpts, wrapFactories: true });
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

  const { offlineBundle } = await import("../export/offline-check.ts");
  let bundlePath: string;
  try {
    bundlePath = (await offlineBundle(exportDir, opts.repoRoot ?? defaultRepoRoot())).bundlePath;
  } catch (e) {
    return { ...inconclusive(""), verdict: "DIVERGENT", divergence: { index: 0, a: null, b: null }, reason: `the export does not bundle offline: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!existsSync(bundlePath)) return inconclusive(`offline bundle missing at ${bundlePath}`);
  const b = bootTrace(readFileSync(bundlePath, "utf8"), { ...traceOpts, wrapFactories: false });
  const pb = projectBootTrace(b.trace, projOpts());
  const common = { ...base, appKeys: { a: keys(pa), b: keys(pb) }, factories: { a: enters(pa), b: enters(pb) }, masked: maskedCount };
  if (!b.ran) return inconclusive(`the export side produced no boot trace: ${errText(b)}`, pb);

  const bThrowRec = b.trace.records.find((r) => r.k === "call" && r.fn === PROBE_FN && r.args[0] === "throw");
  const exportThrow = bThrowRec !== undefined && bThrowRec.k === "call"
    ? `throw ${String(bThrowRec.args[1])}: ${String(bThrowRec.throws ?? "")}`
    : b.reachedEnd ? null : `threw ${errText(b)}`;
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
  return { ...common, verdict: "EQUIVALENT", divergence: null, reason: null };
}
