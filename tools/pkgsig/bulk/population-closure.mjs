#!/usr/bin/env node
// tools/pkgsig/bulk/population-closure.mjs — widen the bulk signature
// population with the dependency closure of what the DB already has
// (deps-population-widen, docs/DEPS.md "Population widening").
//
// The round-1/2b population was a react-native keyword search ranked by
// downloads. It skips the ordinary JS that RN libraries depend on (Sentry's
// internals, @formatjs/*, the es-shim chain, domutils, expo modules). This
// tool walks the dependency graph instead, starting from sources that never
// read a measured app's truth or lockfile:
//
//   (a) seeds: every package name with a signature file at --hbc in the
//       --seed-db directories (db-v3-clean, db-v4-paths). Their
//       `dependencies` + `peerDependencies`, per version present, come
//       from the npm registry's abbreviated packuments.
//   (c) --corpus-names <json>: package-name strings found in real-world
//       bundles (population-corpus.mjs; the caller excludes holdout apps).
//       A scoped name found there is a hop-0 candidate; any name found
//       there gets a priority bonus.
//
// Version policy: ONE version per new name — the version that the most
// parent ranges resolve to (maxSatisfying over published, non-prerelease
// versions; ties go to the higher version; a name with no parent range,
// e.g. a corpus-only name, takes dist-tags.latest). Signature matching is
// by package name across every loaded version, and building the exact
// version of the 68 Expensify packages that only had other versions
// recovered 9 of them, so a second version of a name buys far less than a
// first version of a new name.
//
// A name is "new" when no --seed-db or --exclude-db directory has a file
// for it at --hbc. Candidates are ranked by score = distinct parent names
// + 2 * corpus apps, then by parents, then by hop (closer first), then name; the top --cap
// are written as worker.sh jobs ("name\tversion\thbc").
//
// Usage (on a build node with network):
//   node tools/pkgsig/bulk/population-closure.mjs --seed-db <dir> [--seed-db <dir>]
//     [--exclude-db <dir>] [--hbc 98] [--hops 2] [--cap 3000]
//     [--corpus-names <json>] [--cache <json>] [--concurrency 8]
//     --out <jobs.tsv> [--plan-out <plan.json>]

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import semver from "semver";

/** Names (scope separator restored) with a `<name>@<ver>__hbc<hv>.json` file, mapped to their versions. */
export function dbVersions(fileNames, hv) {
  const out = new Map();
  const suffix = `__hbc${hv}.json`;
  for (const f of fileNames) {
    if (!f.endsWith(suffix)) continue;
    const base = f.slice(0, -suffix.length);
    const at = base.lastIndexOf("@");
    if (at <= 0) continue;
    const name = base.slice(0, at).replace("__", "/");
    if (!out.has(name)) out.set(name, new Set());
    out.get(name).add(base.slice(at + 1));
  }
  return out;
}

/** Names never worth a JS signature build. */
export function skipName(name) {
  return name.startsWith("@types/") || name === "react" || name === "react-native";
}

/**
 * The single version to build for `name`: the one most `ranges` resolve
 * to (maxSatisfying over stable published versions), ties to the higher
 * version; with no resolvable range, `latest`. Null when nothing resolves.
 */
export function pickVersion(versions, ranges, latest) {
  const stable = versions.filter((v) => semver.valid(v) && !semver.prerelease(v));
  const votes = new Map();
  for (const r of ranges) {
    let v = null;
    try { v = semver.maxSatisfying(stable, r); } catch { v = null; }
    if (v) votes.set(v, (votes.get(v) ?? 0) + 1);
  }
  if (votes.size === 0) return latest && versions.includes(latest) ? latest : null;
  return [...votes.entries()].sort((a, b) => b[1] - a[1] || semver.rcompare(a[0], b[0]))[0][0];
}

function depsOf(manifest) {
  return { ...(manifest?.peerDependencies ?? {}), ...(manifest?.dependencies ?? {}) };
}

/**
 * Plan the widened population. `getPackument(name)` resolves to
 * `{ latest, versions: { [ver]: { dependencies?, peerDependencies? } } }` or null.
 * `seeds`: Map name -> Set(version) the DB has (sources of edges).
 * `existing`: Set of names the DB already has at this HBC version.
 * `corpus`: Map name -> number of corpus apps naming it.
 */
export async function planPopulation({ seeds, existing, corpus = new Map(), getPackument, hops = 2, cap = 3000 }) {
  const cand = new Map(); // name -> { parents:Set, ranges:[], hop }
  const note = (name, parent, range, hop) => {
    if (skipName(name) || existing.has(name)) return;
    let c = cand.get(name);
    if (!c) cand.set(name, (c = { parents: new Set(), ranges: [], hop }));
    if (parent) c.parents.add(parent);
    if (range) c.ranges.push(range);
    if (hop < c.hop) c.hop = hop;
  };
  // hop 0: scoped corpus names (unscoped strings are too ambiguous to seed)
  for (const name of corpus.keys()) if (name.startsWith("@")) note(name, null, null, 0);
  // hop 1: edges out of every seed version
  const seedNames = [...seeds.keys()].sort();
  const docs = await Promise.all(seedNames.map((n) => getPackument(n)));
  seedNames.forEach((n, i) => {
    const doc = docs[i];
    if (!doc) return;
    for (const v of seeds.get(n)) for (const [d, r] of Object.entries(depsOf(doc.versions[v]))) note(d, n, r, 1);
  });
  // resolve versions; further hops follow the chosen version's edges
  const chosen = new Map();
  for (let hop = 1; hop <= hops; hop++) {
    const todo = [...cand.keys()].filter((n) => !chosen.has(n)).sort();
    if (!todo.length) break;
    const pdocs = await Promise.all(todo.map((n) => getPackument(n)));
    todo.forEach((n, i) => {
      const doc = pdocs[i];
      const v = doc ? pickVersion(Object.keys(doc.versions), cand.get(n).ranges, doc.latest) : null;
      chosen.set(n, v);
      if (v && hop < hops) for (const [d, r] of Object.entries(depsOf(doc.versions[v]))) note(d, n, r, hop + 1);
    });
  }
  const rows = [];
  for (const [name, c] of cand) {
    const version = chosen.get(name);
    if (!version) continue;
    const corpusApps = corpus.get(name) ?? 0;
    rows.push({ name, version, hop: c.hop, parents: c.parents.size, corpusApps, score: c.parents.size + 2 * corpusApps });
  }
  rows.sort((a, b) => b.score - a.score || b.parents - a.parents || a.hop - b.hop || (a.name < b.name ? -1 : 1));
  return { selected: rows.slice(0, cap), total: rows.length, unresolved: [...chosen].filter(([, v]) => !v).map(([n]) => n) };
}

// --- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const o = { seedDb: [], excludeDb: [], hbc: 98, hops: 2, cap: 3000, corpusNames: null, cache: null, concurrency: 8, out: null, planOut: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === "--seed-db") o.seedDb.push(v());
    else if (a === "--exclude-db") o.excludeDb.push(v());
    else if (a === "--hbc") o.hbc = Number(v());
    else if (a === "--hops") o.hops = Number(v());
    else if (a === "--cap") o.cap = Number(v());
    else if (a === "--corpus-names") o.corpusNames = v();
    else if (a === "--cache") o.cache = v();
    else if (a === "--concurrency") o.concurrency = Number(v());
    else if (a === "--out") o.out = v();
    else if (a === "--plan-out") o.planOut = v();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.seedDb.length || !o.out) throw new Error("need --seed-db <dir> and --out <jobs.tsv>");
  return o;
}

/** Abbreviated-packument fetcher with a reduced on-disk cache, bounded concurrency and backoff. */
function registryFetcher(cachePath, concurrency) {
  const cache = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const inflight = new Map();
  let active = 0, fetched = 0;
  const queue = [];
  const pump = () => { while (active < concurrency && queue.length) { active++; queue.shift()(); } };
  const save = () => { if (cachePath) writeFileSync(cachePath, JSON.stringify(cache)); };
  async function fetchOne(name) {
    const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}`;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const r = await fetch(url, { headers: { accept: "application/vnd.npm.install-v1+json" } });
        if (r.status === 404) return null;
        if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const versions = {};
        for (const [v, m] of Object.entries(j.versions ?? {})) {
          const e = {};
          if (m.dependencies && Object.keys(m.dependencies).length) e.dependencies = m.dependencies;
          if (m.peerDependencies && Object.keys(m.peerDependencies).length) e.peerDependencies = m.peerDependencies;
          versions[v] = e;
        }
        return { latest: j["dist-tags"]?.latest ?? null, versions };
      } catch (e) {
        await new Promise((res) => setTimeout(res, 500 * 2 ** attempt + Math.random() * 300));
      }
    }
    return null;
  }
  const get = (name) => {
    if (name in cache) return Promise.resolve(cache[name]);
    if (inflight.has(name)) return inflight.get(name);
    const p = new Promise((res) => queue.push(async () => {
      const doc = await fetchOne(name);
      cache[name] = doc; active--; fetched++;
      if (fetched % 500 === 0) { save(); console.error(`fetched ${fetched}`); }
      res(doc); pump();
    }));
    inflight.set(name, p); pump();
    return p;
  };
  return { get, save };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const seeds = new Map();
  for (const d of o.seedDb) for (const [n, vs] of dbVersions(readdirSync(d), o.hbc)) {
    if (!seeds.has(n)) seeds.set(n, new Set());
    for (const v of vs) seeds.get(n).add(v);
  }
  const existing = new Set(seeds.keys());
  for (const d of o.excludeDb) for (const n of dbVersions(readdirSync(d), o.hbc).keys()) existing.add(n);
  const corpus = new Map(o.corpusNames ? Object.entries(JSON.parse(readFileSync(o.corpusNames, "utf8")).names) : []);
  const reg = registryFetcher(o.cache, o.concurrency);
  const plan = await planPopulation({ seeds, existing, corpus, getPackument: reg.get, hops: o.hops, cap: o.cap });
  reg.save();
  writeFileSync(o.out, plan.selected.map((r) => `${r.name}\t${r.version}\t${o.hbc}`).join("\n") + "\n");
  if (o.planOut) writeFileSync(o.planOut, JSON.stringify({ seeds: seeds.size, existing: existing.size, corpusNames: corpus.size, ...plan }, null, 1));
  console.log(`seeds=${seeds.size} existing=${existing.size} corpus=${corpus.size} candidates=${plan.total} selected=${plan.selected.length} unresolved=${plan.unresolved.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
