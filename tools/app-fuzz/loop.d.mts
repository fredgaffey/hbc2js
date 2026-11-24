// Type declaration for `loop.mjs` (only what tests import).
export interface SeedConfig { seed: number; profile: string; hbc: number; minify: boolean; obfuscate: boolean; headlessOnly: boolean; functions: number; size: number }
export function seedConfig(seed: number, profile: string): SeedConfig;
export function guidedWeights(cov: { seeds: number; feature: Record<string, number>; assoc: Record<string, Record<string, number>> }): Record<string, number>;
export function crashSig(log: string): string;
export function hermesVmFor(v: number): string | null;
