#!/usr/bin/env node
// `npm run test:affected [base]` -- run only the tests that can be affected by the
// changes since <base> (default main): committed diff, working-tree edits, and untracked
// files. Conservative: anything it cannot map falls back to the full gate (`npm test`).
//
// Mapping: static import graph over src/ tests/ tools/ ui/ (import/export-from/import()/
// require, relative specifiers only) plus "path mentions" -- a repo-relative path written
// in a file's text (e.g. a test that spawns src/cli/main.ts) counts as a dependency, so a
// CLI change maps to every test that runs the CLI. A test is affected if its transitive
// closure contains a changed file, or its basename contains a changed module's basename.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_EXT = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const IS_TEST = /^tests\/(?!fixtures\/|support\/|golden\/).*\.test\.ts$/;
// Gate tiers a plain `npm test` runs. Tests under tests/sweep, tests/fuzz (non-consistency) are
// not part of the gate, so affected-mapping does not run them either.
const GATE_TEST = /^tests\/(?:gate|artifact|project|projdb|secrets|security|appgen|mcp|readability|workers|ui-core|ui-server|cli)\/.*\.test\.ts$|^tests\/fuzz\/spec-consistency\.test\.ts$/;
// Changes to any of these affect how every test runs: no mapping attempted.
const ALWAYS_FULL = [
  /^package(?:-lock)?\.json$/, /^tsconfig[^/]*\.json$/, /^tools\/run-tests\.mjs$/, /^tools\/test\//,
  /^tests\/support\//, /^\.github\//, /^\.gitignore$/, /^\.gitattributes$/, /^tests\/golden\//,
];

function importsOf(text) {
  const out = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'`]([^"'`\n]+)["'`]/g;
  for (let m; (m = re.exec(text)); ) out.push(m[1]);
  return out.filter((s) => s.startsWith("."));
}
function mentionsIn(text, knownPaths) {
  const out = new Set();
  const re = /(?:^|[^\w./-])((?:src|tools|ui|tests|docs|skills|third_party)\/[\w./@-]+)/g;
  for (let m; (m = re.exec(text)); ) {
    const p = m[1].replace(/[.,;:]+$/, "");
    if (knownPaths.has(p)) out.add(p);
    else for (const ext of [".ts", ".mjs", ".js", ".tsx"]) if (knownPaths.has(p + ext)) out.add(p + ext);
  }
  return out;
}
function resolveSpec(from, spec, known) {
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  const cands = [base, base.replace(/\.(m?)js$/, ".$1ts"), base.replace(/\.js$/, ".tsx"), `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`];
  return cands.find((c) => known.has(c)) ?? null;
}

/** files: Map<repoRelPath, text|null>. Returns { full: string|null, tests: string[] } */
export function computeAffected(changed, files, opts = {}) {
  // opts.fast: ignore path-mention edges into src/ (tests that spawn the CLI are then only
  // selected by direct import / name match). Faster, less safe; default is conservative.
  for (const c of changed) {
    const hit = ALWAYS_FULL.find((r) => r.test(c));
    if (hit) return { full: `${c} affects every test run`, tests: [] };
  }
  const known = new Set(files.keys());
  const deps = new Map(); // file -> Set<dep>
  for (const [f, text] of files) {
    if (text === null || !(SRC_EXT.test(f) || f.endsWith(".sh"))) continue;
    const d = new Set();
    for (const s of importsOf(text)) { const r = resolveSpec(f, s, known); if (r) d.add(r); }
    const fromSrc = !/\.test\.ts$/.test(f); // prose/comment mentions in non-test files are noise: only code-file mentions link
    for (const p of mentionsIn(text, known)) if (p !== f && (!fromSrc || SRC_EXT.test(p) || p.endsWith(".sh")) && !(opts.fast && p.startsWith('src/'))) d.add(p);
    deps.set(f, d);
  }
  const tests = [...known].filter((f) => IS_TEST.test(f));
  const closure = (t) => {
    const seen = new Set([t]); const stack = [t];
    while (stack.length) for (const d of deps.get(stack.pop()) ?? []) if (!seen.has(d)) { seen.add(d); if (!IS_TEST.test(d)) stack.push(d); }
    return seen;
  };
  const closures = new Map(tests.map((t) => [t, closure(t)]));
  const hits = new Set();
  const mentionedBy = (f) => tests.filter((t) => closures.get(t).has(f));
  for (const c of changed) {
    if (IS_TEST.test(c)) { if (known.has(c)) hits.add(c); continue; }
    if (!/^(?:src|tools|tests|docs|ui|skills|third_party)\//.test(c) && !/^(?:README|CONTRIBUTING|CLAUDE|SPEC|LICENSE)/.test(c)) return { full: `${c}: unknown location`, tests: [] };
    if (!known.has(c)) continue; // deleted file: its dependents still mention it textually; handled below
    const direct = mentionedBy(c);
    for (const t of direct) hits.add(t);
    const stem = posix.basename(c).replace(/\.[^.]+$/, "");
    let named = 0;
    if (stem.length >= 4 && stem !== "index") for (const t of tests) if (posix.basename(t).includes(stem)) { hits.add(t); named++; }
    if (direct.length === 0 && named === 0 && /^(?:src|tools)\//.test(c)) return { full: `${c}: no test depends on it (cannot map)`, tests: [] };
    if (/^docs\//.test(c)) for (const t of tests) if (t.startsWith("tests/gate/docs/")) hits.add(t);
  }
  for (const c of changed) if (!known.has(c) && !IS_TEST.test(c) && /^(?:src|tools)\//.test(c)) return { full: `${c}: deleted/renamed; cannot map`, tests: [] };
  return { full: null, tests: [...hits].filter((t) => GATE_TEST.test(t)).sort() };
}

function gitLines(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 }).split("\n").filter(Boolean);
}
export function collect(cwd, base) {
  const changed = new Set([
    ...gitLines(cwd, ["diff", "--name-only", "--no-renames", `${base}...HEAD`]),
    ...gitLines(cwd, ["diff", "--name-only", "--no-renames", "HEAD"]),
    ...gitLines(cwd, ["ls-files", "-o", "--exclude-standard"]),
  ]);
  const paths = new Set([...gitLines(cwd, ["ls-files"]), ...gitLines(cwd, ["ls-files", "-o", "--exclude-standard"])]);
  const files = new Map();
  for (const p of paths) {
    if (/^(?:node_modules|dist)\//.test(p) || !existsSync(join(cwd, p))) continue;
    const scan = /^(?:src|tests|tools|ui)\//.test(p) && (SRC_EXT.test(p) || p.endsWith(".sh")) && !/^tests\/fixtures\/bundles\//.test(p);
    files.set(p, scan ? readFileSync(join(cwd, p), "utf8") : null);
  }
  return { changed: [...changed].sort(), files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const base = args.find((a) => !a.startsWith("--")) ?? "main";
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { changed, files } = collect(root, base);
  const r = computeAffected(changed, files, { fast: args.includes("--fast") });
  console.log(`changed vs ${base}: ${changed.length} file(s)`);
  if (changed.length === 0) { console.log("nothing changed; nothing to run"); process.exit(0); }
  if (r.full) {
    console.log(`FULL GATE: ${r.full}`);
    if (dry) process.exit(0);
    process.exit(spawnSync(process.execPath, [join(root, "tools/run-tests.mjs")], { stdio: "inherit", cwd: root }).status ?? 1);
  }
  console.log(`${r.tests.length} affected test file(s)`);
  for (const t of r.tests) console.log("  " + t);
  if (dry || r.tests.length === 0) process.exit(0);
  process.exit(spawnSync(process.execPath, [join(root, "tools/run-tests.mjs"), ...r.tests], { stdio: "inherit", cwd: root }).status ?? 1);
}
