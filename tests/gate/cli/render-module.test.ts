import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep } from "../../support/tiers.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.debug.hbc");
const HELD_OUT = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.debug.hbc");

interface ModuleEntryJson {
  readonly id: number;
  readonly rendersJsx: boolean;
}
interface ModulesIndexJson {
  readonly modules: readonly ModuleEntryJson[];
}
interface SplitModulesJson {
  readonly modules: readonly { readonly id: number; readonly readable?: string | null }[];
}

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** `--only components` selects exactly the module ids `index/modules.json`
 *  tags `rendersJsx: true` -- read independently from the artifact this same
 *  run wrote, never assumed equal by construction. */
function assertComponentsSelectionEqualsIndex(outDir: string): { componentsCount: number; totalCount: number } {
  const modulesIndex = JSON.parse(readFileSync(join(outDir, "index", "modules.json"), "utf8")) as ModulesIndexJson;
  const splitModules = JSON.parse(readFileSync(join(outDir, "MODULES.json"), "utf8")) as SplitModulesJson;
  const expected = new Set(modulesIndex.modules.filter((m) => m.rendersJsx).map((m) => m.id));
  const got = new Set(splitModules.modules.filter((m) => m.readable !== null && m.readable !== undefined).map((m) => m.id));
  assert.deepEqual(got, expected, "render-modules --only components must select exactly the rendersJsx:true module ids");
  return { componentsCount: expected.size, totalCount: modulesIndex.modules.length };
}

test("render-modules --only components on rn-template: selection matches the rendersJsx index tag, every readable file node --checks", () => {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-render-modules-cli-"));
  try {
    const r = runCli(["render-modules", RN_TEMPLATE, "--only", "components", "--out", outDir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /rendered \d+\/\d+ module\(s\)/);
    const { componentsCount } = assertComponentsSelectionEqualsIndex(outDir);
    assert.ok(componentsCount > 0, "rn-template must have at least one rendersJsx module");

    const splitModules = JSON.parse(readFileSync(join(outDir, "MODULES.json"), "utf8")) as SplitModulesJson;
    let checked = 0;
    for (const m of splitModules.modules) {
      if (m.readable === null || m.readable === undefined) continue;
      const path = join(outDir, m.readable);
      assert.ok(existsSync(path), `${m.readable} must exist`);
      const code = readFileSync(path, "utf8");
      assert.match(code, /^\/\/ hbc2js readable render -- module \d+ \(factory fn#\d+\), tier: passes\n/, "readable file must open with a tier header");
      const check = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
      assert.equal(check.status, 0, `${m.readable} failed node --check: ${check.stderr}`);
      checked += 1;
    }
    assert.equal(checked, componentsCount);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("render-module --module N writes readable/module_N.js and honours --limit on render-modules", () => {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-render-module-cli-"));
  try {
    // Find one rendersJsx module id first via a components run into a scratch dir.
    const scratch = mkdtempSync(join(tmpdir(), "hbc2js-render-module-scratch-"));
    const scratchRun = runCli(["render-modules", RN_TEMPLATE, "--only", "components", "--limit", "1", "--out", scratch]);
    assert.equal(scratchRun.status, 0, scratchRun.stderr);
    const scratchModules = JSON.parse(readFileSync(join(scratch, "MODULES.json"), "utf8")) as SplitModulesJson;
    const oneId = scratchModules.modules.find((m) => m.readable !== null && m.readable !== undefined)?.id;
    rmSync(scratch, { recursive: true, force: true });
    assert.ok(oneId !== undefined, "expected at least one rendersJsx module id from the scratch run");

    const r = runCli(["render-module", RN_TEMPLATE, "--module", String(oneId), "--out", outDir]);
    assert.equal(r.status, 0, r.stderr);
    const path = join(outDir, "readable", `module_${String(oneId)}.js`);
    assert.ok(existsSync(path));
    const check = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("render-modules --tier jsx: header names the jsx tier (D20: not node --check'd)", () => {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-render-modules-jsx-"));
  try {
    const r = runCli(["render-modules", RN_TEMPLATE, "--only", "components", "--limit", "1", "--tier", "jsx", "--out", outDir]);
    assert.equal(r.status, 0, r.stderr);
    const splitModules = JSON.parse(readFileSync(join(outDir, "MODULES.json"), "utf8")) as SplitModulesJson;
    const one = splitModules.modules.find((m) => m.readable !== null && m.readable !== undefined);
    assert.ok(one !== undefined);
    const code = readFileSync(join(outDir, one!.readable!), "utf8");
    assert.match(code, /tier: passes\+jsx\n/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("held-out app: render-modules --only components selection matches the index tag (sweep)", (t) => {
  if (!requireSweep(t)) return;
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-render-modules-heldout-"));
  try {
    const r = runCli(["render-modules", HELD_OUT, "--only", "components", "--out", outDir]);
    assert.equal(r.status, 0, r.stderr);
    assertComponentsSelectionEqualsIndex(outDir);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
