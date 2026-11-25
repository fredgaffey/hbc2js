// Sweep 3 (2026-11-26, `:copy` clusters of the static sweep, docs/SWEEP-2026-11-26.md):
// each fixture must print expected.txt under Hermes AND leave no NEVER-WRITTEN /
// READ-BEFORE-WRITE finding from tools/sweep/static.ts on the decompiled text.
//   502 in-paramless-catch: try-shape drops the catch binding when the
//       exception is dead, but the `Catch rX` lowering still printed
//       `catch { rX = __exc; }`, a copy of the never-written `__exc`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decompile } from "../../../src/decompile.ts";
import { findHermesVm, runHermes } from "../../../src/harness/hermes-vm.ts";
import { staticFindings } from "../../../tools/sweep/static.ts";
import { repoRoot } from "../../support/paths.ts";

const FIXTURES = ["502-paramless-catch-dead-exc-copy"];

for (const fixture of FIXTURES) {
  const dir = join(repoRoot(), "tests", "fixtures", "constructs", fixture);
  for (const v of [84, 94, 96, 98, 99]) {
    for (const mode of ["none", "on"] as const) {
      test(`sweep 2026-11-26 :copy: ${fixture} v${v} --passes=${mode} has no unwritten-read findings and prints expected.txt`, (t) => {
        const hbc = join(dir, `v${v}.hbc`);
        if (!existsSync(hbc)) return t.skip(`v${v} does not compile this fixture (versions.txt)`);
        const r = decompile(new Uint8Array(readFileSync(hbc)), { resolveV98Ambiguity: true, passes: mode === "none" ? { none: true } : {} });
        const bad = staticFindings(r.code, fixture, v).filter((f) => f.check === "NEVER-WRITTEN" || f.check === "READ-BEFORE-WRITE");
        assert.deepEqual(bad.map((f) => `${f.sig} ${f.detail}`), []);
        const vm = findHermesVm(96);
        if (vm === null) return t.skip("no Hermes VM (tools/hermes-vm)");
        const tmp = mkdtempSync(join(tmpdir(), "hbc2js-sweep1126-"));
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

// Checker false positive (same triage): `T = rN` where T is never observed
// moves an unwritten register nowhere. Reported as WARN:DEAD-COPY, transitively
// through copy chains and cycles; a copy whose target is read stays a finding.
test("sweep 2026-11-26 :copy: static checker reports copies into never-read locals as WARN:DEAD-COPY", () => {
  const checks = (code: string): string[] => staticFindings(code, "t", 96).filter((f) => f.check !== "FREE").map((f) => `${f.check} ${f.detail}`).sort();
  // dead target
  assert.deepEqual(checks("function f() { let r1; let r2; r2 = r1; r2 = 3; }"), ["WARN r1"]);
  // transitive chain + cycle: r2 -> r3 -> r2, none observed
  assert.deepEqual(checks("function f() { let r1; let r2; let r3; r2 = r1; r3 = r2; r2 = r3; }"), ["WARN r1"]);
  // live target: still a finding
  assert.deepEqual(checks("function f() { let r1; let r2; r2 = r1; return r2; }"), ["NEVER-WRITTEN r1"]);
  // chain ending in a read: live
  assert.deepEqual(checks("function f() { let r1; let r2; let r3; r2 = r1; r3 = r2; g(r3); }"), ["NEVER-WRITTEN r1"]);
  // read-before-write into a dead local, then a live read before the write
  assert.deepEqual(checks("function f() { let r1; let r2; r2 = r1; g(r1); r1 = 2; }"), ["READ-BEFORE-WRITE r1", "WARN r1"]);
  // hermesc's construct-call setup: a dead copy inside a sequence
  assert.deepEqual(checks("function f(C) { let r5; let r14; let r2 = (r14 = r5, new C()); return r2; }"), ["WARN r5"]);
  // ... but the sequence's final value is used
  assert.deepEqual(checks("function f() { let r5; let r14; return (0, r14 = r5); }"), ["NEVER-WRITTEN r5"]);
  // the assignment's value is used: not a plain copy statement
  assert.deepEqual(checks("function f() { let r1; let r2; g(r2 = r1); }"), ["NEVER-WRITTEN r1"]);
});
