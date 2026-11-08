// corpus-B1: a bundle entry > 64 MiB overflowed readZipEntry's maxBuffer and
// surfaced as "could not read it". corpus-B5: a Hermes bundle named
// assets/<x>.bundle (not index.*) was not a candidate at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractBundleFromApk, pickApkBundleCandidates } from "../../../src/deps/apk.ts";

const MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);
const haveZip = () => spawnSync("zip", ["-v"], { stdio: "ignore" }).status === 0 && spawnSync("unzip", ["-v"], { stdio: "ignore" }).status === 0;

function makeApk(files: Record<string, Buffer>): { dir: string; apk: string } {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-corpus-apk-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b);
  const z = spawnSync("zip", ["-r", "-X", "t.apk", "assets"], { cwd: dir, encoding: "utf8" });
  assert.equal(z.status, 0, z.stderr);
  return { dir, apk: join(dir, "t.apk") };
}

test("corpus-B1: extractBundleFromApk reads a bundle entry larger than 64 MiB", (t) => {
  if (!haveZip()) return t.skip("zip/unzip not on PATH");
  const size = 70 * 1024 * 1024;
  const body = Buffer.alloc(size);
  MAGIC.copy(body);
  const { dir, apk } = makeApk({ "assets/index.android.bundle": body });
  try {
    const r = extractBundleFromApk(apk);
    assert.equal(r.bytes.length, size);
    assert.equal(r.isHermes, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corpus-B5: pickApkBundleCandidates includes custom-named assets/*.bundle", () => {
  const c = pickApkBundleCandidates(["assets/kernel.android.bundle", "assets/x.txt"]);
  assert.deepEqual(c, ["assets/kernel.android.bundle"]);
});

test("corpus-B5: extractBundleFromApk finds assets/kernel.android.bundle", (t) => {
  if (!haveZip()) return t.skip("zip/unzip not on PATH");
  const { dir, apk } = makeApk({ "assets/kernel.android.bundle": Buffer.concat([MAGIC, Buffer.alloc(8)]) });
  try {
    assert.equal(extractBundleFromApk(apk).entryPath, "assets/kernel.android.bundle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
