// Round-trip review "passes-roundtrip-call3" (E2E tier 1,
// react-navigation-example-0.85.3 v98, passes-on): `diff:Call3(reg)` grew
// 11 -> 312 once spec 27 section 10 let the namespace-interop helper's
// forEach callback through. Its `Object.defineProperty(t, n, o.get ? o : {...})`
// reads the method BEFORE the conditional argument, so the decompiled form
// was `m = r4.defineProperty; ...if/break...; Reflect.apply(m, r4, [...])`,
// which `call-shape` refused (`unproven-this`) and which recompiles with an
// extra Reflect/apply/NewArray, shifting every register.
//
// Docs: docs/specs/passes/04-call-shape.md section 9 (rule R3e).
//
// Rung-owned property: in fixture 130, the four plain functions recompile to
// the original normalised bytecode, and no function keeps a `Reflect.apply`
// whose callee was read off its own `this`. Fixture 131 is the negative twin:
// the method is called with a different (or twice-used) receiver, so every
// `Reflect.apply` stays.
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
import { normaliseFunction } from "../../../src/harness/roundtrip.ts";

const VERSIONS = [84, 94, 96, 98, 99] as const;
type Version = (typeof VERSIONS)[number];
const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");
const POSITIVE = join(CONSTRUCTS, "130-call-cond-arg");
const NEGATIVE = join(CONSTRUCTS, "131-call-cond-arg-other-this");
const PLAIN = ["pick", "twoConds", "reassign", "viaGlobal"];

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

/** Normalised bytecode of every function named in `names`, by name (property puts masked). */
function byName(bytes: Uint8Array, names: readonly string[]): Map<string, string> {
  const mod = parse(bytes);
  const out = new Map<string, string>();
  for (let i = 0; i < mod.functions.length; i++) {
    const fn = decodeFunction(mod, i);
    // Object-literal property stores are masked: how a literal lowers
    // (PutNewOwnById vs PutById vs PutOwnBySlotIdx) is the object-literal
    // bucket's business, not this rung's.
    if (names.includes(fn.name)) out.set(fn.name, normaliseFunction(mod, fn, { strong: true }).replace(/^(Put\w*) (%\d+), (%\d+), .*$/gm, "Put $2, $3"));
  }
  return out;
}

function recompile(version: Version, source: string): Uint8Array {
  const hermesc = findHermesc(version)!;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-call-cond-arg-"));
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

/** `Reflect.apply(<callee>, <this>, ...)` sites whose callee is a member read
 *  `<callee> = <this>.<p>` somewhere in the same output. */
function ownThisApplies(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/Reflect\.apply\((\w+), (\w+), /g)) {
    const [, f, r] = m;
    if (new RegExp(`\\b${f} = ${r}\\.\\w+;`).test(code)) out.push(m[0]);
  }
  return out;
}

for (const version of VERSIONS) {
  test(`130-call-cond-arg v${version}: no Reflect.apply keeps a callee read off its own this`, () => {
    if (!existsSync(join(POSITIVE, `v${version}.hbc`))) return;
    const code = decompiled(new Uint8Array(readFileSync(join(POSITIVE, `v${version}.hbc`))));
    assert.deepEqual(ownThisApplies(code), []);
  });

  // v84 is excluded from the identity check only: its decompiled `let`
  // bindings recompile with ThrowIfEmpty TDZ checks the original lacks, a
  // difference that predates this rung (the Reflect.apply form had it too).
  test(`130-call-cond-arg v${version}: method calls with a conditional argument recompile identically`, (t) => {
    if (version === 84) return;
    if (!existsSync(join(POSITIVE, `v${version}.hbc`)) || !needHermesc(version, t)) return;
    const original = new Uint8Array(readFileSync(join(POSITIVE, `v${version}.hbc`)));
    const want = byName(original, PLAIN);
    assert.equal(want.size, PLAIN.length, "fixture shape changed under this test");
    const got = byName(recompile(version, decompiled(original)), PLAIN);
    for (const name of PLAIN) assert.equal(got.get(name), want.get(name), `v${version} ${name}: bytecode differs after the round trip`);
  });

  test(`131-call-cond-arg-other-this v${version}: a different or reused receiver is never rewritten onto the method's object`, () => {
    if (!existsSync(join(NEGATIVE, `v${version}.hbc`))) return;
    const code = decompiled(new Uint8Array(readFileSync(join(NEGATIVE, `v${version}.hbc`))));
    // The source never calls `.m(...)` directly: every call goes through
    // `f.call(receiver, ...)` (v98/v99 lower it to Reflect.apply behind a
    // `__hbc_b_functionPrototypeCall` guard), so no `.m(` may appear.
    assert.match(code, /\bm = \w+\.m;/, "fixture shape changed under this test");
    assert.doesNotMatch(code, /\.m\(/, "no call may be rewritten onto the object the method was read from");
  });
}
