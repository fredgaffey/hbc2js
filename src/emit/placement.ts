// docs/specs/05-emitter.md §6 "Function nesting" — where an *orphan* goes.
import type { Stmt } from "./ast.ts";
//
// `_fn<n>` is normally emitted inside the function that owns its
// `closureEnvOf` environment, so JS closure capture does the work. An orphan is
// a function for which that environment is unknown:
//
//   * no `Create*Closure` site ever resolved its environment operand
//     (`closureEnvOf` has no entry), or
//   * it is created at two sites with *different* environments, so the env
//     graph refuses to pick one (`W_AMBIGUOUS_CLOSURE_ENV`, `closureEnvOf` is
//     `null`).
//
// Orphans used to go to MODULE level unconditionally — outside the global
// function, where nothing any function body declares is in scope. Their bodies
// still read `_e<env>_<slot>` names declared inside some function's body, and
// every one of those reads is unbound: 481 of them on react-navigation-example
// (docs/BUGS.md 2026-09-04, the `_fn13838`…`_fn13843` / `_e652_0` family).
//
// The rule here is placement by *fewest unbound names*. For each orphan the
// candidate hosts are module level and every ancestor-or-self of a function
// that declares an environment the orphan's subtree uses; the cost of a
// candidate is the number of names that candidate leaves unbound:
//
//   * an `_e<env>_<slot>` read whose declaring function is neither the host nor
//     one of its ancestors (nor inside the orphan's own subtree, which travels
//     with it), plus
//   * a `_fn<n>` reference at a `Create*Closure` site that is neither the host
//     nor nested inside it — module level costs nothing here, which is exactly
//     why a function created at two unrelated sites stays there.
//
// Module level is always a candidate, so a host is chosen only when it is
// *strictly* better: this can never turn a bound name into an unbound one.
// Deeper wins ties, since a deeper host sees strictly more declarations.

export interface OrphanPlacementInput {
  readonly functionCount: number;
  readonly globalIndex: number;
  /** As built by `emitModule`: lexical parent, `null` for module level. */
  readonly parentOf: ReadonlyMap<number, number | null>;
  /** fn -> the environments its body loads from or stores to. */
  readonly envsUsedIn: ReadonlyMap<number, ReadonlySet<number>>;
  /** env -> the function whose body declares that env's slot names. */
  readonly declaringFunction: ReadonlyMap<number, number>;
  /** fn -> the functions whose bodies hold a `Create*Closure` for it. */
  readonly creationSitesOf: ReadonlyMap<number, ReadonlySet<number>>;
}

export interface OrphanPlacement {
  readonly orphan: number;
  readonly host: number;
  /** Names left unbound by module level, and by the chosen host. */
  readonly unboundAtModule: number;
  readonly unboundAtHost: number;
}

/**
 * Chooses a host function for every orphan that is strictly better off inside
 * one. Pure: the caller applies the result to its `parentOf` map (and keeps its
 * own cycle guard — two orphans could otherwise be hosted into each other).
 */
export function resolveOrphanHosts(input: OrphanPlacementInput): OrphanPlacement[] {
  const { functionCount, globalIndex, parentOf, envsUsedIn, declaringFunction, creationSitesOf } = input;

  const childrenOf = new Map<number, number[]>();
  for (let i = 0; i < functionCount; i++) {
    if (i === globalIndex) continue;
    const parent = parentOf.get(i) ?? null;
    if (parent === null) continue;
    const list = childrenOf.get(parent);
    if (list === undefined) childrenOf.set(parent, [i]);
    else list.push(i);
  }

  /** Ancestor-or-self chain, outermost last; cycle-safe. */
  const chainOf = (f: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    let cur: number | null = f;
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      out.push(cur);
      cur = parentOf.get(cur) ?? null;
    }
    return out;
  };

  const subtreeOf = (root: number): Set<number> => {
    const out = new Set<number>();
    const stack = [root];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (out.has(n)) continue;
      out.add(n);
      for (const c of childrenOf.get(n) ?? []) stack.push(c);
    }
    return out;
  };

  const placements: OrphanPlacement[] = [];
  for (let orphan = 0; orphan < functionCount; orphan++) {
    if (orphan === globalIndex) continue;
    if ((parentOf.get(orphan) ?? null) !== null) continue;

    const tree = subtreeOf(orphan);
    // Env-slot declarations the subtree needs, and the `_fn` references to it.
    const needs: number[] = [];
    for (const f of tree) {
      for (const env of envsUsedIn.get(f) ?? []) {
        const declarer = declaringFunction.get(env);
        if (declarer === undefined || tree.has(declarer)) continue;
        needs.push(declarer);
      }
    }
    const sites: number[] = [];
    for (const f of tree) {
      for (const site of creationSitesOf.get(f) ?? []) if (!tree.has(site)) sites.push(site);
    }
    if (needs.length === 0) continue; // module level already binds every name

    const candidates: number[] = [];
    const seen = new Set<number>();
    for (const declarer of needs) {
      for (const cand of chainOf(declarer)) {
        if (tree.has(cand) || seen.has(cand)) continue;
        seen.add(cand);
        candidates.push(cand);
      }
    }

    const costAt = (host: number): number => {
      const visible = new Set(chainOf(host));
      let cost = 0;
      for (const declarer of needs) if (!visible.has(declarer)) cost++;
      for (const site of sites) if (site !== host && !chainOf(site).includes(host)) cost++;
      return cost;
    };

    const unboundAtModule = needs.length; // module level sees no function's body
    let best: number | null = null;
    let bestCost = unboundAtModule;
    let bestDepth = -1;
    for (const cand of candidates) {
      const cost = costAt(cand);
      const depth = chainOf(cand).length;
      if (cost < bestCost || (cost === bestCost && best !== null && depth > bestDepth)) {
        best = cand;
        bestCost = cost;
        bestDepth = depth;
      }
    }
    if (best === null) continue;
    placements.push({ orphan, host: best, unboundAtModule, unboundAtHost: bestCost });
  }
  return placements;
}

/**
 * Where a pulled-in orphan declaration goes inside the factory body.
 *
 * Hermes allocates a scope's environment slots in TEXTUAL declaration order:
 * hoisting moves a function declaration's *closure creation* to the top of the
 * scope, but not its slot. Probed on hermesc v98 with two captured function
 * declarations either side of a `let a0, a1, a2;` — the same
 * `CreateClosure`/`StoreToEnvironment` sequence either way, but the `let`
 * bindings took slots 0..2 only when the function declarations came after
 * them (docs/BUGS.md 2026-09-05, `diff:LoadFromEnvironment(imm)`).
 *
 * So prepending these declarations to the factory body — which is what this
 * used to do — pushed every one of the factory's OWN `_e<env>_<slot>`
 * bindings up by the number of orphans pulled in, and every getter/closure
 * reading them recompiled with a shifted slot immediate. On
 * react-navigation-example module 681 / fn#683 (a lazy re-export barrel with
 * eleven getters) that was the uniform +2 the bug row describes: two orphans,
 * `_fn13951` and `_fn13952`.
 *
 * The declarations therefore go exactly where `emitFunction` puts a function's
 * own nested children: after the whole prologue (the `"use strict"` directive,
 * the register/env-slot `let`s, `__this`/`__args`, the dispatch and generator
 * state variables), i.e. at the first `func` statement, or after the leading
 * run of declaration-shaped statements when the body has no children of its
 * own. They stay hoisted function declarations, so every reference in the
 * factory — including ones textually above them — still resolves.
 */
export function withExtraDeclarations(body: readonly Stmt[], extras: readonly Extract<Stmt, { k: "func" }>[]): Stmt[] {
  let at = body.findIndex((s) => s.k === "func");
  if (at < 0) {
    at = 0;
    while (at < body.length && (body[at]!.k === "directive" || body[at]!.k === "comment" || body[at]!.k === "decl" || body[at]!.k === "init")) at++;
  }
  return [...body.slice(0, at), ...extras, ...body.slice(at)];
}
