#!/usr/bin/env node
// tools/torture/score.mjs — score an `hbc2js export` tree against a torture
// build's manifest.json (tools/torture/README.md "Scoring").
//
//   node tools/torture/score.mjs <export-dir> <manifest.json> [--json] [--jobs N] [--timeout-ms T]
//
// Metrics: dependency set vs truth (direct deps and every bundled package,
// with version agreement), module-path recovery, bucket (app vs vendor)
// classification, function-name recovery, free identifiers
// (tools/export-check/free-idents.mjs), and semantic equivalence: every
// recovered core/junk entry point is run in Node from the exported tree
// (src/_hbc registry, independent of hbc2js's own oracle) and its result
// compared with the manifest's checksum.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";

const HERE = fileURLToPath(new URL(".", import.meta.url));

function entryArg(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul((h ^ name.charCodeAt(i)) >>> 0, 16777619) >>> 0;
  return (h % 1000) + 1;
}

// ---- child mode: run one recovered module's entry points -------------------
async function runModuleChild(exportDir, id, names, isCore) {
  const req = (p) => import("node:module").then((m) => m.createRequire(join(exportDir, "index.js"))(p));
  const results = {};
  try {
    await req("./src/_hbc/helpers.js");
    const reg = await req("./src/_hbc/registry.js");
    const exp = JSON.parse(readFileSync(join(exportDir, "EXPORT.json"), "utf8"));
    const byId = new Map(exp.modules.map((m) => [m.id, m.path]));
    // Register just what is reachable; module files require() their deps.
    await req("./" + byId.get(id));
    const ns = reg.r(id);
    for (const n of names) {
      try {
        const f = ns[n];
        if (typeof f !== "function") { results[n] = { status: "missing" }; continue; }
        const v = isCore ? await f() : await f(entryArg(n));
        results[n] = { status: "ok", value: v };
      } catch (e) {
        results[n] = { status: "threw", error: String(e && e.message || e).slice(0, 200) };
      }
    }
  } catch (e) {
    for (const n of names) results[n] ??= { status: "load-failed", error: String(e && e.message || e).slice(0, 200) };
  }
  process.stdout.write(JSON.stringify(results));
}

function runChild(exportDir, id, names, isCore, timeoutMs) {
  return new Promise((resolve) => {
    execFile(process.execPath, [fileURLToPath(import.meta.url), "--child", exportDir, String(id), JSON.stringify(names), isCore ? "1" : "0"],
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        try { resolve(JSON.parse(stdout)); } catch {
          const status = err && err.killed ? "timeout" : "load-failed";
          resolve(Object.fromEntries(names.map((n) => [n, { status, error: String(err && err.message || "").slice(0, 200) }])));
        }
      });
  });
}

async function pool(tasks, jobs) {
  const out = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); }
  }));
  return out;
}

const pct = (a, b) => (b === 0 ? null : Math.round((1000 * a) / b) / 10);

export async function score(exportDir, manifestPath, { jobs, timeoutMs } = {}) {
  jobs ??= Math.max(2, cpus().length - 2); timeoutMs ??= 60000;
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const exp = JSON.parse(readFileSync(join(exportDir, "EXPORT.json"), "utf8"));
  const pkgJson = JSON.parse(readFileSync(join(exportDir, "package.json"), "utf8"));
  const expById = new Map(exp.modules.map((m) => [m.id, m]));
  const pathToId = new Map(Object.entries(man.moduleIds).map(([id, p]) => [p, Number(id)]));

  // 1. dependencies
  const recovered = { ...(pkgJson.dependencies || {}) };
  for (const [k, v] of Object.entries(exp.dependencies || {})) recovered[k] ??= v.version;
  const direct = man.dependencies;
  const bundled = man.bundledPackages;
  const recNames = Object.keys(recovered);
  const tpBundled = recNames.filter((n) => n in bundled);
  const deps = {
    recovered: recNames.length,
    directTruth: Object.keys(direct).length,
    directRecall: pct(Object.keys(direct).filter((n) => n in recovered).length, Object.keys(direct).length),
    directMissing: Object.keys(direct).filter((n) => !(n in recovered)),
    bundledTruth: Object.keys(bundled).length,
    bundledRecall: pct(tpBundled.length, Object.keys(bundled).length),
    precision: pct(tpBundled.length, recNames.length),
    falsePositives: recNames.filter((n) => !(n in bundled)),
    versionExact: pct(tpBundled.filter((n) => recovered[n] === bundled[n].version).length, tpBundled.length),
    versionWrong: tpBundled.filter((n) => recovered[n] !== bundled[n].version).map((n) => `${n}: ${recovered[n]} (truth ${bundled[n].version})`),
    reactNative: { recovered: exp.reactNative && exp.reactNative.version, truth: man.rnVersion },
  };

  // 2. modules: path + bucket + owner
  let pathExact = 0, pathBase = 0, appTotal = 0, appAsApp = 0, vendTotal = 0, vendOwner = 0, vendAsApp = 0, missingMods = 0;
  const base = (p) => p.replace(/^.*\//, "").replace(/\.[jt]sx?$/, "");
  for (const [idStr, truthPath] of Object.entries(man.moduleIds)) {
    const m = expById.get(Number(idStr));
    if (!m) { missingMods++; continue; }
    if (truthPath.startsWith("node_modules/")) {
      vendTotal++;
      const rest = truthPath.slice(13).split("/");
      const pkg = rest[0].startsWith("@") ? rest[0] + "/" + rest[1] : rest[0];
      if (m.owner === pkg) vendOwner++;
      if (m.bucket === "app") vendAsApp++;
    } else {
      appTotal++;
      if (m.bucket === "app") appAsApp++;
      if (m.path === truthPath || m.path === "src/" + truthPath) pathExact++;
      if (base(m.path) === base(truthPath)) pathBase++;
    }
  }
  const modules = {
    truth: Object.keys(man.moduleIds).length, exported: exp.modules.length, missing: missingMods,
    appModules: appTotal, appPathExact: pct(pathExact, appTotal), appBasenameMatch: pct(pathBase, appTotal),
    appClassifiedApp: pct(appAsApp, appTotal), vendorModules: vendTotal,
    vendorOwnerCorrect: pct(vendOwner, vendTotal), vendorClassifiedApp: vendAsApp,
  };

  // 3. function names: declared (`function NAME(` / `// fn#N "NAME"`) in the
  //    recovered file of the truth module.
  const fileCache = new Map();
  const text = (id) => {
    if (!fileCache.has(id)) {
      const m = expById.get(id);
      const p = m && join(exportDir, m.path);
      fileCache.set(id, p && existsSync(p) ? readFileSync(p, "utf8") : "");
    }
    return fileCache.get(id);
  };
  const named = [];
  for (const f of man.junk) named.push([f.module, f.name]);
  for (const [mod, names] of Object.entries(man.coreFunctionNames)) for (const n of names) named.push([mod, n]);
  let nameDecl = 0, nameAnywhere = 0;
  for (const [mod, n] of named) {
    const t = text(pathToId.get(mod));
    const esc = n.replace(/[$]/g, "\\$");
    if (new RegExp(`function ${esc}\\s*\\(|// fn#\\d+ "${esc}"`).test(t)) nameDecl++;
    if (t.includes(n)) nameAnywhere++;
  }
  const names = { truth: named.length, declaredInRightModule: pct(nameDecl, named.length), mentionedInRightModule: pct(nameAnywhere, named.length) };

  // 4. free identifiers
  let free = null;
  try {
    const out = execFileSync(process.execPath, [join(HERE, "../export-check/free-idents.mjs"), exportDir, "--json"], { maxBuffer: 256 * 1024 * 1024, timeout: 600000 });
    const j = JSON.parse(out.toString());
    const files = Object.entries(j.files || {});
    const counts = new Map();
    for (const [, ns] of files) for (const n of ns) counts.set(n, (counts.get(n) || 0) + 1);
    free = { summary: j.summary, filesWithFree: files.length, top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15) };
  } catch (e) {
    free = { error: String(e.message).slice(0, 300) };
  }

  // 5. semantic equivalence in Node
  const groups = new Map();
  for (const c of man.core) { const k = "c:" + c.module; if (!groups.has(k)) groups.set(k, { mod: c.module, core: true, items: [] }); groups.get(k).items.push(c); }
  for (const j of man.junk) { const k = "j:" + j.module; if (!groups.has(k)) groups.set(k, { mod: j.module, core: false, items: [] }); groups.get(k).items.push(j); }
  const tasks = [...groups.values()].map((g) => async () => {
    const id = pathToId.get(g.mod);
    if (id === undefined || !expById.has(id)) return g.items.map((it) => ({ it, r: { status: "module-not-exported" }, core: g.core }));
    const res = await runChild(exportDir, id, g.items.map((it) => it.name), g.core, timeoutMs);
    return g.items.map((it) => ({ it, r: res[it.name] || { status: "missing" }, core: g.core }));
  });
  const all = (await pool(tasks, jobs)).flat();
  const sem = { core: { total: 0, pass: 0 }, junk: { total: 0, pass: 0 }, byStatus: {}, failures: [] };
  for (const { it, r, core } of all) {
    const bucket = core ? sem.core : sem.junk;
    bucket.total++;
    let st = r.status;
    if (st === "ok") st = JSON.stringify(r.value) === JSON.stringify(it.expected) ? "pass" : "wrong-value";
    if (st === "pass") bucket.pass++;
    sem.byStatus[st] = (sem.byStatus[st] || 0) + 1;
    if (st !== "pass" && sem.failures.length < 40) sem.failures.push({ module: it.module, name: it.name, status: st, expected: it.expected, got: r.value, error: r.error });
  }
  sem.core.rate = pct(sem.core.pass, sem.core.total);
  sem.junk.rate = pct(sem.junk.pass, sem.junk.total);

  return { variant: man.variant, deps, modules, names, freeIdentifiers: free, semantic: sem };
}

async function main() {
  const a = process.argv.slice(2);
  if (a[0] === "--child") return runModuleChild(a[1], Number(a[2]), JSON.parse(a[3]), a[4] === "1");
  const pos = a.filter((x, i) => !x.startsWith("--") && !(i > 0 && /^--(jobs|timeout-ms)$/.test(a[i - 1])));
  if (pos.length < 2) { console.error("usage: node tools/torture/score.mjs <export-dir> <manifest.json> [--json] [--jobs N] [--timeout-ms T]"); process.exit(2); }
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? Number(a[i + 1]) : undefined; };
  const res = await score(pos[0], pos[1], { jobs: get("--jobs"), timeoutMs: get("--timeout-ms") });
  console.log(JSON.stringify(res, null, 2));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
