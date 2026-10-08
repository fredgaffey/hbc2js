// Two layers (CLAUDE.md testing rules: no exact-output compare against a
// shared fixture's whole decompile):
//  - the "independent recount" test: reimplements the tag's definition from
//    scratch over the WRITTEN `calls.jsonl` rows (deliberately not importing
//    `isJsxFactoryCall` — the point is that two independent readings of the
//    same call index agree, the same posture A3's checker independence
//    takes for closure resolution) and asserts it equals what the writer
//    actually put in `functions.jsonl`/`modules.json`.
//  - the negative test: a module with zero JSX-factory call sites anywhere
//    in its owned functions is `rendersJsx:false` — on a hand-written
//    3-function sample artifact, not the big fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { cachedSplitProject as splitProject } from "../../support/decompiled.ts";
import { requireSweep } from "../../support/tiers.ts";
import { writeArtifact } from "../../../src/artifact/write.ts";

const JSX_FACTORY_NAMES = new Set(["jsx", "jsxs", "jsxDEV", "createElement"]);

/** The tag's definition, reimplemented independently from `calls.jsonl`
 *  alone (never imports `isJsxFactoryCall`) — a row is a JSX-factory call
 *  when it is a `method`-kind call through a property named `jsx`/`jsxs`/
 *  `jsxDEV`/`createElement` (`via`), or a `global`-kind call to one of those
 *  names directly (`callee`). */
function jsxCallerFns(calls: readonly { caller: number; kind: string; callee: unknown; via?: string }[]): Set<number> {
  const out = new Set<number>();
  for (const c of calls) {
    const isJsxMethod = c.kind === "method" && typeof c.via === "string" && JSX_FACTORY_NAMES.has(c.via);
    const isJsxGlobal = c.kind === "global" && typeof c.callee === "string" && c.callee.startsWith("g:") && JSX_FACTORY_NAMES.has(c.callee.slice(2));
    if (isJsxMethod || isJsxGlobal) out.add(c.caller);
  }
  return out;
}

function jsonl(text: string): unknown[] {
  return text.trim().split("\n").slice(1).map((l) => JSON.parse(l));
}

/** Builds a fresh artifact for `hbcPath` and returns its three files this
 *  test needs, parsed. Caller removes `outDir`. */
function buildArtifact(hbcPath: string, moduleName: string): { functions: any[]; modules: any[]; calls: any[]; outDir: string } {
  const bytes = readFileSync(hbcPath);
  const splitResult = splitProject(bytes, { moduleName });
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-renders-jsx-"));
  writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
  return {
    functions: jsonl(readFileSync(join(outDir, "index", "functions.jsonl"), "utf8")) as any[],
    modules: (JSON.parse(readFileSync(join(outDir, "index", "modules.json"), "utf8")) as { modules: any[] }).modules,
    calls: jsonl(readFileSync(join(outDir, "index", "calls.jsonl"), "utf8")) as any[],
    outDir,
  };
}

function assertRendersJsxMatchesCallsIndex(functions: any[], modules: any[], calls: any[]): { taggedFns: number; taggedModules: number } {
  const expectedFns = jsxCallerFns(calls);
  const actualTaggedFns = new Set(functions.filter((f) => f.rendersJsx === true).map((f) => f.fn));
  assert.deepEqual([...actualTaggedFns].sort((a, b) => a - b), [...expectedFns].sort((a, b) => a - b), "functions.jsonl rendersJsx must equal the set independently derived from calls.jsonl");

  // A module with no JSX call anywhere in its owned functions is false.
  const fnById = new Map(functions.map((f) => [f.fn, f]));
  for (const m of modules) {
    const owned = functions.filter((f) => f.module === m.id);
    const expected = owned.some((f) => expectedFns.has(f.fn));
    assert.equal(m.rendersJsx, expected, `module ${m.id}: rendersJsx must be the OR of its owned functions' rendersJsx`);
  }
  void fnById;
  return { taggedFns: actualTaggedFns.size, taggedModules: modules.filter((m) => m.rendersJsx === true).length };
}

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

test("rendersJsx: rn-template — functions.jsonl/modules.json agree with an independent recount from calls.jsonl", (t) => {
  const { functions, modules, calls, outDir } = buildArtifact(RN_TEMPLATE, "index.android.hbc");
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const { taggedFns, taggedModules } = assertRendersJsxMatchesCallsIndex(functions, modules, calls);
  assert.ok(taggedFns > 0, "rn-template is known to use JSX (the status notes jsx-recover measurement) — 0 tagged functions would mean the detector found nothing");
  assert.ok(taggedModules > 0);
  assert.ok(taggedModules <= modules.length);
});

test("rendersJsx: a module with no JSX-factory call anywhere in its owned functions is false (hand-written sample-artifact)", () => {
  const dir = join(repoRoot(), "tests", "artifact", "sample-artifact");
  const functions = jsonl(readFileSync(join(dir, "index", "functions.jsonl"), "utf8")) as any[];
  const modules = (JSON.parse(readFileSync(join(dir, "index", "modules.json"), "utf8")) as { modules: any[] }).modules;
  for (const f of functions) assert.equal(f.rendersJsx, false, `fn ${f.fn}: sample-artifact has no jsx/jsxs/createElement call site`);
  for (const m of modules) assert.equal(m.rendersJsx, false, `module ${m.id}: no owned function calls a JSX factory`);
});

const HELD_OUT = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc");

test("rendersJsx: held-out app (react-navigation-example-0.85.3) — same agreement with calls.jsonl", (t) => {
  if (!requireSweep(t)) return;
  if (!existsSync(HELD_OUT)) {
    t.skip(`${HELD_OUT} not present — run this fixture's fetch.sh first (INCONCLUSIVE, not a failure)`);
    return;
  }
  const { functions, modules, calls, outDir } = buildArtifact(HELD_OUT, "react-navigation-example.hbc");
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const { taggedFns, taggedModules } = assertRendersJsxMatchesCallsIndex(functions, modules, calls);
  assert.ok(taggedFns > 0, "react-navigation-example is a real RN screen app — 0 tagged functions would mean the detector found nothing on the held-out bundle");
  assert.ok(taggedModules > 0);
});
