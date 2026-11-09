// BUILDFAIL1: signature builders (confirm.ts + tools/pkgsig/bulk/build-one.mjs)
// lost ~25% of builds to (a) peers missing after the --legacy-peer-deps
// fallback, (b) Node built-ins Metro cannot resolve, (c) ENOSPC inotify
// watcher errors, (d) maxBuffer. Offline: pure plan + config evaluation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { test } from "node:test";
import { unresolvedBareModule, builderMetroConfigJs, bundleEnv, missingPeers, peerInstallArgv, builderConfigArgs } from "../../../src/deps/builder-support.ts";

function loadConfig(prev?: (c: unknown, n: string, p: string) => unknown) {
  const src = builderMetroConfigJs();
  const mod = { exports: {} as any };
  const merge = (a: any, b: any) => ({ ...a, resolver: { ...a.resolver, ...b.resolver } });
  const req = (n: string) => {
    if (n === "@react-native/metro-config") return { getDefaultConfig: () => ({ resolver: {} }), mergeConfig: merge };
    if (n === "./metro.config.js") return { resolver: prev ? { resolveRequest: prev } : {} };
    if (n === "path") return nodePath;
    if (n === "fs") return { existsSync: () => true, writeFileSync() {} };
    throw new Error("unexpected " + n);
  };
  new Function("require", "module", "__dirname", src)(req, mod, "/scratch");
  return mod.exports.resolver.resolveRequest as (ctx: any, name: string, platform: string) => any;
}

test("BUILDFAIL1(b): unresolvable Node built-ins map to an empty shim; real resolutions are untouched", () => {
  const resolve = loadConfig();
  const failing = { resolveRequest: (_c: unknown, n: string) => { throw new Error("Unable to resolve " + n); } };
  for (const n of ["os", "node:util", "module", "fs", "path", "crypto", "stream", "events", "fs/promises", "node:sqlite", "node:whatever"]) {
    assert.deepEqual(resolve(failing, n, "android"), { type: "sourceFile", filePath: "/scratch/hbc2js-node-shim.js" }, n);
  }
  assert.throws(() => resolve(failing, "expo-modules-core", "android"), /Unable to resolve/);
  const ok = { resolveRequest: () => ({ type: "sourceFile", filePath: "/nm/events/index.js" }) };
  assert.equal(resolve(ok, "events", "android").filePath, "/nm/events/index.js");
});

test("BUILDFAIL1(b): an existing resolveRequest in the project config is chained, not replaced", () => {
  const resolve = loadConfig(() => { throw new Error("prev failed"); });
  assert.equal(resolve({ resolveRequest: () => ({}) }, "os", "android").type, "sourceFile");
  assert.throws(() => resolve({}, "left-pad", "android"), /prev failed/);
});

test("BUILDFAIL1(a): non-optional absent peers are planned; optional, installed, react/react-native are not", () => {
  const peers = missingPeers(
    { peerDependencies: { "expo-modules-core": "*", "react-native-worklets": ">=0.5.0", react: "^18", "react-native": "*", "expo-font": "^13", opt: "1" }, peerDependenciesMeta: { opt: { optional: true } } },
    (n) => n === "expo-font",
  );
  assert.deepEqual(peers.map((p) => `${p.name}@${p.range}`), ["expo-modules-core@*", "react-native-worklets@>=0.5.0"]);
  const argv = peerInstallArgv("expo-asset@57.0.7", peers);
  assert.equal(argv[1], "expo-asset@57.0.7", "target repeated: --no-save installs prune the earlier target");
  assert.ok(argv.includes("react-native-worklets@>=0.5.0") && argv.includes("--ignore-scripts") && argv.includes("--no-save"));
  assert.deepEqual(missingPeers({}, () => false), []);
});

test("BUILDFAIL1(a2): the unresolved bare package is extracted from Metro output (scoped, deep path); built-ins and relatives are not", () => {
  const e = (m: string) => `error \x1b[31mUnable to resolve module ${m} from /s/node_modules/x/index.js: ${m} could not be found`;
  assert.equal(unresolvedBareModule(e("tslib")), "tslib");
  assert.equal(unresolvedBareModule(e("drizzle-orm/pg-core")), "drizzle-orm");
  assert.equal(unresolvedBareModule(e("@aws-sdk/client-sfn/dist")), "@aws-sdk/client-sfn");
  assert.equal(unresolvedBareModule(e("./Icon.js")), null);
  assert.equal(unresolvedBareModule(e("node:sqlite")), null);
  assert.equal(unresolvedBareModule(e("fs")), null);
  assert.equal(unresolvedBareModule("some other failure"), null);
});

test("BUILDFAIL1(c): bundle child env sets CI=true (Metro watcher off, no inotify) and keeps the rest", () => {
  const e = bundleEnv({ PATH: "/bin", CI: undefined });
  assert.equal(e.CI, "true");
  assert.equal(e.PATH, "/bin");
  assert.deepEqual(builderConfigArgs("/s"), ["--config", "/s/metro.hbc2js-builder.config.js"]);
});

test("BUILDFAIL1: both builders wire the support module (config, CI env, peers, maxBuffer)", () => {
  const bo = readFileSync(new URL("../../../tools/pkgsig/bulk/build-one.mjs", import.meta.url), "utf8");
  const cf = readFileSync(new URL("../../../src/deps/confirm.ts", import.meta.url), "utf8");
  for (const [name, s] of [["build-one", bo], ["confirm", cf]] as const) {
    assert.ok(/builderConfigArgs\(/.test(s), `${name}: --config`);
    assert.ok(/bundleEnv\(/.test(s), `${name}: CI env`);
    assert.ok(/missingPeers\(/.test(s), `${name}: peers`);
    assert.ok(name === "confirm" || /unresolvedBareModule\(/.test(s), `${name}: retry`);
    assert.ok(/builderMetroConfigJs\(/.test(s), `${name}: config written`);
  }
  assert.ok(/maxBuffer/.test(cf), "confirm: maxBuffer");
});

test("BUILDFAIL1: the path-rebuild transplant (transplant-multi) wires the support module too", () => {
  const tm = readFileSync(new URL("../../../tools/pkgsig/bulk/transplant-multi.mjs", import.meta.url), "utf8");
  assert.ok(/builderConfigArgs\(/.test(tm), "transplant-multi: --config");
  assert.ok(/bundleEnv\(/.test(tm), "transplant-multi: CI env");
  assert.ok(/missingPeers\(/.test(tm), "transplant-multi: peers");
  assert.ok(/unresolvedBareModule\(/.test(tm), "transplant-multi: retry");
  assert.ok(/builderMetroConfigJs\(/.test(tm), "transplant-multi: config written");
  assert.ok(/timeout: 300_000/.test(tm), "transplant-multi: 300 s per-job timeout");
});
