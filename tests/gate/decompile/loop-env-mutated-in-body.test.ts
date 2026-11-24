// Torture hbc99 --hard, findings cluster "hbc99: per-iteration let closure
// capture, loop var mutated in body (env hoisted out of loop)": an
// environment hermesc creates once per loop iteration (an inlined Babel
// `_loop(c)` helper) was declared function-wide when the body wrote its slot
// after a branch, so every closure read the last iteration's value. Fixture
// 491 runs decompiled vs expected under a Hermes VM, which (unlike V8)
// compiles without block scoping: a per-iteration binding must be a function
// boundary there, not a block `let`. Fixture 17-closure-loop-var v98/v99 was
// DIVERGENT under the VM for the same reason and is pinned here too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decompile } from "../../../src/decompile.ts";
import { findHermesVm, runHermes } from "../../../src/harness/hermes-vm.ts";
import { repoRoot } from "../../support/paths.ts";

const CASES = [
  ["491-loop-env-mutated-in-body", [84, 94, 96, 98, 99]],
  ["17-closure-loop-var", [98, 99]],
] as const;

for (const [fixture, versions] of CASES) {
  const dir = join(repoRoot(), "tests", "fixtures", "constructs", fixture);
  for (const v of versions) {
    for (const mode of ["none", "on"] as const) {
      test(`loop env mutated in body: ${fixture} v${v} --passes=${mode} prints expected.txt under Hermes`, (t) => {
        const vm = findHermesVm(96);
        if (vm === null) return t.skip("no Hermes VM (tools/hermes-vm)");
        const r = decompile(new Uint8Array(readFileSync(join(dir, `v${v}.hbc`))), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} });
        const tmp = mkdtempSync(join(tmpdir(), "hbc2js-loopenv-"));
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
