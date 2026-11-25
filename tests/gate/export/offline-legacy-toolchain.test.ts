// corpus a08 (RN 0.66.4): with its bundle step and stub-host gaps fixed,
// `equiv --boot` failed building the export offline: "Cannot find module
// '@react-native/metro-babel-transformer'". Before RN 0.73 neither that
// package nor `@react-native/metro-config` exists: RN's own CLI transforms with
// `metro-react-native-babel-transformer` and takes the serializer's polyfills
// from `react-native/rn-get-polyfills` and InitializeCore (cli-plugin-metro's
// loadMetroConfig). The offline bundle must do the same for such a tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rnSerializerDefaults, upstreamBabelTransformer } from "../../../src/export/offline-check.ts";

function legacyTree(): string {
  const tree = realpathSync(mkdtempSync(join(tmpdir(), "hbc2js-legacy-tree-")));
  const nm = join(tree, "node_modules");
  const put = (rel: string, body: string): void => { mkdirSync(join(nm, rel, ".."), { recursive: true }); writeFileSync(join(nm, rel), body); };
  writeFileSync(join(tree, "package.json"), `{"name":"t","version":"0.0.0"}`);
  put("react-native/package.json", `{"name":"react-native","version":"0.66.4"}`);
  put("react-native/rn-get-polyfills.js", `module.exports = () => [require.resolve("./Libraries/polyfills/error-guard.js")];`);
  put("react-native/Libraries/polyfills/error-guard.js", ``);
  put("react-native/Libraries/Core/InitializeCore.js", ``);
  put("metro-react-native-babel-transformer/package.json", `{"name":"metro-react-native-babel-transformer","version":"0.66.2","main":"src/index.js"}`);
  put("metro-react-native-babel-transformer/src/index.js", `module.exports = { transform() {} };`);
  return tree;
}

test("corpus a08: a pre-0.73 tree's offline bundle uses RN's own transformer and polyfills (no @react-native/metro-*)", () => {
  const tree = legacyTree();
  assert.equal(upstreamBabelTransformer(tree), join(tree, "node_modules/metro-react-native-babel-transformer/src/index.js"));
  const d = rnSerializerDefaults(tree);
  assert.deepEqual(d.getPolyfills!({ platform: "android" }), [join(tree, "node_modules/react-native/Libraries/polyfills/error-guard.js")]);
  assert.deepEqual(d.getModulesRunBeforeMainModule!(tree), [join(tree, "node_modules/react-native/Libraries/Core/InitializeCore.js")]);
});

// The next a08 gap: Metro 0.66's runBuild prints "Writing bundle output to:"
// with console.log whatever the reporter, which put text before
// `equiv --boot --json`'s JSON on stdout. The offline bundle keeps stdout clean.
test("corpus a08: an old Metro's console.log during the offline bundle does not reach stdout", async () => {
  const tree = legacyTree();
  const nm = join(tree, "node_modules");
  mkdirSync(join(nm, "metro"), { recursive: true });
  writeFileSync(join(nm, "metro/package.json"), `{"name":"metro","version":"0.66.2","main":"index.js"}`);
  writeFileSync(join(nm, "metro/index.js"), `module.exports = {
    loadConfig: async () => ({ serializer: { getPolyfills: () => ["p"] }, resolver: {}, transformer: {} }),
    runBuild: async (c, o) => { console.log("Writing bundle output to: " + o.out); require("fs").writeFileSync(o.out, ""); },
  };`);
  const { offlineBundle } = await import("../../../src/export/offline-check.ts");
  const write = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => { out += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    await offlineBundle(tree, tree);
  } finally {
    process.stdout.write = write;
  }
  assert.ok(!out.includes("Writing bundle output"), `stdout got: ${JSON.stringify(out)}`);
});
