// Root cause of the earlier "0 seams, 11 unclassifiable" result: the large bundle's `export
// default <identifier>` compiling to a live-binding getter
// (`Object.defineProperty(exports, "default", {get(){...}})`) under
// whatever exact Babel/Metro patch version built this app, vs this repo's
// pinned toolchain's direct `exports.default = ...` assignment for the
// SAME source. That getter is, unavoidably, an EXTRA nested closure of its
// own (a getter cannot be expressed without one) — so the large bundle's
// module has one more nested closure than the candidate even when every
// nested STRING CONSTANT is byte-identical between them (hand-diffed on
// BackHandler: 6/6 overlap). This breaks every hash-SET tier (nested-exact,
// nested-fuzzy, and the closure-less whole-set fallback) regardless of
// which functions are excluded, because they all compare SET size/hash,
// not content.
//
// FIX: added a fourth tier, `nestedStringsMatch` in
// `src/tooling/seams.ts` — compares nested STRING CONSTANTS directly (no
// hash), which survives a closure-population-size mismatch. Tried only
// when nested-exact/nested-fuzzy/whole-set (`tierOf`) found nothing at all,
// gated so it can never coin-flip between the two platforms (see that
// function's own doc comment for the exact preconditions; unit-tested
// per-precondition in tests/gate/tooling/seams-nested-strings.test.ts).
// Measured directly on this fixture (`react-navigation-example.hbc`,
// release build): `--platform ios` now reports 5 seams (BackHandler,
// Platform, RCTNetworking, ToastAndroid, legacySendAccessibilityEvent, all
// matchTier "nested-strings", all matchedPlatform "android" — consistent
// with this app really being an android build per its own BUILD.md), down
// from 11 unclassifiable to 6 still-unclassifiable (the remaining gap is
// real and not addressed by this tier — likely modules whose nested string
// sets don't clear the >= 3 threshold, or whose bundle module has extra
// wrapper-introduced strings beyond the getter that no longer set-equal
// the candidate's; not investigated further here, out of this item's
// scope). `neutralModuleCount` (620) is identical before/after — this tier
// never touches `scanRnDir`, only which VARIANT modules classify.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runSeams } from "../../../src/tooling/seams.ts";
import { requireSweep } from "../../support/tiers.ts";
import { repoRoot } from "../../support/paths.ts";

const BUNDLE = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc");
const RN_DIR = join(repoRoot(), "node_modules", "react-native");

test("sweep: seams reports the held-out app's baked-in variants as seams (not all-unclassifiable)", async (t) => {
  if (!requireSweep(t)) return;
  if (!existsSync(BUNDLE)) {
    t.skip("held-out bundle not present — run tests/fixtures/bundles/react-navigation-example-0.85.3/fetch.sh first");
    return;
  }
  const bytes = new Uint8Array(readFileSync(BUNDLE));
  const result = await runSeams(bytes, { rnDir: RN_DIR, platform: "ios" });
  assert.ok(
    result.seams.length > 0,
    `expected at least one seam (real Metro-baked android variant flagged against --platform ios) on react-navigation-example.hbc; got 0 seams, ` +
      `${result.unclassifiable.length} unclassifiable: ${JSON.stringify(result.unclassifiable, null, 2)}`,
  );
  const names = result.seams.map((s) => s.name);
  assert.ok(
    names.includes("BackHandler"),
    `expected BackHandler among react-navigation-example.hbc's seams (the nested-strings tier's known case); got: ${JSON.stringify(names)}`,
  );
  assert.ok(
    result.seams.every((s) => s.matchedPlatform === "android"),
    `expected every seam's matchedPlatform to be "android" (react-navigation-example.hbc's own BUILD.md records an android build); got: ${JSON.stringify(result.seams)}`,
  );
  // The nested-strings tier only changes which VARIANT modules classify —
  // it never touches scanRnDir, so the neutral-module count (modules that
  // structurally cannot produce a cross-platform seam) must stay exactly
  // what it was before this tier existed. Named per-bundle: always name the
  // bundle file with any number you quote.
  assert.equal(result.neutralModuleCount, 620, "react-navigation-example.hbc's neutralModuleCount must not change when the nested-strings tier is added");
});

// Falsification step: if the
// tier were matching on noise (e.g. some property of the bundle unrelated
// to which platform's source is really baked in) rather than genuine
// platform identity, swapping --platform would report the SAME modules as
// seams either way (matchedPlatform "android" fixed, requested platform
// flipped — a real matcher reports the OPPOSITE set, a noise-matcher
// reports the SAME set either way since it never depended on opts.platform
// in the first place). react-navigation-example.hbc really is an android
// build (BUILD.md), so the honest, falsifiable prediction is: --platform
// android reports ZERO seams (the correct platform is baked in, matching
// the "matchedPlatform === opts.platform -> not a seam" rule), and in
// particular none of the five names --platform ios reported.
test("sweep: seams with the platforms swapped does not report the same modules as seams (false-positive check)", async (t) => {
  if (!requireSweep(t)) return;
  if (!existsSync(BUNDLE)) {
    t.skip("held-out bundle not present — run tests/fixtures/bundles/react-navigation-example-0.85.3/fetch.sh first");
    return;
  }
  const bytes = new Uint8Array(readFileSync(BUNDLE));
  const ios = await runSeams(bytes, { rnDir: RN_DIR, platform: "ios" });
  const android = await runSeams(bytes, { rnDir: RN_DIR, platform: "android" });
  const iosNames = new Set(ios.seams.map((s) => s.name));
  const androidNames = new Set(android.seams.map((s) => s.name));
  const overlap = [...iosNames].filter((n) => androidNames.has(n));
  assert.deepEqual(
    overlap,
    [],
    `--platform ios and --platform android must not report the same seam names on react-navigation-example.hbc (a noise match would); ` +
      `ios: ${JSON.stringify([...iosNames])}, android: ${JSON.stringify([...androidNames])}`,
  );
  assert.equal(
    android.seams.length,
    0,
    `react-navigation-example.hbc is an android build (BUILD.md) -- --platform android should report zero seams; got: ${JSON.stringify(android.seams)}`,
  );
});
