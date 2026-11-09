import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { ArgInlineSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * Registered straight after `jsx-recover` (it and `private-fields`/
 * `class-recover` read a props object or a `defineProperty` descriptor out
 * of its own `rN = {...}` statement, so they must see it exactly as the
 * emitter and `object-literal` left it) and before every renaming rung.
 */
export const objectLiteralArg: Pass<readonly Stmt[], ArgInlineSite> = {
  name: "object-literal-arg",
  stage: "B",
  targets: ["140-define-property-getter"],
  catalogue: [28],
  after: ["object-literal", "array-literal", "private-fields", "jsx-recover"],
  before: ["fn-naming", "reg-split", "var-naming"],
  match,
  rewrite,
  check,
};
