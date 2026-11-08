// CONFPOOL1: `--confirm-jobs N` worker pool. N scratch RN projects (copies of
// the scaffold), candidates distributed across them, results merged in
// candidate order, identical to serial. Stubbed npm/npx, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHermesc } from "../../support/hermesc.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { confirmCandidates } from "../../../src/deps/confirm.ts";

const STUB_HEAD = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const ev = (k) => fs.appendFileSync(process.env.HBC2JS_TEST_EVENT_LOG, JSON.stringify({ t: Date.now(), k, cwd: process.cwd(), tool: TOOL }) + "\\n");
const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
`;
const FAKE_NPM = `${STUB_HEAD.replace("TOOL", '"npm"')}
if (args[0] === "install") {
  ev("start"); nap();
  const spec = args.filter((a) => !a.startsWith("--")).pop();
  const pkg = spec.slice(0, spec.lastIndexOf("@"));
  if (pkg.includes("failme")) { ev("end"); process.exit(1); }
  const destDir = join(process.cwd(), "node_modules", ...pkg.split("/"));
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(process.env.HBC2JS_TEST_FAKE_PKG_DIR, destDir, { recursive: true });
  ev("end");
}
process.exit(0);
`;
const FAKE_NPX = `${STUB_HEAD.replace("TOOL", '"npx"')}
ev("start"); nap();
const outPath = args[args.indexOf("--bundle-output") + 1];
fs.writeFileSync(outPath, process.env.HBC2JS_TEST_FAKE_BUNDLE_JS || "");
ev("end");
process.exit(0);
`;

const CANNED_SOURCE = `
function __d(factory, moduleId, deps) {}
__d(function (global, require, importDefault, exportAll, module, exports, dependencyMap) {
  var total = 0;
  for (var i = 0; i < 37; i++) { total = total + i * 3 - (i % 5) + (i > 10 ? 2 : 1); }
  module.exports = total;
}, 0, []);
__d(function (global, require, importDefault, exportAll, module, exports, dependencyMap) {
  var s = "";
  for (var j = 0; j < 29; j++) { s = s + String.fromCharCode(65 + (j % 26)); }
  module.exports = s;
}, 1, []);
__d(function (global, require, importDefault, exportAll, module, exports, dependencyMap) {
  var arr = [];
  for (var k = 0; k < 41; k++) { arr.push(k * k - k + 7, k + 1); }
  module.exports = arr;
}, 2, []);
`;

test("CONFPOOL1: N=3 uses 3 scratch dirs, never overlaps installs per dir, equals N=1, isolates failures", async (t) => {
  const hermesc = requireHermesc(t, 94);
  if (hermesc === null) return;
  const work = mkdtempSync(join(tmpdir(), "hbc2js-confpool-"));
  const binDir = join(work, "bin");
  const fakePkgDir = join(work, "fake-pkg");
  const evLog = join(work, "events.log");
  const originalPath = process.env.PATH;
  try {
    mkdirSync(binDir, { recursive: true });
    for (const [n, s] of [["npm", FAKE_NPM], ["npx", FAKE_NPX]] as const) { writeFileSync(join(binDir, n), s); chmodSync(join(binDir, n), 0o755); }
    process.env.PATH = `${binDir}:${originalPath}`;
    mkdirSync(fakePkgDir, { recursive: true });
    writeFileSync(join(fakePkgDir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    process.env.HBC2JS_TEST_FAKE_PKG_DIR = fakePkgDir;
    process.env.HBC2JS_TEST_FAKE_BUNDLE_JS = CANNED_SOURCE;
    process.env.HBC2JS_TEST_EVENT_LOG = evLog;
    const hbc = join(work, "t.hbc");
    execFileSync(hermesc.path, ["-O", "-emit-binary", `-out=${hbc}`, "-"], { input: CANNED_SOURCE });
    const target = buildInventory(readFileSync(hbc)).inventory;
    const cands = ["pkg-a", "pkg-b", "pkg-failme", "pkg-d", "pkg-e", "pkg-f"].map((p) => ({ package: p, version: "1.0.0" }));

    const run = async (name: string, jobs: number) => {
      const scratch = join(work, name, "scratch");
      mkdirSync(join(scratch, "node_modules", "react-native"), { recursive: true });
      writeFileSync(join(scratch, "node_modules", "react-native", "package.json"), JSON.stringify({ name: "react-native", version: "0.0.0-test" }));
      const projectDbDir = join(work, name, "p");
      writeFileSync(evLog, "");
      const results = await confirmCandidates(cands, target, {
        scratchProjectDir: scratch, rnVersion: "0.0.0-test", hbcVersion: 94, hermescPath: hermesc.path, rateLimitMs: 0,
        referenceDate: "2026-08-26T00:00:00.000Z", projectDbDir, fingerprintCacheDir: join(work, name, "fp"), jobs,
      } as Parameters<typeof confirmCandidates>[2]);
      const events = readFileSync(evLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: number; k: string; cwd: string; tool: string });
      const sigs = readdirSync(projectDbDir).filter((f) => f.endsWith(".json")).sort().map((f) => readFileSync(join(projectDbDir, f), "utf8").replace(/"builtAt":"[^"]*"/, ""));
      const norm = results.map((r) => JSON.parse(JSON.stringify(r, (k, v) => (k === "writtenTo" ? undefined : v))));
      return { events, sigs, norm };
    };

    const serial = await run("n1", 1);
    const pooled = await run("n3", 3);

    // (a) 3 distinct dirs, no two installs/builds overlapping in the same dir
    const dirs = new Set(pooled.events.map((e) => e.cwd));
    assert.equal(dirs.size, 3, `expected 3 scratch dirs, saw ${[...dirs].join(", ")}`);
    const open = new Map<string, number>();
    for (const e of pooled.events) {
      const n = (open.get(e.cwd) ?? 0) + (e.k === "start" ? 1 : -1);
      open.set(e.cwd, n);
      assert.ok(n <= 1, `two concurrent ${e.tool} calls in ${e.cwd}`);
    }
    let maxConc = 0, cur = 0;
    for (const e of pooled.events) { cur += e.k === "start" ? 1 : -1; maxConc = Math.max(maxConc, cur); }
    assert.ok(maxConc >= 2, "workers actually run concurrently");
    assert.equal(new Set(serial.events.map((e) => e.cwd)).size, 1, "N=1 uses the single scratch dir");

    // (b) identical to serial, in candidate order
    assert.deepEqual(pooled.norm.map((r: { candidate: { package: string } }) => r.candidate.package), cands.map((c) => c.package));
    assert.deepEqual(pooled.norm, serial.norm);
    assert.deepEqual(pooled.sigs, serial.sigs);

    // (c) the failing candidate fails alone
    const ok = pooled.norm.map((r: { ok: boolean }) => r.ok);
    assert.deepEqual(ok, [true, true, false, true, true, true]);
  } finally {
    process.env.PATH = originalPath;
    for (const k of ["HBC2JS_TEST_FAKE_PKG_DIR", "HBC2JS_TEST_FAKE_BUNDLE_JS", "HBC2JS_TEST_EVENT_LOG"]) delete process.env[k];
    rmSync(work, { recursive: true, force: true });
  }
});
