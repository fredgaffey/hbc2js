import { test } from "node:test";
import assert from "node:assert/strict";
import { rnCompatPin, satisfies } from "../../../src/export/rn-compat.ts";
import { exportDependencies } from "../../../src/export/boilerplate.ts";
import type { DepsReport } from "../../../src/deps/report.ts";

test("satisfies: the peer-range shapes react-native peers actually use", () => {
  assert.equal(satisfies("0.73.11", "*"), true);
  assert.equal(satisfies("0.73.11", ">=0.70"), true);
  assert.equal(satisfies("0.73.11", ">=0.74.0"), false);
  assert.equal(satisfies("0.73.11", "^0.72.0 || ^0.73.0"), true);
  assert.equal(satisfies("0.73.11", "^0.72.0"), false);
  assert.equal(satisfies("0.88.1", "0.x"), true);
  assert.equal(satisfies("0.73.11", "~0.73.0"), true);
  assert.equal(satisfies("0.73.11", ">=0.60 <0.73"), false);
  assert.equal(satisfies("0.73.11", ">0.72"), true);
  assert.equal(satisfies("0.73.11", "0.71 - 0.74"), true);
  assert.equal(satisfies("1.0.0", "^0.73.0"), false);
  assert.equal(satisfies("0.73.11", "garbage"), false);
});

test("a pin never admits a version whose peer range excludes the detected RN", () => {
  // react-native-screens 4.x needs RN >= 0.7x; for RN 0.73 the newest admitting version is older than latest
  const pin73 = rnCompatPin("react-native-screens", "0.73.11");
  const pin88 = rnCompatPin("react-native-screens", "0.88.1");
  assert.ok(pin73 !== null && pin88 !== null);
  const major = (v: string): number => Number(v.split(".")[0]);
  assert.ok(major(pin73!.version) <= major(pin88!.version));
  assert.match(pin73!.note, /rn-compat\.json/);
  assert.equal(rnCompatPin("no-such-package-xyz", "0.73.11"), null);
});

function report(over: Partial<DepsReport>): DepsReport {
  return { hbcVersion: 96, reactNativeVersion: "0.88.1", reactNativeVersionSource: "bundle-string", confirmedDeps: [{ package: "react-native", version: "0.88.1", confidence: "high", modulesCovered: 0, moduleTotal: 1, source: "bundle-string", versionEvidence: "bundle-string" }], guessedDeps: [], hintedDeps: [{ package: "react-native-device-info", version: null, confidence: 0.7, evidenceKind: "native-module", evidence: ["RNSScreen"] }], nativeChannel: null, ...over } as unknown as DepsReport;
}

test("bare-RN name-only hint is pinned from the compat table, not '*'; evidence-pinned deps are untouched", () => {
  const deps = exportDependencies(report({}), "0.88.1");
  const d = deps["react-native-device-info"]!;
  assert.notEqual(d.version, "*");
  assert.match(d.version, /^\d+\.\d+\.\d+$/);
  assert.equal(d.versionDerived, true);
  assert.match(d.note ?? "", /peer range|published by/);
  assert.equal(deps["react-native"]!.version, "0.88.1");
});

// 0.1.2 corpus a01 (bare RN 0.78.1, react 19.0.0): the signature DB matched RN
// 0.72/0.73 while the bundle's own constant said react 19.0.0; the exported
// package.json pinned react 19.0.0 beside react-native 0.73.3 (peer react
// 18.2.0) and `npm install` failed ERESOLVE.
test("react 19 bundle constant moves a signature-matched RN 0.73 onto a react-19 line; package.json peers agree", async () => {
  const { resolveReactNativeVersion } = await import("../../../src/export/boilerplate.ts");
  const { rnReactPeer, satisfies: sat } = await import("../../../src/export/rn-compat.ts");
  const r = report({
    reactNativeVersion: "0.72.17",
    reactNativeVersionSource: "signature-match",
    reactNativeVersionExpectedRange: "RN 0.72.x-0.87.x",
    confirmedDeps: [
      { package: "react", version: "19.0.0", confidence: "high", modulesCovered: 1, moduleTotal: 1, source: "bundle-string", versionEvidence: "bundle-string" },
      { package: "react-native", version: "0.73.3", confidence: "high", modulesCovered: 5, moduleTotal: 9, source: "db-match", versionEvidence: "exact-hash" },
    ],
    hintedDeps: [],
  } as unknown as Partial<DepsReport>);
  const rn = resolveReactNativeVersion(r, undefined);
  assert.match(rn.version!, /^0\.78\./, "nearest RN line whose react peer admits 19.0.0");
  assert.match(rn.note ?? "", /react 19\.0\.0/);
  const deps = exportDependencies(r, rn.version);
  assert.equal(deps["react-native"]!.version, rn.version, "react-native dependency follows the resolved RN");
  assert.equal(deps["react"]!.version, "19.0.0");
  assert.ok(sat(deps["react"]!.version, rnReactPeer(deps["react-native"]!.version)!), "react satisfies RN's react peer");
});

test("an RN known from the bundle's own constants pulls a weaker react onto its react peer", () => {
  const r = report({
    reactNativeVersion: "0.77.3",
    confirmedDeps: [
      { package: "react-native", version: "0.77.3", confidence: "high", modulesCovered: 0, moduleTotal: 1, source: "bundle-string", versionEvidence: "bundle-string" },
      { package: "react", version: "19.0.0", confidence: "high", modulesCovered: 2, moduleTotal: 3, source: "db-match", versionEvidence: "exact-hash" },
    ],
    hintedDeps: [],
  } as unknown as Partial<DepsReport>);
  const deps = exportDependencies(r, "0.77.3");
  // RN 0.77 has no Expo SDK line, so only the rn-compat react peer decides.
  assert.equal(deps["react"]!.version, "^18.2.0");
  assert.match(deps["react"]!.note!, /peer react \^18\.2\.0/);
});
