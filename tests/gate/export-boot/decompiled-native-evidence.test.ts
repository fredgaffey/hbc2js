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
  assert.deepEqual(deriveNativeManifest(src).present.ExponentConstants!.manifest, { name: "app", slug: "app", scheme: "hbc2jsboot", android: { package: "com.hbc2js.boot" } });
  const real = { name: "Real", slug: "real", scheme: "real" };
  assert.deepEqual(deriveNativeManifest(src, { present: { ExponentConstants: { manifest: real } } }).present.ExponentConstants!.manifest, real);
  // A bare app that never reads expoConfig keeps the bare default.
  assert.equal(deriveNativeManifest(src.replace("default.expoConfig", "default.sessionId")).present.ExponentConstants!.manifest, null);
});

test("0.1.2 apps: a decompiled library spec module (`…(\"X\");return _.default=p,c},id,[`) is present; an assigned-argument optional probe is not", () => {
  const src = [
    `__d(function(g,r,i,a,m,e,d){Object.defineProperty(_,"__esModule",{value:!0});var c=void 0;_.default=c;var p=(0,t(v[0]).requireOptionalNativeModule)("ExponentConstants");return _.default=p,c},551,[269]);`,
    `__d(function(g,r,i,a,m,e,d){var O=A[2];O=(0,(O=S(O)).requireOptionalNativeModule)(O="ExpoUpdates"),E=O;return c},552,[269]);`,
  ].join("\n");
  const m = deriveNativeManifest(src);
  assert.ok("ExponentConstants" in m.present);
  assert.ok(!("ExpoUpdates" in m.present));
});

test("0.1.2 apps: the readable whole-file decompile's spec module (`let v = requireOptionalNativeModule(\"X\"); list[\"default\"] = v; return r0; }`) is present", () => {
  const src = `function _fn5723(a1, a2, a3, a4, a5, a6, a7) {
      let list = a6;
      Object.defineProperty(list, "__esModule", {value: true});
      let r0 = undefined;
      list["default"] = r0;
      let requireOptionalNativeModule = a2(a7[0]).requireOptionalNativeModule;
      let requireOptionalNativeModule2 = requireOptionalNativeModule("ExponentConstants");
      list["default"] = requireOptionalNativeModule2;
      return r0;
    }
    function _fn5724(a1, a2) { let u = a2(0).requireOptionalNativeModule("ExpoUpdates"); if (u) { u.x(); } return u; }`;
  const m = deriveNativeManifest(src);
  assert.ok("ExponentConstants" in m.present);
  assert.ok(!("ExpoUpdates" in m.present));
});

// The same chain in the readable decompile `equiv --boot` boots (statements in
// labelled blocks; the name hoisted by its own statement).
const ASYNC_STORAGE_READABLE = `__d(function _fn1240(a1, a2, a3, a4, a5, a6, a7) {
      let r0, r1, r3, r5, r7, r9;
      L0: {
        r5 = a2(a7[0]);
        if (r5.TurboModuleRegistry) {
          L1: {
            r3 = r5.TurboModuleRegistry.get("PlatformLocalStorage");
            if (r3) {
              break L1;
            }
            r9 = r5.TurboModuleRegistry;
            r7 = "RNC_AsyncSQLiteDBStorage";
            r3 = r9.get(r7);
            break L1;
          }
          L2: {
            if (r3) {
              break L2;
            }
            r9 = r5.TurboModuleRegistry;
            r7 = "RNCAsyncStorage";
            r3 = r9.get(r7);
            break L2;
          }
          r1 = r3;
          break L0;
        }
        L3: {
          r1 = r5.NativeModules.PlatformLocalStorage;
          if (r1) {
            break L3;
          }
          r3 = r5.NativeModules;
          r1 = r3.RNC_AsyncSQLiteDBStorage;
          break L3;
        }
        r1 = r1 || (r3 = r5.NativeModules, r3.RNCAsyncStorage);
        break L0;
      }
      r3 = !r1;
      a6["default"] = r1;
    }, 1239, [3]);`;

test("0.1.2 apps: the readable decompile's lookup chain (labelled blocks, hoisting statement) keeps its tail module", () => {
  const ev = bundleEvidence(ASYNC_STORAGE_READABLE);
  assert.ok(ev.required.has("RNCAsyncStorage"), [...ev.required].join(","));
  const m = deriveNativeManifest(ASYNC_STORAGE_READABLE);
  assert.ok("RNCAsyncStorage" in m.present);
  for (const n of ["PlatformLocalStorage", "RNC_AsyncSQLiteDBStorage"]) assert.ok(!(n in m.present), `${n} absent`);
});

// 0.1.2 corpus stub-host gaps, as the readable decompile of each original
// renders them.

// a06 (Notifee, factory 494/496): the module config names the native module;
// the getter reads `NativeModules[config.nativeModuleName]` and throws.
const NOTIFEE_CONFIG = `__d(function _fn5530(a1, a2, a3, a4, a5, a6, a7) {
    r7 = {};
    r8 = r4(r8);
    r8 = r8.version;
    r7.version = r8;
    r8 = "NotifeeApiModule";
    r7.nativeModuleName = r8;
    r11 = 2;
}, 494, [1]);`;

test("corpus a06: a library config's nativeModuleName (Invertase NativeModule base) is required; compact `nativeModuleName:\"X\"` too", () => {
  assert.ok(bundleEvidence(NOTIFEE_CONFIG).required.has("NotifeeApiModule"));
  assert.ok(bundleEvidence(`__d(function(g,r,i,a,m,e,d){var c={version:"7.9.0",nativeModuleName:"NotifeeApiModule"}},494,[]);`).required.has("NotifeeApiModule"));
  // A different register on the hoisting line is not the same name.
  assert.ok(!bundleEvidence(`r8 = "Other";\n r7.nativeModuleName = r9;`).required.has("Other"));
});

// a08 (RN 0.66, async-storage 1.x): a NativeModules-only property chain.
const ASYNC_STORAGE_LEGACY = `__d(function _fn10954(a1, a2, a3, a4, a5, a6, a7) {
  let r0, r1, list, NativeModules;
  L0: {
    list = a6;
    NativeModules = a2(a7[0]).NativeModules;
    r1 = NativeModules.PlatformLocalStorage;
    if (r1) {
      break L0;
    }
    r1 = NativeModules.RNC_AsyncSQLiteDBStorage;
    break L0;
  }
  L1: {
    if (r1) {
      break L1;
    }
    r1 = NativeModules.RNCAsyncStorage;
    break L1;
  }
  list["default"] = r1;
  return r0;
}, 946, [5]);`;

test("corpus a08: the tail of a legacy NativeModules.A || .B || .C chain is required; the probes stay absent", () => {
  const ev = bundleEvidence(ASYNC_STORAGE_LEGACY);
  assert.ok(ev.required.has("RNCAsyncStorage"));
  assert.ok(!ev.required.has("PlatformLocalStorage") && !ev.spec.has("PlatformLocalStorage"));
  assert.ok(!ev.required.has("RNC_AsyncSQLiteDBStorage"));
  const compact = bundleEvidence(`__d(function(o,t,u,l,s,c,y){var R,M,b;b=v(N[0]);(M=b.NativeModules.PlatformLocalStorage)||(M=(R=b.NativeModules).RNC_AsyncSQLiteDBStorage),M=M||(R=b.NativeModules).RNCAsyncStorage,R=!M;c.default=M},946,[5]);`);
  assert.ok(compact.required.has("RNCAsyncStorage"));
  assert.ok(!compact.required.has("RNC_AsyncSQLiteDBStorage"));
  // A guard read is not evidence.
  assert.ok(!bundleEvidence(`__d(function(g,r,i,a,m,e,d){if(r(d[0]).NativeModules.Foo&&x)y()},1,[]);`).required.has("Foo"));
});

// a09 (react-native-blob-util's spec, factory 1003): `export default
// TurboModuleRegistry.get("X")` as a live binding read by a default getter.
const BLOB_UTIL_SPEC = `__d(function _fn1005(a1, a2, a3, a4, a5, a6, a7) {
      let _e1130_0;
      let r6 = a6;
      Object.defineProperty(r6, "default", {enumerable: true, get: function get() {
        // fn#6477 "get"
        "use strict";
        return _e1130_0;
      }});
      let r3 = a7[0];
      let r0 = undefined;
      let TurboModuleRegistry = a2(r3).TurboModuleRegistry;
      let get2 = TurboModuleRegistry.get("ReactNativeBlobUtil");
      _e1130_0 = get2;
      return r0;
    }, 1003, [3]);`;

test("corpus a09: a spec module exported as a live binding (default getter) is present", () => {
  assert.ok(bundleEvidence(BLOB_UTIL_SPEC).spec.has("ReactNativeBlobUtil"));
  // Stored into a variable no getter returns: not a spec export.
  assert.ok(!bundleEvidence(BLOB_UTIL_SPEC.replace("return _e1130_0;", "return other;")).spec.has("ReactNativeBlobUtil"));
});
