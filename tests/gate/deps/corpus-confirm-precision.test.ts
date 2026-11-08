// corpus-confirm-precision (corpus block C2, 2026-11-08): real-world
// `deps --confirm` added false positives and no recall. On one corpus app
// confirm raised unique packages 72 -> 209, the additions being generic-name
// 1-3-module packages (`focus`, `atob`, `i`, `name`, `count`, ...), and the
// run wrote every confirm-built signature back into the shared `--sigdb`
// directory it was scoring against. Mechanism and rule: docs/DEPS.md
// "Confirm minimum evidence". All fixtures here are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { confirmMinimumEvidence, CONFIRM_MIN_FACTORY_INSTR } from "../../../src/deps/confirm.ts";
import { confirmWriteTargets } from "../../../src/deps/index.ts";
import type { ModuleInventory } from "../../../src/deps/inventory.ts";
import type { SigDbFile, SigFunction, SigModule } from "../../../src/deps/sigdb-types.ts";

function fn(index: number, hash: string, instrCount: number): SigFunction {
  return { index, name: `f${index}`, paramCount: 1, instrCount, exactHash: hash, fuzzyHash: `z${hash}`, stringSetHash: "s", stringCount: 0 };
}
function mod(factoryFunctionIndex: number, hash: string): SigModule {
  return { factoryFunctionIndex, localModuleId: factoryFunctionIndex, depCount: 0, depIds: [], factoryExactHash: hash, factoryFuzzyHash: `z${hash}`, nestedFunctionCount: 0, functionSetHash: `fs${hash}`, factoryIsBaseline: false };
}
/** A candidate signature whose modules have the given factory (hash, instrCount). */
function sig(pkg: string, factories: readonly (readonly [string, number])[]): SigDbFile {
  const functions = factories.map(([h, n], i) => fn(i, h, n));
  return {
    schema: 2,
    hashScheme: 2,
    package: pkg,
    version: "1.0.0",
    hbcVersion: 94,
    totalFunctions: functions.length,
    rawFunctionCount: functions.length,
    subtractedBaselines: [],
    functions,
    modules: functions.map((f) => mod(f.index, f.exactHash)),
    toolchainBaseline: false,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: 94, hermescRnEra: null, repoCommit: null, builtAt: "2026-11-08T00:00:00.000Z" },
  } as SigDbFile;
}
function target(hashes: readonly string[]): ModuleInventory {
  const functions = hashes.map((h, i) => fn(i, h, 40));
  return { hbcVersion: 94, totalFunctions: functions.length, moduledFunctionCount: functions.length, modules: [], functions };
}

const BIG = CONFIRM_MIN_FACTORY_INSTR + 20;

test("corpus-confirm-precision: a medium-tier confirm (one module hit of a 2-module generic-name package) is not confirmed", () => {
  const s = sig("name", [["h1", BIG], ["h2", BIG]]);
  const v = confirmMinimumEvidence({ tier: "medium" }, s, target(["h1", "x"]), { corroborated: false });
  assert.equal(v.ok, false, JSON.stringify(v));
});

test("corpus-confirm-precision: high tier carried only by trivial factories (below the instruction floor) is not confirmed", () => {
  const s = sig("atob", [["t1", 4], ["t2", 5], ["t3", 6]]);
  const v = confirmMinimumEvidence({ tier: "high" }, s, target(["t1", "t2", "t3"]), { corroborated: false });
  assert.equal(v.ok, false, JSON.stringify(v));
  assert.equal(v.ownModuleHits, 0);
});

test("corpus-confirm-precision: hits on target modules already owned by another package (candidate's dependency tree) do not count", () => {
  const s = sig("focus", [["d1", BIG], ["d2", BIG], ["d3", BIG], ["own", BIG]]);
  const v = confirmMinimumEvidence({ tier: "high" }, s, target(["d1", "d2", "d3"]), { corroborated: false, ownedTargetFactoryHashes: new Set(["d1", "d2", "d3"]) });
  assert.equal(v.ok, false, JSON.stringify(v));
  assert.equal(v.ownModuleHits, 0);
});

test("corpus-confirm-precision: three sizeable, unowned module hits at high tier still confirm", () => {
  const s = sig("real-lib", [["a", BIG], ["b", BIG], ["c", BIG], ["d", BIG]]);
  const v = confirmMinimumEvidence({ tier: "high" }, s, target(["a", "b", "c"]), { corroborated: false, ownedTargetFactoryHashes: new Set(["zz"]) });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.ownModuleHits, 3);
});

test("corpus-confirm-precision: one or two sizeable hits need corroborating evidence (native-module / url-host / name@version)", () => {
  const s = sig("tiny-real", [["a", BIG], ["b", BIG]]);
  const t = target(["a", "b"]);
  assert.equal(confirmMinimumEvidence({ tier: "high" }, s, t, { corroborated: false }).ok, false);
  assert.equal(confirmMinimumEvidence({ tier: "high" }, s, t, { corroborated: true }).ok, true);
});

test("corpus-confirm-precision: confirm never writes into the --sigdb dir it scores against, and the user cache is opt-in", () => {
  const shared = join("x", "db-v3");
  const w = confirmWriteTargets({ out: join("x", "out"), sigdb: shared });
  assert.notEqual(w.projectDbDir, shared, "confirm-built signatures must not land in the shared scoring DB");
  assert.equal(w.projectDbDir, join("x", "out", ".hbc2js", "sigdb"));
  assert.equal(w.userCacheDbDir, undefined, "user cache (read by every later run) is not written by default");
  const opted = confirmWriteTargets({ out: join("x", "out"), confirmCache: true });
  assert.notEqual(opted.userCacheDbDir, undefined);
});
