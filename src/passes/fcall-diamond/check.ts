// fcall-diamond checker — docs/specs/passes/04-call-shape.md section 10 (R3g).
// Re-derives the whole proof from `before` (never trusts match data) and
// asserts the rewrite is the annotation alone, naming the non-fast arm.
import type { Stmt } from "../../structure/ir.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { analyse } from "./match.ts";

export function check(before: Stmt, after: Stmt, ctx: PassContext): CheckResult {
  if (before.k !== "if" || after.k !== "if") return { ok: false, reason: "not an if" };
  if (before.keepOnly !== undefined) return { ok: false, reason: "already-annotated" };
  const site = analyse(before, ctx);
  if (site === null || typeof site === "string") return { ok: false, reason: `proof does not hold: ${site ?? "not the idiom"}` };
  const keep = site.drop === "then" ? "else" : "then";
  if (after.keepOnly !== keep) return { ok: false, reason: "annotation names the wrong arm" };
  if (after.then !== before.then || after.else !== before.else || after.cfgBlock !== before.cfgBlock || after.elseIf !== before.elseIf) return { ok: false, reason: "tree changed" };
  return { ok: true };
}
