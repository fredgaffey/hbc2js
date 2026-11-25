// docs/specs/33-export-boot.md (0.1.2 apps): an HBC v98/v99 original
// decompiles to class private fields (`#e = undefined`), which the only
// prebuilt VMs (classic Hermes, HBC <= 96) reject at parse time ("private
// properties are not supported"), so the react-navigation example never
// booted. The boot harness lowers class syntax the executing engine lacks
// (Babel's spec-mode WeakMap/WeakSet lowering, the same transform on both
// sides) before running source mode or compiling with that engine's hermesc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findHermesVm } from "../../../src/harness/hermes-vm.ts";
import { bootTrace, classSyntaxSupported, lowerClassSyntax } from "../../../src/harness/boot-equiv.ts";
import { findHermesc } from "../../../src/harness/export-boot.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

const SRC = `
  class Base { #seen = 0; static #count = 0; static made() { return Base.#count; }
    constructor() { Base.#count++; }
    #bump() { return ++this.#seen; }
    get seen() { return this.#seen; }
    touch() { return this.#bump(); }
    static isBase(o) { return #seen in o; }
  }
  class Sub extends Base { #own = 7; own() { return this.#own; } }
  var s = new Sub(); s.touch(); s.touch();
  if (s.seen !== 2 || s.own() !== 7 || Base.made() !== 1 || !Base.isBase(s) || Base.isBase({})) throw new Error("private semantics");
`;

test("0.1.2 apps: lowerClassSyntax removes private members, keeping semantics", () => {
  const out = lowerClassSyntax(SRC, undefined);
  assert.ok(out !== null, "Babel is resolvable from hbc2js's own install in the repo");
  assert.ok(!/#seen|#own|#bump/.test(out!), out!.slice(0, 400));
  // Text without private syntax is returned unchanged (no Babel pass).
  assert.equal(lowerClassSyntax("var a = '#fff';", undefined), "var a = '#fff';");
});

test("0.1.2 apps: a classic VM (HBC 96) boots private class fields in source mode after lowering", (t) => {
  const vm = findHermesVm(96);
  if (vm === null) return t.skip("no v96 VM");
  if (classSyntaxSupported(vm.path, "vm")) return t.skip("this VM parses private fields natively");
  const r = bootTrace(SRC, { seed: 0, vm: vm.path });
  assert.equal(r.reachedEnd, true, JSON.stringify(r.bootError ?? r.why));
  assert.equal(r.lowered, true);
});

test("0.1.2 apps: the bytecode path lowers too when its hermesc lacks private fields (not a false 'export does not build')", (t) => {
  const c = findHermesc(96);
  if (c === null || c.version !== 96) return t.skip("no v96 hermesc + VM pair");
  if (classSyntaxSupported(c.hermesc, "hermesc")) return t.skip("this hermesc compiles private fields natively");
  const r = bootTrace(SRC, { seed: 0, vm: c.vm, hermesc: c.hermesc });
  assert.equal(r.reachedEnd, true, JSON.stringify(r.bootError ?? r.why));
  assert.equal(r.lowered, true);
});

test("0.1.2 apps: thousands of undeclared-global warnings do not hide a source-mode boot (hermes -w)", (t) => {
  const vm = findHermesVm(96);
  if (vm === null) return t.skip("no v96 VM");
  // Each warning echoes its 2 KB source line: on stderr without -w (over the 64 MB buffer); the run must still report.
  // Strict-mode code warns once per undeclared name (decompiled bundles do).
  const pad = " ".repeat(2000);
  const src = `(function () { "use strict";\n${Array.from({ length: 40000 }, (_, i) => `function f${i}() { return undeclaredGlobal${i}; }${pad}`).join("\n")}\n})();`;
  const r = bootTrace(src, { seed: 0, vm: vm.path, timeoutMs: 60000 });
  assert.equal(r.reachedEnd, true, JSON.stringify(r.why));
});

// 0.1.2 benchmark b2: bundle form (`equiv --boot app.hbc some/android.bundle`)
// resolved Babel only from hbc2js's own install (none from npm). Babel is
// resolved from the bundle's directory upward (nearest node_modules) first.
test("lowerClassSyntax resolves Babel from the nearest node_modules above fromDir (also relative)", () => {
  const top = mkdtempSync(join(tmpdir(), "hbc2js-lower-"));
  try {
    const mod = (name: string, body: string): void => {
      mkdirSync(join(top, "node_modules", name), { recursive: true });
      writeFileSync(join(top, "node_modules", name, "package.json"), JSON.stringify({ name, main: "index.js" }));
      writeFileSync(join(top, "node_modules", name, "index.js"), body);
    };
    mod("@babel/core", "exports.transformSync = () => ({ code: '/*from-bundle-dir*/' });");
    for (const p of ["class-static-block", "private-property-in-object", "private-methods", "class-properties", "classes"]) mod(`@babel/plugin-transform-${p}`, "module.exports = {};");
    const deep = join(top, "a", "b");
    mkdirSync(deep, { recursive: true });
    assert.equal(lowerClassSyntax(SRC, deep), "/*from-bundle-dir*/");
    assert.equal(lowerClassSyntax(SRC, relative(process.cwd(), deep)), "/*from-bundle-dir*/");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});
