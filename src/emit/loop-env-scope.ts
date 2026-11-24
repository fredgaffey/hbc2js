// docs/specs/05-emitter.md §6 note — where a loop-local environment's `let`
// goes once its accesses are not all in the creating basic block.
//
// `src/emit/index.ts` keeps an environment created inside a loop per-iteration
// (a `let _e<env>_<slot>` at the Create*Environment site, not one function-top
// binding) when the create block dominates every access. The structurer can
// still put a dominated access in a statement list the create site's list does
// not enclose (`L1: { let _e1_0; ... } if (...) { _e1_0 = r2; }`), so the
// declaration is moved up to the innermost statement list that encloses every
// reference, just before the first statement that names it. Moving it up never
// crosses a loop body: that would turn one binding per inner iteration into one
// per outer iteration. When the enclosing list lies outside a loop the
// declaration sits in, the binding cannot be per-iteration in any placement the
// references can see, and the declaration goes to the function's top-level list
// instead -- exactly the function-wide binding the emitter used before (with
// W_LOOP_LOCAL_ENV, reported by the caller).
//
// A block-scoped `let` is not enough on its own: Hermes compiles without ES6
// block scoping by default, so a `let` inside a loop body is ONE binding per
// function activation there, and every iteration's closure shared it (fixture
// 17-closure-loop-var v99 and the torture `_loop` shape were DIVERGENT under
// the Hermes VMs). The per-iteration binding therefore becomes what the source
// had before hermesc inlined it: the statements from the declaration through
// the last reference are wrapped in `(function () { let _e...; ... })();`,
// when nothing in them binds differently across a function boundary
// (`opaqueReason`: return, this, arguments, yield, await, break/continue out
// of the range). A top-level declaration in the range that is read after it is
// hoisted in front of the wrapper (`let x = v` becomes `x = v` inside).
import type { Stmt } from "./ast.ts";
import { opaqueReason } from "./iife-reconstruct.ts";

/** A statement list's position: the path of (statement index, field) steps
 *  from the function body down to it. `loop` marks a loop body step. */
interface Step {
  readonly index: number;
  readonly field: string;
  readonly loop: boolean;
}

interface Loc {
  readonly list: readonly Step[];
  readonly index: number;
}


/** Child statement lists of a statement, with the field name that holds each. */
function childLists(s: Stmt): { field: string; list: readonly Stmt[]; loop: boolean }[] {
  switch (s.k) {
    case "if":
      return [
        { field: "then", list: s.then, loop: false },
        { field: "else", list: s.else, loop: false },
      ];
    case "while":
    case "do-while":
    case "for":
    case "for-in":
    case "for-of":
      return [{ field: "body", list: s.body, loop: true }];
    case "labeled":
      return [{ field: "body", list: s.body, loop: false }];
    case "try":
      return [
        { field: "block", list: s.block, loop: false },
        { field: "handler", list: s.handler, loop: false },
        ...(s.finalizer !== undefined ? [{ field: "finalizer", list: s.finalizer, loop: false }] : []),
      ];
    case "switch":
      return s.cases.map((c, i) => ({ field: `case${i}`, list: c.body, loop: false }));
    default:
      return [];
  }
}

/** Does `node` (anything but the child statement lists listed in `skip`) name one of `names`? */
function mentions(node: unknown, names: ReadonlySet<string>, skip: ReadonlySet<unknown>): boolean {
  if (node === null || typeof node !== "object" || skip.has(node)) return false;
  if (Array.isArray(node)) return node.some((x) => mentions(x, names, skip));
  const o = node as Record<string, unknown>;
  if (o.k === "ident" && typeof o.name === "string" && names.has(o.name)) return true;
  if (o.k === "decl" && Array.isArray(o.names) && o.names.some((n) => names.has(n as string))) return true;
  for (const key of Object.keys(o)) if (mentions(o[key], names, skip)) return true;
  return false;
}

function isGroupDecl(s: Stmt, names: ReadonlySet<string>): boolean {
  return s.k === "decl" && s.kind === "let" && s.names.length === names.size && s.names.every((n) => names.has(n));
}

function collect(list: readonly Stmt[], path: readonly Step[], names: ReadonlySet<string>, refs: Loc[], decls: Loc[]): void {
  list.forEach((s, index) => {
    if (isGroupDecl(s, names)) {
      decls.push({ list: path, index });
      return;
    }
    const kids = childLists(s);
    if (mentions(s, names, new Set(kids.map((c) => c.list)))) refs.push({ list: path, index });
    for (const c of kids) collect(c.list, [...path, { index, field: c.field, loop: c.loop }], names, refs, decls);
  });
}

function sameStep(a: Step, b: Step): boolean {
  return a.index === b.index && a.field === b.field;
}

function mapList(list: readonly Stmt[], path: readonly Step[], f: (l: readonly Stmt[]) => Stmt[]): Stmt[] {
  if (path.length === 0) return f(list);
  const [step, ...rest] = path as [Step, ...Step[]];
  return list.map((s, i) => {
    if (i !== step.index) return s;
    const o = s as unknown as Record<string, unknown>;
    if (step.field.startsWith("case")) {
      const ci = Number(step.field.slice(4));
      const sw = s as Extract<Stmt, { k: "switch" }>;
      return { ...sw, cases: sw.cases.map((c, j) => (j === ci ? { ...c, body: mapList(c.body, rest, f) } : c)) } as Stmt;
    }
    return { ...o, [step.field]: mapList(o[step.field] as readonly Stmt[], rest, f) } as unknown as Stmt;
  });
}

export interface SettleResult {
  readonly body: readonly Stmt[];
  /** Groups whose declaration had to leave its loop (function-wide binding). */
  readonly widened: readonly (readonly string[])[];
}

/** Moves each group's loop-local `let` to where every reference sees it. */
export function settleLoopLocalDecls(body: readonly Stmt[], groups: readonly (readonly string[])[]): SettleResult {
  let out = body;
  const widened: (readonly string[])[] = [];
  for (const group of groups) {
    const names = new Set(group);
    const refs: Loc[] = [];
    const decls: Loc[] = [];
    collect(out, [], names, refs, decls);
    if (decls.length !== 1 || refs.length === 0) continue;
    const decl = decls[0]!;
    // Longest common list path of the declaration and every reference.
    let common = decl.list.length;
    for (const r of refs) {
      let k = 0;
      while (k < common && k < r.list.length && sameStep(decl.list[k]!, r.list[k]!)) k++;
      common = k;
    }
    let target = decl.list.slice(0, common);
    if (decl.list.slice(common).some((s) => s.loop)) {
      target = [];
      widened.push(group);
    }
    const depth = target.length;
    const firstAt = (l: Loc): number => (l.list.length === depth ? l.index : l.list[depth]!.index);
    const insertAt = Math.min(...refs.filter((r) => target.every((s, i) => r.list[i] !== undefined && sameStep(s, r.list[i]!))).map(firstAt));
    if (decl.list.length === depth && decl.index <= insertAt) continue; // already in scope of every reference
    const stmt = (() => {
      let l: readonly Stmt[] = out;
      for (const s of decl.list) {
        const st = l[s.index]!;
        l = s.field.startsWith("case") ? (st as Extract<Stmt, { k: "switch" }>).cases[Number(s.field.slice(4))]!.body : ((st as unknown as Record<string, unknown>)[s.field] as readonly Stmt[]);
      }
      return l[decl.index]!;
    })();
    // Insert first (the target list encloses the declaration's list, so the
    // insertion index is unaffected by the removal unless they are the same
    // list, handled by removing at the shifted index).
    out = mapList(out, target, (l) => [...l.slice(0, insertAt), stmt, ...l.slice(insertAt)]);
    const removeIn = decl.list.length === depth ? { list: decl.list, index: decl.index >= insertAt ? decl.index + 1 : decl.index } : { list: decl.list.map((s, i) => (i === depth && s.index >= insertAt ? { ...s, index: s.index + 1 } : s)), index: decl.index };
    out = mapList(out, removeIn.list, (l) => l.filter((_, i) => i !== removeIn.index));
  }
  for (const group of groups) {
    if (widened.includes(group)) continue;
    out = wrapGroup(out, new Set(group));
  }
  return { body: out, widened };
}

function listAt(body: readonly Stmt[], path: readonly Step[]): readonly Stmt[] {
  let l = body;
  for (const s of path) {
    const st = l[s.index]!;
    l = s.field.startsWith("case") ? (st as Extract<Stmt, { k: "switch" }>).cases[Number(s.field.slice(4))]!.body : ((st as unknown as Record<string, unknown>)[s.field] as readonly Stmt[]);
  }
  return l;
}

/**
 * Wraps one group's declaration and every statement up to its last reference
 * in an IIFE. The range is first tried in the declaration's own list; when it
 * cannot be wrapped there (a `break` to a label just outside it, typically the
 * structurer's `L1: { ... break L1; }`), it is lifted one enclosing statement
 * at a time, never past the innermost loop body the declaration sits in.
 */
function wrapGroup(body: readonly Stmt[], names: ReadonlySet<string>): readonly Stmt[] {
  const refs: Loc[] = [];
  const decls: Loc[] = [];
  collect(body, [], names, refs, decls);
  if (decls.length !== 1 || refs.length === 0) return body;
  const decl = decls[0]!;
  const depth = decl.list.length;
  let loopDepth = -1; // index of the innermost loop-body step
  decl.list.forEach((s, i) => {
    if (s.loop) loopDepth = i;
  });
  if (loopDepth < 0) return body; // not inside a loop: one binding is right
  for (const r of refs) if (r.list.length < depth || !decl.list.every((s, i) => sameStep(s, r.list[i]!))) return body;
  const declStmt = listAt(body, decl.list)[decl.index]!;
  // Without the declaration: the range at each level is cut from this.
  const bare = mapList(body, decl.list, (l) => l.filter((_, i) => i !== decl.index));
  for (let level = depth; level > loopDepth; level--) {
    const path = decl.list.slice(0, level);
    const first = level === depth ? decl.index : decl.list[level]!.index;
    let last = first - 1;
    for (const r of refs) {
      let at = r.list.length === level ? r.index : r.list[level]!.index;
      if (level === depth && at > decl.index) at--; // the declaration is gone from `bare`
      if (at < first) return body;
      last = Math.max(last, at);
    }
    const list = listAt(bare, path);
    const range = list.slice(first, last + 1);
    if (opaqueReason(range) !== null) continue;
    const own = new Set<string>();
    for (const st of range) {
      if (st.k === "decl") st.names.forEach((n) => own.add(n));
      else if (st.k === "init") own.add(st.name);
      else if (st.k === "func" || st.k === "classdecl") own.add(st.name);
    }
    const hoist = new Set<string>();
    if (own.size > 0) {
      const rest = mapList(bare, path, (l) => [...l.slice(0, first), ...l.slice(last + 1)]);
      for (const n of own) if (mentions(rest, new Set([n]), new Set())) hoist.add(n);
      if (range.some((st) => (st.k === "func" || st.k === "classdecl") && hoist.has(st.name))) return body;
    }
    const inner: Stmt[] = [declStmt];
    for (const st of range) {
      if (st.k === "init" && hoist.has(st.name)) inner.push({ k: "expr", expr: { k: "assign", target: { k: "ident", name: st.name }, value: st.value } });
      else if (st.k === "decl" && st.names.some((n) => hoist.has(n))) {
        const keep = st.names.filter((n) => !hoist.has(n));
        if (keep.length > 0) inner.push({ ...st, names: keep });
      } else inner.push(st);
    }
    const replacement: Stmt[] = [];
    if (hoist.size > 0) replacement.push({ k: "decl", kind: "let", names: [...hoist] });
    replacement.push({ k: "iife", body: inner });
    return mapList(bare, path, (l) => [...l.slice(0, first), ...replacement, ...l.slice(last + 1)]);
  }
  return body;
}
