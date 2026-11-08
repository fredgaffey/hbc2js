// readability-rater: the lenient rater (role-qualified containment +
// abbreviation expansion) vs the strict exact-match rater. The error examples
// are real misses from the 2026-11-09 held-out recording.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LenientNameRater, isRateableLabel, rateHighConfidence } from "../../../src/readability/rater.ts";
import { ReferenceNameRater } from "../../../src/readability/types.ts";
import type { LabelledTarget } from "../../../src/readability/types.ts";

function target(referenceName: string, alsoAccept: string[] = []): LabelledTarget {
  return { id: `t-${referenceName}`, kind: "register", source: "x", referenceName, alsoAccept, securityRelevant: false, note: "" } as LabelledTarget;
}
const lenient = new LenientNameRater();
const strict = new ReferenceNameRater();

test("rater: role-qualified proposals are accurate under the lenient rater only", () => {
  for (const [ref, prop] of [["props", "drawerProps"], ["props", "inputProps"], ["name", "screenName"], ["screen", "screenName"], ["parentScreens", "parentScreenNames"]] as const) {
    assert.equal(lenient.rate(target(ref), prop).verdict, "accurate", `${ref} <- ${prop}`);
  }
  assert.equal(strict.rate(target("props"), "drawerProps").verdict, "inaccurate", "exact stays strict");
});

test("rater: containment is by whole camelCase word, not substring", () => {
  assert.equal(lenient.rate(target("name"), "filenameParts").verdict, "inaccurate");
  assert.equal(lenient.rate(target("author"), "whitespacePattern").verdict, "inaccurate");
  assert.equal(lenient.rate(target("state"), "initialRoutes").verdict, "inaccurate");
});

test("rater: abbreviation expansions come from the committed table", () => {
  assert.equal(lenient.rate(target("e"), "event").verdict, "accurate");
  assert.equal(lenient.rate(target("evt"), "pressEvent").verdict, "accurate");
  assert.equal(lenient.rate(target("cb"), "onDone_callback").verdict, "accurate");
  assert.equal(lenient.rate(target("opts"), "navigatorOptions").verdict, "accurate");
  assert.equal(lenient.rate(target("options"), "opts").verdict, "accurate");
  assert.equal(lenient.rate(target("i"), "tabIndex").verdict, "accurate");
});

test("rater: case/underscore normalisation and alsoAccept still work", () => {
  assert.equal(lenient.rate(target("routeName"), "route_name").verdict, "accurate");
  assert.equal(lenient.rate(target("a", ["left"]), "left").verdict, "accurate");
});

test("rater: single-letter author labels are not rateable", () => {
  assert.equal(isRateableLabel(target("a")), false);
  assert.equal(isRateableLabel(target("props")), true);
});

test("rater: rateHighConfidence reports exact and lenient side by side and skips unrateable", () => {
  const s = { app: "x", bundle: "x", labelledBy: "x", labelSource: "x", ts: "x", targets: [target("props"), target("a"), target("name")] };
  const proposals = new Map([
    ["t-props", { name: "drawerProps", confidence: "high" as const }],
    ["t-a", { name: "leftRoute", confidence: "high" as const }],
    ["t-name", { name: "name", confidence: "med" as const }],
  ]);
  const r = rateHighConfidence(s, proposals);
  assert.deepEqual(r.high, { n: 1, exact: 0, lenient: 1, excludedSingleLetter: 1 });
  assert.deepEqual(r.all, { n: 2, exact: 1, lenient: 2, excludedSingleLetter: 1 });
});
