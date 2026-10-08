import type { SigFunction, SigModule } from "../../../src/deps/sigdb-types.ts";
export function computeBaselineUnion(dbDir: string, hbcVersion: number): { hashes: Set<string>; paths: string[]; owners: Map<string, Set<string | null>> };
export function hasCompleteBaselineSet(paths: readonly string[]): boolean;
export function subtractBaseline(
  rawFunctions: readonly SigFunction[],
  rawModules: readonly SigModule[],
  baselineHashes: ReadonlySet<string>,
  opts?: { package?: string; owners?: ReadonlyMap<string, ReadonlySet<string | null>>; legacyExactHashes?: readonly string[] },
): { functions: SigFunction[]; modules: SigModule[] };
