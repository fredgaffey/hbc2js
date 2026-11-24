// Free-identifier regression for `hbc2js export` (bench report, Ignite
// 11.5.0, 2026-11-24): the readable tier shipped registers no scope declares
// -- `{[r12]: r11}` after var-naming renamed r12 to `key` (object-literal had
// folded the register into the prop's *string* key, invisible to every
// register walk), and `r7?.getStateFromPath` after r7 became `options` (the
// rename and EM-01 skipped `optmember`). Each throws ReferenceError at
// runtime though Metro bundles it. The fixture is a one-module Metro-shaped
// bundle reproducing the computed-key shape; the optional-chain walks are
// pinned per node kind in tests/gate/passes/register-walk-coverage.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { freeIdentifiersWithLines } from "../../../tools/export-check/free-idents.mjs";
import { cleanup, exportTo } from "./support.ts";

const FIXTURE = join(repoRoot(), "tests", "fixtures", "export-scope", "v96.hbc");

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

test("export: no module file references an identifier no scope declares (computed object key, optional chain)", () => {
  const { out, run } = exportTo(FIXTURE);
  try {
    assert.equal(run.status, 0, run.stderr);
    const free: Record<string, readonly string[]> = {};
    const files = jsFiles(join(out, "src"));
    assert.ok(files.some((f) => f.includes("module_0")), `module file missing: ${files.join(", ")}`);
    for (const f of files) {
      const names = freeIdentifiersWithLines(readFileSync(f, "utf8"));
      if (names.length > 0) free[relative(out, f)] = names;
    }
    assert.deepEqual(free, {});
  } finally {
    cleanup(out);
  }
});
