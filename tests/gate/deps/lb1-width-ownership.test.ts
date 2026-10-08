// LB1 (docs/DEPS.md "Why exact-version signatures miss", 2026-09-29) --
// regression tests for the two signature-BUILD defects it diagnosed:
//   (c) Hermes picks operand-width opcode variants (GetByIdShort / GetById /
//       GetByIdLong, CreateClosure / CreateClosureLongIndex, ...) from the
//       WHOLE bundle's string/function table sizes, and the mnemonic entered
//       both hash tiers, so a package fingerprinted in a small scaffold never
//       matched a large app;
//   (d) baseline subtraction removed every function the RN foundation
//       bundle shares with a package -- including the package's OWN code
//       when RN itself depends on that package.
// Plus the format-change guards: hash scheme 2 supersedes scheme 1 per
// package, and pre-LB1 (scheme 1) files still score against the target's
// scheme-1 hashes, never against scheme-2 ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import type { DecodedFunction } from "../../../src/disasm/decode.ts";
import type { HbcModule } from "../../../src/parse/types.ts";
import { fingerprintModule, SIG_HASH_SCHEME } from "../../../src/deps/fingerprint.ts";
import { computeFunctionOwners } from "../../../src/deps/baseline-owners.ts";
import { buildInventoryFromModule } from "../../../src/deps/inventory.ts";
import { matchInventory } from "../../../src/deps/match.ts";
import { loadSignatures, writeSignature } from "../../../src/deps/db.ts";
import { computeBaselineHashes, subtractBaseline } from "../../../src/deps/confirm.ts";
import { loadCommonalityIndex } from "../../../src/deps/classify.ts";
// @ts-expect-error — plain-JS tool, no declaration file.
import { truthFromMap } from "../../../tools/deps-truth.mjs";
import { computeBaselineUnion, subtractBaseline as subtractBaselineBulk } from "../../../tools/pkgsig/bulk/baseline-subtract.mjs";
import type { SigDbFile, SigFunction, SigModule } from "../../../src/deps/sigdb-types.ts";

const RN_TEMPLATE = join(repoRoot(), "tests/fixtures/bundles/rn-template-0.72/truth");
let cachedMod: HbcModule | undefined;
function rnTemplate(): HbcModule {
  cachedMod ??= parseHbc(new Uint8Array(readFileSync(join(RN_TEMPLATE, "index.android.hbc"))));
  return cachedMod;
}

// What the SAME source compiles to in a bundle whose string/function tables
// are one width class bigger (the LB1 small-scaffold vs big-app pairing).
const WIDER: Record<string, string> = {
  GetByIdShort: "GetById",
  GetById: "GetByIdLong",
  PutNewOwnByIdShort: "PutNewOwnById",
  PutNewOwnById: "PutNewOwnByIdLong",
  TryGetById: "TryGetByIdLong",
  PutById: "PutByIdLong",
  LoadConstString: "LoadConstStringLongIndex",
  CreateClosure: "CreateClosureLongIndex",
};
function widen(fn: DecodedFunction, map: Record<string, string>): DecodedFunction {
  return { ...fn, instructions: fn.instructions.map((i) => (map[i.name] !== undefined ? { ...i, name: map[i.name]! } : i)) };
}

test("LB1(c): the same function compiled in a small and a big bundle hashes equal (exact + fuzzy) once operand widths fold", () => {
  const mod = rnTemplate();
  const small = fingerprintModule(mod, decodeFunction);
  const big = fingerprintModule(mod, (m, i) => widen(decodeFunction(m, i), WIDER));
  let widthSensitive = 0;
  for (let i = 0; i < small.functions.length; i++) {
    if (decodeFunction(mod, i).instructions.some((x) => WIDER[x.name] !== undefined)) widthSensitive++;
    assert.equal(big.functions[i]!.exactHash, small.functions[i]!.exactHash, `exact hash of fn ${i}`);
    assert.equal(big.functions[i]!.fuzzyHash, small.functions[i]!.fuzzyHash, `fuzzy hash of fn ${i}`);
  }
  assert.ok(widthSensitive > 100, `fixture must exercise width variants (got ${widthSensitive})`);
  assert.equal(SIG_HASH_SCHEME, 2);
});

test("LB1(c): jump *Long variants are NOT folded (jump distance is function-local, not bundle-context)", () => {
  const mod = rnTemplate();
  const idx = mod.functions.findIndex((_, i) => decodeFunction(mod, i).instructions.some((x) => x.name === "Jmp"));
  assert.ok(idx >= 0);
  const a = fingerprintModule(mod, decodeFunction).functions[idx]!;
  const b = fingerprintModule(mod, (m, i) => (i === idx ? widen(decodeFunction(m, i), { Jmp: "JmpLong" }) : decodeFunction(m, i))).functions[idx]!;
  assert.notEqual(a.exactHash, b.exactHash);
});

test("LB1 format guard: a pre-LB1 (scheme 1) file still matches through the target's scheme-1 hashes", () => {
  const mod = rnTemplate();
  const fp = fingerprintModule(mod, decodeFunction);
  const inventory = buildInventoryFromModule(mod);
  const differ = fp.functions.filter((f, i) => f.exactHash !== fp.legacyExactHashes[i]).length;
  assert.ok(differ > 100, `scheme 1 and 2 must differ on width-sensitive functions (got ${differ})`);
  const base = { schema: 2 as const, version: "1.0.0", hbcVersion: inventory.hbcVersion, totalFunctions: fp.functions.length, rawFunctionCount: fp.functions.length, subtractedBaselines: [], modules: [], toolchainBaseline: false, provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: 94, hermescRnEra: null, repoCommit: null, builtAt: "" } };
  const v1: SigDbFile = { ...base, package: "scheme-one", functions: fp.functions.map((f, i) => ({ ...f, exactHash: fp.legacyExactHashes[i]!, fuzzyHash: fp.legacyFuzzyHashes[i]! })) };
  const v2: SigDbFile = { ...base, package: "scheme-two", hashScheme: 2, functions: fp.functions };
  const s1 = matchInventory(inventory, [{ file: v1, layer: "user", path: "a" }]).packages[0]!;
  const s2 = matchInventory(inventory, [{ file: v2, layer: "user", path: "b" }]).packages[0]!;
  assert.ok(s2.exactHits > 0);
  assert.equal(s1.exactHits, s2.exactHits);
});

test("LB1 format guard: a hash-scheme-2 entry supersedes scheme-1 entries of the same package; baselines never superseded", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-lb1-db-"));
  try {
    const mk = (o: Partial<SigDbFile>): SigDbFile => ({
      schema: 2, package: "p", version: "1.0.0", hbcVersion: 94, totalFunctions: 1, rawFunctionCount: 1, subtractedBaselines: [],
      functions: [{ index: 0, name: "f", paramCount: 0, instrCount: 10, exactHash: "a".repeat(24), fuzzyHash: "b".repeat(24), stringSetHash: "c".repeat(24), stringCount: 0 }],
      modules: [], toolchainBaseline: false,
      provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: 94, hermescRnEra: null, repoCommit: null, builtAt: "" }, ...o,
    });
    writeSignature(dir, mk({ version: "1.0.0", subtractedDependencies: [] })); // J4 v2 but hash scheme 1
    writeSignature(dir, mk({ version: "2.0.0", hashScheme: 2, subtractedDependencies: [] }));
    writeSignature(dir, mk({ package: "q", version: "1.0.0" }));
    writeSignature(dir, mk({ package: "react-native-foundation", version: "0.72.17", toolchainBaseline: true }));
    const loaded = loadSignatures([{ name: "user", dir }]);
    assert.deepEqual(loaded.filter((l) => l.file.package === "p").map((l) => l.file.version), ["2.0.0"]);
    assert.equal(loaded.filter((l) => l.file.package === "q").length, 1);
    assert.equal(loaded.filter((l) => l.file.toolchainBaseline).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LB1(d): computeFunctionOwners attributes every __d module's functions to its package (truth module map)", () => {
  const mod = rnTemplate();
  const truth = JSON.parse(readFileSync(join(RN_TEMPLATE, "deps-truth.json"), "utf8")) as { modules: Record<string, { package: string | null }> };
  const owners = computeFunctionOwners(mod, decodeFunction, (id) => truth.modules[String(id)]?.package ?? null);
  assert.equal(owners.length, mod.functions.length);
  assert.equal(owners[0], null, "the global function belongs to no package");
  const count = (p: string) => owners.filter((o) => o === p).length;
  assert.ok(count("regenerator-runtime") > 50, `regenerator-runtime owns its functions (got ${count("regenerator-runtime")})`);
  assert.ok(count("react-native") > 1000);
  assert.ok(count("react") > 50);
});

function ownershipFixture(): { dir: string; raw: SigFunction[]; mods: SigModule[] } {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-lb1-own-"));
  mkdirSync(join(dir, "_baselines"), { recursive: true });
  const fns = [{ exactHash: "own1", owner: "p" }, { exactHash: "foreign", owner: "q" }, { exactHash: "tool" }, { exactHash: "mixed", owner: "p" }, { exactHash: "mixed", owner: "q" }, { exactHash: "old1" }];
  writeFileSync(join(dir, "_baselines", "react-native-foundation@1__hbc94.json"), JSON.stringify({ functions: fns }));
  const f = (i: number, h: string): SigFunction => ({ index: i, name: "", paramCount: 0, instrCount: 10, exactHash: h, fuzzyHash: "x", stringSetHash: "y", stringCount: 0 });
  const raw = [f(0, "own1"), f(1, "foreign"), f(2, "tool"), f(3, "mixed"), f(4, "real"), f(5, "new1")];
  const m = (i: number, h: string): SigModule => ({ factoryFunctionIndex: i, localModuleId: i, depCount: 0, depIds: [], factoryExactHash: h, factoryFuzzyHash: null, nestedFunctionCount: 0, functionSetHash: "z", factoryIsBaseline: false });
  return { dir, raw, mods: [m(0, "own1"), m(1, "foreign")] };
}
const LEGACY = ["own1", "foreign", "tool", "mixed", "real", "old1"]; // fn 5's scheme-1 hash is a scheme-1 baseline hash

test("LB1(d): ownership-aware subtraction keeps functions the baseline owns through the SAME package (src/deps/confirm.ts)", () => {
  const { dir, raw, mods } = ownershipFixture();
  try {
    const b = computeBaselineHashes([dir], 94);
    const { functions, modules } = subtractBaseline(raw, mods, b.hashes, { package: "p", owners: b.owners, legacyExactHashes: LEGACY });
    assert.deepEqual(functions.map((x) => x.exactHash), ["own1", "real"]);
    assert.equal(modules[0]!.factoryIsBaseline, false);
    assert.equal(modules[1]!.factoryIsBaseline, true);
    assert.deepEqual(subtractBaseline(raw, mods, b.hashes, { legacyExactHashes: LEGACY }).functions.map((x) => x.exactHash), ["real"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LB1(d): ownership-aware subtraction, bulk twin (tools/pkgsig/bulk/baseline-subtract.mjs)", () => {
  const { dir, raw, mods } = ownershipFixture();
  try {
    const b = computeBaselineUnion(dir, 94);
    const { functions } = subtractBaselineBulk(raw, mods, b.hashes, { package: "p", owners: b.owners, legacyExactHashes: LEGACY });
    assert.deepEqual(functions.map((x: SigFunction) => x.exactHash), ["own1", "real"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LB1 format guard: a pre-LB1 (version 2, scheme-1 hashes) commonality index loads as empty, never mixed", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-lb1-ci-"));
  try {
    writeFileSync(join(dir, "v2.json"), JSON.stringify({ version: 2, bundleCount: 3, hashes: { h: 2 } }));
    writeFileSync(join(dir, "v3.json"), JSON.stringify({ version: 3, bundleCount: 3, hashes: { h: 2 } }));
    assert.equal(loadCommonalityIndex(join(dir, "v2.json")).bundleCount, 0);
    assert.equal(loadCommonalityIndex(join(dir, "v3.json")).bundleCount, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LB1(d): truthFromMap reads Metro INDEX source maps (sections, RN 0.87) for baseline ownership", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-lb1-map-"));
  try {
    writeFileSync(join(dir, "b.js"), ["var x=1;", "__d(function(){},0,[1]);", "__d(function(){},1,[]);", "__d(function(){", "var y=2},2,[]);", ""].join("\n"));
    const sec = (line: number, src: string) => ({ offset: { line, column: 0 }, map: { version: 3, sources: [src], names: [], mappings: "AAAA" } });
    writeFileSync(join(dir, "b.map"), JSON.stringify({ version: 3, sections: [sec(0, "__prelude__"), sec(1, "/s/node_modules/@scope/pkg/index.js"), sec(2, "/s/node_modules/other/lib/a.js"), { offset: { line: 3, column: 0 }, map: { version: 3, sources: ["/s/node_modules/multi/i.js"], names: [], mappings: ";AAAA" } }] }));
    writeFileSync(join(dir, "b.hbc"), "x");
    const t = truthFromMap([join(dir, "b.hbc")], join(dir, "b.map"), join(dir, "b.js"));
    const t2 = t as { modules: Record<string, { package: string | null }> };
    assert.equal(t2.modules["0"]!.package, "@scope/pkg");
    assert.equal(t2.modules["1"]!.package, "other");
    assert.equal(t2.modules["2"]!.package, "multi", "a module spanning several lines, first line unmapped (RN 0.87 react.production.js)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
