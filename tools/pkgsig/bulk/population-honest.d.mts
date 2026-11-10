import type { Packument } from "./population-closure.mjs";
export interface DeclaredEntry { ranges: string[]; sources: string[] }
export interface HonestJob { name: string; version: string; hbc: number; tier: "declared" | "top"; rank: number | null; phase: 1 | 2 }
export function declaredRanges(opts: {
  expo?: { label: string; bundledNativeModules?: Record<string, string>; dependencies?: Record<string, string> }[];
  template?: { label: string; dependencies?: Record<string, string> }[];
}): Map<string, DeclaredEntry>;
export function versionsFor(p: Packument, ranges: readonly string[] | null, priorMajors: number): string[];
export function planHonest(opts: {
  declared: Map<string, DeclaredEntry>;
  topDownload: readonly string[];
  top?: number;
  existing: Map<number, Map<string, Set<string>>>;
  hbcs: readonly number[];
  getPackument: (name: string) => Promise<Packument | null>;
  priorMajors?: number;
  cap?: number;
}): Promise<{ all: HonestJob[]; selected: HonestJob[]; names: number; unresolved: string[] }>;
