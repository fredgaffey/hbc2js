import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { splitProject } from "../../../src/split/index.ts";
import { renderModuleReadable } from "../../../src/split/render-module.ts";
import { nodeCheck } from "../../../src/decompile.ts";
import { buildFactoryInfo, computeFnOwnership, computeLexicalParents } from "../../../src/artifact/build.ts";
import { buildSemanticIndexes } from "../../../src/artifact/semantic-walk.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.debug.hbc");

test("render-modules batch: one parse serves every selected module, node --check passes, memory stays bounded", () => {
  const bytes = readFileSync(RN_TEMPLATE);

  const t0 = performance.now();
  const splitResult = splitProject(bytes, { moduleName: "index.android.debug.hbc" });
  const parseMs = performance.now() - t0;

  // rendersJsx per function, the same walk the artifact writer uses
  // (src/artifact/write.ts) -- computed once, off the SAME `splitResult`,
  // never a second parse.
  const factoryInfo = buildFactoryInfo(splitResult.module, splitResult.modules);
  const parents = computeLexicalParents(splitResult.module, splitResult.analysis);
  const ownership = computeFnOwnership(splitResult.module, parents, splitResult.modules);
  const { rendersJsxByFn } = buildSemanticIndexes(splitResult.module, splitResult.analysis, factoryInfo, ownership);

  // "components" selection (same rule `buildModulesIndex` uses): a module a
  // rendersJsx function's printed range attributes to it. Walked here
  // directly from `functionRanges` -> module, not `deps` (require edges,
  // not ownership).
  const moduleOfFn = new Map<number, number>();
  for (const m of splitResult.modules) {
    for (const [fn, range] of splitResult.functionRanges) {
      if (range.file === m.file) moduleOfFn.set(fn, m.id);
    }
  }
  const componentModuleIds = new Set<number>();
  for (const [fn, isJsx] of rendersJsxByFn) {
    if (!isJsx) continue;
    const modId = moduleOfFn.get(fn);
    if (modId !== undefined) componentModuleIds.add(modId);
  }
  assert.ok(componentModuleIds.size > 0, "rn-template must have at least one component module");

  const rssBefore = process.memoryUsage().rss;
  const t1 = performance.now();
  let rendered = 0;
  for (const id of componentModuleIds) {
    const m = splitResult.modules.find((mm) => mm.id === id)!;
    const out = renderModuleReadable(splitResult.analysis, m.factoryFunctionIndex, id, { tier: "passes", strictEnv: false, moduleName: "index.android.debug.hbc" });
    const check = nodeCheck(out.code);
    assert.ok(check.ok, `module ${String(id)} readable render failed node --check: ${"message" in check ? check.message : ""}`);
    rendered += 1;
  }
  const renderMs = performance.now() - t1;
  const rssAfter = process.memoryUsage().rss;
  const rssDeltaMb = (rssAfter - rssBefore) / (1024 * 1024);

  assert.ok(rendered >= componentModuleIds.size);
  // Single-parse proxy: re-parsing + re-analysing the whole bundle per
  // module (instead of the scoped `onlyFunction` render this batch uses)
  // would cost at least `rendered` more `parseMs`-sized parses on top of the
  // render work itself; bounding total render time to a small multiple of
  // ONE parse (never `rendered * parseMs`) catches that regression without
  // being a flaky exact-timing assertion.
  assert.ok(renderMs < Math.max(parseMs * 5, 2000), `rendering ${String(rendered)} modules took ${renderMs.toFixed(0)}ms vs one parse at ${parseMs.toFixed(0)}ms -- looks like a per-module re-parse`);
  // Bounded memory: rendering dozens of modules off ONE analysis must not
  // accumulate per-module state; generous cap to absorb GC/CI noise while
  // still catching an unbounded per-module leak.
  assert.ok(rssDeltaMb < 300, `RSS grew by ${rssDeltaMb.toFixed(1)}MB rendering ${String(rendered)} modules -- expected roughly flat`);
});
