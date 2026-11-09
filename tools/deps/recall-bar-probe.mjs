// usage: R=<repo> node bar.mjs <hbc> <truth.json> <db> <label>  -- per non-high candidate: what stopped it at the bar
import { readFileSync } from "fs";
const R = process.env.R;
const { loadSignatures, resolveDbLayers } = await import(R + "/src/deps/db.ts");
const C = await import(R + "/src/deps/candidates.ts");
const { buildInventory } = await import(R + "/src/deps/inventory.ts");
const M = await import(R + "/src/deps/match.ts");
const { foreignSets } = await import(R + "/src/deps/module-paths.ts");
const [hbc, truthPath, db, label] = process.argv.slice(2);
const truth = new Set(Object.keys(JSON.parse(readFileSync(truthPath, "utf8")).packages));
const inv = buildInventory(new Uint8Array(readFileSync(hbc))).inventory;
const layers = resolveDbLayers({ sigdb: db }); const di = C.buildDependencyIndex(layers);
const universe = C.listCandidatePackageNamesForLayers(layers); const text = C.evidenceTextFromInventory(inv);
const direct = new Set(C.findCandidatesInText(universe, text));
const cands = C.deriveCandidatePackages(layers, inv, di);
const sigs = loadSignatures(layers, { candidates: cands }); const r = M.matchInventory(inv, sigs);
const high = new Set(r.packages.filter((s) => s.tier === "high" && !s.isBaseline).map((s) => s.package));
const parentsOf = new Map(); for (const s of sigs) for (const d of s.file.subtractedDependencies ?? []) { const n = d.slice(0, d.lastIndexOf("@") > 0 ? d.lastIndexOf("@") : d.length); if (!parentsOf.has(n)) parentsOf.set(n, new Set()); parentsOf.get(n).add(s.file.package); }
const tE = new Set(inv.functions.map((f) => f.exactHash)); const leg = inv.legacyExactHashes ?? inv.functions.map((f) => f.exactHash); for (const h of leg) tE.add(M.LEGACY_PREFIX + h);
const owners = new Map(); for (const s of sigs) { if (s.file.hbcVersion !== inv.hbcVersion || s.file.toolchainBaseline) continue; const fo = foreignSets(s.file); for (const fn of s.file.functions) { if (fo.functions.has(fn.index)) continue; const k = M.schemeKey(s.file, fn.exactHash); if (!owners.has(k)) owners.set(k, new Set()); owners.get(k).add(s.file.package); } }
const rank = { high: 3, medium: 2, low: 1, none: 0 };
const byPkg = new Map(); for (const s of r.packages) { if (s.isBaseline) continue; const b = byPkg.get(s.package); if (!b || rank[s.tier] > rank[b.tier] || (rank[s.tier] === rank[b.tier] && (s.moduleExactHits > b.moduleExactHits || (s.moduleExactHits === b.moduleExactHits && s.exactHits > b.exactHits)))) byPkg.set(s.package, s); }
const rows = [];
for (const [p, s] of byPkg) { if (s.tier === "high") continue;
  const f = sigs.find((x) => x.file.package === p && x.file.version === s.version && x.file.hbcVersion === inv.hbcVersion).file; const fo = foreignSets(f);
  // raw (no ambiguity/generic filter) counts
  let rawE = 0, rawMh = 0, ambE = 0, instr = 0; const elig = f.functions.filter((x) => x.instrCount >= 8 && !fo.functions.has(x.index));
  for (const fn of elig) { const k = M.schemeKey(f, fn.exactHash); if (tE.has(k)) { rawE++; if ((owners.get(k)?.size ?? 1) >= 20) ambE++; else instr += fn.instrCount; } }
  const mods = f.modules.filter((m) => !m.factoryIsBaseline && m.factoryIsDependency !== true && !fo.factories.has(m.factoryFunctionIndex));
  for (const m of mods) if (m.factoryExactHash && tE.has(M.schemeKey(f, m.factoryExactHash))) rawMh++;
  const mh = s.moduleExactHits, mt = s.moduleTotal, tiny = mt < 3;
  let why;
  if (s.demotion) why = "demoted:" + s.demotion.rule;
  else if (s.tier === "none") why = "no-hit";
  else if (tiny) why = s.exactHits === 0 ? "tiny:fuzzy-only" : "tiny:fn-floor";
  else if (mh === 2) why = "cov-path:" + (mh / mt < 0.05 ? "modcov" : "") + (s.exactCoverage < 0.1 ? "fncov" : "");
  else if (mh === 1) why = "one-module";
  else if (s.exactHits > 0) why = "fn-only";
  else why = "fuzzy-only";
  if (!s.demotion && rawMh > mh && rawMh >= 3) why += "+amb(raw mh " + rawMh + ")";
  const route = direct.has(p) ? "text" : [...(parentsOf.get(p) ?? [])].some((q) => cands.has(q)) ? "dep" : "scope";
  const depHigh = [...(parentsOf.get(p) ?? [])].filter((q) => high.has(q));
  const myDeps = (f.subtractedDependencies ?? []).map((d) => d.slice(0, d.lastIndexOf("@") > 0 ? d.lastIndexOf("@") : d.length)); const myDepsHigh = myDeps.filter((d) => high.has(d));
  rows.push({ c: truth.has(p) ? "TP" : "FP", p, v: s.version, tier: s.tier, why, mh, mt, eh: s.exactHits, el: s.eligibleFunctions, ec: +s.exactCoverage.toFixed(3), fc: +s.fuzzyCoverage.toFixed(3), fo: s.fuzzyOnlyHits, sc: s.stringCorroborated, rawE, ambE, rawMh, instr, paths: f.modulePaths ?? 0, route, parentHigh: depHigh.length, depsHigh: myDepsHigh.length + "/" + myDeps.length });
}
for (const x of rows.sort((a, b) => a.why.localeCompare(b.why) || a.c.localeCompare(b.c))) console.log("ROW " + label + " " + JSON.stringify(x));
const t = new Map(); for (const x of rows) { const k = x.why.replace(/\+amb.*/, "+amb"); if (!t.has(k)) t.set(k, [0, 0]); t.get(k)[x.c === "TP" ? 0 : 1]++; }
console.log("SUM " + label + " high=" + high.size + " " + [...t].map(([k, [a, b]]) => `${k}=${a}/${b}`).join(" "));
