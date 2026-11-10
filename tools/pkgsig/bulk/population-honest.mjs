#!/usr/bin/env node
// tools/pkgsig/bulk/population-honest.mjs — app-blind population widening
// (sigdb-honest-population, docs/PACKAGE-SIGNATURES.md §9).
//
// Measured recall is only honest if the signature population was chosen
// without looking at the measured apps. This planner reads three pinned,
// public sources and nothing else:
//
//   declared: what the RN/Expo SDKs themselves declare an app ships with —
//     `bundledNativeModules.json` + `dependencies` of each --expo package
//     dir, and `template/package.json` `dependencies` of each --template
//     (@react-native-community/template) package dir.
//   top: the first --top names of npm-high-impact's `topDownload` list
//     (npm packages ranked by weekly downloads; pass lib/top-download.js).
//
// Names failing skipName() (types, react/react-native, build toolchain;
// shared with population-closure.mjs) are dropped. Versions:
//   declared: every version an SDK range resolves to (maxSatisfying over
//     stable versions); primary = the highest of them.
//   top: dist-tags.latest (primary), plus the newest stable release of each
//     of the --prior-majors majors below latest's.
// One job per (name, version, hbc) for each --hbc; a job is skipped when an
// --exclude-db already has that exact file. Order: phase 1 = the primary
// version of names with no file at that hbc (breadth first), phase 2 = the
// remaining versions; within a phase declared before top, each by download
// rank (declared names off the list after, by name), then hbc. --cap cuts
// the ordered list. Output is worker.sh jobs ("name\tversion\thbc").
//
// Usage (build node, network for packuments only):
//   node tools/pkgsig/bulk/population-honest.mjs --top-download <top-download.js>
//     [--expo <dir>]... [--template <dir>]... [--exclude-db <dir>]...
//     [--hbc 96,98] [--top 2000] [--prior-majors 1] [--cap 800]
//     [--cache <json>] [--concurrency 8] --out <jobs.tsv> [--plan-out <plan.json>]

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { dbVersions, registryFetcher, skipName } from "./population-closure.mjs";

/** name -> { ranges: string[], sources: string[] } from Expo SDK and RN template package dirs. */
export function declaredRanges({ expo = [], template = [] }) {
  const out = new Map();
  const add = (name, range, src) => {
    if (!out.has(name)) out.set(name, { ranges: [], sources: [] });
    const e = out.get(name);
    if (!e.ranges.includes(range)) e.ranges.push(range);
    if (!e.sources.includes(src)) e.sources.push(src);
  };
  for (const { label, bundledNativeModules = {}, dependencies = {} } of expo) {
    for (const [n, r] of Object.entries(bundledNativeModules)) add(n, r, `expo-sdk:${label}`);
    for (const [n, r] of Object.entries(dependencies)) add(n, r, `expo-deps:${label}`);
  }
  for (const { label, dependencies = {} } of template) for (const [n, r] of Object.entries(dependencies)) add(n, r, `rn-template:${label}`);
  return out;
}

function stableOf(p) {
  return Object.keys(p.versions).filter((v) => semver.valid(v) && !semver.prerelease(v));
}

/** Versions to build for one name, primary first. */
export function versionsFor(p, ranges, priorMajors) {
  const stable = stableOf(p);
  if (ranges) {
    const got = new Set();
    for (const r of ranges) {
      let v = null;
      try { v = semver.maxSatisfying(stable, r); } catch { v = null; }
      if (v) got.add(v);
    }
    return [...got].sort(semver.rcompare);
  }
  const latest = p.latest && p.versions[p.latest] ? p.latest : stable.sort(semver.rcompare)[0];
  if (!latest) return [];
  const out = [latest];
  if (semver.valid(latest)) {
    let major = semver.major(latest);
    for (let k = 0; k < priorMajors && major > 0; k++) {
      major--;
      const v = semver.maxSatisfying(stable, `${major}.x`);
      if (v) out.push(v);
      else break;
    }
  }
  return out;
}

/**
 * Plan the app-blind population. `existing`: Map hbc -> Map name -> Set(version)
 * of files already present. Returns all ordered jobs and the capped selection.
 */
export async function planHonest({ declared, topDownload, top = 2000, existing, hbcs, getPackument, priorMajors = 1, cap = 800 }) {
  const rank = new Map();
  topDownload.forEach((n, i) => { if (!rank.has(n)) rank.set(n, i); });
  const names = [];
  const byRank = (a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0);
  for (const n of [...declared.keys()].sort(byRank)) if (!skipName(n)) names.push({ name: n, tier: "declared" });
  for (const n of topDownload.slice(0, top)) if (!declared.has(n) && !skipName(n)) names.push({ name: n, tier: "top" });
  const unresolved = [];
  const phase = [[], []];
  const docs = await Promise.all(names.map((x) => getPackument(x.name)));
  names.forEach(({ name, tier }, i) => {
    const p = docs[i];
    const vs = p ? versionsFor(p, tier === "declared" ? declared.get(name).ranges : null, priorMajors) : [];
    if (!vs.length) { unresolved.push(name); return; }
    for (const hbc of hbcs) {
      const have = existing.get(hbc)?.get(name);
      vs.forEach((version, j) => {
        if (have?.has(version)) return;
        const ph = j === 0 && !have ? 0 : 1;
        phase[ph].push({ name, version, hbc, tier, rank: rank.get(name) ?? null, phase: ph + 1 });
      });
    }
  });
  const all = [...phase[0], ...phase[1]];
  return { all, selected: all.slice(0, cap), names: names.length, unresolved };
}

function parseArgs(argv) {
  const o = { expo: [], template: [], excludeDb: [], hbc: [96, 98], top: 2000, priorMajors: 1, cap: 800, cache: null, concurrency: 8, out: null, planOut: null, topDownload: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === "--expo") o.expo.push(v());
    else if (a === "--template") o.template.push(v());
    else if (a === "--exclude-db") o.excludeDb.push(v());
    else if (a === "--hbc") o.hbc = v().split(",").map(Number);
    else if (a === "--top") o.top = Number(v());
    else if (a === "--prior-majors") o.priorMajors = Number(v());
    else if (a === "--cap") o.cap = Number(v());
    else if (a === "--cache") o.cache = v();
    else if (a === "--concurrency") o.concurrency = Number(v());
    else if (a === "--out") o.out = v();
    else if (a === "--plan-out") o.planOut = v();
    else if (a === "--top-download") o.topDownload = v();
    else throw new Error(`unknown arg ${a}`);
  }
  if (!o.topDownload || !o.out) throw new Error("need --top-download <top-download.js> and --out <jobs.tsv>");
  return o;
}

const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {});

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const { topDownload } = await import(pathToFileURL(o.topDownload).href);
  const expo = o.expo.map((d) => { const pj = readJson(join(d, "package.json")); return { label: pj.version, bundledNativeModules: readJson(join(d, "bundledNativeModules.json")), dependencies: pj.dependencies }; });
  const template = o.template.map((d) => ({ label: readJson(join(d, "package.json")).version, dependencies: readJson(join(d, "template", "package.json")).dependencies }));
  const declared = declaredRanges({ expo, template });
  const existing = new Map(o.hbc.map((h) => [h, new Map()]));
  for (const d of o.excludeDb) {
    const files = readdirSync(d);
    for (const h of o.hbc) for (const [n, vs] of dbVersions(files, h)) {
      const m = existing.get(h);
      if (!m.has(n)) m.set(n, new Set());
      for (const v of vs) m.get(n).add(v);
    }
  }
  const reg = registryFetcher(o.cache, o.concurrency);
  const plan = await planHonest({ declared, topDownload, top: o.top, existing, hbcs: o.hbc, getPackument: reg.get, priorMajors: o.priorMajors, cap: o.cap });
  reg.save();
  writeFileSync(o.out, plan.selected.map((r) => `${r.name}\t${r.version}\t${r.hbc}`).join("\n") + "\n");
  if (o.planOut) writeFileSync(o.planOut, JSON.stringify({ sources: { expo: expo.map((e) => e.label), template: template.map((t) => t.label), top: o.top, topListLength: topDownload.length }, declared: Object.fromEntries(declared), ...plan }, null, 1));
  console.log(`declared=${declared.size} names=${plan.names} jobs=${plan.all.length} selected=${plan.selected.length} unresolved=${plan.unresolved.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
