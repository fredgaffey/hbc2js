import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileReactNativeVersion, detectReactNativeVersion } from "../../../src/deps/report.ts";
import type { MatchReport } from "../../../src/deps/match.ts";

test("reconcileReactNativeVersion: known-good HBC/RN pairings are all consistent", () => {
  const knownPairings: ReadonlyArray<{ readonly hbcVersion: number; readonly rn: string; readonly note: string }> = [
    { hbcVersion: 84, rn: "0.64.0", note: "hermes-engine-cli 0.8.1 era, RN 0.64-0.69" },
    { hbcVersion: 84, rn: "0.69.6", note: "hermes-engine-cli 0.11.0 era, RN 0.64-0.69" },
    { hbcVersion: 85, rn: "0.69.6", note: "react-native itself started bundling hermesc here" },
    { hbcVersion: 89, rn: "0.70.15", note: "react-native@0.70.15" },
    { hbcVersion: 90, rn: "0.71.19", note: "react-native@0.71.19" },
    { hbcVersion: 94, rn: "0.72.17", note: "react-native@0.72.17, byte-identical hermesc" },
    // HBC96 spans several years/mechanisms per docs/TOOLCHAIN.md; the range
    // was widened from 0.73.x-0.81.x to 0.72.x-0.81.x since
    // react-native@0.72.x apps commonly ship a HBC96-compiled bundle by
    // overriding hermes-engine independently of the RN npm version -- a
    // real-world case.
    { hbcVersion: 96, rn: "0.72.17", note: "real-world HBC96 bundle built with react-native@0.72.17, previously flagged false" },
    { hbcVersion: 96, rn: "0.73.11", note: "react-native@0.73.11, the sdks/hermesc source of HBC96" },
    { hbcVersion: 96, rn: "0.74.5", note: "still within the widened floor" },
    { hbcVersion: 96, rn: "0.81.6", note: "documented upper bound before the RN->hermes-compiler split" },
    { hbcVersion: 98, rn: "0.86.0", note: "hermes-compiler 250829098.0.x family, current latest" },
    { hbcVersion: 99, rn: "1000.0.0", note: "the 1000.x line has no documented upper bound" },
  ];
  for (const { hbcVersion, rn, note } of knownPairings) {
    const { consistent, expectedRange } = reconcileReactNativeVersion(hbcVersion, rn);
    assert.equal(consistent, true, `HBC${hbcVersion} + RN ${rn} (${note}) should be consistent, range=${expectedRange}`);
  }
});

test("reconcileReactNativeVersion: HBC96 + RN 0.72.17 is no longer a false positive", () => {
  // The exact repro this test covers: a real-world HBC96 bundle whose best-matched
  // react-native version was 0.72.17.
  const { consistent, expectedRange } = reconcileReactNativeVersion(96, "0.72.17");
  assert.equal(consistent, true);
  assert.equal(expectedRange, "RN 0.72.x-0.81.x");
});

test("reconcileReactNativeVersion: a genuinely wrong era is still flagged", () => {
  // Sanity check: widening HBC96's floor must not turn the range table into
  // a no-op. A HBC94 bundle (RN 0.72.x only) reporting a RN 0.60.x version
  // -- a different HBC era's version entirely -- is still inconsistent.
  const { consistent } = reconcileReactNativeVersion(94, "0.60.0");
  assert.equal(consistent, false);
});

test("reconcileReactNativeVersion: no RN version detected -> null, not false", () => {
  const { consistent, expectedRange } = reconcileReactNativeVersion(96, null);
  assert.equal(consistent, null);
  assert.equal(expectedRange, "RN 0.72.x-0.81.x");
});

test("reconcileReactNativeVersion: undocumented HBC version -> null range and null consistency", () => {
  const { consistent, expectedRange } = reconcileReactNativeVersion(999, "0.72.17");
  assert.equal(consistent, null);
  assert.equal(expectedRange, null);
});

test("detectReactNativeVersion: prefers a range-consistent HBC96 candidate at the same tier", () => {
  const matchReport = {
    hbcVersion: 96,
    packages: [
      { package: "react-native", version: "0.70.6", tier: "medium", exactCoverage: 0.5 },
      { package: "react-native", version: "0.72.17", tier: "medium", exactCoverage: 0.5 },
    ],
  } as unknown as MatchReport;
  assert.equal(detectReactNativeVersion(matchReport), "0.72.17");
});
