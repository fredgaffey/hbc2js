// Torture s4-n1000-hbc96 parseHarborMeadow_mn threw "Cannot use 'in' operator
// to search for 'Math' in undefined" (expected 939838618). hermesc -O loads
// the global object into one register, reuses that register later on the
// straight-line path, and a switch case `break L0`s past the reuse to code that
// still reads `Math` through it. globalthis-dead-store's local scan walked
// past the `break` as if control fell through, met the later plain write, and
// deleted the `rN = globalThis` store. Fixture 497 (red v84-v96 before the
// fix) runs decompiled vs expected under a Hermes VM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decompile } from "../../../src/decompile.ts";
import { findHermesVm, runHermes } from "../../../src/harness/hermes-vm.ts";
import { repoRoot } from "../../support/paths.ts";

const dir = join(repoRoot(), "tests", "fixtures", "constructs", "497-globalthis-store-skipped-by-break");
for (const v of [84, 94, 96, 98, 99]) {
  for (const mode of ["none", "on"] as const) {
    test(`globalThis store skipped by a break: fixture 497 v${v} --passes=${mode} prints expected.txt under Hermes`, (t) => {
      const vm = findHermesVm(96);
      if (vm === null) return t.skip("no Hermes VM (tools/hermes-vm)");
      const r = decompile(new Uint8Array(readFileSync(join(dir, `v${v}.hbc`))), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} });
      const tmp = mkdtempSync(join(tmpdir(), "hbc2js-gt497-"));
      try {
        const file = join(tmp, "out.js");
        writeFileSync(file, r.code);
        const out = runHermes(vm.path, file);
        assert.equal(out.lines.join("\n") + "\n", readFileSync(join(dir, "expected.txt"), "utf8"));
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
}
