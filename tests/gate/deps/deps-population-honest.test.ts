// sigdb-honest-population: the signature population must be chosen
// without reading the measured apps, or measured recall is not honest.
// population-honest.mjs plans it from the Expo SDK / RN template
// declarations and the npm top-downloads list only. Offline: canned registry.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Packument } from "../../../tools/pkgsig/bulk/population-closure.mjs";
import { declaredRanges, planHonest, versionsFor } from "../../../tools/pkgsig/bulk/population-honest.mjs";

const REG: Record<string, Packument> = {
  "expo-asset": { latest: "13.0.0", versions: { "12.0.1": {}, "12.0.9": {}, "13.0.0": {} } },
  "expo-font": { latest: "14.0.2", versions: { "14.0.2": {} } },
  semver: { latest: "7.7.3", versions: { "5.7.2": {}, "6.3.1": {}, "6.3.0": {}, "7.7.3": {}, "8.0.0-rc.1": {} } },
  chalk: { latest: "5.4.1", versions: { "4.1.2": {}, "5.4.1": {} } },
  "zero-major": { latest: "0.4.0", versions: { "0.4.0": {} } },
};
const getPackument = async (n: string) => REG[n] ?? null;

test("declaredRanges unions Expo SDK lists and RN template deps with their sources", () => {
  const d = declaredRanges({
    expo: [{ label: "57.0.1", bundledNativeModules: { "expo-asset": "~12.0.1", "react-native": "0.83.1" }, dependencies: { "expo-font": "~14.0.0" } }, { label: "58.0.1", bundledNativeModules: { "expo-asset": "~13.0.0" } }],
    template: [{ label: "0.88.1", dependencies: { react: "19.2.0", "@types/x": "*" } }],
  });
  assert.deepEqual(d.get("expo-asset"), { ranges: ["~12.0.1", "~13.0.0"], sources: ["expo-sdk:57.0.1", "expo-sdk:58.0.1"] });
  assert.deepEqual(d.get("expo-font")!.sources, ["expo-deps:57.0.1"]);
  assert.ok(d.has("react"));
});

test("versionsFor: SDK ranges resolve to stable versions; top names take latest plus prior majors", () => {
  assert.deepEqual(versionsFor(REG["expo-asset"]!, ["~12.0.1", "~13.0.0"], 1), ["13.0.0", "12.0.9"]);
  assert.deepEqual(versionsFor(REG.semver!, null, 2), ["7.7.3", "6.3.1", "5.7.2"]);
  assert.deepEqual(versionsFor(REG.semver!, null, 0), ["7.7.3"]);
  assert.deepEqual(versionsFor(REG["zero-major"]!, null, 1), ["0.4.0"]);
});

test("planHonest: declared first, new names before new versions, existing files skipped, cap cuts", async () => {
  const declared = declaredRanges({ expo: [{ label: "58", bundledNativeModules: { "expo-asset": "~12.0.1 || ~13.0.0", "expo-font": "~14.0.0", "react-native": "*" } }] });
  const existing = new Map([[96, new Map([["semver", new Set(["7.7.3"])]])], [98, new Map([["expo-font", new Set(["14.0.2"])]])]]);
  const plan = await planHonest({ declared, topDownload: ["semver", "chalk", "expo-asset", "@types/node", "missing-pkg", "zero-major"], top: 5, existing, hbcs: [96, 98], getPackument, priorMajors: 1, cap: 100 });
  const key = (r: { name: string; version: string; hbc: number; phase: number }) => `${r.phase}:${r.name}@${r.version}/${r.hbc}`;
  assert.deepEqual(plan.all.map(key), [
    "1:expo-asset@13.0.0/96", "1:expo-asset@13.0.0/98", "1:expo-font@14.0.2/96",
    "1:semver@7.7.3/98", "1:chalk@5.4.1/96", "1:chalk@5.4.1/98",
    "2:semver@6.3.1/96", "2:semver@6.3.1/98", "2:chalk@4.1.2/96", "2:chalk@4.1.2/98",
  ]);
  assert.deepEqual(plan.unresolved, ["missing-pkg"]); // zero-major is past --top 5; react-native and @types skipped
  const capped = await planHonest({ declared, topDownload: ["semver"], existing, hbcs: [98], getPackument, cap: 2 });
  assert.equal(capped.selected.length, 2);
});
