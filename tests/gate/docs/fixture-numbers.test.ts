import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// Two construct fixtures must never share a numeric prefix (concurrent workers
// collided on 100 and 101).
test("construct fixture numeric prefixes are unique", () => {
  const dir = join(__dirname, "../../fixtures/constructs");
  const seen = new Map<string, string[]>();
  for (const name of readdirSync(dir)) {
    const m = /^(\d+)-/.exec(name);
    if (!m) continue;
    seen.set(m[1], [...(seen.get(m[1]) ?? []), name]);
  }
  const dups = [...seen].filter(([, v]) => v.length > 1).map(([k, v]) => `${k}: ${v.join(", ")}`);
  expect(dups).toEqual([]);
});
