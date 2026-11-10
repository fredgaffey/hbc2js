export interface Packument { latest: string | null; versions: Record<string, { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }> }
export interface PopulationRow { name: string; version: string; hop: number; parents: number; corpusApps: number; score: number }
export function dbVersions(fileNames: readonly string[], hv: number): Map<string, Set<string>>;
export function skipName(name: string): boolean;
export function pickVersion(versions: readonly string[], ranges: readonly string[], latest: string | null): string | null;
export function planPopulation(opts: {
  seeds: Map<string, Set<string>>;
  existing: Set<string>;
  corpus?: Map<string, number>;
  getPackument: (name: string) => Promise<Packument | null>;
  hops?: number;
  cap?: number;
}): Promise<{ selected: PopulationRow[]; total: number; unresolved: string[] }>;
export function family(name: string): string;
export function registryFetcher(cachePath: string | null, concurrency: number): { get: (name: string) => Promise<Packument | null>; save: () => void };
