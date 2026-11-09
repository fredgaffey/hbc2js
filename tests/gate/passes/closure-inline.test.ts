// closure-inline (docs/specs/passes/32-closure-inline.md): roundtrip review
// `diff:GetGlobalObject/CreateClosure` bucket, 2026-11-09 -- the source
// `Object.defineProperty(o, k, {get: function () {...}})` reads `Object`
// before it creates the getter closure, but the decompiled text declared the
// getter as a hoisted `function _fnN` (created at function entry), so the
// recompile created the closure first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoRoot } from "../../support/paths.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import { requireOracles } from "../../support/tiers.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { classify } from "../../../src/passes/closure-inline/match.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { normaliseFunction } from "../../../src/harness/roundtrip.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";

const FIXTURE = "230-closure-inline-getter";
const DIR = join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE);
const VERSIONS = [84, 94, 96, 98, 99] as const;
const decompiled = (bytes: Uint8Array): string => decompile(bytes, { moduleName: FIXTURE, resolveV98Ambiguity: true }).code;
function fnText(code: string, name: string): string {
  const i = code.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} not in output`);
  return code.slice(i, code.indexOf("\n    }\n", i));
}
function normalisedByName(bytes: Uint8Array, name: string): string {
  const mod = parseHbc(bytes);
  for (let i = 0; i < mod.functions.length; i++) {
    if (mod.functions[i]!.name === name) return normaliseFunction(mod, decodeFunction(mod, i), { strong: true });
  }
  throw new Error(`no function ${name}`);
}

for (const v of VERSIONS) {
  test(`closure-inline: fixture 230 v${v} creates each getter inside its descriptor; the shared getter stays one declaration`, () => {
    const code = decompiled(new Uint8Array(readFileSync(join(DIR, `v${v}.hbc`))));
    const re = fnText(code, "reexport");
    assert.doesNotMatch(re, /\n\s*function \w+\(/, `v${v} reexport still hoists a getter:\n${re}`);
    assert.match(re, /get: function \w+\(/, `v${v} reexport:\n${re}`);
    // negative twin: the shared getter is still ONE function (created once)
    assert.equal(fnText(code, "twice").split("function ").length - 1, 2, `v${v} twice:\n${fnText(code, "twice")}`);
  });

  test(`closure-inline: fixture 230 v${v} reexport recompiles with the global read before the closure creation`, (t) => {
    if (v !== 98 && v !== 99) return; // the -O round-trip ratchet runs at the bundle versions
    const hermesc = findHermesc(v);
    if (hermesc === null) {
      if (requireOracles()) throw new Error(`hermesc v${v} required`);
      t.skip(`hermesc v${v} not found`);
      return;
    }
    const original = new Uint8Array(readFileSync(join(DIR, `v${v}.hbc`)));
    const dir = mkdtempSync(join(tmpdir(), "hbc2js-closure-inline-"));
    try {
      writeFileSync(join(dir, "in.js"), decompiled(original));
      const r = runHermesc(hermesc, ["-emit-binary", `-out=${join(dir, "out.hbc")}`, "in.js"], dir);
      assert.equal(r.status, 0, r.stderr);
      const round = new Uint8Array(readFileSync(join(dir, "out.hbc")));
      // The ORDER this rung owns: `Object` is read before the first getter
      // closure is created, as in the original. (The rest of the function --
      // the descriptor literal built before `.defineProperty` is read -- is
      // a separate object-literal difference, not asserted here.)
      const order = (text: string): number[] => {
        const lines = text.split("\n");
        return [lines.findIndex((l) => l.includes('"Object"')), lines.findIndex((l) => l.startsWith("CreateClosure"))];
      };
      const [gO, cO] = order(normalisedByName(original, "reexport"));
      assert.ok(gO >= 0 && gO < cO, "original reads Object first");
      const [gR, cR] = order(normalisedByName(round, "reexport"));
      assert.ok(gR >= 0 && gR < cR, `recompiled creates the closure before reading Object:\n${normalisedByName(round, "reexport")}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("closure-inline: fixture 230 (shared getter, hoisting use, absent global) is T2 PASS at every version", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, only: [FIXTURE], versions: [...VERSIONS] });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS).map((r) => `${r.fixture.name}: ${r.verdict}`);
  assert.deepEqual(bad, []);
  assert.ok(report.results.length >= 5, `only ${report.results.map((r) => r.fixture.name).join(",")} ran`);
});

// --- hand-built sites -----------------------------------------------------------
const fn = (name: string, body: readonly Stmt[] = [{ k: "return", arg: lit("1") } as Stmt]): Stmt => ({ k: "func", name, params: [], body });
const exprStmt = (e: Expr): Stmt => ({ k: "expr", expr: e });
const callOf = (...args: Expr[]): Stmt => exprStmt({ k: "call", callee: id("use"), args });
const verdict = (body: readonly Stmt[]): string => {
  const r = classify(body, 0);
  return r.ok ? "ok" : r.reason;
};

test("closure-inline: refusals -- two reads, a loop, a declaration store, a shadowing block binding, a self-reference", () => {
  assert.equal(verdict([fn("_fn5"), callOf(id("_fn5"))]), "ok");
  assert.equal(verdict([fn("_fn5"), callOf(id("_fn5")), callOf(id("_fn5"))]), "multi-use");
  assert.equal(verdict([fn("_fn5"), { k: "while", label: null, test: id("c"), body: [callOf(id("_fn5"))] } as Stmt]), "in-loop");
  // a read in a loop TEST runs once per iteration too
  assert.equal(verdict([fn("_fn5"), { k: "while", label: null, test: { k: "call", callee: id("g"), args: [id("_fn5")] }, body: [] } as Stmt]), "in-loop");
  // a declaration's own store (`r1.m = m`, `_e14_3 = _fn5`) keeps the declaration
  assert.equal(verdict([fn("_fn5"), exprStmt({ k: "assign", target: { k: "member", obj: id("r1"), prop: lit("m"), computed: false }, value: id("_fn5") })]), "declaration-store");
  assert.equal(verdict([fn("_fn5"), exprStmt({ k: "assign", target: id("_e14_3"), value: id("_fn5") })]), "declaration-store");
  assert.equal(verdict([fn("_fn5"), exprStmt({ k: "assign", target: id("r3"), value: id("_fn5") })]), "ok");
  const usesX = fn("_fn5", [{ k: "return", arg: id("x") } as Stmt]);
  assert.equal(verdict([usesX, { k: "if", test: id("c"), then: [{ k: "init", kind: "let", name: "x", value: lit("2") } as Stmt, callOf(id("_fn5"))], else: [] } as Stmt]), "shadowed");
  assert.equal(verdict([fn("_fn5", [{ k: "return", arg: id("_fn5") } as Stmt]), callOf(id("_fn5"))]), "self-reference");
  assert.equal(verdict([fn("_fn5"), callOf({ k: "func", name: null, params: [], body: [callOf(id("_fn5"))] })]), "nested-use");
});

test("closure-inline: an existing fixture file exists for every version", () => {
  for (const v of VERSIONS) assert.ok(existsSync(join(DIR, `v${v}.hbc`)));
});
