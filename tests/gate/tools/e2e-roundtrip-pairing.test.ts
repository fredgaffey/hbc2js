// roundtrip-pair-identity: the round-trip harness pairs original and
// recompiled closures by structural identity (alignLeftovers), not by order.
// A recompile with one closure more or fewer must not shift every later
// sibling's pair.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Decoder, alignLeftovers, childrenOf } from "../../../tools/e2e/roundtrip-corpus.ts";
import { compileWithHermesc, findHermesc } from "../../../src/harness/roundtrip.ts";
import { parseHbc } from "../../../src/parse/module.ts";

const BASE = [
  "var fs = [",
  "  function (a) { return a + 1; },",
  "  function (a, b, c) { return [function (z) { return z * a; }, function () { return b + c; }]; },",
  "  function () { return 7; },",
  "  function (a, b) { return a - b; },",
  "];",
  "globalThis.fs = fs;",
].join("\n");
// Same module with one extra, structurally distinct closure inserted FIRST.
const WITH_EXTRA = BASE.replace("var fs = [", "var fs = [\n  function (p, q, r, s) { return [p, q, r, s].join(','); },");
const WITH_FEWER = BASE.replace("  function (a) { return a + 1; },\n", "");

function load(src: string): Decoder | null {
  const hc = findHermesc(96);
  if (hc === null) return null;
  const c = compileWithHermesc(hc, `(function(){\n${src}\n})();`, "m.js");
  assert.ok(c.ok, c.ok ? "" : c.error);
  return new Decoder(parseHbc(c.bytes));
}

function kids(d: Decoder): number[] {
  const g = d.decode(d.mod.header.globalCodeIndex);
  assert.ok(!(g instanceof Error));
  const [factory] = childrenOf(g);
  const f = d.decode(factory!);
  assert.ok(!(f instanceof Error));
  return [...childrenOf(f)];
}

const params = (d: Decoder, i: number): number => d.mod.functions[i]!.header.paramCount;

test("an inserted early closure leaves every later sibling paired with its identical twin", (t) => {
  const o = load(BASE);
  const r = load(WITH_EXTRA);
  if (o === null || r === null) return t.skip("hermesc v96 not available");
  const oc = kids(o);
  const rc = kids(r);
  assert.equal(rc.length, oc.length + 1);
  const byOrder = oc.map((x, k) => [x, rc[k]!] as const);
  assert.ok(byOrder.some(([x, y]) => params(o, x) !== params(r, y)), "order pairing mis-pairs (premise)");
  const pairs = alignLeftovers(o, oc, r, rc);
  assert.equal(pairs.length, oc.length, "every original is paired");
  for (const [a, b] of pairs) {
    assert.equal(b, a + 1, "original k pairs with recompiled k+1 (the extra one is skipped)");
    assert.equal(params(o, oc[a]!), params(r, rc[b]!));
  }
});

test("a removed early closure leaves the rest paired, and only the lost one is unmatched", (t) => {
  const o = load(BASE);
  const r = load(WITH_FEWER);
  if (o === null || r === null) return t.skip("hermesc v96 not available");
  const pairs = alignLeftovers(o, kids(o), r, kids(r));
  assert.deepEqual(pairs, [[1, 0], [2, 1], [3, 2]]);
});
