#!/usr/bin/env node
// Print one emitted function of a sweep's decompiled.js, from the line before
// its `// fn#N` marker, for triage:  node tools/sweep/show.mjs <decompiled.js> <fn> [lines=60] [grep]
import { readFileSync } from "node:fs";
const [file, fn, n = "60", pat] = process.argv.slice(2);
const lines = readFileSync(file, "utf8").split("\n");
const i = lines.findIndex((l) => new RegExp(`// fn#${fn}\\b`).test(l));
if (i < 0) { console.error(`fn#${fn} not found`); process.exit(1); }
const out = lines.slice(Math.max(0, i - 1), i - 1 + Number(n)).map((l, k) => `${i + k}: ${l}`);
console.log((pat ? out.filter((l, k) => k < 3 || new RegExp(pat).test(l)) : out).join("\n"));
