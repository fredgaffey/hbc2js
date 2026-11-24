// docs/BUGS.md 2026-11-24, cluster export:orphan-multisite-closure-not-emitted
// (a bare RN app booted DIVERGENT: `ReferenceError: Property '_fn30532'
// doesn't exist` at module eval).
//
// A capture-free function created from CreateClosure sites in several
// functions has no single home, so it stays an orphan and the whole-file
// render hoists it to top level. The export renders each module scoped to its
// factory's subtree, so the orphan's declaration was in NO module file and the
// files only listed it as "declared by parents not shown here".
//
// Fixture 490 (v98/v99 inline the predicate's creator into three functions in
// two modules): export it, run the tree's registry + module files under a
// Hermes VM, and compare with the fixture's expected output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoRoot } from "../../support/paths.ts";
import { findHermesVm } from "../../support/hermesvm.ts";
import { exportProject } from "../../../src/export/index.ts";

const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "490-orphan-multisite-closure");

/** A tiny CommonJS linker over the export file map: every file becomes a
 *  function(require, module, exports) keyed by its path; `require` resolves
 *  relative paths. The driver reads module 1 through the registry, exactly as
 *  the fixture's own global code does. */
function linkTree(files: ReadonlyMap<string, string>): string {
  const parts: string[] = ["var __files = {};"];
  for (const [path, text] of files) {
    if (!path.endsWith(".js") || !path.startsWith("src/")) continue;
    parts.push(`__files[${JSON.stringify(path)}] = function (require, module, exports) {\n${text}\n};`);
  }
  parts.push(`
var __cache = {};
function __resolve(from, rel) {
  var out = from.split("/"); out.pop();
  rel.split("/").forEach(function (seg) { if (seg === "..") out.pop(); else if (seg !== ".") out.push(seg); });
  return out.join("/");
}
function __load(path) {
  if (__cache[path]) return __cache[path].exports;
  var fn = __files[path];
  if (fn === undefined) throw new Error("no file " + path);
  var mod = { exports: {} };
  __cache[path] = mod;
  fn(function (rel) { return __load(__resolve(path, rel)); }, mod, mod.exports);
  return mod.exports;
}
__load("src/_hbc/helpers.js");
var __hbc = __load("src/_hbc/registry.js");
for (var p in __files) if (/module_\\d+\\.js$/.test(p)) __load(p);
var m1 = __hbc.r(1);
print(m1.count);
print(m1.both([1, 2]));
print(m1.both(["x", 3]));
`);
  return parts.join("\n");
}

for (const v of [98, 99] as const) {
  test(`orphan multi-site closure: the v${v} export declares the orphan in every module that names it`, async (t) => {
    const vm = findHermesVm(96);
    if (vm === null) return t.skip("no Hermes VM (tools/hermes-vm)");
    const r = await exportProject(join(FIXTURE, `v${v}.hbc`), { substitute: "none", workers: 1 });
    const modules = [...r.files.entries()].filter(([p]) => /module_\d+\.js$/.test(p));
    assert.equal(modules.length, 2);
    for (const [p, text] of modules) assert.doesNotMatch(text, /declared by parents not shown here/, `${p} names an undeclared function`);
    const dir = mkdtempSync(join(tmpdir(), "hbc2js-orphan-ms-"));
    try {
      const js = join(dir, "run.js");
      writeFileSync(js, linkTree(r.files));
      const out = execFileSync(vm.path, [js], { encoding: "utf8" });
      assert.equal(out, readFileSync(join(FIXTURE, "expected.txt"), "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The flat `--split` text (the export's fallback tier) used to give a shared
// orphan to the FIRST module that named it and leave every later one with a
// dangling reference.
for (const v of [98, 99] as const) {
  test(`orphan multi-site closure: every v${v} --split module file that names the orphan declares it`, async () => {
    const { splitProject } = await import("../../../src/split/index.ts");
    const r = splitProject(new Uint8Array(readFileSync(join(FIXTURE, `v${v}.hbc`))), { moduleName: `v${v}.hbc` });
    assert.equal(r.modules.length, 2);
    for (const m of r.modules) {
      const text = r.files.get(m.file)!;
      for (const ref of new Set([...text.matchAll(/\b(_fn\d+)\b/g)].map((x) => x[1]!))) {
        if (/^_fn(\d+)$/.test(ref) && ref === `_fn${m.factoryFunctionIndex}`) continue;
        assert.match(text, new RegExp(`function ${ref}\\(`), `${m.file} names ${ref} without declaring it`);
      }
    }
  });
}
