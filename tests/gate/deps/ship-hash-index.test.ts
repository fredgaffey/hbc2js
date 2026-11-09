// Shipping the candidate hash index with the signature DB (sigdb-ship-hash-index):
// validator checks, sqlite sidecar layout, missing-index hint, fetch-db unpack,
// finalize.sh dry run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDb } from "../../../tools/pkgsig/ship/validate-path-db.mjs";
import { HASH_INDEX_MAGIC, hashIndexFileName, hashIndexHint, proposeFromHashIndex } from "../../../src/deps/hash-index.ts";

const sig = (pkg: string, extra: object = {}) => JSON.stringify({ schema: 2, hashScheme: 2, package: pkg, version: "1.0.0", hbcVersion: 99, modulePaths: 1, modules: [], functions: [], ...extra });
const idx = (packages: string[]) => `${HASH_INDEX_MAGIC}${JSON.stringify({ hbcVersion: 99, minInstr: 8, maxOwners: 1, packages })}\nabc\t0\n`;
const tmp = () => mkdtempSync(join(tmpdir(), "shiphi-"));

test("ship-hash-index: validator checks index files (parse, known packages, stale)", () => {
  const root = tmp();
  try {
    writeFileSync(join(root, "a@1.0.0__hbc99.json"), sig("a"));
    // no index: ok, reported as absent
    assert.deepEqual(validateDb(root).hashIndex, { files: [], warnings: [] });
    writeFileSync(join(root, hashIndexFileName(99)), idx(["a"]));
    const t = Date.now() / 1000 + 100;
    utimesSync(join(root, hashIndexFileName(99)), t, t);
    const ok = validateDb(root);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.hashIndex.files, [hashIndexFileName(99)]);
    assert.deepEqual(ok.hashIndex.warnings, []);
    // stale: index older than newest signature
    utimesSync(join(root, hashIndexFileName(99)), 1000, 1000);
    const stale = validateDb(root);
    assert.equal(stale.ok, true);
    assert.match(stale.hashIndex.warnings.join("|"), /stale/);
    // unknown package + unparseable
    writeFileSync(join(root, hashIndexFileName(99)), idx(["a", "ghost"]));
    writeFileSync(join(root, hashIndexFileName(98)), "garbage\n");
    const bad = validateDb(root);
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join("|"), /ghost/);
    assert.match(bad.errors.join("|"), /hbc98\.tsv.*unparseable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ship-index: index beside sigdb.sqlite (dir layer or .sqlite path) is read; none falls back gracefully", () => {
  const root = tmp();
  try {
    writeFileSync(join(root, "sigdb.sqlite"), "");
    writeFileSync(join(root, hashIndexFileName(99)), idx(["a"]));
    const inv = { hbcVersion: 99, functions: [{ instrCount: 20, exactHash: "abc" }] } as never;
    const dirLayer = [{ name: "shared", dir: root }] as never;
    const fileLayer = [{ name: "shared", dir: join(root, "sigdb.sqlite") }] as never;
    assert.deepEqual([...proposeFromHashIndex(dirLayer, inv, { minHits: 1, minCoverage: 0 })], ["a"]);
    assert.deepEqual([...proposeFromHashIndex(fileLayer, inv, { minHits: 1, minCoverage: 0 })], ["a"]);
    const empty = join(root, "empty"); mkdirSync(empty); writeFileSync(join(empty, "x.sqlite"), "");
    assert.deepEqual([...proposeFromHashIndex([{ name: "shared", dir: join(empty, "x.sqlite") }] as never, inv)], []);
    assert.match(hashIndexHint([{ name: "shared", dir: join(empty, "x.sqlite") }] as never, 99) ?? "", /build-candidate-hash-index\.mjs/);
    assert.equal(hashIndexHint(dirLayer, 99), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ship-hash-index: fetch-db.sh keeps .tsv files in place", () => {
  const root = tmp();
  try {
    const src = join(root, "src"); mkdirSync(src);
    writeFileSync(join(src, "a@1.0.0__hbc99.json"), sig("a", { subtractedBaselines: ["_baselines/x.json"] }));
    writeFileSync(join(src, hashIndexFileName(99)), idx(["a"]));
    const ar = join(root, "t.tar.gz");
    assert.equal(spawnSync("tar", ["-czf", ar, "-C", src, "."]).status, 0);
    const r = spawnSync("bash", ["tools/pkgsig/fetch-db.sh", join(root, "d")], { env: { ...process.env, HBC2JS_SIGDB_SOURCE: ar }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readdirSync(join(root, "d")).includes(hashIndexFileName(99)), r.stdout);
    assert.equal(readFileSync(join(root, "d", hashIndexFileName(99)), "utf8"), idx(["a"]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ship-hash-index: finalize.sh dry run builds the index into staging, tarball and SHA256SUMS", () => {
  const root = tmp();
  try {
    const src = join(root, "src"), out = join(root, "out"), stage = join(root, "stage");
    mkdirSync(src); mkdirSync(out);
    const fns = Array.from({ length: 4 }, (_, i) => ({ index: i, exactHash: `h${i}`, instrCount: 20, moduleId: 0 }));
    for (const d of [src, out]) writeFileSync(join(d, "a@1.0.0__hbc99.json"), sig("a", { modulePaths: d === out ? 1 : 0, modules: [{ localModuleId: 0, path: "a/i.js" }], functions: fns }));
    const r = spawnSync("bash", ["tools/pkgsig/ship/finalize.sh"], { env: { ...process.env, SRC: src, OUT: out, STAGE: stage, SAMPLE: "5", TAG: "sigdb-v4-test" }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const n = hashIndexFileName(99);
    assert.ok(existsSync(join(stage, "db", n)), "index in staging db");
    assert.match(readFileSync(join(stage, "dist", "SHA256SUMS"), "utf8"), new RegExp(n.replace(/\./g, "\\.")));
    const ls = spawnSync("sh", ["-c", `tar -tzf ${stage}/dist/sigdb-*.tar.gz 2>/dev/null || tar --zstd -tf ${stage}/dist/sigdb-*.tar.zst`], { encoding: "utf8" });
    assert.match(ls.stdout, /candidate-hash-index__hbc99\.tsv/);
    assert.match(ls.stdout, /a@1\.0\.0__hbc99\.json/, "tarball keeps the signature files too (bsdtar portability)");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
