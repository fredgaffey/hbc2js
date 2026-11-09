// rebuild-paths.sh slot acquisition: more concurrent jobs than slots must
// WAIT for a slot, never log NOSLOT and skip (db-v4-paths rebuild lost
// ~13k of 71k files that way when slots == xargs -P). Uses a stub TOOL.
// Needs flock (Linux, util-linux); skipped where it is absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hasFlock = spawnSync("flock", ["--version"]).status === 0;

test("rebuild-paths.sh: jobs outnumbering slots wait for a slot instead of NOSLOT-skipping", { skip: !hasFlock && "flock not installed" }, () => {
  const d = mkdtempSync(join(tmpdir(), "noslot-"));
  const src = join(d, "src"), out = join(d, "out"), sc = join(d, "sc");
  for (const x of [src, join(sc, "ScaffoldRN87"), join(sc, "ScaffoldRN72")]) mkdirSync(x, { recursive: true });
  const jobs = 24;
  for (let i = 0; i < jobs; i++) writeFileSync(join(src, `p${i}@1.0.0__hbc99.json`), "{}");
  const stub = join(d, "stub.sh");
  writeFileSync(stub, `#!/usr/bin/env bash
if [ "$1" = --plan ]; then for f in $(ls "$2"); do echo "87 \${f%%__*} $f"; done; exit 0; fi
slot=$1; src=$2; out=$3; shift 3; mkdir -p "$out"
(sleep 2 >/dev/null 2>&1 &) # lingering worker outliving the job, like a Metro worker
sleep 0.3; for f in "$@"; do cp "$src/$f" "$out/$f"; echo "{\\"file\\":\\"$f\\",\\"ok\\":true}"; done
`);
  chmodSync(stub, 0o755);
  // node-run wrapper: the driver invokes `node --experimental-strip-types $TOOL ...`
  const wrap = join(d, "stub.mjs");
  writeFileSync(wrap, `import { spawn, spawnSync } from "node:child_process";
const r = spawnSync(${JSON.stringify(stub)}, process.argv.slice(2), { stdio: "inherit" }); process.exit(r.status ?? 1);
`);
  const r = spawnSync("bash", [join(import.meta.dirname, "../../../tools/pkgsig/bulk/rebuild-paths.sh"), "3"], {
    env: { ...process.env, SRC: src, OUT: out, SCAFFOLDS: sc, TOOL: wrap, SLOT_POLL: "0.1", MIN_FREE_GB: "0" },
    encoding: "utf8",
  });
  const log = readFileSync(`${out}.log`, "utf8");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/NOSLOT/.test(log), `NOSLOT logged:\n${log.split("\n").filter((l) => /NOSLOT/.test(l)).length} lines`);
  assert.equal(readdirSync(out).length, jobs, "every job ran");
});

test("rebuild-paths.sh: a slot timeout is logged as NOSLOT and the file stays out of OUT for the resume pass", { skip: !hasFlock && "flock not installed" }, () => {
  const d = mkdtempSync(join(tmpdir(), "noslot-"));
  const src = join(d, "src"), out = join(d, "out"), sc = join(d, "sc");
  for (const x of [src, join(sc, "ScaffoldRN87"), join(sc, "ScaffoldRN72")]) mkdirSync(x, { recursive: true });
  for (let i = 0; i < 4; i++) writeFileSync(join(src, `p${i}@1.0.0__hbc99.json`), "{}");
  const wrap = join(d, "stub.mjs");
  writeFileSync(wrap, `import { readdirSync, copyFileSync, mkdirSync } from "node:fs";
const [a, b, c, ...rest] = process.argv.slice(2);
if (a === "--plan") { for (const f of readdirSync(b)) console.log("87 " + f.split("__")[0] + " " + f); process.exit(0); }
mkdirSync(c, { recursive: true });
for (const f of rest) { copyFileSync(b + "/" + f, c + "/" + f); console.log(JSON.stringify({ file: f, ok: true })); }
`);
  mkdirSync(join(`${out}-work`, "locks"), { recursive: true });
  const holder = spawn("flock", [join(`${out}-work`, "locks", "87-1.lock"), "sleep", "6"], { stdio: "ignore" });
  spawnSync("sleep", ["0.5"]);
  spawnSync("bash", [join(import.meta.dirname, "../../../tools/pkgsig/bulk/rebuild-paths.sh"), "1"], {
    env: { ...process.env, SRC: src, OUT: out, SCAFFOLDS: sc, TOOL: wrap, SLOT_POLL: "0.1", SLOT_TIMEOUT: "1", MIN_FREE_GB: "0" },
    encoding: "utf8",
  });
  holder.kill();
  const log = readFileSync(`${out}.log`, "utf8");
  assert.match(log, /NOSLOT .*retried on re-run/);
  const failed = readFileSync(`${out}.failed.txt`, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(failed.length, 4, "files without output are listed as failed");
});
