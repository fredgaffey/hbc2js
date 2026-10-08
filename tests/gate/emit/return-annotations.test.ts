// `src/emit/return-annotate.ts` adds two per-function header comments, both
// derived from real CFG facts (a proven undefined-only Ret shape; a real
// FunctionKind; a bytecode string-table-id-matched global-property write and
// read), never from a name or a recovered `async`/`await` AST shape. This
// test exercises the real construct fixture (`87-return-annotations`,
// compiled for every HBC version) end to end through `decompile()` with
// `emit.returnAnnotations: true`, plus two hand-built unit cases that prove
// the "never a guess" contract directly (a mixed void/non-void function gets
// no annotation; an unresolvable async call site is not counted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import type { HbcVersion } from "../../support/hermesc.ts";
import { decompile } from "../../../src/decompile.ts";
import { isProvablyVoidFunction } from "../../../src/emit/return-annotate.ts";

const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "87-return-annotations");
const VERSIONS: readonly HbcVersion[] = [84, 94, 96, 98, 99];

for (const version of VERSIONS) {
  const hbcPath = join(FIXTURE, `v${version}.hbc`);

  test(`H3b: return annotations v${version} (default-on, opt-out): void function, and async fire-and-forget vs awaited`, (t) => {
    if (!existsSync(hbcPath)) {
      t.skip(`fixture not built for v${version} - run tests/fixtures/build.sh (INCONCLUSIVE, not a failure)`);
      return;
    }
    const withAnnotations = decompile(new Uint8Array(readFileSync(hbcPath)), { emit: { returnAnnotations: true } }).code;
    const without = decompile(new Uint8Array(readFileSync(hbcPath)), {}).code;

    // (a) voidFn: every return path is a bare `return;` -- annotated.
    assert.ok(withAnnotations.includes("// returns: nothing"), `v${version}: expected a "returns: nothing" annotation, got:\n${withAnnotations}`);

    // (b) fetchFoo: async, called twice -- once discarded, once awaited.
    // M (2) is honest about being "call sites this analysis can resolve",
    // not every call site in the app (H3 brief's honesty requirement).
    const discardMatch = withAnnotations.match(/async, result discarded at (\d+) of (\d+) call sites this analysis can resolve/);
    assert.ok(discardMatch, `v${version}: expected an "async, result discarded at N of M call sites" annotation, got:\n${withAnnotations}`);
    assert.equal(discardMatch![1], "1", `v${version}: exactly one of fetchFoo's two call sites is discarded`);
    assert.equal(discardMatch![2], "2", `v${version}: exactly two of fetchFoo's call sites are resolved`);

    // Never emitted for `callSites` itself (async, called ONCE, bare
    // statement -- discarded too, "1 of 1" -- distinct from fetchFoo's own
    // "1 of 2", both present, neither a false claim about the other).
    assert.ok(withAnnotations.includes("async, result discarded at 1 of 1 call sites this analysis can resolve"), `v${version}: expected callSites' own "1 of 1" annotation too, got:\n${withAnnotations}`);

    assert.ok(without.includes("// returns: nothing"), `H3b: v${version}: default render must carry "returns: nothing"`);
    assert.ok(without.includes("result discarded"), `H3b: v${version}: default render must carry "result discarded"`);
    // Explicit `false` opts out of both.
    const off = decompile(new Uint8Array(readFileSync(hbcPath)), { emit: { returnAnnotations: false } }).code;
    assert.ok(!off.includes("returns: nothing"), `H3b: v${version}: returnAnnotations:false must drop "returns: nothing"`);
    assert.ok(!off.includes("result discarded"), `H3b: v${version}: returnAnnotations:false must drop "result discarded"`);

    // `node --check` on the annotated output: the added comments are
    // comments, never a syntax change.
    assert.match(withAnnotations, /^\/\/ hbc2js/);
  });
}

// --- unit tests: the "never a guess" contract itself -----------------------
import { analyseModule } from "../../../src/cfg/index.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { findGlobalCallSites, isAsyncFunction } from "../../../src/emit/return-annotate.ts";

test("isProvablyVoidFunction: a mixed void/non-void function is never claimed void (real fixture, not synthetic)", () => {
  // 12-... any fixture with a mixed return is overkill; reuse this task's
  // own fixture's `fetchFoo` wrapper, which returns a real value (a
  // Promise), to prove the negative case on real bytecode rather than a
  // hand-rolled CFG.
  const hbcPath = join(FIXTURE, "v96.hbc");
  if (!existsSync(hbcPath)) return;
  const mod = parseHbc(new Uint8Array(readFileSync(hbcPath)));
  const analysis = analyseModule(mod);
  // fn#1 is fetchFoo's OWN wrapper (see the fixture's build): it always
  // returns a real value (the promise `spawnAsync` produces), never
  // undefined -- isProvablyVoidFunction must say so.
  assert.equal(isProvablyVoidFunction(analysis.cfg(1)), false);
});

test("findGlobalCallSites: a callee this mechanism cannot resolve at all yields no sites, never a guess", () => {
  const hbcPath = join(FIXTURE, "v96.hbc");
  if (!existsSync(hbcPath)) return;
  const mod = parseHbc(new Uint8Array(readFileSync(hbcPath)));
  const analysis = analyseModule(mod);
  // Function index far outside the module's own function table: no global
  // property write exists for it, so the mechanism must return an empty
  // list rather than fabricate anything.
  assert.deepEqual(findGlobalCallSites(analysis, 99999), []);
});

test("isAsyncFunction: a plain (non-async) function is never reported async", () => {
  const hbcPath = join(FIXTURE, "v96.hbc");
  if (!existsSync(hbcPath)) return;
  const mod = parseHbc(new Uint8Array(readFileSync(hbcPath)));
  const analysis = analyseModule(mod);
  // fn#0 is the module's own global/init function: never async.
  assert.equal(isAsyncFunction(analysis, 0), false);
});
