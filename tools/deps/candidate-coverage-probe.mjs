// tools/deps/candidate-coverage-probe.mjs -- the diagnostic that settled where
// dependency recall is actually lost. Usage:
//   node tools/deps/candidate-coverage-probe.mjs <bundle.hbc> <deps-truth.json>
// For every truth package it answers two separate questions that three prior
// items conflated: is there a signature for it in the loaded DB at all, and
// did it ever become a match CANDIDATE. Splitting those is the whole point --
// see docs/DEPS.md "Where dependency recall is actually lost".
import { readFileSync } from "node:fs";
import { resolveDbLayers } from "../../src/deps/db.ts";
import { buildInventory } from "../../src/deps/inventory.ts";
import { deriveCandidatePackages, listCandidatePackageNamesForLayers, evidenceTextFromInventory } from "../../src/deps/candidates.ts";

const hbcPath = process.argv[2];
const truthPath = process.argv[3];
const bytes = readFileSync(hbcPath);
const { inventory } = buildInventory(bytes);
const layers = resolveDbLayers({});
const universe = listCandidatePackageNamesForLayers(layers);
const candidates = deriveCandidatePackages(layers, inventory);
const truth = JSON.parse(readFileSync(truthPath, "utf8"));
const truthPkgs = Object.keys(truth.packages);
const inUniverse = truthPkgs.filter((p) => universe.includes(p));
const inCandidates = truthPkgs.filter((p) => candidates.has(p));
const missingFromUniverse = truthPkgs.filter((p) => !universe.includes(p));
const inUniverseNotCandidate = truthPkgs.filter((p) => universe.includes(p) && !candidates.has(p));
console.log(hbcPath);
console.log("universe size:", universe.length, "candidates derived:", candidates.size);
console.log("truth packages:", truthPkgs.length, "in DB universe:", inUniverse.length, "became candidates:", inCandidates.length);
console.log("truth pkgs NOT in DB at all (no signature file):", missingFromUniverse.join(", ") || "(none)");
console.log("truth pkgs IN DB but never became a candidate:", inUniverseNotCandidate.join(", ") || "(none)");
