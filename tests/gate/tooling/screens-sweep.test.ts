// Known negative: NOT ONE of the 49 navigators found came from `calls-resolved.jsonl`
// (`evidence:"creator-call"`, the PROVEN tier) -- every one is
// `creator-name-property-get` (a property-get of the creator's name,
// never itself proof a call happened). Root cause: the app's own
// `createStackNavigator()`/`createStaticNavigation()`/`createDrawerNavigator()`
// call sites are many statements away from their own `require()` inside one
// large factory function (`index.tsx`), which crosses `semantic-walk.ts`'s
// documented BLOCK-LOCAL dataflow boundary (a real, already-known limitation,
// not something this item introduces or fixes) -- the points-to pass never
// gets a chance to resolve them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireSweep } from "../../support/tiers.ts";
import { repoRoot } from "../../support/paths.ts";
import { cachedSplitProject as splitProject } from "../../support/decompiled.ts";
import { writeArtifact } from "../../../src/artifact/write.ts";
import { ArtifactService } from "../../../src/artifact/service.ts";
import { screens } from "../../../src/artifact/screens.ts";

const BUNDLE = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc");

// The app's own real route-name registry (`/example/src/screens.tsx`'s
// `SCREENS` object, 44 keys) -- see the file header for how this was read.
const REAL_SCREEN_NAMES = [
  "NativeStack", "NativeStackCardModal", "NativeStackFormSheet", "NativeStackHeaderCustomization",
  "NativeStackPreloadFlow", "NativeStackPreventRemove", "StackAnimations", "StackBasic",
  "StackCardModal", "StackFloatScreenHeader", "StackHeaderCustomization", "StackModal",
  "StackPreloadFlow", "StackPreventRemove", "StackTransparentModal", "NativeBottomTabs",
  "NativeBottomTabsCustomTabBar", "BottomTabs", "BottomTabsDynamic", "BottomTabsFullHistory",
  "BottomTabsPreloadFlow", "DrawerMasterDetail", "MaterialTopTabsBasic", "LibrariesDrawerLayout",
  "LibrariesTabView", "ComponentsButton", "ComponentsHeaders", "ComponentsLink",
  "ComponentsMaterialSymbols", "ComponentsSFSymbols", "AuthFlow", "NavigatorLayout",
  "ScreenLayout", "StaticConfigScreen", "StackRetain", "ActivityModes", "BottomTabsShowcase",
  "DrawerShowcase", "MaterialTopTabsShowcase", "NativeStackShowcase", "StackShowcase",
  "MyStackStatic", "MyStackDynamic", "Loaders",
] as const;
// "StaticConfigScreen" is imported as `import { StaticConfig as StaticConfigScreen }`; this
// tool reports the EXPORT name ("StaticConfig"), not the local alias -- see
// `src/artifact/screens.ts`'s `ScreenRow.name` doc comment for why (the
// registry's own object-literal KEYS are baked into a constant buffer this
// artifact format does not scan). The floor below accounts for this one
// known rename rather than asserting a name this tool cannot produce.
const REAL_SCREEN_NAMES_AS_RECOVERABLE = new Set<string>(REAL_SCREEN_NAMES.map((n) => (n === "StaticConfigScreen" ? "StaticConfig" : n)));

void test("screens (sweep): real react-navigation-example.hbc -- coverage floor against the app's own 44-entry screen registry", (t) => {
  if (!requireSweep(t)) return;

  const bytes = readFileSync(BUNDLE);
  const splitResult = splitProject(bytes, { moduleName: "react-navigation-example.hbc" });
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-screens-sweep-"));
  try {
    writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
    const svc = new ArtifactService(outDir);
    const result = screens(svc, { all: true });

    // Real negative, measured above: no navigator in this run is proven by
    // a resolved call. Recorded, not silently accepted -- if this ever
    // flips to >0 it is real progress on the points-to pass, not a
    // regression, and this assertion should be updated to say so.
    assert.equal(result.navigators.filter((n) => n.evidence === "creator-call").length, 0);
    // Floor, not an exact count: at least 10 navigator-name mentions found
    // anywhere in this ~5.2k-module bundle (measured: 49).
    assert.ok(result.totalNavigators >= 10, `expected >= 10 navigators, got ${result.totalNavigators}`);

    // The root registry: found generically (never hard-coded which module
    // id it is) via the ONE navigator whose kind is "Static" -- this app
    // calls `createStaticNavigation` exactly once, per its own source.
    const staticNav = result.navigators.find((n) => n.kind === "Static");
    assert.ok(staticNav !== undefined, "expected a createStaticNavigation navigator to be found");
    // The root registry module is a DIRECT eager dep of the Static
    // navigator's own module -- recompute that relation instead of
    // asserting on a magic id.
    const staticModule = svc.allModules().find((m) => m.id === staticNav!.module);
    assert.ok(staticModule !== undefined);
    const rootRegistryIds = new Set(staticModule!.deps.filter((d) => d.kind === "eager").map((d) => d.id));
    const rootRows = result.screens.filter((s) => rootRegistryIds.has(s.registryModule));

    const foundNames = new Set(rootRows.map((r) => r.name));
    const foundReal = [...foundNames].filter((n) => REAL_SCREEN_NAMES_AS_RECOVERABLE.has(n));
    // Floor per the brief ("gate-assert a floor, not an exact count"):
    // measured 44/44 on this run; assert a floor with headroom for a
    // future heuristic change, never the exact figure.
    assert.ok(foundReal.length >= 40, `expected >= 40 of the 44 real screen names recovered, got ${foundReal.length}: ${[...foundNames].sort().join(",")}`);

    const unambiguous = rootRows.filter((r) => r.component !== null);
    assert.ok(unambiguous.length >= 38, `expected >= 38 unambiguous component attributions among the root registry's rows, got ${unambiguous.length}`);

    // Every row's evidence is a real one of the three documented tiers --
    // never a bare boolean/guess with no explanation.
    for (const s of result.screens) {
      assert.ok(s.component === null || s.component.evidence === "registry-dep-name-match");
      if (s.component === null) assert.ok(s.componentNote.length > 0);
    }
    for (const n of result.navigators) {
      assert.ok(n.evidence === "creator-call" || n.evidence === "creator-name-property-get");
    }

    assert.equal(rootRows.length, unambiguous.length + rootRows.filter((r) => r.component === null).length);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
