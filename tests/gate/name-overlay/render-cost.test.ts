// Readability render cost (docs/READABILITY.md "Render cost"): a render that
// needs one function must not re-emit the module. `RenderOptions.onEmit` is the
// instrumented counter; `wholeModule: true` is the reference path (the old
// full re-emit + slice) the scoped path must equal byte-for-byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { parseForDecompile } from "../../../src/decompile.ts";
import { NameService, OverlayStore, regId } from "../../../src/name-overlay/index.ts";
import { rawFrames, rawFramesFor } from "../../../src/name-overlay/frames.ts";

const DIR = join(repoRoot(), "tests", "fixtures", "constructs");
const F96 = join(DIR, "96-reg-reuse-straight", "v99.hbc");

function analysisOf(path: string): ReturnType<typeof analyseModule> {
  return analyseModule(parseForDecompile(readFileSync(path), {}).module, { strictEnv: false });
}

test("render-cost: render({fn}) after a rename in fn Y does not re-emit unrelated functions", () => {
  const analysis = analysisOf(F96);
  const svc = new NameService(analysis, new OverlayStore(), { strictEnv: false });
  const frames = rawFrames(analysis, { strictEnv: false });
  const all: number[] = [];
  svc.render({ wholeModule: true, onEmit: (f) => all.push(f) });
  assert.ok(all.length >= 3, `fixture should have several functions, got ${all.length}`);
  // Y = a function with a nameable register that is NOT fn 3; X = fn 3.
  const X = 3;
  const Y = [...frames.keys()].find((f) => f !== X && f !== 0 && !all.includes(-1) && svc.setName(regId(f, 1), "renamedInY", { confidence: "med", evidence: "t", source: "human" }).ok);
  const emitted: number[] = [];
  const r = svc.render({ fn: X, onEmit: (f) => emitted.push(f) });
  assert.ok(emitted.includes(X));
  assert.ok(emitted.length < all.length, `scoped render emitted ${emitted.length} of ${all.length} functions`);
  if (Y !== undefined) assert.ok(!emitted.includes(Y) || Y === X, `unrelated fn ${Y} was re-emitted`);
  assert.equal(r.code, svc.render({ fn: X, wholeModule: true }).code);
});

test("render-cost: scoped render is byte-identical to the whole-module slice (construct fixtures, with and without names)", () => {
  const dirs = readdirSync(DIR).filter((d) => /^\d\d-/.test(d)).slice(0, 40);
  let compared = 0;
  for (const d of dirs) {
    const p = join(DIR, d, "v99.hbc");
    if (!existsSync(p)) continue;
    const analysis = analysisOf(p);
    const store = new OverlayStore();
    const svc = new NameService(analysis, store, { strictEnv: false });
    for (const named of [false, true]) {
      if (named) {
        for (const [f] of rawFrames(analysis, { strictEnv: false })) svc.setName(regId(f, 1), `n${f}`, { confidence: "med", evidence: "t", source: "human" });
      }
      const n = analysis.module.functions.length;
      for (let f = 0; f < Math.min(n, 12); f++) {
        const scoped = svc.render({ fn: f });
        const whole = svc.render({ fn: f, wholeModule: true });
        assert.equal(scoped.code, whole.code, `${d} fn ${f} named=${named}`);
        assert.deepEqual(scoped.collisions, whole.collisions, `${d} fn ${f} collisions`);
        compared++;
      }
    }
  }
  assert.ok(compared > 100, `compared ${compared}`);
});

test("render-cost: rawFramesFor(fn) captures the same raw frame as the whole-module rawFrames", () => {
  const dirs = readdirSync(DIR).filter((d) => /^\d\d-/.test(d)).slice(0, 25);
  let compared = 0;
  for (const d of dirs) {
    const p = join(DIR, d, "v99.hbc");
    if (!existsSync(p)) continue;
    const analysis = analysisOf(p);
    const whole = rawFrames(analysis, { strictEnv: false });
    for (const [f, frame] of whole) {
      if (f >= 12) continue;
      const one = rawFramesFor(analysis, f, { strictEnv: false }).get(f);
      assert.ok(one !== undefined, `${d} fn ${f}`);
      assert.equal(JSON.stringify(one.node), JSON.stringify(frame.node), `${d} fn ${f}`);
      compared++;
    }
  }
  assert.ok(compared > 50, `compared ${compared}`);
});
