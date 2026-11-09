// readability-coverage (skill v6): each requested binding is sent with its def
// line, a few use lines (1-based line numbers of the printed source) and the
// callees it flows into, so the model has evidence for temporaries it used to
// skip. Pure string work; no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bindingHints } from "../../../src/readability/binding-hints.ts";

const SRC = [
  "// header",
  "function _fn7(a1) {",
  "  let r0, r1, r2_2;",
  "  r0 = a1;",
  "  r1 = r0.path;",
  "  r2_2 = navigate(r1, 3);",
  "  function _fn9(a1) {",
  "    let r1;",
  "    r1 = 5;",
  "    return r1;",
  "  }",
  "  return r2_2;",
  "}",
].join("\n");

test("binding-hints: def line, uses and flows-into callee, with source line numbers", () => {
  const hints = bindingHints(SRC, 7, [{ fn: 7, reg: 1 }]);
  assert.equal(hints.length, 1);
  assert.equal(hints[0]!.id, "{7,1}");
  assert.equal(hints[0]!.ident, "r1");
  assert.equal(hints[0]!.def, "L5: r1 = r0.path;");
  assert.deepEqual(hints[0]!.flowsInto, ["navigate"]);
  assert.deepEqual(hints[0]!.uses, ["L6: r2_2 = navigate(r1, 3);"]);
});

test("binding-hints: lines of a nested closure (other registers with the same rN) are ignored", () => {
  const h = bindingHints(SRC, 7, [{ fn: 7, reg: 1 }])[0]!;
  assert.ok(!h.uses.some((u) => u.includes("= 5")) && !h.def.includes("= 5"));
});

test("binding-hints: a live range targets rN_W and a binding with no use gets an empty list", () => {
  const h = bindingHints(SRC, 7, [{ fn: 7, reg: 2, web: 2 }, { fn: 7, reg: 9 }]);
  assert.equal(h[0]!.ident, "r2_2");
  assert.equal(h[0]!.def, "L6: r2_2 = navigate(r1, 3);");
  assert.deepEqual(h[0]!.uses, ["L12: return r2_2;"]);
  assert.equal(h[1]!.def, "");
  assert.deepEqual(h[1]!.uses, []);
});
