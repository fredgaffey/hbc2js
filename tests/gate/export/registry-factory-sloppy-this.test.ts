// BlueWallet boot DIVERGENT at entry 920 (fix-batch-012c): a UMD polyfill
// module (text-encoding) installs `TextDecoder` onto its factory's sloppy
// `this` (`(function (global) { ... global.TextDecoder = ... }(this || {}))`,
// which hermesc inlines into the factory as `LoadThisNS`). Metro's require
// calls a factory plainly, so a sloppy factory's `this` is the global object.
// The export registry called it as a METHOD, `entry.factory(...)`, so `this`
// was the registry entry: the polyfill installed onto `{factory, deps}` and a
// later module's bare `TextDecoder` read threw ReferenceError.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRegistryJs } from "../../../src/export/registry.ts";
import { findHermesVm, runHermes } from "../../../src/harness/hermes-vm.ts";

function program(instrument: boolean): string {
  return [
    "var module = { exports: {} };",
    "(function (module, exports) {",
    buildRegistryJs(new Map(), instrument),
    "})(module, module.exports);",
    "var reg = module.exports;",
    // module 0: the UMD polyfill, a sloppy factory installing onto `this`
    "reg.define(function (global, require, a, b, mod, exports) {",
    "  var g = this || {};",
    "  if (!g.HbcPolyfilled) g.HbcPolyfilled = function () { return 939838618; };",
    "}, 0, []);",
    // module 1: reads the global the polyfill installed
    "reg.define(function (global, require, a, b, mod, exports) {",
    "  require(0);",
    "  mod.exports = HbcPolyfilled();",
    "}, 1, []);",
    "print(reg.r(1));",
  ].join("\n");
}

for (const instrument of [false, true]) {
  test(`export registry: a sloppy factory's this is the global object (instrument=${instrument})`, (t) => {
    const src = program(instrument);
    // Node: the program's own semantics (the expected value).
    const lines: string[] = [];
    new Function("print", src)((s: unknown) => lines.push(String(s)));
    assert.deepEqual(lines, ["939838618"]);
    const vm = findHermesVm(99) ?? findHermesVm(98) ?? findHermesVm(96);
    if (vm === null) return t.skip("no Hermes VM (tools/hermes-vm)");
    const dir = mkdtempSync(join(tmpdir(), "hbc2js-reg-this-"));
    const file = join(dir, "p.js");
    writeFileSync(file, src);
    const out = runHermes(vm.path, file);
    assert.equal(out.ok, true, out.raw);
    assert.deepEqual(out.lines, ["939838618"]);
  });
}

test("split loader: calls a module factory plainly too (same Metro protocol)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../../src/split/index.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("entry.factory("), "split loader still calls entry.factory(...) as a method");
  assert.ok(src.includes("  factory(globalThis, requireFn,"));
});
