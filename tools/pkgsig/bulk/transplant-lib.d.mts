export declare const FAMILY_OF_HBC: Record<number, string>;
export declare function parseSigFileName(name: string): { pkgVer: string; hbc: number } | null;
export declare function planJobs(names: readonly string[], done?: ReadonlySet<string>): { family: string; pkgVer: string; files: string[] }[];
export declare function transplantPaths<O extends { modules: any[]; functions: any[] }>(old: O, fresh: { modules: any[]; functions: any[] }): { modules: any[]; functions: any[]; modMiss: number; fnMiss: number; ok: boolean };
export declare function sweepStaleWorkDirs(tmpRoot?: string): number;
export declare function withWorkDir<T>(fn: (work: string) => T, opts?: { tmpRoot?: string }): T;
export declare function runBundleJob(
  files: readonly string[],
  deps: { install(): void; bundle(work: string): unknown; perFile(file: string, work: string, ctx: any): Record<string, unknown>; cleanup?(): void },
  opts?: { tmpRoot?: string },
): { file: string; ok: boolean; reason?: string; [k: string]: unknown }[];
