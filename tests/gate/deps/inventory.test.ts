// docs/DECISIONS.md D17a point 1 — module inventory: enumerate Metro
// `__d(fn, id, deps)` registrations structurally (dscan.ts), never by
// decompiling everything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { repoRoot } from "../../support/paths.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

test("buildInventory recovers rn-template-0.72's full __d() module graph", () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const { inventory } = buildInventory(bytes);

  assert.equal(inventory.hbcVersion, 94);
  // docs/PACKAGE-SIGNATURES.md §5.6: 435 Metro modules in this exact fixture.
  assert.equal(inventory.modules.length, 435);
  assert.ok(inventory.totalFunctions > inventory.modules.length, "expects nested closures beyond one function per module");
  assert.ok(inventory.moduledFunctionCount > 0);
  assert.ok(inventory.moduledFunctionCount <= inventory.totalFunctions);

  // Every module has a resolved local id and a real (non-negative) dep count
  // for this fixture — Metro always emits a static deps array here.
  for (const m of inventory.modules) {
    assert.notEqual(m.localModuleId, null, `module at factory fn ${m.factoryFunctionIndex} has no resolved local id`);
    assert.notEqual(m.depCount, null, `module ${m.localModuleId} has no resolved dep count`);
  }

  // At least one module's function set carries real string-constant evidence
  // (guess.ts and report.ts both depend on this being populated).
  const withStrings = inventory.modules.filter((m) => m.stringConstants.length > 0);
  assert.ok(withStrings.length > 100, `expected most of 435 modules to carry string constants, got ${withStrings.length}`);

  // Dependency edges are real Metro module ids, not function indices — every
  // id referenced should itself be some module's own localModuleId (Metro
  // never leaves a dangling reference in a large bundle).
  const knownIds = new Set(inventory.modules.map((m) => m.localModuleId));
  let sawNonEmptyDeps = false;
  for (const m of inventory.modules) {
    for (const dep of m.depIds ?? []) {
      sawNonEmptyDeps = true;
      assert.ok(knownIds.has(dep), `module ${m.localModuleId} depends on unknown module id ${dep}`);
    }
  }
  assert.ok(sawNonEmptyDeps, "expected at least one module with a non-empty deps array");
});

test("buildInventory is deterministic across repeated calls", () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const a = buildInventory(bytes).inventory;
  const b = buildInventory(bytes).inventory;
  assert.deepEqual(
    a.modules.map((m) => m.exactHash),
    b.modules.map((m) => m.exactHash),
  );
});

function wrapAsModule(source: string): string {
  return `__d(function(global, require, importDefault, importAll, module, exports, dependencyMap) {\n${source}\n}, 0, []);`;
}

test("fuzzyHashSet distinguishes two modules whose factory is identical but nested closure differs", (t) => {
  const hermesc = findHermesc(99);
  if (hermesc === null) {
    t.skip("hermesc v99 not found (run tools/get-hermesc.sh 99)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-inventory-fuzzyset-test-"));
  try {
    // Same shape as the seams T5 fixture (tests/fixtures/tooling/seams/rn/
    // Libraries/Utilities/Toast.{ios,android}.js): the factory is just
    // `module.exports = function Toast(msg) {...}` — a CreateClosure + PutById
    // — and the interesting body lives in the nested closure `Toast`.
    const sourceA = "module.exports = function Toast(msg) {\n  return 'toast:' + msg + '!';\n};";
    const sourceB = "module.exports = function Toast(msg) {\n  if (msg) {\n    return 'TOAST[' + msg + ']';\n  }\n  return 'TOAST[]';\n};";

    const compile = (name: string, source: string) => {
      const srcPath = join(dir, `${name}.js`);
      writeFileSync(srcPath, wrapAsModule(source), "utf8");
      const outPath = join(dir, `${name}.hbc`);
      const r = runHermesc(hermesc, ["-O", "-emit-binary", `-out=${outPath}`, `${name}.js`], dir);
      assert.equal(r.status, 0, `hermesc failed: ${r.stderr}`);
      return buildInventory(new Uint8Array(readFileSync(outPath))).inventory;
    };

    const invA = compile("a", sourceA);
    const invB = compile("b", sourceB);
    assert.equal(invA.modules.length, 1);
    assert.equal(invB.modules.length, 1);
    const a = invA.modules[0]!;
    const b = invB.modules[0]!;

    // The trap: factory-only hashes are equal — the factory bytecode
    // (CreateClosure + PutById) is byte-identical either way.
    assert.equal(a.exactHash, b.exactHash, "factory-only exactHash expected equal (the trap this test pins)");
    assert.equal(a.fuzzyHash, b.fuzzyHash, "factory-only fuzzyHash expected equal (the trap this test pins)");
    assert.equal(a.factoryOnly, true);
    assert.equal(b.factoryOnly, true);

    // The fix: whole-set fields must differ.
    assert.notEqual(a.stringSetHash, b.stringSetHash, "functionSetHash (whole set, exact tier) must differ");
    assert.notEqual(a.fuzzyHashSet, b.fuzzyHashSet, "fuzzyHashSet (whole set, fuzzy tier) must differ");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
