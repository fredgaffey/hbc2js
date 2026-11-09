import type { Stmt } from "../../structure/ir.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { FcallSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** Catalogue row R3, rule R3g (docs/specs/passes/04-call-shape.md section 8):
 *  collapses hermesc's v98+ `JmpBuiltinIs functionPrototypeCall` diamond for
 *  `F.call(T, a...)` to its generic arm, once both arms are proven to be the
 *  same call. `call-shape` R3b then prints the generic arm as `F.call(...)`. */
export const fcallDiamond: Pass<Stmt, FcallSite> = {
  name: "fcall-diamond",
  stage: "A",
  targets: ["170-function-call-diamond"],
  catalogue: ["R3"],
  after: ["finally-dedup"],
  before: ["loop-cond", "if-chain", "label-clean"],
  versions: (v) => v >= 97,
  match,
  rewrite,
  check,
};
