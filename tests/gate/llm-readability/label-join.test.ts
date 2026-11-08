// Spec 28 section 7 accuracy ground truth: register-level labels JOINED to
// .hbc function ids (tools/readability/label-registers.ts). The join is one
// compiler run's -dump-ra and -dump-bytecode (same function order as the .hbc
// ids), verified per function; the proof here is against the decoded .hbc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { parseForDecompile } from "../../../src/decompile.ts";
import { decodeMappings, labelBundle, paramTokens, resolveWithMap } from "../../../tools/readability/label-registers.ts";

const HERMESC = join(repoRoot(), "tools", "hermesc", "v98", "hermesc");
const SRC = join(repoRoot(), "tests", "fixtures", "constructs", "01-if-else-chain", "source.js");

test("label-registers: IR labels join to .hbc function ids and land on the real registers", (t) => {
  if (!existsSync(HERMESC)) {
    t.skip("needs tools/hermesc/v98 (tools/get-hermesc.sh 98)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "label-join-"));
  try {
    const hbc = join(dir, "c.hbc");
    const r = spawnSync(HERMESC, ["-O", "-g", "-emit-binary", `-out=${hbc}`, SRC], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const analysis = analyseModule(parseForDecompile(readFileSync(hbc), {}).module, { strictEnv: false });
    const j = labelBundle(HERMESC, SRC);
    assert.ok(j.countsMatch, "IR and bytecode dumps must list the same number of functions");
    assert.equal(j.nameMismatches, 0);
    assert.equal(j.joined.length, analysis.module.functions.length);

    let params = 0, envLoads = 0;
    for (const f of j.joined) {
      const d = analysis.decoded(f.fn);
      assert.equal(d.name, f.name, `fn ${String(f.fn)}: joined name must be the .hbc function's name`);
      for (const l of f.labels) {
        const dest = (op: string): boolean =>
          d.instructions.some((i) => i.name === op && i.operands[0]?.role === "reg" && i.operands[0].value === l.reg);
        if (l.via === "param") {
          params += 1;
          assert.ok(dest("LoadParam"), `fn ${String(f.fn)}: param ${l.name} -> r${String(l.reg)} is not a LoadParam destination`);
        } else if (l.via === "env-load") {
          envLoads += 1;
          assert.ok(dest("LoadFromEnvironment"), `fn ${String(f.fn)}: ${l.name} -> r${String(l.reg)} is not a LoadFromEnvironment destination`);
        }
      }
    }
    assert.ok(params >= 1 && envLoads >= 1, "the fixture must exercise both a param and an environment variable label");
    const check = j.joined.find((f) => f.name === "check");
    assert.ok(check !== undefined && check.labels.some((l) => l.name === "n" && l.via === "param"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("label-registers: minified parameters resolve to original names through the source map", () => {
  // `function(e,t){return e}` at col 0; params at cols 9 and 11. Hand-encoded
  // mappings: seg(col 0 src0 l0 c0), seg(col 9 -> name 0), seg(col 11 -> name 1).
  assert.deepEqual(paramTokens("function(e,t){return e}", 0), [{ name: "e", col: 9 }, { name: "t", col: 11 }]);
  assert.deepEqual(paramTokens("x=>x", 0), [{ name: "x", col: 0 }]);
  assert.deepEqual(paramTokens("function({a},b=1,c){}", 0), [{ name: "c", col: 17 }], "destructured/defaulted params are not single bindings");
  // VLQ: AAAA = [0,0,0,0]; SAAUA = col+9, name... use known encodings.
  const segs = decodeMappings("AAAA,SAAAA,EAAAC");
  assert.deepEqual(segs[0]!.map((s) => [s[0], s[4]]), [[0, -1], [9, 0], [11, 1]]);
  const map = { sources: ["/src/a.ts"], names: ["userId", "options"], mappings: "AAAA,SAAAA,EAAAC" };
  const joined = [{ fn: 7, name: "", line: 1, col: 1, labels: [{ reg: 3, name: "e", via: "param" as const }, { reg: 4, name: "t", via: "param" as const }] }];
  const out = resolveWithMap(joined, ["function(e,t){return e}"], map);
  assert.deepEqual(out.map((o) => [o.fn, o.reg, o.name, o.source]), [[7, 3, "userId", "/src/a.ts"], [7, 4, "options", "/src/a.ts"]]);
});
