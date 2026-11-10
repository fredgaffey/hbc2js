import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { MethodReadSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * Spec 05 section 7.4 (docs/BUGS.md 2026-11-09 "method read moved past an
 * intervening getter"): re-fuses a `methodRead` call the emitter left unfused
 * for evaluation order. Registered after every rung that folds the work in
 * between into literals (`object-literal`, `array-literal`) and after
 * `private-fields` (which reads a symbol-slot load in statement form), and
 * before `jsx-recover` and `object-literal-arg`, which read the fused
 * `o.m(...)` call shape.
 */
export const methodRead: Pass<readonly Stmt[], MethodReadSite> = {
  name: "method-read",
  stage: "B",
  targets: ["250-method-read-before-getter-arg"],
  catalogue: ["R3"],
  after: ["object-literal", "array-literal", "private-fields"],
  before: ["jsx-recover", "object-literal-arg", "fn-naming", "reg-split", "var-naming"],
  match,
  rewrite,
  check,
};
