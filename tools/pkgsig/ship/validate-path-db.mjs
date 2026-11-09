#!/usr/bin/env node
// tools/pkgsig/ship/validate-path-db.mjs — validator for a module-paths
// signature DB dir (docs/PACKAGE-SIGNATURES.md "Shipping db-v4-paths").
// Read-only. Usage:
//   validate-path-db.mjs <db-dir> [--src <source-db-dir>] [--list-pathless] [--json]
// Exit 1 when a hard check fails: unparseable file, filename/header mismatch,
// duplicate package@version@hbc, a function moduleId naming no module, a
// modulePaths:1 file with an absolute / `..` path, or (with --src) a file
// present in the output but not the source.
// Reports (not failures): module path coverage, function moduleId coverage,
// hash-scheme and hbc-version distribution, pathless files (in src, absent
// from out, or out files lacking modulePaths:1).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const NAME_RE = /^(.*)@([^@]+)__hbc(\d+)\.json$/;

function listSigs(dir) {
  return readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "index.json").sort();
}

const INDEX_RE = /^candidate-hash-index__hbc(\d+)\.tsv$/;
const INDEX_MAGIC = "#hbc2js-candidate-hash-index 1 ";

// Candidate hash-index files (src/deps/hash-index.ts): must parse, name only
// packages present in the DB at that hbc version, and not predate the newest
// signature file (stale = warning only).
function checkHashIndexes(dir, files, seen, errors) {
  const out = { files: [], warnings: [] };
  const names = readdirSync(dir).filter((n) => INDEX_RE.test(n)).sort();
  const newestSig = files.reduce((m, f) => Math.max(m, statSync(join(dir, f)).mtimeMs), 0);
  for (const n of names) {
    const hbc = INDEX_RE.exec(n)[1];
    out.files.push(n);
    let header;
    try {
      const text = readFileSync(join(dir, n), "utf8");
      const first = text.slice(0, Math.max(text.indexOf("\n"), 0));
      if (!first.startsWith(INDEX_MAGIC)) throw new Error("bad magic");
      header = JSON.parse(first.slice(INDEX_MAGIC.length));
      if (!Array.isArray(header.packages) || String(header.hbcVersion) !== hbc) throw new Error("bad header");
    } catch (e) { errors.push(`${n}: unparseable (${e.message.slice(0, 60)})`); continue; }
    const have = new Set([...seen.keys()].filter((k) => k.endsWith(`@${hbc}`)).map((k) => k.slice(0, k.indexOf("@", 1))));
    for (const p of header.packages) if (!have.has(p)) errors.push(`${n}: names package ${p} not in the DB at hbc${hbc}`);
    if (statSync(join(dir, n)).mtimeMs < newestSig) out.warnings.push(`${n}: stale (older than the newest signature file); rebuild it`);
  }
  return out;
}

export function validateDb(dir, opts = {}) {
  const files = listSigs(dir);
  const r = {
    dir, files: files.length, errors: [], parseErrors: 0,
    withPaths: 0, pathless: [], schemes: {}, hbc: {}, modules: 0, modulesWithPath: 0,
    functions: 0, functionsWithModuleId: 0, filesLowCoverage: [], duplicates: [],
    missingFromOut: [], extraInOut: [], srcFiles: null,
  };
  const seen = new Map();
  for (const f of files) {
    let d;
    try { d = JSON.parse(readFileSync(join(dir, f), "utf8")); }
    catch (e) { r.parseErrors++; r.errors.push(`${f}: unparseable (${e.message.slice(0, 60)})`); continue; }
    const m = NAME_RE.exec(f);
    if (m === null) { r.errors.push(`${f}: bad filename`); continue; }
    const pkg = m[1].replace(/__/g, "/");
    if (d.package !== undefined && !f.startsWith(d.package.replace(/\//g, "__") + "@")) r.errors.push(`${f}: header package ${d.package}`);
    if (d.version !== undefined && d.version !== m[2]) r.errors.push(`${f}: header version ${d.version}`);
    if (d.hbcVersion !== undefined && d.hbcVersion !== Number(m[3])) r.errors.push(`${f}: header hbcVersion ${d.hbcVersion}`);
    const key = `${pkg}@${m[2]}@${m[3]}`;
    if (seen.has(key)) { r.duplicates.push(`${f} == ${seen.get(key)}`); r.errors.push(`${f}: duplicate of ${seen.get(key)}`); }
    seen.set(key, f);
    const scheme = d.hashScheme ?? 1;
    r.schemes[scheme] = (r.schemes[scheme] ?? 0) + 1;
    r.hbc[m[3]] = (r.hbc[m[3]] ?? 0) + 1;
    if (d.modulePaths !== 1) { r.pathless.push(f); continue; }
    r.withPaths++;
    const mods = Array.isArray(d.modules) ? d.modules : [];
    const ids = new Set(mods.map((x) => x.localModuleId));
    let withPath = 0;
    for (const x of mods) {
      if (typeof x.path === "string") {
        withPath++;
        if (x.path.startsWith("/") || x.path.split("/").includes("..")) r.errors.push(`${f}: module ${x.localModuleId} path ${x.path}`);
      } else if (x.path !== null && x.path !== undefined) r.errors.push(`${f}: module ${x.localModuleId} path not string/null`);
    }
    r.modules += mods.length; r.modulesWithPath += withPath;
    if (mods.length > 0 && withPath * 2 < mods.length) r.filesLowCoverage.push(f);
    const fns = Array.isArray(d.functions) ? d.functions : [];
    let withId = 0, bad = 0;
    for (const x of fns) {
      if (x.moduleId === undefined || x.moduleId === null) continue;
      withId++;
      if (!ids.has(x.moduleId)) bad++;
    }
    r.functions += fns.length; r.functionsWithModuleId += withId;
    if (bad > 0) r.errors.push(`${f}: ${bad} function moduleId(s) name no module`);
  }
  if (opts.src !== undefined) {
    const src = new Set(listSigs(opts.src));
    const out = new Set(files);
    r.srcFiles = src.size;
    for (const f of src) if (!out.has(f)) r.missingFromOut.push(f);
    for (const f of out) if (!src.has(f)) { r.extraInOut.push(f); r.errors.push(`${f}: not in source DB`); }
  }
  r.hashIndex = checkHashIndexes(dir, files, seen, r.errors);
  const pct = (a, b) => (b === 0 ? null : Math.round((1000 * a) / b) / 10);
  r.modulePathCoveragePct = pct(r.modulesWithPath, r.modules);
  r.functionModuleIdCoveragePct = pct(r.functionsWithModuleId, r.functions);
  r.filesWithPathsPct = pct(r.withPaths, r.files);
  r.ok = r.errors.length === 0;
  return r;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const dir = a.find((x, i) => !x.startsWith("--") && a[i - 1] !== "--src");
  if (dir === undefined) { console.error("usage: validate-path-db.mjs <db-dir> [--src <dir>] [--list-pathless] [--json]"); process.exit(2); }
  const si = a.indexOf("--src");
  const r = validateDb(dir, { src: si >= 0 ? a[si + 1] : undefined });
  const full = a.includes("--list-pathless");
  const brief = { ...r, errors: r.errors.slice(0, 20), errorCount: r.errors.length,
    pathless: full ? r.pathless : r.pathless.length, missingFromOut: full ? r.missingFromOut : r.missingFromOut.length,
    filesLowCoverage: r.filesLowCoverage.length, duplicates: r.duplicates.slice(0, 10), extraInOut: r.extraInOut.length, hashIndexFiles: r.hashIndex.files.length, hashIndexWarnings: r.hashIndex.warnings };
  console.log(JSON.stringify(brief, null, 1));
  process.exit(r.ok ? 0 : 1);
}
