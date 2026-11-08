// BUGS 2026-09-11 (metrics cluster) "decompileFunction re-parses per call":
// a caller that loops over functions passes one `prepareModule()` result so
// parse + analysis are paid once, and output is byte-identical to the
// re-parsing path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompileFunction, prepareModule } from "../../../src/decompile.ts";

function fixture(): Uint8Array {
  const dir = join(repoRoot(), "tests", "fixtures", "constructs", "01-if-else-chain");
  const f = readdirSync(dir).filter((n) => /^v\d+\.hbc$/.test(n)).sort().pop()!;
  return new Uint8Array(readFileSync(join(dir, f)));
}

test("prepared module is parsed once and reused across decompileFunction calls", () => {
  const bytes = fixture();
  const prepared = prepareModule(bytes, { strictEnv: false });
  const n = prepared.module.functions.length;
  assert.ok(n > 1);
  for (let fn = 0; fn < n; fn++) {
    const reused = decompileFunction(bytes, fn, { strictEnv: false, prepared });
    const fresh = decompileFunction(bytes, fn, { strictEnv: false });
    assert.equal(reused.module, prepared.module, "no re-parse");
    assert.notEqual(fresh.module, prepared.module);
    assert.equal(reused.code, fresh.code, `fn#${String(fn)} output identical`);
  }
});
