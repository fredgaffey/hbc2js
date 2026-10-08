
export const BOOT_TIMING_MARKER: "__HBC_BOOT_TIMING__";

export interface BootTimingRecord {
  readonly id: number;
  readonly t0: number;
  readonly dt: number;
}

export interface ArtifactIndexEntry {
  readonly owner: string | null;
  readonly bucket: string | null;
  readonly path: string | null;
}

export interface ModuleSummaryRow {
  readonly id: number;
  readonly selfMs: number;
  readonly package: string;
  readonly path: string | null;
}

export interface ModuleSummary {
  readonly rows: readonly ModuleSummaryRow[];
  readonly top: readonly ModuleSummaryRow[];
  readonly totalMs: number;
  readonly moduleCount: number;
  readonly unattributedModuleCount: number;
  readonly unattributedSelfMs: number;
}

export function parseDump(text: string): BootTimingRecord[];
export function loadArtifactIndex(indexJson: { readonly modules?: readonly Record<string, unknown>[] }): Map<number, ArtifactIndexEntry>;
export function packageFor(index: Map<number, ArtifactIndexEntry>, id: number): string;
export function computeSelfTimes(records: readonly BootTimingRecord[]): Map<number, number>;
export function summarizeModules(records: readonly BootTimingRecord[], index: Map<number, ArtifactIndexEntry>, topN?: number): ModuleSummary;
export function formatReport(summary: ModuleSummary): string;
