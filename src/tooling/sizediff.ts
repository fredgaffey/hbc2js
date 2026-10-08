// Compares an `original.hbc` against a `rebuilt.hbc` (the recompiled result
// of decompiling `original.hbc` and running it back through hermesc, by
// whatever pipeline produced it — plain `hermesc -emit-binary` on `split`'s
// per-module output, or the full `hbc2js export` -> Metro -> hermesc chain).
// Two independent measurements, both derived from data this module computes
// itself (bytes in, object out — no filesystem, matching the rest of
// `src/tooling/`, `src/cli.ts` does all I/O):
//
//   1. Per-module / per-function byte deltas: every function's own
//      `FunctionHeader.bytecodeSizeInBytes` (the P2.1 artifact format's own
//      `functions.jsonl` `size` field, computed the same way,
//      `docs/specs/10-artifact-format.md` §2.1), grouped by the module a
//      Metro/CJS `require()` scan (`src/deps/inventory.ts`'s
//      `buildInventoryFromModule` — the D17a "module inventory" step, the
//      same structural `__d()`/CJS-table scan the P2.1 artifact index's own
//      module attribution starts from) attributes it to.
//
//      Within a matched pair, functions are joined by ordinal-within-module
//      (ascending bytecode function index, computed independently on each
//      side) since a function's own bytecode INDEX is not stable across a
//      decompile+recompile round trip (hermesc renumbers) even when the
//      module identity is. A function this tool cannot attribute to any
//      module (true for a plain, non-Metro script — every
//      `tests/fixtures/constructs/*` fixture, compiled directly by hermesc
//      with no `__d`/CJS wrapping at all) gets `module: null` on both
//      sides — there is exactly one such group, always trivially "matched"
//      (no cross-build id-stability question applies to a sentinel that
//      means "not owned by any module"). A (module, ordinal) pair present
//      on only one side, or belonging to an unmatched/ambiguous module, is
//      an unmatched row (`original`/`rebuilt` null on the missing side) —
//      never dropped, never guessed at (this lane's contract).
//
// `totals`/`ratio` are independent of matching too, by design: the sum of
// EVERY function's own size on each side, so they hold even when part 1's
// row-level match is entirely empty on one side (the construct-fixture case:
// a plain script's decompiled-then-recompiled form gains an extra top-level
// IIFE wrapper function hermesc's own compile of `decompile()`'s
// `(function () { ... })();` output introduces, shifting every ordinal by
// one or two and leaving almost every row unmatched — `ratio` and
// `histogram` still answer the two questions this tool exists for).
import { createHash } from "node:crypto";
import { buildInventoryFromModule, type InventoryModule } from "../deps/inventory.ts";
import { decodeFunction } from "../disasm/decode.ts";
import { decompile } from "../decompile.ts";
import { parseHbc } from "../parse/module.ts";
import { type AstNode, parseJs, walk } from "../util/js-ast.ts";

export type Shape = "reflect-apply" | "labelled-break" | "state-machine-switch" | "other";

export interface SizeDiffFunctionSide {
  readonly fn: number;
  readonly size: number;
}

export interface SizeDiffFunctionRow {
  /** The function's own module's LOCAL id on the `original` side; `null`
   *  for the "not owned by any module" sentinel group (see the module doc
   *  comment) or when the function's module has no counterpart on this
   *  side at all. Two rows can legitimately show the SAME `ordinal` under
   *  different `originalModule`/`rebuiltModule` values — they are not
   *  jointly a key, `(originalModule, rebuiltModule, ordinal)` is. */
  readonly originalModule: number | null;
  /** The function's own module's LOCAL id on the `rebuilt` side — may
   *  differ from `originalModule` even for a correctly matched module,
   *  since local ids are not stable across builds (I1, see module doc
   *  comment); `null` when there is no `rebuilt` counterpart. */
  readonly rebuiltModule: number | null;
  readonly ordinal: number;
  readonly original: SizeDiffFunctionSide | null;
  readonly rebuilt: SizeDiffFunctionSide | null;
  /** `rebuilt.size - original.size`; `null` when either side is missing
   *  (an unmatched row — never a fabricated delta against a made-up 0). */
  readonly delta: number | null;
  /** `null` only when `original` itself is null (a rebuilt-only row: no
   *  original decompiled text exists to classify). */
  readonly shape: Shape | null;
}

export type SizeDiffModuleStatus = "matched" | "original-only" | "rebuilt-only" | "ambiguous";

export interface SizeDiffModuleRow {
  /** The module's own content-identity key (I1) — `"none"` for the "not
   *  owned by any module" sentinel row; a real hash for every other row,
   *  including an `"ambiguous"` one (the key IS the collision — see
   *  `status`). Exposed mainly for debugging/human output, not itself
   *  something a caller should need to join on. */
  readonly key: string;
  /** `status`: `"matched"` — a unique identity on both sides, `original`/
   *  `rebuiltModule` are that module's own local id on each side (may
   *  differ). `"original-only"`/`"rebuilt-only"` — this identity has no
   *  counterpart on the other side at all; the missing side's `*Module` is
   *  `null` and its size/function counts are 0. `"ambiguous"` — this
   *  identity was shared by more than one module on at least one side;
   *  every module sharing it (on either side) gets its OWN row, each with
   *  only one of `originalModule`/`rebuiltModule` set — never guessed at
   *  by picking one to pair (module doc comment). */
  readonly status: SizeDiffModuleStatus;
  readonly originalModule: number | null;
  readonly rebuiltModule: number | null;
  readonly originalSize: number;
  readonly rebuiltSize: number;
  /** `rebuiltSize - originalSize`; still a real number even for an
   *  unmatched/ambiguous row (the missing side is 0, same convention
   *  `originalFunctions`/`rebuiltFunctions` already used) — `status` is
   *  what tells a caller not to read this as a real per-module change. */
  readonly delta: number;
  readonly originalFunctions: number;
  readonly rebuiltFunctions: number;
}

export interface ShapeHistogram {
  readonly "reflect-apply": number;
  readonly "labelled-break": number;
  readonly "state-machine-switch": number;
  readonly other: number;
}

export interface SizeDiffResult {
  readonly totals: { readonly original: number; readonly rebuilt: number; readonly delta: number };
  /** `totals.rebuilt / totals.original`; `0` when `totals.original` is `0`
   *  (an empty original — never a division producing `Infinity`/`NaN` in
   *  the JSON output). */
  readonly ratio: number;
  readonly byModule: readonly SizeDiffModuleRow[];
  readonly byFunction: readonly SizeDiffFunctionRow[];
  /** FUNCTION-level unmatched counts (rows in `byFunction` with one side
   *  null) — unchanged meaning from before I1. See `unmatchedModules` for
   *  the MODULE-level count this fix adds (a module-identity mismatch is
   *  first-class now, not just visible as a pile of unmatched functions). */
  readonly unmatched: { readonly originalOnly: number; readonly rebuiltOnly: number };
  /** MODULE-level unmatched counts (I1) — how many rows in `byModule` are
   *  `"original-only"`/`"rebuilt-only"`/`"ambiguous"`, counting each
   *  colliding module once. Never dropped from `byModule` itself; this is
   *  a convenience total, not the only place to see them. */
  readonly unmatchedModules: { readonly originalOnly: number; readonly rebuiltOnly: number; readonly ambiguous: number };
  /** `original`'s own bytecode function count — see the module doc comment
   *  for why the histogram is guaranteed to sum to exactly this. */
  readonly functionCount: number;
  readonly histogram: ShapeHistogram;
}

interface FnSide {
  readonly fn: number;
  readonly module: number | null;
  readonly size: number;
}

interface SideInventory {
  readonly fns: readonly FnSide[];
  /** The raw per-module inventory rows for THIS side, keyed by their own
   *  LOCAL module id — used only to compute each module's content
   *  identity (`moduleIdentity`) and pair modules across sides (I1); never
   *  used to join functions directly (local ids are not stable across
   *  builds, module doc comment). */
  readonly modules: readonly InventoryModule[];
}

function inventoryOf(bytes: Uint8Array): SideInventory {
  const module = parseHbc(bytes);
  const inventory = buildInventoryFromModule(module);
  const moduleOf = new Map<number, number>();
  for (const m of inventory.modules) {
    if (m.localModuleId === null) continue;
    for (const fnIdx of m.functionIndices) moduleOf.set(fnIdx, m.localModuleId);
  }
  // `buildInventoryFromModule`'s nested-closure walk is ONE LEVEL deep by
  // design ("matches helper closures a module defines" —
  // `src/deps/fingerprint.ts`'s `collectNested`), because `nestedFunctionCount`
  // and `functionSetHash` are sigdb signature inputs and must not change.
  //
  // So close it transitively here, leaving fingerprint/sigdb untouched — but
  // ONLY where ownership is unambiguous. A first-claimant-wins walk was tried
  // and is wrong: a factory that transitively reaches a SHARED helper swallows
  // its whole subtree, which produced modules going 3 -> 515 and 3 -> 1280
  // functions and a median growth of 0.46x for modules >2KB (i.e. most modules
  // "shrinking" inside a bundle 2.6x larger). A function reachable from more
  // than one module's factory therefore stays unattributed (`module: null`)
  // rather than being assigned to whichever module happened to be walked
  // first. This tool's contract is "never guessed at".
  const reachedBy = new Map<number, number | "many">();
  for (const m of inventory.modules) {
    if (m.localModuleId === null) continue;
    const owner = m.localModuleId;
    const stack = [...m.functionIndices];
    const seenHere = new Set<number>(m.functionIndices);
    while (stack.length > 0) {
      const idx = stack.pop()!;
      const prev = reachedBy.get(idx);
      if (prev === undefined) reachedBy.set(idx, owner);
      else if (prev !== owner) reachedBy.set(idx, "many");
      let decoded;
      try { decoded = decodeFunction(module, idx); } catch { continue; }
      for (const insn of decoded.instructions) {
        for (const op of insn.operands) {
          if (op.role !== "function" || seenHere.has(op.value)) continue;
          seenHere.add(op.value);
          stack.push(op.value);
        }
      }
    }
  }
  for (const [idx, owner] of reachedBy) {
    if (owner !== "many") moduleOf.set(idx, owner);
    else moduleOf.delete(idx);
  }
  const fns = module.functions.map((f) => ({
    fn: f.header.index,
    module: moduleOf.get(f.header.index) ?? null,
    size: f.header.bytecodeSizeInBytes,
  }));
  return { fns, modules: inventory.modules };
}

/** fn -> its 0-based rank (by ascending fn index) within its own module
 *  group — the "ordinal" that (module, ordinal) matching keys on, computed
 *  independently on each side (a function's bytecode index itself is not
 *  stable across a decompile+recompile round trip). */
function ordinalsOf(sides: readonly FnSide[]): ReadonlyMap<number, number> {
  const byModule = new Map<number | null, number[]>();
  for (const s of sides) {
    const arr = byModule.get(s.module) ?? [];
    arr.push(s.fn);
    byModule.set(s.module, arr);
  }
  const ordinals = new Map<number, number>();
  for (const arr of byModule.values()) {
    arr.sort((a, b) => a - b);
    arr.forEach((fn, i) => ordinals.set(fn, i));
  }
  return ordinals;
}

/** A module's content-identity key (I1) — a hash of its own sorted literal
 *  string set (factory + one-level-nested closures), independent of its
 *  LOCAL module id on either side. See the module doc comment for why
 *  strings, not a bytecode-shape hash, and why a collision here is
 *  reported (`"ambiguous"`), never silently resolved. */
function moduleIdentity(m: InventoryModule): string {
  return createHash("sha256").update(m.stringConstants.join("\n"), "utf8").digest("hex").slice(0, 24);
}

/** The `"null"` sentinel identity — the "not owned by any module" group is
 *  never subject to cross-side identity matching (there is nothing to
 *  disambiguate: it always means the same thing on both sides), so it gets
 *  a key that can never collide with a real `moduleIdentity()` hash. */
const NULL_MODULE_KEY = "none";

/** `moduleKey` is a canonical pair-key (see `sizeDiff`), never a raw local
 *  module id — split back out by `lastIndexOf(":")` since `ordinal` is
 *  always the last, purely-numeric segment regardless of what separators
 *  `moduleKey` itself contains. */
function keyOf(moduleKey: string, ordinal: number): string {
  return `${moduleKey}:${ordinal}`;
}

interface ModulePairRow {
  readonly key: string;
  readonly status: SizeDiffModuleStatus;
  readonly originalModule: number | null;
  readonly rebuiltModule: number | null;
}

/** Pairs modules across the two sides by content identity (I1) — never by
 *  local id. Groups each side's modules by `moduleIdentity()`; a key with
 *  exactly one module on each side is `"matched"`. Any other combination
 *  (missing on one side, or more than one module sharing the key on either
 *  side) produces one row PER MODULE in that group, each `"ambiguous"` (if
 *  the key had more than one module on the side WITH more than one — note
 *  a key can be ambiguous on one side and simply absent on the other, in
 *  which case every module in the ambiguous group is still `"ambiguous"`,
 *  never demoted to `"original-only"`: there being zero candidates on the
 *  other side does not make the mismatch on THIS side any less of a guess)
 *  or `"original-only"`/`"rebuilt-only"` (exactly one module, zero on the
 *  other side). Never picks a pairing among ambiguous candidates. */
function pairModules(originalModules: readonly InventoryModule[], rebuiltModules: readonly InventoryModule[]): readonly ModulePairRow[] {
  const byKey = (mods: readonly InventoryModule[]): Map<string, number[]> => {
    const out = new Map<string, number[]>();
    for (const m of mods) {
      if (m.localModuleId === null) continue;
      const key = moduleIdentity(m);
      const arr = out.get(key) ?? [];
      arr.push(m.localModuleId);
      out.set(key, arr);
    }
    return out;
  };
  const originalByKey = byKey(originalModules);
  const rebuiltByKey = byKey(rebuiltModules);
  const allKeys = new Set<string>([...originalByKey.keys(), ...rebuiltByKey.keys()]);

  const rows: ModulePairRow[] = [];
  for (const key of allKeys) {
    const origIds = originalByKey.get(key) ?? [];
    const rebIds = rebuiltByKey.get(key) ?? [];
    if (origIds.length === 1 && rebIds.length === 1) {
      rows.push({ key, status: "matched", originalModule: origIds[0]!, rebuiltModule: rebIds[0]! });
      continue;
    }
    const ambiguous = origIds.length > 1 || rebIds.length > 1;
    for (const id of origIds) {
      rows.push({ key, status: ambiguous ? "ambiguous" : "original-only", originalModule: id, rebuiltModule: null });
    }
    for (const id of rebIds) {
      rows.push({ key, status: ambiguous ? "ambiguous" : "rebuilt-only", originalModule: null, rebuiltModule: id });
    }
  }
  return rows;
}

const SHAPE_FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

interface FnBody {
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly body: AstNode;
}

/** Every function-like node's own `BlockStatement` body span, anywhere in
 *  the file (nested or not) — the candidates `mapCommentsToBodies` picks the
 *  innermost enclosing one from. */
function collectFunctionBodies(program: AstNode): readonly FnBody[] {
  const out: FnBody[] = [];
  walk(program, (n) => {
    if (!SHAPE_FUNCTION_TYPES.has(n.type)) return;
    const body = n.body;
    if (isAstNode(body) && body.type === "BlockStatement" && typeof body.start === "number" && typeof body.end === "number") {
      out.push({ bodyStart: body.start, bodyEnd: body.end, body });
    }
  });
  return out;
}

/** Every `// fn#N` marker `src/emit/print.ts` prints as the first line of
 *  each function body, resolved to that function's own AST body node: the
 *  innermost `FnBody` whose span contains the comment (bodies are properly
 *  nested or disjoint in a valid AST, never partially overlapping, so "the
 *  candidate with the latest `bodyStart` that still contains the comment"
 *  is exactly "the nearest enclosing one"). */
function mapCommentsToBodies(comments: readonly AstNode[], bodies: readonly FnBody[]): ReadonlyMap<number, AstNode> {
  const out = new Map<number, AstNode>();
  const fnCommentRe = /^\s*fn#(\d+)/;
  for (const c of comments) {
    const m = typeof c.value === "string" ? fnCommentRe.exec(c.value) : null;
    if (m === null) continue;
    const fn = Number(m[1]);
    const pos = c.start as number;
    let best: FnBody | undefined;
    for (const b of bodies) {
      if (b.bodyStart <= pos && pos < b.bodyEnd && (best === undefined || b.bodyStart > best.bodyStart)) best = b;
    }
    if (best !== undefined) out.set(fn, best.body);
  }
  return out;
}

/** The shape driving ONE function's own body, excluding any nested function
 *  it lexically contains (skipped entirely — neither visited nor descended
 *  into — so a child's own `Reflect.apply`/label/switch is never
 *  double-counted against its parent, same as the retired scanner's
 *  span-blanking). */
function classifyBody(bodyNode: AstNode): Shape {
  let reflectApply = false;
  let hasLabel = false;
  let hasLabelledBreakOrContinue = false;
  let hasWhileTrue = false;
  let hasSwitch = false;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isAstNode(node)) return;
    if (SHAPE_FUNCTION_TYPES.has(node.type)) return; // a nested function: its own `// fn#N` bucket, not this one's
    switch (node.type) {
      case "CallExpression": {
        const callee = node.callee;
        if (isAstNode(callee) && callee.type === "MemberExpression" && callee.computed !== true) {
          const obj = callee.object;
          const prop = callee.property;
          if (isAstNode(obj) && obj.type === "Identifier" && obj.name === "Reflect" && isAstNode(prop) && prop.type === "Identifier" && prop.name === "apply") {
            reflectApply = true;
          }
        }
        break;
      }
      case "LabeledStatement":
        hasLabel = true;
        break;
      case "BreakStatement":
      case "ContinueStatement":
        if (node.label !== null && node.label !== undefined) hasLabelledBreakOrContinue = true;
        break;
      case "WhileStatement":
        if (isAstNode(node.test) && node.test.type === "BooleanLiteral" && node.test.value === true) hasWhileTrue = true;
        break;
      case "SwitchStatement":
        hasSwitch = true;
        break;
      default:
        break;
    }
    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "loc" || key === "range" || key === "extra" || key === "tokens" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
      visit((node as Record<string, unknown>)[key]);
    }
  };
  visit(bodyNode);
  if (reflectApply) return "reflect-apply";
  if (hasLabel && hasLabelledBreakOrContinue) return "labelled-break";
  if (hasWhileTrue && hasSwitch) return "state-machine-switch";
  return "other";
}

/** fn -> the shape driving that ONE function's own printed text. `code`
 *  that fails to parse (an exotic decompiler output shape `@babel/parser`
 *  doesn't accept) degrades to every function landing in `other`, same as
 *  the retired scanner's own "empty decompiled text" fallback — this tool
 *  never refuses outright over the histogram alone (module doc comment). */
async function classifyShapes(code: string): Promise<ReadonlyMap<number, Shape>> {
  if (code.length === 0) return new Map();
  let file: AstNode;
  try {
    file = await parseJs(code);
  } catch {
    return new Map();
  }
  const program = (file as unknown as { program: AstNode }).program;
  const comments = ((file as unknown as { comments?: AstNode[] }).comments ?? []) as AstNode[];
  const bodies = collectFunctionBodies(program);
  const fnToBody = mapCommentsToBodies(comments, bodies);
  const shapes = new Map<number, Shape>();
  for (const [fn, body] of fnToBody) shapes.set(fn, classifyBody(body));
  return shapes;
}

export async function sizeDiff(originalBytes: Uint8Array, rebuiltBytes: Uint8Array): Promise<SizeDiffResult> {
  const originalInv = inventoryOf(originalBytes);
  const rebuiltInv = inventoryOf(rebuiltBytes);
  const originalSides = originalInv.fns;
  const rebuiltSides = rebuiltInv.fns;
  const originalOrdinals = ordinalsOf(originalSides);
  const rebuiltOrdinals = ordinalsOf(rebuiltSides);

  // Pair modules by content identity (I1), never by local id — see
  // `pairModules`'s own doc comment. Each pair row gets its OWN canonical
  // key: a "matched" row's canonical key IS its content-identity key
  // directly, but every unmatched/ambiguous row is namespaced by its own
  // status+local-id so that TWO modules sharing one colliding identity
  // never get folded back together into a single group here.
  const modulePairs = pairModules(originalInv.modules, rebuiltInv.modules);
  const originalLocalToKey = new Map<number, string>();
  const rebuiltLocalToKey = new Map<number, string>();
  const pairByKey = new Map<string, ModulePairRow>();
  for (const row of modulePairs) {
    const canonicalKey = row.status === "matched" ? row.key : `${row.key}\u0001${row.status}\u0001${row.originalModule ?? "-"}\u0001${row.rebuiltModule ?? "-"}`;
    pairByKey.set(canonicalKey, { ...row, key: canonicalKey });
    if (row.originalModule !== null) originalLocalToKey.set(row.originalModule, canonicalKey);
    if (row.rebuiltModule !== null) rebuiltLocalToKey.set(row.rebuiltModule, canonicalKey);
  }
  pairByKey.set(NULL_MODULE_KEY, { key: NULL_MODULE_KEY, status: "matched", originalModule: null, rebuiltModule: null });

  // A local module id that isn't in `originalLocalToKey`/`rebuiltLocalToKey`
  // at all would mean `pairModules` was never given that module — should
  // be unreachable (every module `functionSides`'s `moduleOf` map can name
  // came from the same `inventory.modules` list `pairModules` iterates),
  // but the fallback is namespaced by side+id so it can never be silently
  // folded into the real `NULL_MODULE_KEY` "not owned by any module" group
  // if it ever did happen.
  const canonicalKeyFor = (side: "original" | "rebuilt", localModuleId: number | null): string => {
    if (localModuleId === null) return NULL_MODULE_KEY;
    const map = side === "original" ? originalLocalToKey : rebuiltLocalToKey;
    return map.get(localModuleId) ?? `unpaired\u0001${side}\u0001${localModuleId}`;
  };

  const originalByKey = new Map<string, FnSide>();
  for (const s of originalSides) originalByKey.set(keyOf(canonicalKeyFor("original", s.module), originalOrdinals.get(s.fn)!), s);
  const rebuiltByKey = new Map<string, FnSide>();
  for (const s of rebuiltSides) rebuiltByKey.set(keyOf(canonicalKeyFor("rebuilt", s.module), rebuiltOrdinals.get(s.fn)!), s);

  const allKeys = new Set<string>([...originalByKey.keys(), ...rebuiltByKey.keys()]);

  // "the decompiled/re-emitted source the rebuilt hbc came from" — always
  // `original`'s own decompile, per this module's doc comment. A bundle this
  // tool cannot decompile at all (an unsupported opcode table, say) still
  // answers `totals`/`ratio`/matching — only the histogram degrades, every
  // function landing in `other` rather than the tool refusing outright.
  let decompiledCode = "";
  try {
    decompiledCode = decompile(originalBytes).code;
  } catch {
    decompiledCode = "";
  }
  const shapesByFn = await classifyShapes(decompiledCode);

  const byFunction: SizeDiffFunctionRow[] = [];
  let originalOnly = 0;
  let rebuiltOnly = 0;
  for (const key of allKeys) {
    const sep = key.lastIndexOf(":");
    const canonicalKey = key.slice(0, sep);
    const ordinal = Number(key.slice(sep + 1));
    const pair = pairByKey.get(canonicalKey);
    const o = originalByKey.get(key) ?? null;
    const r = rebuiltByKey.get(key) ?? null;
    if (o === null) rebuiltOnly++;
    if (r === null) originalOnly++;
    byFunction.push({
      originalModule: pair?.originalModule ?? null,
      rebuiltModule: pair?.rebuiltModule ?? null,
      ordinal,
      original: o === null ? null : { fn: o.fn, size: o.size },
      rebuilt: r === null ? null : { fn: r.fn, size: r.size },
      delta: o !== null && r !== null ? r.size - o.size : null,
      shape: o !== null ? (shapesByFn.get(o.fn) ?? "other") : null,
    });
  }
  byFunction.sort((a, b) => (a.originalModule ?? a.rebuiltModule ?? -1) - (b.originalModule ?? b.rebuiltModule ?? -1) || a.ordinal - b.ordinal);

  const byModule: SizeDiffModuleRow[] = [];
  for (const pair of pairByKey.values()) {
    // `NULL_MODULE_KEY`'s own `originalModule`/`rebuiltModule` are BOTH
    // legitimately `null` (it means "not owned by any module", not "no
    // counterpart") -- the `!== null` guard below exists only to keep an
    // unmatched real module's MISSING side at an empty array, so it must
    // not apply to this one sentinel row.
    const origs = pair.key === NULL_MODULE_KEY ? originalSides.filter((s) => s.module === null) : pair.originalModule !== null ? originalSides.filter((s) => s.module === pair.originalModule) : [];
    const rebs = pair.key === NULL_MODULE_KEY ? rebuiltSides.filter((s) => s.module === null) : pair.rebuiltModule !== null ? rebuiltSides.filter((s) => s.module === pair.rebuiltModule) : [];
    if (pair.key === NULL_MODULE_KEY && origs.length === 0 && rebs.length === 0) continue; // no unattributed functions on either side: nothing to report
    const originalSize = origs.reduce((a, s) => a + s.size, 0);
    const rebuiltSize = rebs.reduce((a, s) => a + s.size, 0);
    byModule.push({
      key: pair.key,
      status: pair.status,
      originalModule: pair.originalModule,
      rebuiltModule: pair.rebuiltModule,
      originalSize,
      rebuiltSize,
      delta: rebuiltSize - originalSize,
      originalFunctions: origs.length,
      rebuiltFunctions: rebs.length,
    });
  }
  byModule.sort((a, b) => (a.originalModule ?? a.rebuiltModule ?? -1) - (b.originalModule ?? b.rebuiltModule ?? -1));

  const totalOriginal = originalSides.reduce((a, s) => a + s.size, 0);
  const totalRebuilt = rebuiltSides.reduce((a, s) => a + s.size, 0);

  const histogram: { "reflect-apply": number; "labelled-break": number; "state-machine-switch": number; other: number } = {
    "reflect-apply": 0,
    "labelled-break": 0,
    "state-machine-switch": 0,
    other: 0,
  };
  for (const s of originalSides) {
    const shape = shapesByFn.get(s.fn) ?? "other";
    histogram[shape]++;
  }

  const unmatchedModules = { originalOnly: 0, rebuiltOnly: 0, ambiguous: 0 };
  for (const m of byModule) {
    if (m.status === "original-only") unmatchedModules.originalOnly++;
    else if (m.status === "rebuilt-only") unmatchedModules.rebuiltOnly++;
    else if (m.status === "ambiguous") unmatchedModules.ambiguous++;
  }

  return {
    totals: { original: totalOriginal, rebuilt: totalRebuilt, delta: totalRebuilt - totalOriginal },
    ratio: totalOriginal === 0 ? 0 : totalRebuilt / totalOriginal,
    byModule,
    byFunction,
    unmatched: { originalOnly, rebuiltOnly },
    unmatchedModules,
    functionCount: originalSides.length,
    histogram,
  };
}
