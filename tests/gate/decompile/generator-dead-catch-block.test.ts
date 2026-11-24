// App-fuzz cfg05 (hbc96 export crash): a generator yielding inside a nested if
// of a string switch with a fallthrough default, in a try whose body also has
// an empty inner try/catch. hermesc v84-v96 lay out that empty catch's Catch
// block with no handler row, so it is dead code; CFG-05 treated ANY unreachable
// block in an opcode-era generator as "dispatcher not built" and threw
// E_INTERNAL, aborting the export. Only an unreachable RESUME block means that
// now. Fixture 495 runs decompiled vs expected under a Hermes VM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decompile } from "../../../src/decompile.ts";
import { findHermesVm, runHermes } from "../../../src/harness/hermes-vm.ts";
import { repoRoot } from "../../support/paths.ts";

const CASES = [
  ["495-generator-yield-switch-fallthrough-try", [84, 94, 96, 98, 99]],
] as const;

for (const [fixture, versions] of CASES) {
  const dir = join(repoRoot(), "tests", "fixtures", "constructs", fixture);
  for (const v of versions) {
    for (const mode of ["none", "on"] as const) {
      test(`generator yield in switch fallthrough: ${fixture} v${v} --passes=${mode} prints expected.txt under Hermes`, (t) => {
        const vm = findHermesVm(96);
        if (vm === null) return t.skip("no Hermes VM (tools/hermes-vm)");
        const r = decompile(new Uint8Array(readFileSync(join(dir, `v${v}.hbc`))), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} });
        const tmp = mkdtempSync(join(tmpdir(), "hbc2js-gen495-"));
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
