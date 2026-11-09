// Fork relabel (corpus-fork-relabel, docs/DEPS.md "Fork relabel"): an app
// that ships a fork or rename Q of an upstream package P carries P's code, so
// P's signature matches, while the truth (and the app's package.json) names
// Q. The bundle's own string table often names Q as a package (the app's
// bundled package.json, a dependent's package.json, an error message). When
// it does, Q is a fork relative of P by one of the structural rules below,
// and nothing names P on its own, the confirmed package is reported as Q.
//
// Rules (no hand list of rename families):
//  - scoped-copy: P is unscoped and Q is `@scope/P` (`@metamask/superstruct`,
//    `@tanstack/react-query`, `@metamask/react-native-webview`).
//  - own-scope: both scoped, same basename, and Q's scope contains the
//    basename (`@react-native-community/cookies` -> `@react-native-cookies/
//    cookies`). An unrelated scope with the same generic basename
//    (`@babel/core`, `@sentry/core`) is not a rename.
//  - affix: same scope, and one name is the other plus `-word...` at either
//    end (`whatwg-url` -> `whatwg-url-without-unicode`, `source-map-js` ->
//    `source-map`). The shorter name must still carry a separator (the
//    corpus-guess-generic rule: a bare word is an identifier, not a package
//    name), and an affix Q must have no signature at all: one that has a
//    signature which did not match is more likely a plugin of P
//    (`react-native-reanimated-carousel`) than P's code under a new name.
//    An affix Q must be named in a package.json-shaped module (one
//    function, no requires, strings `name`, `version` and a dependency key): affixed names in code are
//    often not packages (React's renderer calls itself
//    `react-native-renderer`, which made `react-native` a false fork).
// Guards: Q is not itself confirmed (then both codes are present, or the
// twin rules decide), `@types/*` is never a fork, exactly one Q qualifies,
// and every module that names P as a whole string also names Q and names at
// most FORK_CONTEXT_MAX_CONFIRMED other confirmed packages (a small
// package.json listing the fork, where the upstream is a keyword or a
// description; the app's own package.json, which lists everything, keeps P).
import type { PackageScore } from "./match.ts";

export type ForkRule = "scoped-copy" | "own-scope" | "affix";

/** A module naming P and Q may name at most this many other confirmed
 *  packages and still be read as Q's context (the measured fork manifests
 *  name 1-2: `react`, `react-native`); an app manifest names dozens. */
export const FORK_CONTEXT_MAX_CONFIRMED = 4;

const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const NAME_AT_VERSION = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(?:npm:|[\d^~<>=*])/;

/** The package name a whole string names: the string itself when it is
 *  package-name shaped, or the `name` of a `name@version` literal. */
function nameOf(s: string): string | null {
  if (s.length > 214) return null;
  if (NAME.test(s)) return s;
  return NAME_AT_VERSION.exec(s)?.[1] ?? null;
}

const scopeOf = (n: string): string | null => (n.startsWith("@") ? n.slice(1, n.indexOf("/")) : null);
const baseOf = (n: string): string => (n.startsWith("@") ? n.slice(n.indexOf("/") + 1) : n);
const hasSeparator = (n: string): boolean => /[-./@]/.test(n);

function forkRule(p: string, q: string): ForkRule | null {
  if (p === q || q.startsWith("@types/")) return null;
  const ps = scopeOf(p);
  const qs = scopeOf(q);
  const pb = baseOf(p);
  const qb = baseOf(q);
  if (pb === qb) {
    if (ps === null && qs !== null) return "scoped-copy";
    if (ps !== null && qs !== null && qs.includes(pb)) return "own-scope";
    return null;
  }
  if (ps !== qs) return null;
  const [short, long] = pb.length < qb.length ? [pb, qb] : [qb, pb];
  if (!hasSeparator(short)) return null;
  return long.startsWith(short + "-") || long.endsWith("-" + short) ? "affix" : null;
}

export function relabelForks(packages: readonly PackageScore[], inventory: { readonly modules: readonly { readonly stringConstants: readonly string[]; readonly functionIndices: readonly number[]; readonly depIds: readonly number[] | null }[] }, signatureNames: ReadonlySet<string>): PackageScore[] {
  const confirmed = new Set(packages.filter((p) => p.tier === "high" && !p.isBaseline).map((p) => p.package));
  if (confirmed.size === 0) return [...packages];
  // name -> modules naming it, and module -> names (only for names that
  // matter: confirmed packages and fork relatives of one).
  const modulesOf = new Map<string, Set<number>>();
  inventory.modules.forEach((m, i) => {
    for (const s of m.stringConstants) {
      const n = nameOf(s);
      if (n === null) continue;
      let set = modulesOf.get(n);
      if (set === undefined) modulesOf.set(n, (set = new Set()));
      set.add(i);
    }
  });
  const isManifest = (i: number): boolean => {
    const m = inventory.modules[i]!;
    // A bundled package.json is one data factory: no requires, no inner functions.
    if (m.functionIndices.length !== 1 || (m.depIds !== null && m.depIds.length > 0)) return false;
    const strs = new Set(m.stringConstants);
    return strs.has("name") && strs.has("version") && (strs.has("dependencies") || strs.has("devDependencies") || strs.has("peerDependencies"));
  };
  const namesIn = (i: number): string[] => inventory.modules[i]!.stringConstants.map(nameOf).filter((n): n is string => n !== null);
  return packages.map((p) => {
    if (p.tier !== "high" || p.isBaseline || p.fork !== undefined) return p;
    const qs: { q: string; rule: ForkRule }[] = [];
    for (const q of modulesOf.keys()) {
      const rule = forkRule(p.package, q);
      if (rule === null || confirmed.has(q) || (rule === "affix" && signatureNames.has(q))) continue;
      qs.push({ q, rule });
    }
    if (qs.length !== 1) return p;
    const { q, rule } = qs[0]!;
    const qMods = modulesOf.get(q)!;
    // An affix name in code is often not a package at all (React's renderer
    // reports itself as "react-native-renderer"); a package.json listing it is.
    if (rule === "affix" && ![...qMods].some(isManifest)) return p;
    for (const i of modulesOf.get(p.package) ?? []) {
      if (!qMods.has(i)) return p;
      const others = new Set(namesIn(i).filter((n) => n !== p.package && confirmed.has(n)));
      if (others.size > FORK_CONTEXT_MAX_CONFIRMED) return p;
    }
    const evidence = [...qMods].slice(0, 3).map((i) => `module ${i}: ${JSON.stringify(inventory.modules[i]!.stringConstants.find((s) => nameOf(s) === q))}`);
    return { ...p, fork: { package: q, rule, evidence } };
  });
}
