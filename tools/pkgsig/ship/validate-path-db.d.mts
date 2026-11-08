export interface PathDbReport {
  dir: string; files: number; errors: string[]; parseErrors: number; withPaths: number;
  pathless: string[]; schemes: Record<string, number>; hbc: Record<string, number>;
  modules: number; modulesWithPath: number; functions: number; functionsWithModuleId: number;
  filesLowCoverage: string[]; duplicates: string[]; missingFromOut: string[]; extraInOut: string[];
  srcFiles: number | null; modulePathCoveragePct: number | null; functionModuleIdCoveragePct: number | null;
  filesWithPathsPct: number | null; ok: boolean;
}
export function validateDb(dir: string, opts?: { src?: string }): PathDbReport;
