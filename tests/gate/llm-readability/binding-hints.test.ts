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

// readability-v9 (docs/READABILITY.md "Skill v9"): a parameter copy printed as
// a declaration-with-initialiser (`let r3 = a1;`) was skipped as a `let` line,
// so the hint had no def and the model never saw that the binding IS the
// parameter (react-navigation fn 12947: `listener` named `item`).
test("readability-v9: a `let rN = aK` initialiser is the def, and parameter copies are listed in params", () => {
  const src = [
    "function _fn5(a1, a2) {",
    "  let r0, r4;",
    "  let r3 = a1;",
    "  r4 = r3.length;",
    "  r0 = r4 + 1;",
    "  r4 = a2;",
    "  r0 = arguments[3];",
    "  set.add(r3);",
    "  return r4;",
    "}",
  ].join("\n");
  const [h3, h4, h0] = bindingHints(src, 5, [{ fn: 5, reg: 3 }, { fn: 5, reg: 4 }, { fn: 5, reg: 0 }]);
  assert.equal(h3!.def, "L3: let r3 = a1;");
  assert.deepEqual(h3!.params, ["a1"]);
  assert.deepEqual(h4!.params, ["a2 (L6)"], "a later parameter copy into a reused register is listed with its line");
  assert.deepEqual(h0!.params, ["arguments[3] (L7)"]);
  assert.deepEqual(bindingHints(SRC, 7, [{ fn: 7, reg: 1 }])[0]!.params, []);
});
