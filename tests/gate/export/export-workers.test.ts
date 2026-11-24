// The export render pool (src/export/render-pool.ts) must not change a byte:
// `hbc2js export` with one render thread (the serial main-thread path) and
// with several (the pool, which hands the main thread's env graph to workers)
// write identical trees. EXPORT.json's `ts` timestamp is the only field that
// legitimately differs between two runs and is masked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLI, cleanup, walk } from "./support.ts";
import { repoRoot } from "../../support/paths.ts";

const BUNDLE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

function exportWith(workers: number): { out: string; stderr: string } {
  const out = join(mkdtempSync(join(tmpdir(), "hbc2js-export-workers-")), "out");
  const r = spawnSync(process.execPath, [CLI, "export", BUNDLE, "--out", out], {
    encoding: "utf8",
    env: { ...process.env, HBC2JS_WORKERS: String(workers) },
    timeout: 600_000,
  });
  assert.equal(r.status, 0, `export (workers=${workers}) failed: ${r.stderr}`);
  return { out, stderr: r.stderr };
}

function tree(out: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const rel of walk(out)) {
    let text = readFileSync(join(out, rel), "utf8");
    if (rel === "EXPORT.json") text = text.replace(/^ {4}"ts": ".*",$/m, '    "ts": "<masked>",');
    files.set(rel, text);
  }
  return files;
}

test("export: workers=1 and workers=3 write byte-identical trees (rn-template-0.72)", () => {
  const serial = exportWith(1);
  const pooled = exportWith(3);
  try {
    assert.doesNotMatch(serial.stderr, /worker thread/, "workers=1 must take the serial main-thread path");
    assert.match(pooled.stderr, /on 3 worker thread\(s\)/, "workers=3 must use the render pool");
    const a = tree(serial.out);
    const b = tree(pooled.out);
    assert.deepEqual([...b.keys()].sort(), [...a.keys()].sort());
    for (const [rel, text] of a) assert.equal(b.get(rel), text, `${rel} differs between workers=1 and workers=3`);
    assert.ok(a.size > 400, `expected a full tree, got ${a.size} files`);
  } finally {
    cleanup(dirname(serial.out));
    cleanup(dirname(pooled.out));
  }
});
