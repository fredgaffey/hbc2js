#!/usr/bin/env node
// tools/app-fuzz/rebuild-repro.mjs <repro-dir> <out-dir> [ws] — rebuild a kept
// repro's minimal app (same plan + config) into <out-dir> and export it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "../torture/build.mjs";
import { emitShapes } from "./gen-shapes.mjs";
const [dir, out, ws = "/tmp/hbc2js/app-fuzz/ws"] = process.argv.slice(2);
const r = JSON.parse(readFileSync(join(dir, "repro.json"), "utf8"));
const c = r.cfg;
await build({ seed: c.seed, functions: r.plan.length, hbc: c.hbc, minify: c.minify, obfuscate: c.obfuscate, headlessOnly: c.headlessOnly, out, ws, generate: () => emitShapes(r.plan, "repro") });
console.log(out);
