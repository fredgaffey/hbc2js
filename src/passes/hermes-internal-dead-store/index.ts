import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import type { Analysis } from "../globalthis-dead-store/analysis.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * Stage B, expression-only deleting rung (docs/LOWERING-CATALOGUE.md R17,
 * docs/specs/passes/14-template-literal.md section 9): deletes the dead
 * `rN = __hbc_HermesInternal.concat` callee spill (and its namespace pair)
 * that `template-literal` leaves behind once every call it fed has become a
 * template literal. `after: [..., "template-literal"]` because the deadness
 * only exists after that rewrite; `before` the renaming rungs for the same
 * reason as `globalthis-dead-store` (a register a deletion exposes as dead
 * must never be named first). Registered immediately after
 * `template-literal`.
 */
export const hermesInternalDeadStore: Pass<readonly Stmt[], Analysis> = {
  name: "hermes-internal-dead-store",
  stage: "B",
  targets: ["290-template-concat-dead-spill"],
  catalogue: ["R17"],
  after: ["expr-rebuild", "global-access", "template-literal"],
  before: ["fn-naming", "reg-split", "var-naming"],
  match,
  rewrite,
  check,
};
