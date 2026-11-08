// deps-closure-ownership (docs/BUGS.md "A module's function set is its direct
// closures only", corpus-residual-fp diagnosis): the target-side module
// inventory gave a module only the closures its factory creates DIRECTLY,
// so on a real app ~37% of functions belonged to no module. Ownership now
// follows the closure-creation graph transitively (shared walker with
// `SigFunction.moduleId`). Signature-side stored fields (`SigModule`
// `nestedFunctionIndices` / `nestedFunctionCount` / `functionSetHash`,
// `SigFunction.moduleId`) must not change: they are DB contents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHermesc } from "../../support/hermesc.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { fingerprintModule } from "../../../src/deps/fingerprint.ts";
import { attachModulePaths } from "../../../src/deps/module-paths.ts";
import { closureOwnership } from "../../../src/deps/closure-owner.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { parseHbc } from "../../../src/parse/module.ts";

const FN = "function (global, require, importDefault, exportAll, module, exports, dependencyMap)";
const JS = [
  "function __d(factory, moduleId, deps) {}",
  // Created by the global function, outside any factory: stays unowned.
  "function topHelper(a) { return function topInner(b) { return a + b; }; }",
  "globalThis.th = topHelper;",
  `__d(${FN} {
    function outer(x) { return function middle(y) { return function inner(z) { return x + y + z; }; }; }
    // Babel-compiled class shape: constructor + prototype/static methods inside an IIFE.
    var Widget = (function makeClass() { function Widget(n) { this.n = n; } Widget.prototype.grow = function grow(k) { return this.n * k; }; Widget.make = function make() { return new Widget(1); }; return Widget; })();
    var api = { ping: function ping() { return 1; }, pong() { return 2; }, get size() { return 3; } };
    function* gen() { yield 1; }
    async function later() { return 4; }
    module.exports = { outer: outer, Widget: Widget, api: api, gen: gen, later: later };
  },0,[]);`,
  `__d(${FN} { module.exports = function other(q) { return function otherInner() { return q; }; }; },1,[]);`,
].join("\n") + "\n";

const OWNED_BY_0 = ["makeClass", "outer", "middle", "inner", "Widget", "grow", "make", "ping", "pong", "size", "gen", "later"];

function compile(hermesc: string, js: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-closure-owner-"));
  try {
    execFileSync(hermesc, ["-O", "-emit-binary", `-out=${join(dir, "o.hbc")}`, "-"], { input: js });
    return new Uint8Array(readFileSync(join(dir, "o.hbc")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("deps-closure-ownership: every closure a factory creates, at any depth, belongs to its module", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const { module: mod, inventory } = buildInventory(compile(h.path, JS));
  const m0 = inventory.modules.find((m) => m.localModuleId === 0)!;
  const m1 = inventory.modules.find((m) => m.localModuleId === 1)!;
  const names = (idx: readonly number[]) => new Set(idx.map((i) => inventory.functions[i]!.name));
  const own0 = names(m0.functionIndices);
  for (const n of OWNED_BY_0) assert.ok([...own0].some((x) => x === n || x.endsWith(n)), `${n} should be owned by module 0, got ${[...own0].join(",")}`);
  assert.deepEqual([...names(m1.functionIndices)].sort(), ["", "other", "otherInner"]);
  // Top-level helpers created by `global` stay unowned.
  for (const m of inventory.modules) for (const n of ["topHelper", "topInner", "global"]) assert.ok(!names(m.functionIndices).has(n), `${n} must stay unowned`);
  const owned = new Set(inventory.modules.flatMap((m) => m.functionIndices));
  assert.equal(inventory.moduledFunctionCount, owned.size);
  assert.equal(inventory.unownedFunctionCount, inventory.totalFunctions - owned.size);
  assert.equal(inventory.ambiguousFunctionCount, 0);
  void mod;
});

test("deps-closure-ownership: signature-side stored fields are unchanged (direct closures; moduleId first-wins)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const mod = parseHbc(compile(h.path, JS));
  const fp = fingerprintModule(mod, decodeFunction);
  const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 24);
  for (const m of fp.modules) {
    const direct: number[] = [];
    for (const insn of decodeFunction(mod, m.factoryFunctionIndex).instructions) for (const op of insn.operands) if (op.role === "function" && !direct.includes(op.value) && op.value !== m.factoryFunctionIndex) direct.push(op.value);
    assert.deepEqual(m.nestedFunctionIndices, direct, "SigModule.nestedFunctionIndices stays direct-only");
    assert.equal(m.nestedFunctionCount, direct.length);
    const hashes = [m.factoryFunctionIndex, ...direct].map((i) => fp.functions[i]!.exactHash).sort();
    assert.equal(m.functionSetHash, sha(hashes.join("\n")), "SigModule.functionSetHash stays over factory + direct closures");
  }
  const { functions } = attachModulePaths(mod, decodeFunction, fp.functions, fp.modules, new Map());
  const inner = functions.find((f) => f.name === "inner")!;
  assert.equal(inner.moduleId, 0);
  assert.equal(functions.find((f) => f.name === "topInner")!.moduleId, undefined);
});

test("deps-closure-ownership: a function reached from two modules is ambiguous (inventory) or first-wins (signature moduleId)", () => {
  // 0 = global creates factories 1 and 2; 3 is reachable from both; 4 only via 3; 5 only from 2.
  const graph: Record<number, number[]> = { 0: [1, 2, 6], 1: [3], 2: [3, 5, 1], 3: [4], 4: [], 5: [], 6: [7], 7: [] };
  const children = (i: number) => graph[i] ?? [];
  const amb = closureOwnership([1, 2], children, "ambiguous");
  assert.deepEqual([...amb.owner.entries()].sort((a, b) => a[0] - b[0]), [[1, 1], [2, 2], [5, 2]]);
  assert.deepEqual([...amb.ambiguous].sort(), [3, 4]);
  const first = closureOwnership([1, 2], children, "first");
  assert.deepEqual([...first.owner.entries()].sort((a, b) => a[0] - b[0]), [[1, 1], [2, 2], [3, 1], [4, 1], [5, 2]]);
  assert.equal(first.ambiguous.size, 0);
});
