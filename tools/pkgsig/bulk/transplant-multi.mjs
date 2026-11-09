#!/usr/bin/env node
// tools/pkgsig/bulk/transplant-multi.mjs — the batched form of
// transplant-paths.mjs (docs/PACKAGE-SIGNATURES.md §7 "Rebuilding a DB with
// paths"): install and Metro-bundle ONE package@version in a scaffold slot
// (with a source map), then for each of its signature files compile that
// bundle with the file's hermesc, fingerprint, and transplant module paths
// v1 onto the old file (transplant-lib.mjs `transplantPaths`). A file is
// written only when at most half its modules are unmatched.
//
//   R=<repo> node --experimental-strip-types transplant-multi.mjs <slotDir> <srcDb> <outDir> <file>...
//   R=<repo> node transplant-multi.mjs --plan <srcDb> <outDir>
//
// Every <file> must be the same package@version and the slot the scaffold
// of their RN family (FAMILY_OF_HBC). Prints one JSON line per file (ok,
// modules, modMiss, functions, fnMiss | reason). --plan prints one job per
// line, `<family> <pkg@ver> <file>...`, for the files of <srcDb> not yet in
// <outDir> (rebuild-paths.sh feeds these to xargs).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { planJobs, runBundleJob, transplantPaths } from "./transplant-lib.mjs";

if (process.argv[2] === "--plan") {
  const [srcDb, outDir] = process.argv.slice(3);
  const done = new Set(existsSync(outDir) ? readdirSync(outDir) : []);
  for (const j of planJobs(readdirSync(srcDb), done)) console.log(`${j.family} ${j.pkgVer} ${j.files.join(" ")}`);
  process.exit(0);
}

const R = resolve(process.env.R ?? join(import.meta.dirname, "../../.."));
const { pipedOpts, runInstall } = await import(join(R, "tools/pkgsig/bulk/install-plan.mjs"));
const { decodeFunction } = await import(join(R, "src/disasm/decode.ts"));
const { parseHbc } = await import(join(R, "src/parse/module.ts"));
const { fingerprintModule } = await import(join(R, "src/deps/fingerprint.ts"));
const { attachModulePaths, modulePathsFromSourceMap, MODULE_PATHS_VERSION } = await import(join(R, "src/deps/module-paths.ts"));
const { BUILDER_METRO_CONFIG_NAME, builderConfigArgs, builderMetroConfigJs, bundleEnv, missingPeers, peerInstallArgv, unresolvedBareModule } = await import(join(R, "src/deps/builder-support.ts"));
const installedPeers = [];
const [slotArg, srcDb, outDir, ...files] = process.argv.slice(2);
const slot = resolve(slotArg);
const base = files[0].slice(0, files[0].lastIndexOf("__hbc"));
const at = base.lastIndexOf("@");
const pkg = base.slice(0, at).replace(/^(@[^/]*?)__/, "$1/"), version = base.slice(at + 1);
const entry = join(slot, "__sigpaths_entry__.js");
const results = runBundleJob(files, {
  install() {
    runInstall(`${pkg}@${version}`, (cmd, argv) => execFileSync(cmd, argv, pipedOpts({ cwd: slot, timeout: 300_000 })));
    // BUILDFAIL1(a): peers still absent after the (possibly legacy) install.
    try {
      const pj = JSON.parse(readFileSync(join(slot, "node_modules", ...pkg.split("/"), "package.json"), "utf8"));
      const peers = missingPeers(pj, (n) => existsSync(join(slot, "node_modules", ...n.split("/"), "package.json")));
      if (peers.length > 0) {
        execFileSync("npm", peerInstallArgv(`${pkg}@${version}`, peers), pipedOpts({ cwd: slot, timeout: 300_000 }));
        installedPeers.push(...peers.map((p) => p.name));
      }
    } catch {
      // best effort; the bundle then fails as before
    }
    writeFileSync(join(slot, BUILDER_METRO_CONFIG_NAME), builderMetroConfigJs());
    writeFileSync(entry, `const X = require(${JSON.stringify(pkg)});\nmodule.exports = X;\n`);
  },
  bundle(work) {
    process.env.TMPDIR = work;
    const js = join(work, "out.bundle"), map = join(work, "out.bundle.map");
    mkdirSync(join(work, "assets"), { recursive: true });
    // BUILDFAIL1(a2): an unresolved bare module is installed (target repeated) and the bundle retried, <= 3 rounds.
    for (let round = 0; ; round++) try {
      execFileSync("npx", ["react-native", "bundle", ...builderConfigArgs(slot), "--platform", "android", "--dev", "false", "--minify", "true", "--max-workers", "1", "--reset-cache", "--entry-file", entry, "--bundle-output", js, "--sourcemap-output", map, "--assets-dest", join(work, "assets")], pipedOpts({ cwd: slot, timeout: 300_000, env: bundleEnv() }));
      break;
    } catch (e) {
      const miss = round < 3 ? unresolvedBareModule(`${e?.stderr ?? ""}${e?.message ?? ""}`) : null;
      if (miss !== null && !existsSync(join(slot, "node_modules", ...miss.split("/"), "package.json"))) {
        try {
          execFileSync("npm", peerInstallArgv(`${pkg}@${version}`, [...installedPeers.map((name) => ({ name, range: "*" })), { name: miss, range: "latest" }]), pipedOpts({ cwd: slot, timeout: 300_000 }));
          installedPeers.push(miss);
          continue;
        } catch {}
      }
      throw e;
    }
    return { js, sourceMap: JSON.parse(readFileSync(map, "utf8")), jsText: readFileSync(js, "utf8") };
  },
  perFile(file, work, { js, sourceMap, jsText }) {
    const hbcVersion = /__hbc(\d+)\.json$/.exec(file)[1];
    const hbc = join(work, `out${hbcVersion}.hbc`);
    execFileSync(join(R, `tools/hermesc/v${hbcVersion}/hermesc`), ["-O", "-emit-binary", `-out=${hbc}`, js], pipedOpts({ timeout: 120_000 }));
    const mod = parseHbc(new Uint8Array(readFileSync(hbc)));
    const fp = fingerprintModule(mod, decodeFunction);
    const fresh = attachModulePaths(mod, decodeFunction, fp.functions, fp.modules, modulePathsFromSourceMap(sourceMap, jsText));
    const old = JSON.parse(readFileSync(join(srcDb, file), "utf8"));
    const t = transplantPaths(old, fresh);
    const res = { modules: old.modules.length, modMiss: t.modMiss, functions: old.functions.length, fnMiss: t.fnMiss };
    if (t.ok) {
      writeFileSync(join(outDir, file), JSON.stringify({ ...old, modulePaths: MODULE_PATHS_VERSION, functions: t.functions, modules: t.modules }));
      res.ok = true;
    } else res.reason = "too many unmatched modules";
    return res;
  },
  cleanup() {
    rmSync(entry, { force: true });
    try { execFileSync("npm", ["uninstall", pkg, ...installedPeers, "--ignore-scripts", "--no-save", "--no-audit", "--no-fund"], { cwd: slot, stdio: "ignore", timeout: 120_000 }); } catch {}
  },
});
for (const r of results) console.log(JSON.stringify(r));
