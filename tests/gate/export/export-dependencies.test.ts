import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLCHAIN_FOR_RN, buildBabelConfigJs, buildPackageJson, exportDependencies, expoSdkForRn, resolveReactNativeVersion } from "../../../src/export/boilerplate.ts";
import type { DepsReport } from "../../../src/deps/report.ts";

function report(over: Partial<DepsReport>): DepsReport {
  return {
    hbcVersion: 96,
    reactNativeVersion: "0.83.2",
    reactNativeVersionSource: "bundle-string",
    confirmedDeps: [
      { package: "react-native", version: "0.83.2", confidence: "high", modulesCovered: 0, moduleTotal: 1, source: "bundle-string", versionEvidence: "bundle-string" },
      { package: "react", version: "19.2.0", confidence: "high", modulesCovered: 0, moduleTotal: 1, source: "bundle-string", versionEvidence: "bundle-string" },
    ],
    guessedDeps: [{ package: "@react-navigation/native", version: null, confidence: 0.6, modules: 1, evidence: ["x"] }],
    hintedDeps: [
      { package: "react-native-screens", version: null, confidence: 0.7, evidenceKind: "native-module", evidence: ["RNSScreen"] },
      { package: "expo-font", version: null, confidence: 0.7, evidenceKind: "native-module", evidence: ["ExpoFontLoader"] },
      { package: "expo", version: null, confidence: 0.7, evidenceKind: "dependency-edge", evidence: ["expo-font"] },
    ],
    nativeChannel: { deps: [{ package: "react-native-mmkv", channel: "native-only", evidence: ["native-package"], nativeModuleCount: 1 }] },
    ...over,
  } as unknown as DepsReport;
}

test("package.json carries guessed/hinted/native-channel deps, not just confirmed ones", () => {
  const deps = exportDependencies(report({}), "0.83.2");
  assert.deepEqual(Object.keys(deps).sort(), ["@react-navigation/native", "expo", "expo-font", "react", "react-native", "react-native-mmkv", "react-native-screens"]);
  assert.equal(deps["react-native"]!.version, "0.83.2");
  assert.equal(deps["react-native"]!.level, "bundle-string");
  assert.equal(deps["react-native-screens"]!.level, "hint");
  assert.equal(deps["react-native-screens"]!.versionDerived, true);
  assert.equal(deps["expo-font"]!.version, "~55.0.4"); // pinned from Expo SDK 55's bundledNativeModules.json
  assert.equal(deps["react-native-mmkv"]!.level, "native-channel");
  const pkg = buildPackageJson({ appName: "x", report: report({}), rnVersion: "0.83.2" }) as { dependencies: Record<string, string> };
  assert.equal(pkg.dependencies["react-native-screens"], "~4.23.0");
  assert.equal(pkg.dependencies["react"], "19.2.0");
});

test("Expo SDK compat table pins name-only deps and overrides conflicting signature versions", () => {
  const r = report({
    confirmedDeps: [
      { package: "react-native", version: "0.83.2", confidence: "high", modulesCovered: 0, moduleTotal: 1, source: "bundle-string", versionEvidence: "bundle-string" },
      { package: "react-native-reanimated", version: "3.19.5", confidence: "high", modulesCovered: 3, moduleTotal: 3, source: "db-match", versionEvidence: "exact-hash" },
    ],
    guessedDeps: [],
    hintedDeps: [{ package: "some-unknown-lib", version: null, confidence: 0.7, evidenceKind: "native-module", evidence: ["X"] }],
    nativeChannel: null,
  });
  const deps = exportDependencies(r, "0.83.2");
  assert.equal(deps["react-native-reanimated"]!.version, "4.2.1");
  assert.match(deps["react-native-reanimated"]!.note ?? "", /3\.19\.5.*Expo SDK 55/);
  assert.equal(deps["react-native-worklets"]!.version, "0.7.2"); // reanimated 4's peer
  assert.equal(deps["react-native-worklets"]!.level, "peer");
  assert.equal(deps["react-native"]!.version, "0.83.2"); // bundle evidence is never overridden
  assert.equal(deps["some-unknown-lib"]!.version, "*");
  assert.match(deps["some-unknown-lib"]!.note ?? "", /unpinned/);
  // a bare RN version with no Expo SDK mapping leaves the signature version alone
  assert.equal(exportDependencies(r, "0.75.4")["react-native-reanimated"]!.version, "3.19.5");
});

test("react-navigation 6.x signature versions are replaced when the bundle uses the 7.x-only static API", () => {
  const r = report({
    reactNavigationApi7: true,
    confirmedDeps: [{ package: "@react-navigation/native", version: "6.1.18", confidence: "high", modulesCovered: 3, moduleTotal: 3, source: "db-match", versionEvidence: "exact-hash" }],
    guessedDeps: [], hintedDeps: [], nativeChannel: null,
  } as Partial<DepsReport>);
  const d = exportDependencies(r, "0.75.4")["@react-navigation/native"]!;
  assert.equal(d.version, "^7.0.0");
  assert.match(d.note ?? "", /static/);
  const none = exportDependencies({ ...r, reactNavigationApi7: false } as DepsReport, "0.75.4")["@react-navigation/native"]!;
  assert.equal(none.version, "6.1.18");
});

test("RN 0.83 gets the modern toolchain (babel-preset, metro-config, cli 20, metro 0.83)", () => {
  const t = TOOLCHAIN_FOR_RN("0.83.2");
  assert.equal(t["@react-native/babel-preset"], "0.83.2");
  assert.equal(t["@react-native/metro-config"], "0.83.2");
  assert.equal(t["@react-native-community/cli"], "^20.0.0");
  assert.equal(t["metro"], "^0.83.0");
  assert.equal(t["metro-react-native-babel-preset"], undefined);
  assert.match(buildBabelConfigJs("0.83.2"), /@react-native\/babel-preset/);
  assert.equal(expoSdkForRn("0.83.2"), 55);
});

test("a signature-DB nearest match is not reported as confirmed", () => {
  const sig = resolveReactNativeVersion(report({ reactNativeVersion: "0.72.17", reactNativeVersionSource: "signature-match" }), undefined);
  assert.equal(sig.source, "deps-signature-match");
  assert.equal(resolveReactNativeVersion(report({}), undefined).source, "bundle-string");
});

// Real-app check (ignite-11.5.0, RN 0.83.2 / Expo 55); skips when the gitignored binary is absent.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runDeps } from "../../../src/deps/index.ts";

const IGNITE = join(import.meta.dirname, "..", "..", "fixtures", "bundles", "ignite-11.5.0", "app.hbc");
test("ignite-11.5.0: deps report RN 0.83.2 / React 19.2.0 from bundle constants and export lists Expo + hint-level deps", { skip: !existsSync(IGNITE) }, async () => {
  const { report } = await runDeps(IGNITE, { offline: true });
  assert.equal(report.reactNativeVersion, "0.83.2");
  assert.equal(report.reactNativeVersionSource, "bundle-string");
  assert.equal(report.reactVersion, "19.2.0");
  const deps = exportDependencies(report, report.reactNativeVersion);
  for (const name of ["expo", "expo-font", "expo-linking", "react-native-screens", "react-native-safe-area-context"]) assert.ok(deps[name] !== undefined, `${name} missing`);
  assert.equal(deps["react"]!.version, "19.2.0");
});
