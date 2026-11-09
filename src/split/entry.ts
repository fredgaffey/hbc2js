// src/split/entry.ts — find the Metro entry module id from the bundle's
// global function: the last `<globalObj>.__r(<literal id>)` call (Metro's
// `require(entryId)`, run after every `__d()` registration). Best-effort,
// top-level statements only — see src/split/tag.ts's header comment.
import type { Expr, Stmt } from "../emit/ast.ts";
import { classify, isReflectApply, type Tag } from "./tag.ts";
import { walk } from "../passes/ast.ts";

/** Registers that every assignment in the global function's own code (nested
 *  blocks included, nested functions excluded) sets to one and the same
 *  integer literal. hermesc -O materialises a constant into a register once,
 *  possibly inside a labelled block, and reads it at top level much later —
 *  the entry id `0` of a Metro bundle's final `__r(0)` is the case that matters
 *  (export-boot L4). A register with any other or differing assignment is left
 *  out. */
function singleConstRegisters(globalBody: readonly Stmt[]): Map<string, number> {
  const fnOf = (s: Stmt): number | undefined => (s as { readonly origin?: { readonly fn?: number } }).origin?.fn;
  const own = globalBody.map(fnOf).find((f) => f !== undefined);
  const seen = new Map<string, number | "mixed">();
  walk(globalBody, {
    stmt: (s) => {
      if (fnOf(s) !== own) return;
      const at = assignedIdent(s);
      if (at === null) return;
      const v = at.value.k === "lit" && /^-?\d+$/.test(at.value.text) ? Number(at.value.text) : "mixed";
      const cur = seen.get(at.name);
      seen.set(at.name, cur === undefined || cur === v ? v : "mixed");
    },
  });
  const out = new Map<string, number>();
  for (const [name, v] of seen) if (v !== "mixed") out.set(name, v);
  return out;
}

function assignedIdent(s: Stmt): { readonly name: string; readonly value: Expr } | null {
  if (s.k === "init") return { name: s.name, value: s.value };
  if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident") return { name: s.expr.target.name, value: s.expr.value };
  return null;
}

export function resolveEntryModuleId(globalBody: readonly Stmt[]): number | null {
  const ids = resolveStartupModuleIds(globalBody);
  return ids.length > 0 ? ids[ids.length - 1]! : null;
}

/** Every top-level `<globalObj>.__r(<literal id>)` call, in order: Metro's
 *  run-before-main modules (e.g. RN's InitializeCore) followed by the entry
 *  module (spec 33 L1: an export must run all of them, not just the last). */
export function resolveStartupModuleIds(globalBody: readonly Stmt[]): number[] {
  const regs = new Map<string, Tag>();
  const noParams = new Set<string>();
  const ids: number[] = [];
  let consts: Map<string, number> | undefined;

  const checkCall = (call: Extract<Expr, { k: "call" }>): void => {
    if (!isReflectApply(call.callee) || call.args.length !== 3) return;
    const fnTag = classify(call.args[0]!, regs, noParams);
    if (!(fnTag.kind === "prop" && fnTag.name === "__r")) return;
    const arr = call.args[2]!;
    if (arr.k !== "array" || arr.elements.length !== 1) return;
    const argTag = classify(arr.elements[0]!, regs, noParams);
    if (argTag.kind === "num") ids.push(argTag.value);
    else if (arr.elements[0]!.k === "ident") {
      consts ??= singleConstRegisters(globalBody);
      const v = consts.get(arr.elements[0]!.name);
      if (v !== undefined) ids.push(v);
    }
  };

  for (const s of globalBody) {
    const at = assignedIdent(s);
    if (at !== null) {
      if (at.value.k === "call") {
        checkCall(at.value);
        regs.set(at.name, { kind: "other" });
      } else {
        regs.set(at.name, classify(at.value, regs, noParams));
      }
      continue;
    }
    if (s.k === "expr" && s.expr.k === "call") checkCall(s.expr);
  }
  return ids;
}
