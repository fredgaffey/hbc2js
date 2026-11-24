// corpus a10 (0.1.2 F-Droid corpus): an Expo build whose Metro
// createModuleIdFactory returns 8-hex-digit STRING ids -- every registration
// is `__d(factory, "bb416d32", ["d339d332", ...])` and the startup calls are
// `__r("<id>")`. dscan only took numeric ids, so all 4688 modules had a null
// id, split wrote 0 modules and export reported "no Metro modules". String ids
// are now numbered by first registration (0, 1, 2, ...) and the startup
// `__r("<id>")` calls resolve through the same table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { splitProject } from "../../../src/split/index.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import type { HbcVersion } from "../../support/hermesc.ts";

const FACTORY = "function(global, require, importDefault, importAll, module, exports, dependencyMap)";
const SOURCE = `var g = typeof globalThis !== "undefined" ? globalThis : this;
__d(${FACTORY} { module.exports = "a10-core"; }, "c0ffee01", []);
__d(${FACTORY} { module.exports = require(dependencyMap[0]) + "-lib"; }, "bb416d32", ["c0ffee01"]);
__d(${FACTORY} { module.exports = require(dependencyMap[0]) + require(dependencyMap[1]); }, "d339d332", ["bb416d32", "c0ffee01"]);
__r("c0ffee01");
__r("d339d332");`;

const VERSIONS = ([94, 96, 98] as HbcVersion[]).filter((v) => findHermesc(v) !== null);

function compile(version: HbcVersion, dir: string): Uint8Array {
  writeFileSync(join(dir, `s${version}.js`), SOURCE, "utf8");
  const out = join(dir, `s${version}.hbc`);
  const r = runHermesc(findHermesc(version)!, ["-O", "-emit-binary", `-out=${out}`, `s${version}.js`], dir);
  assert.equal(r.status, 0, `hermesc v${version} failed: ${r.stderr}`);
  return new Uint8Array(readFileSync(out));
}

test("corpus a10: string Metro module ids are numbered by registration order, deps and startup ids through the same table", (t) => {
  if (VERSIONS.length === 0) return t.skip("no hermesc found (run tools/get-hermesc.sh)");
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-string-ids-"));
  try {
    for (const v of VERSIONS) {
      const bytes = compile(v, dir);
      const opts = v === 98 ? { opcodeTable: "hbc98-late" as const } : {};
      const inv = buildInventory(bytes, opts).inventory;
      assert.deepEqual(inv.modules.map((m) => m.localModuleId), [0, 1, 2], `v${v} ids`);
      assert.deepEqual(inv.modules.map((m) => m.depIds), [[], [0], [1, 0]], `v${v} deps`);
      if (v === 98) continue; // splitProject takes no opcode-table option
      const split = splitProject(bytes);
      assert.equal(split.modules.length, 3, `v${v} split modules`);
      assert.deepEqual(split.startupModuleIds, [0, 2], `v${v} startup ids`);
      assert.equal(split.entryModuleId, 2, `v${v} entry`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
