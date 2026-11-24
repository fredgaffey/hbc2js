// Sweep 2026-11-24 (docs/SWEEP-2026-11-24.md) miscompile clusters, each
// minimised into a construct fixture: decompiled (passes on and off) vs the
// fixture's expected.txt under a Hermes VM, at every version it compiles for.
//   492 S1 spread-rest: the fold deleted a register load it could not substitute.
//   493 S3 destructure: a register written in a pattern default was invisible
//       to the use counter, so a later definition became its `let` (TDZ).
//   498 S6 env graph: hermesc v98 inlined a closure `o` whose captured scope is
//       not visible at the caller (`GetClosureEnvironment` + `CreateEnvironment`
//       over that view); o's inner closures got a second creation site whose
//       environment had no parent, so they were orphaned (E_UNBOUND_IDENT
//       stub, or reads of the wrong scope). Per-site copies now read the
//       viewed scope through the runtime view.
//   494 S4 default-params: temporaries var-naming had renamed stayed body
//       `let`s, so the default IIFE assigned globals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decompile } from "../../../src/decompile.ts";
import { findHermesVm, runHermes } from "../../../src/harness/hermes-vm.ts";
import { repoRoot } from "../../support/paths.ts";

const FIXTURES = ["492-spread-drops-env-load", "493-destructure-default-tdz", "494-default-param-body-temps", "498-inlined-closure-env-view"];

for (const fixture of FIXTURES) {
  const dir = join(repoRoot(), "tests", "fixtures", "constructs", fixture);
  for (const v of [84, 94, 96, 98, 99]) {
    for (const mode of ["none", "on"] as const) {
      test(`sweep 2026-11-24: ${fixture} v${v} --passes=${mode} prints expected.txt under Hermes`, (t) => {
        const vm = findHermesVm(96);
        if (vm === null) return t.skip("no Hermes VM (tools/hermes-vm)");
        const hbc = join(dir, `v${v}.hbc`);
        if (!existsSync(hbc)) return t.skip(`v${v} does not compile this fixture (versions.txt)`);
        const r = decompile(new Uint8Array(readFileSync(hbc)), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} });
        const tmp = mkdtempSync(join(tmpdir(), "hbc2js-sweep1124-"));
        try {
          const file = join(tmp, "out.js");
          writeFileSync(file, r.code);
          assert.equal(runHermes(vm.path, file).lines.join("\n") + "\n", readFileSync(join(dir, "expected.txt"), "utf8"));
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      });
    }
  }
}
