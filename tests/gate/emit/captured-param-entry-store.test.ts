// roundtrip-paramenv: round-trip bucket `diff:StoreToEnvironment/LoadParam`
// (#1 DIFFERENT bucket on the second-app corpus run of 2026-11-09, #12 on
// react-navigation). A parameter captured by a closure lives in its
// function's environment from entry; the emitter printed it as a separate
// `let _eN_M` assigned from `aK`, and the recompile moved the store past the
// next parameter's LoadParam. Fixture 270 is the positive shape, 271 the
// negative twins (slot written again after entry: must keep its own binding).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoRoot } from "../../support/paths.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import { requireOracles } from "../../support/tiers.ts";
import { decompile } from "../../../src/decompile.ts";
import { parseHbc } from "../../../src/index.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { normaliseFunction } from "../../../src/harness/roundtrip.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";

const POS = "270-captured-param-entry-store";
const NEG = "271-captured-param-reassigned";
const VERSIONS = [84, 94, 96, 98, 99] as const;
const bytesOf = (fx: string, v: number): Uint8Array => new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", fx, `v${v}.hbc`)));
const code = (fx: string, v: number): string => decompile(bytesOf(fx, v), { moduleName: fx, resolveV98Ambiguity: true }).code;

/** Normalised bytecode of every function with this name, in table order. */
function byName(bytes: Uint8Array, name: string): string[] {
  const mod = parseHbc(bytes);
  const out: string[] = [];
  for (let i = 0; i < mod.functions.length; i++) {
    const fn = decodeFunction(mod, i);
    if (fn.name === name) out.push(normaliseFunction(mod, fn, { strong: true }));
  }
  return out;
}

function recompile(v: (typeof VERSIONS)[number], source: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-paramenv-"));
  try {
    writeFileSync(join(dir, "a.js"), source);
    const r = runHermesc(findHermesc(v)!, ["-O", "-emit-binary", `-out=${join(dir, "a.hbc")}`, "a.js"], dir);
    assert.equal(r.status, 0, `hermesc v${v} failed: ${r.stderr}`);
    return new Uint8Array(readFileSync(join(dir, "a.hbc")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const paramLists = (src: string): string[] => [...src.matchAll(/function \w+\(([^)]*)\)/g)].map((m) => m[1]!);

// v84 is left out: its recompile adds `let` TDZ checks (ThrowIfEmpty) unrelated to this shape.
for (const v of [94, 96, 98, 99] as const) {
  test(`roundtrip-paramenv: fixture 270 v${v} — the captured-parameter functions recompile IDENTICAL`, (t) => {
    if (findHermesc(v) === null) {
      if (requireOracles()) throw new Error(`hermesc v${v} required`);
      t.skip(`hermesc v${v} not found`);
      return;
    }
    const orig = bytesOf(POS, v);
    const round = recompile(v, code(POS, v));
    for (const name of ["factory", "sloppy"]) {
      assert.deepEqual(byName(round, name), byName(orig, name), `v${v} ${name}: recompiled bytecode differs\n${code(POS, v)}`);
    }
  });
}

test("roundtrip-paramenv: fixture 270 names captured parameters by their environment slot", () => {
  for (const v of VERSIONS) {
    if (!existsSync(join(repoRoot(), "tests", "fixtures", "constructs", POS, `v${v}.hbc`))) continue;
    const out = code(POS, v);
    assert.ok(paramLists(out).some((p) => /_e\d+_\d+/.test(p)), `v${v}: no slot-named parameter\n${out}`);
    assert.ok(!/_e\d+_\d+ = a\d+;/.test(out), `v${v}: still copies a parameter into a slot\n${out}`);
  }
});

test("roundtrip-paramenv: fixture 271 (slot written after entry) keeps parameter and slot apart", () => {
  for (const v of VERSIONS) {
    if (!existsSync(join(repoRoot(), "tests", "fixtures", "constructs", NEG, `v${v}.hbc`))) continue;
    const out = code(NEG, v);
    assert.deepEqual(paramLists(out).filter((p) => /_e\d+_\d+/.test(p)), [], `v${v}: a reassigned slot became a parameter\n${out}`);
  }
});

test("roundtrip-paramenv: fixtures 270/271 are T2 PASS at every version", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, only: [POS, NEG], versions: [...VERSIONS] });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS).map((r) => `${r.fixture.name}: ${r.verdict}`);
  assert.deepEqual(bad, []);
  assert.ok(report.results.length >= 10, `only ${report.results.map((r) => r.fixture.name).join(",")} ran`);
});
