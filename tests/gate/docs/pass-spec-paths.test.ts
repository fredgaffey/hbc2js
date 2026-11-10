// Doc gate: every backticked `src/...`, `tests/...` or `tools/...` file path in
// docs/specs/passes/*.md must exist, so a rename or a never-written file cannot
// leave a dangling reference in a pass spec (found by the 2026-11-10 doc audit:
// `tools/passes-metrics.ts`, `src/passes/yield-recovery/loop.ts`, ...).
// Paths with a glob, a placeholder (`<`), a trailing slash or under the
// gitignored toolchain directories are skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

test("docs/specs/passes/*.md: referenced repo paths exist", () => {
  const root = repoRoot();
  const dir = join(root, "docs", "specs", "passes");
  const missing: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".md"))) {
    const text = readFileSync(join(dir, f), "utf8");
    for (const m of text.matchAll(/`((?:src|tests|tools)\/[A-Za-z0-9_.\/-]+)`/g)) {
      const p = m[1]!.replace(/\.$/, "");
      if (p.endsWith("/") || p.startsWith("tools/hermes")) continue;
      if (!existsSync(join(root, p))) missing.push(`${f}: ${p}`);
    }
  }
  assert.deepEqual(missing, []);
});
