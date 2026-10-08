#!/usr/bin/env node
// tools/e2e/export-build.mjs — docs/specs/29-export.md §0's finish line, run
// by hand (never from a gate/sweep test — this installs from npm and is
// explicitly out-of-gate, same convention as tools/e2e/boot-split.mjs).
//
//   node tools/e2e/export-build.mjs <bundle.hbc> [--out <dir>] [--skip-install]
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const cli = join(repoRoot, "src", "cli.ts");

function parseArgs(argv) {
  let bundle;
  let out;
  let skipInstall = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i];
    else if (a === "--skip-install") skipInstall = true;
    else if (!a.startsWith("-") && bundle === undefined) bundle = a;
  }
  return { bundle, out, skipInstall };
}

function run(label, cmd, args, cwd) {
  process.stderr.write(`export-build: ${label} -- ${cmd} ${args.join(" ")}\n`);
  const start = Date.now();
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  const wallMs = Date.now() - start;
  process.stderr.write(`export-build: ${label} -- exit ${r.status} in ${wallMs}ms\n`);
  return { status: r.status, wallMs };
}

function main() {
  const { bundle, out, skipInstall } = parseArgs(process.argv.slice(2));
  if (bundle === undefined || !existsSync(bundle)) {
    process.stderr.write("usage: export-build.mjs <bundle.hbc> [--out <dir>] [--skip-install]\n");
    process.exit(2);
  }
  const outDir = out ?? mkdtempSync(join(tmpdir(), "hbc2js-export-build-"));

  const exportRun = run("export", process.execPath, [cli, "export", bundle, "--out", outDir, "--overwrite"], repoRoot);
  if (exportRun.status !== 0) process.exit(exportRun.status ?? 1);

  if (skipInstall) {
    process.stderr.write(`export-build: --skip-install given; tree written to ${outDir}, stopping before npm install\n`);
    return;
  }

  const install = run("npm install", "npm", ["install"], outDir);
  if (install.status !== 0) process.exit(install.status ?? 1);

  const bundleOut = join(outDir, "android.bundle");
  const bundleRun = run(
    "react-native bundle",
    "npx",
    ["react-native", "bundle", "--entry-file", "index.js", "--platform", "android", "--dev", "false", "--bundle-output", bundleOut],
    outDir,
  );
  process.stderr.write(
    `export-build: summary -- export ${exportRun.wallMs}ms, npm install ${install.wallMs}ms, ` +
      `react-native bundle ${bundleRun.wallMs}ms (exit ${bundleRun.status}), tree at ${outDir}\n`,
  );
  process.exit(bundleRun.status ?? 1);
}

main();
