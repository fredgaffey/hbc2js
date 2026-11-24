// `equiv --boot --export-exec bytecode` must never report `"exportExec":
// "source"` (benchmark finding, 2026-11-24): the mode is chosen before the
// control boot, so early results carry it, and an explicit bytecode request
// that cannot be met is an INCONCLUSIVE that says why, not a silent
// source-mode run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportBootProof } from "../../../src/harness/export-boot.ts";

test("export-boot: --export-exec bytecode that cannot be honoured reports bytecode and says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-export-exec-"));
  try {
    writeFileSync(join(dir, "EXPORT.json"), JSON.stringify({ source: { hbcVersion: 96 }, substitutions: [] }));
    // An explicit VM keeps both sides in source mode (spec 33 §1), so a
    // bytecode request cannot be met.
    const r = await exportBootProof(join(dir, "missing.hbc"), dir, { exportExec: "bytecode", vm: join(dir, "no-such-hermes") });
    assert.equal(r.exportExec, "bytecode");
    assert.equal(r.verdict, "INCONCLUSIVE");
    assert.match(r.reason ?? "", /^--export-exec bytecode: an explicit vm runs both sides in source mode/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
