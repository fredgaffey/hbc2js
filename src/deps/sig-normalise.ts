// src/deps/sig-normalise.ts — signature-tier normaliser for package
// recognition (D17/D17a).
//
// Promoted from `tools/pkgsig/lib/sig-normalise.mjs`. Deliberately a *fork*
// of `src/harness/roundtrip.ts`'s `normaliseFunction`, not a shared helper:
// D3 requires that oracle to stay byte-exact for round-trip diffing, while
// this one additionally masks a Metro require-call-site dependency-map
// index (docs/PACKAGE-SIGNATURES.md §3.2/§5.1) — a build-graph-position-
// dependent integer that would otherwise depress exact-hash match rates for
// any function containing an internal `require()`.
//
// Every Metro-compiled CommonJS factory function receives
// `(global, require, importDefault, importAll, module, exports,
// dependencyMap)`-shaped parameters with the dependency map always last
// (Babel drops unused trailing params, never reorders). A
// `require(d[N])`/`_dependencyMap[N]` call site therefore always compiles to
// one of two shapes:
//   (a) LoadConst{Zero,UInt8,Int,Double} %i, N ; GetByVal %v, %depmap, %i
//   (b) GetByIndex %v, %depmap, N              (hbc98+, immediate index)
// Both bake N as a plain `imm`-role operand; this file masks it to a
// canonical `dep#` token for both instruction shapes.

import { getBuiltinTable } from "../tables/registry.ts";
import type { HbcModule } from "../parse/types.ts";
import type { DecodedFunction, Instruction, Operand } from "../disasm/decode.ts";

function builtinName(mod: HbcModule, n: number): string {
  const id = mod.layout.builtinTable;
  if (id === undefined) return "?";
  const table = getBuiltinTable(id);
  return table.builtins.find((b) => b.n === n)?.name ?? "?";
}

function maskedFunctionName(name: string): string {
  return name === "global" ? "global" : "~";
}

const LOAD_CONST_NUMERIC = new Set(["LoadConstZero", "LoadConstUInt8", "LoadConstInt", "LoadConstDouble"]);

// `hermesc -g` (debug info on) inserts `AsyncBreakCheck` at every function
// entry and loop back-edge, and `Debugger` for `debugger;` statements —
// neither carries any semantics the signature cares about, and the former
// shifts every offset so that not a single function of a `-g` build hashes
// like its release twin (a removed report). Both are elided from the
// exact, fuzzy and instruction-count views so release and debug builds of
// the same source fingerprint identically (D17d).
const DEBUG_ONLY_INSTRUCTIONS = new Set(["AsyncBreakCheck", "Debugger"]);

export function isDebugOnlyInstruction(name: string): boolean {
  return DEBUG_ONLY_INSTRUCTIONS.has(name);
}

/** The instructions a signature is computed over: `fn.instructions` minus
 *  debug-only ones. Labels that sat on an elided instruction are carried to
 *  the next kept one (a loop back-edge targets the `AsyncBreakCheck` in a
 *  `-g` build and the loop head itself in a release build — same label
 *  either way once elided). */
export function signatureInstructions(fn: DecodedFunction): { readonly insn: Instruction; readonly labels: readonly string[] }[] {
  const out: { insn: Instruction; labels: string[] }[] = [];
  let pending: string[] = [];
  for (const insn of fn.instructions) {
    const label = fn.labels.get(insn.offset);
    if (label !== undefined) pending.push(label);
    if (isDebugOnlyInstruction(insn.name)) continue;
    out.push({ insn, labels: pending });
    pending = [];
  }
  return out;
}

// LB1 (docs/DEPS.md "Why exact-version signatures miss"): Hermes emits
// `GetByIdShort` / `GetById` / `GetByIdLong`, `CreateClosure` /
// `CreateClosureLongIndex`, `LoadConstString` / `LoadConstStringLongIndex`,
// ... -- the same operation at different OPERAND WIDTHS -- chosen from how
// big the whole bundle's string/function tables are, not from the function
// itself. The naming convention is Hermes' own (MIT
// `include/hermes/BCGen/HBC/BytecodeList.def`: a `Short` / `Long` /
// `LongIndex` suffix on an otherwise identical opcode), and every such
// family in our generated tables folds by dropping that suffix. Jump
// families (`JmpLong`, `JLessLong`, `SaveGeneratorLong`, ... -- any
// instruction with an `addr` operand) are left alone: their width follows
// the jump DISTANCE inside the function, which is source-determined. The
// operand values these widths encode are table indices, and none of them
// ever enter the hash (strings resolve to text, functions to a masked
// name, literal offsets / cache indices / regexps to fixed tokens).
const WIDTH_SUFFIX = /(Short|LongIndex|Long)$/;
const foldCache = new Map<string, string>();

/** Canonical mnemonic for signature hashing (hash scheme 2). */
export function foldOperandWidth(insn: Instruction): string {
  const name = insn.name;
  if (!WIDTH_SUFFIX.test(name) || insn.operands.some((o) => o.role === "addr")) return name;
  let folded = foldCache.get(name);
  if (folded === undefined) {
    folded = name.replace(WIDTH_SUFFIX, "");
    foldCache.set(name, folded);
  }
  return folded;
}

/** True when `fn` holds any instruction whose mnemonic hash scheme 2 folds
 *  (so its scheme-1 and scheme-2 texts differ). */
export function hasWidthVariant(fn: DecodedFunction): boolean {
  return fn.instructions.some((i) => foldOperandWidth(i) !== i.name);
}

export interface SignatureTextOptions {
  /** Fold operand-width variants (hash scheme 2, the default). `false`
   *  reproduces the pre-LB1 scheme-1 text byte-for-byte. */
  readonly foldWidth?: boolean;
}

type MaskMode = "self" | "load";
type RegState = { readonly kind: "depmap" } | { readonly kind: "constimm"; readonly offset: number } | undefined;

/**
 * Local dataflow pass (flat, single forward scan — Metro's require-call-site
 * idiom is always straight-line, no intervening branch between the
 * `LoadParam`/`LoadConst` and the `GetByVal`/`GetByIndex` that consumes it)
 * recovering the set of instruction offsets whose `imm` operand is a
 * dependency-map index and should be masked. Returns a
 * `Map<offset, "self" | "load">`: "self" masks that instruction's own imm
 * operand (`GetByIndex`'s immediate form); "load" masks the *earlier*
 * `LoadConst` instruction at that offset (the `GetByVal` + separate
 * index-register form).
 */
function findDependencyIndexOperands(fn: DecodedFunction): Map<number, MaskMode> {
  const lastParamIndex = fn.header.paramCount - 1;
  const masked = new Map<number, MaskMode>();
  const regState = new Map<number, RegState>();

  for (const insn of fn.instructions) {
    const ops = insn.operands;

    if (insn.name === "LoadParam" && ops.length >= 2 && ops[0]!.role === "reg") {
      regState.set(ops[0]!.value, ops[1]!.value === lastParamIndex ? { kind: "depmap" } : undefined);
      continue;
    }
    if (LOAD_CONST_NUMERIC.has(insn.name) && ops.length >= 1 && ops[0]!.role === "reg") {
      regState.set(ops[0]!.value, { kind: "constimm", offset: insn.offset });
      continue;
    }
    if (insn.name === "GetByVal" && ops.length === 3 && ops[0]!.role === "reg" && ops[1]!.role === "reg" && ops[2]!.role === "reg") {
      const base = regState.get(ops[1]!.value);
      const idx = regState.get(ops[2]!.value);
      if (base?.kind === "depmap" && idx?.kind === "constimm") {
        masked.set(idx.offset, "load");
      }
      regState.set(ops[0]!.value, undefined);
      continue;
    }
    if (insn.name === "GetByIndex" && ops.length === 3 && ops[0]!.role === "reg" && ops[1]!.role === "reg" && ops[2]!.role === "imm") {
      const base = regState.get(ops[1]!.value);
      if (base?.kind === "depmap") {
        masked.set(insn.offset, "self");
      }
      regState.set(ops[0]!.value, undefined);
      continue;
    }
    if (ops.length > 0 && ops[0]!.role === "reg") {
      regState.set(ops[0]!.value, undefined);
    }
  }
  return masked;
}

function operandToken(mod: HbcModule, op: Operand, insn: Instruction, fn: DecodedFunction, regName: (n: number) => string, maskedImm: boolean): string {
  switch (op.role) {
    case "reg":
      return regName(op.value);
    case "addr": {
      const target = insn.targets[0];
      const label = target !== undefined ? fn.labels.get(target) : undefined;
      return label ?? "@?";
    }
    case "string":
      return `s#"${mod.strings.get(op.value)}"`;
    case "function":
      return `f#"${maskedFunctionName(mod.functions[op.value]?.name ?? "?")}"`;
    case "bigint": {
      const entry = mod.bigInts[op.value];
      return `bi#${entry !== undefined ? entry.value().toString() : "?"}n`;
    }
    case "regexp":
      return "re#";
    case "builtin":
      return `b#"${builtinName(mod, op.value)}"`;
    case "cacheIndex":
      return "#";
    case "shape": {
      const shape = mod.shapes[op.value];
      return `sh#(numProps=${shape !== undefined ? shape.numProps : "?"})`;
    }
    case "literalOffset":
      return "lit#";
    case "double":
    case "imm":
    case "envSlot":
      if (maskedImm) return "dep#";
      return String(op.value);
    default:
      return String(op.value);
  }
}

function normaliseSwitch(mod: HbcModule, insn: Instruction, fn: DecodedFunction): string {
  const st = insn.switchTable;
  if (st === undefined) return "";
  const defaultLabel = fn.labels.get(st.defaultTarget) ?? "@?";
  const cases = st.cases
    .map((c) => {
      const label = fn.labels.get(c.target) ?? "@?";
      const value = st.kind === "string" ? `s#"${mod.strings.get(c.value)}"` : String(c.value);
      return `${value}->${label}`;
    })
    .join(" ");
  return `.switch ${insn.name} default=${defaultLabel} ${cases}`;
}

/**
 * Signature-tier drop-in replacement for `normaliseFunction`: byte-identical
 * output for every function that does *not* contain a require-call-site
 * dependency-map index, and masks the dependency-index immediate for the
 * ones that do.
 */
export function normaliseFunctionForSignature(mod: HbcModule, fn: DecodedFunction, opts: SignatureTextOptions = {}): string {
  const fold = opts.foldWidth !== false;
  const regs = new Map<number, string>();
  const regName = (n: number): string => {
    let r = regs.get(n);
    if (r === undefined) {
      r = `%${regs.size}`;
      regs.set(n, r);
    }
    return r;
  };

  const maskedOffsets = findDependencyIndexOperands(fn);
  const lines = [`fn(${fn.header.paramCount}) ${maskedFunctionName(fn.name)}`];

  for (const { insn, labels } of signatureInstructions(fn)) {
    const prefix = labels.map((l) => `${l}: `).join("");
    if (insn.kind === "switch") {
      lines.push(prefix + normaliseSwitch(mod, insn, fn));
      continue;
    }
    const maskMode = maskedOffsets.get(insn.offset);
    const ops = insn.operands
      .filter((o) => o.role !== "cacheIndex")
      .map((op, idx) => {
        const isMasked = maskMode === "self" ? idx === insn.operands.length - 1 && op.role === "imm" : maskMode === "load" && op.role !== "reg";
        return operandToken(mod, op, insn, fn, regName, isMasked);
      });
    lines.push(`${prefix}${fold ? foldOperandWidth(insn) : insn.name} ${ops.join(", ")}`.trimEnd());
  }

  for (const h of fn.handlers) {
    const start = fn.labels.get(h.start) ?? "@?";
    const end = fn.labels.get(h.end) ?? "@?";
    const target = fn.labels.get(h.target) ?? "@?";
    lines.push(`.try ${start}..${end} -> ${target}`);
  }

  return lines.join("\n");
}
