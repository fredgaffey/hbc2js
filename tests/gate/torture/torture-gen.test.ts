// tests/gate/torture/torture-gen.test.ts — tools/torture/ (torture-app
// benchmark, tools/torture/README.md): the seeded junk generator is
// deterministic, emits only bounded pure computation, every generated
// function terminates in Node with a uint32 checksum, the headless harness
// (what build.mjs uses for the manifest truth) agrees with a direct call of
// every export, and the build's module-id truth parser reads Metro's layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../support/paths.ts";
import { generateJunk, entryArg, type JunkResult } from "../../../tools/torture/gen-junk.mjs";
import { metroModuleIds } from "../../../tools/torture/build.mjs";

const N = 50;
type Gen = JunkResult;
const digest = (g: Gen) => createHash("sha256").update(JSON.stringify(g.files)).digest("hex");

test("gen-junk: same seed is byte-identical, different seed differs", () => {
  const a: Gen = generateJunk("1", N);
  const b: Gen = generateJunk("1", N);
  assert.equal(digest(a), digest(b));
  assert.equal(a.functions.length, N);
  assert.notEqual(digest(generateJunk("2", N)), digest(a));
});

test("gen-junk: only bounded pure computation, callees form a DAG by level", () => {
  const g: Gen = generateJunk("1", N);
  // _rt.js is the fixed hand-written runtime (loops bounded by its callers' constants).
  const src = g.files.filter(([rel]) => rel !== "src/junk/_rt.js").map(([, c]) => c).join("\n");
  for (const bad of [/\beval\b/, /\bFunction\s*\(/, /\brequire\s*\(/, /\bimport\s*\(/, /\bfetch\b/, /setTimeout|setInterval/, /while\s*\(\s*true/, /\bfor\s*\(\s*;/]) {
    assert.doesNotMatch(src, bad, `generated junk must not contain ${bad}`);
  }
  for (const m of src.matchAll(/for \(let (\w+) = 0; (\w+) < (\d+);/g)) assert.equal(m[1], m[2]);
  assert.equal((src.match(/for \(let /g) || []).length, (src.match(/for \(let \w+ = 0; \w+ < \d+; \w+\+\+\)/g) || []).length, "every counted for-loop has a constant bound");
  for (const m of src.matchAll(/while \((\w+) < (\d+) &&/g)) assert.ok(Number(m[2]) <= 5, "while loops are counter-bounded");
  const level = new Map(g.functions.map((f) => [f.name, f.level]));
  for (const f of g.functions) for (const c of f.callees) assert.ok(level.get(c)! < f.level, `${f.name} -> ${c} must go down a level`);
});

test("gen-junk: every function terminates in Node and the headless harness agrees with direct calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-torture-"));
  try {
    const g: Gen = generateJunk("1", N);
    for (const [rel, content] of g.files) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    const app = join(repoRoot(), "tools/torture/app");
    cpSync(join(app, "src/core"), join(dir, "src/core"), { recursive: true });
    cpSync(join(app, "headless.js"), join(dir, "headless.js"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
    const r = spawnSync(process.execPath, [join(dir, "headless.js")], { cwd: dir, timeout: 60_000, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
    for (const [name, v] of Object.entries(out.core)) assert.doesNotMatch(String(v), /^THREW:/, `core ${name}`);
    assert.equal(Object.keys(out.core).length, 28);
    assert.equal(Object.keys(out.junk).length, N);
    for (const f of g.functions) {
      const ns = await import(pathToFileURL(join(dir, f.module)).href);
      const v = ns[f.name](entryArg(f.name));
      assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff, `${f.name} returns a uint32`);
      assert.equal(out.junk[`${f.module}#${f.name}`], v, `${f.name}: headless == direct`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build: metroModuleIds maps __d chunks to sources in bundle order", () => {
  const bundle = [
    "var __BUNDLE_START_TIME__=0;",
    "__d(function (g, r, i, a, m, e, d) {", "  m.exports = 1;", "},0,[1]);",
    "__d(function (g, r, i, a, m, e, d) {", "  m.exports = 2;", "},7,[]);",
    "__r(0);",
  ].join("\n");
  const ws = "/ws";
  const map = { sources: ["__prelude__", "/ws/node_modules/metro-runtime/src/polyfills/require.js", "/ws/index.js", "/ws/node_modules/@scope/pkg/lib/x.js"] };
  assert.deepEqual(metroModuleIds(bundle, map, ws), { 0: "index.js", 7: "node_modules/@scope/pkg/lib/x.js" });
});

test("gen-junk --hard: opt-in, deterministic, default bytes unchanged, safe, every function terminates in Node", async () => {
  const plain: Gen = generateJunk("1", N);
  const a: Gen = generateJunk("1", N, { hard: true });
  assert.equal(digest(a), digest(generateJunk("1", N, { hard: true })));
  assert.notEqual(digest(a), digest(plain));
  assert.ok(a.functions.length > N && a.functions.some((f) => f.form === "async"), "hard adds async leaves");
  const src = a.files.filter(([rel]) => rel !== "src/junk/_rt.js").map(([, c]) => c).join("\n");
  for (const bad of [/\beval\b/, /\bFunction\s*\(/, /\brequire\s*\(/, /\bimport\s*\(/, /\bfetch\b/, /setTimeout|setInterval/, /while\s*\(\s*true/, /\bfor\s*\(\s*;/]) {
    assert.doesNotMatch(src, bad, `hard junk must not contain ${bad}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-torture-hard-"));
  try {
    for (const [rel, content] of a.files) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
    for (const f of a.functions) {
      const ns = await import(pathToFileURL(join(dir, f.module)).href);
      const v = await ns[f.name](entryArg(f.name));
      assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff, `${f.name} returns a uint32`);
      assert.equal(await ns[f.name](entryArg(f.name)), v, `${f.name} is deterministic`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
