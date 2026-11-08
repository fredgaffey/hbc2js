// src/deps/closure-owner.ts — which module owns each function
// (docs/PACKAGE-SIGNATURES.md §7, docs/DEPS.md "Closure ownership").
//
// A function belongs to the module whose factory creates it, directly or
// through any chain of closures (CreateClosure / CreateGenerator /
// CreateAsyncClosure — every operand with role "function"). The walk stops
// at another module's factory: a factory is always its own module's root.
//
// Two policies for a function reachable from more than one factory:
// - "first": the first factory in `roots` order wins. This is what
//   `attachModulePaths` has always written to `SigFunction.moduleId`; it is
//   stored in signature files and must not change.
// - "ambiguous": the function is owned by nobody and listed in
//   `ambiguous`. The target-side inventory uses this (a function shared
//   across modules is not evidence for either).

export type OwnershipPolicy = "first" | "ambiguous";

export interface ClosureOwnership {
  /** Function index -> owning root (factory function index). */
  readonly owner: ReadonlyMap<number, number>;
  /** Functions reached from two or more roots ("ambiguous" policy only). */
  readonly ambiguous: ReadonlySet<number>;
}

/** Ownership of every function reachable from `roots` through `children`
 *  (a function's directly created closures). A root is never entered from
 *  another root's walk, nor is any index in `stops` (other factories that
 *  are not roots themselves, e.g. a module without a numeric id). */
export function closureOwnership(roots: readonly number[], children: (index: number) => readonly number[], policy: OwnershipPolicy, stops: ReadonlySet<number> = new Set()): ClosureOwnership {
  const rootSet = new Set([...roots, ...stops]);
  const owner = new Map<number, number>();
  const ambiguous = new Set<number>();
  const kids = new Map<number, readonly number[]>();
  const childrenOf = (i: number): readonly number[] => {
    let k = kids.get(i);
    if (k === undefined) kids.set(i, (k = children(i)));
    return k;
  };
  for (const root of roots) {
    if (owner.has(root) && owner.get(root) !== root) continue;
    const seen = new Set<number>([root]);
    const stack = [root];
    while (stack.length > 0) {
      const idx = stack.pop()!;
      const prev = owner.get(idx);
      if (prev === undefined && !ambiguous.has(idx)) owner.set(idx, root);
      else if (prev !== root && policy === "ambiguous") {
        owner.delete(idx);
        ambiguous.add(idx);
      }
      for (const c of childrenOf(idx)) {
        if (seen.has(c) || rootSet.has(c)) continue;
        seen.add(c);
        stack.push(c);
      }
    }
  }
  return { owner, ambiguous };
}

/** Directly created closures of function `index` (every "function"-role
 *  operand), in first-appearance order, without itself or `global`. */
export function directClosures<M>(mod: M, decode: (mod: M, index: number) => { readonly instructions: readonly { readonly operands: readonly { readonly role: string; readonly value: number }[] }[] }, index: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>([index, 0]);
  for (const insn of decode(mod, index).instructions) {
    for (const op of insn.operands) {
      if (op.role === "function" && !seen.has(op.value)) {
        seen.add(op.value);
        out.push(op.value);
      }
    }
  }
  return out;
}
