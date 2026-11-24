#!/usr/bin/env node
// tools/torture/build.mjs — build one torture-app variant end to end and
// write its exact ground truth (tools/torture/README.md).
//
//   node tools/torture/build.mjs --seed S --functions N [--hbc 96|98|99]
//        [--minify] [--obfuscate] [--out DIR] [--ws DIR]
//   node tools/torture/build.mjs --verify-hermes <outdir> [--hermes PATH]
//
// Pipeline (same no-Gradle shape as tools/appgen/build.mjs, spec 09 §2.2):
// cached workspace (npm install only when the pinned package.json changes)
// -> copy hand-written app/ + gen-junk.mjs output -> truth: run plain source
// in Node -> [--obfuscate: javascript-obfuscator over core+junk, truth re-run
// and must match] -> Metro bundle (app entry + headless entry) -> hermesc -O
// -> compose source maps -> manifest.json (+ Hermes VM check when a VM for
// that HBC version is available).
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, statSync, rmSync, readdirSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { generateJunk } from "./gen-junk.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "../..");
const RN_VERSION = "0.73.11";

// Exact pins (no ranges): the bundle's dependency truth is these versions.
export const PINS = {
  dependencies: {
    "react": "18.2.0",
    "react-native": RN_VERSION,
    "@react-navigation/native": "6.1.9",
    "@react-navigation/native-stack": "6.9.17",
    "@react-navigation/bottom-tabs": "6.5.11",
    "react-native-screens": "3.29.0",
    "react-native-safe-area-context": "4.8.2",
    "zustand": "4.4.7",
    "i18next": "23.7.16",
    "react-i18next": "14.0.0",
    "@react-native-async-storage/async-storage": "1.21.0",
    "dayjs": "1.11.10",
  },
  devDependencies: {
    "@babel/core": "7.23.7",
    "@babel/runtime": "7.23.8",
    "@babel/plugin-transform-class-static-block": "7.23.4",
    "@react-native/babel-preset": "0.73.21",
    "@react-native/metro-config": "0.73.5",
    "javascript-obfuscator": "4.1.1", // BSD-2-Clause
  },
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const ms = (t0) => Date.now() - t0;

function sh(cmd, args, cwd, extraEnv = {}) {
  return execFileSync(cmd, args, {
    cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 * 512, timeout: 0,
    env: { ...process.env, ...extraEnv },
  }).toString();
}

function parseArgs(argv) {
  const out = { hbc: 96, minify: false, obfuscate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") out.seed = argv[++i];
    else if (a === "--functions") out.functions = Number(argv[++i]);
    else if (a === "--hbc") out.hbc = Number(argv[++i]);
    else if (a === "--minify") out.minify = true;
    else if (a === "--obfuscate") out.obfuscate = true;
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--ws") out.ws = argv[++i];
    else if (a === "--verify-hermes") out.verify = argv[++i];
    else if (a === "--hermes") out.hermes = argv[++i];
    else throw new Error("unknown argument " + a);
  }
  return out;
}

function hermescFor(hbc, ws) {
  if (hbc === 96) {
    const os = platform() === "darwin" ? "osx-bin" : "linux64-bin";
    return { path: join(ws, "node_modules/react-native/sdks/hermesc", os, "hermesc"), compiler: "project-hermesc" };
  }
  if (hbc === 98 || hbc === 99) return { path: join(ROOT, "tools/hermesc", `v${hbc}`, "hermesc"), compiler: "direct-hermesc" };
  throw new Error(`--hbc ${hbc}: expected 96, 98 or 99`);
}

function findHermesVm(hbc, explicit) {
  const c = [explicit, process.env.HBC2JS_TORTURE_HERMES, join(ROOT, "tools/hermes-vm", `v${hbc}`, "bin/hermes"),
    join(ROOT, "tools/hermesc", `v${hbc}`, "hermes")];
  return c.find((p) => p && existsSync(p)) || null;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p));
  }
  return out.sort();
}

/** Run headless.js against the plain ESM sources of `srcRoot` in Node. */
function nodeTruth(ws, scratch) {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  cpSync(join(ws, "src/core"), join(scratch, "src/core"), { recursive: true });
  cpSync(join(ws, "src/junk"), join(scratch, "src/junk"), { recursive: true });
  cpSync(join(ws, "headless.js"), join(scratch, "headless.js"));
  writeFileSync(join(scratch, "package.json"), '{"type":"module"}\n');
  const out = sh(process.execPath, ["--stack-size=4000", join(scratch, "headless.js")], scratch);
  return JSON.parse(out.trim().split("\n").pop());
}

/** Top-level + method function names per core module (truth for name recovery). */
async function coreFunctionNames(ws) {
  const { parse } = await import("@babel/parser");
  const out = {};
  for (const f of listFiles(join(ws, "src/core"))) {
    const code = readFileSync(join(ws, "src/core", f), "utf8");
    const ast = parse(code, { sourceType: "module", plugins: ["classStaticBlock"] });
    const names = [];
    const walk = (n) => {
      if (!n || typeof n.type !== "string") return;
      if ((n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") && n.id) names.push(n.id.name);
      if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && n.init &&
          /Function|Arrow/.test(n.init.type)) names.push(n.id.name);
      if ((n.type === "ClassMethod" || n.type === "ObjectMethod") && n.key.type === "Identifier" && n.kind === "method") names.push(n.key.name);
      for (const k of Object.keys(n)) {
        if (k === "loc" || k === "start" || k === "end") continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") walk(v);
      }
    };
    walk(ast.program);
    out["src/core/" + f] = [...new Set(names)];
  }
  return out;
}

function bundledPackages(mapPath, ws) {
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const pkgs = new Map();
  const appModules = [];
  for (const s of map.sources || []) {
    const i = s.lastIndexOf("node_modules/");
    if (i < 0) {
      const rel = s.startsWith(ws) ? relative(ws, s) : s;
      if (!rel.startsWith("__prelude__")) appModules.push(rel);
      continue;
    }
    const rest = s.slice(i + "node_modules/".length).split("/");
    const name = rest[0].startsWith("@") ? rest[0] + "/" + rest[1] : rest[0];
    const pj = join(s.slice(0, i + "node_modules/".length), name, "package.json");
    if (!pkgs.has(name)) {
      let version = null;
      try { version = JSON.parse(readFileSync(pj, "utf8")).version; } catch {}
      pkgs.set(name, { version, modules: 0 });
    }
    pkgs.get(name).modules++;
  }
  return { packages: Object.fromEntries([...pkgs].sort(([a], [b]) => (a < b ? -1 : 1))), appModules: appModules.sort() };
}

/** Metro module id -> source path. Metro writes one `__d(...)` per module in
 *  bundle order, each ending `},<id>,[deps]);`, and its source map lists
 *  sources in that same order after the prelude + polyfills, so module k is
 *  sources[k + (sources.length - modules)]. */
export function metroModuleIds(bundleText, map, ws) {
  const lines = bundleText.split("\n");
  const starts = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith("__d(")) starts.push(i);
  const off = map.sources.length - starts.length;
  if (off < 0) throw new Error(`source map has fewer sources (${map.sources.length}) than modules (${starts.length})`);
  const ids = {};
  for (let k = 0; k < starts.length; k++) {
    const endLine = k + 1 < starts.length ? starts[k + 1] - 1 : lines.length - 1;
    let id = null;
    for (let i = endLine; i >= starts[k] && id === null; i--) {
      const m = /\},(\d+),\[[\d,]*\](?:,"[^"]*")?\);?\s*$/.exec(lines[i]);
      if (m) id = Number(m[1]);
    }
    if (id === null) throw new Error(`no module id at end of __d chunk #${k} (line ${starts[k] + 1})`);
    const s = map.sources[k + off];
    ids[id] = s.startsWith(ws) ? relative(ws, s) : s.replace(/^.*node_modules\//, "node_modules/");
  }
  return ids;
}

function ensureWorkspace(ws, timings) {
  mkdirSync(ws, { recursive: true });
  const pkg = { name: "torture-app", version: "0.0.1", private: true, ...PINS };
  const text = JSON.stringify(pkg, null, 2) + "\n";
  const stamp = join(ws, ".pins.sha256");
  const want = sha256(text);
  if (!existsSync(join(ws, "node_modules")) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== want) {
    writeFileSync(join(ws, "package.json"), text);
    const t0 = Date.now();
    sh("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", "--legacy-peer-deps"], ws);
    timings.npmInstallMs = ms(t0);
    writeFileSync(stamp, want);
  }
}

function obfuscateTree(ws) {
  const obf = join(ws, "node_modules/.bin/javascript-obfuscator");
  for (const sub of ["src/core", "src/junk"]) {
    sh(obf, [join(ws, sub), "--output", join(ws, sub),
      "--compact", "true", "--string-array", "true", "--string-array-threshold", "0.75",
      "--identifier-names-generator", "hexadecimal", "--rename-globals", "false",
      "--control-flow-flattening", "false", "--seed", "1"], ws);
  }
}

function metroBundle(ws, entry, out, minify) {
  sh(join(ws, "node_modules/.bin/react-native"), [
    "bundle", "--platform", "android", "--dev", "false", "--minify", String(minify),
    "--entry-file", entry, "--bundle-output", out, "--sourcemap-output", out + ".map", "--reset-cache",
  ], ws, { NODE_OPTIONS: "--max-old-space-size=8192" });
}

export async function build(opts) {
  const { seed, functions, hbc = 96, minify = false, obfuscate = false } = opts;
  const variant = `s${seed}-n${functions}-hbc${hbc}${minify ? "-min" : ""}${obfuscate ? "-obf" : ""}`;
  const out = opts.out || join(HERE, "out", variant);
  const ws = opts.ws || join(HERE, "out", "_ws");
  const timings = {};
  const T = Date.now();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  ensureWorkspace(ws, timings);

  // Fresh app tree in the cached workspace (node_modules kept).
  for (const f of ["src", "App.js", "index.js", "headless.js", "babel.config.js", "metro.config.js", "app.json"]) {
    rmSync(join(ws, f), { recursive: true, force: true });
  }
  for (const f of readdirSync(join(HERE, "app"))) cpSync(join(HERE, "app", f), join(ws, f), { recursive: true });
  let t0 = Date.now();
  const junk = generateJunk(seed, functions);
  for (const [rel, content] of junk.files) {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), content);
  }
  timings.generateMs = ms(t0);

  t0 = Date.now();
  const truth = nodeTruth(ws, join(out, "_truth"));
  timings.nodeTruthMs = ms(t0);
  let obfuscationCheck = null;
  if (obfuscate) {
    t0 = Date.now();
    obfuscateTree(ws);
    const after = nodeTruth(ws, join(out, "_truth"));
    timings.obfuscateMs = ms(t0);
    const diff = Object.keys(truth.junk).filter((k) => after.junk[k] !== truth.junk[k])
      .concat(Object.keys(truth.core).filter((k) => JSON.stringify(after.core[k]) !== JSON.stringify(truth.core[k])));
    obfuscationCheck = { mismatches: diff.length, sample: diff.slice(0, 10) };
  }
  rmSync(join(out, "_truth"), { recursive: true, force: true });

  t0 = Date.now();
  metroBundle(ws, "index.js", join(ws, "bundle.js"), minify);
  metroBundle(ws, "headless.js", join(ws, "headless.js.bundle"), minify);
  timings.metroMs = ms(t0);

  const hc = hermescFor(hbc, ws);
  t0 = Date.now();
  sh(hc.path, ["-emit-binary", "-O", "-output-source-map", "-out", join(ws, "bundle.hbc"), join(ws, "bundle.js")], ws);
  timings.hermescMs = ms(t0);
  sh(hc.path, ["-emit-binary", "-O", "-out", join(ws, "headless.hbc"), join(ws, "headless.js.bundle")], ws);
  sh(process.execPath, [join(ws, "node_modules/react-native/scripts/compose-source-maps.js"),
    join(ws, "bundle.js.map"), join(ws, "bundle.hbc.map"), "-o", join(out, "bundle.map")], ws);
  for (const f of ["bundle.hbc", "bundle.js", "bundle.js.map", "headless.hbc"]) cpSync(join(ws, f), join(out, f));
  if (functions <= 10000) cpSync(join(ws, "src"), join(out, "source/src"), { recursive: true });

  const { packages, appModules } = bundledPackages(join(ws, "bundle.js.map"), ws);
  const coreNames = await coreFunctionNames(ws);
  const moduleIds = metroModuleIds(readFileSync(join(ws, "bundle.js"), "utf8"),
    JSON.parse(readFileSync(join(ws, "bundle.js.map"), "utf8")), ws);
  const coreModuleOf = {};
  const coreIndexSrc = readFileSync(join(HERE, "app/src/core/index.js"), "utf8");
  for (const m of coreIndexSrc.matchAll(/'(src\/core\/[a-z]+\.js)': \[([^\]]*)\]/g)) {
    for (const n of m[2].matchAll(/'([A-Za-z]+)'/g)) coreModuleOf[n[1]] = m[1];
  }
  const manifest = {
    schema: "hbc2js-torture-manifest/1",
    variant, seed: String(seed), functionsRequested: functions,
    framework: "bare-rn", rnVersion: RN_VERSION, hbcVersion: hbc, compiler: hc.compiler,
    minify, obfuscate, obfuscationCheck,
    dependencies: { ...PINS.dependencies },
    bundledPackages: packages,
    appModules,
    moduleIds, // Metro/HBC module id -> source path (app paths relative; vendor as node_modules/...)
    core: Object.entries(truth.core).map(([name, expected]) => ({ name, module: coreModuleOf[name], expected })),
    coreFunctionNames: coreNames,
    junkModules: junk.modules,
    junk: junk.functions.map((f) => ({ ...f, expected: truth.junk[f.module + "#" + f.name] })),
    sizes: {
      bundleJs: statSync(join(out, "bundle.js")).size,
      hbc: statSync(join(out, "bundle.hbc")).size,
    },
    sha256: { "bundle.hbc": sha256(readFileSync(join(out, "bundle.hbc"))) },
    hermesVm: null,
    timings,
  };
  const missing = manifest.junk.filter((f) => typeof f.expected !== "number");
  if (missing.length) throw new Error(`${missing.length} junk entries have no Node checksum (first: ${missing[0].name})`);
  timings.totalMs = ms(T);
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  const vm = findHermesVm(hbc, opts.hermes);
  if (vm) verifyHermes(out, vm);
  return { out, manifest };
}

/** Run headless.hbc in a Hermes VM and record agreement with the Node truth. */
export function verifyHermes(out, vm) {
  out = resolve(out);
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  vm = vm || findHermesVm(manifest.hbcVersion);
  if (!vm) throw new Error("no Hermes VM found for HBC " + manifest.hbcVersion);
  const t0 = Date.now();
  const res = sh(vm, [join(out, "headless.hbc")], out);
  const line = res.trim().split("\n").pop();
  const got = JSON.parse(line);
  const mism = [];
  for (const c of manifest.core) if (JSON.stringify(got.core[c.name]) !== JSON.stringify(c.expected)) mism.push({ entry: c.name, node: c.expected, hermes: got.core[c.name] });
  for (const j of manifest.junk) if (got.junk[j.module + "#" + j.name] !== j.expected) mism.push({ entry: j.name, node: j.expected, hermes: got.junk[j.module + "#" + j.name] });
  manifest.hermesVm = { vm, ms: ms(t0), checked: manifest.core.length + manifest.junk.length, mismatches: mism.length, sample: mism.slice(0, 20) };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  return manifest.hermesVm;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.verify) { console.log(JSON.stringify(verifyHermes(a.verify, a.hermes), null, 2)); return; }
  if (a.seed === undefined || !Number.isInteger(a.functions) || a.functions < 1) {
    console.error("usage: node tools/torture/build.mjs --seed S --functions N [--hbc 96|98|99] [--minify] [--obfuscate] [--out DIR] [--ws DIR]\n" +
      "       node tools/torture/build.mjs --verify-hermes <outdir> [--hermes PATH]");
    process.exit(2);
  }
  const { out, manifest } = await build(a);
  console.log(JSON.stringify({ out, variant: manifest.variant, junkFunctions: manifest.junk.length, core: manifest.core.length,
    sizes: manifest.sizes, timings: manifest.timings, hermesVm: manifest.hermesVm, obfuscationCheck: manifest.obfuscationCheck }, null, 2));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error(String(e.stderr || "") + (e.stack || e)); process.exit(1); });
