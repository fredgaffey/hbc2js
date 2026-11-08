// ACCEPTANCE + REGRESSION: explicit derived constructors (fixture
// 88-derived-ctor-shapes), from the docs/BUGS.md row "E2E tier 1 -- bucket
// `diff:GetOwnPrivateBySym/GetByVal`" and docs/specs/passes/26-ctor-this.md
// section 10 (the derived-`super` rung, which is `super-call`'s, spec 28).
//
// Building this fixture found a lowering bug, not a rung gap: when hermesc
// hands `CreateDerivedClass` the SAME register as destination and superclass
// (`CreateDerivedClass r4, r3, r2, r4, 3` -- an arrow class field plus an
// inlined `new` in the defining frame is enough to trigger it), the emitter
// wrote the constructor into the register before reading the superclass out
// of it, so the output called `Object.setPrototypeOf(r4, r4)` and threw
// "Cyclic __proto__ value" at --passes=none and on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { decompile } from "../../../src/decompile.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";
import { repoRoot } from "../../support/paths.ts";

const FIXTURE = "88-derived-ctor-shapes";
const ALIAS = "89-derived-class-super-register-alias";
const dirOf = (f: string): string => join(repoRoot(), "tests", "fixtures", "constructs", f);
const js = (version: "v98" | "v99", mode: "on" | "none", fixture: string = FIXTURE): string =>
  decompile(new Uint8Array(readFileSync(join(dirOf(fixture), `${version}.hbc`))), {
    resolveV98Ambiguity: true,
    passes: mode === "none" ? { none: true } : {},
  }).code;
const run = (code: string): string => {
  const out: string[] = [];
  runInNewContext(code, { print: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  return out.join("\n") + "\n";
};
const ctorOf = (code: string, className: string): string => {
  const c = code.indexOf(`class ${className} `);
  assert.notEqual(c, -1, `no class ${className} in the decompiled output`);
  const i = code.indexOf("constructor(", c);
  const j = code.indexOf("\n  }\n", i);
  assert.ok(i !== -1 && j !== -1, `class ${className}'s constructor is not delimited as expected`);
  return code.slice(i, j);
};

test(`derived-ctor (BUGS GetOwnPrivateBySym row): ${FIXTURE} and ${ALIAS} are PASS under T2 at v98 and v99`, async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, versions: [98, 99], only: [FIXTURE, ALIAS] });
  assert.equal(report.results.length, 4);
  for (const r of report.results) assert.equal(r.verdict, VERDICT.PASS, `${r.fixture.name}: ${r.oracles.map((o) => `${o.oracle}=${o.verdict} ${o.detail ?? ""}`).join(" ")}`);
});

for (const version of ["v98", "v99"] as const) {
  for (const fixture of [FIXTURE, ALIAS]) {
    const expected = readFileSync(join(dirOf(fixture), "expected.txt"), "utf8");
    for (const mode of ["none", "on"] as const) {
      test(`derived-ctor (CreateDerivedClass dst == superclass register): ${fixture} ${version} --passes=${mode} runs and prints expected.txt`, () => {
        assert.equal(run(js(version, mode, fixture)), expected);
      });
    }
  }

  test(`derived-ctor: ${FIXTURE} ${version} -- Cond's CreateDerivedClass aliases its superclass register, and the class is still recovered`, () => {
    // --passes=none shows the pre-head link pair the lowering now emits for
    // an aliased superclass register (dst r2 == superclass r2 here)...
    assert.match(js(version, "none"), /Object\.setPrototypeOf\((_fn\d+), (r\d+)\);\n\s+Object\.setPrototypeOf\(\1\.prototype, \2 === null \? null : \2\.prototype\);\n\s+\2 = \1;/);
    // ...and class-recover takes that pair as the class's `extends` link
    // (spec 24 section 8), so the output is a real class again.
    const on = js(version, "on");
    assert.match(on, /class Cond extends /);
    assert.doesNotMatch(on, /Object\.setPrototypeOf\(_fn\d+/);
  });

  test(`derived-ctor: ${FIXTURE} ${version} -- every unconditional super(...) is rebuilt, the conditional one is refused`, () => {
    const on = js(version, "on");
    for (const name of ["Plain", "Fields", "Arrow", "Before"]) {
      const ctor = ctorOf(on, name);
      assert.equal(ctor.split(/\n\s+super\(/).length - 1, 1, `${name}: exactly one rebuilt super(...)`);
      assert.doesNotMatch(ctor, /Reflect\.construct|getPrototypeOf|super\(\) called twice/, name);
      assert.doesNotMatch(ctor, /this = /, name);
    }
    // Code before super(...) stays before it, and touches no receiver.
    assert.match(ctorOf(on, "Before"), /print\("before super"[^]*\n\s+super\(/);
    // A conditional super is two Construct sites, not one statement: refused
    // (R-SC2), the lowering survives untouched.
    const cond = ctorOf(on, "Cond");
    assert.match(cond, /Reflect\.construct/);
    assert.doesNotMatch(cond, /\n\s+super\(/);
  });
}
