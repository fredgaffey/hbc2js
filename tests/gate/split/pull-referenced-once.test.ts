// 0.1.2 corpus a03 (Expo, HBC98, 8.6k functions): `export` never finished
// splitting. A module's referenced-but-undeclared helpers were pulled until
// their printed text matched `function _fnN(`; a helper printed in any other
// shape (e.g. a generator, `function* _fnN(`) never counted, so two mutually
// recursive ones re-queued each other forever, growing the module unboundedly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pullReferencedFunctions } from "../../../src/split/index.ts";

test("pullReferencedFunctions: mutually recursive helpers whose print never says `function _fnN(` are pulled once each", () => {
  // Bodies print under a recovered name, so scanning never marks them declared.
  const text: Record<number, string> = { 1: "function a() { return _fn2(); }", 2: "function b() { return _fn1() + _fn0(); }" };
  let prints = 0;
  const skipped: [number, string][] = [];
  const pulled = pullReferencedFunctions(
    "var x = _fn1(); var y = _fn9();",
    0,
    (i) => (text[i] !== undefined ? i : undefined),
    (i) => {
      if (++prints > 10) throw new Error("closure did not terminate");
      return text[i]!;
    },
    (i, why) => skipped.push([i, why]),
  );
  assert.deepEqual(pulled, [1, 2]);
  assert.deepEqual(skipped, [[9, "no-body"], [0, "global"]]);
});
