// BLIND input is exactly what `hbc2js deps` sees today: the bundle alone
// (`runDeps`, `--offline`). INFORMED input is the candidate name+version
// list `--known` would read from the app's own package.json/lockfile --
// here, because rn-template was built in a scratch dir outside this repo
// and only the .hbc/.bundle were copied in (BUILD.md), no package.json
// survives locally, so the known list is reconstructed from
// `deps-truth.json`'s `packages` map's NAMES + VERSIONS ONLY (exactly what
// a package.json/lockfile would have told a developer -- never any
// module-id/ownership field from the truth file, which stays exclusively
// on the scoring side of this test, never passed to `runInformedDeps`).
// This keeps the two modes' inputs visibly separate: `knownFromTruthNames`
// below is the ONLY function in this file allowed to touch `truth`, and its
// return type (`KnownPackage[]`, name+version only) cannot carry any
// bundle-derived fact through to the informed call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { runDeps, runInformedDeps } from "../../../src/deps/index.ts";
import type { KnownPackage } from "../../../src/deps/known.ts";

const TRUTH_DIR = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "truth");
const truth = JSON.parse(readFileSync(join(TRUTH_DIR, "deps-truth.json"), "utf8")) as {
  packages: Record<string, string | null>;
  direct: string[] | null;
  transitiveOf: Record<string, string[]>;
};

/** The ONLY place this file reads `truth` for the informed SIDE (see the
 *  file-header note) -- names + versions, nothing bundle-derived. */
function knownFromTruthNames(): KnownPackage[] {
  return Object.entries(truth.packages).map(([name, version]) => ({ name, version }));
}

function directPackages(): Set<string> {
  return new Set(truth.direct ?? Object.keys(truth.packages).filter((p) => !(p in (truth.transitiveOf ?? {}))));
}

test("rn-template release: informed mode confirms at least what blind confirms, precision 100% by construction, gap reported", async () => {
  const bundlePath = join(TRUTH_DIR, "index.android.hbc");
  const blind = await runDeps(bundlePath, { offline: true });
  const known = knownFromTruthNames();
  const informed = runInformedDeps(bundlePath, known, {});

  const truthPkgs = new Set(Object.keys(truth.packages));
  const direct = directPackages();

  const blindConfirmed = new Set(blind.report.confirmedDeps.map((d) => d.package));
  const informedConfirmed = new Set(informed.results.filter((r) => r.status === "confirmed").map((r) => r.package));

  // Precision: every "confirmed" name must be a real truth package -- true
  // by construction here (the DB load itself was filtered to `known`'s
  // names, all of which come from `truth.packages`), asserted directly
  // rather than assumed.
  for (const pkg of informedConfirmed) assert.ok(truthPkgs.has(pkg), `informed confirmed ${pkg}, not in truth`);
  const informedPrecision = informedConfirmed.size === 0 ? 1 : [...informedConfirmed].filter((p) => truthPkgs.has(p)).length / informedConfirmed.size;
  assert.equal(informedPrecision, 1);

  const informedRecallAll = informedConfirmed.size === 0 ? 0 : [...informedConfirmed].filter((p) => truthPkgs.has(p)).length / truthPkgs.size;
  const informedRecallDirect = direct.size === 0 ? 1 : [...informedConfirmed].filter((p) => direct.has(p)).length / direct.size;
  const blindRecallAll = blindConfirmed.size === 0 ? 0 : [...blindConfirmed].filter((p) => truthPkgs.has(p)).length / truthPkgs.size;

  // Informed is a ceiling: everything blind confirms, informed confirms too
  // (both go through the exact same match.ts/report.ts scoring; informed
  // just widens which DB signatures are even loaded).
  for (const pkg of blindConfirmed) assert.ok(informedConfirmed.has(pkg), `blind confirmed ${pkg} but informed did not`);

  const notFound = informed.results.filter((r) => r.status === "not-found").map((r) => r.package);
  const refused = informed.results.filter((r) => r.status === "refused").map((r) => r.package);

  console.log(
    `rn-template index.android.hbc: truth ${truthPkgs.size} packages (${direct.size} direct); ` +
      `blind confirmed ${blindConfirmed.size} (recall ${(blindRecallAll * 100).toFixed(1)}% of all); ` +
      `informed confirmed ${informedConfirmed.size} (recall ${(informedRecallAll * 100).toFixed(1)}% of all / ${(informedRecallDirect * 100).toFixed(1)}% of direct), ` +
      `refused ${refused.length}, not-found ${notFound.length}; gap (informed-blind) ${((informedRecallAll - blindRecallAll) * 100).toFixed(1)} points`,
  );
  assert.ok(informedRecallAll >= blindRecallAll, "informed recall must be >= blind recall (it is the ceiling)");
});
