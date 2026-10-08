// This tool answers the *ceiling* question I3 step 1 asks, before any fix is
// written: of the `new Array(` sites the real `array-literal` rung still
// leaves unfolded, how many have the property that EVERY element's value is
// either already a plain/pure non-register expression, or a bare register
// read whose SOLE definition (within the same statement list, i.e. the same
// scope `array-literal`'s own `match()` operates over) is a pure expression
// that is read nowhere else? That is exactly the shape a future
// "element-expression folding" step could fix by substituting the
// definition directly into the store's own value, in place -- no hoisting,
// no reordering, so it needs none of `canHoist`'s reasoning.
//
// Every surviving `defOf`-shaped statement (`rN = new Array(k)`, k > 0, not
// already closed by the real rung) found in the final tree is exactly one
// of this bundle's unfolded sites -- the denominator quoted in docs, and the
// same count a `new Array(` text-grep on the final emitted source would
// give (k=0 sites are excluded: `inlineEmptyOf` always closes those before
// this rung even runs, docs/specs/passes/31-array-literal.md §4 precondition
// 5, so none ever survive to be counted here).
//
//   node --max-old-space-size=8192 tools/passes/array-literal-fold-ceiling.ts <bundle.hbc>
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { analyseModule } from "../../src/cfg/index.ts";
import type { FunctionCfg } from "../../src/cfg/types.ts";
import { emitModule } from "../../src/emit/index.ts";
import type { Stmt } from "../../src/emit/ast.ts";
import { parseHbc } from "../../src/parse/module.ts";
import { astPassHook, passHook } from "../../src/passes/index.ts";
import { identUses, isRegisterName, stmtLists } from "../../src/passes/ast.ts";
import { FRESH_ARRAY, OWN_INDEX_DEFINE, defOf, freshRegisterDef, opcodeOf, storeOf } from "../../src/passes/array-literal/match.ts";
import type { PassContext } from "../../src/passes/types.ts";

/** The three pure-renaming stage-B rungs (registry.ts's own grouping) --
 *  see the file header for why all three, `reg-split` especially, must be
 *  off for this measurement to answer the right question. */
const RENAMING_RUNGS = ["fn-naming", "reg-split", "var-naming"];

export type FoldCeilingCode = "closes-with-fold" | "blocked" | "undecidable";

export interface FoldCeilingSite {
  readonly functionIndex: number;
  readonly count: number;
  readonly code: FoldCeilingCode;
}

export interface FoldCeilingStats {
  readonly total: number;
  readonly closesWithFold: number;
  readonly blocked: number;
  readonly undecidable: number;
  readonly sites: readonly FoldCeilingSite[];
}

function fakeCtx(functionIndex: number, cfg: FunctionCfg): PassContext {
  return { functionIndex, cfg } as unknown as PassContext;
}

/**
 * Classifies one surviving `new Array(k)` site (`list[i]`, `def` already
 * recognised by `defOf`). Walks forward exactly as the real `match()` does,
 * plus one extra tolerance: a non-own-index-store statement that is a pure
 * single-register definition (`freshRegisterDef`) is not an immediate
 * refusal -- it may still be a *pending fold candidate*, consumed the
 * moment a later own-index store's value turns out to be a bare read of
 * that exact register with no OTHER read of it anywhere in between (the
 * "single-use register whose definition is a pure expression" property I3
 * asks about). Everything else (index gap/repeat, self-reference, a
 * non-store/non-fold-candidate statement, a leftover pending def nothing
 * ever consumes) is `"blocked"` -- decidably not fixed by this mechanism.
 * A store whose value is a bare register with NO locally-provable
 * definition (defined outside this statement list, or defined by something
 * other than a pure single assignment) is `"undecidable"`: this tool's
 * local, list-scoped analysis cannot soundly say either way.
 */
export function classifySite(list: readonly Stmt[], i: number, def: { readonly reg: string; readonly count: number }, ctx: PassContext): FoldCeilingCode {
  const reg = def.reg;
  const storePos: number[] = [];
  const consumedDefs = new Set<number>();
  let next = 0;
  let undecidable = false;
  let j = i + 1;
  for (; j < list.length && next < def.count; j++) {
    const s = list[j]!;
    const op = opcodeOf(s, ctx);
    if (op !== null && OWN_INDEX_DEFINE.has(op)) {
      const st = storeOf(s, reg);
      if (st === null || st.index !== next) return "blocked"; // gap/repeat, real match() refuses this too
      const selfUse = identUses([{ k: "expr", expr: st.value }], reg);
      if (selfUse.reads + selfUse.writes > 0) return "blocked"; // self-referencing-element
      if (st.value.k === "ident" && isRegisterName(st.value.name) && st.value.name !== reg) {
        const rX = st.value.name;
        let defPos = -1;
        for (let k = j - 1; k > i; k--) {
          if (identUses([list[k]!], rX).writes > 0) {
            defPos = k;
            break;
          }
        }
        if (defPos === -1) {
          undecidable = true; // no local definition to inspect at all
        } else {
          const fresh = freshRegisterDef(list[defPos]!);
          if (fresh === null || fresh.reg !== rX) return "blocked"; // def exists but isn't pure/single-assign
          if (identUses(list.slice(defPos + 1, j), rX).reads > 0) return "blocked"; // read elsewhere too: not single-use
          consumedDefs.add(defPos);
        }
      }
      storePos.push(j);
      next++;
      continue;
    }
    const fresh = freshRegisterDef(s);
    if (fresh === null || fresh.reg === reg) return "blocked";
    // Not yet classified here -- verified retroactively below once every
    // store this site needs has been found (or the site gave up).
  }
  if (next !== def.count) return "blocked";
  const lastStore = storePos[storePos.length - 1]!;
  for (let k = i + 1; k < lastStore; k++) {
    if (storePos.includes(k)) continue;
    if (!consumedDefs.has(k)) return "blocked"; // a pending def nothing ever consumed
  }
  return undecidable ? "undecidable" : "closes-with-fold";
}

function classifyFunction(body: readonly Stmt[], cfg: FunctionCfg, out: FoldCeilingSite[]): void {
  const ctx = fakeCtx(cfg.functionIndex, cfg);
  for (const list of stmtLists(body)) {
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      const def = defOf(s);
      if (def === null) continue;
      const op = opcodeOf(s, ctx);
      if (op === null || !FRESH_ARRAY.has(op)) continue;
      if (def.count === 0) continue; // always closes via inlineEmptyOf -- out of scope
      out.push({ functionIndex: cfg.functionIndex, count: def.count, code: classifySite(list, i, def, ctx) });
    }
  }
}

export function measureBundle(bytes: Uint8Array, moduleName: string): FoldCeilingStats {
  const module = parseHbc(bytes);
  // strictEnv: false -- this tool only needs the pass-AST shape array-literal
  // itself sees, not a fully-resolved closure environment graph; some real
  // bundles have a handful of environment slots this pipeline cannot
  // statically resolve (unrelated to array-literal), and strict mode would
  // abort the whole measurement over them.
  const analysis = analyseModule(module, { strictEnv: false });
  const opts = { skip: RENAMING_RUNGS };
  const sites: FoldCeilingSite[] = [];
  const rawAstHook = astPassHook(analysis, opts);
  emitModule(analysis, {
    moduleName,
    provenanceComments: false,
    strictEnv: false,
    passes: passHook(analysis, opts),
    astPasses: (fn, cfg) => {
      const out = rawAstHook(fn, cfg);
      if (out.fn.k === "func") classifyFunction(out.fn.body, cfg, sites);
      return out;
    },
  });
  let closesWithFold = 0;
  let blocked = 0;
  let undecidable = 0;
  for (const site of sites) {
    if (site.code === "closes-with-fold") closesWithFold++;
    else if (site.code === "blocked") blocked++;
    else undecidable++;
  }
  return { total: sites.length, closesWithFold, blocked, undecidable, sites };
}

function pct(n: number, total: number): string {
  return total === 0 ? "0.0%" : `${((100 * n) / total).toFixed(1)}%`;
}

async function main(argv: readonly string[]): Promise<void> {
  const bundle = argv[0];
  if (bundle === undefined) throw new Error("usage: array-literal-fold-ceiling.ts <bundle.hbc>");
  const stats = measureBundle(new Uint8Array(readFileSync(bundle)), basename(bundle));
  process.stdout.write(`# array-literal fold-ceiling -- ${basename(bundle)}\n\n`);
  process.stdout.write(`unfolded new Array( sites (denominator): ${stats.total}\n`);
  process.stdout.write(`closes-with-fold: ${stats.closesWithFold} (${pct(stats.closesWithFold, stats.total)})\n`);
  process.stdout.write(`blocked (other reason): ${stats.blocked} (${pct(stats.blocked, stats.total)})\n`);
  process.stdout.write(`undecidable: ${stats.undecidable} (${pct(stats.undecidable, stats.total)})\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`array-literal-fold-ceiling: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
}
