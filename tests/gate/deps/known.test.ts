import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKnownDeps } from "../../../src/deps/known.ts";

test("parseKnownDeps: package.json shape merges dependencies + devDependencies, strips semver ranges", () => {
  const known = parseKnownDeps({
    dependencies: { react: "18.2.0", "react-native": "^0.72.17" },
    devDependencies: { "@babel/core": "~7.29.7" },
  });
  const byName = new Map(known.map((k) => [k.name, k.version]));
  assert.equal(known.length, 3);
  assert.equal(byName.get("react"), "18.2.0");
  assert.equal(byName.get("react-native"), "0.72.17");
  assert.equal(byName.get("@babel/core"), "7.29.7");
});

test("parseKnownDeps: flat name->version map shape (a resolved lockfile reduces to this)", () => {
  const known = parseKnownDeps({ lodash: "4.17.21", "left-pad": null });
  const byName = new Map(known.map((k) => [k.name, k.version]));
  assert.equal(known.length, 2);
  assert.equal(byName.get("lodash"), "4.17.21");
  assert.equal(byName.get("left-pad"), null);
});

test("parseKnownDeps: rejects a shape that is neither package.json nor a flat map", () => {
  assert.throws(() => parseKnownDeps({ notAKnownShape: [1, 2, 3] }));
});
