// Round-trip review "passes-roundtrip-bucket" (E2E tier 1,
// react-navigation-example-0.85.3 v98, passes-on): the largest DIFFERENT
// buckets, `diff:LoadFromEnvironment(imm)` and
// `diff:CreateFunctionEnvironment(imm)`, are dominated by module factories
// that inlined the namespace-interop helper. The factory then creates its OWN
// environment (offset 0) plus the helper's, side by side. Spec 27 treated the
// factory's own environment as one more IIFE candidate; its statements
// straddle the helper's range, so BOTH refused as `overlapping statement
// ranges` and the recompile merged them into one environment.
//
// Docs: docs/specs/passes/27-iife-reconstruct.md section 10.
//
// Rung-owned property (no whole-output comparison): decompiling fixture 120
// and recompiling with the same hermesc reproduces the environment sizes the
// owning function creates, and every closure's slot immediates. Fixture 121
// is the negative twin: the helper's closure also reads the caller's own
// environment, so it must stay flat (no wrapper emitted).
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

const VERSIONS = [98, 99] as const;
type Version = (typeof VERSIONS)[number];
const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");
const POSITIVE = join(CONSTRUCTS, "120-own-env-plus-iife");
const NEGATIVE = join(CONSTRUCTS, "121-own-env-plus-iife-captures-outer");

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

/** Per function that creates more than one environment: the sizes it creates, in order. */
function envCreations(bytes: Uint8Array): string[] {
  const mod = parse(bytes);
  const out: string[] = [];
  for (let i = 0; i < mod.functions.length; i++) {
    const creates = decodeFunction(mod, i).instructions.filter((insn) => insn.name === "CreateFunctionEnvironment");
    if (creates.length > 1) out.push(creates.map((insn) => insn.operands[1]!.value).join(","));
  }
  return out;
}

/** Every environment load/store slot immediate, per function, as a sorted multiset. */
function envSlots(bytes: Uint8Array): string[] {
  const mod = parse(bytes);
  const out: string[] = [];
  for (let i = 0; i < mod.functions.length; i++) {
    const slots = decodeFunction(mod, i)
      .instructions.filter((insn) => /^(LoadFrom|Store|StoreNP)(To)?Environment/.test(insn.name))
      .map((insn) => `${insn.name.startsWith("Load") ? "L" : "S"}${insn.operands[insn.name.startsWith("Load") ? 2 : 1]!.value}`);
    if (slots.length > 0) out.push(slots.sort().join(","));
  }
  return out.sort();
}

function recompile(version: Version, source: string): Uint8Array {
  const hermesc = findHermesc(version)!;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-own-env-iife-"));
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
  test(`120-own-env-plus-iife v${version}: the fixture builds an own environment plus an inlined one`, () => {
    if (!existsSync(join(POSITIVE, `v${version}.hbc`))) return;
    assert.deepEqual(envCreations(new Uint8Array(readFileSync(join(POSITIVE, `v${version}.hbc`)))), ["3,2"], "fixture shape changed under this test");
  });

  test(`120-own-env-plus-iife v${version}: recompiling keeps the own and the inlined environment apart`, (t) => {
    if (!existsSync(join(POSITIVE, `v${version}.hbc`)) || !needHermesc(version, t)) return;
    const original = new Uint8Array(readFileSync(join(POSITIVE, `v${version}.hbc`)));
    const round = recompile(version, decompiled(original));
    assert.deepEqual(envCreations(round), envCreations(original), `v${version}: environment sizes differ after the round trip`);
    assert.deepEqual(envSlots(round), envSlots(original), `v${version}: environment slot immediates differ after the round trip`);
  });

  test(`121-own-env-plus-iife-captures-outer v${version}: a closure reading both environments stays flat`, () => {
    if (!existsSync(join(NEGATIVE, `v${version}.hbc`))) return;
    const code = decompiled(new Uint8Array(readFileSync(join(NEGATIVE, `v${version}.hbc`))));
    assert.equal(code.split("\n").filter((l) => /^\s+\(function \(\) \{$/.test(l)).length, 0, "no IIFE wrapper may be emitted");
  });
}
