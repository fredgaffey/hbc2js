#!/usr/bin/env node
// tools/deps/sig-mismatch-probe.mjs — LB1 diagnosis probe (docs/DEPS.md
// "Why exact-version signatures miss"). For each package named in a
// deps-truth.json, puts the app's own functions for that package (every
// function transitively created by the truth modules' factories) side by
// side with the exact-version signature file's functions and with the
// scaffold baselines that were subtracted from it.
//
// Usage:
//   node tools/deps/sig-mismatch-probe.mjs <app.hbc> <deps-truth.json> <sigDbDir> [pkg ...]
//     sigDbDir: a directory of <pkg>@<ver>__hbc<N>.json files (read file by
//     file — never loaded as a DB layer, so the 27 GB v2 DB is safe here).
//     Baselines are read from <sigDbDir>/_baselines if present, else from
//     tools/pkgsig/db/_baselines.
//   Optional: --bundle <app.bundle.js> --hermesc <hermesc>  additionally
//     recompiles each package's OWN modules (cut verbatim from the app's
//     Metro bundle, plus the bundle's prelude lines) as a small standalone
//     bundle — a stand-in for the bulk scaffold build — and reports (i) how
//     much of the signature residual that small compile reproduces (high =
//     same source, the difference is compile CONTEXT) and (ii) how many of
//     the app's functions match the small compile raw vs with operand-width
//     opcode variants (GetByIdShort/GetById/GetByIdLong, *LongIndex, ...)
//     folded to one mnemonic — the LB1 fix hypothesis.
// Default package list: every truth package whose exact file exists.
// Example (rn-template-0.72, v2 DB):
//   node tools/deps/sig-mismatch-probe.mjs tests/fixtures/bundles/rn-template-0.72/truth/index.android.hbc \
//     tests/fixtures/bundles/rn-template-0.72/truth/deps-truth.json ~/.cache/hbc2js-sigdb-v2-backup \
//     --bundle tests/fixtures/bundles/rn-template-0.72/index.android.bundle --hermesc tools/hermesc/v94/hermesc
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { parseHbc } = await import(join(repo, "src/parse/module.ts"));
const { decodeFunction } = await import(join(repo, "src/disasm/decode.ts"));
const { fingerprintModule } = await import(join(repo, "src/deps/fingerprint.ts"));
const { scanModuleRegistrations } = await import(join(repo, "src/deps/dscan.ts"));
const { normaliseFunctionForSignature } = await import(join(repo, "src/deps/sig-normalise.ts"));

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const bundlePath = flag("--bundle"), hermesc = flag("--hermesc");
const [hbcPath, truthPath, dbDir, ...only] = argv;
if (!hbcPath || !truthPath || !dbDir) { console.error("usage: sig-mismatch-probe.mjs <app.hbc> <deps-truth.json> <sigDbDir> [pkg ...]"); process.exit(2); }
const truth = JSON.parse(readFileSync(truthPath, "utf8"));
const mod = parseHbc(new Uint8Array(readFileSync(hbcPath)));
const { functions } = fingerprintModule(mod, decodeFunction);
const regs = scanModuleRegistrations(mod, decodeFunction(mod, 0));
const factoryById = new Map(regs.map((r) => [String(r.moduleId), r.factoryFunctionIndex]));
const children = (i) => { const out = []; for (const insn of decodeFunction(mod, i).instructions) for (const op of insn.operands) if (op.role === "function") out.push(op.value); return out; };
const closure = (roots) => { const seen = new Set(); const st = [...roots]; while (st.length) { const i = st.pop(); if (seen.has(i)) continue; seen.add(i); st.push(...children(i)); } return [...seen]; };
const safe = (p) => p.replace("/", "__");
const blDir = existsSync(join(dbDir, "_baselines")) ? join(dbDir, "_baselines") : join(repo, "tools/pkgsig/db/_baselines");
const blCache = new Map();
const baselineHashes = (paths) => { const s = new Set(); for (const p of paths) { const f = join(blDir, p.split("/").pop()); if (!blCache.has(f)) blCache.set(f, existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).functions.map((x) => x.exactHash) : null); for (const h of blCache.get(f) ?? []) s.add(h); } return s; };
const hbcV = mod.header.version;
// Operand-width opcode variants (string/function-table index width): fold to
// one mnemonic. Jump/SaveGenerator "Long" (branch distance) is left alone.
const WIDTH = /^((?:\S+: )*)(?!Jmp|SaveGenerator)([A-Z][A-Za-z]*?)(Short|LongIndex|Long)(?= |$)/;
const sha = (t) => createHash("sha256").update(t).digest("hex").slice(0, 24);
const widthHash = (m, i) => sha(normaliseFunctionForSignature(m, decodeFunction(m, i)).split("\n").map((l) => l.replace(WIDTH, "$1$2")).join("\n"));
const bundleLines = bundlePath ? readFileSync(bundlePath, "utf8").split("\n") : null;
const prelude = bundleLines ? bundleLines.slice(0, bundleLines.findIndex((l) => l.startsWith("__d("))) : [];
function miniCompile(ids) {
  const mods = bundleLines.filter((l) => { const m = /,(\d+),\[[\d,]*\]\);?$/.exec(l); return l.startsWith("__d(") && m && ids.has(m[1]); });
  const dir = mkdtempSync(join(tmpdir(), "sigprobe-"));
  try {
    writeFileSync(join(dir, "m.js"), [...prelude, ...mods, ""].join("\n"));
    execFileSync(hermesc, ["-O", "-emit-binary", `-out=${join(dir, "m.hbc")}`, join(dir, "m.js")], { stdio: "ignore" });
    const m = parseHbc(new Uint8Array(readFileSync(join(dir, "m.hbc"))));
    return { m, fns: fingerprintModule(m, decodeFunction).functions };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const pkgs = only.length ? only : Object.keys(truth.packages);
console.log(`app=${hbcPath} hbc${hbcV}`);
console.log("pkg@ver | appFns | sigFns(raw) | app∩sig exact/fuzzy/strSet | app∩baseline exact | sigUnmatched: sameStrSet-in-app (instrΔ list)" + (bundleLines ? " || mini: sigResidualReproduced | app∩mini exact raw -> width-folded" : ""));
for (const pkg of pkgs) {
  const ver = truth.packages[pkg];
  const file = join(dbDir, `${safe(pkg)}@${ver}__hbc${hbcV}.json`);
  if (!existsSync(file)) { if (only.length) console.log(`${pkg}@${ver} | no sig file`); continue; }
  const sig = JSON.parse(readFileSync(file, "utf8"));
  const ids = Object.entries(truth.modules).filter(([, m]) => m.package === pkg).map(([id]) => id);
  const app = closure(ids.map((id) => factoryById.get(id)).filter((x) => x !== undefined)).map((i) => functions[i]);
  const sE = new Set(sig.functions.map((f) => f.exactHash)), sF = new Set(sig.functions.map((f) => f.fuzzyHash)), sS = new Set(sig.functions.map((f) => f.stringSetHash));
  const bl = baselineHashes(Array.isArray(sig.subtractedBaselines) ? sig.subtractedBaselines : []);
  const n = (pred) => app.filter(pred).length;
  const aE = new Set(app.map((f) => f.exactHash));
  const unmatched = sig.functions.filter((f) => !aE.has(f.exactHash));
  const deltas = [];
  let sameSS = 0;
  for (const f of unmatched) { const a = app.find((x) => x.stringSetHash === f.stringSetHash && f.stringCount > 1); if (a) { sameSS++; deltas.push(`${f.name || "?"}:${f.instrCount}->${a.instrCount}${a.fuzzyHash === f.fuzzyHash ? "=F" : ""}`); } }
  let tail = "";
  if (bundleLines && hermesc) {
    const mini = miniCompile(new Set(ids));
    const mE = new Set(mini.fns.map((f) => f.exactHash));
    const mW = new Set(mini.fns.map((f) => widthHash(mini.m, f.index)));
    tail = ` || ${sig.functions.filter((f) => mE.has(f.exactHash)).length}/${sig.functions.length} | ${n((f) => mE.has(f.exactHash))} -> ${n((f) => mW.has(widthHash(mod, f.index)))}`;
  }
  console.log(`${pkg}@${ver} | ${app.length} | ${sig.totalFunctions}(${sig.rawFunctionCount}) | ${n((f) => sE.has(f.exactHash))}/${n((f) => sF.has(f.fuzzyHash))}/${n((f) => sS.has(f.stringSetHash))} | ${n((f) => bl.has(f.exactHash))} | ${unmatched.length}: ${sameSS} [${deltas.slice(0, 4).join(" ")}]` + tail);
}
