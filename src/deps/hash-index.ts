// Hash-index candidate proposal (corpus-recall-candidates, docs/DEPS.md
// "Hash-index candidate proposal"). Candidate pre-selection (`candidates.ts`)
// proposes a package only when its NAME appears in the bundle's strings or it
// is a recorded dependency of such a package. Many truth packages have a
// signature at the target's HBC version and their own function hashes in the
// target, yet nothing names them (`is-callable`, `js-base64`, `asn1.js`).
//
// This module adds one more evidence source: a precomputed reverse index,
// one file per HBC version stored beside the signature files
// (`candidate-hash-index__hbc<N>.tsv`), mapping each DISTINCTIVE function
// hash (own function, instrCount >= minInstr, owned by exactly one package
// name across every version in the DB) to the package that owns it. At run time the file is
// scanned once as a Buffer and only the lines whose hash occurs in the target
// are kept, so no signature file is parsed and memory stays flat no matter
// how large the DB is. A package becomes a candidate when at least `minHits`
// of its unique hashes appear in the target AND they are at least
// `minCoverage` of all its unique hashes in the index. The coverage clause is
// what keeps precision: a signature that still carries a copy of another
// package's code (an unsubtracted dependency, an inlined helper library)
// hits on that copy, which is a small part of its own unique code, while a
// package that is really in the bundle hits on most of it. Measured on five
// truth apps (docs/DEPS.md): confirmed false positives proposed this way sat
// at coverage <= 0.31 except two, true positives mostly above 0.4. Proposal only loads the
// package's signatures for scoring; the match stage's own bar still decides
// whether anything is confirmed.
//
// Format: line 1 is `#hbc2js-candidate-hash-index 1 <json header>` with
// `{hbcVersion, minInstr, maxOwners, packages: string[]}`; every following
// line is `<exactHash>\t<packageId>[,<packageId>]`, sorted by hash.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DbLayer } from "./db.ts";
import type { ModuleInventory } from "./inventory.ts";
import type { SigDbFile } from "./sigdb-types.ts";

export const HASH_INDEX_MAGIC = "#hbc2js-candidate-hash-index 1 ";
export const DEFAULT_INDEX_MIN_INSTR = 8;
export const DEFAULT_INDEX_MAX_OWNERS = 1;
export const DEFAULT_MIN_HITS = 3;
export const DEFAULT_MIN_COVERAGE = 1 / 3;

export function hashIndexFileName(hbcVersion: number): string {
  return `candidate-hash-index__hbc${hbcVersion}.tsv`;
}

export interface HashIndexHeader {
  readonly hbcVersion: number;
  readonly minInstr: number;
  readonly maxOwners: number;
  readonly packages: readonly string[];
}

export interface BuildHashIndexOptions {
  readonly minInstr?: number;
  readonly maxOwners?: number;
  readonly readFile?: (path: string) => string;
}

/** Builds the index text for every non-baseline, hash-scheme-2 signature
 *  file in `dir` at `hbcVersion`. Each file is parsed once and dropped. */
export function buildCandidateHashIndex(dir: string, hbcVersion: number, opts: BuildHashIndexOptions = {}): string {
  const minInstr = opts.minInstr ?? DEFAULT_INDEX_MIN_INSTR;
  const maxOwners = opts.maxOwners ?? DEFAULT_INDEX_MAX_OWNERS;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const suffix = `__hbc${hbcVersion}.json`;
  const packages: string[] = [];
  const ids = new Map<string, number>();
  // hash -> owning package ids; null once more than maxOwners own it.
  const owners = new Map<string, number[] | null>();
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(suffix)) continue;
    let file: SigDbFile;
    try {
      file = JSON.parse(readFile(join(dir, name))) as SigDbFile;
    } catch {
      continue;
    }
    if (file.toolchainBaseline || file.hbcVersion !== hbcVersion || (file.hashScheme ?? 1) < 2) continue;
    let id = ids.get(file.package);
    if (id === undefined) {
      id = packages.length;
      packages.push(file.package);
      ids.set(file.package, id);
    }
    for (const fn of file.functions) {
      if (fn.instrCount < minInstr) continue;
      if (fn.owner !== undefined && fn.owner !== null && fn.owner !== file.package) continue;
      const cur = owners.get(fn.exactHash);
      if (cur === null) continue;
      if (cur === undefined) owners.set(fn.exactHash, [id]);
      else if (!cur.includes(id)) owners.set(fn.exactHash, cur.length >= maxOwners ? null : [...cur, id]);
    }
  }
  const header: HashIndexHeader = { hbcVersion, minInstr, maxOwners, packages };
  const lines: string[] = [];
  for (const [hash, o] of owners) if (o !== null) lines.push(`${hash}\t${o.join(",")}`);
  lines.sort();
  return `${HASH_INDEX_MAGIC}${JSON.stringify(header)}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

/** Builds and writes `<outDir>/candidate-hash-index__hbc<N>.tsv`; returns its path. */
export function writeCandidateHashIndex(sigDir: string, outDir: string, hbcVersion: number, opts: BuildHashIndexOptions = {}): string {
  const path = join(outDir, hashIndexFileName(hbcVersion));
  writeFileSync(path, buildCandidateHashIndex(sigDir, hbcVersion, opts));
  return path;
}

export interface ProposeOptions {
  readonly minHits?: number;
  readonly minCoverage?: number;
}

/** Packages with at least `minHits` of their unique indexed hashes present in
 *  the target, covering at least `minCoverage` of their unique hashes, per
 *  layer that carries an index for the target's HBC version. Layers without
 *  one contribute nothing. Lines naming several packages (an index built
 *  with maxOwners > 1) are not evidence for any of them. */
export function proposeFromHashIndex(layers: readonly DbLayer[], inventory: ModuleInventory, opts: ProposeOptions = {}): ReadonlySet<string> {
  const minHits = opts.minHits ?? DEFAULT_MIN_HITS;
  const minCoverage = opts.minCoverage ?? DEFAULT_MIN_COVERAGE;
  const out = new Set<string>();
  for (const layer of layers) {
    const path = join(layer.dir, hashIndexFileName(inventory.hbcVersion));
    if (!existsSync(path)) continue;
    const buf = readFileSync(path);
    const nl = buf.indexOf(10);
    if (nl < 0) continue;
    const first = buf.toString("utf8", 0, nl);
    if (!first.startsWith(HASH_INDEX_MAGIC)) continue;
    const header = JSON.parse(first.slice(HASH_INDEX_MAGIC.length)) as HashIndexHeader;
    if (header.hbcVersion !== inventory.hbcVersion) continue;
    const target = new Set<string>();
    for (const fn of inventory.functions) if (fn.instrCount >= header.minInstr) target.add(fn.exactHash);
    const hits = new Map<number, number>();
    const unique = new Map<number, number>();
    let start = nl + 1;
    while (start < buf.length) {
      let end = buf.indexOf(10, start);
      if (end < 0) end = buf.length;
      const tab = buf.indexOf(9, start);
      if (tab > start && tab < end) {
        const comma = buf.indexOf(44, tab);
        if (comma < 0 || comma >= end) {
          const id = Number(buf.toString("latin1", tab + 1, end));
          unique.set(id, (unique.get(id) ?? 0) + 1);
          if (target.has(buf.toString("latin1", start, tab))) hits.set(id, (hits.get(id) ?? 0) + 1);
        }
      }
      start = end + 1;
    }
    for (const [id, n] of hits) {
      const name = header.packages[id];
      if (name !== undefined && n >= minHits && n >= minCoverage * (unique.get(id) ?? 0)) out.add(name);
    }
  }
  return new Set([...out].sort());
}

/** HBC versions present among `dir`'s signature filenames (for the builder CLI). */
export function sigHbcVersions(dir: string): readonly number[] {
  const vs = new Set<number>();
  for (const name of readdirSync(dir)) {
    const m = /__hbc(\d+)\.json$/.exec(name);
    if (m !== null) vs.add(Number(m[1]));
  }
  return [...vs].sort((a, b) => a - b);
}
