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

test("export-boot apps: a library whose absent fallback is a throwing `new Proxy` (linking-error template) is present", () => {
  // Expensify, react-native-key-command: `t=n.NativeModules.KeyCommand?
  // n.NativeModules.KeyCommand:new Proxy({},{get(){throw new Error(o)}})`.
  // Read as a conditional probe it was absent, so the original's factory
  // threw "doesn't seem to be linked" under the stub host (INCONCLUSIVE).
  const src = [
    "__d(function(g,r,i,a,m,e,d){var t=n.NativeModules.KeyCommand?n.NativeModules.KeyCommand:new Proxy({},{get(){throw new Error(o)}});e.default=t},1333,[21]);",
    "__d(function(g,r,i,a,m,e,d){var M=NativeModules.RNFoo ? NativeModules.RNFoo : new Proxy({}, {get() { throw new Error(L) }});},1,[]);",
    "__d(function(g,r,i,a,m,e,d){var M=NativeModules.Probe ? 1 : 2},2,[]);",
  ].join("\n");
  const ev = bundleEvidence(src);
  assert.ok(ev.required.has("KeyCommand"));
  assert.ok(ev.required.has("RNFoo"));
  assert.ok(!ev.required.has("Probe") && !ev.spec.has("Probe"));
  assert.ok("KeyCommand" in deriveNativeManifest(src).present);
});

test("export-boot apps: an app module bound once and dereferenced unguarded at module eval is present", () => {
  // Expensify BootSplash: `n=r(d[2]).NativeModules.BootSplash;
  // e.default={…,logoSizeRatio:n.logoSizeRatio||1}` threw "Cannot read
  // property 'logoSizeRatio' of undefined" in the original (INCONCLUSIVE).
  const src = [
    "__d(function(g,r,i,a,m,e,d){var t=o(r(d[1])),n=r(d[2]).NativeModules.BootSplash;e.default={hide:function(){return n.hide()},logoSizeRatio:n.logoSizeRatio||1}},3604,[1]);",
    "__d(function(g,r,i,a,m,e,d){var x=r(d[0]).NativeModules.EXDevLauncher;e.f=function(){return x?x.open():null}},5,[]);",
    "__d(function(g,r,i,a,m,e,d){var y=r(d[0]).NativeModules.Opt;if(y){y.go()}},6,[]);",
    // react-native-device-info: guarded only to throw when missing.
    "__d(function(g,r,i,a,m,e,d){var o=r(d[0]),t=o.NativeModules.RNDeviceInfo;if('web'!==o.Platform.OS||(t=r(d[1])),!t&&('android'===o.Platform.OS))throw new Error(\"RNDeviceInfo is null\");e.default=t},1752,[21]);",
  ].join("\n");
  const ev = bundleEvidence(src);
  assert.ok(ev.required.has("BootSplash"));
  assert.ok(!ev.required.has("EXDevLauncher"), "guarded with ?");
  assert.ok(!ev.required.has("Opt"), "guarded with if");
  assert.ok(ev.required.has("RNDeviceInfo"), "throws when missing");
  // netinfo: the module comes from another factory; the error names it.
  const net = bundleEvidence("__d(function(g,r,i,a,m,e,d){var o=t(r(d[2]));if(!o.default)throw new Error(\"@react-native-community/netinfo: NativeModule.RNCNetInfo is null. To fix this issue try these steps\")},2245,[]);");
  assert.ok(net.required.has("RNCNetInfo"));
});

test("export-boot apps: a device promise method (Linking.getInitialURL) resolves under the stub host", (t) => {
  // Expensify module 3172 runs `Linking.getInitialURL().then(…)` at module
  // eval; the stub returned undefined and the original threw "Cannot read
  // property 'then' of undefined" (INCONCLUSIVE).
  if (!vmOrSkip(t)) return;
  const src = `
    var p = globalThis.__turboModuleProxy("IntentAndroid").getInitialURL();
    if (p === undefined || typeof p.then !== "function") throw new Error("getInitialURL must return a Promise");
  `;
  const r = bootTrace(src, { seed: 0, natives: deriveNativeManifest("") });
  assert.equal(r.reachedEnd, true, JSON.stringify(r.bootError));
});

test("export-boot apps: NitroModules.install() installs globalThis.NitroModulesProxy under the stub host", (t) => {
  // Expensify module 20 (react-native-nitro-modules) calls
  // `getEnforcing('NitroModules').install()` and then reads
  // `global.NitroModulesProxy`; it was null and the original threw
  // "Failed to get NitroModules" (INCONCLUSIVE).
  if (!vmOrSkip(t)) return;
  const src = `
    var r = globalThis.__turboModuleProxy("NitroModules").install();
    if (r != null) throw new Error("install must return nothing");
    var n = globalThis.NitroModulesProxy;
    if (n == null) throw new Error("NitroModulesProxy missing");
    var h = n.createHybridObject("NitroFetch");
    if (h == null) throw new Error("hybrid object missing");
  `;
  const r = bootTrace(src, { seed: 0, natives: deriveNativeManifest("x.getEnforcing('NitroModules')") });
  assert.equal(r.reachedEnd, true, JSON.stringify(r.bootError));
});

test("export-boot apps: the stub host provides an Intl namespace for module-eval polyfills", (t) => {
  // Expensify module 3088 (@formatjs/intl-locale polyfill) runs
  // `Object.defineProperty(Intl,'Locale',…)`; the host VM has no Intl, so
  // the original threw "Property 'Intl' doesn't exist" (INCONCLUSIVE).
  if (!vmOrSkip(t)) return;
  const src = `Object.defineProperty(Intl, "Locale", { value: function () {}, writable: true, enumerable: false, configurable: true });`;
  const r = bootTrace(src, { seed: 0, natives: deriveNativeManifest("") });
  assert.equal(r.reachedEnd, true, JSON.stringify(r.bootError));
});
