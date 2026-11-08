// CONFSPEED1: --confirm per-candidate cost. Two levers, both verdict-neutral:
// (1) Metro runs WITHOUT --reset-cache (measured: 10-18 s -> 2-5 s per
// candidate; the transform cache is content-keyed), (2) the raw fingerprint
// of a built candidate is cached on disk keyed by package@version + hbc +
// hash scheme + RN version, so a second run (even against another target)
// performs zero npm/npx invocations. Stubbed npm/npx, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHermesc } from "../../support/hermesc.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { confirmCandidates } from "../../../src/deps/confirm.ts";
import type { ConfirmSuccess } from "../../../src/deps/confirm.ts";

const FAKE_NPM = `#!/usr/bin/env node
"use strict";
const { mkdirSync, cpSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
require("node:fs").appendFileSync(process.env.HBC2JS_TEST_CALL_LOG, "npm " + args.join(" ") + "\\n");
if (args[0] === "install") {
  const spec = args.filter((a) => !a.startsWith("--")).pop();
  if (spec) {
    const pkg = spec.slice(0, spec.lastIndexOf("@"));
    const destDir = join(process.cwd(), "node_modules", ...pkg.split("/"));
    mkdirSync(destDir, { recursive: true });
    cpSync(process.env.HBC2JS_TEST_FAKE_PKG_DIR, destDir, { recursive: true });
  }
}
process.exit(0);
`;

const FAKE_NPX = `#!/usr/bin/env node
"use strict";
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
require("node:fs").appendFileSync(process.env.HBC2JS_TEST_CALL_LOG, "npx " + args.join(" ") + "\\n");
const outIdx = args.indexOf("--bundle-output");
const outPath = args[outIdx + 1];
writeFileSync(outPath, process.env.HBC2JS_TEST_FAKE_BUNDLE_JS || "");
process.exit(0);
`;

// Three substantial (>= 8 real instructions), distinct `__d()` module
// registrations — `moduleExactHits >= 3` alone clears "high" tier
// (docs/DEPS.md's confidence-tier table) regardless of package size, so
// compiling this same source twice (once for the "target", once standing in
// for the "candidate" package's own Metro bundle) deterministically
// reproduces a real, independently-verified high-confidence match without
// depending on any committed fixture or the network.
const CANNED_SOURCE = `
function __d(factory, moduleId, deps) {}
__d(function (global, require, importDefault, exportAll, module, exports, dependencyMap) {
  var total = 0;
  for (var i = 0; i < 37; i++) {
    total = total + i * 3 - (i % 5) + (i > 10 ? 2 : 1);
  }
  module.exports = total;
}, 0, []);
__d(function (global, require, importDefault, exportAll, module, exports, dependencyMap) {
  var s = "";
  for (var j = 0; j < 29; j++) {
    s = s + String.fromCharCode(65 + (j % 26));
  }
  module.exports = s;
}, 1, []);
__d(function (global, require, importDefault, exportAll, module, exports, dependencyMap) {
  var arr = [];
  for (var k = 0; k < 41; k++) {
    arr.push(k * k - k + 7, k + 1);
  }
  module.exports = arr;
}, 2, []);
`;


test("CONFSPEED1: no --reset-cache, and a second confirm of the same candidate performs zero builds with identical signature", async (t) => {
  const hermesc = requireHermesc(t, 94);
  if (hermesc === null) return;
  const work = mkdtempSync(join(tmpdir(), "hbc2js-confspeed-"));
  const binDir = join(work, "bin");
  const fakePkgDir = join(work, "fake-pkg");
  const scratch = join(work, "scratch");
  const log = join(work, "calls.log");
  const originalPath = process.env.PATH;
  const mk = (n: string) => ({ projectDbDir: join(work, n, "p"), userCacheDbDir: join(work, "user-cache", "sigdb") });
  try {
    mkdirSync(binDir, { recursive: true });
    for (const [n, s] of [["npm", FAKE_NPM], ["npx", FAKE_NPX]] as const) { writeFileSync(join(binDir, n), s); chmodSync(join(binDir, n), 0o755); }
    process.env.PATH = `${binDir}:${originalPath}`;
    mkdirSync(fakePkgDir, { recursive: true });
    writeFileSync(join(fakePkgDir, "package.json"), JSON.stringify({ name: "some-fake-pkg", version: "9.9.9" }));
    process.env.HBC2JS_TEST_FAKE_PKG_DIR = fakePkgDir;
    process.env.HBC2JS_TEST_FAKE_BUNDLE_JS = CANNED_SOURCE;
    process.env.HBC2JS_TEST_CALL_LOG = log;
    writeFileSync(log, "");
    mkdirSync(join(scratch, "node_modules", "react-native"), { recursive: true });
    writeFileSync(join(scratch, "node_modules", "react-native", "package.json"), JSON.stringify({ name: "react-native", version: "0.0.0-test" }));
    const hbc = join(work, "t.hbc");
    execFileSync(hermesc.path, ["-O", "-emit-binary", `-out=${hbc}`, "-"], { input: CANNED_SOURCE });
    const target = buildInventory(readFileSync(hbc)).inventory;
    const base = { scratchProjectDir: scratch, rnVersion: "0.0.0-test", hbcVersion: 94, hermescPath: hermesc.path, rateLimitMs: 0, referenceDate: "2026-08-26T00:00:00.000Z" };
    const cands = [{ package: "some-fake-pkg", version: "9.9.9" }];

    const r1 = await confirmCandidates(cands, target, { ...base, ...mk("a") });
    const calls1 = readFileSync(log, "utf8").split("\n").filter(Boolean);
    assert.ok(calls1.some((l) => l.startsWith("npx ")), "first run builds");
    assert.ok(calls1.every((l) => !l.includes("--reset-cache")), "Metro must not be told to reset its cache");

    writeFileSync(log, "");
    const r2 = await confirmCandidates(cands, target, { ...base, ...mk("b") });
    assert.equal(readFileSync(log, "utf8"), "", "second run: zero npm/npx invocations");
    assert.equal(r1[0]!.ok && r2[0]!.ok, true);
    const s1 = r1[0] as ConfirmSuccess, s2 = r2[0] as ConfirmSuccess;
    assert.deepEqual(s2.score, s1.score, "cached path yields the identical score");
    const sig = (d: string) => readFileSync(join(d, readdirSync(d).filter((f) => f.endsWith(".json"))[0]!), "utf8").replace(/"builtAt":"[^"]*"/, "");
    assert.equal(sig(mk("b").projectDbDir), sig(mk("a").projectDbDir), "identical written signature");
  } finally {
    process.env.PATH = originalPath;
    for (const k of ["HBC2JS_TEST_FAKE_PKG_DIR", "HBC2JS_TEST_FAKE_BUNDLE_JS", "HBC2JS_TEST_CALL_LOG"]) delete process.env[k];
    rmSync(work, { recursive: true, force: true });
  }
});
