// This file is unit-level, on synthetic `InventoryModule`-shaped objects
// (`makeModule` below fills in dummy values for every field
// `nestedStringsMatch` does not read) — no hermesc/Metro compile needed to
// exercise the four abstain preconditions precisely, one branch per test.
// The real held-out-app happy path (this tier is what turns BackHandler
// into a real seam) and the platform-swap false-positive check live in
// `tests/gate/tooling/seams-sweep.test.ts` (sweep tier — needs the real
// fixture + hermesc + node_modules/react-native).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nestedStringsMatch, type Platform } from "../../../src/tooling/seams.ts";
import type { InventoryModule } from "../../../src/deps/inventory.ts";

function makeModule(nestedStringConstants: readonly string[]): InventoryModule {
  return {
    factoryFunctionIndex: 0,
    localModuleId: null,
    depCount: null,
    depIds: null,
    nestedFunctionIndices: [],
    functionIndices: [0],
    instrCount: 0,
    stringConstants: [],
    exactHash: null,
    fuzzyHash: null,
    stringSetHash: "dummy",
    factoryStringSetHash: null,
    factoryStringCount: 0,
    factoryOnly: true,
    fuzzyHashSet: "dummy",
    nestedExactHashSet: nestedStringConstants.length > 0 ? "dummy-exact" : null,
    nestedFuzzyHashSet: nestedStringConstants.length > 0 ? "dummy-fuzzy" : null,
    nestedStringConstants,
  };
}

const THREE = ["alpha", "beta", "gamma"];
const OTHER_THREE = ["delta", "epsilon", "zeta"];
const TWO = ["alpha", "beta"];

test("nestedStringsMatch: happy path — bundle set equals exactly one (qualifying) variant's set", () => {
  const ios = makeModule([]);
  const android = makeModule(THREE);
  const bundle = makeModule(THREE);
  const result: Platform | null = nestedStringsMatch(bundle, ios, android);
  assert.equal(result, "android");
});

test("nestedStringsMatch: happy path, other side — bundle matches the ios set", () => {
  const ios = makeModule(THREE);
  const android = makeModule(OTHER_THREE);
  const bundle = makeModule(THREE);
  assert.equal(nestedStringsMatch(bundle, ios, android), "ios");
});

test("nestedStringsMatch: abstains when the matching set has fewer than 3 strings", () => {
  const ios = makeModule([]);
  const android = makeModule(TWO);
  const bundle = makeModule(TWO);
  assert.equal(nestedStringsMatch(bundle, ios, android), null);
});

test("nestedStringsMatch: abstains when the two variants' nested string sets are identical", () => {
  const ios = makeModule(THREE);
  const android = makeModule(THREE);
  const bundle = makeModule(THREE);
  assert.equal(nestedStringsMatch(bundle, ios, android), null);
});

test("nestedStringsMatch: abstains when the two variants are both empty (still identical)", () => {
  const ios = makeModule([]);
  const android = makeModule([]);
  const bundle = makeModule([]);
  assert.equal(nestedStringsMatch(bundle, ios, android), null);
});

test("nestedStringsMatch: abstains when the bundle set matches neither variant", () => {
  const ios = makeModule(THREE);
  const android = makeModule(OTHER_THREE);
  const bundle = makeModule(["nothing", "in", "common", "here"]);
  assert.equal(nestedStringsMatch(bundle, ios, android), null);
});

test("nestedStringsMatch: abstains when the bundle set is empty (never matches a qualifying variant)", () => {
  const ios = makeModule(THREE);
  const android = makeModule(OTHER_THREE);
  const bundle = makeModule([]);
  assert.equal(nestedStringsMatch(bundle, ios, android), null);
});

// "Bundle set equals BOTH variants' sets" (the fourth abstain precondition) is not separately constructible: exact-array
// equality is transitive, so bundle===ios and bundle===android together
// imply ios===android, which the "two variants must differ" precondition
// above already rejects first. `nestedStringsMatch`'s own
// `matchesIos === matchesAndroid` check still guards this case defensively
// (never `as MatchTier`-casts a double match into a real answer) — this
// test exercises that guard through the one reachable door: the identical-
// variant-sets case already covered above, which is the only way
// "matches both" could ever arise.
test("nestedStringsMatch: identical variant sets is the only way 'matches both' could arise, and it already abstains", () => {
  const ios = makeModule(THREE);
  const android = makeModule(THREE);
  const bundle = makeModule(THREE); // bundle equals BOTH ios and android here, by construction.
  assert.equal(nestedStringsMatch(bundle, ios, android), null);
});
