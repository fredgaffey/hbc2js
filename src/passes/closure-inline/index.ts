import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { ClosureInlineSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * Stage B (docs/specs/passes/32-closure-inline.md, catalogue row R17): a
 * hoisted `function _fnN` declaration read exactly once, outside every loop,
 * becomes a function expression at that read, so the closure is created where
 * Hermes created it (after a global read such as `Object` in
 * `Object.defineProperty(o, k, {get: function () {...}})`), not at entry.
 *
 * `after`: every structure rung that may still look for the declaration
 * (`class-recover`, `super-call`, `ctor-this`, `private-fields`, `inline-new`).
 * and `fn-naming`, so the moved function keeps its recovered name (`get`).
 * `before`: `reg-split`/`var-naming`, which must see the register copies
 * (`rN = function get() {...}`) with their bytecode identity.
 */
export const closureInline: Pass<readonly Stmt[], ClosureInlineSite> = {
  name: "closure-inline",
  stage: "B",
  targets: ["230-closure-inline-getter"],
  catalogue: ["R17"],
  after: ["expr-rebuild", "object-literal", "class-recover", "super-call", "ctor-this", "inline-new", "private-fields", "fn-naming"],
  before: ["reg-split", "var-naming"],
  match,
  rewrite,
  check,
};
