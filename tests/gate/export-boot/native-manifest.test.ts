// Spec 31 §4.2 / spec 33 L4: the stub host's native-module presence
// manifest (src/harness/native-manifest.ts). Derivation rule on synthetic
// bundle text, then the stub host honouring it under the real VM.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { findAllHermesVms } from "../../../src/harness/hermes-vm.ts";
import { bootTrace } from "../../../src/harness/boot-equiv.ts";
import { bundleEvidence, deriveNativeManifest } from "../../../src/harness/native-manifest.ts";

function vmOrSkip(t: TestContext): boolean {
  if (findAllHermesVms().length > 0) return true;
  t.skip("no Hermes VM");
  return false;
}

const TEXT = [
  `__d(function(g,r,i,a,m,e,d){var t=r(d[0]).TurboModuleRegistry.get('LibOwnModule')},10,[6]);`,
  `__d(function(g,r,i,a,m,e,d){var t=r(d[0]).getEnforcing('NeededModule'),x=1},11,[6]);`,
  `__d(function(g,r,i,a,m,e,d){var u=t.get("ProbeA")||t.get("ProbeB")||t.get("ChainTail");var l=u},12,[6]);`,
  `__d(function(g,r,i,a,m,e,d){var o=(()=>{try{return(0,n.requireNativeModule)('MaybeGo')}catch{return null}})()},13,[6]);`,
  `__d(function(g,r,i,a,m,e,d){var s=(0,u.requireOptionalNativeModule)('OptionalUpdates'),o=1},14,[6]);`,
  `__d(function(g,r,i,a,m,e,d){var t=(0,r(d[0]).requireOptionalNativeModule)('ExponentConstants')},15,[6]);`,
  `__d(function(g,r,i,a,m,e,d){var w=Dimensions.get('window');try{o.TurboModuleRegistry.get('JsiCore')?.installModules()}catch(e){}},16,[6]);`,
  `__d(function(g,r,i,a,m,e,d){var k=r(d[0]).get('ActionSheetManager')},17,[6]);`,
].join("\n");

test("native manifest: required and library-spec lookups are present; probes, try-wrapped and optional side lookups are absent", () => {
  const ev = bundleEvidence(TEXT);
  assert.deepEqual([...ev.required].sort(), ["ChainTail", "JsiCore", "NeededModule"]);
  const m = deriveNativeManifest(TEXT);
  for (const n of ["LibOwnModule", "JsiCore", "ChainTail", "NeededModule", "ExponentConstants", "PlatformConstants", "DeviceInfo"]) assert.ok(n in m.present, `${n} present`);
  for (const n of ["ProbeA", "ProbeB", "MaybeGo", "OptionalUpdates", "window", "ActionSheetManager"]) assert.ok(!(n in m.present), `${n} absent`);
  assert.equal(m.present.ExponentConstants!.executionEnvironment, "bare");
});

test("native manifest: the per-app override adds present modules with constants and forces absences", () => {
  const m = deriveNativeManifest(TEXT, { present: { OptionalUpdates: { manifestString: "{}" }, Extra: true }, absent: ["LibOwnModule"] });
  assert.deepEqual(m.present.OptionalUpdates, { manifestString: "{}" });
  assert.ok("Extra" in m.present);
  assert.ok(!("LibOwnModule" in m.present));
});

test("export-boot L4: optional native modules look present (stub answered every name), so expo-constants JSON.parsed a function", (t) => {
  if (!vmOrSkip(t)) return;
  // The shape of expo-constants' module-eval probes (react-navigation-example factory 1059).
  const src = `
    var NM = globalThis.nativeModuleProxy;
    var dev = NM.EXDevLauncher;
    var p = dev && dev.manifestString ? JSON.parse(dev.manifestString) : null;
    var upd = globalThis.__turboModuleProxy("OptionalUpdates");
    if (upd !== null) throw new Error("absent TurboModule must be null");
    var pc = NM.PlatformConstants;
    if (pc === undefined || pc.getConstants().isTesting !== false) throw new Error("PlatformConstants constants");
    if (pc.isTesting !== false) throw new Error("constants readable as properties");
    if (typeof pc.someMethod !== "function") throw new Error("methods stay callable");
    if ("EXDevLauncher" in NM) throw new Error("absent module has no key");
  `;
  const r = bootTrace(src, { seed: 0, natives: deriveNativeManifest(TEXT) });
  assert.equal(r.reachedEnd, true, JSON.stringify(r.bootError));
});

test("native manifest: Expo's globalThis.expo.modules answers present modules only", (t) => {
  if (!vmOrSkip(t)) return;
  const src = `
    globalThis.__turboModuleProxy("ExpoModulesCore").installModules();
    var mods = globalThis.expo.modules;
    if (mods.OptionalUpdates !== undefined) throw new Error("absent expo module must be undefined");
    var c = mods.ExponentConstants;
    if (c === undefined || c.executionEnvironment !== "bare" || c.manifest !== null) throw new Error("ExponentConstants constants");
  `;
  const r = bootTrace(src, { seed: 0, natives: deriveNativeManifest(TEXT, { present: { ExpoModulesCore: true } }) });
  assert.equal(r.reachedEnd, true, JSON.stringify(r.bootError));
});

test("export-boot L4: B2 drove RN's own LogBox surface (registered first) instead of the app key", async (t) => {
  if (!vmOrSkip(t)) return;
  const { observeRun } = await import("../../../src/harness/export-boot.ts");
  const src = `
    var AR = { registerComponent: function (k) { return k; }, runApplication: function () {} };
    __HBC_BOOT_PROBE__("enter", 1); __HBC_BOOT_PROBE__("exit", 1, AR);
    AR.registerComponent("LogBox"); AR.registerComponent("main");
    globalThis.RN$AppRegistry = AR;
  `;
  const r = bootTrace(src, { seed: 0, run: { horizonMs: 10 } });
  assert.equal(r.reachedEnd, true, JSON.stringify(r.bootError));
  assert.equal(observeRun(r.trace).runApplication, "main");
});
