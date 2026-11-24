#!/usr/bin/env node
// tools/app-fuzz/gen-shapes.mjs — decompiler-hostile code generator for the
// app fuzzer (tools/app-fuzz/README.md). Drop-in replacement for
// tools/torture/gen-junk.mjs (same output contract: files under src/junk/,
// src/junk/_rt.js with mix/seedList/entryArg, src/junk/index.js
// JUNK_MODULES; every exported function takes one int and returns a uint32
// checksum), so tools/torture/build.mjs (truth in Node, Metro, hermesc
// 96/98/99, minify/obfuscate) and score.mjs's child loader are reused as is.
//
// Weighted toward the shapes most likely to break a decompiler: random
// nested control flow (try/catch/finally in loops and switches, labelled
// break/continue, returns from finally, throws as control flow, no-return
// helper calls), generators with yield in try/finally, closures capturing
// loop variables, classes with private/static members and static blocks,
// getters/setters, optional chaining/calls, destructuring defaults, spread,
// numeric/string edge cases, constant-foldable expressions, large functions
// with many live locals, deep nesting.
//
// A function is a list of "parts" {t: template, k: key}; each part draws
// from its own PRNG stream (seed, function index, part index), so dropping a
// part during minimisation leaves the others byte-identical.
//
// Safety: pure in-memory computation only (no I/O, eval, Function, timers,
// native modules, dynamic import). Every loop has a constant bound, every
// throw is caught inside the same function, recursion depth is constant.
// Engine-neutral by construction: no `this` in plain calls, no arguments
// aliasing, no error-message text, no Function#name/toString, no
// transcendental Math, no locale/Intl, no writes to frozen objects (Metro
// module bodies are sloppy in Hermes, Node ESM is strict).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { makeRng } from "../appgen/lib/prng.mjs";

export const RT_SOURCE = `// Shared runtime for generated shape modules (pure).
export function mix(h, v) {
  return Math.imul((h ^ (v | 0)) >>> 0, 16777619) >>> 0;
}
export function entryArg(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul((h ^ name.charCodeAt(i)) >>> 0, 16777619) >>> 0;
  return (h % 1000) + 1;
}
export function seedList(x, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((x * (i + 3) + i * i) % 97);
  return out;
}
export function sh(s) {
  s = String(s);
  let h = 7;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 31) >>> 0;
  return h;
}
export class Fail {
  constructor(v) { this.v = v; }
}
export function fail(v) {
  throw new Fail(v);
}
`;

/** Mirrors RT_SOURCE's entryArg for harnesses. */
export function entryArg(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul((h ^ name.charCodeAt(i)) >>> 0, 16777619) >>> 0;
  return (h % 1000) + 1;
}

const ind = (s, pad) => s.split("\n").map((l) => (l ? pad + l : l)).join("\n");

// ---------------------------------------------------------------- cfg mix --
// Random structured control flow with a context stack so every break /
// continue / throw is legal and terminates.
function cfgGen(r, s, { maxDepth, budget, yields = false }) {
  let n = 0;
  let left = budget;
  const v = () => `${["x", "h", "c" + s + "_0"][r.int(3)]}`;
  const cond = () => {
    const a = v();
    switch (r.int(7)) {
      case 0: return `(${a} & ${1 + r.int(7)}) === ${r.int(3)}`;
      case 1: return `${a} % ${2 + r.int(5)} > ${r.int(3)}`;
      case 2: return `(${a} ^ ${r.int(64)}) < ${r.int(500)}`;
      case 3: return `!(${a} & 1) || ${a} > ${r.int(900)}`;
      case 4: return `${a} >>> ${r.int(4)} & 1`;
      case 5: return `(o${s}?.k ?? ${r.int(9)}) > ${r.int(9)}`;
      default: return `${a} !== ${r.int(5)} && (${a} | 0) % 3 !== 1`;
    }
  };
  const expr = () => {
    const a = v();
    switch (r.int(8)) {
      case 0: return `${a} * ${1 + r.int(13)} + ${r.int(100)}`;
      case 1: return `(${a} << ${r.int(5)}) ^ (${a} >>> ${1 + r.int(3)})`;
      case 2: return `${cond()} ? ${r.int(99)} : ${a} - ${r.int(7)}`;
      case 3: return `(o${s}.k++, o${s}.k + ${a})`;
      case 4: return `o${s}?.m?.(${a}) ?? ${r.int(9)}`;
      case 5: return `~${a} & 0xffff`;
      case 6: return `${a} % ${2 + r.int(9)} - ${r.int(4)}`;
      default: return `(${a} | 0) + (c${s}_0 = c${s}_0 + 1 | 0)`;
    }
  };
  // ctx: {loops: [{label, isSwitch}], catches: n, inFinally}
  function stmts(ctx, depth, count) {
    const out = [];
    for (let i = 0; i < count && left > 0; i++) out.push(stmt(ctx, depth));
    return out.join("\n");
  }
  function jumps(ctx) {
    const opts = [];
    const loops = ctx.loops.filter((l) => !l.isSwitch);
    if (ctx.loops.some((l) => !l.block)) opts.push("break;");
    if (loops.length) opts.push("continue;");
    for (const l of ctx.loops) if (l.label) opts.push(`break ${l.label};`);
    for (const l of loops) if (l.label) opts.push(`continue ${l.label};`);
    if (ctx.catches > 0) { opts.push(`throw new Fail(${expr()});`); opts.push(`fail(${r.int(50)});`); }
    if (r.int(4) === 0) opts.push("return h >>> 0;");
    return opts;
  }
  function stmt(ctx, depth) {
    left--;
    const k = depth >= maxDepth ? (yields && r.int(3) === 0 ? 10 : 0) : r.int(11);
    const id = n++;
    const L = r.int(4) === 0 ? `L${s}_${id}` : null;
    switch (k) {
      case 1: case 2: { // if / else with a jump
        const j = jumps(ctx);
        const th = j.length && r.int(2) ? `h = mix(h, ${expr()});\n${r.pick(j)}` : stmts(ctx, depth + 1, 1 + r.int(2));
        const el = r.int(2) ? ` else {\n${ind(stmts(ctx, depth + 1, 1 + r.int(2)), "  ")}\n}` : "";
        return `if (${cond()}) {\n${ind(th, "  ")}\n}${el}`;
      }
      case 3: { // for
        const iv = `i${s}_${id}`;
        const inner = { ...ctx, loops: [...ctx.loops, { label: L }] };
        const body = stmts(inner, depth + 1, 1 + r.int(3));
        return `${L ? L + ": " : ""}for (let ${iv} = 0; ${iv} < ${1 + r.int(5)}; ${iv}++) {\nh = mix(h, ${iv});\n${ind(body, "  ")}\n}`.replace("\nh = mix", "\n  h = mix");
      }
      case 4: { // while / do-while with counter first
        const cv = `w${s}_${id}`;
        const inner = { ...ctx, loops: [...ctx.loops, { label: L }] };
        const body = stmts(inner, depth + 1, 1 + r.int(3));
        const bound = 1 + r.int(4);
        return r.int(2)
          ? `let ${cv} = 0;\n${L ? L + ": " : ""}while (${cv} < ${bound}) {\n  ${cv}++;\n${ind(body, "  ")}\n}`
          : `let ${cv} = 0;\n${L ? L + ": " : ""}do {\n  ${cv}++;\n${ind(body, "  ")}\n} while (${cv} < ${bound});`;
      }
      case 5: case 6: { // try / catch / finally
        const form = r.int(3); // 0 catch, 1 finally, 2 both
        const tryCtx = { ...ctx, catches: ctx.catches + (form !== 1 ? 1 : 0) };
        let t = `try {\n${ind(stmts(tryCtx, depth + 1, 1 + r.int(3)), "  ")}\n}`;
        if (form !== 1) {
          const bind = r.int(4) === 0 ? "" : ` (e${s}_${id})`;
          const use = bind ? `h = mix(h, e${s}_${id} instanceof Fail ? e${s}_${id}.v : ${r.int(9)});\n` : `h = mix(h, ${r.int(77)});\n`;
          t += ` catch${bind} {\n${ind(use + stmts(ctx, depth + 1, r.int(2)), "  ")}\n}`;
        }
        if (form !== 0) t += ` finally {\n${ind(`h = mix(h, ${expr()});\n` + stmts({ ...ctx, inFinally: true }, depth + 1, r.int(2)), "  ")}\n}`;
        return t;
      }
      case 7: { // switch with fallthrough
        const inner = { ...ctx, loops: [...ctx.loops, { label: L, isSwitch: true }] };
        const nc = 2 + r.int(4);
        const cases = [];
        const strs = r.int(3) === 0;
        for (let c = 0; c < nc; c++) {
          const lab = strs ? `'k${c}'` : String(c);
          const body = stmts(inner, depth + 1, 1 + r.int(2));
          const braced = r.int(3) !== 0;
          cases.push(`case ${lab}:${braced ? " {" : ""}\n${ind(body, "  ")}${r.int(3) ? "\n  break;" : ""}${braced ? "\n}" : ""}`);
        }
        if (r.int(2)) cases.splice(r.int(cases.length), 0, `default:\n  h = mix(h, ${r.int(1000)});`);
        const disc = strs ? `'k' + (${v()} % ${nc + 1})` : `${v()} % ${nc + 1}`;
        return `${L ? L + ": " : ""}switch (${disc}) {\n${ind(cases.join("\n"), "  ")}\n}`;
      }
      case 8: { // labelled block
        const lb = `B${s}_${id}`;
        const inner = { ...ctx, loops: [...ctx.loops, { label: lb, isSwitch: true, block: true }] };
        return `${lb}: {\n  if (${cond()}) break ${lb};\n${ind(stmts(inner, depth + 1, 1 + r.int(2)), "  ")}\n}`;
      }
      case 9: { // ternary / logical assignment chain
        return `c${s}_0 ||= ${r.int(5)};\nc${s}_0 &&= ${expr()};\no${s}.z ??= ${r.int(9)};\nh = mix(h, ${cond()} ? (${cond()} ? ${expr()} : ${r.int(9)}) : ${expr()});`;
      }
      case 10: { // closure capturing the current state (or a yield in generator mode)
        if (yields && r.int(2)) return r.int(3) ? `h = mix(h, (yield ${expr()}) ?? ${r.int(9)});` : `yield* [${r.int(9)}, h & 255];`;
        return `fs${s}.push(((q) => () => q + c${s}_0)(${expr()}));`;
      }
      default:
        return `h = mix(h, ${expr()});`;
    }
  }
  const head = `let c${s}_0 = x & 7;\nconst o${s} = { k: x % 5, z: null, m: (q) => q * 3 + 1 };\nconst fs${s} = [];`;
  const body = stmts({ loops: [], catches: 0, inFinally: false }, 0, 2 + r.int(3));
  // Wrap: one function-level try/catch so a throw escaping a try/finally is still caught.
  return `${head}\ntry {\n${ind(body, "  ")}\n} catch (e${s}) {\n  h = mix(h, e${s} instanceof Fail ? e${s}.v + 1 : 3);\n}\nfor (const f of fs${s}) h = mix(h, f());`;
}

// ---------------------------------------------------------------- templates --
// Each returns { pre?: module-level code, body: statements updating h from x }.
export const TEMPLATES = {
  cfg: (r, s) => ({ body: cfgGen(r, s, { maxDepth: 3 + r.int(2), budget: 8 + r.int(14) }) }),
  cfgDeep: (r, s) => ({ body: cfgGen(r, s, { maxDepth: 6 + r.int(3), budget: 20 + r.int(25) }) }),

  tryLoop: (r, s) => ({ body: `for (let i = 0; i < ${3 + r.int(4)}; i++) {
  try {
    if (i === ${r.int(3)}) continue;
    if ((x + i) % ${2 + r.int(4)} === 0) throw new Fail(i * ${1 + r.int(9)});
    if (i > ${2 + r.int(3)}) break;
    h = mix(h, i + x);
  } catch (e) {
    h = mix(h, e.v);
    ${r.int(2) ? "continue;" : "h ^= 1;"}
  } finally {
    h = mix(h, ${r.int(100)} + i);
  }
}` }),

  finallyReturn: (r, s) => ({
    pre: `function fr${s}(a, log) {
  try {
    if (a & 1) return a * ${1 + r.int(5)};
    if (a % 3 === 0) throw new Fail(a);
    log.push(a);
  } catch (e) {
    log.push(-e.v);
    return e.v + ${r.int(9)};
  } finally {
    log.push(${r.int(50)});
    ${r.int(2) ? `if (a > ${r.int(500)}) return ${r.int(1000)};` : ""}
  }
  return log.length;
}`,
    body: `{
  const log = [];
  for (let k = 0; k < 4; k++) h = mix(h, fr${s}(x + k, log));
  for (const v of log) h = mix(h, v);
}` }),

  labelled: (r, s) => ({ body: `outer${s}: for (let a = 0; a < ${2 + r.int(4)}; a++) {
  inner${s}: for (let b = 0; b < ${2 + r.int(4)}; b++) {
    if ((a * b + x) % ${3 + r.int(4)} === 0) continue outer${s};
    if (b > a + ${r.int(3)}) break inner${s};
    if (a + b > ${4 + r.int(4)}) break outer${s};
    h = mix(h, a * 10 + b);
  }
  h = mix(h, a);
}
blk${s}: {
  if (x % 2) break blk${s};
  h = mix(h, ${r.int(1000)});
}` }),

  generator: (r, s) => ({
    pre: `function* g${s}(n, log) {
  try {
    for (let i = 0; i < n; i++) {
      try {
        const got = yield i * ${1 + r.int(7)};
        if (got === ${r.int(4)}) throw new Fail(i);
        log.push(got === undefined ? -1 : got);
      } finally {
        log.push(100 + i);
      }
    }
    yield* [${r.int(9)}, ${r.int(9)}];
    return n;
  } catch (e) {
    log.push(e instanceof Fail ? e.v : -9);
    return -n;
  } finally {
    log.push(999);
  }
}`,
    body: `{
  const log = [];
  for (const v of g${s}(${3 + r.int(3)}, log)) { h = mix(h, v); if (v > ${5 + r.int(20)}) break; }
  const it = g${s}(4, log);
  let st = it.next();
  let k = 0;
  while (!st.done && k < 10) { st = it.next(k++); h = mix(h, st.value ?? 7); }
  const it2 = g${s}(3, log);
  it2.next();
  h = mix(h, it2.return(${r.int(50)}).value);
  const it3 = g${s}(3, log);
  it3.next();
  try { h = mix(h, it3.throw(new Fail(${r.int(30)})).value ?? 1); } catch (e) { h = mix(h, 2); }
  for (const v of log) h = mix(h, v);
}` }),

  asyncPrefix: (r, s) => ({
    pre: `async function a${s}(n, log) {
  for (let i = 0; i < n; i++) {
    try {
      if (i === ${r.int(3)}) throw new Fail(i);
      log.push(i);
    } catch (e) {
      log.push(-e.v - 1);
    } finally {
      log.push(50);
    }
  }
  await null;
  log.push(777);
  return n;
}`,
    body: `{
  const log = [];
  a${s}(${2 + r.int(4)}, log);
  for (const v of log) h = mix(h, v);
}` }),

  closures: (r, s) => ({ body: `{
  const fl = [];
  for (let i = 0; i < ${3 + r.int(3)}; i++) fl.push(() => i * ${1 + r.int(9)} + x);
  var acc${s} = [];
  for (var j${s} = 0; j${s} < 3; j${s}++) acc${s}.push(() => j${s});
  let w = 0;
  while (w < 3) { const c = w * w; fl.push(() => c); w++; }
  for (const k of [${r.int(5)}, ${r.int(5)}]) fl.push(() => k + w);
  let shared = x;
  const inc = () => ++shared, get = () => shared;
  inc(); inc();
  fl.push(get);
  for (const f of fl.concat(acc${s})) h = mix(h, f());
}` }),

  classes: (r, s) => ({
    pre: `class Base${s} {
  #p = ${r.int(50)};
  static #count = 0;
  static made = [];
  static { Base${s}.made.push(${r.int(9)}); }
  constructor(v) { this.v = v; Base${s}.#count++; }
  #twice(q) { return q * 2 + this.#p; }
  get dbl() { return this.#twice(this.v); }
  set dbl(q) { this.v = q >> 1; }
  static count() { return Base${s}.#count; }
  static has(o) { return #p in o; }
  step(k) { this.#p += k; return this.#p; }
}
class Sub${s} extends Base${s} {
  static extra = ${r.int(100)};
  constructor(v, w) { super(v + w); this.w = w; }
  step(k) { return super.step(k + this.w) + ${r.int(5)}; }
  get dbl() { return super.dbl + 1; }
}`,
    body: `{
  const a = new Base${s}(x % 17), b = new Sub${s}(x % 5, ${1 + r.int(4)});
  h = mix(h, a.dbl); a.dbl = 40; h = mix(h, a.v);
  h = mix(h, b.dbl); h = mix(h, b.step(3)); h = mix(h, a.step(2));
  h = mix(h, Base${s}.count() + Sub${s}.extra + Base${s}.made.length);
  h = mix(h, (Base${s}.has(b) ? 1 : 0) + (Base${s}.has({}) ? 2 : 0));
  h = mix(h, b instanceof Base${s} ? 5 : 6);
}` }),

  optional: (r, s) => ({ body: `{
  const objs = [null, undefined, { a: { b: ${r.int(9)}, f: (q) => q + 1 } }, { a: null }, { a: { b: 0, f: null } }];
  for (const o of objs) {
    h = mix(h, o?.a?.b ?? ${r.int(20)});
    h = mix(h, o?.a?.f?.(x) ?? -1);
    h = mix(h, o?.["a"]?.b === undefined ? 1 : 2);
    const arr = o ? [o] : null;
    h = mix(h, arr?.[0]?.a?.b ?? 3);
  }
  let z = null;
  z ??= x; z ||= 1; z &&= z + ${r.int(9)};
  h = mix(h, z);
}` }),

  destructure: (r, s) => ({
    pre: `function d${s}({ a = ${r.int(9)}, b: { c = 2, ...rest } = {}, ...others } = {}, [p, , q = p + 1, ...tail] = [], n = q * 2) {
  return a + c + Object.keys(rest).length * 10 + Object.keys(others).length * 100 + (p | 0) + q + tail.length + n;
}`,
    body: `{
  h = mix(h, d${s}());
  h = mix(h, d${s}({ a: x }, [1, 2]));
  h = mix(h, d${s}({ b: { c: x, d: 1, e: 2 }, z: 1 }, [3, 4, undefined, 5, 6], ${r.int(9)}));
  let cnt = 0;
  const { u = ++cnt, v = ++cnt } = { u: x };
  h = mix(h, u + v * 10 + cnt);
  let m1 = 1, m2 = 2;
  [m1, m2] = [m2, m1 + x];
  h = mix(h, m1 * 3 + m2);
}` }),

  spread: (r, s) => ({ body: `{
  const base = [x % 7, ${r.int(9)}, ${r.int(9)}];
  const more = [...base, ...'ab\\u{1F600}', ...new Set([1, 1, 2])];
  h = mix(h, more.length);
  h = mix(h, Math.max(...base, ${r.int(9)}) + Math.min(...base));
  const o1 = { a: 1, b: 2, [\`k\${x % 3}\`]: 3 };
  const o2 = { ...o1, b: x, ...null, ...(x & 1 ? { c: 4 } : {}) };
  for (const k in o2) h = mix(h, o2[k] + k.length);
  const fn = (...args) => args.reduce((p, q) => p * 3 + (typeof q === 'string' ? q.length : q), 0);
  h = mix(h, fn(...base, ...[x]));
}` }),

  exceptions: (r, s) => ({
    pre: `function deep${s}(n) {
  if (n <= 0) fail(${r.int(99)});
  try {
    return deep${s}(n - 1) + 1;
  } finally {
    if (n === ${1 + r.int(3)}) { /* swallow nothing */ }
  }
}
function rethrow${s}(v) {
  try {
    if (v & 1) throw new Fail(v);
    return v;
  } catch (e) {
    if (e.v % 3 === 0) throw new Fail(e.v + 1);
    return -e.v;
  }
}`,
    body: `{
  try { h = mix(h, deep${s}(${1 + r.int(4)})); } catch (e) { h = mix(h, e.v); }
  for (let i = 0; i < 6; i++) {
    try { h = mix(h, rethrow${s}(x + i)); } catch (e) { h = mix(h, e.v * 2); }
  }
  try { try { fail(1); } finally { h = mix(h, 9); } } catch { h = mix(h, 11); }
  try { try { fail(2); } catch (e) { fail(e.v + 5); } } catch (e) { h = mix(h, e.v); }
}` }),

  noReturn: (r, s) => ({
    pre: `function nr${s}(a) {
  if (a < 0) fail(a);
  for (;;) {
    if (a > ${5 + r.int(20)}) return a;
    a += ${1 + r.int(7)};
  }
}
function pick${s}(a) {
  switch (a % 4) {
    case 0: return 1;
    case 1: return 2;
    case 2: fail(3);
    default: fail(4);
  }
}`,
    body: `for (let i = 0; i < 6; i++) {
  try { h = mix(h, nr${s}(x - ${r.int(3)} * i)); h = mix(h, pick${s}(x + i)); } catch (e) { h = mix(h, e.v); }
}
while (true) { if (h & 1 || h > 0) break; h = 1; }` }),

  numbers: (r, s) => ({ body: `{
  const vals = [0, -0, NaN, Infinity, -Infinity, 2 ** 53, 2 ** 53 + 1, -1, 0x7fffffff, -0x80000000, 4294967295, 0.5, -7.5, 1e21, ${r.int(1000)} / 7];
  for (const v of vals) {
    h = mix(h, (v | 0) + (v >>> 0) + (v >> ${r.int(5)}));
    h = mix(h, Object.is(v, -0) ? 1 : 0);
    h = mix(h, v === v ? 2 : 3);
    h = mix(h, Math.trunc(v % ${2 + r.int(5)}) | 0);
    h = mix(h, Math.sign(v) * 3 + (Number.isInteger(v) ? 1 : 0));
  }
  h = mix(h, 1 / -0 < 0 ? 5 : 6);
  h = mix(h, (-x % 7) + (x % -7));
  h = mix(h, parseInt('0x1f') + parseInt('${r.int(99)}px', 10) + Number('  12  ') + (+'1e3'));
  h = mix(h, sh((x * 1.5).toString(36)) + sh((x / 3).toFixed(4)) + sh(String(0.1 + 0.2)));
  h = mix(h, Math.clz32(x) + Math.imul(x, 0x9e3779b1) + (x ** 2 % 1000));
}` }),

  strings: (r, s) => ({ body: `{
  const s1 = 'a\\u00e9\\u{1F600}z' + x;
  h = mix(h, s1.length + s1.codePointAt(2) + [...s1].length);
  h = mix(h, sh(s1.split('').reverse().join('')));
  h = mix(h, sh(\`t\${x}-\${\`in\${x % 3}\`}-\${s1.slice(-2)}\`));
  h = mix(h, sh('ab'.repeat(3).padStart(9, '*').padEnd(12, '-')));
  h = mix(h, sh('x-y-z'.replace(/-(.)/g, '$1$&').replaceAll('y', '$$')));
  const re = /(?<w>[a-z]+)(\\d+)/g;
  let m, k = 0;
  while ((m = re.exec('ab12 cd34 e5')) && k++ < 5) h = mix(h, sh(m.groups.w) + m.index + re.lastIndex);
  h = mix(h, String.fromCharCode(0xd83d, 0xde00).length + '\\0'.length + 'abc'.at(-1).charCodeAt(0));
  h = mix(h, sh(JSON.stringify({ a: [1, 'b', null], c: x % 9 })));
}` }),

  foldable: (r, s) => ({ body: `{
  h = mix(h, ('ab' + 'cd').length * (${r.int(8)} << 2) | ~${r.int(50)});
  h = mix(h, typeof undefined === 'undefined' ? ${r.int(99)} : 0);
  h = mix(h, (void 0) === undefined ? 1 : 2);
  h = mix(h, !!'' + !!'x' + (null ?? ${r.int(9)}) + (0 || ${r.int(9)}) + (1 && ${r.int(9)}));
  if (${r.int(2) ? "1 > 2" : "'a' < 'b'"}) h = mix(h, 3); else h = mix(h, 4);
  h = mix(h, (1, 2, x));
  h = mix(h, ${r.int(1000)} * 0 + -(-${r.int(9)}) + (3 - -2) % 4);
  const big = ${r.int(2) ? "2147483647 + 1" : "-2147483648 - 1"};
  h = mix(h, big | 0);
  h = mix(h, (${r.int(5)} == '${r.int(5)}') + (null == undefined) * 2 + (NaN != NaN) * 4);
}` }),

  manyLocals: (r, s) => {
    const n = 30 + r.int(140);
    const lines = [`let v${s}_0 = x | 0;`];
    for (let i = 1; i < n; i++) {
      const a = r.int(i), b = r.int(i);
      const op = r.pick(["+", "^", "*", "-", "&", "|"]);
      lines.push(`const v${s}_${i} = (v${s}_${a} ${op} v${s}_${b} ${r.int(3) ? "+ " + r.int(999) : "* " + (1 + r.int(9))}) | 0;`);
    }
    const uses = [];
    for (let i = 0; i < n; i += 1 + r.int(3)) uses.push(`v${s}_${i}`);
    lines.push(`h = mix(h, ${uses.join(" ^ ")});`);
    return { body: lines.join("\n") };
  },

  deepIf: (r, s) => {
    const d = 5 + r.int(8);
    const gen = (k) => {
      if (k >= d) return `h = mix(h, ${r.int(1000)});`;
      const c = `(x >> ${k % 10}) & 1`;
      return `if (${c}) {\n${ind(gen(k + 1), "  ")}\n} else ${r.int(2) ? `if (x % ${k + 2} === 1) {\n  h = mix(h, ${k});\n} else ` : ""}{\n${ind(r.int(3) ? `h = mix(h, ${r.int(99)});` : gen(k + 2), "  ")}\n}`;
    };
    return { body: gen(0) };
  },

  getset: (r, s) => ({ body: `{
  let hits = 0;
  const key = 'k' + (x % 3);
  const o = {
    _v: x % 11,
    get v() { hits++; return this._v; },
    set v(q) { hits += 2; this._v = q * 2; },
    [key]: ${r.int(9)},
    [\`m\${x % 2}\`](q) { return q + this._v; },
  };
  Object.defineProperty(o, 'ro', { get: () => hits * 3, enumerable: false });
  o.v += ${1 + r.int(9)}; o.v++;
  h = mix(h, o.v + hits + o.ro + (o.k0 ?? -1) + (o.m0 ? o.m0(1) : o.m1(2)));
  h = mix(h, Object.keys(o).length);
}` }),

  switchScopes: (r, s) => ({ body: `{
  const fl = [];
  for (let i = 0; i < ${4 + r.int(4)}; i++) {
    switch ((x + i) % ${3 + r.int(3)}) {
      case 0: { let q = i * 2; fl.push(() => q); }
      case 1: { const q = i + 100; fl.push(() => q); break; }
      case 2: if (i > 2) continue;
      default: { let q = -i; fl.push(() => q); }
    }
    h = mix(h, i);
  }
  for (const f of fl) h = mix(h, f());
}` }),

  recursion: (r, s) => ({
    pre: `function ev${s}(n) { return n === 0 ? 1 : od${s}(n - 1); }
function od${s}(n) { return n === 0 ? 0 : ev${s}(n - 1); }
const fib${s} = (n, memo = new Map()) => n < 2 ? n : memo.get(n) ?? (memo.set(n, fib${s}(n - 1, memo) + fib${s}(n - 2, memo)), memo.get(n));`,
    body: `h = mix(h, ev${s}(x % ${10 + r.int(30)}) + fib${s}(x % ${10 + r.int(20)}));
{
  const walk = (t, d) => !t ? d : Math.max(walk(t.l, d + 1), walk(t.r, d + 1));
  h = mix(h, walk({ l: { r: { l: null } }, r: x & 1 ? { l: { l: { l: null } } } : null }, 0));
}` }),

  argumentsObj: (r, s) => ({
    pre: `function ar${s}() {
  let t = arguments.length * ${1 + r.int(9)};
  for (let i = 0; i < arguments.length; i++) t = t * 7 + (arguments[i] | 0);
  const rest = Array.prototype.slice.call(arguments, 1);
  return t + rest.length;
}`,
    body: `h = mix(h, ar${s}() + ar${s}(x) + ar${s}(x, 2, 3) + ar${s}.apply(null, [1, x, 9, 9]));` }),

  bigint: (r, s) => ({ body: `{
  let b = BigInt(x) * ${r.int(1000)}n + (1n << ${40 + r.int(30)}n);
  for (let i = 0; i < 3; i++) b = b * 3n - BigInt(i);
  h = mix(h, Number(b % 1000003n) + Number(BigInt.asUintN(16, b)) + (b > 10n ? 1 : 0));
  h = mix(h, sh((-b / 7n).toString(16)));
}` }),

  iterators: (r, s) => ({ body: `{
  const it = { from: x % 4, to: x % 4 + ${2 + r.int(4)}, [Symbol.iterator]() {
    let c = this.from; const t = this.to;
    return { next: () => (c < t ? { value: c++, done: false } : { value: undefined, done: true }), return: () => { h = mix(h, 1234); return { done: true }; } };
  } };
  for (const v of it) { if (v === ${r.int(6)}) break; h = mix(h, v); }
  const [p, q = 9, ...rest] = it;
  h = mix(h, p + q + rest.length);
  const m = new Map([[1, 'a'], [x, 'b'], ['k', x]]);
  for (const [k, v] of m) h = mix(h, sh(k) + sh(v));
  const ws = new WeakMap(); const key = {}; ws.set(key, x);
  h = mix(h, ws.get(key) + (ws.has({}) ? 1 : 0));
}` }),

  genCfg: (r, s) => {
    const body = cfgGen(r, s, { maxDepth: 3 + r.int(3), budget: 10 + r.int(16), yields: true });
    return {
      pre: `function* gc${s}(x, h) {\n${ind(body, "  ")}\n  return h >>> 0;\n}`,
      body: `{
  const it = gc${s}(x, h);
  let st = it.next(), k = 0;
  while (!st.done && k < 200) { h = mix(h, st.value); st = it.next(k++ % ${2 + r.int(5)} ? k : undefined); }
  h = mix(h, st.done ? st.value : 1);
}` };
  },

  bigSwitch: (r, s) => {
    const n = 8 + r.int(40);
    const base = r.int(3) ? 0 : r.int(100) - 50;
    const cases = [];
    for (let i = 0; i < n; i++) {
      if (r.int(6) === 0) continue; // holes
      const body = r.int(4) === 0 ? `h = mix(h, ${r.int(1000)});` : r.int(3) === 0 ? `h = mix(h, ${i}); break;` : `h = mix(h, x * ${i + 1}); break;`;
      cases.push(`case ${base + i}: ${body}`);
    }
    return { body: `for (let i = 0; i < ${3 + r.int(5)}; i++) {
  switch ((x + i * ${1 + r.int(7)}) % ${n + 2} + ${base}) {
${ind(cases.join("\n"), "    ")}
    default: h = mix(h, ${r.int(77)});
  }
}` };
  },

  literals: (r, s) => {
    const lit = (d) => {
      const k = r.int(d > 2 ? 4 : 7);
      if (k === 0) return String(r.int(2000) - 1000);
      if (k === 1) return `'${["", "a", "b c", "\\u00e9", "x".repeat(r.int(20))][r.int(5)]}'`;
      if (k === 2) return ["null", "true", "false", "0.25", "-0", "1e300"][r.int(6)];
      if (k === 3) return `x % ${2 + r.int(9)}`;
      if (k <= 5) { const n = r.int(12); return `[${Array.from({ length: n }, () => lit(d + 1)).join(", ")}]`; }
      const n = r.int(8); return `{ ${Array.from({ length: n }, (_, i) => `${[`a${i}`, `b${i}`, `'c-d${i}'`, `${i}`, `${10 + i}`, `k${i}`][r.int(6)]}: ${lit(d + 1)}`).join(", ")} }`;
    };
    return { body: `{
  const L = [${Array.from({ length: 3 + r.int(6) }, () => lit(0)).join(", ")}];
  h = mix(h, sh(JSON.stringify(L)));
  const L2 = [${Array.from({ length: 20 + r.int(60) }, () => r.int(300)).join(", ")}];
  h = mix(h, L2.reduce((a, b) => (a * 31 + b) | 0, x));
}` };
  },

  manyArgs: (r, s) => {
    const n = 10 + r.int(30);
    const ps = Array.from({ length: n }, (_, i) => `p${i}${r.int(4) === 0 ? " = " + i : ""}`);
    const args = Array.from({ length: n - r.int(3) }, (_, i) => (r.int(3) ? `x + ${i}` : `${i}`));
    return {
      pre: `function ma${s}(${ps.join(", ")}) {\n  let t = 0;\n${Array.from({ length: n }, (_, i) => `  t = (t * 7 + (p${i} | 0)) | 0;`).join("\n")}\n  return t;\n}`,
      body: `h = mix(h, ma${s}(${args.join(", ")}));\nh = mix(h, ma${s}.call(null, ${args.slice(0, 5).join(", ")}));`,
    };
  },

  forIn: (r, s) => ({ body: `{
  const proto = { inh${s}: 1, 7: 'p' };
  const o = Object.create(proto);
  o.b = 2; o[3] = 'x'; o.a = x % 9; o[1] = 4; o['-1'] = 5;
  Object.defineProperty(o, 'hid', { value: 9, enumerable: false });
  for (const k in o) { h = mix(h, sh(k)); if (k === '${["a", "b", "3"][r.int(3)]}') continue; h = mix(h, typeof o[k] === 'number' ? o[k] : 1); }
  const arr = [5, , 7]; arr.extra = 1;
  for (const k in arr) h = mix(h, sh(k));
  delete o.b;
  h = mix(h, ('b' in o) * 2 + ('inh${s}' in o) * 4 + Object.keys(o).length);
}` }),
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

/** Default weights: random control flow dominates, the rest share. */
export const DEFAULT_WEIGHTS = Object.fromEntries(TEMPLATE_NAMES.map((t) => [t, t === "cfg" ? 5 : t === "cfgDeep" || t === "genCfg" ? 3 : 1]));

function weightedPick(r, weights) {
  const names = TEMPLATE_NAMES.filter((t) => (weights[t] ?? 0) > 0);
  const total = names.reduce((a, t) => a + weights[t], 0);
  let x = r.float() * total;
  for (const t of names) { x -= weights[t]; if (x < 0) return t; }
  return names[names.length - 1];
}

/** Render one function from its parts; returns { pre, src }. */
export function renderFunction(name, parts, { arrow = false } = {}) {
  const pres = [];
  const bodies = [];
  parts.forEach((p, i) => {
    const r = makeRng(p.k);
    // Suffix from the part's own key (its original index), so dropping a
    // sibling part leaves this part's text byte-identical.
    const pid = p.k.split(":").pop();
    const s = `_${pid}`;
    const out = TEMPLATES[p.t](r, s + name.slice(-3).replace(/[^a-z0-9]/gi, ""));
    if (out.pre) pres.push(out.pre);
    bodies.push(`// part ${pid}: ${p.t}\n${out.body}`);
  });
  const body = `  let h = x | 0;\n${ind(bodies.join("\n"), "  ")}\n  return h >>> 0;`;
  const src = arrow ? `export const ${name} = (x) => {\n${body}\n};` : `export function ${name}(x) {\n${body}\n}`;
  return { pre: pres.join("\n\n"), src };
}

const NOUNS = ["Ledger", "Cart", "Order", "Signal", "Atlas", "Kettle", "Meadow", "Forge", "Beacon", "Harbor", "Quill", "Lantern"];

/**
 * Plan (no source yet): seed + count -> function specs. `weights` biases the
 * template mix (coverage guidance); `size` scales parts per function.
 */
export function planShapes(seed, count, { weights = DEFAULT_WEIGHTS, perModule = 4, size = 1 } = {}) {
  const r = makeRng(`shapes:${seed}`);
  const fns = [];
  for (let i = 0; i < count; i++) {
    const nParts = Math.max(1, Math.round((1 + r.int(4)) * size));
    const parts = [];
    for (let p = 0; p < nParts; p++) parts.push({ t: weightedPick(r, weights), k: `shapes:${seed}:${i}:${p}` });
    fns.push({ name: `${r.pick(NOUNS).toLowerCase()}${r.pick(NOUNS)}_${i.toString(36)}`, parts, arrow: r.int(6) === 0, mod: Math.floor(i / perModule) });
  }
  return fns;
}

/**
 * Plan -> files, in gen-junk's contract. Returns { files, functions, modules }.
 */
export function emitShapes(plan, seedLabel = "?") {
  const files = [["src/junk/_rt.js", RT_SOURCE]];
  const byMod = new Map();
  for (const f of plan) { if (!byMod.has(f.mod)) byMod.set(f.mod, []); byMod.get(f.mod).push(f); }
  const modules = [];
  const functions = [];
  for (const [m, fns] of [...byMod].sort((a, b) => a[0] - b[0])) {
    const path = `src/junk/s${String(m).padStart(3, "0")}.js`;
    const pres = [];
    const srcs = [];
    for (const f of fns) {
      const { pre, src } = renderFunction(f.name, f.parts, { arrow: f.arrow });
      if (pre) pres.push(pre);
      srcs.push(src);
      functions.push({ name: f.name, module: path, exported: true, level: 0, callees: [], arg: entryArg(f.name), form: f.arrow ? "arrow" : "function", shapes: f.parts.map((p) => p.t), parts: f.parts });
    }
    const head = `// generated by tools/app-fuzz/gen-shapes.mjs (${seedLabel}) -- do not edit\nimport { mix, sh, Fail, fail } from './_rt.js';\n`;
    files.push([path, head + "\n" + pres.concat(srcs).join("\n\n") + "\n"]);
    modules.push({ path, functions: fns.map((f) => f.name), imports: ["src/junk/_rt.js"] });
  }
  const idx = ["// generated registry: module path -> namespace", ...modules.map((m, i) => `import * as m${i} from './${m.path.slice("src/junk/".length)}';`),
    "", "export const JUNK_MODULES = {", ...modules.map((m, i) => `  '${m.path}': m${i},`), "};", ""];
  files.push(["src/junk/index.js", idx.join("\n")]);
  return { files, functions, modules };
}

export function generateShapes(seed, count, opts = {}) {
  return emitShapes(planShapes(seed, count, opts), `seed ${seed}`);
}

function main() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const out = get("--out");
  const g = generateShapes(get("--seed", "1"), Number(get("--functions", "40")));
  if (!out) { for (const [p, c] of g.files) process.stdout.write(`//// ${p}\n${c}`); return; }
  for (const [p, c] of g.files) { mkdirSync(dirname(join(out, p)), { recursive: true }); writeFileSync(join(out, p), c); }
}
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
