// Per-live-range ("web") binding identity -- docs/RENAME.md "What a name is
// keyed to", docs/specs/passes/19-reg-split.md section 11. reg-split already
// renders each disjoint live range of a reused register as its own binding
// (`r1`, `r1_3`, ...), but the overlay, the nameable denominator and the
// readability targets were keyed by REGISTER, so one name had to fit every
// web (the "r4 is the require function, then StyleSheet" abstentions). These
// tests pin the web-keyed identity `{fn, reg, web}` (key `reg:F:R:W`) and that
// legacy `{fn, reg}` overlays still apply exactly as before.
//
// Fixtures 96-99 (constructs/9[6-9]-reg-reuse-*) are the construct fixtures for
// this item; the structural guards run at every compiled version.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { decompile, parseForDecompile } from "../../../src/decompile.ts";
import { bindingKey, NameService, OverlayStore, parseKey, regId, shortForm } from "../../../src/name-overlay/index.ts";
import { rawFrameBodies, rawFrames } from "../../../src/name-overlay/frames.ts";
import { registerIdent } from "../../../src/name-overlay/id.ts";
import { renderFrame } from "../../../src/name-overlay/render.ts";
import { astPassHook } from "../../../src/passes/index.ts";
import { nameableIndex } from "../../../src/readability/nameable.ts";
import { parseReadabilityResult } from "../../../src/readability/types.ts";
import { collectTargets } from "../../../tools/readability/record.ts";
import { hbcVsJsUnderHermes } from "../../../src/harness/hbc-equiv.ts";
import { TRACE_VERDICT } from "../../../src/harness/compare.ts";

const DIR = join(repoRoot(), "tests", "fixtures", "constructs");
const VERSIONS = ["v84", "v94", "v96", "v98", "v99"] as const;
// Fixture 96 at v99: fn 3 (`setup`) gives r1 to three unrelated values:
// `load("styles")` (web 1, `r1`), the `makeSheet(...)` result (web 2, `r1_2`,
// which var-naming renders `apply`) and `sheet.width + sheet.height` (web 3,
// `r1_3`). Under the whole-register identity all three had to share a name.
const F96 = join(DIR, "96-reg-reuse-straight", "v99.hbc");
const SETUP = 3;

function analysisOf(path: string): ReturnType<typeof analyseModule> {
  return analyseModule(parseForDecompile(readFileSync(path), {}).module, { strictEnv: false });
}

function renderSetup(webNames: ReadonlyMap<string, { name: string }>, names: ReadonlyMap<number, { name: string }> = new Map()): string {
  const analysis = analysisOf(F96);
  const frame = rawFrames(analysis, { strictEnv: false }).get(SETUP)!;
  return renderFrame(astPassHook(analysis), frame.node, frame.cfg, names, { webNames }).code;
}

test("web identity: reg:F:R:W key, parse round trip, short form, rendered ident", () => {
  const id = regId(3, 1, 3);
  assert.equal(bindingKey(id), "reg:3:1:3");
  assert.deepEqual(parseKey("reg:3:1:3"), id);
  assert.equal(shortForm(id), "{3,1,3}");
  assert.equal(registerIdent(id), "r1_3");
  assert.equal(registerIdent(regId(3, 1, 1)), "r1");
  // A legacy whole-register key is unchanged and carries no web.
  assert.equal(bindingKey(regId(3, 1)), "reg:3:1");
  assert.deepEqual(parseKey("reg:3:1"), { kind: "reg", fn: 3, reg: 1 });
  assert.equal(registerIdent(regId(3, 1)), "r1");
});

test("web identity: nameable bindings list each bound web of a split register, not the register", () => {
  const idx = nameableIndex(analysisOf(F96), { strictEnv: false });
  const keys = idx.bindings(SETUP).map((b) => bindingKey(b));
  assert.ok(keys.includes("reg:3:1:1"), keys.join(" "));
  assert.ok(keys.includes("reg:3:1:3"), keys.join(" "));
  assert.ok(!keys.includes("reg:3:1"), "a split register is asked about per web");
  // r1_2 is printed as `apply` (var-naming): not a literal identifier of the
  // body the model sees, so it is not requested (readability-id-match).
  assert.ok(!keys.includes("reg:3:1:2"), keys.join(" "));
  assert.ok(!keys.includes("reg:3:1:4"), "a web that does not exist is not a binding");
  assert.ok(idx.of(SETUP).includes(1), "of() still lists registers");
});

test("web identity: a web-keyed name renames only that live range", () => {
  const code = renderSetup(new Map([["r1_3", { name: "total" }]]));
  assert.match(code, /let total = apply\.width \+ apply\.height;/);
  assert.match(code, /return total;/);
  assert.match(code, /let r1 = a1\("styles"\);/, "web 1 keeps its own (unnamed) binding");
  assert.doesNotMatch(code, /r1_3/);
});

test("web identity: legacy {fn,reg} overlays still name the whole register", () => {
  // Applied before reg-split, as before this item: one name for every web
  // (and, as before, an overlay-named register is protected from inlining).
  const code = renderSetup(new Map(), new Map([[1, { name: "mod" }]]));
  assert.match(code, /let mod = a1;/);
  assert.match(code, /mod = mod\("styles"\);/);
  assert.doesNotMatch(code, /\br1(_\d+)?\b/);
});

test("web identity: readability targets are per web for a split register", () => {
  const analysis = analysisOf(F96);
  const frames = rawFrameBodies(analysis, { strictEnv: false });
  const targets = collectTargets(analysis, frames, new OverlayStore(), new Set([SETUP]), nameableIndex(analysis, { strictEnv: false }));
  const keys = targets.map((t) => bindingKey(regId(t.fn, t.reg, t.web)));
  assert.ok(keys.includes("reg:3:1:3"), keys.join(" "));
  assert.ok(!keys.includes("reg:3:1"), keys.join(" "));
});

test("web identity: the wire bindingId may carry a web", () => {
  const r = parseReadabilityResult('{"names":[{"bindingId":{"fn":3,"reg":1,"web":3},"name":"total","confidence":"med","evidence":"sum of sheet sides"}]}');
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(bindingKey(r.result.names[0]!.bindingId), "reg:3:1:3");
});

test("web identity: NameService sets, gates and renders a web-keyed name", () => {
  const svc = new NameService(analysisOf(F96), new OverlayStore());
  const ok = svc.setName(regId(SETUP, 1, 3), "total", { confidence: "med", evidence: "sum of sides", source: "human" });
  assert.ok(ok.ok, JSON.stringify(ok));
  const missing = svc.setName(regId(SETUP, 1, 7), "gone", { confidence: "med", evidence: "x", source: "human" });
  assert.ok(!missing.ok);
  const code = svc.render({ fn: SETUP }).code;
  assert.match(code, /return total;/);
  assert.match(code, /let r1 = a1\("styles"\);/);
});

// --- structural guards, every compiled version ------------------------------

function fnSource(dir: string, v: string, name: string): string | null {
  const path = join(DIR, dir, `${v}.hbc`);
  if (!existsSync(path)) return null;
  const code = decompile(readFileSync(path), { strictEnv: false }).code;
  const start = code.search(new RegExp(`fn#\\d+ "${name}"`));
  assert.ok(start >= 0, `${dir}/${v}: no fn "${name}"`);
  const end = code.indexOf("\n    }\n", start);
  return code.slice(start, end < 0 ? undefined : end);
}

test("web identity guard: an if/else merge keeps both arm defs in ONE binding (fixture 97)", () => {
  for (const v of VERSIONS) {
    const src = fnSource("97-reg-reuse-if-merge", v, "pick");
    if (src === null) continue;
    const m = /"v=" \+ (\w+)/.exec(src);
    assert.ok(m !== null, `${v}: no "v=" print`);
    const x = m[1]!;
    assert.match(src, new RegExp(`\\b${x} = \\w+ \\* \\w+;`), `${v}: then-arm def is not ${x}`);
    assert.match(src, new RegExp(`\\b${x} = \\w+ \\+ \\w+;`), `${v}: else-arm def is not ${x}`);
  }
});

test("web identity guard: a loop-carried value stays one binding (fixture 98)", () => {
  for (const v of VERSIONS) {
    const src = fnSource("98-reg-reuse-loop-carried", v, "sumTo");
    if (src === null) continue;
    const m = /"acc " \+ (\w+)/.exec(src);
    assert.ok(m !== null, `${v}: no "acc" print`);
    const body = /do \{([\s\S]*?)\} while/.exec(src);
    assert.ok(body !== null, `${v}: no do-while`);
    assert.match(body[1]!, new RegExp(`\\b${m[1]!} = `), `${v}: ${m[1]!} is not the loop-carried binding`);
  }
});

test("web identity guard: a closure-observed variable is never split (fixture 99)", () => {
  for (const v of VERSIONS) {
    const src = fnSource("99-reg-reuse-closure-captured", v, "counter");
    if (src === null) continue;
    assert.doesNotMatch(src, /\b_e\d+_\d+_\d+\b/, `${v}: an environment slot was split`);
  }
});

test("web identity: naming every web keeps fixtures 96-99 equivalent under the real VM, every version", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "hbc2js-web-"));
  let checked = 0, named = 0;
  try {
    for (const dir of ["96-reg-reuse-straight", "97-reg-reuse-if-merge", "98-reg-reuse-loop-carried", "99-reg-reuse-closure-captured"]) {
      for (const v of VERSIONS) {
        const hbc = join(DIR, dir, `${v}.hbc`);
        if (!existsSync(hbc)) continue;
        const analysis = analysisOf(hbc);
        const idx = nameableIndex(analysis, { strictEnv: false });
        const svc = new NameService(analysis, new OverlayStore(), { strictEnv: false });
        for (let fn = 0; fn < analysis.module.functions.length; fn++) {
          for (const b of idx.bindings(fn)) {
            if (b.web === undefined) continue;
            const r = svc.setName(b, `web_${String(b.reg)}_${String(b.web)}`, { confidence: "med", evidence: "test", source: "human" });
            if (r.ok) named += 1;
          }
        }
        const js = join(tmp, `${dir}.${v}.js`);
        writeFileSync(js, svc.render().code);
        const res = hbcVsJsUnderHermes(hbc, js);
        if (res.verdict === TRACE_VERDICT.INCONCLUSIVE && res.vm === undefined) {
          t.diagnostic(`${dir}/${v}: no VM (${res.why})`);
          continue;
        }
        assert.equal(res.verdict, TRACE_VERDICT.EQUIVALENT, `${dir}/${v}: ${res.why}`);
        checked += 1;
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  assert.ok(named > 0, "no web was named");
  t.diagnostic(`${String(checked)} renders equivalent, ${String(named)} webs named`);
});
