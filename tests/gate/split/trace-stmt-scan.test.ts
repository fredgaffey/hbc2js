// Spec 29 section 12: segregate's register trace finds `TRACE_STMT_RE`'s
// matches through `traceStmtMatches` (anchored on `=`, sticky regex) instead
// of a global `matchAll`. The two must give the same matches, groups and
// order on any text; checked on a real decompiled bundle and on random token
// soup built from the pattern's own pieces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import { TRACE_STMT_RE, traceStmtMatches } from "../../../src/split/segregate.ts";
import { repoRoot } from "../../support/paths.ts";

const flat = (it: Iterable<RegExpExecArray | RegExpMatchArray>): string[] => Array.from(it, (m) => JSON.stringify([m.index, m[0], m.groups]));
const same = (text: string, what: string): number => {
  const want = flat(text.matchAll(TRACE_STMT_RE));
  assert.deepEqual(flat(traceStmtMatches(text)), want, what);
  return want.length;
};

void test("traceStmtMatches equals matchAll(TRACE_STMT_RE) on rn-template-0.72's decompiled text", () => {
  const code = decompile(readFileSync(join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc"))).code;
  assert.ok(same(code, "rn-template") > 1000);
});

void test("traceStmtMatches equals matchAll(TRACE_STMT_RE) on random token soup", () => {
  const pieces = ["r1", "r2", "xr3", "a0", "a12", "_e1_2", "_e3_45", "x_e1_2", "$", "obj", "Foo", "component", "name", "default", "Reflect", "apply", "require", "('./module_12.js')", "(\"./module_3.js\")",
    "=", "==", " = ", "\n", " ", "\t", ".", ";", ",", "(", ")", "[", "]", "{", "}", "'", "\"", "3", "17", "null", ":", " : null", "{ A: null, B: null }", "{}", " ", "é", "[0]", "['default']", "[r2]"];
  // One instance of every alternative, plus near relatives.
  const stmts = ["r1 = require('./module_4.js');", "r2 = a0;", "r3 = r2[4];", "r3 = a1[r2];", "r2 = 7;", "r4 = { Home: null, Settings: null };", "r4 = {};", "r5 = 'Home';", "r6.component = r7(r8).default;",
    "r9 = Reflect.apply(r1, r2, [r3]);", "r1 = r2(r3);", "r1.Home = r2;", "r1 = r2['default'];", "r1 = r2.default;", "r3 = _e1_2; r4.name = r3;", "_e2_3 = r1;", "r1 = _e4_5;", "r1 .x\n= r2 ;", "x.y.z = q;", "a = b = c;", "r1 == r2;"];
  let seed = 12345;
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let total = 0;
  for (let t = 0; t < 3000; t++) {
    let s = "";
    const len = 5 + rnd(60);
    for (let i = 0; i < len; i++) s += rnd(3) === 0 ? stmts[rnd(stmts.length)] : pieces[rnd(pieces.length)];
    // Damage: drop or duplicate one character, so near-misses are covered.
    if (s.length > 2 && rnd(2) === 0) { const at = rnd(s.length); s = rnd(2) === 0 ? s.slice(0, at) + s.slice(at + 1) : s.slice(0, at) + s[at] + s.slice(at); }
    total += same(s, `soup #${t}: ${JSON.stringify(s)}`);
  }
  assert.ok(total > 500, `only ${total} matches in the soup`);
});
