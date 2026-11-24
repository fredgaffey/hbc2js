// src/deps/version-evidence.ts -- framework versions read straight out of the
// bundle's own constants (stronger than any signature-DB nearest match):
//   * react-native: `Libraries/Core/ReactNativeVersion.js`'s
//     `exports.version = {major, minor, patch, prerelease}` module;
//   * react: the `version` string constant of the `react` package module
//     (`exports.version = "19.2.0"`).
// Pure functions over decoded instructions / string sets so they unit-test
// without a bundle; `detectVersionEvidence` glues them to a parsed module.
import { decodeFunction } from "../disasm/decode.ts";
import type { Instruction } from "../disasm/decode.ts";
import { objectBufferValues, objectKeysTolerant } from "../emit/literals.ts";
import type { HbcModule } from "../parse/types.ts";

export interface VersionEvidence {
  /** `major.minor.patch` (plus `-prerelease`-less) from the RN version module. */
  readonly reactNative?: string;
  readonly react?: string;
}

export interface InstructionLike {
  readonly name: string;
  readonly operands: readonly { readonly value: number }[];
}

const VERSION_KEYS = new Set(["major", "minor", "patch"]);

/** Linear register scan over one function: numeric constants loaded into a
 *  register and then stored under the property names major/minor/patch.
 *  Returns "M.m.p" only when all three were found. */
export function rnVersionFromInstructions(insns: readonly InstructionLike[], stringOf: (id: number) => string | null): string | null {
  const regs = new Map<number, number>();
  const found = new Map<string, number>();
  for (const insn of insns) {
    const n = insn.name;
    const o = insn.operands;
    if (n === "LoadConstZero" && o[0] !== undefined) {
      regs.set(o[0].value, 0);
      continue;
    }
    if ((n === "LoadConstUInt8" || n === "LoadConstInt" || n === "LoadConstDouble") && o[0] !== undefined && o[1] !== undefined) {
      regs.set(o[0].value, o[1].value);
      continue;
    }
    if ((n.startsWith("PutById") || n.startsWith("PutNewOwnById")) && o.length >= 3) {
      const name = stringOf(o[o.length - 1]!.value);
      const v = regs.get(o[1]!.value);
      if (name !== null && VERSION_KEYS.has(name) && v !== undefined && !found.has(name)) found.set(name, v);
      continue;
    }
    if (n.startsWith("Put") || n.startsWith("Store") || n === "Ret" || n.startsWith("J")) continue;
    if (o[0] !== undefined) regs.delete(o[0].value); // any other instruction may overwrite its dest register
  }
  if (!found.has("major") || !found.has("minor") || !found.has("patch")) return null;
  return `${found.get("major")}.${found.get("minor")}.${found.get("patch")}`;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
// Markers only the `react` package module itself carries together.
const REACT_MARKERS = ["cloneElement", "createElement", "Fragment", "StrictMode", "Suspense", "$$typeof"];

/** The `react` package's version constant: a bare semver string inside a
 *  module that also holds the react element API's names. Null when absent. */
export function reactVersionFromStrings(stringSets: Iterable<readonly string[]>): string | null {
  for (const strings of stringSets) {
    const ver = strings.find((s) => SEMVER.test(s) && Number(s.split(".")[0]) >= 15);
    if (ver === undefined) continue;
    if (REACT_MARKERS.every((m) => strings.includes(m))) return ver;
  }
  return null;
}

/** Older RN builds (<= 0.72 shape) emit `{major: 0, minor: 72, patch: 17, ...}`
 *  as one `NewObjectWithBuffer*`: keys and numeric values live in the literal
 *  buffers, not in register loads. */
function rnVersionFromObjectBuffer(mod: HbcModule, insns: readonly Instruction[]): string | null {
  for (const insn of insns) {
    if (!insn.name.startsWith("NewObjectWithBuffer")) continue;
    const o = insn.operands;
    let keys: readonly string[] | null | undefined;
    let vals: readonly ({ readonly kind: string; readonly value?: number } | null)[] | null | undefined;
    try {
      if (mod.header.version < 97 && o.length === 5) {
        const count = o[2]!.value;
        keys = objectKeysTolerant(mod, o[3]!.value, count);
        vals = objectBufferValues(mod, o[4]!.value, count) as typeof vals;
      } else if (mod.header.version >= 97 && (o.length === 3 || o.length === 4)) {
        const shape = mod.shapes[o[o.length - 2]!.value];
        if (shape === undefined) continue;
        keys = objectKeysTolerant(mod, shape.keyBufferOffset, shape.numProps);
        vals = objectBufferValues(mod, o[o.length - 1]!.value, shape.numProps) as typeof vals;
      }
    } catch {
      continue;
    }
    if (!keys || !vals) continue;
    const got = new Map<string, number>();
    keys.forEach((k, i) => {
      const v = vals![i];
      if (VERSION_KEYS.has(k) && v && (v.kind === "integer" || v.kind === "number") && typeof v.value === "number") got.set(k, v.value);
    });
    if (got.size === 3) return `${got.get("major")}.${got.get("minor")}.${got.get("patch")}`;
  }
  return null;
}

export function detectVersionEvidence(mod: HbcModule, modules: readonly { readonly stringConstants: readonly string[]; readonly functionIndices: readonly number[] }[]): VersionEvidence {
  const out: { reactNative?: string; react?: string } = {};
  const react = reactVersionFromStrings(modules.map((m) => m.stringConstants));
  if (react !== null) out.react = react;
  const stringOf = (id: number): string | null => {
    try {
      return mod.strings.get(id);
    } catch {
      return null;
    }
  };
  for (const m of modules) {
    const s = m.stringConstants;
    if (!(s.includes("major") && s.includes("minor") && s.includes("patch") && s.includes("prerelease"))) continue;
    for (const fi of m.functionIndices) {
      let insns: readonly Instruction[];
      try {
        insns = decodeFunction(mod, fi).instructions as readonly Instruction[];
      } catch {
        continue;
      }
      const v = rnVersionFromInstructions(insns, stringOf) ?? rnVersionFromObjectBuffer(mod, insns);
      if (v !== null) {
        out.reactNative = v;
        return out;
      }
    }
  }
  return out;
}
