// This module implements the "bounded, not exhaustive" strategy: a cheap,
// single walk over the bundle's OWN string table (already recovered
// structurally by `inventory.ts`, no extra parsing) collects evidence text,
// then every candidate package name available in a DB layer (derived from
// its filename alone — `<pkg>@<version>__hbc<N>.json`, no JSON parsing
// needed to know a package's name) is tested for whether it appears
// literally, case-insensitively, anywhere in that evidence text: a
// `node_modules/<pkg>/...` path fragment, a quoted `require`-shaped string,
// a deprecation-notice sentence naming the package
// (`"...install it from 'react-native-foo' instead"`), a version banner,
// or simply the package's own name occurring inside a longer identifier
// (`ReactNative` contains `react-native` case-insensitively) — all of these
// are real evidence a brute-force scan would otherwise have had to
// rediscover by scoring the package's full signature regardless.
//
// Matching thousands of candidate names against the evidence text one
// `String.prototype.includes` call at a time would be O(patterns x text
// length) — worse than useless at 32k patterns. `findCandidatesInText`
// below is a small Aho-Corasick automaton instead: O(total pattern length +
// text length + match count), independent of how many candidate names
// there are.
import type { DbLayer } from "./db.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModuleInventory } from "./inventory.ts";
import type { SigDbFile } from "./sigdb-types.ts";
import { packagesWithOwnStringSets, proposeFromHashIndex } from "./hash-index.ts";

/** `<safeName>@<version>__hbc<N>.json` -> canonical package name (reverses
 *  `writeSignature`'s `db.package.replace(/\//g, "__")`, `db.ts`). Returns
 *  `null` for anything not shaped like a signature file (e.g. `index.json`,
 *  a baseline file — baselines are handled separately, always loaded). */
export function packageNameFromSigFilename(filename: string): string | null {
  const m = /^(.*)@[^@]+__hbc\d+\.json$/.exec(filename);
  if (m === null) return null;
  return m[1]!.replace(/__/g, "/");
}

/** Every candidate package name available in a DB layer, derived purely
 *  from filenames (`_baselines/` excluded — those are always loaded
 *  regardless of candidates, see `db.ts`). No file content is read; this is
 *  a single `readdirSync`, the cheapest possible operation compared to
 *  parsing every signature file up front. */
export function listCandidatePackageNames(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name === "index.json") continue;
    const pkg = packageNameFromSigFilename(name);
    if (pkg !== null) out.push(pkg);
  }
  return out;
}

export function listCandidatePackageNamesForLayers(layers: readonly DbLayer[]): readonly string[] {
  const names = new Set<string>();
  for (const layer of layers) for (const n of listCandidatePackageNames(layer.dir)) names.add(n);
  return [...names];
}

/** Per-run index over the layers' signature filenames plus a memo of the
 *  dependency names each file records (corpus-remeasure2-brex-oom). The
 *  directory is listed ONCE (not once per evidenced package: thousands of
 *  packages x a 100k-file directory), each file is read at most once, and
 *  only its dependency NAMES are kept, never the parsed file. */
export interface DependencyIndex {
  readonly byPackage: Map<string, { dir: string; name: string }[]>;
  readonly depsOfFile: Map<string, readonly string[]>;
  readonly readFile: (path: string) => string;
}

export function buildDependencyIndex(layers: readonly DbLayer[], readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): DependencyIndex {
  const byPackage = new Map<string, { dir: string; name: string }[]>();
  const seenDirs = new Set<string>();
  for (const layer of layers) {
    if (seenDirs.has(layer.dir) || !existsSync(layer.dir)) continue;
    seenDirs.add(layer.dir);
    for (const name of readdirSync(layer.dir)) {
      if (!name.endsWith(".json") || name === "index.json") continue;
      const pkg = packageNameFromSigFilename(name);
      if (pkg === null) continue;
      let list = byPackage.get(pkg);
      if (list === undefined) byPackage.set(pkg, (list = []));
      list.push({ dir: layer.dir, name });
    }
  }
  return { byPackage, depsOfFile: new Map(), readFile };
}

/**
 * Candidate-derivation dependency expansion (docs/DEPS.md "Where
 * dependency recall is actually lost", measured 2026-09-29): the recorded
 * npm dependencies of every on-disk signature for `pkg`, across every
 * layer, as package names — J4's v2 signature files carry this as
 * `subtractedDependencies` (sibling sigdb filenames), a fact recorded from
 * the package's OWN `package.json` at signature-build time, not a guess
 * about the bundle. Read is deliberately narrow: only files whose own
 * filename already names `pkg` are opened (never a directory-wide scan of
 * file contents), and this is only ever called from `deriveCandidatePackages`
 * for packages that already have literal string evidence in the bundle —
 * `pkg` itself must already be a real finding, this only widens what its
 * OWN recorded dependencies contribute.
 */
export function recordedDependencyPackageNames(layers: readonly DbLayer[], pkg: string, index: DependencyIndex = buildDependencyIndex(layers)): ReadonlySet<string> {
  const names = new Set<string>();
  for (const { dir, name } of index.byPackage.get(pkg) ?? []) {
    const path = join(dir, name);
    let deps = index.depsOfFile.get(path);
    if (deps === undefined) {
      const out: string[] = [];
      try {
        const file = JSON.parse(index.readFile(path)) as SigDbFile;
        for (const depFilename of file.subtractedDependencies ?? []) {
          const depPkg = packageNameFromSigFilename(depFilename);
          if (depPkg !== null) out.push(depPkg);
        }
      } catch {
        // malformed signature file — skip, same tolerance as db.ts's loadSignatures
      }
      deps = out;
      index.depsOfFile.set(path, deps);
    }
    for (const d of deps) names.add(d);
  }
  return names;
}

/** The bundle's own evidence text: every string constant belonging to any
 *  `__d()` module, lower-cased and concatenated once. Cheap — these strings
 *  are already recovered structurally by `inventory.ts`'s single decode
 *  pass; this is a second, trivial walk over data already in memory, not a
 *  re-parse of the bundle. */
export function evidenceTextFromInventory(inventory: ModuleInventory): string {
  const parts: string[] = [];
  for (const m of inventory.modules) {
    for (const s of m.stringConstants) parts.push(s);
  }
  // A NUL separator so a package name can never "match" by spanning the
  // boundary between two unrelated strings.
  return parts.join("\0").toLowerCase();
}

interface TrieNode {
  readonly children: Map<string, TrieNode>;
  fail: TrieNode;
  matches: readonly string[];
}

function newNode(): TrieNode {
  const node = { children: new Map<string, TrieNode>(), matches: [] as readonly string[] } as TrieNode;
  node.fail = node; // patched to the real root right after construction for non-root nodes
  return node;
}

/**
 * Aho-Corasick multi-pattern search: which of `patterns` (case-insensitive,
 * candidate package names) occur as a literal substring anywhere in
 * `haystack` (already lower-cased) — O(sum of pattern lengths + haystack
 * length + match count), not O(patterns.length * haystack.length).
 */
export function findCandidatesInText(patterns: readonly string[], haystack: string): ReadonlySet<string> {
  const root = newNode();
  for (const pattern of patterns) {
    const lower = pattern.toLowerCase();
    if (lower.length === 0) continue;
    let node = root;
    for (const ch of lower) {
      let next = node.children.get(ch);
      if (next === undefined) {
        next = newNode();
        next.fail = root;
        node.children.set(ch, next);
      }
      node = next;
    }
    node.matches = [...node.matches, pattern];
  }

  // BFS to build failure links (standard Aho-Corasick construction) — an
  // index-walked array, not `Array.prototype.shift`, so this stays linear
  // in the number of trie nodes even for a large (32k-package) candidate
  // set.
  const queue: TrieNode[] = [...root.children.values()];
  for (const child of root.children.values()) child.fail = root;
  for (let qi = 0; qi < queue.length; qi++) {
    const node = queue[qi]!;
    for (const [ch, child] of node.children) {
      let f = node.fail;
      while (f !== root && !f.children.has(ch)) f = f.fail;
      const viaFail = f.children.get(ch);
      child.fail = viaFail !== undefined && viaFail !== child ? viaFail : root;
      if (child.fail.matches.length > 0) child.matches = [...child.matches, ...child.fail.matches];
      queue.push(child);
    }
  }

  const found = new Set<string>();
  let node = root;
  for (const ch of haystack) {
    while (node !== root && !node.children.has(ch)) node = node.fail;
    const next = node.children.get(ch);
    node = next !== undefined ? next : root;
    if (node.matches.length > 0) for (const p of node.matches) found.add(p);
  }
  return found;
}

/**
 * The full evidence-directed candidate pipeline: given the layered DB dirs
 * and the target's module inventory, return exactly the package names worth
 * loading full signatures for. Deliberately conservative in the *other*
 * direction from precision — a name is included on any literal-substring
 * hit, however it arose (node_modules path, quoted require, prose mention,
 * a substring of a longer identifier); over-inclusion only costs loading a
 * few more (real, on-disk) signature files, while under-inclusion is a
 * silent recall drop, the failure mode this task must not ship by default
 * — see docs/DEPS.md's evidence-directed-matching section for the measured
 * comparison against `--exhaustive`.
 */
export function deriveCandidatePackages(layers: readonly DbLayer[], inventory: ModuleInventory, depIndex: DependencyIndex = buildDependencyIndex(layers)): ReadonlySet<string> {
  const universe = listCandidatePackageNamesForLayers(layers);
  const text = evidenceTextFromInventory(inventory);
  const found = new Set(findCandidatesInText(universe, text));
  const direct = new Set(found);

  // Dependency expansion (candidate-derivation dependency expansion,
  // docs/DEPS.md "Where dependency recall is actually lost", measured
  // 2026-09-29): once a package is itself literally evidenced by name
  // (react-native always is, in any real RN bundle), its OWN recorded npm
  // dependencies become candidates too, with no string evidence of their
  // own name required at all — a minified release bundle never contains
  // the string "base64-js" anywhere, but react-native's own v2 signature
  // file records `base64-js` as one of its dependencies as a fact copied
  // from react-native's package.json at signature-build time, not a guess
  // about this particular bundle. Deliberately ONE level, and
  // deliberately from the DIRECTLY-evidenced set only — `[...found]` is
  // snapshotted here, before scope-prefix corroboration below adds
  // anything, so this never stacks two inference steps (a scope-corroborated
  // package's dependencies are not auto-added). That was not what closed
  // the measured 11-package gap and widening it further risks the
  // confirmed-tier precision this task must not drop; see the same doc
  // section.
  for (const pkg of [...found]) {
    for (const dep of recordedDependencyPackageNames(layers, pkg, depIndex)) found.add(dep);
  }

  // Hash-index proposal (corpus-recall-candidates, `hash-index.ts`): a
  // package whose own distinctive function hashes appear in the target is a
  // candidate even when nothing names it. Added after the dependency
  // snapshot above, so a hash-proposed package's dependencies are never
  // expanded (no stacked inference).
  for (const pkg of proposeFromHashIndex(layers, inventory)) found.add(pkg);

  // Scope-prefix corroboration: a scoped package's own full name
  // (`@react-navigation/native`) doesn't always survive verbatim in a
  // release bundle's strings even when a *sibling* under the same scope's
  // full name does (measured on `react-navigation-example-0.85.3`:
  // `@react-navigation/stack` matches directly via a require-shaped string,
  // but `@react-navigation/native` doesn't — while the bare scope prefix
  // `@react-navigation/` does, evidently from a third string this DB has no
  // signature for). Real npm scopes are one organisation's packages, so
  // scope-level evidence is still targeted evidence, just one level
  // coarser than a full package name — nowhere near brute-forcing every
  // package in the DB, only the (typically small) handful sharing a scope
  // the bundle already gave direct evidence of.
  const scopePrefixes = new Set<string>();
  const scopeToNames = new Map<string, string[]>();
  for (const name of universe) {
    if (!name.startsWith("@")) continue;
    const slash = name.indexOf("/");
    if (slash < 0) continue;
    const scope = name.slice(0, slash + 1).toLowerCase();
    scopePrefixes.add(scope);
    let names = scopeToNames.get(scope);
    if (names === undefined) {
      names = [];
      scopeToNames.set(scope, names);
    }
    names.push(name);
  }
  const matchedScopes = findCandidatesInText([...scopePrefixes], text);
  for (const scope of matchedScopes) {
    for (const name of scopeToNames.get(scope) ?? []) found.add(name);
  }

  // Hop-two expansion (corpus-recall-hop-two, docs/DEPS.md "Hop-two
  // candidate expansion"): a recorded dependency of a candidate that is NOT
  // itself directly evidenced (dependency-, hash- or scope-proposed) is
  // admitted only on its OWN string evidence, per the 2026-09-29 owner
  // ruling — one of its own functions' distinctive string sets (>= 2
  // strings, no other package has it) is present in the target. The edge
  // alone is never enough, and admitted packages' dependencies are not
  // expanded further.
  const hopTwo = new Set<string>();
  for (const pkg of found) {
    if (direct.has(pkg)) continue;
    for (const dep of recordedDependencyPackageNames(layers, pkg, depIndex)) if (!found.has(dep)) hopTwo.add(dep);
  }
  for (const pkg of packagesWithOwnStringSets(layers, inventory, hopTwo)) found.add(pkg);

  return found;
}
