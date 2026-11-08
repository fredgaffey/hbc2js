// deps-recall-nosig: build-one.mjs bundled only `require(<pkg>)`. A package
// with no root entry (`@babel/runtime`: no `main`, no `exports["."]`) failed
// every build ("main module field that could not be resolved"), and a package
// the app reaches through sub-paths (`semver/functions/*`, `nanoid/non-secure`,
// `promise/setimmediate`) got a signature of files the app never contains.
// entryPlan (tools/pkgsig/bulk/install-plan.mjs) now lists the package's
// `exports` sub-paths too. Offline, synthetic package dirs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error untyped .mjs
import { entryPlan, entrySource } from "../../../tools/pkgsig/bulk/install-plan.mjs";

function pkgDir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "entryplan-"));
  for (const [f, s] of Object.entries(files)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), s); }
  return d;
}

test("deps-recall-nosig: no root entry -> exports sub-paths only (explicit and * patterns), no root require", () => {
  const d = pkgDir({
    "package.json": JSON.stringify({ name: "@x/rt", exports: { "./helpers/a": [{ node: "./helpers/a.js" }, "./helpers/a.js"], "./regen": "./regen/index.js", "./helpers/esm/*": "./helpers/esm/*.js", "./package.json": "./package.json" } }),
    "helpers/a.js": "", "regen/index.js": "", "helpers/esm/b.js": "", "helpers/esm/c.js": "",
  });
  try {
    const p = entryPlan("@x/rt", d);
    assert.equal(p.root, false);
    assert.deepEqual(p.attempts, [["@x/rt/helpers/a", "@x/rt/regen", "@x/rt/helpers/esm/b", "@x/rt/helpers/esm/c"]]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("deps-recall-nosig: root entry + sub-paths first, root alone as fallback", () => {
  const d = pkgDir({
    "package.json": JSON.stringify({ name: "nano", main: "index.cjs", exports: { ".": { require: "./index.cjs" }, "./non-secure": { require: "./non-secure/index.cjs" }, "./missing": "./nope.js" } }),
    "index.cjs": "", "non-secure/index.cjs": "",
  });
  try {
    const p = entryPlan("nano", d);
    assert.equal(p.root, true);
    assert.deepEqual(p.attempts, [["nano", "nano/non-secure"], ["nano"]]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("deps-recall-nosig: plain main without exports is unchanged (one attempt, root only)", () => {
  const d = pkgDir({ "package.json": JSON.stringify({ name: "plain", main: "lib/x" }), "lib/x.js": "" });
  try { assert.deepEqual(entryPlan("plain", d).attempts, [["plain"]]); } finally { rmSync(d, { recursive: true, force: true }); }
  const e = pkgDir({ "package.json": JSON.stringify({ name: "idx" }), "index.js": "" });
  try { assert.deepEqual(entryPlan("idx", e).attempts, [["idx"]]); } finally { rmSync(e, { recursive: true, force: true }); }
});

test("deps-recall-nosig: entry source requires each specifier; build-one uses the plan", () => {
  assert.equal(entrySource(["a", "a/b"]), 'module.exports = [require("a"), require("a/b")];\n');
  const src = readFileSync(new URL("../../../tools/pkgsig/bulk/build-one.mjs", import.meta.url), "utf8");
  assert.ok(/entryPlan\(/.test(src) && /entrySource\(/.test(src));
});

test("deps-recall-nosig: a non-string main (math-intrinsics) does not throw", () => {
  const d = pkgDir({ "package.json": JSON.stringify({ name: "mi", main: false, exports: { "./abs": "./abs.js" } }), "abs.js": "", "index.js": "" });
  try { assert.deepEqual(entryPlan("mi", d).attempts, [["mi", "mi/abs"], ["mi"]]); } finally { rmSync(d, { recursive: true, force: true }); }
});

// deps-recall-nosig (slot poisoning): building a package the scaffold already
// has (`@react-native/assets-registry`, a react-native dependency) ran
// `npm uninstall` afterwards and removed it from the shared slot, so every
// later job in that slot failed ("Unable to resolve module
// @react-native/assets-registry/registry"). A pre-existing package is now
// snapshotted before install and restored instead of uninstalled.
// @ts-expect-error untyped .mjs
import { snapshotScaffoldPackage } from "../../../tools/pkgsig/bulk/install-plan.mjs";

test("deps-recall-nosig: a scaffold-owned package is restored, not uninstalled", () => {
  const d = pkgDir({ "node_modules/@rn/reg/package.json": '{"version":"0.87.1"}', "node_modules/@rn/reg/registry.js": "orig" });
  try {
    const restore = snapshotScaffoldPackage(d, "@rn/reg");
    assert.equal(typeof restore, "function");
    rmSync(join(d, "node_modules/@rn/reg"), { recursive: true });
    mkdirSync(join(d, "node_modules/@rn/reg"));
    writeFileSync(join(d, "node_modules/@rn/reg/package.json"), '{"version":"0.86.0"}');
    restore();
    assert.equal(readFileSync(join(d, "node_modules/@rn/reg/package.json"), "utf8"), '{"version":"0.87.1"}');
    assert.equal(readFileSync(join(d, "node_modules/@rn/reg/registry.js"), "utf8"), "orig");
    assert.equal(snapshotScaffoldPackage(d, "absent-pkg"), null, "absent package: caller uninstalls as before");
  } finally { rmSync(d, { recursive: true, force: true }); }
  const src = readFileSync(new URL("../../../tools/pkgsig/bulk/build-one.mjs", import.meta.url), "utf8");
  assert.ok(/snapshotScaffoldPackage\(/.test(src));
});
