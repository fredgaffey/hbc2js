// tests/gate/export/substitutions.test.ts — docs/specs/29-export.md §5 (library
// substitution). Acceptance test written with the spec; skipped by design until
// `src/export/index.ts` exists (§9). Substitution is the only export stage that
// can change behaviour, so these are the tightest assertions in the set: a
// substituted import must resolve to a dependency the deps pass actually
// identified, and nothing may be lost relative to the un-substituted tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { requireSweep } from "../../support/tiers.ts";
import {
  cleanup, exportTo, HELD_OUT, IMPLEMENTED, readManifest, readPackageJson, requireSpecifiers, RN_TEMPLATE, runCli, walk,
} from "./support.ts";

const SKIP = { skip: IMPLEMENTED ? false : "docs/specs/29-export.md not implemented yet (lane item 6c)" };

/** §5.2 S1: the confidence floor below which a package is never substituted. */
const SUBSTITUTION_CONFIDENCE_FLOOR = 0.8;

interface DepsReportJson {
  readonly confirmedDeps: readonly { readonly package: string; readonly version: string; readonly confidence: number }[];
}

test("spec 29 §5.2: every substituted package is an installed, confirmed dependency", SKIP, () => {
  const { out } = exportTo(RN_TEMPLATE);
  try {
    const m = readManifest(out);
    const pkg = readPackageJson(out);
    const deps = pkg.dependencies ?? {};
    const report = JSON.parse(runCli(["deps", RN_TEMPLATE, "--json", "--offline"]).stdout) as DepsReportJson;
    const confirmed = new Map(report.confirmedDeps.map((d) => [d.package, d]));

    for (const s of m.substitutions) {
      const installed = deps[s.package];
      assert.ok(installed !== undefined, `substituted ${s.package} is not in package.json dependencies`);
      assert.equal(installed, s.version, `substituted ${s.package} pinned at ${String(installed)}, manifest says ${s.version}`);
      const evidence = confirmed.get(s.package);
      assert.ok(evidence !== undefined, `substituted ${s.package} is not in the deps report's confirmedDeps`);
      assert.ok(
        evidence.confidence >= SUBSTITUTION_CONFIDENCE_FLOOR,
        `substituted ${s.package} at confidence ${evidence.confidence}, below the §5.2 S1 floor`,
      );
      assert.ok(s.replacedModules.length > 0, `substitution of ${s.package} replaced no modules`);
      assert.ok(s.edgesRewritten > 0, `substitution of ${s.package} rewrote no edges`);
      assert.ok(
        s.replacedModules.includes(s.boundaryModule),
        `substitution of ${s.package}: boundary module ${s.boundaryModule} is not among the replaced modules`,
      );
    }
    // rn-template's own react-native module graph genuinely has more than
    // one boundary module (measured: 13) -- §5.2 S2 must refuse it, not
    // silently substitute a package whose sub-path is unknown. This is the
    // non-vacuous half of this test: `m.substitutions` is expected to be
    // empty here (react-native and react are the only confirmedDeps and
    // neither clears S2 on this fixture), and the refusal itself must be on
    // record, not just absent from `substitutions[]`.
    assert.deepEqual(m.substitutions, [], "rn-template unexpectedly substituted a package -- update this comment/fixture assumption if that's now real");
    const refusal = m.unresolved.find((u) => u.kind === "multi-entry-package" && u.detail.startsWith("react-native:"));
    assert.ok(refusal !== undefined, "expected an S2 multi-entry-package refusal for react-native in unresolved[]");
  } finally {
    cleanup(out);
  }
});

test("spec 29 §5.2: the held-out app actually substitutes a package (S1-S4 exercised end to end)", { skip: IMPLEMENTED ? false : "docs/specs/29-export.md not implemented yet (lane item 6c)" }, (t) => {
  if (!requireSweep(t)) return;
  // `--tier flat` here: substitution's own correctness does not depend on
  // the render tier (the registry-level redirect, `src/export/registry.ts`,
  // is tier-agnostic -- see `src/export/substitute.ts`'s implementation
  // note), and `flat` skips the per-module pass ladder entirely, which is
  // the difference between this test costing seconds and costing the ~98s
  // `tree-layout.test.ts`'s full `passes`-tier held-out case measured.
  const { out, run } = exportTo(HELD_OUT, ["--tier", "flat"]);
  try {
    assert.equal(run.status, 0, `export failed: ${run.stderr}`);
    const m = readManifest(out);
    const pkg = readPackageJson(out);
    assert.ok(m.substitutions.length > 0, "held-out app: expected at least one real substitution");
    // react-native-gesture-handler is a single-module package on this
    // fixture (own(P) size 1, one boundary module, zero leaks) -- the
    // cleanest possible S1-S4 pass, measured by hand while building this
    // test. Assert it by name so a future regression in the boundary
    // analysis is caught even if some other package's substitution still
    // happens to keep `substitutions.length > 0` true.
    const gh = m.substitutions.find((s) => s.package === "react-native-gesture-handler");
    assert.ok(gh !== undefined, "expected react-native-gesture-handler to substitute on the held-out app");
    assert.equal(gh!.replacedModules.length, 1);
    assert.equal(gh!.edgesRewritten, 1);
    assert.equal(pkg.dependencies?.["react-native-gesture-handler"], gh!.version);
    const substitutedIds = new Set(m.substitutions.flatMap((s) => s.replacedModules));
    for (const mod of m.modules) assert.ok(!substitutedIds.has(mod.id), `module ${mod.id} is both kept and substituted`);
    // The registry's redirect must be a literal require() (Metro static
    // resolvability, docs comment in src/export/registry.ts), never a
    // dynamic `require(someVariable)` call -- assert the actual emitted
    // shape, not just that the package ends up in package.json.
    const registryText = readFileSync(join(out, "src", "_hbc", "registry.js"), "utf8");
    assert.match(registryText, /require\(["']react-native-gesture-handler["']\)/);
    // At least one multi-entry-package refusal too (react-native itself, on
    // this fixture) -- both S2 outcomes exercised in the same run.
    assert.ok(m.unresolved.some((u) => u.kind === "multi-entry-package"), "expected at least one multi-entry-package refusal on the held-out app");
  } finally {
    cleanup(out);
  }
});

test("spec 29 §5.3: on the held-out app, --substitute none and --substitute safe still cover the same module ids (non-vacuous: safe actually substitutes here)", { skip: IMPLEMENTED ? false : "docs/specs/29-export.md not implemented yet (lane item 6c)" }, (t) => {
  if (!requireSweep(t)) return;
  const none = exportTo(HELD_OUT, ["--substitute", "none", "--tier", "flat"]);
  const safe = exportTo(HELD_OUT, ["--substitute", "safe", "--tier", "flat"]);
  try {
    const mNone = readManifest(none.out);
    const mSafe = readManifest(safe.out);
    assert.deepEqual(mNone.substitutions, []);
    assert.ok(mSafe.substitutions.length > 0, "expected --substitute safe to actually substitute on the held-out app");
    const noneIds = new Set(mNone.modules.map((m) => m.id));
    const safeIds = new Set([
      ...mSafe.modules.map((m) => m.id),
      ...mSafe.substitutions.flatMap((s) => [...s.replacedModules]),
    ]);
    assert.deepEqual([...safeIds].sort((a, b) => a - b), [...noneIds].sort((a, b) => a - b),
      "substitution lost or invented module ids relative to the un-substituted tree");
  } finally {
    cleanup(none.out);
    cleanup(safe.out);
  }
});

test("spec 29 §4.4: every bare require specifier names an installed package", SKIP, () => {
  const { out } = exportTo(RN_TEMPLATE);
  try {
    const pkg = readPackageJson(out);
    const installed = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const builtins = new Set(["react", "react-native"]);
    for (const rel of walk(out).filter((f) => f.endsWith(".js"))) {
      for (const spec of requireSpecifiers(readFileSync(join(out, rel), "utf8"))) {
        if (spec.startsWith("./") || spec.startsWith("../")) continue;
        const root = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] ?? spec);
        assert.ok(
          installed.has(root) || builtins.has(root),
          `${rel} requires bare specifier ${spec}, but ${root} is in neither dependencies nor devDependencies`,
        );
      }
    }
  } finally {
    cleanup(out);
  }
});

test("spec 29 §3.2: every relative require specifier resolves to a file in the tree", SKIP, () => {
  const { out } = exportTo(RN_TEMPLATE);
  try {
    for (const rel of walk(out).filter((f) => f.endsWith(".js"))) {
      const abs = join(out, rel);
      for (const spec of requireSpecifiers(readFileSync(abs, "utf8"))) {
        if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
        const target = resolve(dirname(abs), spec);
        const ok = existsSync(target) || existsSync(`${target}.js`) || existsSync(join(target, "index.js"));
        assert.ok(ok, `${rel} requires ${spec}, which does not exist in the exported tree`);
      }
    }
  } finally {
    cleanup(out);
  }
});

test("spec 29 §5.3: --substitute none and --substitute safe cover the same module ids", SKIP, () => {
  const none = exportTo(RN_TEMPLATE, ["--substitute", "none"]);
  const safe = exportTo(RN_TEMPLATE, ["--substitute", "safe"]);
  try {
    const mNone = readManifest(none.out);
    const mSafe = readManifest(safe.out);
    assert.deepEqual(mNone.substitutions, [], "--substitute none still substituted something");
    const noneIds = new Set(mNone.modules.map((m) => m.id));
    const safeIds = new Set([
      ...mSafe.modules.map((m) => m.id),
      ...mSafe.substitutions.flatMap((s) => [...s.replacedModules]),
    ]);
    assert.deepEqual([...safeIds].sort((a, b) => a - b), [...noneIds].sort((a, b) => a - b),
      "substitution lost or invented module ids relative to the un-substituted tree");
  } finally {
    cleanup(none.out);
    cleanup(safe.out);
  }
});
