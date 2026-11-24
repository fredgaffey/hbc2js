import { test } from "node:test";
import assert from "node:assert/strict";
import { reactVersionFromStrings, rnVersionFromInstructions } from "../../../src/deps/version-evidence.ts";
import { reconcileReactNativeVersion, newestRnVersionForHbc } from "../../../src/deps/report.ts";

const op = (...v: number[]) => v.map((value) => ({ value }));
const NAMES: Record<number, string> = { 10: "major", 11: "minor", 12: "patch", 13: "prerelease" };
const stringOf = (id: number): string | null => NAMES[id] ?? null;

test("rnVersionFromInstructions: reads major/minor/patch stored via PutById (RN 0.83.2 shape)", () => {
  const insns = [
    { name: "LoadConstUInt8", operands: op(1, 2) },
    { name: "LoadConstZero", operands: op(4) },
    { name: "PutById", operands: op(3, 4, 3, 10) },
    { name: "LoadConstUInt8", operands: op(4, 83) },
    { name: "PutById", operands: op(3, 4, 4, 11) },
    { name: "PutById", operands: op(3, 1, 5, 12) },
    { name: "LoadConstNull", operands: op(1) },
    { name: "PutById", operands: op(3, 1, 6, 13) },
  ];
  assert.equal(rnVersionFromInstructions(insns, stringOf), "0.83.2");
});

test("rnVersionFromInstructions: a register overwritten by a call is not a constant; incomplete -> null", () => {
  const insns = [
    { name: "LoadConstUInt8", operands: op(1, 2) },
    { name: "Call1", operands: op(1, 7, 0) },
    { name: "PutById", operands: op(3, 1, 5, 12) },
  ];
  assert.equal(rnVersionFromInstructions(insns, stringOf), null);
});

test("reactVersionFromStrings: version string only counts inside the react package module", () => {
  const react = ["19.2.0", "Fragment", "StrictMode", "Suspense", "cloneElement", "createElement", "$$typeof"];
  const other = ["4.2.1", "worklet", "Fragment"];
  assert.equal(reactVersionFromStrings([other, react]), "19.2.0");
  assert.equal(reactVersionFromStrings([other]), null);
});

test("HBC v96 range covers RN 0.83 (React Native 0.82+ still ships HBC96)", () => {
  assert.equal(reconcileReactNativeVersion(96, "0.83.2").consistent, true);
  assert.equal(newestRnVersionForHbc(96), "0.81.0"); // conservative build fallback, never presented as evidence
});

// Real-bundle check; skips cleanly when the (gitignored) fixture binary is absent.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInventory } from "../../../src/deps/inventory.ts";

const EXPENSIFY = join(import.meta.dirname, "..", "..", "fixtures", "bundles", "expensify-app-0.86.0", "expensify-app.hbc");
test("detectVersionEvidence: reads RN 0.86.0 and a React version off the real expensify bundle", { skip: !existsSync(EXPENSIFY) }, () => {
  const ev = buildInventory(readFileSync(EXPENSIFY)).inventory.versionEvidence;
  assert.equal(ev?.reactNative, "0.86.0");
  assert.match(ev?.react ?? "", /^19\.\d+\.\d+$/);
});
