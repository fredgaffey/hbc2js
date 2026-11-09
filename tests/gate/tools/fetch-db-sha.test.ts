// tools/pkgsig/fetch-db.sh: local-archive source + HBC2JS_SIGDB_SHA256 check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("fetch-db.sh: sha256 mismatch refuses, match unpacks", () => {
  const root = mkdtempSync(join(tmpdir(), "fetchdb-"));
  try {
    const src = join(root, "src"); mkdirSync(src);
    writeFileSync(join(src, "a@1.0.0__hbc99.json"), JSON.stringify({ schema: 2, package: "a", version: "1.0.0", hbcVersion: 99, functions: [], modules: [], subtractedBaselines: ["_baselines/x.json"] }));
    const ar = join(root, "t.tar.gz");
    assert.equal(spawnSync("tar", ["-czf", ar, "-C", src, "."]).status, 0);
    const sha = createHash("sha256").update(readFileSync(ar)).digest("hex");
    const run = (dest: string, h: string) => spawnSync("bash", ["tools/pkgsig/fetch-db.sh", dest], { env: { ...process.env, HBC2JS_SIGDB_SOURCE: ar, HBC2JS_SIGDB_SHA256: h }, encoding: "utf8" });
    const bad = run(join(root, "d1"), "0".repeat(64));
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /sha256 mismatch/);
    const ok = run(join(root, "d2"), sha);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(readdirSync(join(root, "d2")).some((n) => n.startsWith("a@1.0.0")) || readdirSync(join(root, "d2", "_rejected-unsubtracted")).length > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
