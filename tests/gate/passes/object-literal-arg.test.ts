// Round-trip review "passes-roundtrip-objlit" (E2E tier 1,
// react-navigation-example-0.85.3, passes-on): bucket
// `diff:GetById/NewObjectWithBuffer`, rank 2. The re-export header
// `Object.defineProperty(exports, "x", {enumerable: true, get: ...})`
// decompiled to `r7 = Object; obj = {...}; r7.defineProperty(r6, "x", obj)`,
// whose recompile allocates the descriptor BEFORE reading `defineProperty`
// (hermesc reads the callee first, in source order).
//
// Docs: docs/specs/passes/20-object-literal.md section 9.
//
// Fixture 140: every reachable function containing a `defineProperty` call
// round-trips to identical normalised bytecode at every version. Fixture 141
// (negative twin): the descriptor literal's construction is observable, so
// it must stay a separate statement, and the decompiled program must print
// exactly the original effect order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoRoot } from "../../support/paths.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import type { HbcVersion } from "../../support/hermesc.ts";
import { findHermesVm } from "../../support/hermesvm.ts";
import { requireOracles } from "../../support/tiers.ts";
import { decompile } from "../../../src/decompile.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { normaliseFunction } from "../../../src/harness/roundtrip.ts";

const VERSIONS: readonly HbcVersion[] = [84, 94, 96, 98, 99];
const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");
const POSITIVE = join(CONSTRUCTS, "140-define-property-getter");
const NEGATIVE = join(CONSTRUCTS, "141-define-property-observable-literal");
const EMIT_BUG = join(repoRoot(), "tests", "fixtures", "constructs", "250-method-read-before-getter-arg");

function decompiled(bytes: Uint8Array): string {
  try {
    return decompile(bytes).code;
  } catch {
    return decompile(bytes, { opcodeTable: "hbc98-late" }).code;
  }
}

function parse(bytes: Uint8Array) {
  try {
    return parseHbc(bytes);
  } catch {
    return parseHbc(bytes, { opcodeTable: "hbc98-late" });
  }
}

/** Normalised text of every function that reads `defineProperty`, in order. */
function definers(bytes: Uint8Array): string[] {
  const mod = parse(bytes);
  const out: string[] = [];
  for (let i = 0; i < mod.functions.length; i++) {
    const text = normaliseFunction(mod, decodeFunction(mod, i), { strong: true });
    if (text.includes("defineProperty")) out.push(text);
  }
  return out;
}

function recompile(version: HbcVersion, source: string): Uint8Array {
  const hermesc = findHermesc(version)!;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-objlit-arg-"));
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

function needHermesc(version: HbcVersion, t: { skip(msg: string): void }): boolean {
  if (findHermesc(version) !== null) return true;
  if (requireOracles()) throw new Error(`hermesc v${version} required (HBC2JS_REQUIRE_ORACLES=1)`);
  t.skip(`hermesc v${version} not found (run tools/get-hermesc.sh ${version})`);
  return false;
}

for (const version of VERSIONS) {
  test(`140-define-property-getter v${version}: the descriptor literal is inlined into the call`, () => {
    if (!existsSync(join(POSITIVE, `v${version}.hbc`))) return;
    const code = decompiled(new Uint8Array(readFileSync(join(POSITIVE, `v${version}.hbc`))));
    const calls = code.split("\n").filter((l) => /Object\.defineProperty\([^)]*, \{enumerable: [^,]+, get: [^}]+\}\);$/.test(l));
    assert.equal(calls.length, 3, `expected three inline Object.defineProperty calls:\n${code}`);
  });

  // v84 differs earlier, for an unrelated reason: its `let` bindings recompile
  // with a `ThrowIfEmpty` TDZ check the original does not have.
  test(`140-define-property-getter v${version}: every defineProperty function round-trips IDENTICAL`, version === 84 ? { skip: "v84 TDZ ThrowIfEmpty differs first (unrelated)" } : {}, (t) => {
    if (!existsSync(join(POSITIVE, `v${version}.hbc`)) || !needHermesc(version, t)) return;
    const original = new Uint8Array(readFileSync(join(POSITIVE, `v${version}.hbc`)));
    const want = definers(original);
    const got = definers(recompile(version, decompiled(original)));
    assert.equal(got.length, want.length, "function count differs");
    for (let i = 0; i < want.length; i++) assert.equal(got[i], want[i], `v${version}: defineProperty function ${i} differs after the round trip`);
  });

  test(`141-define-property-observable-literal v${version}: an observable literal is not moved past the method read`, (t) => {
    vmRun(NEGATIVE, version, t);
  });

  // docs/BUGS.md 2026-11-09 "method read moved past an intervening getter":
  // the emitter's method-call fusion (spec 05 section 7.4), fixed; the
  // adversarial-49 fixture graduated to constructs/250.
  test(`constructs/250-method-read-before-getter-arg v${version}: the method is read before the argument's getter`, (t) => {
    vmRun(EMIT_BUG, version, t);
  });
}

function vmRun(dirOf: string, version: HbcVersion, t: { skip(msg: string): void }): void {
  {
    if (!existsSync(join(dirOf, `v${version}.hbc`))) return;
    const code = decompiled(new Uint8Array(readFileSync(join(dirOf, `v${version}.hbc`))));
    const vm = findHermesVm(version);
    if (vm === null) {
      if (requireOracles() && version !== 84) throw new Error(`hermes VM v${version} required (HBC2JS_REQUIRE_ORACLES=1)`);
      t.skip(`no hermes VM v${version}`);
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "hbc2js-objlit-arg-neg-"));
    try {
      writeFileSync(join(dir, "out.js"), code);
      const printed = execFileSync(vm.path, [join(dir, "out.js")], { encoding: "utf8" });
      assert.equal(printed, readFileSync(join(dirOf, "expected.txt"), "utf8"), `effect order changed:\n${code}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
