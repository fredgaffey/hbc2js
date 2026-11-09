#!/usr/bin/env node
// tools/pkgsig/bulk/population-corpus.mjs — population source (c) for
// population-closure.mjs: npm-package-name-shaped strings in the string
// tables of real-world Hermes bundles. Holdout apps (the measured truth
// apps) are excluded by id substring and never opened.
//
// Kept: scoped names (`@scope/name`) and unscoped names containing `-`
// (plain words like `default` are too common to mean anything). Output:
// { apps: [ids], excluded: [ids], names: { name: appCount } }.
//
// Usage (needs `unzip`; the repo's src/ is loaded as TypeScript):
//   node --experimental-strip-types tools/pkgsig/bulk/population-corpus.mjs
//     --apk-dir <dir> [--exclude <substr>]... --out <json>

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCOPED = /^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/;
const DASHED = /^[a-z0-9][a-z0-9._~]*-[a-z0-9._~-]*[a-z0-9]$/;

/** Package-name-shaped strings of one string list (deduplicated). */
export function nameStrings(strings) {
  const out = new Set();
  for (const s of strings) if (s.length <= 214 && (SCOPED.test(s) || DASHED.test(s))) out.add(s);
  return out;
}

async function main() {
  const a = process.argv.slice(2);
  let dir = null, out = null; const exclude = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--apk-dir") dir = a[++i];
    else if (a[i] === "--exclude") exclude.push(a[++i]);
    else if (a[i] === "--out") out = a[++i];
    else throw new Error(`unknown argument ${a[i]}`);
  }
  if (!dir || !out) throw new Error("need --apk-dir and --out");
  const { parseHbc } = await import(new URL("../../../src/parse/module.ts", import.meta.url).href);
  const counts = new Map(); const apps = [], excluded = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".apk")).sort()) {
    if (exclude.some((e) => f.includes(e))) { excluded.push(f); continue; }
    const apk = join(dir, f);
    const entries = execFileSync("unzip", ["-Z1", apk], { maxBuffer: 1 << 28 }).toString().split("\n").filter((e) => /^assets\/.*\.(bundle|hbc)$/.test(e));
    const names = new Set();
    for (const e of entries) {
      const bytes = execFileSync("unzip", ["-p", apk, e], { maxBuffer: 1 << 30 });
      if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0x03bc1fc6) continue; // HBC magic, low word
      try {
        const m = parseHbc(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length));
        const list = []; for (let i = 0; i < m.strings.count; i++) list.push(m.strings.get(i));
        for (const n of nameStrings(list)) names.add(n);
      } catch (err) { console.error(`${f} ${e}: ${err.message}`); }
    }
    if (!entries.length) console.error(`${f}: no bundle`);
    apps.push(f);
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    console.error(`${f}: ${names.size} names`);
  }
  writeFileSync(out, JSON.stringify({ apps, excluded, names: Object.fromEntries([...counts].sort()) }));
  console.log(`apps=${apps.length} excluded=${excluded.length} names=${counts.size}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
