import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { ValueJoinSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * The labelled block an `||`/`&&`/`?:` value join decompiles to ->
 * the expression (docs/specs/passes/32-value-join.md). Round-trip motivated:
 * hermesc keeps an expression's own join block (it carries the phi) but
 * threads an if-statement's empty join away, so a nested join recompiled
 * as statements loses a jump-to-jump block and shifts every later label.
 *
 * After the stage-B rungs that own narrower labelled-block idioms
 * (`optional-chain`'s `??`, `default-params`, `destructure`), before
 * `var-naming` (its `rX` must still be a bare register name).
 */
export const valueJoin: Pass<readonly Stmt[], ValueJoinSite> = {
  name: "value-join",
  stage: "B",
  targets: ["280-value-join-logical"],
  catalogue: [1],
  after: ["expr-rebuild", "global-access", "call-shape", "default-params", "destructure", "optional-chain", "array-literal"],
  before: ["var-naming"],
  match,
  rewrite,
  check,
};
