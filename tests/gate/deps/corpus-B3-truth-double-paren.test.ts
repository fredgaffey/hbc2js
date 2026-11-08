// corpus-B3: tools/deps-truth.mjs's module-boundary regex only matched
// `__d(function(){...},id,[deps]);`, not the extra-paren
// `__d((function(){...}),id,[deps]);` shape, and silently returned 0 packages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error untyped .mjs tool
import { truthFromMap } from "../../../tools/deps-truth.mjs";

for (const [label, line] of [
  ["single-paren", "__d(function(g,r){},0,[]);"],
  ["double-paren", "__d((function(g,r){}),0,[]);"],
] as const) {
  test(`corpus-B3: truthFromMap attributes a ${label} module wrapper`, () => {
    const dir = mkdtempSync(join(tmpdir(), "hbc2js-b3-"));
    try {
      writeFileSync(join(dir, "b.js"), `${line}\n`);
      writeFileSync(join(dir, "b.map"), JSON.stringify({ version: 3, sources: ["/app/node_modules/foo/index.js"], names: [], mappings: "AAAA" }));
      const truth = truthFromMap([], join(dir, "b.map"), join(dir, "b.js"));
      assert.deepEqual(Object.keys(truth.packages), ["foo"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
