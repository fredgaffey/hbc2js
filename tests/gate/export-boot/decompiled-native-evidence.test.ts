// docs/specs/33-export-boot.md (0.1.2 apps): native-module evidence in a
// DECOMPILED original (an `.hbc` input, no Metro text). The decompiler hoists
// string arguments into registers and lowers `?.` / `||` chains to explicit
// assignments, so the Metro-text shapes of native-manifest.ts's rules missed
// three real apps' modules (Expo `ExpoLinking`, `@react-native-async-storage`).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAllHermesVms } from "../../../src/harness/hermes-vm.ts";
import { bootTrace } from "../../../src/harness/boot-equiv.ts";
import { bundleEvidence, deriveNativeManifest, overrideFor } from "../../../src/harness/native-manifest.ts";

function vmOrSkip(t: TestContext): boolean {
  if (findAllHermesVms().length > 0) return true;
  t.skip("no Hermes VM");
  return false;
}

// expo-modules-core's ensureNativeModulesAreInstalled + an Expo module's own
// spec, as hbc2js decompiles them (Ignite app, factories 269 and 960).
const EXPO = [
  `__d(function(g,r,i,a,m,e,d){var t,u,l;e:try{t=(u=f.TurboModuleRegistry.get("ExpoModulesCore"))==(t=null)?t:u.installModules();break e}catch(t){l=t}},268,[6]);`,
  `__d(function(g,r,i,a,m,e,d){var p=(0,u(l[0]).requireNativeModule)("ExpoLinking");return _.default=p,c},960,[269]);`,
].join("\n");

// @react-native-async-storage's lookup chain, decompiled (BlueWallet factory 1239).
const ASYNC_STORAGE = `__d(function(o,t,u,l,s,c,y){var R,M,L,b;(b=v(N[0])).TurboModuleRegistry?((R=b.TurboModuleRegistry.get("PlatformLocalStorage"))||(L="RNC_AsyncSQLiteDBStorage",R=b.TurboModuleRegistry.get(L)),R||(L="RNCAsyncStorage",R=b.TurboModuleRegistry.get(L)),M=R):((M=b.NativeModules.PlatformLocalStorage)||(M=(R=b.NativeModules).RNC_AsyncSQLiteDBStorage),M=M||(R=b.NativeModules).RNCAsyncStorage),R=!M;if(R)throw new Error("[@RNC/AsyncStorage]: NativeModule: AsyncStorage is null.")},1239,[3]);`;

test("0.1.2 apps: a decompiled `get(X)==null?…:u.installModules()` installer is required, and any required Expo module implies ExpoModulesCore", () => {
  const ev = bundleEvidence(EXPO);
  assert.ok(ev.required.has("ExpoModulesCore"), "the decompiled installer shape is evidence");
  assert.ok(ev.required.has("ExpoLinking"));
  // Without the installer factory, a required Expo module still implies the
  // JSI installer that provides it (expo-modules-core is its native half).
  const only = deriveNativeManifest(EXPO.split("\n")[1]!);
  assert.ok("ExpoModulesCore" in only.present, "requireNativeModule('X') implies ExpoModulesCore");
});

test("0.1.2 apps: a decompiled lookup chain (string hoisted into a register) keeps its tail module; the probes stay absent", () => {
  const ev = bundleEvidence(ASYNC_STORAGE);
  assert.ok(ev.required.has("RNCAsyncStorage"), [...ev.required].join(","));
  const m = deriveNativeManifest(ASYNC_STORAGE);
  assert.ok("RNCAsyncStorage" in m.present);
  for (const n of ["PlatformLocalStorage", "RNC_AsyncSQLiteDBStorage"]) assert.ok(!(n in m.present), `${n} absent`);
});

test("0.1.2 apps: an Expo module boots from a decompiled original (installModules reached, expo.modules answers it)", (t) => {
  if (!vmOrSkip(t)) return;
  const src = `
    var TurboModuleRegistry = { get: function (n) { return globalThis.__turboModuleProxy(n); } };
    var u, t;
    t = (u = TurboModuleRegistry.get("ExpoModulesCore")) == (t = null) ? t : u.installModules();
    var mod = globalThis.expo && globalThis.expo.modules && globalThis.expo.modules.ExpoLinking;
    if (!mod) throw new Error("Cannot find native module 'ExpoLinking'");
  `;
  const r = bootTrace(src, { seed: 0, natives: deriveNativeManifest(EXPO.split("\n")[1]!) });
  assert.equal(r.reachedEnd, true, JSON.stringify(r.bootError ?? r.why));
});

test("0.1.2 apps: a boot-native.json that names only an Expo module makes it reachable (implies ExpoModulesCore)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-boot-native-"));
  writeFileSync(join(dir, "boot-native.json"), JSON.stringify({ present: { ExpoLinking: { initialUrl: null } } }));
  const ov = overrideFor(join(dir, "app.hbc"));
  assert.ok(ov !== undefined);
  // expo-modules-core shipped, its lookup in a probe-only shape (no rule-3
  // evidence of its own): an app that bundles expo-modules-core links it.
  const m = deriveNativeManifest(`__d(function(g,r,i,a,m,e,d){var o=(()=>{try{return n.get("ExpoModulesCore")}catch{return null}})()},5,[]);`, ov);
  assert.ok("ExpoLinking" in m.present);
  assert.ok("ExpoModulesCore" in m.present, "expo-modules-core in the bundle means its native half is linked");
});

test("0.1.2 apps: an Expo-built app reads an embedded app config (expo-linking throws at module eval without one); boot-native.json can supply the real one", () => {
  const src = `__d(function(g,r,i,a,m,e,d){var c=(0,r(d[0]).requireOptionalNativeModule)('ExponentConstants')},15,[6]);\n__d(function(g,r,i,a,m,e,d){var x=r(d[0]).default.expoConfig},16,[15]);`;
  assert.deepEqual(deriveNativeManifest(src).present.ExponentConstants!.manifest, { name: "app", slug: "app", android: { package: "com.hbc2js.boot" } });
  const real = { name: "Real", slug: "real", scheme: "real" };
  assert.deepEqual(deriveNativeManifest(src, { present: { ExponentConstants: { manifest: real } } }).present.ExponentConstants!.manifest, real);
  // A bare app that never reads expoConfig keeps the bare default.
  assert.equal(deriveNativeManifest(src.replace("default.expoConfig", "default.sessionId")).present.ExponentConstants!.manifest, null);
});
