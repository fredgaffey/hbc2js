// export-boot L4: under `--tier flat` (and for any module that falls back to
// the flat text) the module files call `__hbc_*` runtime helpers from the
// split render, but `src/_hbc/helpers.js` only installed the helpers of
// READABLE renders, so the held-out app's module 140 threw
// "Property '__hbc_pnames' doesn't exist" (a for-in) on the export side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { cleanup, exportTo } from "./support.ts";

const RN_HBC = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

test("export-boot L4: every __hbc_* helper a flat-tier module calls is installed by src/_hbc/helpers.js", () => {
  const { out, run } = exportTo(RN_HBC, ["--instrument=modules", "--substitute", "none", "--tier", "flat"]);
  try {
    assert.equal(run.status, 0, run.stderr);
    const helpers = readFileSync(join(out, "src", "_hbc", "helpers.js"), "utf8");
    const missing = new Set<string>();
    for (const f of jsFiles(join(out, "src"))) {
      if (f.includes(join("src", "_hbc"))) continue;
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/\b(__hbc_[A-Za-z0-9_]+)\s*\(/g)) {
        const name = m[1]!;
        if (new RegExp(`function ${name}\\b|var ${name}\\b`).test(text)) continue;
        if (!new RegExp(`\\b${name}\\b`).test(helpers)) missing.add(name);
      }
    }
    assert.deepEqual([...missing].sort(), []);
  } finally {
    cleanup(out);
  }
});
