// docs/specs/34-rea-provider.md — the `hbc2js-machine/1` JSON contract.
// Read-only: nothing here writes a file, spawns a process or touches the
// network. Every reply is one JSON object on stdout; callers set the exit code.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import v8 from "node:v8";
import { Script } from "node:vm";
import { decompileFunction } from "./decompile.ts";
import { closureOwnership, directClosures } from "./deps/closure-owner.ts";
import { scanBundleRegistrations } from "./deps/dscan.ts";
import { decodeFunction } from "./disasm/decode.ts";
import { ErrorCode, Hbc2jsError } from "./errors.ts";
import type { Diagnostic } from "./errors.ts";
import { parseHbc } from "./parse/module.ts";
import type { HbcModule, OpcodeTableId } from "./parse/types.ts";
import { listOpcodeTableIds } from "./tables/registry.ts";
import { VERSION } from "./version.ts";
import { withEvidence } from "./agent/evidence.ts";
import type { EvidenceLabel, EvidenceUnknown } from "./agent/evidence.ts";

export const MACHINE_SCHEMA = "hbc2js-machine/1";
export const MACHINE_CONTRACT = 1;

/** Heap bytes needed per input byte to decompile (same estimate the text mode warns with). */
const HEAP_PER_INPUT_BYTE = 300;

/** Sorted bytecode versions the opcode-table registry accepts; derived, never hand-written. */
export function supportedHbcVersions(): number[] {
  const out = new Set<number>();
  for (const id of listOpcodeTableIds()) {
    const m = /^hbc(\d+)/.exec(id);
    if (m !== null) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/** Spec 35 Part 1: the optional `evidence` block for a machine reply. Only called under `--evidence`. */
export function machineEvidence(reply: Record<string, unknown>, labels: Readonly<Record<string, EvidenceLabel>>, extra: { passes?: string; unknowns?: readonly EvidenceUnknown[]; limitations?: readonly string[] } = {}): Record<string, unknown> {
  const sha = (reply["input"] as { sha256?: string } | undefined)?.sha256;
  const present: Record<string, EvidenceLabel> = {};
  for (const [k, v] of Object.entries(labels)) if (k in reply) present[k] = v;
  return withEvidence(reply, {
    labels: present,
    ...(extra.unknowns !== undefined ? { unknowns: extra.unknowns } : {}),
    ...(extra.limitations !== undefined ? { limitations: extra.limitations } : {}),
    provenance: { producer: "hbc2js", version: VERSION, ...(sha !== undefined ? { input: { sha256: sha } } : {}), ...(extra.passes !== undefined ? { passes: extra.passes } : {}) },
  });
}

export function versionEvidence(reply: Record<string, unknown>): Record<string, unknown> {
  return machineEvidence(reply, { schema: "observed", kind: "observed", ok: "observed", hbc2js: "observed", contract: "observed", hbcVersions: "derived", node: "observed" });
}

export function infoEvidence(reply: Record<string, unknown>): Record<string, unknown> {
  return machineEvidence(reply, {
    input: "observed", version: "observed", functionCount: "observed", stringCount: "observed", sections: "observed",
    layoutClass: "derived", opcodeTable: "derived", probe: "derived", warnings: "derived", diagnostics: "derived",
  });
}

export function modulesEvidence(reply: Record<string, unknown>): Record<string, unknown> {
  return machineEvidence(reply, { input: "observed", warnings: "derived", metro: "derived", total: "derived", offset: "derived", rows: "derived", next: "derived" });
}

/** The fn-naming pass chose a readable name for some `_fnN` binding in the rendered source. */
export function sourceHasPassNames(source: string): boolean {
  const body = source.split("\n").filter((l) => !l.startsWith("//"));
  return body.some((l) => {
    const m = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/.exec(l);
    return m !== null && !/^_fn\d+$/.test(m[1] as string);
  });
}

export function functionEvidence(reply: Record<string, unknown>, passesNone: boolean, renameOff: boolean = passesNone): Record<string, unknown> {
  const renamed = !renameOff && typeof reply["source"] === "string" && sourceHasPassNames(reply["source"]);
  return machineEvidence(
    reply,
    {
      input: "observed", fn: "observed", name: renamed ? "inferred" : "observed", moduleId: "derived", factoryOf: "derived",
      source: "derived", verified: "derived", warnings: "derived", passes: "observed", error: "derived",
    },
    { passes: passesNone ? "none" : "default" },
  );
}

export function versionReply(): Record<string, unknown> {
  return {
    schema: MACHINE_SCHEMA,
    kind: "version",
    ok: true,
    hbc2js: VERSION,
    contract: MACHINE_CONTRACT,
    hbcVersions: supportedHbcVersions(),
    node: process.versions.node,
  };
}

/** Spec 00 §6.3 exit codes, plus the machine-only codes. */
export function machineExitCode(code: string): number {
  switch (code) {
    case ErrorCode.E_USAGE:
    case ErrorCode.E_IO:
    case ErrorCode.E_BAD_FUNCTION_ID:
      return 2;
    case ErrorCode.E_UNSUPPORTED_VERSION:
    case ErrorCode.E_LAYOUT_AMBIGUOUS:
    case ErrorCode.E_LAYOUT_NO_CANDIDATE:
      return 4;
    case ErrorCode.E_INTERNAL:
      return 1;
    default:
      return 3; // decode / structural / E_RESOURCE
  }
}

export function errorReply(code: string, message: string, context: Record<string, unknown> = {}): Record<string, unknown> {
  // `code`/`message` are repeated at top level: the pre-contract `--info --json`
  // error shape was `{code, message}` and must keep parsing.
  return { schema: MACHINE_SCHEMA, kind: "error", ok: false, code, message, error: { code, message, context } };
}

export function write(reply: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(reply) + "\n");
}

/** Print the error envelope for any thrown value; returns the exit code. */
export function writeError(e: unknown): number {
  if (e instanceof Hbc2jsError) {
    write(errorReply(e.code, e.message, { ...e.context }));
    return machineExitCode(e.code);
  }
  write(errorReply(ErrorCode.E_INTERNAL, e instanceof Error ? e.message : String(e)));
  return 1;
}

function usage(message: string, code: string = ErrorCode.E_USAGE, context: Record<string, unknown> = {}): Hbc2jsError {
  return new Hbc2jsError(code as ErrorCode, message, context);
}

export function readInput(path: string | undefined): Uint8Array {
  if (path === undefined) throw usage("no input file given (try --help)");
  try {
    return readFileSync(path);
  } catch (e) {
    throw usage(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`, ErrorCode.E_IO);
  }
}

export function inputDigest(bytes: Uint8Array): { sha256: string; bytes: number } {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

export function warningsOf(diagnostics: readonly Diagnostic[]): { code: string; message: string }[] {
  return diagnostics.filter((d) => d.severity === "warn").map((d) => ({ code: d.code, message: d.message }));
}

/** Compile-only syntax check, in process: no child, no temp file, never runs the code.
 *  Wrapped like a CommonJS module body so it accepts what `node --check` accepts. */
export function syntaxCheckInProcess(code: string): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  try {
    new Script(`(function (exports, require, module, __filename, __dirname) {${code}\n})`, { filename: "decompiled.js" });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Fail fast, with the figure, when the heap cannot hold a decompile. */
function checkHeap(inputBytes: number): void {
  const need = inputBytes * HEAP_PER_INPUT_BYTE;
  const limit = v8.getHeapStatistics().heap_size_limit;
  if (need > limit) {
    const requiredMb = Math.ceil(need / 1024 ** 2);
    throw new Hbc2jsError(ErrorCode.E_RESOURCE, `decompiling this ${inputBytes}-byte input needs roughly ${requiredMb} MB of heap; the limit is ${Math.floor(limit / 1024 ** 2)} MB (NODE_OPTIONS=--max-old-space-size)`, {
      hint: `raise --max-old-space-size to at least ${requiredMb}`,
      requiredMb,
      limitMb: Math.floor(limit / 1024 ** 2),
    });
  }
}

interface ModuleRow {
  readonly id: number;
  readonly factoryFn: number;
  readonly deps: readonly number[];
  readonly fnCount: number;
}

/** Metro registrations from the global function's bytecode only (no decompile). */
function scanModules(mod: HbcModule): ModuleRow[] {
  const regs = scanBundleRegistrations(mod, decodeFunction).filter((r) => r.moduleId !== null);
  const { owner } = closureOwnership(
    regs.map((r) => r.factoryFunctionIndex),
    (i) => directClosures(mod, decodeFunction, i),
    "ambiguous",
  );
  const counts = new Map<number, number>();
  for (const [, root] of owner) counts.set(root, (counts.get(root) ?? 0) + 1);
  return regs
    .map((r) => ({ id: r.moduleId as number, factoryFn: r.factoryFunctionIndex, deps: r.depIds ?? [], fnCount: Math.max(1, counts.get(r.factoryFunctionIndex) ?? 1) }))
    .sort((a, b) => a.id - b.id);
}

function intFlag(argv: readonly string[], name: string, dflt: number): number {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const raw = argv[i + 1];
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isInteger(n) || n < 0) throw usage(`${name} expects a non-negative integer, got ${JSON.stringify(raw)}`);
  return n;
}

/** `hbc2js modules <in.hbc> [--json] [--offset N] [--limit N]`; returns the exit code. */
export function runModules(argv: readonly string[]): number {
  try {
    const json = argv.includes("--json");
    const input = argv.find((a, i) => !a.startsWith("-") && !(i > 0 && (argv[i - 1] === "--offset" || argv[i - 1] === "--limit")));
    const offset = intFlag(argv, "--offset", 0);
    const limit = intFlag(argv, "--limit", 500);
    const bytes = readInput(input);
    const mod = parseHbc(bytes);
    const all = scanModules(mod);
    const rows = all.slice(offset, offset + limit);
    const next = offset + limit < all.length ? offset + limit : null;
    if (!json) {
      for (const r of rows) process.stdout.write(`${r.id}\tfn#${r.factoryFn}\tdeps=${r.deps.join(",")}\tfns=${r.fnCount}\n`);
      return 0;
    }
    const modulesReply: Record<string, unknown> = {
      schema: MACHINE_SCHEMA,
      kind: "modules",
      ok: true,
      hbc2js: VERSION,
      input: inputDigest(bytes),
      warnings: warningsOf(mod.diagnostics),
      metro: all.length > 0,
      total: all.length,
      offset,
      rows,
      next,
    };
    write(argv.includes("--evidence") ? modulesEvidence(modulesReply) : modulesReply);
    return 0;
  } catch (e) {
    return argv.includes("--json") ? writeError(e) : writeTextError(e);
  }
}

function writeTextError(e: unknown): number {
  if (e instanceof Hbc2jsError) {
    process.stderr.write(`hbc2js: ${e.code}: ${e.message}\n`);
    return machineExitCode(e.code);
  }
  process.stderr.write(`hbc2js: ${ErrorCode.E_INTERNAL}: ${e instanceof Error ? e.message : String(e)}\n`);
  return 1;
}

export interface MachineDecompileArgs {
  readonly input: string | undefined;
  readonly scopedFn: number | undefined;
  readonly moduleId: number | undefined;
  readonly verify: boolean;
  readonly strictLayout: boolean;
  readonly lenientEnv: boolean;
  readonly passes: { readonly none: boolean; readonly skip: readonly string[]; readonly optIn: readonly string[] };
  readonly opcodeTable?: OpcodeTableId | undefined;
  /** Spec 35: add the optional `evidence` block (off by default; the reply is byte-identical without it). */
  readonly evidence?: boolean | undefined;
}

/** `decompile <in.hbc> --fn N|--module M --json`; returns the exit code. */
export function runMachineDecompile(a: MachineDecompileArgs): number {
  try {
    if (a.scopedFn === undefined && a.moduleId === undefined) throw usage("decompile --json needs --fn N or --module M");
    const bytes = readInput(a.input);
    const mod = parseHbc(bytes, { ...(a.strictLayout ? { strictLayout: true } : {}), ...(a.opcodeTable !== undefined ? { opcodeTable: a.opcodeTable } : {}) });
    const rows = scanModules(mod);
    let fn: number;
    let factoryOf: number | null = null;
    if (a.moduleId !== undefined) {
      const row = rows.find((r) => r.id === a.moduleId);
      if (row === undefined) throw usage(`no module ${a.moduleId} in this bundle`, ErrorCode.E_BAD_FUNCTION_ID, { expected: `one of ${rows.length} registered module ids` });
      fn = row.factoryFn;
      factoryOf = row.id;
    } else {
      fn = a.scopedFn as number;
      if (!Number.isInteger(fn) || fn < 0 || fn >= mod.functions.length) {
        throw usage(`function index ${String(a.scopedFn)} is out of range (0..${mod.functions.length - 1})`, ErrorCode.E_BAD_FUNCTION_ID, { functionIndex: a.scopedFn as number });
      }
      factoryOf = rows.find((r) => r.factoryFn === fn)?.id ?? null;
    }
    checkHeap(bytes.length);
    // Same options as the text-mode path, so `source` is byte-equal to it.
    const result = decompileFunction(bytes, fn, {
      moduleName: a.input === undefined ? "input.hbc" : (a.input.split(/[\\/]/).pop() as string),
      verify: a.verify,
      strictLayout: a.strictLayout,
      strictEnv: !a.lenientEnv,
      passes: a.passes,
      ...(a.opcodeTable !== undefined ? { opcodeTable: a.opcodeTable } : {}),
    });
    const syntax = syntaxCheckInProcess(result.code);
    const { owner } = closureOwnership(
      rows.map((r) => r.factoryFn),
      (i) => directClosures(mod, decodeFunction, i),
      "ambiguous",
    );
    const ownerFn = owner.get(fn);
    const moduleId = factoryOf ?? (ownerFn === undefined ? null : (rows.find((r) => r.factoryFn === ownerFn)?.id ?? null));
    const reply: Record<string, unknown> = {
      schema: MACHINE_SCHEMA,
      kind: "function",
      ok: syntax.ok,
      hbc2js: VERSION,
      input: inputDigest(bytes),
      warnings: warningsOf(result.diagnostics),
      fn,
      name: decodeFunction(mod, fn).name,
      moduleId,
      factoryOf,
      source: result.code,
      verified: { structurer: a.verify, syntax: syntax.ok },
      passes: a.passes.none ? "none" : "default",
    };
    const out = (): Record<string, unknown> => (a.evidence === true ? functionEvidence(reply, a.passes.none, a.passes.none || a.passes.skip.includes("fn-naming")) : reply);
    if (!syntax.ok) {
      reply.error = { code: "E_SYNTAX", message: syntax.message, context: {} };
      write(out());
      return 5;
    }
    write(out());
    return 0;
  } catch (e) {
    return writeError(e);
  }
}
