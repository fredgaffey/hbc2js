#!/usr/bin/env node
// Network-free, build-free, no `src/**` touched (only pure functions) --
// runnable in isolation:
//   node tools/pkgsig/bulk/test-dep-subtract.mjs
//
// Exit code 0 = all assertions passed, 1 = failure (message on stderr).

import { mergeDependencyFields, resolveDependencyVersion, subtractDependencySignatures, topoSortPackages } from "./dep-subtract.mjs";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`ok: ${msg}`);
  }
}

function fn(exactHash, index = 0) {
  return { index, name: "f", paramCount: 0, instrCount: 1, exactHash, fuzzyHash: exactHash, stringSetHash: exactHash, stringCount: 0 };
}

function mod(factoryExactHash, localModuleId) {
  return { factoryFunctionIndex: localModuleId, localModuleId, depCount: 0, depIds: [], factoryExactHash, factoryFuzzyHash: factoryExactHash, nestedFunctionCount: 0, functionSetHash: factoryExactHash, factoryIsBaseline: false };
}

function testSubtractDependencySignatures() {
  // Reproduces the real contamination this fix targets: `stack`'s raw
  // fingerprint (post-baseline-subtraction) contains its own code
  // (hash "own1", module 0) PLUS every function `@react-navigation/native`
  // contributes (hash "native1", module 1) -- module 1's factory hash is
  // in native's own (already-subtracted) function set.
  const rawFunctions = [fn("own1", 0), fn("native1", 1)];
  const rawModules = [mod("own1", 0), mod("native1", 1)];
  const nativeHashes = new Set(["native1"]);

  const { functions, modules, removedCount } = subtractDependencySignatures(rawFunctions, rawModules, [{ key: "@react-navigation/native@8.0.0-alpha.44__hbc98.json", hashes: nativeHashes }]);

  assert(functions.length === 1, `own function survives, dependency's is removed (got ${functions.length})`);
  assert(functions[0].exactHash === "own1", "the surviving function is stack's own");
  assert(removedCount === 1, `removedCount reports exactly 1 removed function (got ${removedCount})`);

  const flags = modules.map((m) => m.factoryIsDependency);
  assert(JSON.stringify(flags) === JSON.stringify([false, true]), `factoryIsDependency flags computed correctly (got ${JSON.stringify(flags)})`);
  // Module 1 (native's) is KEPT in the module graph (same rule as
  // factoryIsBaseline -- the __d() anchoring must stay complete) even
  // though its function was removed.
  assert(modules.length === 2, "module graph stays complete (dependency modules are flagged, not dropped)");
}

function testSubtractMultipleDependencies() {
  const rawFunctions = [fn("own1"), fn("depA1"), fn("depB1")];
  const rawModules = [mod("own1", 0), mod("depA1", 1), mod("depB1", 2)];
  const { functions, removedCount } = subtractDependencySignatures(rawFunctions, rawModules, [
    { key: "depA@1.0.0__hbc98.json", hashes: new Set(["depA1"]) },
    { key: "depB@1.0.0__hbc98.json", hashes: new Set(["depB1"]) },
  ]);
  assert(functions.length === 1 && functions[0].exactHash === "own1", "both dependencies' functions removed, own survives");
  assert(removedCount === 2, `removedCount sums across dependencies (got ${removedCount})`);
}

function testSubtractNoDependencies() {
  const rawFunctions = [fn("own1")];
  const rawModules = [mod("own1", 0)];
  const { functions, modules, removedCount } = subtractDependencySignatures(rawFunctions, rawModules, []);
  assert(functions.length === 1 && removedCount === 0, "no-op when a package has no in-DB dependencies");
  assert(modules[0].factoryIsDependency === false, "factoryIsDependency defaults false");
}

function testResolveDependencyVersion() {
  const got = resolveDependencyVersion("^6.0.0", ["5.9.0", "6.0.0", "6.1.0", "7.0.0"]);
  assert(got === "6.1.0", `picks the max version satisfying the range (got ${got})`);

  const none = resolveDependencyVersion("^9.0.0", ["5.9.0", "6.0.0"]);
  assert(none === null, `no satisfying version -> null (got ${none})`);

  const exact = resolveDependencyVersion("8.0.0-alpha.44", ["8.0.0-alpha.34", "8.0.0-alpha.44"]);
  assert(exact === "8.0.0-alpha.44", `an exact-pin range (common for prerelease react-navigation packages) matches itself (got ${exact})`);
}

function testTopoSortPackages() {
  // stack depends on native; native depends on nothing (in-DB terms).
  const order = topoSortPackages({
    "@react-navigation/stack@6.4.1": ["@react-navigation/native@6.1.18"],
    "@react-navigation/native@6.1.18": [],
  });
  assert(order.indexOf("@react-navigation/native@6.1.18") < order.indexOf("@react-navigation/stack@6.4.1"), `dependency processed before dependent (order: ${order.join(", ")})`);
  assert(order.length === 2, "every node visited exactly once");

  // A cycle (rare, e.g. mutual peer deps) must not throw or infinite-loop;
  // every node is still visited exactly once.
  const cyclic = topoSortPackages({ A: ["B"], B: ["A"] });
  assert(cyclic.length === 2 && new Set(cyclic).size === 2, `a cycle is broken, not thrown (got ${JSON.stringify(cyclic)})`);
}

function testMergeDependencyFieldsIncludesPeerDeps() {
  // Real case, verified against the live npm registry (2026-09-29):
  // @react-navigation/stack@8.0.0-alpha.53's `dependencies` field alone is
  // {use-latest-callback, @react-navigation/elements} -- NOT
  // @react-navigation/native. `native` is a `peerDependencies` entry
  // ("@react-navigation/native": "^8.0.0-alpha.44"). This is the actual
  // mechanism behind the brief's headline contamination example (stack's
  // raw fingerprint containing native's own modules): Metro bundles a
  // resolved peer dependency exactly like a regular one. A subtraction
  // pass that only reads `dependencies` misses this -- the dominant real
  // case, not a hypothetical edge case.
  const doc = {
    dependencies: { "use-latest-callback": "^0.3.5", "@react-navigation/elements": "^3.0.0-alpha.48" },
    peerDependencies: { "@react-navigation/native": "^8.0.0-alpha.44", "react-native-screens": ">= 4.25.0" },
  };
  const merged = mergeDependencyFields(doc);
  assert(merged["@react-navigation/native"] === "^8.0.0-alpha.44", "peerDependencies' @react-navigation/native is included");
  assert(merged["use-latest-callback"] === "^0.3.5", "regular dependencies are still included");
  assert(Object.keys(merged).length === 4, `exactly the union of both fields' distinct names (got ${Object.keys(merged).length})`);
}

testMergeDependencyFieldsIncludesPeerDeps();
testSubtractDependencySignatures();
testSubtractMultipleDependencies();
testSubtractNoDependencies();
testResolveDependencyVersion();
testTopoSortPackages();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed");
