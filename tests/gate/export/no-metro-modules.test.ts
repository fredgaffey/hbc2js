// 0.1.2 corpus a02 (a Re.Pack/rspack build): export found no Metro modules,
// wrote an empty tree and exited 0 with nothing but "no-entry-module". It must
// say why: a non-Metro bundle is recorded and warned about.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

test("export of a bundle with no Metro module registrations records no-metro-modules and warns", () => {
  const root = repoRoot();
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-no-metro-"));
  try {
    const out = join(dir, "out");
    const plain = join(root, "tests", "fixtures", "constructs", "500-try-ladder-deep", "v96.hbc");
    const r = spawnSync(process.execPath, [join(root, "src", "cli.ts"), "export", plain, "--out", out], { encoding: "utf8", timeout: 300_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /registers no Metro modules/);
    const m = JSON.parse(readFileSync(join(out, "EXPORT.json"), "utf8")) as { unresolved: { kind: string }[] };
    assert.ok(m.unresolved.some((u) => u.kind === "no-metro-modules"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
