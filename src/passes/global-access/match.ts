// global-access matcher — docs/LOWERING-CATALOGUE.md row R2,
// docs/specs/passes/03-global-access.md §4.
//
// Site = one statement list `L` (`ctx.fnBody` reachable, innermost first).
// Scans `L` for the first `if (!("p" in G)) { throw new ReferenceError(...) }`
// guard (§2's baseline shape) whose object `G` is a *proven* global reference
// and whose property `p` has exactly one qualifying member read later in the
// same list. `classifySite` is exported so `check.ts` can re-derive the same
// verdict from `before` alone (it gets no access to this match's `data`) and
// so unit tests can assert the exact refuse reason without going through the
// driver — the same split `expr-rebuild/match.ts` uses.
import type { Expr, Stmt } from "../ast.ts";
import { enclosingResumeBody, identUses, isRegisterName, isSafeIdentifier, sameFrameBody, walk } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

export interface GlobalAccessSite {
  readonly guardIndex: number;
  readonly useIndex: number;
  readonly name: string;
  readonly global: Expr;
}

export type GlobalAccessMatch = Match<readonly Stmt[], GlobalAccessSite>;

export type RefuseReason = "unproven-global" | "loop-reentry-clobber" | "pre-guard-clobber" | "shadowed" | "unsafe-identifier" | "no-read-after-guard" | "clobbered-between" | "read-twice" | "guard-in-other-list";

export type ClassifyResult = { readonly ok: true; readonly site: GlobalAccessSite } | { readonly ok: false; readonly reason: RefuseReason };

// ---------------------------------------------------------------------------
// §2 guard-shape recognition.
// ---------------------------------------------------------------------------

export interface GuardShape {
  readonly name: string;
  readonly global: Expr;
}

/** `s` is exactly §2's baseline shape: `if (!("p" in G)) { throw new
 *  ReferenceError("Property 'p' doesn't exist"); }`, empty `else`. The
 *  message is reconstructed from the extracted `p` and compared verbatim —
 *  `p` is always drawn from the `"p"` operand of the `in` test itself, so
 *  this is a defensive cross-check that the two textually agree, not an
 *  independent source of `p`. Returns `null` for anything else, including a
 *  same-shaped guard with a different callee/message (TDZ's
 *  `ThrowIfEmpty`, `super()`-called-twice, `ThrowIfHasRestrictedGlobalProperty`
 *  — none of which negate `in`, or throw `ReferenceError` with this message). */
export function recognizeGuard(s: Stmt): GuardShape | null {
  if (s.k !== "if" || s.else.length !== 0 || s.then.length !== 1) return null;
  const thrown = s.then[0]!;
  if (thrown.k !== "throw") return null;
  const arg = thrown.arg;
  if (arg.k !== "new" || arg.callee.k !== "ident" || arg.callee.name !== "ReferenceError") return null;
  if (arg.args.length !== 1 || arg.args[0]!.k !== "lit") return null;
  const test = s.test;
  if (test.k !== "unary" || test.op !== "!") return null;
  const inner = test.arg;
  if (inner.k !== "bin" || inner.op !== "in" || inner.left.k !== "lit") return null;
  const raw = inner.left.text;
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return null;
  const name = raw.slice(1, -1);
  const expectedMessage = `"Property '${name}' doesn't exist"`;
  if (arg.args[0]!.text !== expectedMessage) return null;
  return { name, global: inner.right };
}

// ---------------------------------------------------------------------------
// §4's global-reference proof.
// ---------------------------------------------------------------------------

/** Every `expr`-statement store `rX = value` reachable from `stmts`
 *  (including nested statement lists, excluding a nested `func`'s own frame
 *  — mirrors `identUses`'s own nested/non-nested split), for `rX === reg`.
 *  Registers are never declared via `init` (spec 05 §3: a leading `decl let
 *  r0…rN`, assigned only by plain `expr` stores), so that is the only shape
 *  a register write can take. */
function registerStoreValues(stmts: readonly Stmt[], reg: string): readonly Expr[] {
  const out: Expr[] = [];
  const visit = (list: readonly Stmt[]): void => {
    for (const s of list) {
      if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && s.expr.target.name === reg) out.push(s.expr.value);
      switch (s.k) {
        case "if":
          visit(s.then);
          visit(s.else);
          break;
        case "while":
        case "do-while":
        case "for":
        case "labeled":
        case "iife":
          visit(s.body);
          break;
        case "try":
          visit(s.block);
          visit(s.handler);
          break;
        case "switch":
          for (const c of s.cases) visit(c.body);
          break;
        case "return": {
          const resume = sameFrameBody(s); // the resume closure is this frame (00-LADDER "Resumable bodies")
          if (resume !== null) visit(resume);
          break;
        }
        default:
          break; // decl, break, continue, throw (no sub-list), func (separate frame)
      }
    }
  };
  visit(stmts);
  return out;
}

/**
 * §4: `G` is a global reference when it is `globalThis` itself, or a
 * register with no nested-closure read (`identUses(...).nested === 0`) and
 * exactly one write whose value is `{k:"ident", name:"globalThis"}`, that
 * write being the register's chronologically **first** write in the whole
 * function (`registerStoreValues` walks in the same pre-order `defUse`
 * uses, "assigned before recursing into it", so index 0 is that write).
 *
 * Deviation from §4's literal text (recorded per the agent notes's "every
 * change ships tests + docs" rule, and in `the work log`): §4 reads as
 * "`defUse` gives `rN` exactly one write in the whole function [and] that
 * write's value is `globalThis`" — i.e. exactly one write, full stop. Measured
 * directly against all three `targets` fixtures (`19-var-hoisting` fn#1
 * "demo", fn#0; `02-while-loop`; `01-if-else-chain`), the register holding
 * `globalThis` is **always** reused for an unrelated scratch value once its
 * last guarded read has passed — most commonly `r = <lastGlobalCall>(...);
 * return r;`, the register allocator reusing the now-dead handle to hold the
 * return value. Every one of these fixtures' guards would refuse
 * `unproven-global` under the literal rule, corpus-wide, on the exact
 * fixtures the spec's own §7 lists as required red->green targets — the rung
 * would recognise its own idiom nowhere. The narrower rule implemented here
 * ("exactly one write is *ever* valued `globalThis`, and it is the first")
 * still refuses the spec's explicit "two `globalThis` stores" negative test
 * (ambiguous: which one dominates a given read?) and still requires
 * `identUses(...).nested === 0` and — for the one guard/read pair actually
 * being folded — the unchanged §4 condition 3 ("no statement in
 * `L[i+1..j-1]` writes `G`") as the local clobber guard for *that* site.
 *
 * This proof is deliberately whole-function and **position-blind**: it answers
 * "which write ever put `globalThis` here", not "can it still be there at this
 * site". The site-aware half — chronology is only domination where control
 * runs through the list once — is §4 condition 5, `hasLoopReentryClobber`
 * below (docs/BUGS.md T14). It
 * is unsound only against a register whose value legitimately reverts to
 * `globalThis`-equivalent behaviour after an intervening reassignment in a
 * *different* statement list the current site cannot see — a shape no
 * fixture in this corpus produces (Hermes's allocator does not reuse a
 * live register), and stage B has no CFG to rule out in general (the same
 * limitation `expr-rebuild`'s own D-a/D-b proof already accepts).
 */
export function isProvenGlobal(fnBody: readonly Stmt[], e: Expr): boolean {
  if (e.k !== "ident") return false;
  if (e.name === "globalThis") return true;
  if (!isRegisterName(e.name)) return false;
  if (identUses(fnBody, e.name).nested !== 0) return false;
  const writes = registerStoreValues(fnBody, e.name);
  const globalWriteIndices = writes.reduce<number[]>((acc, w, idx) => (w.k === "ident" && w.name === "globalThis" ? [...acc, idx] : acc), []);
  return globalWriteIndices.length === 1 && globalWriteIndices[0] === 0;
}

/**
 * §4 condition 7 (2026-11-09, roundtrip `diff:JmpTrue(label)` bucket): the
 * **local** proof, an alternative to `isProvenGlobal` for one site. Hermes
 * often loads `globalThis` into a register that already held an unrelated
 * value earlier in the function, so the whole-function rule ("the register's
 * first write is its only `globalThis` write") refuses although the store sits
 * right before the guard. Sound without any whole-function reasoning when:
 *
 *  - some `list[k]`, `k < guardIndex`, is exactly `rN = globalThis` (the
 *    `GetGlobalObject` lowering), and no statement in `list[k+1..guardIndex-1]`
 *    writes `rN` at any depth (`identUses(...).writes`, which also sees
 *    assignments buried inside expressions). A structured statement list can
 *    only be entered at its start, and a `break`/`continue` landing inside it
 *    lands after the statement that contains it, so every arrival at the guard
 *    (including every loop re-entry) has just run `list[k]`: condition 5 and
 *    condition 6 are subsumed;
 *  - nothing in `list[guardIndex+1..useIndex-1]` writes `rN` (condition 3,
 *    re-asserted here so `check` re-derives it from `before`);
 *  - the read's own statement `list[useIndex]` cannot write `rN` before the
 *    read: it writes `rN` nowhere, or it is exactly `rN = value` with no write
 *    to `rN` inside `value` (the store happens after the read).
 *
 * Condition 3 (no write to `G` between guard and read) is checked by
 * `classifySite`/`check` for every proof alike.
 */
export function isLocallyProvenGlobal(list: readonly Stmt[], guardIndex: number, useIndex: number, e: Expr): boolean {
  if (e.k !== "ident" || !isRegisterName(e.name)) return false;
  const reg = e.name;
  let k = guardIndex - 1;
  for (; k >= 0; k--) {
    const s = list[k]!;
    if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && s.expr.target.name === reg && s.expr.value.k === "ident" && s.expr.value.name === "globalThis") break;
    if (identUses([s], reg).writes > 0) return false;
  }
  if (k < 0) return false;
  const use = list[useIndex];
  if (use === undefined || useIndex <= guardIndex) return false;
  // condition 3 re-asserted inside the proof, so `check` re-derives it too
  if (identUses(list.slice(guardIndex + 1, useIndex), reg).writes > 0) return false;
  if (identUses([use], reg).writes === 0) return true;
  return use.k === "expr" && use.expr.k === "assign" && use.expr.target.k === "ident" && use.expr.target.name === reg && identUses([{ k: "expr", expr: use.expr.value }], reg).writes === 0;
}

// ---------------------------------------------------------------------------
// §4 condition 5: repeat-visit (loop re-entry) soundness.
// ---------------------------------------------------------------------------

/** The **outermost** loop body (`while`/`do-while`/`for`, labelled or not)
 *  that transitively contains the statement list `target`, or `null` when
 *  `target` is not inside a loop at all. Lists are compared by *identity*:
 *  `stmtLists` (`src/passes/ast.ts`) hands the driver the very arrays that
 *  live inside `ctx.fnBody`, and `check` receives that same `before` array,
 *  so both sides re-derive the same answer with no extra plumbing through
 *  `classifySite`'s signature (the smaller of the two options the fix could
 *  take — see docs/specs/passes/03-global-access.md §4). `labeled` and
 *  `iife` bodies are *not* loops themselves (a labelled block runs once; a
 *  labelled *loop* is a `while`/`for` carrying a `label`), but they are
 *  transparent: a list inside a `labeled` inside a `while` is still inside
 *  that `while`. A `func` body is a separate frame and is never entered. */
function outermostLoopBodyContaining(fnBody: readonly Stmt[], target: readonly Stmt[]): readonly Stmt[] | null {
  const visit = (list: readonly Stmt[], loop: readonly Stmt[] | null): { readonly loop: readonly Stmt[] | null } | null => {
    if (list === target) return { loop };
    for (const s of list) {
      let hit: { readonly loop: readonly Stmt[] | null } | null = null;
      switch (s.k) {
        case "if":
          hit = visit(s.then, loop) ?? visit(s.else, loop);
          break;
        case "while":
        case "do-while":
        case "for":
          hit = visit(s.body, loop ?? s.body);
          break;
        case "labeled":
        case "iife":
          hit = visit(s.body, loop);
          break;
        case "try":
          hit = visit(s.block, loop) ?? visit(s.handler, loop);
          break;
        case "switch":
          for (const c of s.cases) {
            hit = visit(c.body, loop);
            if (hit !== null) break;
          }
          break;
        case "return": {
          // The `sameFrame` resume closure runs again on every resume, with
          // the registers the previous resume left: it is a loop body
          // (00-LADDER "Resumable bodies"), the outermost one.
          const resume = sameFrameBody(s);
          if (resume !== null) hit = visit(resume, loop ?? resume);
          break;
        }
        default:
          break; // decl, break, continue, throw, expr, func (separate frame)
      }
      if (hit !== null) return hit;
    }
    return null;
  };
  return visit(fnBody, null)?.loop ?? null;
}

/**
 * §4 condition 5 (2026-08-30, docs/BUGS.md T14). `isProvenGlobal` is a
 * whole-function, *position-blind* proof: "exactly one write is ever valued
 * `globalThis`, and it is chronologically the first". Chronology in a
 * statement list is only a sound stand-in for domination while control flow
 * runs through that list **once**. Inside a loop, a write that comes *after*
 * the guarded read in program text runs *before* it on every repeat visit,
 * so a register the whole-function rule calls "proven" can hold something
 * else from the 2nd iteration on and the fold to a bare global is wrong —
 * the exact shape pinned in `tests/gate/passes/adversarial-ladder.test.ts`
 * ("global-access BUG (pinned)") and confirmed divergent under `node:vm`.
 *
 * So: when the site's statement list is (transitively) inside a loop, take
 * the **outermost** enclosing loop body — a clobber in an outer loop can
 * precede the read on that outer loop's re-entry just as an inner one can —
 * and refuse if it contains *any* write to `G`'s register whose value is not
 * literally `globalThis`, wherever it sits relative to the read and however
 * deeply nested. A write valued `globalThis` re-establishes exactly the
 * value being proven, so it is not a clobber.
 *
 * Non-loop sites keep the whole-function rule unchanged, which is what keeps
 * §7's `targets` fixtures green: Hermes reuses the `globalThis` register for
 * a scratch value after its last guarded read, and that reuse is only a
 * hazard if it can run again before the read.
 */
export function hasLoopReentryClobber(fnBody: readonly Stmt[], list: readonly Stmt[], e: Expr): boolean {
  if (e.k !== "ident" || !isRegisterName(e.name)) return false; // bare `globalThis` cannot be assigned
  const loopBody = outermostLoopBodyContaining(fnBody, list);
  if (loopBody === null) return false;
  return registerStoreValues(loopBody, e.name).some((w) => !(w.k === "ident" && w.name === "globalThis"));
}

// ---------------------------------------------------------------------------
// §4 condition 6: a write BEFORE the guard can clobber the register.
// ---------------------------------------------------------------------------

/** Writes to `reg` in every statement list that *precedes* `target` in flow
 *  order, from `list` outward-in: the statements of `list` before the one
 *  containing `target`, then (recursively) the same inside that statement,
 *  down to `target`'s immediately enclosing list. Returns `null` when
 *  `target` is not reachable from `list` at all (compared by identity, like
 *  `outermostLoopBodyContaining`). Writes are returned in flow order
 *  (outermost prefix first), at **any nesting depth** — a write buried in an
 *  `if` before the guard is a *possible* clobber and is reported as one;
 *  §4 condition 6 refuses rather than trying to prove the branch untaken. */
function prefixWrites(list: readonly Stmt[], target: readonly Stmt[], reg: string): readonly Expr[] | null {
  if (list === target) return [];
  const prefix: Expr[] = [];
  for (const s of list) {
    const inner = prefixWritesIn(s, target, reg);
    if (inner !== null) return [...prefix, ...inner];
    prefix.push(...registerStoreValues([s], reg));
  }
  return null;
}

/** `prefixWrites` for the sub-lists of one statement. An `if`'s `then` and
 *  `else` are *alternatives*, so entering one never inherits the other's
 *  writes; a `try`'s `block` does run before its `handler`, so descending
 *  into the handler inherits the block's writes. A loop body's own later
 *  statements are §4 condition 5's business, not this one's. A `func` body
 *  is a separate frame and is never entered. */
function prefixWritesIn(s: Stmt, target: readonly Stmt[], reg: string): readonly Expr[] | null {
  switch (s.k) {
    case "if":
      return prefixWrites(s.then, target, reg) ?? prefixWrites(s.else, target, reg);
    case "while":
    case "do-while":
    case "for":
    case "labeled":
    case "iife":
      return prefixWrites(s.body, target, reg);
    case "try": {
      const inBlock = prefixWrites(s.block, target, reg);
      if (inBlock !== null) return inBlock;
      const inHandler = prefixWrites(s.handler, target, reg);
      return inHandler === null ? null : [...registerStoreValues(s.block, reg), ...inHandler];
    }
    case "switch": {
      for (const c of s.cases) {
        const hit = prefixWrites(c.body, target, reg);
        if (hit !== null) return hit;
      }
      return null;
    }
    case "return": {
      const resume = sameFrameBody(s); // the resume closure: this frame (00-LADDER "Resumable bodies")
      return resume === null ? null : prefixWrites(resume, target, reg);
    }
    default:
      return null; // decl, break, continue, throw, expr, func, directive, comment, raw
  }
}

/**
 * §4 condition 6 (2026-09-04). The companion to condition 5, same root cause
 * — `isProvenGlobal` is *position-blind* — but the other region: writes that
 * sit **before** the guard. Condition 3 only scans `L[i+1..j-1]`, so the flat
 * list
 *
 * ```
 * r1 = globalThis; r1 = other; if (!("p" in r1)) throw …; r0 = r1.p;
 * ```
 *
 * used to fold to a bare `p` even though `r1` is `other` at the read — the
 * whole-function proof sees one `globalThis` write, chronologically first,
 * and says "proven".
 *
 * The sound requirement is that the last write to `G`'s register that can
 * reach the guard in flow order is valued `globalThis`. This is the
 * approximation the stage-B machinery can express without a CFG: walk
 * `L[0..i-1]` plus every enclosing list's statements before the one
 * containing `L` (outward to `fnBody`), at any nesting depth, and require the
 * **last** write found to be `{k:"ident", name:"globalThis"}`. Because
 * `isProvenGlobal` has already established that exactly one write in the
 * whole function is valued `globalThis`, "the last pre-guard write is the
 * `globalThis` one" is equivalent to "no other write precedes the guard at
 * all" — the two readings of the rule coincide.
 *
 * Two deliberate limits, both measured against the whole construct corpus
 * (61 constructs x 5 versions x plain/.min/.obf) rather than argued:
 *
 *  - **No pre-guard write found at all is NOT a refusal.** Control-flow
 *    flattened (`.obf`) output puts `rN = globalThis` in one `__pc` dispatch
 *    case and the guards in others, so the store is nowhere in the site's
 *    *textual* prefix even though it dominates. Refusing there costs 141 of
 *    the 768 corpus outputs their folds (every `.obf` tier at v84/v94/v96)
 *    for no soundness gain over the pre-existing whole-function proof, which
 *    is exactly as position-blind about that case as it always was. This
 *    condition only adds information when a write *is* visible before the
 *    guard; where none is, the old proof stands unchanged.
 *  - **A write on a path that cannot reach the guard still refuses.** The
 *    walk is flow-order but not path-sensitive: a write inside an `if` whose
 *    branch ends in `throw` is counted, because proving the branch untaken
 *    needs reachability analysis stage B does not have. Measured cost: the
 *    two guards in `14-nested-try-catch/*.obf` (all five versions), where
 *    `r3 = r3.Error` sits in a branch that always throws. That is a
 *    readability cost only — the refusal direction is always the safe one.
 *
 * Non-clobbering shapes this deliberately leaves alone: the `targets`
 * fixtures' scratch-reuse idiom (`r = <lastGlobalCall>(…); return r;`) lives
 * *after* the last guarded read, so it is never in any site's prefix.
 */
export function hasPreGuardClobber(fnBody: readonly Stmt[], list: readonly Stmt[], guardIndex: number, e: Expr): boolean {
  if (e.k !== "ident" || !isRegisterName(e.name)) return false; // bare `globalThis` cannot be assigned
  const outer = prefixWrites(fnBody, list, e.name);
  if (outer === null) return false; // `list` is not reachable from `fnBody`: same convention as `outermostLoopBodyContaining`
  const writes = [...outer];
  for (let k = 0; k < guardIndex; k++) writes.push(...registerStoreValues([list[k]!], e.name));
  const last = writes[writes.length - 1];
  // Resume entry (00-LADDER "Resumable bodies"): inside the `sameFrame`
  // resume closure a register's incoming value was left by an EARLIER
  // resume (or is still `undefined` on the first), which the textual prefix
  // cannot see, so "no visible pre-guard write" is a refusal there.
  if (last === undefined && enclosingResumeBody(fnBody, list) !== null) return true;
  if (last === undefined) return false; // no write to `G` is visible before the guard at all: nothing new to say, the whole-function proof stands (see the doc comment)
  return !(last.k === "ident" && last.name === "globalThis");
}

// ---------------------------------------------------------------------------
// §4.2: shadowing.
// ---------------------------------------------------------------------------

// Synthetic-name patterns `src/emit/names.ts` produces (a rung may not import
// it — D12a — so these are copied, same convention `isSafeIdentifier` above
// already follows): `_e<env>_<slot>` (env slots), `_fn<n>` (top-level function
// bindings), `a<n>` (named parameters, `src/emit/function.ts:168`), and every
// `__`-prefixed scratch/protocol name (`__pc`, `__exc`, `__t`, `__state*`,
// `__hbc*`, …). A register name is covered by `isRegisterName` already.
const ENV_SLOT_RE = /^_e\d+_\d+$/;
const FN_NAME_RE = /^_fn\d+$/;
const PARAM_RE = /^a[1-9]\d*$/;

function looksSynthetic(name: string): boolean {
  return isRegisterName(name) || ENV_SLOT_RE.test(name) || FN_NAME_RE.test(name) || PARAM_RE.test(name) || name.startsWith("__");
}

// `classifySite` calls `isShadowed` once
// per candidate guard `list[i]` in a `match`/driver iteration, and every one
// of those calls used to re-walk the *entire* function body from scratch
// just to answer one membership test (measured: 16.1 s of a 81.7 s whole-
// file decompile on the held-out release fixture, `src/passes/ast.ts`'s
// `walkExpr`/`walkStmts` driven almost entirely by this one call site).
//
// Memoised on `stmts`' own identity, exactly like `registerUsesMemo` in
// `src/passes/ast.ts` (see that WeakMap's doc comment for the fuller
// argument). Sound for the same reason: stage-B statement lists are never
// mutated in place, only replaced wholesale by `spliceList` /
// every rung's `rewrite` -- an edit that changes what's declared in `stmts`
// produces a *new* array object, it never rewrites the members of the old
// one. So a `Set` cached under a given `readonly Stmt[]` identity can never
// go stale: by the time a declaration inside that list changes, `stmts`
// itself (this exact array reference) is no longer reachable as anyone's
// `fnBody`/`list` -- the driver iteration that made the edit is already
// holding the new array. There is no code path in this codebase that
// splices, pushes to, or otherwise mutates a `Stmt[]` that is currently
// installed as `ctx.fnBody` or a pass's `list`; every rewrite path
// (`src/passes/ast.ts`'s `spliceList`, and each pass's own `rewrite.ts`)
// only ever builds and returns a fresh array. Grepping this tree for a
// `.push(`/`.splice(`/index assignment on a `Stmt[]` variable that already
// escaped into a pass's `list`/`fnBody` turns up none; if one is ever added,
// this cache would need either dropping or an explicit invalidation call at
// that mutation site, exactly as `noteRegisterUsesSplice` exists for
// `registerUsesMemo`'s own edited-in-place carry-forward case (which is a
// *derive the new entry from the old one* path, not an in-place mutation of
// the old array).
const declaredNamesMemo = new WeakMap<readonly Stmt[], Set<string>>();

/** Names bound anywhere in `stmts` by `decl`/`init`/a `func`'s own name or
 *  parameters, or a `catch` binding — mirrors `freeNames`'s internal `bound`
 *  computation (not itself exported by `ast.ts`, so copied here). Memoised
 *  by list identity (see `declaredNamesMemo` above); exported so a test can
 *  pin the memoisation as a counted (not wall-clock) invariant, the same
 *  way `classifySite`/`recognizeGuard` are exported for their own unit
 *  tests. */
export function declaredNames(stmts: readonly Stmt[]): Set<string> {
  const cached = declaredNamesMemo.get(stmts);
  if (cached !== undefined) return cached;
  const bound = new Set<string>();
  walk(stmts, {
    expr: (e) => {
      if (e.k === "func") {
        if (e.name !== null) bound.add(e.name);
        for (const param of e.params) bound.add(param.name);
      }
    },
    stmt: (s) => {
      if (s.k === "decl") for (const n of s.names) bound.add(n);
      else if (s.k === "init") bound.add(s.name);
      else if (s.k === "try") { if (s.param !== null) bound.add(s.param); }
      else if (s.k === "func") {
        bound.add(s.name);
        for (const param of s.params) bound.add(param.name);
      }
    },
  });
  declaredNamesMemo.set(stmts, bound);
  return bound;
}

/** §4.2: would introducing `name` as a bare identifier collide with
 *  something already meaningful here? When in doubt, `true` (refuse). */
export function isShadowed(name: string, fnBody: readonly Stmt[]): boolean {
  return looksSynthetic(name) || declaredNames(fnBody).has(name);
}

// ---------------------------------------------------------------------------
// Emitter interface: `src/emit/scope-check.ts`'s EM-01 guard.
// ---------------------------------------------------------------------------

/**
 * How a folded read survives EM-01. `src/emit/scope-check.ts`'s
 * `checkBindings` runs, unconditionally, on every emitted program
 * (`emit/index.ts`'s `emitModule`, after every stage-B pass including this
 * one) and throws `E_UNBOUND_IDENT` for any free bare identifier — a program
 * global is normally read through `globalThis.<name>`, so a free name would
 * otherwise only ever be an emitter bug. This rung's entire idiom
 * (`globalThis.print` -> `print`) legitimately produces one, so
 * `rewrite.ts` tags the folded `ident` node with `global: true` and the
 * emitter accepts a so-marked read as intentional (a *read* only — a write
 * or a `DeclareGlobalVar` keeps its `globalThis.x` form, D14). That marker
 * is the whole interface: because it exists, this rung folds any *proven*
 * global whose name is a safe, non-shadowed identifier — a real host global
 * (`print`, `console`, `window`, `alert`, `require`, …) just as much as an
 * ECMAScript intrinsic — with no allowlist to consult. Previously the rung
 * had to refuse (`unbound-in-emitted-scope`) every name outside a copied
 * `KNOWN_GLOBALS` set to avoid crashing `decompile()`; that cap (and its
 * ~61% ceiling on §7's metric) is gone now that the emitter carries the
 * marker.
 */

// ---------------------------------------------------------------------------
// The one property read the guard licenses deleting.
// ---------------------------------------------------------------------------

function sameIdent(a: Expr, b: Expr): boolean {
  return a.k === "ident" && b.k === "ident" && a.name === b.name;
}

/** `e` is exactly `G.p` (dot form only — the property came from a safe
 *  identifier, so `prop(obj, text)` in `src/emit/lower.ts` always renders it
 *  uncomputed; condition 1 refuses anything that would not). */
export function isTargetRead(e: Expr, global: Expr, name: string): boolean {
  return e.k === "member" && !e.computed && e.prop.k === "lit" && e.prop.text === name && e.obj.k === "ident" && sameIdent(e.obj, global);
}

/** The `Expr` fields directly on `s` — never descending into a nested
 *  `Stmt[]` (an `if`'s `then`/`else`, a loop's `body`, …): that is a
 *  different site as far as §4 condition 4 ("occurs exactly once in *that
 *  statement*") and the `guard-in-other-list` refusal are concerned. */
function topLevelExprFields(s: Stmt): readonly Expr[] {
  switch (s.k) {
    case "expr":
      return [s.expr];
    case "init":
      return [s.value];
    case "if":
      return [s.test];
    case "while":
      return s.test !== undefined ? [s.test] : [];
    case "do-while":
      return [s.test];
    case "for":
      return [s.init, s.test, s.update].filter((x): x is Expr => x !== null);
    case "return":
      return s.arg !== null ? [s.arg] : [];
    case "throw":
      return [s.arg];
    case "switch":
      return [s.disc];
    default:
      return []; // decl, break, continue, labeled, try, func, iife, directive, comment, raw
  }
}

/** Occurrences of the target read within `exprs`, recursing through nested
 *  expressions but never into a nested `func` body (a separate frame). */
function countMatchingReads(exprs: readonly Expr[], global: Expr, name: string): number {
  let count = 0;
  const visit = (e: Expr): void => {
    if (isTargetRead(e, global, name)) count++;
    switch (e.k) {
      case "member":
        visit(e.obj);
        if (e.computed) visit(e.prop);
        return;
      case "call":
      case "new":
        visit(e.callee);
        e.args.forEach(visit);
        return;
      case "bin":
      case "logical":
        visit(e.left);
        visit(e.right);
        return;
      case "unary":
        visit(e.arg);
        return;
      case "assign":
        visit(e.target);
        visit(e.value);
        return;
      case "cond":
        visit(e.test);
        visit(e.then);
        visit(e.else);
        return;
      case "array":
        e.elements.forEach(visit);
        return;
      case "object":
        e.props.forEach((p) => visit("k" in p ? p.arg : p.value));
        return;
      case "seq":
        e.exprs.forEach(visit);
        return;
      default:
        return; // ident, lit, this, argumentsObject, func (separate frame)
    }
  };
  exprs.forEach(visit);
  return count;
}

/** Occurrences of the target read anywhere in `s`, including inside a
 *  nested `Stmt[]` (an `if`'s `then`, a loop's `body`, …) — used only to
 *  distinguish "genuinely absent" and "migrated into a nested list". */
function countMatchingReadsAnywhere(s: Stmt, global: Expr, name: string): number {
  let count = 0;
  walk([s], { expr: (e) => { if (isTargetRead(e, global, name)) count++; } });
  return count;
}

/** Does `s` write `global` itself, or the property `name` on `global`,
 *  anywhere (top level or nested — a write hidden in a nested block is a
 *  hazard `condInputs`-style scans in this codebase would also refuse)? */
function statementClobbers(s: Stmt, global: Expr, name: string): boolean {
  let hit = false;
  walk([s], {
    expr: (e) => {
      if (e.k !== "assign") return;
      if (e.target.k === "ident" && sameIdent(e.target, global)) hit = true;
      if (e.target.k === "member" && !e.target.computed && e.target.prop.k === "lit" && e.target.prop.text === name && e.target.obj.k === "ident" && sameIdent(e.target.obj, global)) hit = true;
    },
  });
  return hit;
}

function isGuardShapeFor(s: Stmt, name: string): boolean {
  const shape = recognizeGuard(s);
  return shape !== null && shape.name === name;
}

// ---------------------------------------------------------------------------
// §4's whole matcher for one candidate guard `L[i]`.
// ---------------------------------------------------------------------------

/** Recomputes the full §4 verdict for the guard already recognised at
 *  `list[i]` (name `p`, object `global`) from `list`/`fnBody` alone — the
 *  same function `match` uses internally and `check.ts` re-derives from
 *  `before`, and what direct unit tests exercise for the exact refuse
 *  reason. */
export function classifySite(list: readonly Stmt[], fnBody: readonly Stmt[], i: number, name: string, global: Expr): ClassifyResult {
  if (!isSafeIdentifier(name)) return { ok: false, reason: "unsafe-identifier" };
  // §4 condition 7: the local proof is decided per read site, below; the
  // whole-function proof (and its conditions 5/6) is the fallback.
  const wholeFunction = (): RefuseReason | null => {
    if (!isProvenGlobal(fnBody, global)) return "unproven-global";
    if (hasLoopReentryClobber(fnBody, list, global)) return "loop-reentry-clobber";
    if (hasPreGuardClobber(fnBody, list, i, global)) return "pre-guard-clobber";
    return null;
  };
  const useLocal = (j: number): boolean => isLocallyProvenGlobal(list, i, j, global);
  const firstUse = firstReadIndex(list, i, global, name);
  if (firstUse === null || !useLocal(firstUse)) {
    const why = wholeFunction();
    if (why !== null) return { ok: false, reason: why };
  }
  if (isShadowed(name, fnBody)) return { ok: false, reason: "shadowed" };

  for (let k = i + 1; k < list.length; k++) {
    const s = list[k]!;
    const topCount = countMatchingReads(topLevelExprFields(s), global, name);
    if (topCount > 1) return { ok: false, reason: "read-twice" };
    if (topCount === 1) return { ok: true, site: { guardIndex: i, useIndex: k, name, global } };
    if (countMatchingReadsAnywhere(s, global, name) > 0) return { ok: false, reason: "guard-in-other-list" };
    if (isGuardShapeFor(s, name) || statementClobbers(s, global, name)) return { ok: false, reason: "clobbered-between" };
  }
  return { ok: false, reason: "no-read-after-guard" };
}

/** The index of the first statement after `list[i]` holding a top-level
 *  read of `global.name` (the candidate `useIndex`), or `null`. */
export function firstReadIndex(list: readonly Stmt[], i: number, global: Expr, name: string): number | null {
  for (let k = i + 1; k < list.length; k++) if (countMatchingReads(topLevelExprFields(list[k]!), global, name) > 0) return k;
  return null;
}

export function match(list: readonly Stmt[], ctx: PassContext): GlobalAccessMatch | null {
  const fnBody = ctx.fnBody ?? list;
  for (let i = 0; i < list.length; i++) {
    const shape = recognizeGuard(list[i]!);
    if (shape === null) continue;
    const result = classifySite(list, fnBody, i, shape.name, shape.global);
    if (result.ok) {
      return { root: list, nodes: [list], data: result.site, at: { functionIndex: ctx.functionIndex, offset: i } };
    }
  }
  return null;
}
