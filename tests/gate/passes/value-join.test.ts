// Round-trip review "passes-roundtrip-polarity" (E2E tier 2,
// expensify-app-0.86.0 v98, passes-on): the `diff:JmpFalse(label)` /
// `diff:JmpTrue(label)` buckets. Once the globalThis-read artefacts are set
// aside, the dominant shape is an `||`/`&&`/`?:` whose value flows into an
// enclosing if/else join: Hermes keeps the expression's own join block (it
// carries the phi), leaving a jump-to-jump block in the bytecode. The
// decompiled labelled block with a guard `break` recompiles as an
// if-statement, whose empty join hermesc threads away, so every later label
// shifts and the conditional jump is the first differing line.
//
// Docs: docs/specs/passes/33-value-join.md.
//
// Rung-owned property: in fixture 280 every named function recompiles to
// the original normalised bytecode — the four expression joins (recovered
// by `value-join`) and the two plain if-statements (which must stay
// if-statements, or they would grow the jump-to-jump block instead).
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
const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "280-value-join-logical");
const JOINS = ["orInElse", "andInElse", "condInElse", "condNegated"];
const STATEMENTS = ["ifOr", "ifAnd"];

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

function byName(bytes: Uint8Array, names: readonly string[]): Map<string, string> {
  const mod = parse(bytes);
  const out = new Map<string, string>();
  for (let i = 0; i < mod.functions.length; i++) {
    const fn = decodeFunction(mod, i);
    if (names.includes(fn.name)) out.set(fn.name, normaliseFunction(mod, fn, { strong: true }));
  }
  return out;
}

function recompile(version: Version, source: string): Uint8Array {
  const hermesc = findHermesc(version)!;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-value-join-"));
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
  test(`280-value-join-logical v${version}: expression joins and plain ifs recompile identically`, (t) => {
    const hbc = join(FIXTURE, `v${version}.hbc`);
    // v84 is excluded from the identity check only: its decompiled `let`
    // bindings recompile with ThrowIfEmpty TDZ checks the original lacks.
    if (version === 84) return;
    if (!existsSync(hbc) || !needHermesc(version, t)) return;
    const original = new Uint8Array(readFileSync(hbc));
    const names = [...JOINS, ...STATEMENTS];
    const want = byName(original, names);
    assert.equal(want.size, names.length, "fixture shape changed under this test");
    const got = byName(recompile(version, decompiled(original)), names);
    const bad = names.filter((n) => got.get(n) !== want.get(n));
    assert.deepEqual(bad, [], `v${version}: bytecode differs after the round trip`);
  });

  test(`280-value-join-logical v${version}: the joins print as expressions`, () => {
    const hbc = join(FIXTURE, `v${version}.hbc`);
    if (!existsSync(hbc)) return;
    const code = decompiled(new Uint8Array(readFileSync(hbc)));
    assert.ok(/ = r\d+ \|\| /.test(code), "orInElse's `||` is recovered");
    assert.ok(/ = r\d+ && /.test(code), "andInElse's `&&` is recovered");
  });
}
