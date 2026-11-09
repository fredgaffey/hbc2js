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
import { dirname, join } from "node:path";
import type { DbLayer } from "./db.ts";
import type { ModuleInventory } from "./inventory.ts";
import type { SigDbFile } from "./sigdb-types.ts";
import { foreignFunctionPackages } from "./module-paths.ts";

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

/** Package-name interning for the index builders. A name gets an id when a
 *  signature file is read (`hasFile`) or when a foreign module's path names it
 *  (sigdb-strip-embedded); `compact` keeps only names with a file, in
 *  first-file order, so the index never names a package the DB lacks. */
class PackageIds {
  private readonly ids = new Map<string, number>();
  private readonly order: string[] = [];
  private readonly filed = new Set<number>();
  id(name: string, hasFile: boolean): number {
    let id = this.ids.get(name);
    if (id === undefined) {
      id = this.order.length;
      this.order.push(name);
      this.ids.set(name, id);
    }
    if (hasFile && !this.filed.has(id)) this.filed.add(id);
    return id;
  }
  compact(): { packages: string[]; remap: Map<number, number> } {
    const fileOrder = [...this.filed];
    const remap = new Map<number, number>(fileOrder.map((old, i) => [old, i]));
    return { packages: fileOrder.map((i) => this.order[i]!), remap };
  }
}

/** Builds the index text for every non-baseline, hash-scheme-2 signature
 *  file in `dir` at `hbcVersion`. Each file is parsed once and dropped. */
export function buildCandidateHashIndex(dir: string, hbcVersion: number, opts: BuildHashIndexOptions = {}): string {
  const minInstr = opts.minInstr ?? DEFAULT_INDEX_MIN_INSTR;
  const maxOwners = opts.maxOwners ?? DEFAULT_INDEX_MAX_OWNERS;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const suffix = `__hbc${hbcVersion}.json`;
  const names = new PackageIds();
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
    const id = names.id(file.package, true);
    // sigdb-strip-embedded: a path-bearing file's copy of another package's
    // module counts as that package's occurrence, never the carrier's
    // (pathless files: empty map, as before).
    const foreign = foreignFunctionPackages(file);
    for (const fn of file.functions) {
      if (fn.instrCount < minInstr) continue;
      if (fn.owner !== undefined && fn.owner !== null && fn.owner !== file.package) continue;
      const cur = owners.get(fn.exactHash);
      if (cur === null) continue;
      const fp = foreign.get(fn.index);
      const oid = fp !== undefined ? names.id(fp, false) : id;
      if (cur === undefined) owners.set(fn.exactHash, [oid]);
      else if (!cur.includes(oid)) owners.set(fn.exactHash, cur.length >= maxOwners ? null : [...cur, oid]);
    }
  }
  const { packages, remap } = names.compact();
  const header: HashIndexHeader = { hbcVersion, minInstr, maxOwners, packages };
  const lines: string[] = [];
  for (const [hash, o] of owners) if (o !== null && o.every((i) => remap.has(i))) lines.push(`${hash}\t${o.map((i) => remap.get(i)).join(",")}`);
  lines.sort();
  return `${HASH_INDEX_MAGIC}${JSON.stringify(header)}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

/** Builds and writes `<outDir>/candidate-hash-index__hbc<N>.tsv` and, beside
 *  it, the hop-two string-set index (`buildCandidateStringSetIndex`); returns
 *  the hash index's path. */
export function writeCandidateHashIndex(sigDir: string, outDir: string, hbcVersion: number, opts: BuildHashIndexOptions = {}): string {
  const path = join(outDir, hashIndexFileName(hbcVersion));
  writeFileSync(path, buildCandidateHashIndex(sigDir, hbcVersion, opts));
  writeFileSync(join(outDir, stringSetIndexFileName(hbcVersion)), buildCandidateStringSetIndex(sigDir, hbcVersion, opts));
  return path;
}

// ---------------------------------------------------------------------------
// Hop-two string-set index (corpus-recall-hop-two, docs/DEPS.md "Hop-two
// candidate expansion"). The owner ruling (2026-09-29) admits a dependency of
// a non-string-evidenced candidate only on its OWN string evidence. Signature
// files carry no string literals, only each function's string-set hash (the
// hash of the set of string constants it uses) and their count; a target
// function with the same string-set hash uses exactly the same strings. The
// index keeps the sets that are distinctive: >= MIN strings, from a function
// the file's own package owns, and present in exactly one package's files at
// that HBC version (toolchain baselines count as an owner, so a set the RN
// baseline has is never anyone's own evidence).

export const STRINGSET_INDEX_MAGIC = "#hbc2js-candidate-stringset-index 1 ";
export const DEFAULT_STRINGSET_MIN_STRINGS = 2;

export function stringSetIndexFileName(hbcVersion: number): string {
  return `candidate-stringset-index__hbc${hbcVersion}.tsv`;
}

export function buildCandidateStringSetIndex(dir: string, hbcVersion: number, opts: BuildHashIndexOptions & { readonly minStrings?: number } = {}): string {
  const minStrings = opts.minStrings ?? DEFAULT_STRINGSET_MIN_STRINGS;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const suffix = `__hbc${hbcVersion}.json`;
  const names = new PackageIds();
  // string-set hash -> owning package id; -1 once a second package has it.
  const owner = new Map<string, number>();
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(suffix)) continue;
    let file: SigDbFile;
    try {
      file = JSON.parse(readFile(join(dir, name))) as SigDbFile;
    } catch {
      continue;
    }
    if (file.hbcVersion !== hbcVersion) continue;
    // A baseline file blocks every set it has but is never itself proposed.
    const fileId = names.id(file.package, true); // interned even for a baseline: header unchanged
    const ownerId = file.toolchainBaseline ? -2 : fileId;
    const foreign = foreignFunctionPackages(file);
    for (const fn of file.functions) {
      if (fn.stringCount < minStrings) continue;
      if (fn.owner !== undefined && fn.owner !== null && fn.owner !== file.package) continue;
      const fp = foreign.get(fn.index);
      const oid = fp !== undefined && !file.toolchainBaseline ? names.id(fp, false) : ownerId;
      const cur = owner.get(fn.stringSetHash);
      if (cur === undefined) owner.set(fn.stringSetHash, oid);
      else if (cur !== oid) owner.set(fn.stringSetHash, -1);
    }
  }
  const { packages, remap } = names.compact();
  const header = { hbcVersion, minStrings, packages };
  const lines: string[] = [];
  for (const [hash, id] of owner) if (id >= 0 && remap.has(id)) lines.push(`${hash}\t${remap.get(id)}`);
  lines.sort();
  return `${STRINGSET_INDEX_MAGIC}${JSON.stringify(header)}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

/** Of `wanted`, the packages that have at least one indexed (distinctive,
 *  own) string set among the target's function string-set hashes, per
 *  layer carrying a string-set index for the target's HBC version. */
export function packagesWithOwnStringSets(layers: readonly DbLayer[], inventory: ModuleInventory, wanted: ReadonlySet<string>): ReadonlySet<string> {
  const out = new Set<string>();
  if (wanted.size === 0) return out;
  const target = new Set<string>();
  for (const fn of inventory.functions) target.add(fn.stringSetHash);
  for (const layer of layers) {
    const path = join(hashIndexDir(layer), stringSetIndexFileName(inventory.hbcVersion));
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const nl = text.indexOf("\n");
    if (nl < 0 || !text.startsWith(STRINGSET_INDEX_MAGIC)) continue;
    const header = JSON.parse(text.slice(STRINGSET_INDEX_MAGIC.length, nl)) as { hbcVersion: number; packages: string[] };
    if (header.hbcVersion !== inventory.hbcVersion) continue;
    const wantedIds = new Set<number>();
    header.packages.forEach((p, i) => { if (wanted.has(p)) wantedIds.add(i); });
    if (wantedIds.size === 0) continue;
    let start = nl + 1;
    while (start < text.length) {
      let end = text.indexOf("\n", start);
      if (end < 0) end = text.length;
      const tab = text.indexOf("\t", start);
      if (tab > start && tab < end) {
        const id = Number(text.slice(tab + 1, end));
        if (wantedIds.has(id) && target.has(text.slice(start, tab))) out.add(header.packages[id]!);
      }
      start = end + 1;
    }
  }
  return out;
}

/** Directory that holds a layer's index files. A sqlite DB keeps the index as a
 *  sidecar beside the `.sqlite` file (never inside it), so a layer whose `dir`
 *  names a `.sqlite` file looks in that file's directory. */
export function hashIndexDir(layer: DbLayer): string {
  return layer.dir.endsWith(".sqlite") ? dirname(layer.dir) : layer.dir;
}

/** One-line hint when NO layer has an index for `hbcVersion` but some layer
 *  has signatures; null when an index exists (or there is no DB at all).
 *  Informational only: shown in verbose output, never an error. */
export function hashIndexHint(layers: readonly DbLayer[], hbcVersion: number): string | null {
  let anyDb = false;
  for (const layer of layers) {
    const dir = hashIndexDir(layer);
    if (existsSync(join(dir, hashIndexFileName(hbcVersion)))) return null;
    if (layer.dir.endsWith(".sqlite") ? existsSync(layer.dir) : existsSync(dir) && (existsSync(join(dir, "sigdb.sqlite")) || readdirSync(dir).some((n) => n.endsWith(".json")))) anyDb = true;
  }
  if (!anyDb) return null;
  return `no candidate hash index for hbc${hbcVersion} beside the signature DB; build one for better recall: node --experimental-strip-types tools/deps/build-candidate-hash-index.mjs <sigdir>`;
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
    const path = join(hashIndexDir(layer), hashIndexFileName(inventory.hbcVersion));
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
/** deps-rnav-recall: exact hash -> owning package for every single-owner
 *  line of the candidate hash index whose hash the target holds (functions
 *  of at least the index's minInstr), over every layer with an index for
 *  the target's HBC version. A hash two layers give to different packages
 *  is dropped. Feeds `MatchOptions.uniqueHashOwners`. */
export function uniqueHashOwnersInTarget(layers: readonly DbLayer[], inventory: ModuleInventory): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const layer of layers) {
    const path = join(hashIndexDir(layer), hashIndexFileName(inventory.hbcVersion));
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
    let start = nl + 1;
    while (start < buf.length) {
      let end = buf.indexOf(10, start);
      if (end < 0) end = buf.length;
      const tab = buf.indexOf(9, start);
      if (tab > start && tab < end) {
        const comma = buf.indexOf(44, tab);
        const hash = buf.toString("latin1", start, tab);
        if ((comma < 0 || comma >= end) && target.has(hash)) {
          const name = header.packages[Number(buf.toString("latin1", tab + 1, end))];
          if (name !== undefined) {
            const prev = out.get(hash);
            if (prev !== undefined && prev !== name) conflicted.add(hash);
            else out.set(hash, name);
          }
        }
      }
      start = end + 1;
    }
  }
  for (const h of conflicted) out.delete(h);
  return out;
}

export function sigHbcVersions(dir: string): readonly number[] {
  const vs = new Set<number>();
  for (const name of readdirSync(dir)) {
    const m = /__hbc(\d+)\.json$/.exec(name);
    if (m !== null) vs.add(Number(m[1]));
  }
  return [...vs].sort((a, b) => a - b);
}
