// tests/gate/export/manifest.test.ts — docs/specs/29-export.md §6 (EXPORT.json)
// and §7 (what the index work is used for). Acceptance test written with the
// spec; skipped by design until `src/export/index.ts` exists (§9). The coverage
// invariant below is the one assertion the whole design rests on: nothing is
// dropped, nothing is counted twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, exportTo, IMPLEMENTED, readManifest, RN_TEMPLATE } from "./support.ts";

const SKIP = { skip: IMPLEMENTED ? false : "docs/specs/29-export.md not implemented yet (lane item 6b)" };

/** §6: the closed set of reasons an item can be left unresolved. A new reason is
 *  a spec change, not a free-text field. */
const UNRESOLVED_KINDS = new Set([
  "multi-entry-package",
  "low-confidence",
  "not-closed",
  "framework-version-unknown",
  "guessed-not-installed",
  "anonymous-library",
  "unclassified-module",
  "no-readable-render",
  "no-entry-module",
  "entry-module-path-unknown",
  "asset-bytes-missing",
  "native-module",
  "ambiguous-owner",
]);

const TIERS = new Set(["passes", "jsx", "flat", "stub"]);

test("spec 29 §6: EXPORT.json carries the documented schema and provenance", SKIP, () => {
  const { out } = exportTo(RN_TEMPLATE);
  try {
    const m = readManifest(out);
    assert.equal(m.schema, "hbc2js-export/1");
    assert.ok(m.producer.hbc2js.length > 0, "producer.hbc2js is empty");
    assert.match(m.producer.ts, /^\d{4}-\d{2}-\d{2}T/, "producer.ts is not an ISO timestamp");
    assert.match(m.source.bundleSha256, /^[0-9a-f]{64}$/, "source.bundleSha256 is not a sha256");
    assert.ok(m.source.hbcVersion > 0, "source.hbcVersion missing");
    assert.ok(m.source.moduleCount > 0, "source.moduleCount missing");
    assert.ok(["registerComponent", "flag", "fallback"].includes(m.app.nameSource), `bad app.nameSource ${m.app.nameSource}`);
    assert.ok(Array.isArray(m.leftOut) && m.leftOut.length > 0, "leftOut must state what the export omits");
  } finally {
    cleanup(out);
  }
});

test("spec 29 §6: coverage invariant -- every module id appears exactly once", SKIP, () => {
  const { out } = exportTo(RN_TEMPLATE);
  try {
    const m = readManifest(out);
    const kept = m.modules.map((mod) => mod.id);
    const replaced = m.substitutions.flatMap((s) => [...s.replacedModules]);
    const all = [...kept, ...replaced];
    assert.equal(new Set(all).size, all.length, "a module id is listed twice across modules[] and substitutions[]");
    assert.equal(new Set(kept).size, kept.length, "modules[] repeats an id");
    const keptSet = new Set(kept);
    for (const id of replaced) {
      assert.ok(!keptSet.has(id), `module ${id} is both kept and replaced by a substitution`);
    }
    assert.equal(all.length, m.source.moduleCount, "modules[] + replacedModules does not cover every module in the bundle");
  } finally {
    cleanup(out);
  }
});

test("spec 29 §6: every unresolved reason comes from the closed set", SKIP, () => {
  const { out } = exportTo(RN_TEMPLATE);
  try {
    const m = readManifest(out);
    for (const u of m.unresolved) {
      assert.ok(UNRESOLVED_KINDS.has(u.kind), `unresolved kind ${u.kind} is not in spec 29 §6's closed set`);
      assert.ok(typeof u.detail === "string" && u.detail.length > 0, `unresolved ${u.kind} has no detail`);
    }
  } finally {
    cleanup(out);
  }
});

test("spec 29 §6: counts agree with the arrays they summarise", SKIP, () => {
  const { out } = exportTo(RN_TEMPLATE);
  try {
    const m = readManifest(out);
    const counts = m.counts as Record<string, number>;
    assert.equal(counts["modules"], m.modules.length, "counts.modules disagrees with modules[]");
    assert.equal(counts["substitutedPackages"], m.substitutions.length, "counts.substitutedPackages disagrees");
    assert.equal(
      counts["substitutedModules"],
      m.substitutions.reduce((n, s) => n + s.replacedModules.length, 0),
      "counts.substitutedModules disagrees",
    );
    assert.equal(counts["unresolved"], m.unresolved.length, "counts.unresolved disagrees");
  } finally {
    cleanup(out);
  }
});

test("spec 29 §7.3: every listed module has a real file and a known tier", SKIP, () => {
  const { out } = exportTo(RN_TEMPLATE);
  try {
    const m = readManifest(out);
    for (const mod of m.modules) {
      assert.ok(existsSync(join(out, mod.path)), `module ${mod.id}: ${mod.path} does not exist`);
      assert.ok(TIERS.has(mod.tier), `module ${mod.id}: unknown tier ${mod.tier}`);
      if (mod.tier === "passes" || mod.tier === "jsx") {
        assert.equal(mod.tierDowngradeReason, null, `module ${mod.id}: an undowngraded tier carries a downgrade reason`);
      } else {
        assert.ok(
          typeof mod.tierDowngradeReason === "string" && mod.tierDowngradeReason.length > 0,
          `module ${mod.id}: tier ${mod.tier} must say why it was downgraded`,
        );
      }
      assert.ok(mod.eagerDeps >= 0 && mod.lazyDeps >= 0, `module ${mod.id}: negative dep counts`);
    }
    // spec 29 §7.1 point 3: real per-module dep-kind counts, not a
    // placeholder (a tree with every count at zero would still pass every
    // assertion above without this).
    const totalEager = m.modules.reduce((n, mod) => n + mod.eagerDeps, 0);
    assert.ok(totalEager > 0, "no module reports an eager dependency -- eagerDeps/lazyDeps look unwired");
  } finally {
    cleanup(out);
  }
});

test("spec 29 §7.2: --tier jsx renders only rendersJsx-tagged modules at tier jsx, the rest at passes", SKIP, () => {
  const { out } = exportTo(RN_TEMPLATE, ["--tier", "jsx"]);
  try {
    const m = readManifest(out);
    const jsxTagged = m.modules.filter((mod) => mod.rendersJsx);
    const jsxTiered = m.modules.filter((mod) => mod.tier === "jsx");
    assert.ok(jsxTagged.length > 0, "no module on rn-template is tagged rendersJsx -- nothing to select from");
    assert.ok(jsxTiered.length > 0, "--tier jsx produced zero modules at tier jsx");
    // Every module rendered at tier jsx is one the index actually tagged
    // rendersJsx -- proves the selection is driven by the tag (§7.2 point
    // 1), not a blanket "every module under --tier jsx" rule.
    for (const mod of jsxTiered) {
      assert.ok(mod.rendersJsx, `module ${mod.id}: tier jsx but not tagged rendersJsx`);
    }
    // A module NOT tagged rendersJsx still renders (at passes), it is never
    // silently dropped just because the CLI ceiling is jsx.
    const untaggedStillPasses = m.modules.filter((mod) => !mod.rendersJsx);
    assert.ok(
      untaggedStillPasses.every((mod) => mod.tier === "passes"),
      "an untagged module under --tier jsx did not fall through to tier passes",
    );
  } finally {
    cleanup(out);
  }
});

test("spec 29 §7.3: the fallback ladder downgrades to flat, then to stub, and records why", SKIP, async () => {
  // rn-template's own factory bodies all render cleanly under the export CLI
  // (checked above -- there is no naturally-occurring failure to assert on
  // in this fixture), so this exercises `renderModuleTiered`'s ladder
  // directly against a REAL `ModuleAnalysis` with a deliberately invalid
  // `factoryFn`, the same forced-failure-unit-case approach
  // `tests/gate/emit/scoped-decompile.test.ts` uses for the render function
  // underneath it. Both rungs the CLI-level tests above cannot reach:
  // renderModuleReadable throwing, and that throw's two different
  // downgrade destinations.
  const { splitProject } = await import("../../../src/split/index.ts");
  const { renderModuleTiered } = await import("../../../src/export/tiers.ts");
  const bytes = readFileSync(RN_TEMPLATE);
  const splitResult = splitProject(new Uint8Array(bytes), { moduleName: "index.android.debug.hbc" });
  const BAD_FACTORY_FN = 999_999; // out of range -- emitModule's onlyFunction lookup throws E_USAGE

  const flatCase = renderModuleTiered({
    analysis: splitResult.analysis,
    factoryFn: BAD_FACTORY_FN,
    moduleId: 0,
    requestedTier: "passes",
    rendersJsx: false,
    moduleName: "index.android.debug.hbc",
    flatText: "// hbc2js --split -- module 0 (ordinary flat text, factory reachable)\nfunction factory(global, require, importDefault, importAll, module, exports, dependencyMap) {}\n__d(factory, 0, []);\n",
  });
  assert.equal(flatCase.tier, "flat", "an ordinary flat fallback (factory reachable) must land on tier flat, not stub");
  assert.ok(typeof flatCase.tierDowngradeReason === "string" && flatCase.tierDowngradeReason.length > 0, "flat downgrade has no reason");
  assert.equal(flatCase.unresolved, undefined, "a flat downgrade (not a stub) must not add an unresolved row");

  const stubCase = renderModuleTiered({
    analysis: splitResult.analysis,
    factoryFn: BAD_FACTORY_FN,
    moduleId: 1,
    requestedTier: "passes",
    rendersJsx: false,
    moduleName: "index.android.debug.hbc",
    flatText: "// hbc2js --split -- module 1: factory fn#999999 was not reachable from the module graph\nfunction factory(global, require, importDefault, importAll, module, exports, dependencyMap) {}\n__d(factory, 1, []);\n",
  });
  assert.equal(stubCase.tier, "stub", "an unreachable-factory fallback must land on tier stub, not flat");
  assert.ok(typeof stubCase.tierDowngradeReason === "string" && stubCase.tierDowngradeReason.length > 0, "stub downgrade has no reason");
  assert.ok(stubCase.unresolved !== undefined, "a stub downgrade must add an unresolved row");
  assert.equal(stubCase.unresolved?.kind, "no-readable-render");
  assert.ok(stubCase.unresolved!.detail.length > 0, "unresolved row has no detail");
});
