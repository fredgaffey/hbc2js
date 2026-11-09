// docs/specs/33-export-boot.md §3/§7 — acceptance tests for the export boot
// proof. They are `todo` until `src/harness/export-boot.ts` exists: each body
// returns immediately while the module is absent, so the gate pays nothing and
// never fails on them. An implementing landing removes `todo` from the tests
// it makes pass (L1: 1-6, L2: 7-8, L3: 9, L4: 10).
//
// The module is imported dynamically by a computed path so this file
// typechecks before the module exists. The expected API (spec §1):
//   exportBootProof(original, exportDir, {phase, seed, horizonMs, firstNative})
//     -> Promise<{verdict, phase, appKeys:{a,b}, runApplication:{a,b},
//                 factories:{a,b}, divergence, masked, exportExec, reason}>
//   projectBootTrace(trace, {mask?}) -> readonly string[]   (§3 projection)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { requireSweep } from "../../support/tiers.ts";
import { repoRoot } from "../../support/paths.ts";
import { cleanup, exportTo, readManifest } from "../export/support.ts";

const MODULE = join(repoRoot(), "src", "harness", "export-boot.ts");
const IMPLEMENTED = existsSync(MODULE);
const TODO = { todo: "docs/specs/33-export-boot.md not implemented yet" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function load(): Promise<any> {
  const path: string = MODULE;
  return import(path);
}

const RN_DIR = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72");
const RN_BUNDLE = join(RN_DIR, "index.android.bundle");
const RN_HBC = join(RN_DIR, "index.android.hbc");
const HO_DIR = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3");
const HO_BUNDLE = join(HO_DIR, "index.android.bundle");
const HO_HBC = join(HO_DIR, "react-navigation-example.hbc");

// The first function declared in an exported module file is its factory
// (the decompiled render names it `_fn<idx>`, not `factory`).
const FACTORY_HEAD = /(function [\w$]+\([^)]*\)\s*\{)/;

const GATE_EXPORT = ["--instrument=modules", "--substitute", "none"];

/** Find the exported file for original module `id` via EXPORT.json. */
function moduleFile(out: string, id: number): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = (readManifest(out) as any).modules.find((m: { id: number }) => m.id === id);
  assert.ok(row?.path, `module ${id} has an export path`);
  return join(out, row.path);
}

// Test 1 was `todo` on one decompile gap (docs/BUGS.md export-boot L1, now
// Resolved): rn-template module 87 probes `hasNativeConstructor(function* ()
// {}, "GeneratorFunction")` in strict code; the zero-yield generator was not
// recovered to a native `function*`, so the export polyfilled
// regeneratorRuntime and entered module 82 where the original does not. Fixed
// in `src/passes/generator-shape.ts` (regression: fixture 395 and
// tests/gate/passes/yield-recovery.test.ts "export-boot L1").
test("spec 33 test 1: rn-template export boots like the original (B1 register)", async () => {
  if (!IMPLEMENTED) return;
  const { exportBootProof } = await load();
  const { out, run } = exportTo(RN_HBC, GATE_EXPORT);
  try {
    assert.equal(run.status, 0, run.stderr);
    const r = await exportBootProof(RN_BUNDLE, out, { phase: "register" });
    assert.equal(r.verdict, "EQUIVALENT", r.reason ?? JSON.stringify(r.divergence));
    assert.ok(r.appKeys.a.length > 0, "the original registers at least one app key");
    assert.deepEqual(r.appKeys.b, r.appKeys.a);
    assert.equal(r.factories.b, r.factories.a);
    assert.equal(r.masked, 0, "--substitute none masks nothing");
  } finally {
    cleanup(out);
  }
});

test("spec 33 test 2: the projection of the original against itself is stable and non-trivial", async () => {
  if (!IMPLEMENTED) return;
  const { projectBootTrace } = await load();
  const { bootTrace } = await import("../../../src/harness/boot-equiv.ts");
  const src = readFileSync(RN_BUNDLE, "utf8");
  const a = projectBootTrace(bootTrace(src, { seed: 0 }).trace);
  const b = projectBootTrace(bootTrace(src, { seed: 0 }).trace);
  assert.deepEqual(a, b);
  assert.ok(a.some((e: string) => e.startsWith("enter ")), "factory enters are projected");
  assert.ok(a.some((e: string) => e.startsWith("registerComponent ")), "app keys are projected");
  assert.ok(!a.some((e: string) => /^call __[dr] /.test(e)), "raw Metro __d/__r never reach the projection");
});

test("spec 33 test 3: an export factory that throws is DIVERGENT, not INCONCLUSIVE", async () => {
  if (!IMPLEMENTED) return;
  const { exportBootProof } = await load();
  const { out, run } = exportTo(RN_HBC, GATE_EXPORT);
  try {
    assert.equal(run.status, 0, run.stderr);
    // Throw from the entry module's factory (the original boots it cleanly).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (readManifest(out) as any).source.entryModule as number;
    const f = moduleFile(out, entry);
    writeFileSync(f, readFileSync(f, "utf8").replace(FACTORY_HEAD, `$1 throw new Error("boot-proof-injected");`));
    const r = await exportBootProof(RN_BUNDLE, out, { phase: "register" });
    assert.equal(r.verdict, "DIVERGENT");
    assert.match(JSON.stringify(r.divergence), /boot-proof-injected|throw/);
  } finally {
    cleanup(out);
  }
});

test("spec 33 test 4: a reordered eager require is caught at the first differing factory enter", async () => {
  if (!IMPLEMENTED) return;
  const { exportBootProof, projectBootTrace } = await load();
  const { bootTrace } = await import("../../../src/harness/boot-equiv.ts");
  const original = projectBootTrace(bootTrace(readFileSync(RN_BUNDLE, "utf8"), { seed: 0 }).trace) as string[];
  const enters = original.filter((e) => e.startsWith("enter ")).map((e) => Number(e.split(" ")[1]));
  assert.ok(enters.length >= 3);
  const first = enters[0]!, late = enters[enters.length - 1]!;
  const { out, run } = exportTo(RN_HBC, GATE_EXPORT);
  try {
    assert.equal(run.status, 0, run.stderr);
    // Make the first factory eagerly require the last one: `late` now enters early.
    const f = moduleFile(out, first);
    writeFileSync(f, readFileSync(f, "utf8").replace(FACTORY_HEAD, `$1 __hbc.r(${late});`));
    const r = await exportBootProof(RN_BUNDLE, out, { phase: "register" });
    assert.equal(r.verdict, "DIVERGENT");
    assert.match(String(r.divergence.b), new RegExp(`enter ${late}\\b`));
  } finally {
    cleanup(out);
  }
});

test("spec 33 test 5: an original that cannot boot under the stub host is INCONCLUSIVE, never PASS", async () => {
  if (!IMPLEMENTED) return;
  const { exportBootProof } = await load();
  const { out, run } = exportTo(RN_HBC, GATE_EXPORT);
  try {
    assert.equal(run.status, 0, run.stderr);
    const broken = join(out, "broken-original.js");
    writeFileSync(broken, `throw new Error("stub-host gap");\n` + readFileSync(RN_BUNDLE, "utf8"));
    const r = await exportBootProof(broken, out, { phase: "register" });
    assert.equal(r.verdict, "INCONCLUSIVE");
    assert.match(String(r.reason), /stub-host gap|original/);
  } finally {
    cleanup(out);
  }
});

test("spec 33 test 6: code outside any tracked factory and substituted ids are excluded symmetrically", async () => {
  if (!IMPLEMENTED) return;
  const { projectBootTrace } = await load();
  const rec = (fn: string, args: unknown[]) => ({ k: "call", fn, args });
  const probe = (ev: string, id: number) => rec("__HBC_BOOT_PROBE__", [ev, id]);
  // A polyfill-time native call (outside every factory) and a Metro __d: both dropped.
  const trace = [
    rec("__turboModuleProxy", ["PlatformConstants"]),
    rec("__d", [7, "[]"]),
    probe("enter", 1), rec("__turboModuleProxy", ["DeviceInfo"]),
    probe("enter", 2), probe("exit", 2),
    probe("exit", 1),
    { k: "end" },
  ];
  const p = projectBootTrace(trace) as string[];
  assert.ok(!p.some((e) => e.includes("PlatformConstants")), "out-of-factory native call excluded");
  assert.ok(p.some((e) => e.includes("DeviceInfo")), "in-factory native call kept");
  assert.ok(!p.some((e) => /__d/.test(e)));
  const masked = projectBootTrace(trace, { mask: new Set([2]) }) as string[];
  assert.ok(!masked.some((e) => / 2$/.test(e)), "a substituted id is masked out");
});

test("spec 33 test 7: the export side runs as hermesc-compiled bytecode when hermesc is available", async () => {
  if (!IMPLEMENTED) return;
  const { exportBootProof, findHermesc } = await load();
  const { out, run } = exportTo(RN_HBC, GATE_EXPORT);
  try {
    assert.equal(run.status, 0, run.stderr);
    const r = await exportBootProof(RN_BUNDLE, out, { phase: "register" });
    assert.equal(r.exportExec, findHermesc() ? "bytecode" : "source");
    assert.equal(r.verdict, "EQUIVALENT");
  } finally {
    cleanup(out);
  }
});

test("spec 33 test 8: `equiv --boot <original> <export-dir> --json` prints export-boot/1 and exits 0", async () => {
  if (!IMPLEMENTED) return;
  const { out, run } = exportTo(RN_HBC, GATE_EXPORT);
  try {
    assert.equal(run.status, 0, run.stderr);
    const cli = spawnSync(process.execPath, [join(repoRoot(), "src", "cli.ts"), "equiv", "--boot", RN_BUNDLE, out, "--json"], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    const j = JSON.parse(cli.stdout);
    assert.equal(j.schema, "export-boot/1");
    assert.equal(j.verdict, "EQUIVALENT");
    for (const k of ["phase", "appKeys", "runApplication", "factories", "masked", "exportExec"]) assert.ok(k in j, k);
  } finally {
    cleanup(out);
  }
});

test("spec 33 test 9: rn-template B2 — runApplication with the same key renders the same view-name sequence", async () => {
  if (!IMPLEMENTED) return;
  const { exportBootProof } = await load();
  const { out, run } = exportTo(RN_HBC, GATE_EXPORT);
  try {
    assert.equal(run.status, 0, run.stderr);
    const r = await exportBootProof(RN_BUNDLE, out, { phase: "run", horizonMs: 1000 });
    assert.equal(r.verdict, "EQUIVALENT", r.reason ?? JSON.stringify(r.divergence));
    assert.equal(r.phase, "run");
    assert.ok(r.runApplication.a, "the original reached runApplication");
    assert.equal(r.runApplication.b, r.runApplication.a, "same app key");
    assert.ok(r.views.a.length > 0 && r.commits.a > 0 && r.commits.b > 0, "at least one commit each side");
    assert.deepEqual(r.views.b, r.views.a);
  } finally {
    cleanup(out);
  }
});

test("spec 33 test 10: held-out app (v98, bridgeless) boots like the original, B1 and B2 (sweep)", TODO, async (t) => {
  if (!IMPLEMENTED) return;
  if (!requireSweep(t)) return;
  if (!existsSync(HO_BUNDLE) || !existsSync(HO_HBC)) { t.skip("run the fixture's fetch.sh"); return; }
  const { exportBootProof } = await load();
  const { out, run } = exportTo(HO_HBC, [...GATE_EXPORT, "--tier", "flat"]);
  try {
    assert.equal(run.status, 0, run.stderr);
    const r = await exportBootProof(HO_BUNDLE, out, { phase: "run", horizonMs: 1000 });
    assert.equal(r.verdict, "EQUIVALENT", r.reason ?? JSON.stringify(r.divergence));
  } finally {
    cleanup(out);
  }
});
