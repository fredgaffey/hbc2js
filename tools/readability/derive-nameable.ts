#!/usr/bin/env node
// tools/readability/derive-nameable.ts -- write `<app>.nameable.json`
// ({fn: [reg,...]}) for every function a recording requested, so the gate can
// compute section 7 coverage over the NAMEABLE denominator without analysing
// the bundle. Usage: node tools/readability/derive-nameable.ts <in.hbc> <recording.json> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyseModule } from "../../src/cfg/index.ts";
import { parseForDecompile } from "../../src/decompile.ts";
import { nameableMember } from "../../src/readability/measure.ts";
import { nameableIndex } from "../../src/readability/nameable.ts";
import type { Recording } from "../../src/workers/backends/replay.ts";

function main(): void {
  const [hbc, rec, out] = process.argv.slice(2);
  if (hbc === undefined || rec === undefined || out === undefined) {
    process.stderr.write("usage: derive-nameable.ts <in.hbc> <recording.json> <out.json>\n");
    process.exit(2);
  }
  const recording = JSON.parse(readFileSync(rec, "utf8")) as Recording;
  const fns = [...new Set(Object.values(recording).flatMap((e) => (e.meta === undefined ? [] : [e.meta.fn])))].sort((a, b) => a - b);
  const idx = nameableIndex(analyseModule(parseForDecompile(readFileSync(hbc), {}).module, { strictEnv: false }), { strictEnv: false });
  // Per BINDING (docs/RENAME.md): a whole register as its number, a reg-split
  // live range as "R:W".
  const map: Record<string, readonly (number | string)[]> = {};
  for (const fn of fns) map[String(fn)] = idx.bindings(fn).map((b) => (b.web === undefined ? b.reg : nameableMember(b)));
  writeFileSync(out, `${JSON.stringify(map)}\n`);
}
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main();
