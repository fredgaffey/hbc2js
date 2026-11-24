#!/usr/bin/env node
// tools/torture/gen-junk.mjs — seeded generator of "junk" functions for the
// torture app (tools/torture/README.md). Emits N functions spread over many
// modules that build in-memory data structures (arrays, objects, Maps, Sets,
// strings, numbers), mutate them under random but BOUNDED control flow
// (if/for/while/do/switch/try/labelled break), call each other along a random
// DAG, and return a uint32 checksum.
//
// Safety contract (checked by tests/gate/torture/): pure computation only —
// no I/O, no eval/Function, no timers, no recursion (callees always have a
// strictly lower level), every loop has a constant bound, and no call sits
// inside a loop, so one entry call runs at most 1+2+4+8 function bodies.
// Deterministic: same (seed, functions, perModule) -> byte-identical files.
//
// --hard adds an opt-in profile of extra language shapes (see HARD_SNIPPETS) plus
// async leaf functions (form "async", level 4, awaited by the harnesses).
//
// Usage: node tools/torture/gen-junk.mjs --seed S --functions N [--per-module K] [--hard] [--out DIR]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { makeRng } from "../appgen/lib/prng.mjs";

const VERBS = ["build", "merge", "scan", "fold", "rank", "sync", "pack", "trim", "load", "score",
  "parse", "route", "index", "patch", "group", "split", "queue", "sample", "verify", "render"];
const NOUNS = ["Ledger", "Cart", "Order", "Signal", "Atlas", "Kettle", "Meadow", "Forge", "Beacon",
  "Harbor", "Ticket", "Profile", "Stream", "Bucket", "Cache", "Token", "Badge", "Invoice", "Route", "Slot"];
const WORDS = ["ab", "cd", "xyz", "q", "lorem", "ipsum", "k9", "zz", "mno", "pear"];
const KEYS = ["alpha", "beta", "gamma", "delta", "eps", "zeta", "eta", "theta"];

const RT_SOURCE = `// Shared runtime for generated junk modules (pure, integer-only).
export function mix(h, v) {
  return Math.imul((h ^ (v | 0)) >>> 0, 16777619) >>> 0;
}

// Entry argument for a junk function, derived from its name so any harness
// (Node, Hermes, the scorer on recovered code) can compute it independently.
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
`;

/** Entry argument for junk function `name` (mirrors RT_SOURCE's entryArg). */
export function entryArg(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul((h ^ name.charCodeAt(i)) >>> 0, 16777619) >>> 0;
  return (h % 1000) + 1;
}


// ---- --hard profile ---------------------------------------------------------
// Opt-in extra shapes the default junk lacks. Driven by its OWN seeded stream
// (`hard:<seed>`), so the default profile's bytes are unchanged and the hard
// profile's regular functions are the default ones plus an appended section.
// Same safety contract: pure, constant-bounded loops, no I/O/timers/eval.
// Each snippet is a self-contained block over h/arr/str/x/mix with names
// suffixed by a unique id; none of them calls another generated function.
const HARD_SNIPPETS = [
  // try/catch/finally inside switch cases inside a loop (break/continue through finally)
  (T) => String.raw`for (let a${T} = 0; a${T} < 4; a${T}++) {
  switch ((h + a${T}) % 3) {
    case 0:
      try {
        if (a${T} === 2) throw new RangeError('r' + a${T});
        h = mix(h, a${T});
      } catch (e${T}) {
        h = mix(h, e${T}.message.length);
      } finally {
        h = mix(h, 7);
      }
      break;
    case 1:
      try {
        h = mix(h, 11);
        continue;
      } finally {
        h = mix(h, a${T} + 1);
      }
    default:
      try {
        break;
      } finally {
        h = mix(h, 13);
      }
  }
  h = mix(h, a${T} * 3);
}`,
  // generator with yield inside try/finally, next(value), return(), throw(), yield*
  (T) => String.raw`function* g${T}(n) {
  let s = 0;
  try {
    for (let k = 0; k < n; k++) {
      const got = yield k * 2 + s;
      s += got | 0;
    }
    return s;
  } finally {
    h = mix(h, 99);
  }
}
function* w${T}() {
  const r = yield* g${T}(2);
  try {
    yield r + 1;
  } catch (e) {
    yield e;
  }
}
const it${T} = g${T}(4);
let r${T} = it${T}.next();
let acc${T} = 0;
while (!r${T}.done) {
  acc${T} += r${T}.value;
  r${T} = it${T}.next(acc${T} & 7);
}
h = mix(h, acc${T} + r${T}.value);
const ib${T} = g${T}(5);
ib${T}.next();
ib${T}.next(1);
h = mix(h, ib${T}.return(5).value);
const ic${T} = w${T}();
const c1${T} = ic${T}.next();
const c2${T} = ic${T}.next(3);
const c3${T} = ic${T}.next(2);
h = mix(h, c1${T}.value + c2${T}.value + c3${T}.value + ic${T}.throw(41).value);`,
  // closures capturing per-iteration let bindings (including mutation inside the body)
  (T) => String.raw`const fs${T} = [];
for (let c${T} = 0; c${T} < 5; c${T}++) {
  fs${T}.push(() => c${T} * (h & 7) + c${T});
  if (c${T} === 3) c${T}++;
}
const gs${T} = [];
for (let i${T} = 0, j${T} = 10; i${T} < 3; i${T}++, j${T}--) gs${T}.push(() => i${T} * 100 + j${T});
h = mix(h, fs${T}.reduce((s, f) => s + f(), 0) + gs${T}.map((f) => f()).join('').length);`,
  // labelled continue across nested loops
  (T) => String.raw`outer${T}: for (let p${T} = 0; p${T} < 4; p${T}++) {
  for (let q${T} = 0; q${T} < 4; q${T}++) {
    if (q${T} > p${T}) continue outer${T};
    if ((p${T} + q${T} + h) % 5 === 0) continue;
    h = mix(h, p${T} * 4 + q${T});
  }
  h = mix(h, 1000 + p${T});
}
blk${T}: {
  for (let u${T} = 0; u${T} < 3; u${T}++) {
    if ((h + u${T}) % 4 === 1) break blk${T};
    h = mix(h, u${T});
  }
  h = mix(h, 5);
}`,
  // destructuring with defaults in params (nested, holes, rest)
  (T) => String.raw`const d${T} = ({ a = 3, b: { c = 4 } = {}, ...rest } = {}, [e = 5, , f = 6] = []) => a + c + e + f + Object.keys(rest).length;
h = mix(h, d${T}({ z: 1 }, [undefined, 9]) + d${T}(undefined, undefined) + d${T}({ a: 1, b: { c: null } }, [1, 2, 3]));`,
  // getters / setters / computed accessor on object literals
  (T) => String.raw`const o${T} = { _v: x % 7, get v() { return this._v * 2; }, set v(n) { this._v = n + 1; }, get ['k' + (x % 3)]() { return 5; } };
o${T}.v = h & 15;
h = mix(h, o${T}.v + o${T}._v + (o${T}['k' + (x % 3)] | 0));`,
  // optional calls / chains / nullish
  (T) => String.raw`const oc${T} = { f: (n) => n + 1, nested: { g() { return this === oc${T}.nested ? 5 : 0; } } };
const un${T} = h & 1 ? undefined : oc${T};
h = mix(h, (un${T}?.f(3) ?? -1) + (oc${T}.nested?.g?.() ?? 0) + (oc${T}.missing?.() ?? 7) + (un${T}?.nested.g() ?? 2));`,
  // sparse arrays / holes
  (T) => String.raw`const sp${T} = [1, , 3, , ];
sp${T}[7] = 9;
let cn${T} = 0;
sp${T}.forEach(() => cn${T}++);
h = mix(h, sp${T}.length * 100 + cn${T} + (1 in sp${T} ? 1 : 0) + Object.keys(sp${T}).length + sp${T}.indexOf(undefined) + sp${T}.map((v) => v * 2).length);`,
  // string escapes / unicode
  (T) => String.raw`const us${T} = 'a\tb\né\u{1F600}\0\\"\'\x41' + "q'\" ";
h = mix(h, us${T}.length);
h = mix(h, us${T}.charCodeAt(h % us${T}.length));
h = mix(h, [...us${T}].length + us${T}.codePointAt(5));
str = (str + 'ü😀').slice(-9);`,
  // numeric edge cases
  (T) => String.raw`const ne${T} = [-0, NaN, 2 ** 53, 2 ** 53 + 2, -(2 ** 31), 0.1 + 0.2, 1 / 3, Number.MAX_SAFE_INTEGER, 1e21, 5e-324];
h = mix(h, ne${T}.filter((v) => Object.is(v, -0)).length + String(ne${T}[2]).length + (1 / ne${T}[0] < 0 ? 3 : 4) + (ne${T}[1] !== ne${T}[1] ? 5 : 6));
h = mix(h, (0.1 + 0.2 === 0.3 ? 1 : 2) + String(ne${T}[8]).length + (ne${T}[3] - ne${T}[2]) + (ne${T}[0] | 0) + (ne${T}[4] >>> 0) % 7 + ((2 ** 53 + 1) === 2 ** 53 ? 1 : 2) + String(ne${T}[9]).length);
h = mix(h, Math.round(-0.5) === 0 && 1 / Math.round(-0.5) < 0 ? 1 : 2);`,
  // exceptions used for control flow (thrown objects, finally overriding return)
  (T) => String.raw`let ec${T} = 0;
const th${T} = (n) => {
  if (n > 2) throw { code: n };
  return n;
};
try {
  for (let i${T} = 0; i${T} < 5; i${T}++) ec${T} += th${T}(i${T});
} catch (e) {
  ec${T} += e.code * 10;
} finally {
  ec${T}++;
}
const fo${T} = () => {
  try {
    return 1;
  } finally {
    ec${T} += 5;
  }
};
const fp${T} = () => {
  try {
    throw 1;
  } catch (e) {
    return 2;
  } finally {
    ec${T} += 3;
    return 3;
  }
};
h = mix(h, ec${T} + fo${T}() * 100 + fp${T}() * 1000 + ec${T});`,
];

function hardSection(hr, uid) {
  const n = 1 + hr.int(3);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push("  {\n" + HARD_SNIPPETS[hr.int(HARD_SNIPPETS.length)](`${uid}_${i}`).split("\n").map((l) => "  " + l).join("\n") + "\n  }");
  return parts.join("\n");
}

// An async leaf: await inside try/catch/finally in a loop, Promise.all, async generator.
function asyncFunction(name) {
  return `export async function ${name}(x) {
  let h = x | 0;
  try {
    for (let i = 0; i < 3; i++) {
      try {
        await null;
        if ((h + i) % 2) throw new Error('t' + i);
        h = mix(h, await Promise.resolve(i));
      } catch (e) {
        h = mix(h, e.message.length);
      } finally {
        h = mix(h, i + (await 1));
      }
    }
  } finally {
    h = mix(h, 5);
  }
  const [a, b] = await Promise.all([1, 2].map(async (v) => v * (h & 3)));
  h = mix(h, a + b);
  async function* ag() {
    try {
      yield 1;
      yield 2;
    } finally {
      h = mix(h, 17);
    }
  }
  for await (const v of ag()) {
    if (v === 1) continue;
    h = mix(h, v);
  }
  const settled = await Promise.allSettled([Promise.reject(new Error('z')), Promise.resolve(h & 7)]);
  h = mix(h, settled.map((s) => (s.status === 'fulfilled' ? s.value : 100)).reduce((p, q) => p + q, 0));
  return h >>> 0;
}`;
}

function camel(rng, idx) {
  return rng.pick(VERBS) + rng.pick(NOUNS) + rng.pick(NOUNS) + "_" + idx.toString(36);
}

function bodyGen(rng) {
  let uniq = 0;
  const loopVars = [];
  const lit = (n) => 1 + rng.int(n);
  const cond = () => {
    switch (rng.int(7)) {
      case 0: return `(h & ${lit(15)}) === ${rng.int(4)}`;
      case 1: return `arr.length > ${lit(12)}`;
      case 2: return `map.has(${rng.int(8)})`;
      case 3: return `str.length % 2 === 0`;
      case 4: return `x > ${lit(900)}`;
      case 5: return `set.has(${rng.int(10)})`;
      default: return loopVars.length ? `${rng.pick(loopVars)} % ${lit(3) + 1} === 0` : `(h >>> 3) % 5 < 2`;
    }
  };
  const atom = () => {
    const k = lit(97);
    const key = rng.pick(KEYS);
    switch (rng.int(20)) {
      case 0: return `arr.push((h + ${k}) % ${lit(500) + 3});`;
      case 1: return `h = mix(h, arr.length);`;
      case 2: return `obj.${key} = (obj.${key} | 0) + ${k};`;
      case 3: return `map.set(${rng.int(8)} + (h & 7), str.length);`;
      case 4: return `set.add(h % ${lit(20) + 1});`;
      case 5: return `str = (str + '${rng.pick(WORDS)}').slice(-${lit(30) + 4});`;
      case 6: return `h = mix(h, str.charCodeAt(h % (str.length || 1)) | 0);`;
      case 7: return `arr.sort((p, q) => p - q);\nh = mix(h, arr[0] | 0);`;
      case 8: return `h = mix(h, arr.reduce((a, b) => (a + b) | 0, 0));`;
      case 9: return `if (arr.length > ${lit(10) + 6}) arr.splice(0, ${lit(5)});`;
      case 10: return `h = mix(h, Object.keys(obj).length * ${k});`;
      case 11: return `h = mix(h, map.size + set.size);`;
      case 12: return `for (const [mk, mv] of map) h = mix(h, mk + mv);`;
      case 13: { const t = `t${uniq++}`; return `const ${t} = arr.map((v) => (v * ${k}) % ${lit(50) + 2}).filter((v) => v & 1);\nh = mix(h, ${t}.length);`; }
      case 14: return `str = str.split('').reverse().join('').slice(0, ${lit(20) + 4});`;
      case 15: return `obj.list = [...(obj.list || []), h & 15].slice(-5);\nh = mix(h, obj.list.length);`;
      case 16: return `delete obj.${key};`;
      case 17: return `h = mix(h, Math.imul(h, ${k}) ^ (x << ${rng.int(8)}));`;
      case 18: return `h = (h + ((x * ${k}) % ${lit(300) + 1})) | 0;`;
      default: return loopVars.length ? `h = mix(h, ${rng.pick(loopVars)} * ${k});` : `h = mix(h, JSON.stringify(obj).length);`;
    }
  };
  const block = (depth, n, ind) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(stmt(depth, ind));
    return out.join("\n");
  };
  const indent = (s, ind) => s.split("\n").map((l) => (l ? ind + l : l)).join("\n");
  function stmt(depth, ind) {
    if (depth >= 2 || rng.int(10) < 6) return indent(atom(), ind);
    const inner = ind + "  ";
    const c = rng.int(7);
    if (c === 0) {
      const els = rng.int(2) ? ` else {\n${block(depth + 1, lit(2), inner)}\n${ind}}` : "";
      return `${ind}if (${cond()}) {\n${block(depth + 1, lit(3), inner)}\n${ind}}${els}`;
    }
    if (c === 1) {
      const v = `i${uniq++}`;
      const label = depth === 0 && rng.int(3) === 0 ? `L${uniq++}` : null;
      loopVars.push(v);
      let body = block(depth + 1, lit(3), inner);
      if (label) body += `\n${inner}if (${cond()}) break ${label};`;
      else if (rng.int(3) === 0) body = `${inner}if (${cond()}) continue;\n` + body;
      loopVars.pop();
      return `${ind}${label ? label + ": " : ""}for (let ${v} = 0; ${v} < ${lit(6)}; ${v}++) {\n${body}\n${ind}}`;
    }
    if (c === 2) {
      const w = `w${uniq++}`;
      return `${ind}let ${w} = 0;\n${ind}while (${w} < ${lit(5)} && (h & 3) !== ${rng.int(4)}) {\n${inner}${w}++;\n${block(depth + 1, lit(2), inner)}\n${ind}}`;
    }
    if (c === 3) {
      const w = `d${uniq++}`;
      return `${ind}let ${w} = 0;\n${ind}do {\n${block(depth + 1, lit(2), inner)}\n${ind}} while (++${w} < ${lit(4)});`;
    }
    if (c === 4) {
      const cases = lit(4) + 1;
      const parts = [];
      for (let i = 0; i < cases; i++) {
        const fall = rng.int(4) === 0 && i < cases - 1;
        parts.push(`${inner}case ${i}:\n${block(depth + 1, lit(2), inner + "  ")}${fall ? "" : `\n${inner}  break;`}`);
      }
      parts.push(`${inner}default:\n${block(depth + 1, 1, inner + "  ")}`);
      return `${ind}switch ((h >>> 0) % ${cases + 1}) {\n${parts.join("\n")}\n${ind}}`;
    }
    if (c === 5) {
      const fin = rng.int(2) ? ` finally {\n${inner}arr.push(${lit(40)});\n${ind}}` : "";
      return `${ind}try {\n${block(depth + 1, lit(2), inner)}\n${inner}if (${cond()}) throw new Error('e${lit(99)}');\n${block(depth + 1, 1, inner)}\n${ind}} catch (e) {\n${inner}h = mix(h, e instanceof Error ? e.message.length : 1);\n${ind}}${fin}`;
    }
    const v = `v${uniq++}`;
    return `${ind}for (const ${v} of arr.slice(0, ${lit(6)})) {\n${inner}h = mix(h, ${v});\n${block(depth + 1, lit(2), inner)}\n${ind}}`;
  }
  return { block, cond };
}

/**
 * Generate the junk tree. Returns { files: [[relPath, content]], functions,
 * modules } where every relPath is under src/junk/ and functions[i] =
 * { name, module, exported, level, callees, arg }.
 */
export function generateJunk(seed, count, { perModule = 20, modulesPerDir = 50, hard = false } = {}) {
  const rng = makeRng(`junk:${seed}`);
  const hr = hard ? makeRng(`hard:${seed}`) : null;
  const nMods = Math.max(1, Math.ceil(count / perModule));
  const modules = [];
  const functions = [];
  const files = [];
  files.push(["src/junk/_rt.js", RT_SOURCE]);
  let fnIndex = 0;
  for (let m = 0; m < nMods; m++) {
    const dir = `g${String(Math.floor(m / modulesPerDir)).padStart(3, "0")}`;
    const base = rng.pick(NOUNS).toLowerCase() + rng.pick(NOUNS) + "_" + m.toString(36);
    const path = `src/junk/${dir}/${base}.js`;
    const nFns = Math.min(perModule, count - fnIndex);
    // Up to 3 earlier modules to import from (locality-biased random DAG).
    const imports = [];
    if (m > 0) {
      const k = rng.int(4);
      for (let i = 0; i < k; i++) {
        const back = 1 + rng.int(Math.min(m, 200));
        const target = modules[m - back];
        if (!imports.includes(target)) imports.push(target);
      }
    }
    const candidates = [];
    for (const t of imports) for (const f of t.fns) candidates.push(f);
    const usedImports = new Map(); // module -> Set(names)
    const mod = { path, fns: [], imports: [] };
    const bodies = [];
    for (let i = 0; i < nFns; i++, fnIndex++) {
      const name = camel(rng, fnIndex);
      const level = rng.int(4);
      const pool = candidates.concat(mod.fns).filter((f) => f.level < level);
      const callees = [];
      const nCalls = pool.length ? rng.int(3) : 0;
      for (let c = 0; c < nCalls; c++) {
        const f = rng.pick(pool);
        if (!callees.includes(f)) callees.push(f);
      }
      for (const f of callees) {
        if (f.module !== path) {
          if (!usedImports.has(f.module)) usedImports.set(f.module, new Set());
          usedImports.get(f.module).add(f.name);
        }
      }
      const g = bodyGen(rng);
      const init = `let h = x | 0;\nconst arr = seedList(x, ${1 + rng.int(6)});\nconst obj = { ${rng.pick(KEYS)}: x % ${1 + rng.int(9) + 1}, tag: '${rng.pick(WORDS)}' };\nconst map = new Map();\nconst set = new Set([${rng.int(5)}, ${5 + rng.int(5)}]);\nlet str = '${rng.pick(WORDS)}${rng.pick(WORDS)}';`;
      const head = g.block(0, 2 + rng.int(3), "  ");
      const calls = callees.map((f) => `  h = mix(h, ${f.name}((h & 1023) + ${rng.int(50)}));`).join("\n");
      const tail = g.block(0, 1 + rng.int(3), "  ");
      const hardSec = hr && hr.int(3) === 0 ? hardSection(hr, `${fnIndex.toString(36)}`) + "\n" : "";
      const body = `${init.split("\n").map((l) => "  " + l).join("\n")}\n${head}\n${calls ? calls + "\n" : ""}${tail}\n${hardSec}  return h >>> 0;`;
      const arrow = rng.int(5) === 0;
      bodies.push(arrow
        ? `export const ${name} = (x) => {\n${body}\n};`
        : `export function ${name}(x) {\n${body}\n}`);
      const fn = { name, module: path, exported: true, level, callees: callees.map((f) => f.name), arg: entryArg(name), form: arrow ? "arrow" : "function" };
      mod.fns.push(fn);
      functions.push(fn);
    }
    if (hr) {
      for (let k = 0, na = Math.ceil(nFns / 5); k < na; k++) {
        const name = `await${hr.pick(NOUNS)}${hr.pick(NOUNS)}_${m.toString(36)}x${k}`;
        bodies.push(asyncFunction(name));
        const fn = { name, module: path, exported: true, level: 4, callees: [], arg: entryArg(name), form: "async" };
        mod.fns.push(fn);
        functions.push(fn);
      }
    }
    const rel = (to) => {
      const fromDir = dirname(path).split("/");
      const toParts = to.split("/");
      let i = 0;
      while (i < fromDir.length && fromDir[i] === toParts[i]) i++;
      const up = fromDir.length - i;
      return (up === 0 ? "./" : "../".repeat(up)) + toParts.slice(i).join("/");
    };
    const header = [`// generated by tools/torture/gen-junk.mjs (seed ${seed}) -- do not edit`,
      `import { mix, seedList } from '${rel("src/junk/_rt.js")}';`];
    for (const [mp, names] of usedImports) {
      header.push(`import { ${[...names].join(", ")} } from '${rel(mp)}';`);
      mod.imports.push(mp);
    }
    files.push([path, header.join("\n") + "\n\n" + bodies.join("\n\n") + "\n"]);
    modules.push(mod);
  }
  const idx = ["// generated registry: module path -> namespace", ...modules.map((m, i) => `import * as m${i} from './${m.path.slice("src/junk/".length)}';`),
    "", "export const JUNK_MODULES = {", ...modules.map((m, i) => `  '${m.path}': m${i},`), "};", ""];
  files.push(["src/junk/index.js", idx.join("\n")]);
  return {
    files,
    functions,
    modules: modules.map((m) => ({ path: m.path, functions: m.fns.map((f) => f.name), imports: m.imports })),
  };
}

function main() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const seed = get("--seed");
  const n = Number(get("--functions", "100"));
  if (seed === undefined || !Number.isInteger(n) || n < 1) {
    console.error("usage: node tools/torture/gen-junk.mjs --seed S --functions N [--per-module K] [--hard] [--out DIR]");
    process.exit(2);
  }
  const out = get("--out");
  const res = generateJunk(seed, n, { perModule: Number(get("--per-module", "20")), hard: a.includes("--hard") });
  if (out) {
    for (const [rel, content] of res.files) {
      mkdirSync(dirname(join(out, rel)), { recursive: true });
      writeFileSync(join(out, rel), content);
    }
  }
  console.log(JSON.stringify({ seed, functions: res.functions.length, modules: res.modules.length, files: res.files.length }));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
