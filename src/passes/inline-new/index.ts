import type { Stmt } from "../ast.ts";
import type { Match, Pass, PassContext } from "../types.ts";
import { check } from "./check.ts";
import { foldAll } from "./match.ts";
import type { InlineNewGroup } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * Stage B, catalogue row R16 (docs/specs/passes/24-class-recover.md section
 * 9): rebuilds a construction hermesc's inliner spliced into a frame --
 * the receiver plus a copy of the recovered class's constructor body -- as
 * `X = new C(args)`, when a lock-step comparison against that constructor
 * proves the region is exactly its body. Runs after `class-recover`,
 * `super-call` and `ctor-this` (the comparison template is the constructor
 * they leave, addressing `this`) and before `private-fields`, whose R-PF1
 * refuses a private name while an inlined construction still installs it.
 */
function match(before: readonly Stmt[], ctx: PassContext): Match<readonly Stmt[], InlineNewGroup> | null {
  if (ctx.fnBody === undefined || before !== ctx.fnBody) return null;
  const { folded } = foldAll(before, (r) => ctx.refuse?.(before, `${r.code}: ${r.reason}`));
  if (folded === 0) return null;
  return { root: before, nodes: [before], data: { folded }, at: { functionIndex: ctx.functionIndex, offset: 0 } };
}

export const inlineNew: Pass<readonly Stmt[], InlineNewGroup> = {
  name: "inline-new",
  stage: "B",
  targets: ["90-inlined-new"],
  catalogue: ["R16"],
  after: ["class-recover", "super-call", "ctor-this"],
  before: ["private-fields", "fn-naming", "reg-split", "var-naming"],
  versions: (hbcVersion, layoutClass) => hbcVersion >= 98 && layoutClass === "E",
  match,
  rewrite,
  check,
};
