// Expo packages are reported only on real evidence (expo-modules-core in the
// bundle); feature probes for optional peers are not evidence. Measured on a
// bare RN 0.88 app: expo, expo-asset, expo-constants, expo-font,
// masked-view and edge-to-edge were all false positives from probe strings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "../../../src/deps/report.ts";
import { probeVerdict } from "../../../src/deps/optional-probes.ts";
import { expoRuntimeFromStrings, rnVersionFromPackageJsonLiteral } from "../../../src/deps/version-evidence.ts";
import type { MatchReport } from "../../../src/deps/match.ts";
import type { ModuleGuess, Evidence } from "../../../src/deps/guess.ts";

const mr: MatchReport = { hbcVersion: 96, totalFunctions: 1000, totalModules: 10, packagesChecked: 0, packages: [], moduleAttributions: [], unattributedModules: [] };
function guess(pkg: string, kind: Evidence["kind"], detail: string, idx: number): ModuleGuess {
  return { factoryFunctionIndex: idx, localModuleId: idx, instrCount: 50, candidates: [{ package: pkg, version: null, confidence: 0.75, evidence: [{ kind, detail, weight: 0.75 }] }] };
}
const probes = [guess("expo-font", "native-module", "ExpoFontLoader", 1), guess("expo-constants", "native-module", "ExponentConstants", 2), guess("react-native-edge-to-edge", "native-module", "RNEdgeToEdge", 3), guess("@react-native-masked-view/masked-view", "native-module", "RNCMaskedView", 4), guess("react-native-screens", "native-module", "RNSScreen", 5)];

test("expo-modules-core fingerprints: probes (expo.modules.X) are not enough", () => {
  assert.equal(expoRuntimeFromStrings([["expo", "modules", "ExpoFontLoader", "getLoadedFonts"]]), false);
  assert.equal(expoRuntimeFromStrings([["TurboModuleRegistry", "ExponentConstants"]]), false);
  assert.equal(expoRuntimeFromStrings([["x", "__expo_module_name__"]]), true);
  assert.equal(expoRuntimeFromStrings([["requireNativeViewManager", "CodedError", "SharedObject", "uuid"]]), true);
  assert.equal(expoRuntimeFromStrings([["ExpoModulesCore"]]), true);
});

test("a bare RN bundle: probe-only expo / edge-to-edge / masked-view hints are suppressed, real native packages stay", () => {
  const r = buildReport("x", mr, probes);
  const hinted = r.hintedDeps.map((d) => d.package);
  assert.deepEqual(hinted, ["react-native-screens"]);
  assert.equal(r.suppressedGuesses.find((s) => s.package === "expo-font")!.reason, "no-expo-runtime");
  assert.equal(r.suppressedGuesses.find((s) => s.package === "react-native-edge-to-edge")!.reason, "optional-probe");
  assert.equal(r.suppressedGuesses.find((s) => s.package === "@react-native-masked-view/masked-view")!.reason, "optional-probe");
  assert.equal(r.expoRuntime, undefined);
});

test("with expo-modules-core in the bundle: expo-* hints, edge-to-edge and the implied `expo` are reported", () => {
  const r = buildReport("x", mr, probes, [], null, null, { expoRuntime: true });
  const hinted = r.hintedDeps.map((d) => d.package).sort();
  assert.deepEqual(hinted, ["expo", "expo-constants", "expo-font", "react-native-edge-to-edge", "react-native-screens"]);
  assert.equal(r.suppressedGuesses.find((s) => s.package === "@react-native-masked-view/masked-view")!.reason, "optional-probe");
  assert.equal(r.expoRuntime, true);
});

test("probes corroborated by a non-string kind (db match, dependency edge) pass", () => {
  assert.equal(probeVerdict("@react-native-masked-view/masked-view", new Set(["native-module", "db-match"]), false), null);
  assert.equal(probeVerdict("@react-native-masked-view/masked-view", new Set(["native-module", "package-name-string"]), false), "optional-probe");
  assert.equal(probeVerdict("@expo/metro-runtime", new Set(["native-module"]), false), null);
});

test("react-native's own package.json literal gives the exact RN version (0.73 bundles drop ReactNativeVersion)", () => {
  const lit = new Map([["name", "react-native"], ["version", "0.73.11"], ["description", "A framework for building native apps using React"]]);
  assert.equal(rnVersionFromPackageJsonLiteral(lit), "0.73.11");
  assert.equal(rnVersionFromPackageJsonLiteral(new Map([["name", "left-pad"], ["version", "1.0.0"], ["description", "x"]])), null);
  assert.equal(rnVersionFromPackageJsonLiteral(new Map([["name", "react-native"], ["version", "next"], ["description", "x"]])), null);
  assert.equal(rnVersionFromPackageJsonLiteral(new Map([["name", "react-native"], ["version", "0.73.11"]])), null);
});
