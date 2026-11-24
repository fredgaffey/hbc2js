// Torture s2-n1000-hbc96 wrong values (verifyBadgeBadge_ax, groupBeaconCache_bb,
// splitKettleMeadow_bd): a loop body try/catch/finally that pushes a constant
// (`arr.push(37)`) whose load hermesc hoists above the loop. Once finally-dedup
// folded the copies into one `finally {}`, expr-rebuild's dead-store scan
// followed the try block's `break L` straight to the label and never looked
// at the finalizer, so `r11 = 37` was deleted and the push read a stale value.
// Fixture 496 (red at v96 before the fix) runs decompiled vs expected under a
// Hermes VM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decompile } from "../../../src/decompile.ts";
import { findHermesVm, runHermes } from "../../../src/harness/hermes-vm.ts";
import { repoRoot } from "../../support/paths.ts";

const CASES = [
  ["496-finally-reads-hoisted-const", [84, 94, 96, 98, 99]],
] as const;

for (const [fixture, versions] of CASES) {
  const dir = join(repoRoot(), "tests", "fixtures", "constructs", fixture);
  for (const v of versions) {
    for (const mode of ["none", "on"] as const) {
      test(`finally reads hoisted const: ${fixture} v${v} --passes=${mode} prints expected.txt under Hermes`, (t) => {
        const vm = findHermesVm(96);
        if (vm === null) return t.skip("no Hermes VM (tools/hermes-vm)");
        const r = decompile(new Uint8Array(readFileSync(join(dir, `v${v}.hbc`))), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} });
        const tmp = mkdtempSync(join(tmpdir(), "hbc2js-fin496-"));
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
}
