// docs/specs/33-export-boot.md (0.1.2 apps), spec 31 §4.2 stub-host additions
// found booting an Expo/Ignite original (hbc96):
// (1) expo-constants builds `Constants` as `{ ...ExponentConstants }`; the host
//     stub served constants through its `get` trap only, so the spread was {}
//     and `executionEnvironment` read undefined, which sent expo-linking's
//     createURL into removeScheme(undefined) ("replace of undefined").
// (2) The Hermes RN ships (>= 0.74) has a native TextEncoder that Expo's
//     runtime reads bare; the standalone v96 CLI lacks it.
// (3) An export tree made without --instrument=modules boots silently (0
//     factories) and read as DIVERGENT `export <end>`; it is now an up-front
//     INCONCLUSIVE naming the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAllHermesVms } from "../../../src/harness/hermes-vm.ts";
import { bootTrace } from "../../../src/harness/boot-equiv.ts";
import { exportBootProof } from "../../../src/harness/export-boot.ts";
import { deriveNativeManifest } from "../../../src/harness/native-manifest.ts";
import type { NativeManifest } from "../../../src/harness/native-manifest.ts";

function vmOrSkip(t: TestContext): boolean {
  if (findAllHermesVms().length === 0) {
    t.skip("no Hermes VM");
    return false;
  }
  return true;
}

const NATIVES = { schema: "boot-native/1", present: { ExpoModulesCore: {}, ExponentConstants: { executionEnvironment: "bare", appOwnership: null, platform: { android: {} } } } } as unknown as NativeManifest;

test("0.1.2 apps: native-module constants are own enumerable properties (spread / Object.keys see them), per stub", (t) => {
  if (!vmOrSkip(t)) return;
  const src = `
    var legacy = globalThis.nativeModuleProxy.ExponentConstants;
    var c = Object.assign({}, legacy);
    var rest = (function (o) { var { appOwnership, ...others } = o; return others; })(legacy);
    if (c.executionEnvironment !== "bare" || rest.executionEnvironment !== "bare") throw new Error("spread lost constants: " + JSON.stringify(c));
    if (Object.keys(legacy).indexOf("platform") < 0) throw new Error("keys: " + Object.keys(legacy));
    globalThis.__turboModuleProxy("ExpoModulesCore").installModules();
    var jsi = globalThis.expo.modules.ExponentConstants;
    if (Object.assign({}, jsi).executionEnvironment !== "bare") throw new Error("expo.modules spread lost constants");
    jsi.platform.android.mutated = 1;
    if (legacy.platform.android.mutated !== undefined) throw new Error("constants shared between stubs");
    if (typeof legacy.getConstants !== "function" || legacy.getConstants().executionEnvironment !== "bare") throw new Error("getConstants");
  `;
  const r = bootTrace(src, { seed: 0, natives: NATIVES });
  assert.equal(r.reachedEnd, true, JSON.stringify(r.bootError ?? r.why));
});

test("0.1.2 apps: a VM without TextEncoder gets a UTF-8 stand-in (encode, encodeInto, encoding)", (t) => {
  if (!vmOrSkip(t)) return;
  const src = `
    var e = new TextEncoder();
    var b = Array.prototype.slice.call(e.encode("a\\u00e9\\u20ac\\ud83d\\ude00\\ud800"));
    var want = [0x61, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80, 0xef, 0xbf, 0xbd];
    if (JSON.stringify(b) !== JSON.stringify(want)) throw new Error("encode " + JSON.stringify(b));
    if (e.encoding !== "utf-8" || e.encode().length !== 0) throw new Error("encoding / empty");
    var d = new Uint8Array(4), r = e.encodeInto("a\\u20ac\\u00e9", d);
    if (r.read !== 2 || r.written !== 4 || d[1] !== 0xe2) throw new Error("encodeInto " + JSON.stringify(r));
    if (Object.keys(globalThis).indexOf("TextEncoder") >= 0) throw new Error("TextEncoder must not be enumerable");
  `;
  const r = bootTrace(src, { seed: 0 });
  assert.equal(r.reachedEnd, true, JSON.stringify(r.bootError ?? r.why));
});

test("0.1.2 apps: an un-instrumented export tree is INCONCLUSIVE up front, naming --instrument=modules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-uninstr-"));
  mkdirSync(join(dir, "src", "_hbc"), { recursive: true });
  writeFileSync(join(dir, "src", "_hbc", "registry.js"), "var modules = {};\n");
  writeFileSync(join(dir, "EXPORT.json"), JSON.stringify({ source: { hbcVersion: 96 }, modules: [] }));
  // The original need not exist: the check precedes the (slow) control.
  const r = await exportBootProof(join(dir, "missing.hbc"), dir);
  assert.equal(r.verdict, "INCONCLUSIVE");
  assert.match(r.reason ?? "", /not instrumented.*--instrument=modules/);
});

test("0.1.2 apps: a decompiled lookup called through a register alias is rule-3 evidence (expo-font's ExpoFontLoader)", () => {
  const src = `__d(function(g,r,i,a,m,e,d){ if (typeof globalThis.window === "undefined") { r1 = {}; } else {\n r3 = r(d[0]).requireNativeModule;\n r1 = r3("ExpoFontLoader"); } },7,[6]);`;
  assert.ok("ExpoFontLoader" in deriveNativeManifest(src).present);
  // The optional lookup through an alias stays a probe, not a requirement.
  assert.ok(!("ExpoFontLoader" in deriveNativeManifest(src.replace("requireNativeModule", "requireOptionalNativeModule")).present));
});
