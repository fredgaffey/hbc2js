// export-boot L4: a non-enumerable own define (`DefineOwnByVal` /
// `PutOwnByVal` with enumerable=0, how v98+ native classes install methods)
// was lowered to `Object.defineProperty(o, k, {value, enumerable: false,
// configurable: true})`, leaving `writable` false. The VM's
// `getDefaultNewPropertyFlags()` makes it writable, so strict code that
// re-assigns a method (React Native's MessageQueue binds its methods in the
// constructor) threw "Cannot assign to read-only property" in the flat
// (`--passes=none`, export `--tier flat`) render. Fixture 396.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import { findAllHermesVms, runHermes } from "../../../src/harness/hermes-vm.ts";
import { repoRoot } from "../../support/paths.ts";

const DIR = join(repoRoot(), "tests", "fixtures", "constructs", "396-class-method-writable");

test("export-boot L4: a non-enumerable own define stays writable in the flat render (fixture 396, v98 and v99)", (t) => {
  const vm = findAllHermesVms().filter((v) => v.hbcVersion >= 98).at(-1);
  const expected = readFileSync(join(DIR, "expected.txt"), "utf8");
  for (const version of ["v98", "v99"]) {
    const code = decompile(readFileSync(join(DIR, `${version}.hbc`)), { passes: { none: true } }).code;
    assert.doesNotMatch(code, /\{value: [^,]+, enumerable: false/, `${version}: data define without writable`);
    if (vm === undefined) { t.diagnostic("no v98+ Hermes VM: run check skipped"); continue; }
    const dir = mkdtempSync(join(tmpdir(), "hbc2js-396-"));
    try {
      const file = join(dir, "out.js");
      writeFileSync(file, code);
      const r = runHermes(vm.path, file, { timeout: 30000, bytecode: false });
      assert.equal(r.stdout, expected, `${version}: ${r.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
