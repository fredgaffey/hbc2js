// docs/BUGS.md 2026-11-08: `functionStrings` missed strings that live only in
// an object-literal buffer (v98-late/v99 `NewObjectWithBuffer`, no
// `LoadConstString`). Module string EVIDENCE (`stringConstants`) now reads the
// literal buffers; the scheme-2 per-function string-set HASH must not change
// (it is stored in signature DBs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { fingerprintModule } from "../../../src/deps/fingerprint.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import type { HbcVersion } from "../../support/hermesc.ts";

const FACTORY = "function(global, require, importDefault, importAll, module, exports, dependencyMap)";
const SRC = `__d(${FACTORY} { module.exports = { objlitKeyAlpha: "objlit-value-beta", objlitKeyGamma: "objlit-value-delta" }; }, 0, []);
__r(0);`;
const EXPECT = ["objlit-value-beta", "objlit-value-delta", "objlitKeyAlpha", "objlitKeyGamma"];
const VERSIONS = ([96, 98, 99] as HbcVersion[]).filter((v) => findHermesc(v) !== null);

test("bugs-2026-11-08-objlit-strings: object-literal strings are module evidence on every version", (t) => {
  if (VERSIONS.length === 0) return t.skip("no hermesc found (run tools/get-hermesc.sh)");
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-objlit-"));
  try {
    for (const v of VERSIONS) {
      writeFileSync(join(dir, "m.js"), SRC, "utf8");
      const r = runHermesc(findHermesc(v)!, ["-O", "-emit-binary", `-out=${join(dir, "m.hbc")}`, "m.js"], dir);
      assert.equal(r.status, 0, r.stderr);
      const inv = buildInventory(new Uint8Array(readFileSync(join(dir, "m.hbc"))), v === 98 ? { opcodeTable: "hbc98-late" } : {}).inventory;
      const m = inv.modules.find((x) => x.localModuleId === 0)!;
      assert.deepEqual(m.stringConstants.filter((s) => s.startsWith("objlit")), EXPECT, `v${v}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bugs-2026-11-08-objlit-strings: scheme-2 string-set hashes are unchanged", () => {
  // Digests computed with the pre-fix code on committed fixtures.
  const PIN: Record<string, string> = { v96: "bcd0c4e73e52173c796d1858", v99: "7794ce6dfbcf695d4597734c" };
  for (const [v, want] of Object.entries(PIN)) {
    const mod = parseHbc(new Uint8Array(readFileSync(join("tests/fixtures/hermes-dec-sample", `${v}.hbc`))));
    const r = fingerprintModule(mod, decodeFunction);
    const got = createHash("sha256").update(r.functions.map((f) => `${f.stringSetHash}:${f.stringCount}`).join("\n")).digest("hex").slice(0, 24);
    assert.equal(got, want, v);
  }
});
