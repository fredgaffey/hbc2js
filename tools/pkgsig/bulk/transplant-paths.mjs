#!/usr/bin/env node
// tools/pkgsig/bulk/transplant-paths.mjs — add module paths v1
// (docs/PACKAGE-SIGNATURES.md §7) to an EXISTING signature file without
// changing anything else in it: re-install and re-bundle the package in a
// scaffold slot with a Metro source map, compile with the file's hermesc,
// fingerprint, and copy each module's path onto the old file's module with
// the same id and factory hash (or the unique module with that factory
// hash), and each function's module id likewise. Unmatched modules keep
// `path: null` (neutral = scored as own, as before). Written only when at
// most half the modules are unmatched (dependency drift since the original
// build).
//
//   R=<repo> node transplant-paths.mjs <file> <slotDir> <srcDb> <outDir>
//
// <file> is a basename `<pkg>@<version>__hbc<N>.json` in <srcDb>; the
// slot must be the scaffold of that hbc version's RN family (worker.sh).
// Prints one JSON line (ok, modules, modMiss, functions, fnMiss).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const R = process.env.R;
const { pipedOpts, runInstall } = await import(R + "/tools/pkgsig/bulk/install-plan.mjs");
const { decodeFunction } = await import(R + "/src/disasm/decode.ts");
const { parseHbc } = await import(R + "/src/parse/module.ts");
const { fingerprintModule } = await import(R + "/src/deps/fingerprint.ts");
const { attachModulePaths, modulePathsFromSourceMap, MODULE_PATHS_VERSION } = await import(R + "/src/deps/module-paths.ts");
const [file, slotArg, srcDb, outDir] = process.argv.slice(2); const slot = (await import("node:path")).resolve(slotArg);
const hbcVersion = /__hbc(\d+)\.json$/.exec(file)[1];
const base = file.slice(0, file.lastIndexOf("__hbc"));
const at = base.lastIndexOf("@");
const pkg = base.slice(0, at).replace(/^(@[^/]*?)__/, "$1/"), version = base.slice(at + 1);
const res = { file, ok: false };
const work = mkdtempSync(join(tmpdir(), "sigpaths-")); process.env.TMPDIR = work;
const entry = join(slot, `__sigpaths_entry__.js`);
try {
  runInstall(`${pkg}@${version}`, (cmd, argv) => execFileSync(cmd, argv, pipedOpts({ cwd: slot, timeout: 240_000 })));
  writeFileSync(entry, `const X = require(${JSON.stringify(pkg)});\nmodule.exports = X;\n`);
  const js = join(work, "out.bundle"), map = join(work, "out.bundle.map"), hbc = join(work, "out.hbc");
  execFileSync("npx", ["react-native", "bundle", "--platform", "android", "--dev", "false", "--minify", "true", "--max-workers", "1", "--reset-cache", "--entry-file", entry, "--bundle-output", js, "--sourcemap-output", map, "--assets-dest", join(work, "assets")], pipedOpts({ cwd: slot, timeout: 240_000 }));
  execFileSync(join(R, `tools/hermesc/v${hbcVersion}/hermesc`), ["-O", "-emit-binary", `-out=${hbc}`, js], pipedOpts({ timeout: 120_000 }));
  const mod = parseHbc(new Uint8Array(readFileSync(hbc)));
  const fp = fingerprintModule(mod, decodeFunction);
  const fresh = attachModulePaths(mod, decodeFunction, fp.functions, fp.modules, modulePathsFromSourceMap(JSON.parse(readFileSync(map, "utf8")), readFileSync(js, "utf8")));
  const old = JSON.parse(readFileSync(join(srcDb, file), "utf8"));
  const freshById = new Map(fresh.modules.map((m) => [m.localModuleId, m]));
  const freshByHash = new Map();
  for (const m of fresh.modules) if (m.factoryExactHash) freshByHash.set(m.factoryExactHash, freshByHash.has(m.factoryExactHash) ? null : m);
  const idMap = new Map(); // fresh module id -> old module id
  let modMiss = 0;
  const modules = old.modules.map((m) => {
    let f = freshById.get(m.localModuleId);
    if (!f || f.factoryExactHash !== m.factoryExactHash) f = m.factoryExactHash ? freshByHash.get(m.factoryExactHash) ?? null : null;
    if (!f) { modMiss++; return { ...m, path: null }; }
    idMap.set(f.localModuleId, m.localModuleId);
    return { ...m, path: f.path ?? null };
  });
  const freshFnByIndex = new Map(fresh.functions.map((f) => [f.index, f]));
  const freshFnByHash = new Map();
  for (const f of fresh.functions) if (f.moduleId !== undefined) freshFnByHash.set(f.exactHash, freshFnByHash.has(f.exactHash) && freshFnByHash.get(f.exactHash) !== f.moduleId ? null : f.moduleId);
  let fnMiss = 0;
  const functions = old.functions.map((f) => {
    const g = freshFnByIndex.get(f.index);
    let mid = g && g.exactHash === f.exactHash ? g.moduleId : freshFnByHash.get(f.exactHash);
    mid = mid === undefined || mid === null ? undefined : idMap.get(mid);
    if (mid === undefined) { fnMiss++; const { moduleId: _x, ...rest } = f; return rest; }
    return { ...f, moduleId: mid };
  });
  Object.assign(res, { modules: old.modules.length, modMiss, functions: old.functions.length, fnMiss });
  if (old.modules.length > 0 && modMiss / old.modules.length <= 0.5) {
    writeFileSync(join(outDir, file), JSON.stringify({ ...old, modulePaths: MODULE_PATHS_VERSION, functions, modules }));
    res.ok = true;
  } else res.reason = "too many unmatched modules";
} catch (e) {
  res.reason = (String(e?.message ?? e).slice(0, 200) + " :: " + String(e?.stderr ?? "").slice(-400));
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(entry, { force: true });
  try { execFileSync("npm", ["uninstall", pkg, "--ignore-scripts", "--no-save", "--no-audit", "--no-fund"], { cwd: slot, stdio: "ignore", timeout: 120_000 }); } catch {}
}
console.log(JSON.stringify(res));
