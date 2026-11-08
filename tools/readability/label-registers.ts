#!/usr/bin/env node
// tools/readability/label-registers.ts -- reproducible register-level ground
// truth from the compiler itself. `hermesc -O -g -dump-ra <src.js>` prints the
// register-allocated IR; the IR still carries the AUTHOR'S names for (a)
// parameters (`LoadParamInst ... %userId`) and (b) variables kept in an
// environment (`[%VS0.sessionToken]` on Load/StoreFrameInst). The register
// printed beside such an instruction (`{r3}`) is a register that holds that
// named value, which is exactly a register-level label.
//
// SCOPE (honest): purely register-allocated temporaries (SSA values that never
// touch an environment or a parameter) have no name in any artifact the
// compiler emits, so this tool cannot label them. And the dump's function
// order is NOT the .hbc function-id order for a whole -O bundle (held-out
// app: 9,058 IR functions vs 15,551 bytecode functions, anonymous function
// names empty), so joining labels to bundle function ids needs a separate
// stable key; this tool labels per IR function and is exact for a single
// source file compiled without -O reordering (the construct fixtures).
//
// Usage: node tools/readability/label-registers.ts <hermesc> <source.js>
import { spawnSync } from "node:child_process";

export interface RegLabel {
  readonly reg: number;
  readonly name: string;
  readonly via: "param" | "env-store" | "env-load";
}
export interface IrFunction {
  /** Position in the dump (0 = the global function). */
  readonly index: number;
  readonly name: string;
  readonly labels: readonly RegLabel[];
}

/** Parse `-dump-ra` text. Pure. */
export function parseRaDump(text: string): IrFunction[] {
  const out: IrFunction[] = [];
  let cur: { name: string; labels: RegLabel[] } | null = null;
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const f = /^function (.*?)\(/.exec(line);
    if (f !== null) {
      cur = { name: f[1]!.replace(/^"|"$/g, ""), labels: [] };
      seen.clear();
      out.push({ index: out.length, name: cur.name, labels: cur.labels });
      continue;
    }
    if (cur === null) continue;
    const add = (reg: string, name: string, via: RegLabel["via"]): void => {
      const k = `${reg}:${name}`;
      if (seen.has(k)) return;
      seen.add(k);
      cur!.labels.push({ reg: Number(reg), name, via });
    };
    let m = /^\s*\{r(\d+)\}\s+%\d+ = LoadParamInst .*%([A-Za-z_$][\w$]*):/.exec(line);
    if (m !== null) { add(m[1]!, m[2]!, "param"); continue; }
    m = /^\s*\{r(\d+)\}\s+%\d+ = LoadFrameInst .*\[%VS\d+\.([A-Za-z_$][\w$]*)\]/.exec(line);
    if (m !== null) { add(m[1]!, m[2]!, "env-load"); continue; }
    m = /StoreFrameInst \{r\d+\} %\d+: environment, \{r(\d+)\} %\d+: [^,]*, \[%VS\d+\.([A-Za-z_$][\w$]*)\]/.exec(line);
    if (m !== null) add(m[1]!, m[2]!, "env-store");
  }
  return out;
}

function main(): void {
  const [hermesc, src] = process.argv.slice(2);
  if (hermesc === undefined || src === undefined) {
    process.stderr.write("usage: label-registers.ts <hermesc> <source.js>\n");
    process.exit(2);
  }
  const r = spawnSync(hermesc, ["-O", "-g", "-dump-ra", src], { encoding: "utf8", maxBuffer: 1 << 30 });
  process.stdout.write(`${JSON.stringify(parseRaDump(r.stdout), null, 2)}\n`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main();
