import { readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

// Two construct fixtures must never share a numeric prefix (concurrent workers
// collided on 100 and 101).
test("construct fixture numeric prefixes are unique", () => {
  const dir = join(repoRoot(), "tests/fixtures/constructs");
  const seen = new Map<string, string[]>();
  for (const name of readdirSync(dir)) {
    const m = /^(\d+)-/.exec(name);
    if (!m) continue;
    seen.set(m[1], [...(seen.get(m[1]) ?? []), name]);
  }
  const dups = [...seen].filter(([, v]) => v.length > 1).map(([k, v]) => `${k}: ${v.join(", ")}`);
  assert.deepEqual(dups, []);
});
