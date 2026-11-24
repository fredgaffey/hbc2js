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
  assert.equal(deps["expo-font"]!.version, "~55.0.8"); // pinned from Expo SDK 55's bundledNativeModules.json (expo 55.0.32)
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
  assert.equal(deps["react-native-worklets"]!.version, "0.7.4"); // reanimated 4's peer (SDK 55 at expo 55.0.32)
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

// 0.1.2 corpus a02 (RN 0.82.1, no deps matched): package.json had no
// react-native at all and paired cli 13 / metro 0.80 with RN 0.78, so
// `npx react-native bundle` failed "unknown command 'bundle'".
test("react-native and react are always dependencies once the RN version is known", () => {
  const empty = report({ reactNativeVersion: null, confirmedDeps: [], guessedDeps: [], hintedDeps: [], nativeChannel: null } as unknown as Partial<DepsReport>);
  const deps = exportDependencies(empty, "0.82.1");
  assert.equal(deps["react-native"]!.version, "0.82.1");
  assert.equal(deps["react"]!.version, "^19.1.1");
  assert.equal(deps["react"]!.level, "peer");
  const pj = buildPackageJson({ appName: "X", report: empty, rnVersion: "0.82.1" }) as { dependencies: Record<string, string> };
  assert.ok(pj.dependencies["react-native"] !== undefined && pj.dependencies["react"] !== undefined);
  assert.deepEqual(Object.keys(exportDependencies(empty, null)), [], "no RN version: nothing invented");
});

test("the CLI and metro devDependencies match the line each RN minor ships against (npm registry)", () => {
  const want: [string, string | undefined, string][] = [
    ["0.69.12", undefined, "^0.76.0"], // RN's own cli dependency serves; not tabled
    ["0.70.15", "^9.3.0", "^0.72.0"],
    ["0.71.19", "^10.2.0", "^0.73.0"],
    ["0.72.17", "^11.4.0", "^0.76.0"],
    ["0.73.11", "^12.3.0", "^0.80.0"],
    ["0.74.7", "^13.6.0", "^0.80.0"],
    ["0.75.5", "^14.0.0", "^0.80.0"],
    ["0.76.9", "^15.0.0", "^0.81.0"],
    ["0.77.3", "^15.0.0", "^0.81.0"],
    ["0.78.3", "^15.0.0", "^0.81.0"],
    ["0.79.7", "^18.0.0", "^0.82.0"],
    ["0.80.3", "^19.0.0", "^0.82.0"],
    ["0.81.6", "^20.0.0", "^0.83.0"],
    ["0.82.1", "^20.0.0", "^0.83.0"],
    ["0.84.1", "^20.0.0", "^0.83.0"],
  ];
  for (const [rn, cli, metro] of want) {
    const t = TOOLCHAIN_FOR_RN(rn);
    assert.equal(t["@react-native-community/cli"], cli, `cli for RN ${rn}`);
    assert.equal(t["metro"], metro, `metro for RN ${rn}`);
    if (Number(rn.split(".")[1]) < 73) assert.equal(t["metro-react-native-babel-preset"], metro, `legacy preset for RN ${rn} follows metro`);
  }
});

test("corpus a10/a06: a signature `expo` version from another SDK is pinned to the detected RN's SDK release", () => {
  const r = report({
    confirmedDeps: [
      { package: "react-native", version: "0.83.2", confidence: "high", modulesCovered: 0, moduleTotal: 1, source: "bundle-string", versionEvidence: "bundle-string" },
      { package: "expo", version: "52.0.28", confidence: "high", modulesCovered: 2, moduleTotal: 2, source: "db-match", versionEvidence: "exact-hash" },
    ],
  });
  const deps = exportDependencies(r, "0.83.2");
  assert.equal(deps["expo"]!.version, "55.0.32");
  assert.match(deps["expo"]!.note ?? "", /52\.0\.28.*SDK 55/);
  // The SDK table and its expo release agree: expo-modules-core's floor and
  // worklets are those of expo 55.0.32 (55.0.5's worklets 0.7.2 conflicted
  // with the expo-modules-core ~55.0.14 that npm floats to 55.0.27).
  assert.equal(exportDependencies(report({}), "0.83.2")["expo"]!.version, "55.0.32");
  // No SDK for the RN: the signature version stays.
  assert.equal(exportDependencies(r, "0.75.4")["expo"]!.version, "52.0.28");
});

test("corpus a06: package.json overrides react and react-native to the root specs (optional peer ranges on other lines no longer ERESOLVE)", () => {
  const pkg = buildPackageJson({ appName: "x", report: report({}), rnVersion: "0.83.2" }) as { overrides?: Record<string, string> };
  assert.deepEqual(pkg.overrides, { react: "$react", "react-native": "$react-native" });
});
