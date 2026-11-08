// bugs-2026-11-09-sigpaths-tmp-leak: the path-rebuild job (transplant-multi /
// transplant-paths) leaked one `sigpaths-*` dir per job under os.tmpdir()
// (6,977 dirs / 20 GB on a live rebuild). The work dir must be removed on
// success, on a bundler failure, on a per-file failure, and a dir orphaned by
// a killed (SIGKILL/timeout) job must be swept by the next job. Stubbed
// bundler, private TMPDIR, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs tool with a .d.mts sibling
import { runBundleJob, sweepStaleWorkDirs } from "../../../tools/pkgsig/bulk/transplant-lib.mjs";

function leftovers(root: string): string[] {
  return readdirSync(root).filter((n) => n.startsWith("sigpaths-"));
}

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "sigpaths-test-root-"));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("bugs-2026-11-09-sigpaths-tmp-leak: no sigpaths-* after success", () => {
  withRoot((root) => {
    let seen = "";
    const res = runBundleJob(["a__hbc98.json", "b__hbc99.json"], {
      install() {},
      bundle(work: string) { seen = work; writeFileSync(join(work, "out.bundle"), "x"); mkdirSync(join(work, "assets")); return {}; },
      perFile() { return { ok: true }; },
    }, { tmpRoot: root });
    assert.ok(seen.startsWith(join(root, "sigpaths-")));
    assert.deepEqual(res.map((r: { ok: boolean }) => r.ok), [true, true]);
    assert.deepEqual(leftovers(root), []);
  });
});

test("bugs-2026-11-09-sigpaths-tmp-leak: no sigpaths-* after a forced bundler failure or per-file failure", () => {
  withRoot((root) => {
    const bad = runBundleJob(["a__hbc98.json"], {
      install() {},
      bundle(work: string) { writeFileSync(join(work, "partial"), "x"); throw new Error("metro exploded"); },
      perFile() { return {}; },
    }, { tmpRoot: root });
    assert.equal(bad[0].ok, false);
    assert.match(String(bad[0].reason), /^bundle: .*metro exploded/);
    const bad2 = runBundleJob(["a__hbc98.json"], {
      install() {},
      bundle() { return {}; },
      perFile() { throw new Error("hermesc failed"); },
    }, { tmpRoot: root });
    assert.match(String(bad2[0].reason), /hermesc failed/);
    const bad3 = runBundleJob(["a__hbc98.json"], {
      install() { throw new Error("npm install failed"); },
      bundle() { return {}; },
      perFile() { return {}; },
    }, { tmpRoot: root });
    assert.match(String(bad3[0].reason), /npm install failed/);
    assert.deepEqual(leftovers(root), []);
  });
});

test("bugs-2026-11-09-sigpaths-tmp-leak: a killed job's orphan is swept; live and legacy dirs are not", () => {
  withRoot((root) => {
    const dead = join(root, "sigpaths-2147483646-abc123");
    const live = join(root, `sigpaths-${String(process.pid)}-live`);
    const legacy = join(root, "sigpaths-Xy12Zq");
    for (const d of [dead, live, legacy]) { mkdirSync(d); writeFileSync(join(d, "f"), "x"); }
    assert.equal(sweepStaleWorkDirs(root), 1);
    assert.ok(!existsSync(dead));
    assert.ok(existsSync(live) && existsSync(legacy));
    runBundleJob([], { install() {}, bundle() { return {}; }, perFile() { return {}; } }, { tmpRoot: root });
    assert.ok(existsSync(live) && existsSync(legacy));
  });
});
