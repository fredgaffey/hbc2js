export declare const FAMILY_OF_HBC: Record<number, string>;
export declare function parseSigFileName(name: string): { pkgVer: string; hbc: number } | null;
export declare function planJobs(names: readonly string[], done?: ReadonlySet<string>): { family: string; pkgVer: string; files: string[] }[];
export declare function transplantPaths<O extends { modules: any[]; functions: any[] }>(old: O, fresh: { modules: any[]; functions: any[] }): { modules: any[]; functions: any[]; modMiss: number; fnMiss: number; ok: boolean };
