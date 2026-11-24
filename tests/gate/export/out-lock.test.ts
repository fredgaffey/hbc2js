// Two `hbc2js export` runs into the same --out must not interleave their
// writes: the second fails fast on the sibling lock file, a lock left by a
// dead process is taken over, and `export --help` prints the export verb's
// own help (benchmark findings, 2026-11-24).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { CLI, cleanup } from "./support.ts";
import { acquireOutLock, lockPathFor, OutLockHeldError } from "../../../src/util/out-lock.ts";

test("out lock: a held lock refuses a second taker; release frees it", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-out-lock-"));
  try {
    const out = join(dir, "out");
    const a = acquireOutLock(out, "hbc2js export");
    assert.equal(a.path, lockPathFor(out));
    assert.ok(existsSync(a.path));
    assert.throws(() => acquireOutLock(out, "hbc2js export"), (e: unknown) => e instanceof OutLockHeldError && /another hbc2js export \(pid \d+\) is writing/.test(e.message));
    a.release();
    assert.ok(!existsSync(a.path));
    acquireOutLock(out, "hbc2js export").release();
  } finally {
    cleanup(dir);
  }
});

test("out lock: a lock whose pid is gone is stale and taken over", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-out-lock-"));
  try {
    const out = join(dir, "out");
    // A pid that cannot be running: one past the largest Linux/macOS pid.
    writeFileSync(lockPathFor(out), JSON.stringify({ pid: 4194305, host: hostname(), verb: "hbc2js export" }));
    const l = acquireOutLock(out, "hbc2js export");
    l.release();
  } finally {
    cleanup(dir);
  }
});

test("export CLI: a held --out lock fails fast with a clear message", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-out-lock-"));
  try {
    const out = join(dir, "out");
    const held = acquireOutLock(out, "hbc2js export");
    try {
      const r = spawnSync(process.execPath, [CLI, "export", join(dir, "missing.hbc"), "--out", out], { encoding: "utf8", timeout: 60_000 });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /hbc2js export: another hbc2js export \(pid \d+\) is writing .*out; wait for it to finish, or delete .*out\.hbc2js\.lock/);
    } finally {
      held.release();
    }
  } finally {
    cleanup(dir);
  }
});

test("export CLI: --help prints the export verb's help, not the global usage", () => {
  const r = spawnSync(process.execPath, [CLI, "export", "--help"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage: hbc2js export <bundle\.hbc> --out <dir>/);
  for (const flag of ["--overwrite", "--tier", "--substitute", "--deps-report", "--app-name", "--rn-version", "--instrument=modules", "--json"]) assert.ok(r.stdout.includes(flag), `help lists ${flag}`);
  assert.doesNotMatch(r.stdout, /hbc2js disasm/);
});
