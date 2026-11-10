// fix-modulename-dependence: review-1110 guard/this reported that which
// versions of construct fixture 310 keep their global guards depended on the
// `moduleName` passed to `decompile`. Not reproducible: `moduleName` reaches
// only the header comment (`src/emit/index.ts`, "decompiled from <name>") and
// the split/scoped-render banners, never a pass. The guards kept at 84/94/96
// are a structural missed fold, independent of the name (see
// docs/specs/passes/03-global-access.md section 7, "Lowered generator bodies").
// These tests pin both facts. passes-inside-generators (00-LADDER "Resumable
// bodies") then folded the 3 first-resume guards; the 3 kept read a register
// an earlier resume stored and are refused on purpose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";

const FIXTURE = "310-review-guard-probes";
const NAMES = ["x", "input.hbc", FIXTURE, "a/b c.hbc", "zz9"];
const bytesAt = (v: number): Uint8Array => new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${v}.hbc`)));
const header = (name: string): string => `// hbc2js -- decompiled from ${name}`;

test("fix-modulename-dependence: fixture 310 decompiles identically modulo the printed module name", () => {
  for (const v of [84, 94, 96, 98, 99]) {
    const bytes = bytesAt(v);
    const outs = NAMES.map((n) => {
      const code = decompile(bytes, { moduleName: n, resolveV98Ambiguity: true }).code;
      assert.ok(code.includes(header(n)), `v${v} ${n}: header missing`);
      return code.replace(header(n), header("<N>"));
    });
    for (let i = 1; i < outs.length; i++) assert.equal(outs[i], outs[0], `v${v}: output for ${JSON.stringify(NAMES[i])} differs from ${JSON.stringify(NAMES[0])}`);
  }
});

test("fix-modulename-dependence: guard count for fixture 310 is name-independent (3 kept at 84/94/96, 0 at 98/99)", () => {
  const expected: Record<number, number> = { 84: 3, 94: 3, 96: 3, 98: 0, 99: 0 };
  for (const [v, want] of Object.entries(expected)) {
    for (const n of NAMES) {
      const code = decompile(bytesAt(Number(v)), { moduleName: n, resolveV98Ambiguity: true }).code;
      assert.equal((code.match(/doesn't exist/g) ?? []).length, want, `v${v} ${n}`);
    }
  }
});
