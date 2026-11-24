// tests/gate/app-fuzz/app-fuzz-gen.test.ts — tools/app-fuzz/ (decompiler-
// hostile app fuzzer, tools/app-fuzz/README.md): the shape generator is
// deterministic, every template is reachable, parts are independent (what
// minimisation relies on), generated code runs in Node to a uint32 for every
// function on two tiny seeds, and the coverage-guided weights favour shapes
// associated with rare features.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateShapes, planShapes, renderFunction, TEMPLATE_NAMES, DEFAULT_WEIGHTS } from "../../../tools/app-fuzz/gen-shapes.mjs";
import { guidedWeights, seedConfig } from "../../../tools/app-fuzz/loop.mjs";

const digest = (files: [string, string][]) => createHash("sha256").update(JSON.stringify(files)).digest("hex");

test("app-fuzz gen: same seed byte-identical, different seed differs, configs deterministic", () => {
  assert.equal(digest(generateShapes("a", 12).files), digest(generateShapes("a", 12).files));
  assert.notEqual(digest(generateShapes("b", 12).files), digest(generateShapes("a", 12).files));
  assert.deepEqual(seedConfig(5, "hard"), seedConfig(5, "hard"));
});

test("app-fuzz gen: every template is reachable and parts render independently", () => {
  const seen = new Set(planShapes("cov", 400).flatMap((f) => f.parts.map((p) => p.t)));
  assert.deepEqual([...seen].sort(), [...TEMPLATE_NAMES].sort());
  const f = planShapes("ind", 1, { size: 3 })[0]!;
  assert.ok(f.parts.length >= 3);
  const full = renderFunction(f.name, f.parts).src;
  const dropped = renderFunction(f.name, f.parts.slice(1)).src;
  // The last part's text is identical whether or not part 0 is present.
  const k = f.parts.length - 1;
  const tail = (src: string) => src.slice(src.indexOf(`// part ${k}:`));
  assert.equal(tail(full), tail(dropped));
});

test("app-fuzz gen: two tiny seeds run in Node, every function returns a uint32", () => {
  const dir = mkdtempSync(join(tmpdir(), "appfuzz-gen-"));
  try {
    for (const seed of ["t1", "t2"]) {
      const out = join(dir, seed);
      for (const [p, c] of generateShapes(seed, 16, { size: 1.5 }).files) {
        mkdirSync(dirname(join(out, p)), { recursive: true });
        writeFileSync(join(out, p), c);
      }
      writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
      const script = `import { JUNK_MODULES } from ${JSON.stringify(pathToFileURL(join(out, "src/junk/index.js")).href)};
import { entryArg } from ${JSON.stringify(pathToFileURL(join(out, "src/junk/_rt.js")).href)};
const bad = []; let n = 0;
for (const ns of Object.values(JUNK_MODULES)) for (const [k, f] of Object.entries(ns)) { const v = f(entryArg(k)); n++; if (v !== v >>> 0) bad.push(k); }
console.log(JSON.stringify({ n, bad }));`;
      writeFileSync(join(out, "run.mjs"), script);
      const r = spawnSync(process.execPath, [join(out, "run.mjs")], { encoding: "utf8", timeout: 20000 });
      assert.equal(r.status, 0, r.stderr);
      const got = JSON.parse(r.stdout.trim());
      assert.equal(got.n, 16);
      assert.deepEqual(got.bad, []);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("app-fuzz loop: guided weights boost shapes seen with rare features", () => {
  assert.deepEqual(guidedWeights({ seeds: 0, feature: {}, assoc: {} }), DEFAULT_WEIGHTS);
  const assoc: Record<string, Record<string, number>> = {};
  for (const t of TEMPLATE_NAMES) assoc[t] = { "#modules": 10, "tier:passes": 10 };
  assoc["labelled"] = { "#modules": 10, "tier:passes": 10, "fail:wrong-value": 4 };
  const w = guidedWeights({ seeds: 10, feature: { "tier:passes": 100, "fail:wrong-value": 4 }, assoc });
  assert.ok(w["labelled"]! > w["spread"]!, JSON.stringify(w));
});
