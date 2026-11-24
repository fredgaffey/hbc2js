// Type declaration for `gen-junk.mjs` (strict tsconfig, no allowJs), same
// convention as tools/appgen/generate.d.mts.
export interface JunkFunction {
  readonly name: string;
  readonly module: string;
  readonly exported: boolean;
  readonly level: number;
  readonly callees: readonly string[];
  readonly arg: number;
  readonly form: "function" | "arrow";
}
export interface JunkModule {
  readonly path: string;
  readonly functions: readonly string[];
  readonly imports: readonly string[];
}
export interface JunkResult {
  readonly files: [string, string][];
  readonly functions: JunkFunction[];
  readonly modules: JunkModule[];
}
export function entryArg(name: string): number;
export function generateJunk(seed: string | number, count: number, opts?: { perModule?: number; modulesPerDir?: number }): JunkResult;
