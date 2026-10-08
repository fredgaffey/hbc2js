// src/artifact/semantic-walk.ts — P2.1 §8 step 3-5: the shared per-function
// instruction walker that produces calls.jsonl / globals.jsonl /
// string-uses.jsonl rows in one pass.
//
// Deliberately instruction-level, not a re-walk of the emitted/lowered AST:
// `CallBuiltin` vs a plain `Call` through a global-member chain are
// textually IDENTICAL once lowered (`src/emit/builtins.ts` `resolveBuiltin`
// prints a builtin exactly like a real `Math.floor` global read would print),
// so the only way to tell them
// apart *at all* is the opcode itself. Working at this level also gives an
// exact `CreateClosure`/`CallDirect` def-use for closure edges (the target
// fnIndex is a literal instruction operand — no guessing) and an exact
// string-id for every property/global name (also a literal operand).
//
// Dataflow is deliberately conservative and BLOCK-LOCAL only (reset per CFG
// block), except function parameters (`LoadParam`), which are tracked
// function-wide because Metro's factory params are read-only in every shape
// observed (docs/DECISIONS.md D17i) — mirrors `src/split/tag.ts`'s own
// param-is-copy-propagation-safe assumption. Anything the walker cannot
// prove is left unresolved; the caller turns "unresolved" into `"?"` with a
// `why` (docs/specs/10-artifact-format.md §2.2) rather than guessing.
import { getBuiltinTable } from "../tables/registry.ts";
import type { BuiltinDef } from "../tables/types.ts";
import { siteKey } from "../cfg/types.ts";
import type { ModuleAnalysis } from "../cfg/types.ts";
import type { Instruction } from "../disasm/decode.ts";
import type { HbcModule } from "../parse/types.ts";
import type { CallRow, GlobalRow, StringUseRow, StringUseRole } from "./schema.ts";

const LOAD_ENV = new Set(["LoadFromEnvironment", "LoadFromEnvironmentL"]);
const STORE_ENV = new Set(["StoreToEnvironment", "StoreToEnvironmentL", "StoreNPToEnvironment", "StoreNPToEnvironmentL"]);

const GETBYID = /^(Try)?GetById(Short|Long)?$/;
const PUTBYID = /^(Try)?PutById(Loose|Strict)?(Long)?$/;
const PROPKEY_DEF = /^(PutNewOwnById|DefineOwnById)(Long|Short)?$/;
const CREATE_CLOSURE = new Set(["CreateClosure", "CreateClosureLongIndex", "CreateGeneratorClosure", "CreateGeneratorClosureLongIndex", "CreateAsyncClosure", "CreateAsyncClosureLongIndex"]);
const CALL_SMALL = new Set(["Call1", "Call2", "Call3", "Call4"]);
const CALL_GENERIC = new Set(["Call", "CallLong"]);
const CALL_DIRECT = new Set(["CallDirect", "CallDirectLongIndex"]);
const CALL_BUILTIN = new Set(["CallBuiltin", "CallBuiltinLong"]);
const CALL_NEW = new Set(["Construct", "ConstructLong", "CallWithNewTarget", "CallWithNewTargetLong"]);

/** JSX-runtime factory property/identifier names (`docs/specs/
 *  passes/08-jsx-recovery.md`'s own factory-name set — duplicated here, not
 *  imported, because the index build is deliberately independent of the
 *  pass ladder, file header). A `GetById` off a non-global value with one of
 *  these names, later used as a call's callee, is the `rendersJsx` signal
 *  (`resolveCallSite`'s `"member"` case below) — the artifact's own call
 *  detection, never a text grep over rendered source. */
const JSX_FACTORY_NAMES = new Set(["jsx", "jsxs", "jsxDEV", "createElement"]);

type RegVal =
  | { readonly t: "globalThis" }
  | { readonly t: "global"; readonly name: string }
  | { readonly t: "globalDeep" }
  | { readonly t: "closure"; readonly fn: number }
  | { readonly t: "param"; readonly slot: number }
  | { readonly t: "depMapIndex"; readonly index: number }
  | { readonly t: "constInt"; readonly value: number }
  /** The result of a `GetById` off a non-global value whose property name is
   *  one of `JSX_FACTORY_NAMES` — e.g. `_jsxRuntime.jsx` (Metro's automatic
   *  JSX runtime, required as a module export). Narrowly tracked (only these
   *  four names) so every other property read keeps its existing `"other"`
   *  classification unchanged (calls.jsonl content is byte-identical to
   *  before this addition — the tag is a side channel, not a new callee
   *  kind). */
  | { readonly t: "member"; readonly name: string }
  | { readonly t: "other" };

export interface FactoryInfo {
  /** LoadParam slot of the `require` parameter (1 + JS-declared-param-index;
   *  slot 0 is always `this`) — Metro's factory signature's 2nd declared
   *  param, positionally, per `src/split/rewrite.ts`. */
  readonly requireSlot: number;
  readonly depMapSlot: number;
  readonly deps: readonly number[];
}

/** Reconstruction lane item 5 (eager vs lazy dep edges): what `walkFunction`
 *  needs to recognise a `require(dependencyMap[i])` call made from a NESTED
 *  function the module's factory hosts, not the factory itself. `deps` is
 *  the module's static dependency array (needed to translate a resolved
 *  index into `m:<id>`, same as `FactoryInfo.deps`); `captures` is
 *  `scanFactoryCaptures`'s own output — `"<env>:<slot>"` -> which raw
 *  factory param (`require` the function, or `dependencyMap` the array,
 *  never an already-applied `require()` RESULT) that environment slot
 *  proveably holds, so a `LoadFromEnvironment` read of that exact slot
 *  inside ANY function owned by the module (the factory included, though it
 *  normally reads the param directly via `LoadParam` instead) resolves the
 *  same way `FactoryInfo.requireSlot`/`depMapSlot` resolve a direct
 *  `LoadParam` read. */
export interface ModuleRequireCaptures {
  readonly deps: readonly number[];
  readonly captures: ReadonlyMap<string, "require" | "depMap">;
}

/** Scans a module's own factory instructions for `StoreToEnvironment` sites
 *  that capture the factory's RAW `require`/`dependencyMap` parameter (not
 *  an already-resolved `require(dependencyMap[i])` result) into an
 *  environment slot — the shape Hermes emits whenever a nested function the
 *  factory hosts (an event handler calling `require(dependencyMap[N])`
 *  lazily, say) references either identifier: they are captured once, by
 *  value, the same way any other closed-over local is. Reuses the exact
 *  "trusted only if `LoadParam` is the sole writer of that register in the
 *  whole function" rule `walkFunction`'s own `paramSlotOfReg` uses (file
 *  header) for the STORE side; sound refusal on the ENV side too — two
 *  different values stored to the same slot (or a store this scan cannot
 *  prove) resolve to neither, exactly `points-to.ts`'s own rule for its
 *  module-value lattice (file header, "Sound refusal"), so a slot this scan
 *  cannot prove just reads as an ordinary unresolved value later, same as
 *  before this function existed. Environment identity comes from the
 *  module's already-built `EnvGraph` (`ModuleAnalysis.envGraph.resolvedAt`),
 *  never a hand-rolled `GetEnvironment`-level walk (D20, `points-to.ts`'s
 *  file header repeats the same decision). */
export function scanFactoryCaptures(analysis: ModuleAnalysis, factoryFnIndex: number, factory: FactoryInfo): ReadonlyMap<string, "require" | "depMap"> {
  const decoded = analysis.decoded(factoryFnIndex);
  const cfg = analysis.cfg(factoryFnIndex);
  const resolvedAt = analysis.envGraph.resolvedAt;
  const byOffset = decoded.byOffset;

  const paramWrites = new Map<number, Set<number>>();
  const anyOtherWrite = new Set<number>();
  for (const insn of decoded.instructions) {
    const dst = insn.operands[0];
    if (dst === undefined || (dst.type !== "Reg8" && dst.type !== "Reg32")) continue;
    if (insn.name === "LoadParam" || insn.name === "LoadParamLong") {
      const set = paramWrites.get(dst.value) ?? new Set<number>();
      set.add(V(insn, 1));
      paramWrites.set(dst.value, set);
    } else {
      anyOtherWrite.add(dst.value);
    }
  }
  const paramSlotOfReg = new Map<number, number>();
  for (const [reg, slots] of paramWrites) {
    if (slots.size === 1 && !anyOtherWrite.has(reg)) paramSlotOfReg.set(reg, [...slots][0]!);
  }

  const found = new Map<string, "require" | "depMap">();
  const conflicted = new Set<string>();
  const blocks = [...cfg.blocks].sort((a, b) => a.start - b.start);
  for (const block of blocks) {
    for (let off = block.start; off < block.end; ) {
      const i = byOffset.get(off);
      if (i === undefined) break;
      const insn = decoded.instructions[i]!;
      off = insn.offset + insn.length;
      if (!STORE_ENV.has(insn.name)) continue;
      const env = resolvedAt.get(siteKey(factoryFnIndex, insn.offset));
      if (env === undefined) continue;
      const key = `${env}:${V(insn, 1)}`;
      if (conflicted.has(key)) continue;
      const slot = paramSlotOfReg.get(V(insn, 2));
      const kind: "require" | "depMap" | undefined = slot === factory.requireSlot ? "require" : slot === factory.depMapSlot ? "depMap" : undefined;
      const existing = found.get(key);
      if (existing === undefined) {
        if (kind !== undefined) found.set(key, kind);
        else conflicted.add(key); // a store this scan cannot prove — refuse rather than guess
      } else if (kind !== existing) {
        found.delete(key);
        conflicted.add(key);
      }
    }
  }
  return found;
}

export interface WalkResult {
  readonly calls: CallRow[];
  /** (g, access) -> n, per this one function; caller sorts/merges across fns. */
  readonly globals: Map<string, number>;
  /** (sid, role) -> n, per this one function. */
  readonly stringUses: Map<string, number>;
  /** §2.1 `rendersJsx` (reconstruction lane item 1): true when THIS
   *  function's own call sites resolve to a JSX-factory callee — either a
   *  `member` value (`JSX_FACTORY_NAMES`, the common `_jsxRuntime.jsx(...)`
   *  shape) or a direct global call (`g:jsx`/`g:createElement`/…, the rare
   *  un-bundled-global shape). Nested functions are NOT walked here — the
   *  caller (`buildFunctionsIndex`) tags each function independently from
   *  its own row; module-level aggregation ("factory or any function it
   *  owns") happens once, in `buildModulesIndex`, over `fnOwnership`. */
  readonly rendersJsx: boolean;
}

export interface StringUseSite {
  readonly sid: number;
  readonly role: StringUseRole;
  readonly pc: number;
  readonly opcode: string;
}

const V = (insn: Instruction, i: number): number => insn.operands[i]!.value;

function builtinName(def: BuiltinDef | undefined, number: number): string {
  if (def === undefined) return `#${number}`;
  if (def.object !== undefined && def.method !== undefined) {
    return def.object === "globalThis" ? def.method : `${def.object}.${def.method}`;
  }
  return def.name;
}

/** Walks one function's instructions (CFG-block-local dataflow) and returns
 *  its call sites (in encounter order — the function's own bytecode is laid
 *  out in source order by hermesc, so this is a stable, deterministic,
 *  render-independent stand-in for "AST order", §9 ruling 1) plus global
 *  access and string-use tallies. */
export function walkFunction(
  module: HbcModule,
  analysis: ModuleAnalysis,
  fnIndex: number,
  factory: FactoryInfo | undefined,
  /** Reconstruction lane item 5: given only when `fnIndex` is NOT the
   *  module's own factory but IS owned by one (`fnOwnership`) — lets a
   *  nested closure's `require(dependencyMap[i])` call resolve the same way
   *  the factory's own direct call does, via `scanFactoryCaptures`'s
   *  environment-slot map instead of `LoadParam`. */
  moduleCaptures?: ModuleRequireCaptures,
  onSite?: (site: StringUseSite) => void,
): WalkResult {
  const decoded = analysis.decoded(fnIndex);
  const cfg = analysis.cfg(fnIndex);
  const builtinId = module.layout.builtinTable;
  const builtins = builtinId === undefined ? undefined : getBuiltinTable(builtinId);
  const strings = module.strings;
  // Effective require/depMap identity for THIS walk: the factory's own
  // `LoadParam` slots when `fnIndex` IS the factory (unchanged from before
  // this addition), or two sentinel slot numbers (never producible by a
  // real `LoadParam`, whose slots are >=1) standing in for "the captured
  // require param" / "the captured dependencyMap param" when `fnIndex` is a
  // nested function reached via `moduleCaptures` instead.
  const effRequireSlot = factory?.requireSlot ?? (moduleCaptures !== undefined ? -1 : undefined);
  const effDepMapSlot = factory?.depMapSlot ?? (moduleCaptures !== undefined ? -2 : undefined);
  const effDeps = factory?.deps ?? moduleCaptures?.deps;

  const calls: CallRow[] = [];
  const globals = new Map<string, number>();
  const stringUses = new Map<string, number>();
  let site = 0;

  const bumpGlobal = (g: string, access: "read" | "write" | "call"): void => {
    const key = `${g} ${access}`;
    globals.set(key, (globals.get(key) ?? 0) + 1);
  };
  const bumpString = (sid: number, role: StringUseRole, insn: Instruction): void => {
    const key = `${sid} ${role}`;
    stringUses.set(key, (stringUses.get(key) ?? 0) + 1);
    onSite?.({ sid, role, pc: insn.offset, opcode: insn.name });
  };

  // Function-wide param slots: a register is trusted to hold "param P" only
  // if LoadParam is the ONLY instruction in the whole function that ever
  // writes it (never reused/clobbered) — conservative by construction.
  const paramWrites = new Map<number, Set<number>>(); // dst reg -> set of param slots it was loaded with
  const anyOtherWrite = new Set<number>();
  for (const insn of decoded.instructions) {
    const dst = insn.operands[0];
    if (dst === undefined || (dst.type !== "Reg8" && dst.type !== "Reg32")) continue;
    if (insn.name === "LoadParam" || insn.name === "LoadParamLong") {
      const set = paramWrites.get(dst.value) ?? new Set<number>();
      set.add(V(insn, 1));
      paramWrites.set(dst.value, set);
    } else {
      anyOtherWrite.add(dst.value);
    }
  }
  const paramSlotOfReg = new Map<number, number>();
  for (const [reg, slots] of paramWrites) {
    if (slots.size === 1 && !anyOtherWrite.has(reg)) paramSlotOfReg.set(reg, [...slots][0]!);
  }

  const blocks = [...cfg.blocks].sort((a, b) => a.start - b.start);
  const byOffset = decoded.byOffset;

  const resolveCallSite = (calleeVal: RegVal): { callee: CallRow["callee"]; kind: CallRow["kind"]; why?: string; via?: string } => {
    if (calleeVal.t === "closure") return { callee: calleeVal.fn, kind: "closure" };
    if (calleeVal.t === "global") return { callee: `g:${calleeVal.name}`, kind: "global" };
    if (calleeVal.t === "globalDeep") return { callee: "?", kind: "unknown", why: "deep-global-member" };
    if (calleeVal.t === "param") return { callee: "?", kind: "unknown", why: "computed-callee" };
    // `member` (a `_jsxRuntime.jsx`-shaped callee, §2.1's `JSX_FACTORY_NAMES`
    // only): the callee is still unresolved (`"?"` — WHICH function `.jsx`
    // points at is not proven here, same truth rule as every other unresolved
    // callee, §2.2), but `kind:"method"` + `via:<propertyName>` record the
    // one thing that IS proven — the call went through a property read of
    // exactly this name — so `rendersJsx` (reconstruction lane item 1) can
    // be recomputed by ANY reader of `calls.jsonl` alone, not just this
    // builder. `kind:"method"` was reserved in the schema for exactly this
    // shape and was otherwise never emitted.
    if (calleeVal.t === "member") return { callee: "?", kind: "method", why: "jsx-factory-member", via: calleeVal.name };
    return { callee: "?", kind: "unknown", why: "computed-callee" };
  };

  for (const block of blocks) {
    const regVal = new Map<number, RegVal>();
    const localOf = (reg: number): RegVal => regVal.get(reg) ?? (paramSlotOfReg.has(reg) ? { t: "param", slot: paramSlotOfReg.get(reg)! } : { t: "other" });

    for (let off = block.start; off < block.end; ) {
      const i = byOffset.get(off);
      if (i === undefined) break;
      const insn = decoded.instructions[i]!;
      off = insn.offset + insn.length;
      const name = insn.name;
      const dst = insn.operands[0]?.value;

      // --- value-producing instructions the walker tracks -------------------
      if (name === "LoadParam" || name === "LoadParamLong") {
        // Handled explicitly (not left to the catch-all below) so a param
        // register's classification survives the rest of ITS OWN block —
        // the catch-all would otherwise immediately re-invalidate it right
        // after this load, since `LoadParam` matches none of the specific
        // cases above it. `localOf`'s `paramSlotOfReg` fallback still covers
        // reads in a LATER block, where this block-local `regVal` is fresh.
        if (dst !== undefined) regVal.set(dst, { t: "param", slot: V(insn, 1) });
        continue;
      }
      if (name === "GetGlobalObject") {
        if (dst !== undefined) regVal.set(dst, { t: "globalThis" });
        continue;
      }
      if (CREATE_CLOSURE.has(name)) {
        if (dst !== undefined) regVal.set(dst, { t: "closure", fn: V(insn, 2) });
        continue;
      }
      if (LOAD_ENV.has(name)) {
        // Reconstruction lane item 5: a nested closure reads its captured
        // `require`/`dependencyMap` this way (never `LoadParam` — that only
        // sees THIS function's own declared params). `moduleCaptures` is
        // only ever given for a fn that is NOT the factory itself, so this
        // is additive: unchanged (falls to the catch-all's `{t:"other"}`,
        // same as before this addition) whenever it is absent, e.g. every
        // caller from before this addition (`src/artifact/service.ts`) or
        // a factory's own walk (which reads these params via `LoadParam`).
        if (dst === undefined) continue;
        const env = analysis.envGraph.resolvedAt.get(siteKey(fnIndex, insn.offset));
        const cap = env === undefined ? undefined : moduleCaptures?.captures.get(`${env}:${V(insn, 2)}`);
        if (cap === "require" && effRequireSlot !== undefined) regVal.set(dst, { t: "param", slot: effRequireSlot });
        else if (cap === "depMap" && effDepMapSlot !== undefined) regVal.set(dst, { t: "param", slot: effDepMapSlot });
        else regVal.set(dst, { t: "other" });
        continue;
      }
      if (name === "CallDirect" || name === "CallDirectLongIndex") {
        if (dst !== undefined) regVal.set(dst, { t: "other" }); // the call RESULT, not the callee
      }
      if (GETBYID.test(name)) {
        const objVal = localOf(V(insn, 1));
        const text = strings.get(V(insn, 3));
        const role: StringUseRole = objVal.t === "globalThis" ? "global-name" : "property-get";
        bumpString(V(insn, 3), role, insn);
        if (objVal.t === "globalThis") {
          bumpGlobal(text, "read");
          if (dst !== undefined) regVal.set(dst, { t: "global", name: text });
        } else if (objVal.t === "global") {
          if (dst !== undefined) regVal.set(dst, { t: "globalDeep" });
        } else if (JSX_FACTORY_NAMES.has(text)) {
          if (dst !== undefined) regVal.set(dst, { t: "member", name: text });
        } else {
          if (dst !== undefined) regVal.set(dst, { t: "other" });
        }
        continue;
      }
      if (PUTBYID.test(name)) {
        const objVal = localOf(V(insn, 0));
        const text = strings.get(V(insn, 3));
        bumpString(V(insn, 3), objVal.t === "globalThis" ? "global-name" : "property-put", insn);
        if (objVal.t === "globalThis") bumpGlobal(text, "write");
        continue;
      }
      if (PROPKEY_DEF.test(name)) {
        bumpString(V(insn, insn.operands.length - 1), "property-key", insn);
        continue;
      }
      if (name === "DeclareGlobalVar") {
        bumpGlobal(strings.get(V(insn, 0)), "write");
        continue;
      }
      if (name === "GetByVal" || name === "GetByIndex") {
        // Constant-index reads off the dependencyMap param are how Metro's
        // `require(dependencyMap[i])` looks at this level (§10 the recogniser
        // `src/split/rewrite.ts` uses at the AST level for the same pattern).
        // `GetByIndex`'s operand 2 is a literal immediate (`lower.ts`'s own
        // `num(V(insn, 2))`); `GetByVal`'s operand 2 is a REGISTER holding
        // the index, which must itself be resolved through `localOf` — using
        // the raw operand value there would silently read a register
        // *number* as if it were the index it holds (only coincidentally
        // right when they happen to match).
        const baseVal = localOf(V(insn, 1));
        const indexKnown = name === "GetByIndex" ? V(insn, 2) : localOf(V(insn, 2)).t === "constInt" ? (localOf(V(insn, 2)) as Extract<RegVal, { t: "constInt" }>).value : undefined;
        if (dst !== undefined && baseVal.t === "param" && effDepMapSlot !== undefined && baseVal.slot === effDepMapSlot && indexKnown !== undefined) {
          regVal.set(dst, { t: "depMapIndex", index: indexKnown });
        } else if (dst !== undefined) {
          regVal.set(dst, { t: "other" });
        }
        continue;
      }
      if (name === "LoadConstZero" || name === "LoadConstUInt8" || name === "LoadConstInt") {
        if (dst !== undefined) regVal.set(dst, { t: "constInt", value: name === "LoadConstZero" ? 0 : V(insn, 1) });
        continue;
      }
      if (name === "LoadConstString" || name === "LoadConstStringLongIndex") {
        bumpString(V(insn, 1), "literal", insn);
        if (dst !== undefined) regVal.set(dst, { t: "other" });
        continue;
      }
      if (name === "CreateRegExp") {
        bumpString(V(insn, 1), "regexp", insn);
        bumpString(V(insn, 2), "regexp", insn);
        continue;
      }

      // --- call sites ---------------------------------------------------------
      if (CALL_BUILTIN.has(name)) {
        const number = V(insn, 1);
        const def = builtins?.builtins[number];
        calls.push({ caller: fnIndex, site: site++, callee: `b:${builtinName(def, number)}`, kind: "builtin" });
        if (dst !== undefined) regVal.set(dst, { t: "other" });
        continue;
      }
      if (CALL_DIRECT.has(name)) {
        calls.push({ caller: fnIndex, site: site++, callee: V(insn, 2), kind: "closure", via: "direct" });
        continue;
      }
      if (CALL_SMALL.has(name) || CALL_GENERIC.has(name) || CALL_NEW.has(name)) {
        const calleeVal = localOf(V(insn, 1));
        const kindBase = CALL_NEW.has(name) ? "construct" : undefined;
        // require(dependencyMap[i]): callee resolves to the require param
        // (the factory's own `LoadParam`, or a nested closure's captured
        // copy of it via `moduleCaptures`, reconstruction lane item 5) AND
        // (for the fixed-arity Call2 shape) the sole real argument resolves
        // to a constant dependencyMap index.
        if (effRequireSlot !== undefined && calleeVal.t === "param" && calleeVal.slot === effRequireSlot && kindBase === undefined) {
          const argReg = insn.operands[3]?.value; // operands: dst, callee, this, arg0, …
          const argVal = argReg === undefined ? undefined : localOf(argReg);
          if (insn.operands.length === 4 && argVal !== undefined && argVal.t === "depMapIndex" && argVal.index >= 0 && effDeps !== undefined && argVal.index < effDeps.length) {
            calls.push({ caller: fnIndex, site: site++, callee: `m:${effDeps[argVal.index]}`, kind: "require" });
            if (dst !== undefined) regVal.set(dst, { t: "other" });
            continue;
          }
        }
        const resolved = resolveCallSite(calleeVal);
        calls.push({
          caller: fnIndex,
          site: site++,
          callee: resolved.callee,
          kind: kindBase ?? resolved.kind,
          ...(resolved.why !== undefined ? { why: resolved.why } : {}),
          ...(resolved.via !== undefined ? { via: resolved.via } : {}),
        });
        if (dst !== undefined) regVal.set(dst, { t: "other" });
        continue;
      }
      if (name === "DirectEval") {
        calls.push({ caller: fnIndex, site: site++, callee: "?", kind: "unknown", why: "reflect" });
        if (dst !== undefined) regVal.set(dst, { t: "other" });
        continue;
      }

      // Anything else that writes a register invalidates any previous
      // (possibly stale) classification of that register. Conservative on
      // purpose: `Put*`/`Store*`/`Define*` read their operand 0 rather than
      // writing it (§ walker file header), so they are excluded — for every
      // other opcode, treating a leading register operand as a destination
      // over-invalidates at worst (more `?`, never a wrong resolved edge).
      const op0 = insn.operands[0];
      if (dst !== undefined && op0 !== undefined && (op0.type === "Reg8" || op0.type === "Reg32") && !/^(Put|Store|Define)/.test(name)) {
        regVal.set(dst, { t: "other" });
      }
    }
  }

  calls.sort((a, b) => a.site - b.site);
  return { calls, globals, stringUses, rendersJsx: calls.some(isJsxFactoryCall) };
}

/** §2.1 `rendersJsx`'s predicate over one `calls.jsonl` row — the ONLY two
 *  shapes a JSX-factory call can take in this index (`resolveCallSite`
 *  above): `kind:"method"` with `via` naming the factory (the common
 *  `_jsxRuntime.jsx(...)` shape), or `kind:"global"` with `callee` naming it
 *  directly (the rare un-bundled-global shape, e.g. a hand-written
 *  `createElement` global). Exported so `buildFunctionsIndex`'s per-function
 *  tag and ANY external reader of `calls.jsonl` alone (the artifact-format
 *  test, `docs/specs/10-artifact-format.md`) compute the identical answer
 *  from the identical rows — never two divergent definitions of the same
 *  tag. */
export function isJsxFactoryCall(c: CallRow): boolean {
  if (c.kind === "method" && typeof c.via === "string") return JSX_FACTORY_NAMES.has(c.via);
  if (c.kind === "global" && typeof c.callee === "string" && c.callee.startsWith("g:")) return JSX_FACTORY_NAMES.has(c.callee.slice(2));
  return false;
}

export interface SemanticIndexes {
  readonly callRows: CallRow[];
  readonly globalRows: GlobalRow[];
  readonly stringUseRows: StringUseRow[];
  /** §2.1 `rendersJsx`: fnIndex -> whether that function's own call sites
   *  resolve to a JSX-factory callee (`walkFunction`'s own `rendersJsx`,
   *  one entry per function — never fabricated for a function the walker
   *  didn't visit, so a lookup miss is itself meaningful only as "not walked
   *  here", which `buildFunctionsIndex` never lets happen since it iterates
   *  `module.functions` the same way this builder does). */
  readonly rendersJsxByFn: ReadonlyMap<number, boolean>;
}

/** §2.2/§2.3b/§2.4 combined: walks every function's instructions EXACTLY
 *  ONCE and derives `calls.jsonl` + `globals.jsonl` + `string-uses.jsonl`
 *  from that one pass, rather than three independent whole-module walks
 *  (the original shape — separate `buildCallsIndex`/`buildGlobalsIndex`/
 *  `buildStringUsesIndex` each re-walked every function's block-local
 *  dataflow from scratch). `walkFunction` itself is the expensive part of
 *  the index build (`decoded`/`cfg` are memoized in `ModuleAnalysis`, so the
 *  walk's own per-instruction loop was the real 3x — docs/BUGS.md
 *  2026-09-03 "index build 51.4% of decompile" row); this cuts the walk
 *  count 3x -> 1x. Output rows and sort orders are byte-identical to the
 *  three-pass version (§1.1 primary-key sorts unchanged). */
export function buildSemanticIndexes(module: HbcModule, analysis: ModuleAnalysis, factoryOf: ReadonlyMap<number, FactoryInfo>, ownership: ReadonlyMap<number, number | null>): SemanticIndexes {
  const callRows: CallRow[] = [];
  const stringUseRows: StringUseRow[] = [];
  const perFnGlobals = new Map<number, Map<string, number>>();
  const rendersJsxByFn = new Map<number, boolean>();

  // Reconstruction lane item 5: one `ModuleRequireCaptures` per module
  // (keyed by module id, via `ownership.get(factoryFnIndex)` — "a factory
  // owns itself", `computeFnOwnership`'s own doc), computed once from each
  // module's factory before the main walk below, so every nested function
  // that walk reaches can resolve its captured `require`/`dependencyMap`
  // the same pass the factory's own direct calls already do.
  const capturesByModuleId = new Map<number, ModuleRequireCaptures>();
  for (const [factoryFnIndex, info] of factoryOf) {
    const moduleId = ownership.get(factoryFnIndex);
    if (moduleId === null || moduleId === undefined) continue;
    capturesByModuleId.set(moduleId, { deps: info.deps, captures: scanFactoryCaptures(analysis, factoryFnIndex, info) });
  }

  for (const fn of module.functions) {
    const factory = factoryOf.get(fn.header.index);
    const moduleId = ownership.get(fn.header.index);
    const moduleCaptures = factory === undefined && moduleId !== undefined && moduleId !== null ? capturesByModuleId.get(moduleId) : undefined;
    const { calls, globals, stringUses, rendersJsx } = walkFunction(module, analysis, fn.header.index, factory, moduleCaptures);
    callRows.push(...calls);
    perFnGlobals.set(fn.header.index, globals);
    rendersJsxByFn.set(fn.header.index, rendersJsx);
    for (const [key, n] of stringUses) {
      const [sidText, role] = key.split("\0") as [string, StringUseRole];
      stringUseRows.push({ sid: Number(sidText), fn: fn.header.index, role, n });
    }
  }
  callRows.sort((a, b) => a.caller - b.caller || a.site - b.site);
  stringUseRows.sort((a, b) => a.sid - b.sid || a.fn - b.fn || a.role.localeCompare(b.role));

  // §2.4: fold in `call` access from the `g:` call rows just computed, so
  // globals.jsonl and calls.jsonl agree by construction (native.jsonl's
  // checker projects both).
  for (const call of callRows) {
    if (typeof call.callee !== "string" || !call.callee.startsWith("g:")) continue;
    const name = call.callee.slice(2);
    const m = perFnGlobals.get(call.caller) ?? new Map<string, number>();
    const key = `${name}\0call`;
    m.set(key, (m.get(key) ?? 0) + 1);
    perFnGlobals.set(call.caller, m);
  }
  const globalRows: GlobalRow[] = [];
  for (const [fn, m] of perFnGlobals) {
    for (const [key, n] of m) {
      const [g, access] = key.split("\0") as [string, GlobalRow["access"]];
      globalRows.push({ g, fn, access, n });
    }
  }
  globalRows.sort((a, b) => (a.g < b.g ? -1 : a.g > b.g ? 1 : a.fn - b.fn || a.access.localeCompare(b.access)));

  return { callRows, globalRows, stringUseRows, rendersJsxByFn };
}
