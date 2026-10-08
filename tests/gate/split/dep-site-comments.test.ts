import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { splitProject } from "../../../src/split/index.ts";
import { renderModuleReadable } from "../../../src/split/render-module.ts";
import { nodeCheck } from "../../../src/decompile.ts";

const RN_TEMPLATE_DEBUG = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.debug.hbc");

test("dependencyAnnotations: module 0's entry factory gets exactly one comment per dependencyMap read, each naming the module id that index actually resolves to (rn-template debug build)", () => {
  const bytes = readFileSync(RN_TEMPLATE_DEBUG);
  const splitResult = splitProject(bytes, { moduleName: "index.android.debug.hbc" });
  const m = splitResult.modules.find((mm) => mm.id === 0);
  assert.ok(m !== undefined, "rn-template debug build must have a module 0 (the entry module, D19)");

  const out = renderModuleReadable(splitResult.analysis, m!.factoryFunctionIndex, m!.id, {
    tier: "passes",
    strictEnv: false,
    moduleName: "index.android.debug.hbc",
    dependencyAnnotations: { deps: m!.deps },
  });

  // Ground truth, established by direct inspection of this exact render
  // (pasted in the H1 report): module 0 reads all four of its own
  // dependencyMap slots exactly once each -- three by a literal index
  // (`list[0]`, `list[1]`, `list[2]`), one through a copy-propagated
  // constant (`let r2_3 = 3; list[r2_3]`), never through Reflect.apply
  // (render-module.ts never runs src/split/rewrite.ts's require() rewrite).
  const comments = out.code.match(/\/\* module \d+ \*\//g) ?? [];
  assert.equal(comments.length, m!.deps.length, `expected one comment per dependencyMap slot (${m!.deps.length} deps: ${JSON.stringify(m!.deps)}), got ${JSON.stringify(comments)}`);
  const commentedIds = comments.map((c) => Number(c.match(/\d+/)![0])).sort((a, b) => a - b);
  assert.deepEqual(commentedIds, [...m!.deps].sort((a, b) => a - b), "every dependencyMap slot's id must appear exactly once, matching modules.json's own deps order (item 5's DepEdge order)");

  const check = nodeCheck(out.code);
  assert.ok(check.ok, `annotated render must still pass node --check: ${"message" in check ? check.message : ""}`);
});

test("dependencyAnnotations: across the first 60 owned modules, no comment ever names a module id the module does not actually depend on (rn-template debug build, index.android.debug.hbc)", () => {
  const bytes = readFileSync(RN_TEMPLATE_DEBUG);
  const splitResult = splitProject(bytes, { moduleName: "index.android.debug.hbc" });
  const sample = splitResult.modules.slice(0, 60);
  assert.ok(sample.length === 60, "rn-template debug build must have at least 60 owned modules to sample");

  let totalComments = 0;
  for (const m of sample) {
    const out = renderModuleReadable(splitResult.analysis, m.factoryFunctionIndex, m.id, {
      tier: "passes",
      strictEnv: false,
      moduleName: "index.android.debug.hbc",
      dependencyAnnotations: { deps: m.deps },
    });
    const check = nodeCheck(out.code);
    assert.ok(check.ok, `module ${String(m.id)} annotated render must still pass node --check: ${"message" in check ? check.message : ""}`);
    const comments = out.code.match(/\/\* module (\d+)/g) ?? [];
    totalComments += comments.length;
    // Not bounded by deps.length: a factory can legitimately read the same
    // constant slot more than once (e.g. copied into two different locals
    // for two different uses) -- the invariant that must always hold,
    // independent of how many times, is membership: every id a comment
    // names is one of this module's own deps.
    for (const c of comments) {
      const id = Number(c.match(/\d+/)![0]);
      assert.ok(m.deps.includes(id), `module ${String(m.id)}'s comment names module ${String(id)}, which is not in its own deps ${JSON.stringify(m.deps)}`);
    }
  }
  // A real number this run measured, so a future reader can tell the
  // feature is actually firing (not silently annotating zero sites) --
  // never a floor asserted against, since it is fixture content, not a
  // property of the algorithm.
  assert.ok(totalComments > 0, "expected at least one dependencyMap comment across 60 modules of a real RN bundle");
});
