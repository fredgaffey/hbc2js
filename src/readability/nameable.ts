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
}

export function nameableIndex(analysis: ModuleAnalysis, opts: { readonly strictEnv?: boolean } = {}): NameableIndex {
  const frames = rawFrames(analysis, opts);
  const hook: AstPassHook = astPassHook(analysis);
  const memo = new Map<number, readonly number[]>();
  return {
    of(fn: number): readonly number[] {
      const hit = memo.get(fn);
      if (hit !== undefined) return hit;
      const frame = frames.get(fn);
      let out: number[] = [];
      if (frame !== undefined && frame.node.k === "func") {
        const regs: number[] = [];
        for (const n of registerUses(frame.node.body).keys()) if (isRegisterName(n)) regs.push(Number(n.slice(1)));
        regs.sort((a, b) => a - b);
        // The UI's own reg -> rendered-ident join (var-naming's heuristic
        // choice, else `rN`), then the ident must survive as a declared
        // binding of the frame after the real stage-B pipeline ran with NO
        // overlay: inlined temporaries and the implicit receiver vanish there.
        const rendered = renderedRegisterNames(fn, frame.node.body, new Map(), { varNaming: true });
        const res = hook(frame.node, frame.cfg);
        // Declarations are placed after the pass pipeline, so a binding shows up
        // here as an assigned/read identifier or as an explicit declaration.
        const bound = res.fn.k === "func" ? new Set([...declaredNames([res.fn]), ...freeNames([res.fn])]) : new Set<string>();
        // `renderedRegisterNames` is best effort for the heuristic half (it
        // classifies the raw body), so the register's own `rN` also counts.
        out = regs.filter((r) => bound.has(`r${String(r)}`) || bound.has(rendered.get(r) ?? `r${String(r)}`));
      }
      memo.set(fn, out);
      return out;
    },
  };
}
