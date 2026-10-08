import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { ArrayLiteralSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * `NewArray`/`NewFastArray` + a contiguous run of own-index defines back
 * into one array literal (docs/specs/passes/31-array-literal.md,
 * docs/LOWERING-CATALOGUE.md row 31) — `r3 = new Array(2); r3[0] = a; r3[1]
 * = b;` becomes `r3 = [a, b]`.
 *
 * `after: ["expr-rebuild", "global-access", "call-shape"]`, same reasons as
 * `object-literal` (docs/specs/passes/20-object-literal.md's own doc
 * comment): a store's value is only an *expression* once `expr-rebuild` has
 * inlined the register that held it. `before: ["jsx-recover", "var-naming"]`
 * — the register this rung deletes must never have been named, and a
 * folded array literal is a plausible `jsx-recover` children shape.
 * Registered immediately after `object-literal` (same ordering rationale,
 * same stage-B structure-recovery block).
 */
export const arrayLiteral: Pass<readonly Stmt[], ArrayLiteralSite> = {
  name: "array-literal",
  stage: "B",
  targets: ["84-array-literal"],
  catalogue: [31],
  after: ["expr-rebuild", "global-access", "call-shape"],
  before: ["jsx-recover", "var-naming"],
  match,
  rewrite,
  check,
};
