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
import { BOOT_HEAP_BYTES_PER_BUNDLE_BYTE, heapLimitFor } from "../../../src/util/heap-reexec.ts";
import { initialWorkerEstimate, planRenderWorkers } from "../../../src/export/render-pool.ts";

const BUNDLE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

function exportWith(workers: number, extraEnv: Record<string, string> = {}): { out: string; stderr: string } {
  const out = join(mkdtempSync(join(tmpdir(), "hbc2js-export-workers-")), "out");
  const r = spawnSync(process.execPath, [CLI, "export", BUNDLE, "--out", out], {
    encoding: "utf8",
    env: { ...process.env, HBC2JS_WORKERS: String(workers), ...extraEnv },
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

test("export: modules split into function-level jobs render byte-identically (rn-template-0.72, workers=3)", () => {
  const serial = exportWith(1);
  // Thresholds lowered so this small bundle's larger modules are split into
  // nested-subtree jobs and assembled (spec 29 §12).
  const split = exportWith(3, { HBC2JS_SPLIT_MIN_COST: "4000", HBC2JS_SPLIT_MIN_PART: "100" });
  try {
    assert.match(split.stderr, /splitting \d+ large module\(s\) into \d+ function-level jobs/, "expected modules split into function-level jobs");
    const a = tree(serial.out);
    const b = tree(split.out);
    assert.deepEqual([...b.keys()].sort(), [...a.keys()].sort());
    for (const [rel, text] of a) assert.equal(b.get(rel), text, `${rel} differs between workers=1 and the function-level split`);
  } finally {
    cleanup(dirname(serial.out));
    cleanup(dirname(split.out));
  }
});

test("export heap bound: re-run only when the bundle needs more than the current limit, capped by RAM", () => {
  const GB = 2 ** 30;
  // A 4.4 MB bundle fits the ~4 GB default: no re-run.
  assert.equal(heapLimitFor(4.4e6, 4144, 32 * GB), null);
  // A 45.6 MB (~99k-function) bundle wants ~10.9 GB.
  assert.equal(heapLimitFor(45.6e6, 4144, 32 * GB), Math.ceil((45.6e6 * 250) / 2 ** 20));
  // ...but never more than 75% of physical memory.
  assert.equal(heapLimitFor(45.6e6, 4144, 8 * GB), 6144);
  // A user-raised limit already big enough: no re-run.
  assert.equal(heapLimitFor(45.6e6, 16000, 32 * GB), null);
});

test("render worker plan: defaults fit half of RAM less the main thread; explicit counts are used as given", () => {
  const GB = 2 ** 30;
  const saved = process.env.HBC2JS_WORKERS;
  delete process.env.HBC2JS_WORKERS;
  try {
    // A 16 GB, 10-core laptop, 13.8k-function / 4.4 MB app, main thread at
    // 1.8 GB: 8 workers (cores - 2), within a 6.2 GB worker budget.
    const laptop = planRenderWorkers(undefined, 13_800, 4.4e6, { total: 16 * GB, mainRss: 1.8 * GB, cpus: 10 });
    assert.equal(laptop.count, 8);
    assert.equal(laptop.budget, 6.2 * GB);
    assert.ok(laptop.count * initialWorkerEstimate(4.4e6) <= laptop.budget!);
    // The 99k-function / 45.6 MB app on the same laptop, main at 6 GB:
    // memory, not cores, sets the starting count.
    const big = planRenderWorkers(undefined, 99_000, 45.6e6, { total: 16 * GB, mainRss: 6 * GB, cpus: 10 });
    assert.equal(big.limitedBy, "memory");
    assert.equal(big.count, Math.floor((2 * GB) / initialWorkerEstimate(45.6e6)) || 1);
    // Small bundles render serially; an explicit count is never resized.
    assert.equal(planRenderWorkers(undefined, 5000, 1e6, { total: 16 * GB, mainRss: GB, cpus: 10 }).count, 1);
    const explicit = planRenderWorkers(5, 99_000, 45.6e6, { total: 16 * GB, mainRss: 6 * GB, cpus: 10 });
    assert.deepEqual(explicit, { count: 5, limitedBy: null, budget: null, max: 5 });
  } finally {
    if (saved !== undefined) process.env.HBC2JS_WORKERS = saved;
  }
});

// 0.1.2 corpus a02: `equiv --boot` on a 10.4 MB / 48.7k-function bundle OOMed
// in the harness's own process at Node's default heap. Export's planning
// (250 B/B) would not re-run for it; the boot harness's share does.
test("heap planning: equiv --boot re-runs a 10.4 MB bundle with a bigger heap where export would not", () => {
  const GB = 2 ** 30;
  const a02 = 10_384_892;
  assert.equal(heapLimitFor(a02, 4144, 32 * GB), null, "export: the default suffices");
  const boot = heapLimitFor(a02, 4144, 32 * GB, BOOT_HEAP_BYTES_PER_BUNDLE_BYTE);
  assert.ok(boot !== null && boot >= 7000, `boot plan ${boot} MB`);
  assert.equal(heapLimitFor(a02, 4144, 8 * GB, BOOT_HEAP_BYTES_PER_BUNDLE_BYTE), 6144, "still capped at 75% of RAM");
  assert.equal(heapLimitFor(1_160_116, 4144, 32 * GB, BOOT_HEAP_BYTES_PER_BUNDLE_BYTE), null, "small apps run in-process");
});
