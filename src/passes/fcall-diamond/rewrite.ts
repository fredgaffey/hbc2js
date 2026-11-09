// fcall-diamond writer — docs/specs/passes/04-call-shape.md section 10 (R3g):
// annotation only. The `if` keeps both arms (stage A must stay CFG-isomorphic,
// docs/specs/07-pass-ladder.md section 2.1) and gets `keepOnly` = the arm that
// does not hold the fast path; the emitter prints that arm alone.
import type { Stmt } from "../../structure/ir.ts";
import type { PassContext } from "../types.ts";
import type { FcallMatch } from "./match.ts";

export function rewrite(m: FcallMatch, _ctx: PassContext): Stmt {
  const { node, drop } = m.data;
  return { ...node, keepOnly: drop === "then" ? "else" : "then" };
}
