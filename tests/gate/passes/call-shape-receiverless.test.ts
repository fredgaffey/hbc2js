// Round-trip review "passes-roundtrip-global" (E2E tier 1,
// react-navigation-example-0.85.3 v98, passes-on): a large share of the
// `diff:*/GetGlobalObject` buckets is a `Reflect.apply(O.p, undefined, [...])`
// left in the output, because call-shape refused a member callee with an
// undefined receiver (`member-callee-with-undefined-this`). Recompiled, the
// leftover is a real `Reflect.apply` call (GetGlobalObject + TryGetById
// "Reflect" + an args array). The source was Babel's interop call
// `(0, ns.fn)(x)`, and R3e prints exactly that.
//
// Docs: docs/specs/passes/04-call-shape.md section 4, R3e.
//
// Fixture 160: `viaSeq` uses the receiverless form, `viaMethod` (negative
// twin) the plain method call, which must keep `ns` as receiver.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoRoot } from "../../support/paths.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import { requireOracles } from "../../support/tiers.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Expr } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { expr } from "../../../src/emit/print.ts";
import { classifyNode } from "../../../src/passes/call-shape/match.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import type { HbcModule } from "../../../src/parse/types.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { normaliseFunction } from "../../../src/harness/roundtrip.ts";

const call = (callee: Expr, args: readonly Expr[]): Expr => ({ k: "call", callee, args });
const member = (obj: Expr, prop: string, computed = false): Expr => ({ k: "member", obj, prop: lit(computed ? JSON.stringify(prop) : prop), computed });
const reflectApply = (F: Expr, T: Expr, args: readonly Expr[]): Expr & { k: "call" } => call(member(id("Reflect"), "apply"), [F, T, { k: "array", elements: args }]) as Expr & { k: "call" };

test("R3e: a member callee with a literal-undefined receiver becomes `(0, O.p)(a...)`", () => {
  const r = classifyNode(reflectApply(member(id("ns"), "fn"), lit("undefined"), [id("x")]), []);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.rule, "R3e");
  assert.equal(expr(r.replacement, 0), "(0, ns.fn)(x)");
});

test("R3e: a computed member callee with a proven-undefined register receiver", () => {
  const body = [{ k: "expr" as const, expr: { k: "assign" as const, target: id("r3"), value: lit("undefined") } }];
  const r = classifyNode(reflectApply(member(id("e"), "default", true), id("r3"), []), body);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(expr(r.replacement, 0), '(0, e["default"])()');
});

test("R3e negative: a member callee whose receiver is an unproven register still refuses", () => {
  const body = [{ k: "expr" as const, expr: { k: "assign" as const, target: id("r3"), value: id("other") } }];
  assert.deepEqual(classifyNode(reflectApply(member(id("e"), "m"), id("r3"), []), body), { ok: false, reason: "unproven-this" });
});

const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "160-receiverless-member-call");

function parse(bytes: Uint8Array): HbcModule {
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
function normalisedByName(bytes: Uint8Array, name: string): string {
  const mod = parse(bytes);
  for (let i = 0; i < mod.functions.length; i++) {
    if (mod.functions[i]!.name === name) return normaliseFunction(mod, decodeFunction(mod, i), { strong: true });
  }
  throw new Error(`no function ${name}`);
}
function fnText(code: string, name: string): string {
  const i = code.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} not in output`);
  return code.slice(i, code.indexOf("\n    }\n", i));
}

for (const version of [84, 94, 96, 98, 99] as const) {
  test(`160-receiverless-member-call v${version}: no Reflect.apply survives in viaSeq; viaMethod stays a method call`, () => {
    const p = join(FIXTURE, `v${version}.hbc`);
    if (!existsSync(p)) return;
    const code = decompiled(new Uint8Array(readFileSync(p)));
    assert.doesNotMatch(fnText(code, "viaSeq"), /Reflect\.apply/);
    assert.match(fnText(code, "viaMethod"), /a1\.fn\(a2\)/);
  });

  test(`160-receiverless-member-call v${version}: viaSeq and viaMethod recompile to the original bytecode`, (t) => {
    const p = join(FIXTURE, `v${version}.hbc`);
    if (!existsSync(p)) return;
    const hermesc = findHermesc(version);
    if (hermesc === null) {
      if (requireOracles()) throw new Error(`hermesc v${version} required`);
      t.skip(`hermesc v${version} not found`);
      return;
    }
    const original = new Uint8Array(readFileSync(p));
    const dir = mkdtempSync(join(tmpdir(), "hbc2js-receiverless-"));
    try {
      writeFileSync(join(dir, "in.js"), decompiled(original));
      const r = runHermesc(hermesc, ["-O", "-emit-binary", `-out=${join(dir, "out.hbc")}`, "in.js"], dir);
      assert.equal(r.status, 0, r.stderr);
      const round = new Uint8Array(readFileSync(join(dir, "out.hbc")));
      // v84: the emitted `let` locals add ThrowIfEmpty TDZ checks in viaSeq
      // (a separate, pre-existing v84 difference); assert only that no
      // `Reflect.apply` survives the round trip there.
      if (version === 84) assert.doesNotMatch(normalisedByName(round, "viaSeq"), /"Reflect"/);
      else assert.equal(normalisedByName(round, "viaSeq"), normalisedByName(original, "viaSeq"), `v${version} viaSeq`);
      assert.equal(normalisedByName(round, "viaMethod"), normalisedByName(original, "viaMethod"), `v${version} viaMethod`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
