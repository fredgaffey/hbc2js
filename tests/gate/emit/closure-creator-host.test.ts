// Round-trip review "passes-roundtrip-closure" (E2E tier 1,
// react-navigation-example-0.85.3 v98, passes-on): the bucket
// `tree:unmatched-closure(orig 1 vs recompiled 0)`. A function created inside
// a function that owns no environment of its own (fixture 150's `parse`) was
// emitted inside the OWNER of its closure environment (`makeParser`), so the
// recompiled `parse` created no closure and `makeParser` one too many.
//
// Docs: docs/specs/03-emit.md is unchanged; the rule is spec 27 section 11
// (docs/specs/passes/27-iife-reconstruct.md).
//
// Rung-owned property: decompiling and recompiling with the same hermesc gives
// back the original closure TREE (who creates whom, canonicalised). Fixture
// 151 is the negative twin: the callback is created in two functions (hermesc
// inlined its creator into both), so it must stay in the environment owner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoRoot } from "../../support/paths.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import { requireOracles } from "../../support/tiers.ts";
import { decompile } from "../../../src/decompile.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";

const VERSIONS = [84, 94, 96, 98, 99] as const;
type Version = (typeof VERSIONS)[number];
const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");
const POSITIVE = join(CONSTRUCTS, "150-closure-created-in-inner-fn");
const NEGATIVE = join(CONSTRUCTS, "151-closure-created-in-two-fns");

function parse(bytes: Uint8Array) {
  try {
    return parseHbc(bytes);
  } catch {
    return parseHbc(bytes, { opcodeTable: "hbc98-late" });
  }
}

function decompiled(bytes: Uint8Array): string {
  try {
    return decompile(bytes).code;
  } catch {
    return decompile(bytes, { opcodeTable: "hbc98-late" }).code;
  }
}

/** The closure tree under the function named `root`, children canonically
 *  sorted: `(...)` per function, its children inside. (Rooted at a named
 *  function because the decompiled program adds wrapper functions above it.) */
function closureTree(bytes: Uint8Array, root: string): string {
  const mod = parse(bytes);
  const kids = (f: number): number[] => {
    const out: number[] = [];
    for (const insn of decodeFunction(mod, f).instructions) for (const op of insn.operands) if (op.role === "function" && !out.includes(op.value)) out.push(op.value);
    return out;
  };
  const sig = (f: number, depth: number): string => (depth > 20 ? "!" : `(${kids(f).map((k) => sig(k, depth + 1)).sort().join("")})`);
  const at = mod.functions.findIndex((f) => f.name === root);
  assert.ok(at >= 0, `no function named ${root}`);
  return sig(at, 0);
}

function recompile(version: Version, source: string): Uint8Array {
  const hermesc = findHermesc(version)!;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-closure-host-"));
  try {
    writeFileSync(join(dir, "in.js"), source);
    const out = join(dir, "out.hbc");
    const r = runHermesc(hermesc, ["-O", "-emit-binary", `-out=${out}`, "in.js"], dir);
    assert.equal(r.status, 0, `hermesc v${version} failed: ${r.stderr}`);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function needHermesc(version: Version, t: { skip(msg: string): void }): boolean {
  if (findHermesc(version) !== null) return true;
  if (requireOracles()) throw new Error(`hermesc v${version} required (HBC2JS_REQUIRE_ORACLES=1)`);
  t.skip(`hermesc v${version} not found (run tools/get-hermesc.sh ${version})`);
  return false;
}

for (const version of VERSIONS) {
  test(`150-closure-created-in-inner-fn v${version}: the round trip keeps the callback inside the function that creates it`, (t) => {
    if (!existsSync(join(POSITIVE, `v${version}.hbc`)) || !needHermesc(version, t)) return;
    const original = new Uint8Array(readFileSync(join(POSITIVE, `v${version}.hbc`)));
    assert.equal(closureTree(recompile(version, decompiled(original)), "makeParser"), closureTree(original, "makeParser"), `v${version}: closure tree differs after the round trip`);
  });

  test(`151-closure-created-in-two-fns v${version}: a callback created in two functions is an expression in each (fix-closure-identity-2)`, (t) => {
    if (!existsSync(join(NEGATIVE, `v${version}.hbc`)) || !needHermesc(version, t)) return;
    const original = new Uint8Array(readFileSync(join(NEGATIVE, `v${version}.hbc`)));
    const code = decompiled(original);
    // Whatever the version inlined, the decompiled source recompiles, and no
    // `left`/`right` body hosts a nested function declaration of its own.
    recompile(version, code);
    if (/function wrap\(/.test(code)) return; // not inlined at this version: wrap hosts it, one creator
    const indent = (re: RegExp): number => {
      const line = code.split("\n").find((l) => re.test(l));
      assert.ok(line !== undefined, `v${version}: no line matching ${re}`);
      return line.length - line.trimStart().length;
    };
    // fix-closure-identity-2 (spec 27 section 12): the callback is created in
    // two functions, so it is a function expression inside each of them (one
    // object per call, as in the VM), not one declaration beside them.
    const decls = code.split("\n").filter((l) => /^\s+function _fn[1-9]\d*\(/.test(l));
    assert.deepEqual(decls, [], `v${version}: no shared callback declaration:\n${code}`);
    // `left`/`right` may themselves be function expressions in makeTwo's
    // returned array (closure-inline, spec 32): the line that starts `left`
    // (a declaration or `arr = [function left(`) is the outer bound either way.
    const outer = indent(/function left\(/);
    assert.ok((code.match(/function _fn[1-9]\d*\(/g) ?? []).length >= 2 && indent(/function _fn[1-9]\d*\(/) > outer, `v${version}: one callback instance per creator:\n${code}`);
  });
}
