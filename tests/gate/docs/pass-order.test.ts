// Doc gate: the "Registered order" block in docs/specs/passes/00-LADDER.md must
// match src/passes/registry.ts exactly (names and order), so the ladder doc
// cannot drift from the real pipeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { REGISTRY } from "../../../src/passes/registry.ts";

test("00-LADDER.md registered-order block matches src/passes/registry.ts", () => {
  const text = readFileSync(join(repoRoot(), "docs", "specs", "passes", "00-LADDER.md"), "utf8");
  const m = /<!-- registry-order:start -->([\s\S]*?)<!-- registry-order:end -->/.exec(text);
  assert.ok(m, "missing registry-order block in 00-LADDER.md");
  const documented = m[1]!.replace(/```/g, "").split(/\s+/).filter((x) => x.length > 0);
  assert.deepEqual(documented, REGISTRY.map((p) => p.name));
});
