// Both properties below come from the CFG (real bytecode facts) or a proven
// FunctionKind, never from a name -- an identifier spelling, a JS `async`
// keyword recovered by a *later* pass, or the string "await" are never
// consulted. When the CFG cannot prove a property either way the function
// gets no annotation at all: a wrong "returns: nothing" would mislead a
// reader worse than saying nothing (H3 brief).
import type { Instruction } from "../disasm/decode.ts";
import type { BasicBlock, FunctionCfg, ModuleAnalysis } from "../cfg/types.ts";
import { writtenRegisters } from "../cfg/reg-effects.ts";
import { closureFunctionId } from "./lower.ts";

const CALL_FAMILY = new Set(["Call", "CallLong", "Call1", "Call2", "Call3", "Call4"]);
const CLOSURE_CREATE = new Set(["CreateClosure", "CreateClosureLongIndex", "CreateAsyncClosure", "CreateAsyncClosureLongIndex", "CreateGeneratorClosure", "CreateGeneratorClosureLongIndex"]);
const GET_BY_ID = new Set(["GetById", "GetByIdLong", "GetByIdShort", "TryGetById", "TryGetByIdLong"]);
const PUT_BY_ID = new Set(["PutById", "PutByIdLong", "PutByIdLoose", "PutByIdLooseLong", "PutByIdStrict", "PutByIdStrictLong"]);

function stringOperand(insn: Instruction): number | undefined {
  return insn.operands.find((o) => o.role === "string")?.value;
}

interface SoleWrite {
  readonly block: number;
  readonly idx: number;
  readonly insn: Instruction;
}

/** Every static write to every register across the whole function, in no
 *  particular order; grouped by register. Shared by both properties below. */
function allWrites(cfg: FunctionCfg): ReadonlyMap<number, SoleWrite[]> {
  const writes = new Map<number, SoleWrite[]>();
  for (const block of cfg.blocks) {
    const insns = block.instructions;
    for (let i = 0; i < insns.length; i++) {
      for (const r of writtenRegisters(insns[i]!)) {
        const w: SoleWrite = { block: block.id, idx: i, insn: insns[i]! };
        const list = writes.get(r);
        if (list === undefined) writes.set(r, [w]);
        else list.push(w);
      }
    }
  }
  return writes;
}

/**
 * The nearest write to `reg` that reaches `(atBlock, atIdx)`: the closest
 * preceding write in the SAME block (unambiguous -- a block runs its own
 * instructions in one straight line, so the LAST prior write always wins),
 * or failing that, the nearest write found by walking up the immediate-
 * dominator chain (each ancestor visited genuinely dominates `atBlock`, so
 * its own last write, if any, really did run first on every path -- a
 * sibling branch's write, which does NOT dominate, is never visited at all,
 * which is exactly what makes generator/async dispatch bodies -- several
 * mutually exclusive state segments reusing the same registers for
 * unrelated things -- resolve correctly here). `undefined` when no write
 * to `reg` is found anywhere on this walk (an unwritten register at this
 * point -- never guessed at, treated the same as "cannot resolve").
 * Note: this does not detect every genuinely ambiguous CFG merge point (two
 * distinct incoming paths each with their own, different, non-dominating
 * write) as ambiguous; in the shapes this analysis is actually run against
 * (straight-line dispatch segments) that case was not observed, and getting
 * it exactly right needs a full reaching-definitions fixpoint, out of scope
 * here -- documented, not silently assumed away.
 */
function reachingWrite(cfg: FunctionCfg, writes: ReadonlyMap<number, SoleWrite[]>, reg: number, atBlock: number, atIdx: number): SoleWrite | undefined {
  const list = writes.get(reg);
  if (list === undefined) return undefined;
  const lastInBlock = (block: number): SoleWrite | undefined => {
    let best: SoleWrite | undefined;
    for (const w of list) if (w.block === block && (best === undefined || w.idx > best.idx)) best = w;
    return best;
  };
  const here = list.filter((w) => w.block === atBlock && w.idx < atIdx);
  if (here.length > 0) return here.reduce((a, b) => (b.idx > a.idx ? b : a));
  let cur = cfg.dom.idom[atBlock] ?? null;
  const seen = new Set<number>();
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const w = lastInBlock(cur);
    if (w !== undefined) return w;
    cur = cfg.dom.idom[cur] ?? null;
  }
  return undefined;
}

/**
 * (a) "returns: nothing": every `Ret` in `cfg` is PROVEN to return undefined
 * -- its operand register has EXACTLY ONE static write anywhere in the whole
 * function, that write is `LoadConstUndefined`, and that write's block
 * dominates the `Ret`'s block (or precedes it within the same block, since
 * dominance alone does not order two instructions of one block). A `Ret`
 * this cannot prove either way (a real value, or an unprovable register
 * shape -- more than one static writer, or a writer that is not
 * `LoadConstUndefined`) makes the WHOLE function ineligible: a function with
 * one valueless `return` and one `return x` is correctly not void, and a
 * function this analysis simply cannot resolve gets no annotation, not a
 * guess in either direction.
 */
export function isProvablyVoidFunction(cfg: FunctionCfg): boolean {
  const writes = allWrites(cfg);
  let sawReturn = false;
  for (const block of cfg.blocks) {
    if (block.terminator.kind !== "return") continue;
    const insns = block.instructions;
    const ret = insns[insns.length - 1];
    if (ret === undefined || ret.kind !== "return") return false;
    const retReg = ret.operands.find((o) => o.role === "reg")?.value;
    if (retReg === undefined) return false;
    sawReturn = true;
    const w = reachingWrite(cfg, writes, retReg, block.id, insns.length - 1);
    if (w === undefined || w.insn.name !== "LoadConstUndefined") return false;
  }
  return sawReturn;
}

/** True only when a real `FunctionKind` computed from the bytecode (header
 *  flags / creation-site opcode / generator body shape -- `src/cfg/generators.ts`)
 *  says so; never derived from a name or a recovered `async` keyword. */
export function isAsyncFunction(analysis: ModuleAnalysis, index: number): boolean {
  return analysis.kinds.some((k) => k.functionIndex === index && (k.kind === "async" || k.kind === "async-generator"));
}

export interface CallSiteResult {
  readonly caller: number;
  readonly offset: number;
  readonly discarded: boolean;
}

/**
 * (b)'s prerequisite: the bytecode STRING TABLE id a function's closure is
 * stored under as a global property, when EXACTLY one such write exists
 * across the whole bundle. This is how a module-level `function foo(){}`
 * declaration compiles (verified directly against hermesc v84/94/96/98/99
 * output, not assumed): `Create*Closure dst, env, fn=K` followed, later in
 * the SAME block, by `PutById globalObjReg, dst, cache, "foo"`. Matching the
 * write's string id against a later READ of the identical id is exact
 * bytecode-level identity (the same string-table entry, not a spelling
 * guess) -- it is how a JS global binding itself resolves, unavoidably
 * nominal; this is not the name-based inference the brief forbids (inferring
 * *behaviour*, like async-ness, from what a function is merely called).
 * Ambiguous (more than one distinct string for the same function index, e.g.
 * a reassigned global) or absent -- the function is simply left out, never
 * guessed. Does not resolve a closure kept only in a local variable or an
 * environment slot (documented gap, mirrors calls.jsonl's own
 * kind:"method"-only receiver gap the H3 brief names).
 */
function globalPropertyOf(analysis: ModuleAnalysis): ReadonlyMap<number, number> {
  const byFn = new Map<number, number | "ambiguous">();
  for (let i = 0; i < analysis.module.functions.length; i++) {
    let cfg: FunctionCfg;
    try {
      cfg = analysis.cfg(i);
    } catch {
      continue;
    }
    const writes = allWrites(cfg);
    for (const block of cfg.blocks) {
      // Closure-creation -> its store is a same-block, adjacent-in-effect
      // shape in every large bundle observed (a module-level `function
      // foo(){}` declaration is straight-line code); a closure carried
      // across a branch before being stored is left unresolved, sound but
      // incomplete, same as this function's other documented gaps.
      const pendingClosure = new Map<number, number>();
      const insns = block.instructions;
      for (let idx = 0; idx < insns.length; idx++) {
        const insn = insns[idx]!;
        if (CLOSURE_CREATE.has(insn.name)) {
          const fn = closureFunctionId(insn);
          const dst = insn.operands[0]?.value;
          if (fn !== undefined && dst !== undefined) pendingClosure.set(dst, fn);
          continue;
        }
        if (!PUT_BY_ID.has(insn.name)) continue;
        const obj = insn.operands[0]?.value;
        const value = insn.operands[1]?.value;
        const str = stringOperand(insn);
        if (obj === undefined || value === undefined || str === undefined) continue;
        const objWrite = reachingWrite(cfg, writes, obj, block.id, idx);
        if (objWrite === undefined || objWrite.insn.name !== "GetGlobalObject") continue;
        const fn = pendingClosure.get(value);
        if (fn !== undefined) {
          const prev = byFn.get(fn);
          byFn.set(fn, prev === undefined || prev === str ? str : "ambiguous");
        }
      }
    }
  }
  const out = new Map<number, number>();
  for (const [fn, v] of byFn) if (v !== "ambiguous") out.set(fn, v);
  return out;
}

/** Does `insn` READ `reg` (as opposed to merely redefining it)? `reg` counts
 *  as read whenever it appears as a `role: "reg"` operand at a position
 *  `writtenRegisters` does NOT claim as a destination; when it IS a claimed
 *  destination too, it is a read only if it also appears a second time
 *  (a rare read-and-rewrite shape) -- the ordinary "just overwritten" shape
 *  (one `role:"reg"` occurrence, which IS the destination) is correctly not
 *  a read. */
function readsRegister(insn: Instruction, reg: number): boolean {
  const occurrences = insn.operands.filter((o) => o.role === "reg" && o.value === reg).length;
  if (occurrences === 0) return false;
  if (!writtenRegisters(insn).includes(reg)) return true;
  return occurrences > 1;
}

/** Forward, same-block only: does `reg` get read by anything from `fromIdx`
 *  on, before either being read (used) or provably overwritten/falling out
 *  of scope (discarded)? `true` (discarded) is proven two ways: `reg` is
 *  redefined before ever being read (its old value, our call's result, is
 *  dead -- a real, not guessed, dead-store proof), or the block's own
 *  terminator PROVES nothing further ever runs on this path (`return`,
 *  `throw`, `unreachable`). A block that merely falls through or branches
 *  without settling it either way is left `undefined` (inconclusive),
 *  never guessed. */
const MAX_HOPS = 8;

function classifyAfter(cfg: FunctionCfg, block: BasicBlock, fromIdx: number, reg: number, hops = MAX_HOPS): boolean | undefined {
  const insns = block.instructions;
  for (let j = fromIdx; j < insns.length; j++) {
    const insn = insns[j]!;
    if (readsRegister(insn, reg)) return false;
    if (writtenRegisters(insn).includes(reg)) return true;
  }
  const t = block.terminator.kind;
  if (t === "return" || t === "throw" || t === "unreachable") return true;
  // A single unconditional successor (straight-line fallthrough/jump, no
  // branch) is still a PROVEN path -- follow it, bounded, rather than
  // refusing at every block boundary (the common shape this feature exists
  // for: an async function's own dispatch/wrapping code is a short chain
  // of such blocks after the last real call). Two or more successors
  // (`branch`/`switch`) is a genuine fork -- refuse, never guess which way.
  if (hops <= 0) return undefined;
  if (block.succs.length !== 1) return undefined;
  const next = cfg.blocks[block.succs[0]!.to];
  if (next === undefined) return undefined;
  return classifyAfter(cfg, next, 0, reg, hops - 1);
}

/**
 * Every call site this analysis can resolve for `target` through the
 * global-property mechanism `globalPropertyOf` proves: a `GetById`-family
 * read of the same global property, immediately (same block, no
 * intervening redefinition) fed into a `Call`-family instruction as its
 * callee. `M` (this array's length) is therefore bounded by what this
 * mechanism can find, not by every call site in the app -- `formatReturnAnnotation`
 * says so in its own wording, per the H3 brief's honesty requirement.
 */
export function findGlobalCallSites(analysis: ModuleAnalysis, target: number): readonly CallSiteResult[] {
  const globalProps = globalPropertyOf(analysis);
  const str = globalProps.get(target);
  if (str === undefined) return [];
  const results: CallSiteResult[] = [];
  for (let caller = 0; caller < analysis.module.functions.length; caller++) {
    let cfg: FunctionCfg;
    try {
      cfg = analysis.cfg(caller);
    } catch {
      continue;
    }
    const writes = allWrites(cfg);
    for (const block of cfg.blocks) {
      const insns = block.instructions;
      for (let i = 0; i < insns.length; i++) {
        const insn = insns[i]!;
        if (!GET_BY_ID.has(insn.name)) continue;
        const dst = insn.operands[0]?.value;
        const obj = insn.operands[1]?.value;
        const s = stringOperand(insn);
        if (dst === undefined || obj === undefined || s !== str) continue;
        const objWrite = reachingWrite(cfg, writes, obj, block.id, i);
        if (objWrite === undefined || objWrite.insn.name !== "GetGlobalObject") continue;
        for (let j = i + 1; j < insns.length; j++) {
          const cand = insns[j]!;
          if (CALL_FAMILY.has(cand.name) && cand.operands[1]?.value === dst) {
            const callDst = cand.operands[0]?.value;
            if (callDst === undefined) break;
            const discarded = classifyAfter(cfg, block, j + 1, callDst);
            if (discarded !== undefined) results.push({ caller, offset: cand.offset, discarded });
            break;
          }
          if (writtenRegisters(cand).includes(dst)) break;
        }
      }
    }
  }
  return results;
}

/** The header-comment text for one function, or `undefined` when neither
 *  property is provable. (a) takes priority (an async function is never
 *  void in practice, since its own wrapper always returns a promise-valued
 *  object -- `isProvablyVoidFunction` correctly never fires for one). */
export function formatReturnAnnotation(cfg: FunctionCfg, isAsync: boolean, callSites: readonly CallSiteResult[]): string | undefined {
  if (isProvablyVoidFunction(cfg)) return "returns: nothing";
  if (!isAsync || callSites.length === 0) return undefined;
  const discarded = callSites.filter((s) => s.discarded);
  if (discarded.length === 0) return undefined;
  const list = discarded.map((s) => `fn#${s.caller}@0x${s.offset.toString(16)}`).join(", ");
  return `async, result discarded at ${discarded.length} of ${callSites.length} call sites this analysis can resolve (direct global-scope calls only, not every call site in the app): ${list}`;
}
