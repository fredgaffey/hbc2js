// src/readability/nameable.ts -- spec 28 section 7 coverage DENOMINATOR.
// A numbered register is "nameable" when the rendered source binds it to a
// local identifier: after the real stage-B pipeline, the register's identifier
// is a declared local, a parameter or a destructured/catch binding of the
// emitted function. Registers that the passes inlined away (reused
// temporaries, the implicit receiver) never appear as a binding, so a name for
// them could not be shown anywhere.
//
// Method: render the frame through the real stage-B pipeline with no overlay
// and keep the registers whose rendered identifier (`renderedRegisterNames`,
// the UI's reg -> ident join) is a declared binding (`declaredNames`) of the
// final AST. NOT done by overlaying sentinel names: an overlay-named register
// is protected from inlining, so that render shows bindings the real,
// unnamed source never has.
import type { ModuleAnalysis } from "../cfg/types.ts";
import type { Stmt } from "../emit/ast.ts";
import type { RegisterId } from "../name-overlay/id.ts";
import { parseWebIdent, regId } from "../name-overlay/id.ts";
import { classifyAll } from "../passes/var-naming/match.ts";
import { renderedRegisterNames } from "../name-overlay/render.ts";
import { rawFrames } from "../name-overlay/frames.ts";
import { astPassHook } from "../passes/index.ts";
import type { AstPassHook } from "../passes/index.ts";
import { freeNames, isRegisterName, registerUses } from "../passes/ast.ts";
import { declaredNames } from "../passes/var-naming/match.ts";

export interface NameableIndex {
  /** Registers of `fn` that the rendered source binds to a local identifier,
   *  ascending. Empty for an unknown fn. */
  readonly of: (fn: number) => readonly number[];
  /** The nameable BINDINGS of `fn` (docs/RENAME.md): an unsplit register as
   *  its whole-register id `{fn,reg}`, a register `reg-split` split as one
   *  `{fn,reg,web}` per web the rendered source binds. Ordered by (reg, web). */
  readonly bindings: (fn: number) => readonly RegisterId[];
}

export function nameableIndex(analysis: ModuleAnalysis, opts: { readonly strictEnv?: boolean } = {}): NameableIndex {
  const frames = rawFrames(analysis, opts);
  const hook: AstPassHook = astPassHook(analysis);
  const memo = new Map<number, readonly number[]>();
  const webMemo = new Map<number, readonly RegisterId[]>();
  const compute = (fn: number): void => {
      const frame = frames.get(fn);
      let out: number[] = [];
      const ids: RegisterId[] = [];
      if (frame !== undefined && frame.node.k === "func") {
        const regs: number[] = [];
        for (const n of registerUses(frame.node.body).keys()) if (isRegisterName(n)) regs.push(Number(n.slice(1)));
        regs.sort((a, b) => a - b);
        // The UI's own reg -> rendered-ident join (var-naming's heuristic
        // choice, else `rN`), then the ident must survive as a declared
        // binding of the frame after the real stage-B pipeline ran with NO
        // overlay: inlined temporaries and the implicit receiver vanish there.
        const rendered = renderedRegisterNames(fn, frame.node.body, new Map(), { varNaming: true });
        // The interposition is the identity: it only observes the post-
        // reg-split body (the webs), so `res` is the ordinary render.
        let split: readonly Stmt[] = [];
        const res = hook(frame.node, frame.cfg, { beforeVarNaming: (b) => (split = b) });
        // Declarations are placed after the pass pipeline, so a binding shows up
        // here as an assigned/read identifier or as an explicit declaration.
        const bound = res.fn.k === "func" ? new Set([...declaredNames([res.fn]), ...freeNames([res.fn])]) : new Set<string>();
        // `renderedRegisterNames` is best effort for the heuristic half (it
        // classifies the raw body), so the register's own `rN` also counts.
        out = regs.filter((r) => bound.has(`r${String(r)}`) || bound.has(rendered.get(r) ?? `r${String(r)}`));
        // Live ranges: the post-split idents, each joined to var-naming's
        // heuristic name for it (classified on the same post-split body
        // var-naming itself sees), must survive as a binding.
        const heuristic = new Map<string, string>();
        for (const c of classifyAll(split)) if (c.result.ok) heuristic.set(c.name, c.result.to);
        const splitIdents = [...registerUses(split).keys()].filter(isRegisterName);
        const webs = new Map<number, number[]>();
        for (const n of splitIdents) {
          const w = parseWebIdent(n);
          if (w === null) continue;
          const list = webs.get(w.reg) ?? [];
          list.push(w.web);
          webs.set(w.reg, list);
        }
        const isBound = (ident: string): boolean => bound.has(ident) || bound.has(heuristic.get(ident) ?? ident);
        const present = new Set(splitIdents);
        for (const r of regs) {
          const ws = webs.get(r);
          if (ws === undefined) {
            if (out.includes(r)) ids.push(regId(fn, r));
            continue;
          }
          if (present.has(`r${String(r)}`) && isBound(`r${String(r)}`)) ids.push(regId(fn, r, 1));
          for (const w of ws.sort((a, b) => a - b)) if (isBound(`r${String(r)}_${String(w)}`)) ids.push(regId(fn, r, w));
        }
        // A split register counts for `of` when any of its webs is bound.
        const viaWeb = new Set(ids.map((i) => i.reg));
        out = regs.filter((r) => out.includes(r) || viaWeb.has(r));
      }
      memo.set(fn, out);
      webMemo.set(fn, ids);
  };
  return {
    of(fn: number): readonly number[] {
      if (!memo.has(fn)) compute(fn);
      return memo.get(fn)!;
    },
    bindings(fn: number): readonly RegisterId[] {
      if (!webMemo.has(fn)) compute(fn);
      return webMemo.get(fn)!;
    },
  };
}
