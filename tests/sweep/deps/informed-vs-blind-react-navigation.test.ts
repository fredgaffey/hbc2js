import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep } from "../../support/tiers.ts";
import { runDeps, runInformedDeps } from "../../../src/deps/index.ts";
import type { KnownPackage } from "../../../src/deps/known.ts";

const DIR = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3");

for (const variant of ["react-navigation-example.hbc", "react-navigation-example.debug.hbc"]) {
  test(`${variant}: informed mode is a ceiling over blind, precision 100%, gap reported`, async (t) => {
    if (!requireSweep(t)) return;
    const truthPath = join(DIR, "deps-truth.json");
    const bundlePath = join(DIR, variant);
    if (!existsSync(truthPath) || !existsSync(bundlePath)) {
      t.skip(`${truthPath} or ${bundlePath} not present -- fixture not seeded locally (INCONCLUSIVE, not a failure)`);
      return;
    }
    const truth = JSON.parse(readFileSync(truthPath, "utf8")) as {
      packages: Record<string, string | null>;
      direct: string[] | null;
      transitiveOf: Record<string, string[]>;
    };
    const truthPkgs = new Set(Object.keys(truth.packages));
    const direct = new Set(truth.direct ?? Object.keys(truth.packages).filter((p) => !(p in (truth.transitiveOf ?? {}))));
    const known: KnownPackage[] = Object.entries(truth.packages).map(([name, version]) => ({ name, version }));

    const blind = await runDeps(bundlePath, { offline: true });
    const informed = runInformedDeps(bundlePath, known, {});

    const blindConfirmed = new Set(blind.report.confirmedDeps.map((d) => d.package));
    const informedConfirmed = new Set(informed.results.filter((r) => r.status === "confirmed").map((r) => r.package));

    for (const pkg of informedConfirmed) assert.ok(truthPkgs.has(pkg), `informed confirmed ${pkg}, not in truth`);
    const informedPrecision = informedConfirmed.size === 0 ? 1 : [...informedConfirmed].filter((p) => truthPkgs.has(p)).length / informedConfirmed.size;
    assert.equal(informedPrecision, 1, "informed precision must be 100% -- unrestricted DB load is filtered to the known list by construction");

    for (const pkg of blindConfirmed) assert.ok(informedConfirmed.has(pkg), `blind confirmed ${pkg} but informed did not -- ceiling property broken`);

    const informedRecallAll = [...informedConfirmed].filter((p) => truthPkgs.has(p)).length / truthPkgs.size;
    const informedRecallDirect = direct.size === 0 ? 1 : [...informedConfirmed].filter((p) => direct.has(p)).length / direct.size;
    const blindRecallAll = [...blindConfirmed].filter((p) => truthPkgs.has(p)).length / truthPkgs.size;
    const notFound = informed.results.filter((r) => r.status === "not-found").length;
    const refused = informed.results.filter((r) => r.status === "refused").length;

    console.log(
      `${variant}: truth ${truthPkgs.size} packages (${direct.size} direct); ` +
        `blind confirmed ${blindConfirmed.size} (recall ${(blindRecallAll * 100).toFixed(1)}% of all); ` +
        `informed confirmed ${informedConfirmed.size} (recall ${(informedRecallAll * 100).toFixed(1)}% of all / ${(informedRecallDirect * 100).toFixed(1)}% of direct), ` +
        `refused ${refused}, not-found ${notFound}; gap (informed-blind) ${((informedRecallAll - blindRecallAll) * 100).toFixed(1)} points`,
    );
  });
}
