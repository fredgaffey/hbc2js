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
const SLOT_FILL = join(CONSTRUCTS, "260-literal-slot-fill-in-sequence");
const SLOT_FILL_NEG = join(CONSTRUCTS, "261-literal-slot-fill-observable-store");
const PUTBYID_BUG = join(CONSTRUCTS, "390-putbyid-fold-inherited-setter");
const EMIT_BUG = join(repoRoot(), "tests", "fixtures", "adversarial", "49-method-read-before-getter-arg");

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
function definers(bytes: Uint8Array, wanted: (text: string) => boolean = (t) => t.includes("defineProperty")): string[] {
  const mod = parse(bytes);
  const out: string[] = [];
  for (let i = 0; i < mod.functions.length; i++) {
    const text = normaliseFunction(mod, decodeFunction(mod, i), { strong: true });
    if (wanted(text)) out.push(text);
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
    // Kind D (passes-roundtrip-objlit2) moves each getter into its slot as
    // `get: function () {`, which hermesc creates after the literal as the
    // original did; a getter that stays a declaration is a plain name.
    const calls = code.split("\n").filter((l) => /Object\.defineProperty\([^)]*, \{enumerable: [^,]+, get: (function \(\) \{$|[^}]+\}\);$)/.test(l));
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
  // the emitter's method-call fusion, not this rung. Open.
  test(`adversarial/49-method-read-before-getter-arg v${version}: the method is read before the argument's getter`, { todo: "docs/BUGS.md 2026-11-09 method-read fusion" }, (t) => {
    vmRun(EMIT_BUG, version, t);
  });
}

// passes-roundtrip-objlit2 (round-trip buckets `diff:NewObjectWithBuffer/CreateClosure`
// and `diff:PutOwnBySlotIdx/PutById*`): kind C, a store into a key the fresh
// literal already owns, inside a sequence expression, folds into the literal.
for (const version of VERSIONS) {
  // Before v97 hermesc does not pre-declare a non-constant key as a buffer
  // placeholder: the store adds a NEW key, which a sequence element (no
  // bytecode origin) cannot prove is an own define, so kind C stays out.
  const placeholders = version >= 97 ? {} : { skip: "pre-v97: no NewObjectWithBuffer placeholders" };
  test(`260-literal-slot-fill-in-sequence v${version}: slot fills fold into the literal`, placeholders, () => {
    if (!existsSync(join(SLOT_FILL, `v${version}.hbc`))) return;
    const code = decompiled(new Uint8Array(readFileSync(join(SLOT_FILL, `v${version}.hbc`))));
    assert.doesNotMatch(code, /\.(get|scales|fileHashes) = /, `a slot fill was left as an assignment:\n${code}`);
    assert.match(code, /scales: \[1\]/);
    assert.match(code, /\{enumerable: true, get: function \(\) \{/);
  });

  test(`260-literal-slot-fill-in-sequence v${version}: the slot-fill functions round-trip IDENTICAL`, placeholders, (t) => {
    if (!existsSync(join(SLOT_FILL, `v${version}.hbc`)) || !needHermesc(version, t)) return;
    const original = new Uint8Array(readFileSync(join(SLOT_FILL, `v${version}.hbc`)));
    // The two slot-fill functions (not the global code, which the decompiled
    // module wraps in one more function).
    const pick = (x: string) => x.includes('s#"getOwnPropertyDescriptor"') || /GetById\w* %\d+, %\d+, s#"register"/.test(x);
    const want = definers(original, pick);
    assert.equal(want.length, 2, "expected the exportStar callback and the asset factory");
    const got = definers(recompile(version, decompiled(original)), pick);
    assert.equal(got.length, want.length, "function count differs");
    for (let i = 0; i < want.length; i++) assert.equal(got[i], want[i], `v${version}: slot-fill function ${i} differs after the round trip`);
  });

  test(`260-literal-slot-fill-in-sequence v${version}: behaviour is unchanged`, (t) => {
    vmRun(SLOT_FILL, version, t);
  });

  test(`261-literal-slot-fill-observable-store v${version}: a store into an accessor key is not folded`, (t) => {
    vmRun(SLOT_FILL_NEG, version, t);
  });

  // docs/BUGS.md 2026-11-10 "object-literal folds a PutById past an inherited
  // setter" (DECISIONS D27a): src/passes/object-literal no longer folds a
  // PutById-family store, so the setter Object.prototype carries still runs.
  test(`constructs/390-putbyid-fold-inherited-setter v${version}: an inherited setter still runs`, (t) => {
    vmRun(PUTBYID_BUG, version, t);
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
