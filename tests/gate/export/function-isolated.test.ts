// Robustness (fix batch 0.1.2 item 1): one function whose CFG fails an
// internal invariant (E_INTERNAL) used to abort the whole `hbc2js export`
// before any file was written -- the environment walk and the semantic index
// both built every function's CFG unguarded. Now that function is opaque to
// both, `emitModule` writes it as a visible throwing stub (EM-01), the export
// finishes, and EXPORT.json `unresolved` carries a `function-isolated` row.
// The failure is injected (HBC2JS_INJECT_CFG_FAILURE), so this stays a gate
// after every real CFG bug is fixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decompile } from "../../../src/decompile.ts";
import { isolatedFunctionsIn } from "../../../src/export/index.ts";
import { repoRoot } from "../../support/paths.ts";
import { CLI, RN_TEMPLATE } from "./support.ts";

const INJECT = "HBC2JS_INJECT_CFG_FAILURE";

test("export: an injected E_INTERNAL in one function isolates it; the tree is written and EXPORT.json records it", () => {
  const out = join(mkdtempSync(join(tmpdir(), "hbc2js-isolated-")), "tree");
  try {
    const r = spawnSync(process.execPath, [CLI, "export", RN_TEMPLATE, "--out", out], { encoding: "utf8", env: { ...process.env, [INJECT]: "500" } });
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    const manifest = JSON.parse(readFileSync(join(out, "EXPORT.json"), "utf8"));
    const rows = manifest.unresolved.filter((u: { kind: string }) => u.kind === "function-isolated");
    assert.equal(rows.length, 1, JSON.stringify(manifest.unresolved));
    assert.match(rows[0].detail, /fn#500 could not be decompiled \(E_INTERNAL\)/);
    const path = /\((src\/[^)]+\.js)\)/.exec(rows[0].detail)![1]!;
    assert.ok(existsSync(join(out, path)));
    const text = readFileSync(join(out, path), "utf8");
    assert.match(text, /ISOLATED FAILURE/);
    assert.deepEqual(isolatedFunctionsIn(text), [{ fn: 500, code: "E_INTERNAL" }]);
  } finally {
    rmSync(join(out, ".."), { recursive: true, force: true });
  }
});

test("decompile: an injected CFG failure in a generator stubs that function only", () => {
  const prev = process.env[INJECT];
  process.env[INJECT] = "1";
  try {
    const hbc = readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", "09-switch-fallthrough", "v96.hbc"));
    const r = decompile(new Uint8Array(hbc));
    assert.match(r.code, /could not decompile fn#1 /);
    assert.equal(isolatedFunctionsIn(r.code).length, 1);
  } finally {
    if (prev === undefined) delete process.env[INJECT];
    else process.env[INJECT] = prev;
  }
});
