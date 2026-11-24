#!/usr/bin/env node
// tools/copy-build-assets.mjs — `tsc` only emits `.ts` -> `.js`/`.d.ts`; a
// couple of modules read a sibling non-TS asset at runtime via
// `import.meta.url` (src/projdb/db.ts's `schema.sql`, src/deps/db.ts's
// `sigdb-schema.sql`). Without this, `dist/cli.js` — the packaged
// `bin: hbc2js` entry point — fails on first use of any `hbcproj`/`deps`
// command with an ENOENT for the missing `.sql` file (found via
// docs/specs/18-project-storage-integrity.md §11's CI `hbcproj verify
// --full` smoke step, .github/workflows/ci.yml, which is the first thing
// to exercise a *built* `dist/cli.js` against a real project rather than
// `src/cli.ts` directly). Run as an `npm run build` post-step.
//
// Every non-TS file under src/ is copied (not a hand-kept list: the list
// missed export/offline-babel-transformer.cjs and ui-core/presets/*.json in
// 0.1.2, breaking `equiv --boot` and keymap presets from the npm package).
// Skipped: `.gitkeep` placeholders and `.md` notes. `--out <dir>` copies into
// another tree (tests/gate/release/npm-runtime.test.ts uses it).
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outIdx = process.argv.indexOf("--out");
const outRoot = outIdx >= 0 ? process.argv[outIdx + 1] : join(repoRoot, "dist");

/** @param {string} rel @returns {boolean} */
export function isBuildAsset(rel) {
  return !rel.endsWith(".ts") && !rel.endsWith(".md") && !rel.endsWith("/.gitkeep") && rel !== ".gitkeep";
}

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const srcRoot = join(repoRoot, "src");
for (const abs of walk(srcRoot, [])) {
  const rel = relative(srcRoot, abs).split("\\").join("/");
  if (!isBuildAsset(rel)) continue;
  const dest = join(outRoot, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(abs, dest);
  process.stdout.write(`copy-build-assets: src/${rel} -> ${dest}\n`);
}
