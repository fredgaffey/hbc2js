#!/usr/bin/env node
// tools/app-fuzz/loop.mjs — the app fuzzer's static bug-finding loop
// (tools/app-fuzz/README.md):
//   generate (gen-shapes.mjs) -> build .hbc (tools/torture/build.mjs) ->
//   hbc2js export -> static checks (parse, free identifiers, stubs, tiers,
//   warning codes) + exact per-function checksum oracle (score.mjs child
//   loader) -> minimise -> findings DB + coverage-guided weights.
//
//   node tools/app-fuzz/loop.mjs --seeds 1..30 [--profile hard|mixed|ui]
//        [--root /tmp/hbc2js/app-fuzz] [--findings /tmp/hbc2js/findings.mjs]
//        [--no-minimise] [--keep]
//   node tools/app-fuzz/loop.mjs --summary [--root DIR]
//   node tools/app-fuzz/loop.mjs --verify-repros [--root DIR]   (Hermes VM triage)
//
// One seed at a time (one export at a time on a shared box).
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, appendFileSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { makeRng } from "../appgen/lib/prng.mjs";
import { planShapes, emitShapes, DEFAULT_WEIGHTS, TEMPLATE_NAMES, entryArg } from "./gen-shapes.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "../..");
const SCORE = join(ROOT, "tools/torture/score.mjs");

// ------------------------------------------------------------------ args --
function parseArgs(argv) {
  const o = { profile: "hard", root: "/tmp/hbc2js/app-fuzz", findings: "/tmp/hbc2js/findings.mjs", minimise: true, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seeds") { const [lo, hi] = argv[++i].split(".."); o.lo = Number(lo); o.hi = Number(hi ?? lo); }
    else if (a === "--profile") o.profile = argv[++i];
    else if (a === "--root") o.root = argv[++i];
    else if (a === "--findings") o.findings = argv[++i];
    else if (a === "--no-minimise") o.minimise = false;
    else if (a === "--keep") o.keep = true;
    else if (a === "--summary") o.summary = true;
    else if (a === "--verify-repros") o.verifyRepros = true;
    else if (a === "--hermes") o.hermes = argv[++i];
    else if (a === "--reduce") o.reduce = argv[++i];
    else if (a === "--budget") o.budget = Number(argv[++i]);
  }
  return o;
}

/** Per-seed build config from the profile (deterministic in the seed). */
export function seedConfig(seed, profile) {
  const r = makeRng(`appfuzz:${profile}:${seed}`);
  const hbc = [96, 98, 99][r.int(3)];
  const minify = r.int(4) === 0;
  if (profile === "ui") return { seed, profile, hbc, minify, obfuscate: false, headlessOnly: false, functions: 24, size: 1 };
  if (profile === "mixed") return { seed, profile, hbc, minify, obfuscate: r.int(5) === 0, headlessOnly: true, functions: 48, size: 1 };
  return { seed, profile, hbc, minify, obfuscate: false, headlessOnly: true, functions: 32, size: 1.6 };
}

// -------------------------------------------------------------- coverage --
function loadCoverage(root) {
  const p = join(root, "coverage.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { seeds: 0, feature: {}, assoc: {} };
}
function saveCoverage(root, cov) { writeFileSync(join(root, "coverage.json"), JSON.stringify(cov, null, 1) + "\n"); }

/** Template weights biased toward shapes that co-occur with rare features
 *  (warning codes, stubs, tier downgrades, failures). */
export function guidedWeights(cov) {
  const w = { ...DEFAULT_WEIGHTS };
  if (!cov.seeds) return w;
  for (const t of TEMPLATE_NAMES) {
    const a = cov.assoc[t] || {};
    const total = a["#modules"] || 0;
    if (!total) { w[t] = DEFAULT_WEIGHTS[t] * 2; continue; } // never tried: explore
    let score = 0;
    for (const [f, n] of Object.entries(a)) {
      if (f.startsWith("#")) continue;
      const rarity = 1 / Math.sqrt(cov.feature[f] || 1);
      score += (n / total) * rarity * (f.startsWith("fail:") ? 3 : 1);
    }
    w[t] = Math.round(DEFAULT_WEIGHTS[t] * Math.min(5, Math.max(0.3, 0.5 + 4 * score)) * 100) / 100;
  }
  return w;
}

function recordCoverage(cov, moduleFeatures) {
  cov.seeds++;
  for (const { shapes, features } of moduleFeatures) {
    for (const f of features) cov.feature[f] = (cov.feature[f] || 0) + 1;
    for (const t of new Set(shapes)) {
      const a = (cov.assoc[t] ||= {});
      a["#modules"] = (a["#modules"] || 0) + 1;
      for (const f of features) a[f] = (a[f] || 0) + 1;
    }
  }
}

// ------------------------------------------------------------- pipeline --
const ms = (t0) => Date.now() - t0;

async function buildPlan(plan, cfg, out, ws, gen = () => emitShapes(plan, `seed ${cfg.seed}`)) {
  const { build } = await import("../torture/build.mjs");
  return build({ seed: cfg.seed, functions: plan.length, hbc: cfg.hbc, minify: cfg.minify, obfuscate: cfg.obfuscate, headlessOnly: cfg.headlessOnly, out, ws, generate: gen });
}

function runExport(hbcPath, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  const t0 = Date.now();
  let stderr = "", ok = true, error = null;
  try {
    const r = execFileSync(process.execPath, [join(ROOT, "src/cli.ts"), "export", hbcPath, "--out", outDir],
      { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, env: { ...process.env, HBC2JS_WORKERS: process.env.HBC2JS_WORKERS || "6" } });
    stderr = r.toString();
  } catch (e) { ok = false; stderr = String(e.stderr || ""); error = String(e.message || e).slice(0, 400); }
  return { ok, error, ms: ms(t0), log: stderr };
}

/** Normalised crash signature from an export log: the first E_* line, numbers
 *  and offsets masked. */
export function crashSig(log) {
  const m = /\b(E_[A-Z_]+): ([^\n]*)/.exec(log || "");
  if (!m) return "no-error-code";
  return (m[1] + ": " + m[2]).replace(/0x[0-9a-f]+/gi, "0xN").replace(/\d+/g, "N").replace(/\s+\(at [^)]*\)\s*$/, "").slice(0, 120);
}

function childRun(exportDir, id, names, isCore, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCORE, "--child", exportDir, String(id), JSON.stringify(names), isCore ? "1" : "0"],
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        try { resolve(JSON.parse(stdout)); } catch {
          resolve(Object.fromEntries(names.map((n) => [n, { status: err && err.killed ? "timeout" : "load-failed", error: String(err && err.message || "").slice(0, 200) }])));
        }
      });
  });
}

/** Hermes VM for an HBC version, if present (tools/hermes-vm/v<N>, built by
 *  tools/build-hermes-vm.sh, or $HBC2JS_APPFUZZ_HERMES_<N>). */
export function hermesVmFor(v) {
  return [process.env[`HBC2JS_APPFUZZ_HERMES_${v}`], join(ROOT, `tools/hermes-vm/v${v}/bin/hermes`), join(ROOT, `tools/hermes-vm/build-${v}/bin/hermes`)]
    .find((p) => p && existsSync(p)) || null;
}

/** Run headless.hbc in the VM: { core: {name: v}, junk: {"path#name": v} } or null. */
function vmTruth(hbcPath, v) {
  const vm = hermesVmFor(v);
  if (!vm) return null;
  try { return JSON.parse(execFileSync(vm, [hbcPath], { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }).toString().trim().split("\n").pop()); }
  catch (e) { return { error: String(e.message).slice(0, 200) }; }
}

const CODE_RE = /\b([WE]_[A-Z0-9_]{3,})\b/g;

/** Static checks + checksum oracle over one export. Returns per-module
 *  features and per-function/core failures. */
async function checkExport(exportDir, manifest, vm = null) {
  const { parse } = await import("@babel/parser");
  const { freeIdentifiers } = await import("../export-check/free-idents.mjs");
  const exp = JSON.parse(readFileSync(join(exportDir, "EXPORT.json"), "utf8"));
  const byId = new Map(exp.modules.map((m) => [m.id, m]));
  const pathToId = new Map(Object.entries(manifest.moduleIds).map(([id, p]) => [p, Number(id)]));
  // Truth for the decompiled code is what the bytecode computes: the Hermes
  // VM when available, else the Node truth (flagged unverified). A Node vs
  // Hermes disagreement is recorded separately (never a decompiler bug).
  const vmOk = vm && !vm.error && vm.junk;
  const res = { truth: vmOk ? "hermes-vm" : "node-unverified", engineDiv: [], syntaxErrors: 0, files: 0, codes: {}, tiers: {}, modules: [], failures: [], core: { total: 0, pass: 0 }, junk: { total: 0, pass: 0 } };
  // Syntax over every exported app/vendor module file.
  const srcRoot = join(exportDir, "src");
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".js") ? [join(d, e.name)] : []);
  const parseErr = (code) => {
    try { parse(code, { sourceType: "unambiguous", plugins: ["jsx"], allowReturnOutsideFunction: true }); return null; }
    catch (e) { return String(e.message).slice(0, 160); }
  };
  for (const f of existsSync(srcRoot) ? walk(srcRoot) : []) {
    res.files++;
    const code = readFileSync(f, "utf8");
    for (const m of code.matchAll(CODE_RE)) res.codes[m[1]] = (res.codes[m[1]] || 0) + 1;
    if (parseErr(code)) res.syntaxErrors++;
  }
  for (const m of exp.modules) res.tiers[m.tier] = (res.tiers[m.tier] || 0) + 1;
  // Junk modules: features + semantic.
  const byModule = new Map();
  for (const j of manifest.junk) { if (!byModule.has(j.module)) byModule.set(j.module, []); byModule.get(j.module).push(j); }
  for (const [path, fns] of byModule) {
    const id = pathToId.get(path);
    const em = byId.get(id);
    const features = new Set();
    const shapes = fns.flatMap((f) => f.shapes || []);
    if (!em) { features.add("fail:module-not-exported"); for (const f of fns) res.failures.push({ kind: "module-not-exported", fn: f, module: path }); res.modules.push({ path, shapes, features: [...features] }); continue; }
    const file = join(exportDir, em.path);
    const code = existsSync(file) ? readFileSync(file, "utf8") : "";
    features.add("tier:" + em.tier);
    if (em.tierDowngradeReason) features.add("downgrade:" + String(em.tierDowngradeReason).replace(/[0-9]+/g, "N").slice(0, 60));
    for (const m of code.matchAll(CODE_RE)) features.add("code:" + m[1]);
    // Decompiler-path signals in the output: runtime helpers it fell back
    // to, label/unreachable density, and bloat versus the source.
    const b2 = (n) => (n <= 0 ? "0" : "2^" + Math.floor(Math.log2(n)));
    for (const m of new Set([...code.matchAll(/\b(__hbc_[A-Za-z0-9_]+)/g)].map((x) => x[1]))) features.add("helper:" + m);
    features.add("unreachable:" + b2(code.split("hbc2js: unreachable").length - 1));
    features.add("labels:" + b2([...code.matchAll(/^\s*[A-Za-z_$][\w$]*:\s*(for|while|do|switch|\{)/gm)].length));
    features.add("whileTrue:" + b2([...code.matchAll(/while \(true\)|for \(;;\)/g)].length));
    const srcLen = fns.reduce((a, f) => a + (f.parts || []).length, 0) || 1;
    features.add("bloat:" + b2(Math.round(code.length / 1000 / srcLen)));
    const pe = parseErr(code);
    if (pe) { features.add("fail:syntax"); res.failures.push({ kind: "syntax", module: path, exportPath: em.path, error: pe, fns }); }
    else {
      let free = [];
      try { free = freeIdentifiers(code); } catch {}
      if (free.length) { features.add("fail:free-ident"); res.failures.push({ kind: "free-ident", module: path, exportPath: em.path, error: free.slice(0, 8).join(","), fns }); }
    }
    const stubbed = [...code.matchAll(/hbc2js: could not decompile (\S+) -- ([A-Z_]+)/g)];
    if (stubbed.length) { features.add("fail:stub"); res.failures.push({ kind: "stub", module: path, exportPath: em.path, error: stubbed.map((m) => m[2]).join(","), fns }); }
    const got = await childRun(exportDir, id, fns.map((f) => f.name), false);
    for (const f of fns) {
      res.junk.total++;
      const g = got[f.name] || { status: "missing" };
      let st = g.status;
      const want = vmOk && typeof vm.junk[f.module + "#" + f.name] === "number" ? vm.junk[f.module + "#" + f.name] : f.expected;
      if (vmOk && want !== f.expected) { features.add("engine-divergence"); res.engineDiv.push({ kind: "hermes-vs-node", module: path, fn: f, got: want, decompiled: g.value }); }
      if (st === "ok") st = g.value === want ? "pass" : "wrong-value";
      if (st === "pass") { res.junk.pass++; continue; }
      features.add("fail:" + st);
      res.failures.push({ kind: st, module: path, exportPath: em.path, fn: f, got: g.value, want, error: g.error });
    }
    res.modules.push({ path, shapes, features: [...features] });
  }
  // Torture core (same 28 entries every seed): checked, never minimised.
  const coreBy = new Map();
  for (const c of manifest.core) { if (!coreBy.has(c.module)) coreBy.set(c.module, []); coreBy.get(c.module).push(c); }
  for (const [path, cs] of coreBy) {
    const id = pathToId.get(path);
    if (!byId.has(id)) { for (const c of cs) res.failures.push({ kind: "core:module-not-exported", core: c.name }); res.core.total += cs.length; continue; }
    const got = await childRun(exportDir, id, cs.map((c) => c.name), true);
    for (const c of cs) {
      res.core.total++;
      const g = got[c.name] || { status: "missing" };
      const want = vmOk && vm.core && c.name in vm.core ? vm.core[c.name] : c.expected;
      const st = g.status === "ok" ? (JSON.stringify(g.value) === JSON.stringify(want) ? "pass" : "wrong-value") : g.status;
      if (st === "pass") res.core.pass++;
      else res.failures.push({ kind: "core:" + st, core: c.name, module: path, error: g.error });
    }
  }
  return res;
}

// ----------------------------------------------------------- minimising --
/** Does `plan` (a few fn specs) still show failure `kind` for function
 *  `name` (or, for module-level static kinds, anywhere)? */
async function reproduces(plan, cfg, kind, name, scratch, ws, gen) {
  try {
    const { manifest } = await buildPlan(plan, cfg, join(scratch, "b"), ws, gen);
    const ex = runExport(join(scratch, "b/bundle.hbc"), join(scratch, "e"));
    if (!ex.ok) return kind === "export-crash" && crashSig(ex.log) === name;
    const res = await checkExport(join(scratch, "e"), manifest, vmTruth(join(scratch, "b/headless.hbc"), cfg.hbc));
    if (kind === "hermes-vs-node") return res.engineDiv.some((f) => f.fn.name === name);
    return res.failures.some((f) => f.kind === kind && (!f.fn || !name || f.fn.name === name || (f.fns || []).some((x) => x.name === name)));
  } catch (e) {
    return false; // build failure in a reduced case: not a reproduction
  }
}

/** ddmin-lite: functions first (halving), then parts of the survivor. */
async function minimise(planAll, failure, cfg, scratch, ws, budget = 14) {
  let tries = 0;
  const target = failure.kind === "export-crash" ? failure.sig : failure.fn ? failure.fn.name : null;
  let fns = failure.fn ? planAll.filter((f) => f.name === target) : planAll.filter((f) => failure.fns.some((x) => x.name === f.name));
  fns = fns.map((f) => ({ ...f, mod: 0 }));
  const check = async (p) => { tries++; return reproduces(p, cfg, failure.kind, target, scratch, ws); };
  if (!(await check(fns))) return { ok: false, tries, plan: fns };
  // A crash that reproduces with no generated code at all is in the fixed
  // torture core (or the toolchain), not in a generated shape.
  if (failure.kind === "export-crash" && (await check([]))) return { ok: true, tries, plan: [] };
  while (fns.length > 1 && tries < budget) { // halve the function set
    const a = fns.slice(0, fns.length >> 1), b = fns.slice(fns.length >> 1);
    if (await check(a)) fns = a; else if (await check(b)) fns = b; else break;
  }
  if (fns.length === 1) { // drop parts one at a time
    let parts = fns[0].parts;
    for (let i = parts.length - 1; i >= 0 && parts.length > 1 && tries < budget; i--) {
      const cand = parts.filter((_, j) => j !== i);
      if (await check([{ ...fns[0], parts: cand }])) parts = cand;
    }
    fns = [{ ...fns[0], parts }];
  }
  return { ok: true, tries, plan: fns };
}

const slug = (s) => s.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80);

function clusterOf(f, plan) {
  if (f.kind.startsWith("core:")) return `app-fuzz:${f.kind}:${f.core}`;
  // Crashes cluster by signature alone (the minimal shapes go in the detail),
  // so a minimised and an unminimised sighting share one key.
  if (f.kind === "export-crash") return `app-fuzz:export-crash:${f.sig}`;
  const shapes = [...new Set(plan.flatMap((p) => p.parts.map((x) => x.t)))].sort();
  const err = f.kind === "stub" ? ":" + f.error.split(",")[0] : "";
  return `app-fuzz:${f.kind}${err}:${shapes.join("+")}`;
}

const KIND_OF = { "hermes-vs-node": "other", "wrong-value": "miscompile", threw: "miscompile", timeout: "miscompile", "load-failed": "crash", missing: "miscompile", syntax: "syntax", "free-ident": "free-ident", stub: "stub", "module-not-exported": "other", "export-crash": "crash" };

function addFinding(o, row) {
  if (!existsSync(o.findings)) return null;
  const args = [o.findings, "add", "--source", "app-fuzz"];
  for (const [k, v] of Object.entries(row)) if (v !== undefined && v !== null) args.push("--" + k, String(v));
  try { return execFileSync(process.execPath, args).toString().trim(); } catch (e) { return "ERR " + String(e.message).slice(0, 100); }
}

// ------------------------------------------------------------ one seed ---
async function runSeed(seed, o, cov, seenClusters) {
  const cfg = seedConfig(seed, o.profile);
  const weights = guidedWeights(cov);
  const plan = planShapes(`${o.profile}:${seed}`, cfg.functions, { weights, size: cfg.size });
  const dir = join(o.root, "runs", `${o.profile}-${seed}`);
  const ws = join(o.root, "ws");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const row = { seed, profile: o.profile, hbc: cfg.hbc, minify: cfg.minify, obfuscate: cfg.obfuscate, headlessOnly: cfg.headlessOnly, functions: plan.length, t: {} };
  let t0 = Date.now();
  let manifest;
  try { ({ manifest } = await buildPlan(plan, cfg, join(dir, "build"), ws)); }
  catch (e) { row.buildError = String(e.message).slice(0, 300); appendFileSync(join(o.root, "seeds.jsonl"), JSON.stringify(row) + "\n"); return row; }
  row.t.build = ms(t0);
  row.hbcFunctions = null;
  const ex = runExport(join(dir, "build/bundle.hbc"), join(dir, "export"));
  row.t.export = ex.ms;
  const logCodes = {};
  for (const m of ex.log.matchAll(CODE_RE)) logCodes[m[1]] = (logCodes[m[1]] || 0) + 1;
  row.exportLogCodes = logCodes;
  let res;
  if (!ex.ok) {
    res = { failures: [{ kind: "export-crash", sig: crashSig(ex.log), error: crashSig(ex.log), fns: plan }], modules: [], junk: { total: 0, pass: 0 }, core: { total: 0, pass: 0 } };
  } else {
    t0 = Date.now();
    res = await checkExport(join(dir, "export"), manifest, vmTruth(join(dir, "build/headless.hbc"), cfg.hbc));
    row.truth = res.truth;
    row.engineDivergences = res.engineDiv.length;
    // Engine divergences: one finding per seed+shape set, minimised like the rest.
    res.failures.push(...res.engineDiv);
    row.t.check = ms(t0);
  }
  row.junk = res.junk; row.core = res.core; row.syntaxErrors = res.syntaxErrors; row.files = res.files;
  row.codes = res.codes; row.tiers = res.tiers;
  recordCoverage(cov, res.modules);
  // Cluster failures; minimise one representative per new cluster.
  row.findings = [];
  const groups = new Map();
  for (const f of res.failures) {
    const fplan = f.fn ? plan.filter((p) => p.name === f.fn.name) : f.fns ? plan.filter((p) => f.fns.some((x) => x.name === p.name)) : [];
    const c = clusterOf(f, fplan);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(f);
  }
  t0 = Date.now();
  for (const [c0, fs] of groups) {
    const f = fs[0];
    let cluster = c0, min = null, repro = null;
    const isCore = f.kind.startsWith("core:");
    if (o.minimise && !isCore && !seenClusters.has(c0)) {
      const scratch = join(dir, "min");
      min = await minimise(plan, f, cfg, scratch, ws);
      if (min.ok) {
        cluster = clusterOf(f, min.plan);
        repro = join(o.root, "repros", slug(cluster.replace(/^app-fuzz:/, "")) + `-s${seed}`);
        if (!seenClusters.has(cluster)) {
          mkdirSync(repro, { recursive: true });
          // Re-build the minimal case once more so its artifacts are kept.
          const { manifest: mm } = await buildPlan(min.plan, cfg, join(scratch, "b"), ws);
          runExport(join(scratch, "b/bundle.hbc"), join(scratch, "e"));
          const jm = mm.junk[0]?.module;
          if (jm) cpSync(join(scratch, "b/source", jm), join(repro, "source.js"));
          try {
            const exp = JSON.parse(readFileSync(join(scratch, "e/EXPORT.json"), "utf8"));
            const id = Object.entries(mm.moduleIds).find(([, p]) => p === jm)?.[0];
            const em = exp.modules.find((m) => m.id === Number(id));
            if (em) cpSync(join(scratch, "e", em.path), join(repro, "exported.js"));
          } catch { /* export crashed: no tree */ }
          cpSync(join(scratch, "b/headless.hbc"), join(repro, "headless.hbc"));
          writeFileSync(join(repro, "repro.json"), JSON.stringify({ cluster, kind: f.kind, cfg, plan: min.plan, expected: mm.junk.map((j) => ({ name: j.name, expected: j.expected, arg: entryArg(j.name) })), truth: res.truth, want: f.want, got: f.got, decompiled: f.decompiled, error: f.error, tries: min.tries }, null, 1) + "\n");
        } else repro = null;
      }
      rmSync(scratch, { recursive: true, force: true });
    }
    const novel = !seenClusters.has(cluster);
    seenClusters.add(c0); seenClusters.add(cluster);
    const fnName = f.fn ? f.fn.name : f.core || null;
    const summary = `${f.kind} in ${fnName || f.module || "?"} (${fs.length}x this seed)${f.error ? ": " + String(f.error).slice(0, 120) : ""}`;
    row.findings.push({ cluster, kind: f.kind, count: fs.length, minimised: !!(min && min.ok), parts: min && min.ok ? min.plan[0].parts.length : null, repro, novel });
    if (novel || !isCore) {
      addFinding(o, { cluster, summary, app: `appfuzz-${o.profile}-${seed}`, hbc: cfg.hbc, kind: KIND_OF[f.kind.replace(/^core:/, "")] || "other", severity: f.kind === "hermes-vs-node" ? "low" : /wrong-value|threw|syntax/.test(f.kind) ? "high" : "medium", repro: repro || undefined, detail: JSON.stringify({ cfg, truth: res.truth, fn: fnName, got: f.got, want: f.want, nodeExpected: f.fn && f.fn.expected, decompiled: f.decompiled, shapes: f.fn && f.fn.shapes }) });
    }
  }
  row.t.minimise = ms(t0);
  row.weights = weights;
  appendFileSync(join(o.root, "seeds.jsonl"), JSON.stringify(row) + "\n");
  if (!o.keep) rmSync(dir, { recursive: true, force: true });
  return row;
}

/** Statement-level reduction of a kept repro's module source: greedily
 *  delete statements (largest first) while the same failure persists.
 *  Never deletes declarations or update expressions (loop counters), so
 *  every candidate still terminates. Writes reduced.js next to repro.json. */
async function reduceRepro(dir, ws, budget) {
  const { parse } = await import("@babel/parser");
  const r = JSON.parse(readFileSync(join(dir, "repro.json"), "utf8"));
  const base = emitShapes(r.plan, "reduce");
  const mi = base.files.findIndex(([p]) => p.startsWith("src/junk/s"));
  let text = base.files[mi][1];
  const scratch = join(dir, "_reduce");
  const name = r.kind === "export-crash" ? r.error : r.plan[0]?.name;
  const gen = (t) => () => ({ ...base, files: base.files.map((f, i) => (i === mi ? [f[0], t] : f)) });
  const candidates = (t) => {
    const ast = parse(t, { sourceType: "module" });
    const out = [];
    const visit = (node, inBody) => {
      if (!node || typeof node.type !== "string") return;
      if (inBody && node.type !== "VariableDeclaration" && !(node.type === "ExpressionStatement" && node.expression.type === "UpdateExpression")) out.push([node.start, node.end]);
      for (const [k, v] of Object.entries(node)) {
        if (k === "loc" || k === "leadingComments" || k === "trailingComments") continue;
        const body = (node.type === "BlockStatement" && k === "body") || (node.type === "SwitchCase" && k === "consequent");
        if (Array.isArray(v)) v.forEach((c) => visit(c, body));
        else if (v && typeof v === "object") visit(v, false);
      }
    };
    visit(ast.program, false);
    return out.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  };
  let tries = 0, removed = 0;
  let progress = true;
  const tried = new Set();
  while (progress && tries < budget) {
    progress = false;
    for (const [a, b] of candidates(text)) {
      if (tries >= budget) break;
      const cand = text.slice(0, a) + text.slice(b);
      if (tried.has(cand)) continue;
      tried.add(cand);
      tries++;
      if (await reproduces(r.plan, r.cfg, r.kind, name, scratch, ws, gen(cand))) { text = cand; removed++; progress = true; break; }
    }
  }
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(join(dir, "reduced.js"), text);
  return { tries, removed, lines: text.split("\n").length };
}

function summary(root) {
  const rows = readFileSync(join(root, "seeds.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const lines = ["| profile | seed | hbc | min | obf | fns | junk pass | core pass | truth | hermes!=node | syntax err files | build s | export s | check s | min s | clusters |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  const clusters = new Map();
  for (const r of rows) {
    const t = (k) => (r.t?.[k] != null ? (r.t[k] / 1000).toFixed(0) : "-");
    lines.push(`| ${r.profile} | ${r.seed} | ${r.hbc} | ${r.minify ? "y" : ""} | ${r.obfuscate ? "y" : ""} | ${r.functions} | ${r.junk ? `${r.junk.pass}/${r.junk.total}` : r.buildError ? "BUILD-FAIL" : "-"} | ${r.core ? `${r.core.pass}/${r.core.total}` : "-"} | ${r.truth === "hermes-vm" ? "vm" : "node"} | ${r.engineDivergences ?? "-"} | ${r.syntaxErrors ?? "-"} | ${t("build")} | ${t("export")} | ${t("check")} | ${t("minimise")} | ${(r.findings || []).length} |`);
    for (const f of r.findings || []) {
      const c = clusters.get(f.cluster) || { n: 0, seeds: new Set(), hbc: new Set(), repro: null, kind: f.kind };
      c.n += f.count; c.seeds.add(r.seed); c.hbc.add(r.hbc); c.repro ||= f.repro;
      clusters.set(f.cluster, c);
    }
  }
  lines.push("", "| rank | cluster | fns | seeds | hbc | repro |", "|---|---|---|---|---|---|");
  [...clusters].sort((a, b) => b[1].seeds.size - a[1].seeds.size || b[1].n - a[1].n).forEach(([k, c], i) =>
    lines.push(`| ${i + 1} | ${k} | ${c.n} | ${c.seeds.size} | ${[...c.hbc].sort().join(",")} | ${c.repro || ""} |`));
  return lines.join("\n");
}

/** Triage: run each repro's headless.hbc in a Hermes VM; a Node/Hermes
 *  disagreement means the generator emitted an engine-dependent shape, not
 *  a decompiler bug. */
function verifyRepros(root, hermesFor) {
  const out = [];
  for (const d of readdirSync(join(root, "repros"))) {
    const rp = join(root, "repros", d, "repro.json");
    if (!existsSync(rp)) continue;
    const r = JSON.parse(readFileSync(rp, "utf8"));
    const vm = hermesFor(r.cfg.hbc);
    if (!vm) { out.push(`${d}\tno-vm-for-hbc${r.cfg.hbc}`); continue; }
    let got;
    try { got = JSON.parse(execFileSync(vm, [join(root, "repros", d, "headless.hbc")]).toString().trim().split("\n").pop()); } catch (e) { out.push(`${d}\tvm-error`); continue; }
    const val = (n) => Object.entries(got.junk).find(([k]) => k.endsWith("#" + n))?.[1];
    const agree = r.expected.every((e) => val(e.name) === e.expected);
    out.push(`${d}\t${agree ? "hermes-agrees-with-node (decompiler bug)" : "ENGINE-DIVERGENCE (generator bug)"}`);
  }
  return out.join("\n");
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  mkdirSync(o.root, { recursive: true });
  if (o.summary) { console.log(summary(o.root)); return; }
  if (o.reduce) { console.log(JSON.stringify(await reduceRepro(o.reduce, join(o.root, "ws"), o.budget || 60))); return; }
  if (o.verifyRepros) {
    const hermesFor = (v) => o.hermes || [join(ROOT, `tools/hermes-vm/build-${v}/bin/hermes`), join(ROOT, `tools/hermesc/v${v}/hermes`)].find(existsSync) || null;
    console.log(verifyRepros(o.root, hermesFor)); return;
  }
  if (o.lo === undefined) { console.error("usage: loop.mjs --seeds A..B [--profile hard|mixed|ui] | --summary | --verify-repros"); process.exit(2); }
  const cov = loadCoverage(o.root);
  const seenClusters = new Set(existsSync(join(o.root, "seeds.jsonl"))
    ? readFileSync(join(o.root, "seeds.jsonl"), "utf8").trim().split("\n").filter(Boolean).flatMap((l) => (JSON.parse(l).findings || []).map((f) => f.cluster)) : []);
  for (let s = o.lo; s <= o.hi; s++) {
    const t0 = Date.now();
    const row = await runSeed(s, o, cov, seenClusters);
    saveCoverage(o.root, cov);
    console.log(`[${o.profile} ${s}] hbc${row.hbc}${row.minify ? " min" : ""} ${row.truth === "hermes-vm" ? "vm" : "node"} junk ${row.junk ? row.junk.pass + "/" + row.junk.total : row.buildError ? "BUILD-FAIL " + row.buildError.slice(0, 80) : "-"} core ${row.core ? row.core.pass + "/" + row.core.total : "-"} syntaxErr ${row.syntaxErrors ?? "-"} findings ${(row.findings || []).map((f) => f.cluster + (f.novel ? "*" : "")).join(" ")} ${(ms(t0) / 1000).toFixed(0)}s`);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
