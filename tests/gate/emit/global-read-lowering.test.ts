// Regression test for docs/BUGS.md's 2026-09-21 row "src/emit global-access":
// Hermes has one opcode for a guarded global read (`TryGetById` -- read the
// global, throw a `ReferenceError` if it's absent, with the throw built into
// the opcode itself, no separate `Throw` instruction needed), and the
// decompiler should prefer the bare identifier form that recompiles back to
// it over the explicit `r1 = globalThis; if (!("p" in r1)) throw ...; r0 =
// r1.p;` scaffolding -- EXCEPT where nothing proves it safe, since a wrong
// bare fold silently changes which binding a read observes. Both halves of
// that bar are exercised here, over the real fixture at all five HBC
// versions, with EXACT opcode counts (not just a textual match):
//  - `unshadowed` folds to a bare identifier and recompiles to the exact
//    same TryGetById/GetByIdShort sequence the original compiled to, with
//    ZERO Throw opcodes either side (the guard's throw is never needed, so
//    it costs nothing once folded);
//  - `loopy`'s two reads (`Reflect`, `String`) are refused (see that
//    fixture's source.js for why: applying the fold would leave a register
//    read before its first definition in the rewritten statement list --
//    the pass ladder's own post-rewrite soundness check, not specific to
//    global-access's own refuse reasons, but the exact same kind of guard
//    this fixture exists to prove: an unsafe fold is abandoned rather than
//    risked), and the guard survives at every version -- which means
//    recompiling it costs 2 real `Throw` opcodes the ORIGINAL never had
//    (TryGetById's own throw is intrinsic to the opcode; a JS-level `throw`
//    statement is not). That inflation is the measured, accepted cost of
//    correctly refusing an unsafe fold, not a bug in this test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { requireHermesc, runHermesc } from "../../support/hermesc.ts";
import type { HbcVersion } from "../../support/hermesc.ts";
import { decompile } from "../../../src/decompile.ts";
import { decodeModule } from "../../../src/disasm/decode.ts";
import { parseHbc } from "../../../src/parse/module.ts";

const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "86-global-read-lowering");
const VERSIONS: readonly HbcVersion[] = [84, 94, 96, 98, 99];

/** Opcode-name histogram for exactly ONE named function in `bytes`. */
function opcodeHistogram(bytes: Uint8Array, fnName: string): Map<string, number> {
  const mod = parseHbc(bytes);
  const hist = new Map<string, number>();
  for (const fn of decodeModule(mod)) {
    if (fn.name !== fnName) continue;
    for (const insn of fn.instructions) hist.set(insn.name, (hist.get(insn.name) ?? 0) + 1);
  }
  return hist;
}

function count(hist: ReadonlyMap<string, number>, name: string): number {
  return hist.get(name) ?? 0;
}

/**
 * `globalThis` is not a keyword to Hermes: `src/emit/lower.ts`'s
 * `GetGlobalObject` case prints the literal identifier `globalThis`
 * (docs/specs/05-emitter.md), which is faithful (the property really is
 * self-referential and can never be missing or shadowed) but not opcode-
 * for-opcode round-trip-stable on its own -- recompiling a bare `globalThis`
 * reference costs its OWN `TryGetById "globalThis"` (measured directly:
 * hermesc has no dedicated "the global object, please" expression form; it
 * compiles the identifier `globalThis` the same way it compiles any other
 * free identifier). That is a separate, pre-existing fidelity gap from the
 * one this test is about -- `loopy`'s own guard needs a real reference to
 * the global object to test `"p" in ...` against, so it keeps exactly one
 * literal `globalThis` per version, and this helper accounts for the
 * `TryGetById` that literal costs on recompile rather than mistaking it for
 * a regression in the fold this test actually exercises.
 */
function countLiteralGlobalThis(code: string, fnName: string): number {
  const marker = `function ${fnName}(`;
  const start = code.indexOf(marker);
  if (start === -1) return 0;
  let depth = 0;
  let bodyStart = -1;
  let i = start;
  for (; i < code.length; i++) {
    if (code[i] === "{") {
      depth++;
      if (bodyStart === -1) bodyStart = i;
    } else if (code[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = code.slice(bodyStart, i + 1);
  return (body.match(/\bglobalThis\b/g) ?? []).length;
}

for (const version of VERSIONS) {
  const hbcPath = join(FIXTURE, `v${version}.hbc`);

  test(`global-read lowering v${version}: unshadowed read folds to a bare identifier, unsafe-to-fold guard survives`, (t) => {
    if (!existsSync(hbcPath)) {
      t.skip(`fixture not built for v${version} - run tests/fixtures/build.sh (INCONCLUSIVE, not a failure)`);
      return;
    }
    const code = decompile(new Uint8Array(readFileSync(hbcPath)), {}).code;

    // --- unshadowed: no guard scaffolding survives for "Error". ---------
    assert.ok(!code.includes(`Property 'Error' doesn't exist`), `v${version}: unshadowed's guard should have folded away, got:\n${code}`);
    assert.match(code, /\bError\.name\b/, `v${version}: expected a bare "Error.name" read in the decompiled output`);

    // --- loopy: the guard survives for BOTH reads it cannot prove safe. --
    assert.ok(code.includes(`Property 'Reflect' doesn't exist`), `v${version}: loopy's Reflect guard should have survived (not provably safe to fold), got:\n${code}`);
    assert.ok(code.includes(`Property 'String' doesn't exist`), `v${version}: loopy's String guard should have survived (not provably safe to fold), got:\n${code}`);
  });

  test(`global-read lowering v${version}: recompile round trip reproduces the original's TryGetById/Throw opcode counts`, (t) => {
    const h = requireHermesc(t, version);
    if (h === null) return;
    if (!existsSync(hbcPath)) {
      t.skip(`fixture not built for v${version} - run tests/fixtures/build.sh (INCONCLUSIVE, not a failure)`);
      return;
    }
    const originalBytes = new Uint8Array(readFileSync(hbcPath));
    const code = decompile(originalBytes, {}).code;

    const dir = mkdtempSync(join(tmpdir(), "hbc2js-global-read-lowering-"));
    const srcPath = join(dir, "recompiled.js");
    const outPath = join(dir, "recompiled.hbc");
    writeFileSync(srcPath, code);
    const result = runHermesc(h, ["-emit-binary", "-out", outPath, srcPath], dir);
    assert.equal(result.status, 0, `v${version}: recompiling the decompiled output failed:\n${result.stderr}`);
    const recompiledBytes = new Uint8Array(readFileSync(outPath));

    // --- unshadowed: fully folded -> exact round trip, zero Throw either side.
    {
      const before = opcodeHistogram(originalBytes, "unshadowed");
      const after = opcodeHistogram(recompiledBytes, "unshadowed");
      const tax = countLiteralGlobalThis(code, "unshadowed");
      assert.equal(tax, 0, `v${version}: unshadowed should have folded away its only globalThis reference`);
      assert.equal(count(before, "TryGetById"), 1, `v${version}: premise - unshadowed's original should compile "Error" via exactly one TryGetById`);
      assert.equal(count(after, "TryGetById"), count(before, "TryGetById"), `v${version}: unshadowed's TryGetById count should round-trip exactly (before ${count(before, "TryGetById")}, after ${count(after, "TryGetById")})`);
      assert.equal(count(before, "Throw"), 0, `v${version}: premise - TryGetById's own throw is never a separate Throw opcode`);
      assert.equal(count(after, "Throw"), 0, `v${version}: a fully-folded read should cost zero Throw opcodes on recompile, got ${count(after, "Throw")}`);
    }

    // --- loopy: both guards refused -> guard scaffolding round-trips too,
    // at the accepted cost of 2 real Throw opcodes the original never paid.
    {
      const before = opcodeHistogram(originalBytes, "loopy");
      const after = opcodeHistogram(recompiledBytes, "loopy");
      const tax = countLiteralGlobalThis(code, "loopy");
      assert.equal(tax, 1, `v${version}: loopy should keep exactly one literal globalThis reference (feeding both surviving guards)`);
      assert.equal(count(before, "TryGetById"), 2, `v${version}: premise - loopy's original should compile "Reflect"+"String" via exactly two TryGetById`);
      assert.equal(count(after, "TryGetById"), count(before, "TryGetById") + tax, `v${version}: loopy's TryGetById count should round-trip plus the literal-globalThis tax (before ${count(before, "TryGetById")}, after ${count(after, "TryGetById")}, tax ${tax})`);
      assert.equal(count(before, "Throw"), 0, `v${version}: premise - the original has no separate Throw opcode either`);
      assert.equal(count(after, "Throw"), 2, `v${version}: keeping both guards should cost exactly 2 Throw opcodes on recompile (one per surviving guard), got ${count(after, "Throw")}`);
    }
  });
}
