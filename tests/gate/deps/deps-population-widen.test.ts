// deps-population-widen: the bulk population was a react-native keyword
// search, so ordinary JS dependencies of RN libraries were never queued.
// population-closure.mjs plans the dependency closure of the DB's own
// packages (plus corpus-string names) with one version per new name.
// Offline: a canned registry, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dbVersions, family, pickVersion, planPopulation, skipName, type Packument } from "../../../tools/pkgsig/bulk/population-closure.mjs";

const REGISTRY: Record<string, Packument> = {
  "lib-a": { latest: "2.0.0", versions: { "1.0.0": { dependencies: { "dep-x": "^1.0.0", "@types/foo": "*" } }, "2.0.0": { dependencies: { "dep-x": "^1.2.0", "dep-y": "~3.1.0" }, peerDependencies: { react: "*", "react-native": "*" } } } },
  "@s/lib-b": { latest: "1.0.0", versions: { "1.0.0": { dependencies: { "dep-x": "^2.0.0", "lib-a": "^2.0.0" } } } },
  "dep-x": { latest: "2.1.0", versions: { "1.1.0": { dependencies: { "deep-z": "^1.0.0" } }, "1.3.0": { dependencies: { "deep-z": "^1.0.0" } }, "1.4.0-beta.1": {}, "2.1.0": {} } },
  "dep-y": { latest: "3.2.0", versions: { "3.1.4": {}, "3.2.0": {} } },
  "deep-z": { latest: "1.5.0", versions: { "1.5.0": { dependencies: { "deeper-w": "*" } } } },
  "deeper-w": { latest: "1.0.0", versions: { "1.0.0": {} } },
  "@corp/sdk": { latest: "4.0.0", versions: { "4.0.0": {} } },
};
const getPackument = async (n: string) => REGISTRY[n] ?? null;

test("dbVersions reads names per HBC version and restores the scope separator", () => {
  const m = dbVersions(["lib-a@1.0.0__hbc98.json", "lib-a@2.0.0__hbc98.json", "@s__lib-b@1.0.0__hbc98.json", "old@1.0.0__hbc96.json", "index.json"], 98);
  assert.deepEqual([...m.keys()].sort(), ["@s/lib-b", "lib-a"]);
  assert.deepEqual([...m.get("lib-a")!].sort(), ["1.0.0", "2.0.0"]);
});

test("pickVersion takes the version most ranges resolve to, never a prerelease", () => {
  const vs = Object.keys(REGISTRY["dep-x"]!.versions);
  assert.equal(pickVersion(vs, ["^1.0.0", "^1.2.0", "^2.0.0"], "2.1.0"), "1.3.0");
  assert.equal(pickVersion(vs, ["^1.0.0", "^2.0.0"], "2.1.0"), "2.1.0"); // tie -> higher
  assert.equal(pickVersion(vs, [], "2.1.0"), "2.1.0"); // no range -> latest
  assert.equal(pickVersion(vs, ["^9.0.0"], null), null);
  assert.equal(family("@aws-sdk/core"), "@aws-sdk");
  assert.equal(family("lodash"), "lodash");
  assert.ok(skipName("@types/node") && skipName("react") && !skipName("react-dom"));
  assert.ok(skipName("typescript") && skipName("@babel/core") && skipName("eslint-plugin-prettier") && skipName("@jest/globals"));
  assert.ok(!skipName("@babel/runtime") && !skipName("metro-runtime") && !skipName("pretty-format"));
});

test("planPopulation: closure of the seeds, minus what the DB has, ranked by dependents", async () => {
  const seeds = new Map([["lib-a", new Set(["1.0.0", "2.0.0"])], ["@s/lib-b", new Set(["1.0.0"])]]);
  const existing = new Set([...seeds.keys(), "dep-y"]); // dep-y already built
  const corpus = new Map([["@corp/sdk", 1], ["deep-z", 2], ["not-a-package-anywhere", 3]]);
  const plan = await planPopulation({ seeds, existing, corpus, getPackument, hops: 2, cap: 10 });
  const got = plan.selected.map((r) => `${r.name}@${r.version}:${r.hop}:${r.score}`);
  // deep-z: hop 2 (via dep-x), one parent + corpus bonus 2*2; dep-x: two parents;
  // @corp/sdk: hop-0 scoped corpus name; deeper-w would be hop 3 (beyond --hops).
  assert.deepEqual(got, ["deep-z@1.5.0:2:5", "dep-x@1.3.0:1:2", "@corp/sdk@4.0.0:0:2"]);
  assert.equal(plan.total, 3);
  const capped = await planPopulation({ seeds, existing, corpus, getPackument, hops: 1, cap: 1 });
  assert.deepEqual(capped.selected.map((r) => r.name), ["dep-x"]);
  assert.equal(capped.total, 2);
});
