// tools/pkgsig/bulk/install-plan.mjs — pure decision logic for build-one.mjs's
// npm install and hermesc invocation (BUILDONE1), split out so it is testable
// offline (build-one.mjs runs main() on import).
//
// Peer policy mirrors src/deps/confirm.ts installCandidate: strict install
// first (npm >=7 installs peer dependencies), `--legacy-peer-deps` only as a
// fallback when strict resolution fails. `--legacy-peer-deps` never installs
// peers, so Metro then cannot resolve e.g. @react-navigation/native or
// react-native-worklets.

import { createRequire } from "node:module";

const BASE = ["--ignore-scripts", "--no-save", "--no-audit", "--no-fund"];

/** npm argv attempts, in order. */
export function installAttempts(spec) {
  return [
    ["install", spec, ...BASE],
    ["install", spec, ...BASE, "--legacy-peer-deps"],
  ];
}

/** execFileSync options for stderr-piped children: default maxBuffer (1 MiB)
 *  gives ENOBUFS on chatty hermesc/metro output (axios). */
export const MAX_BUFFER = 1 << 30;
export function pipedOpts(extra = {}) {
  return { stdio: ["ignore", "ignore", "pipe"], maxBuffer: MAX_BUFFER, ...extra };
}

/** Run attempts with `exec(cmd, argv)`; fall back on failure. Returns the
 *  index of the attempt that succeeded; throws the LAST error if all fail. */
export function runInstall(spec, exec) {
  const attempts = installAttempts(spec);
  let last;
  for (let i = 0; i < attempts.length; i++) {
    try {
      exec("npm", attempts[i]);
      return i;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// deps-recall-nosig: which specifiers the signature entry file requires.
// Only `require(<pkg>)` used to be bundled, so a package with no root entry
// (@babel/runtime: no `main`, no `exports["."]`) failed every build, and a
// package the app reaches through sub-paths (semver/functions/*,
// nanoid/non-secure) got a signature without those files. The plan adds
// every `exports` sub-path whose target file exists (`*` patterns expanded
// against the files on disk); root-only stays as the fallback attempt so a
// sub-path that does not bundle on react-native never loses a build that
// worked before. Packages without `exports` are unchanged.
const SUBPATH_CAP = 500;
const RESOLVE_EXTS = ["", ".js", ".cjs", ".mjs", ".json", "/index.js", "/index.cjs"];

function fileExists(dir, rel, existsSync, statSync) {
  for (const ext of RESOLVE_EXTS) {
    const p = `${dir}/${rel}${ext}`;
    if (existsSync(p) && statSync(p).isFile()) return true;
  }
  return false;
}

/** All string targets of an exports value (conditions flattened). */
function targetsOf(v) {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(targetsOf);
  if (v && typeof v === "object") return Object.values(v).flatMap(targetsOf);
  return [];
}

/** Files below `dir` (relative, posix), skipping node_modules. */
function listFiles(dir, readdirSync, prefix = "") {
  const out = [];
  for (const ent of readdirSync(`${dir}/${prefix}`, { withFileTypes: true })) {
    if (ent.name === "node_modules") continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(dir, readdirSync, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * `{ root, attempts }` for package `name` installed at `pkgDir`: `attempts`
 * is a list of specifier lists, tried in order until one bundles.
 */
export function entryPlan(name, pkgDir, fs = createRequire(import.meta.url)("node:fs")) {
  const { existsSync, statSync, readdirSync, readFileSync } = fs;
  const pj = JSON.parse(readFileSync(`${pkgDir}/package.json`, "utf8"));
  const exp = pj.exports;
  const sugar = typeof exp === "string" || Array.isArray(exp) || (exp && typeof exp === "object" && !Object.keys(exp).some((k) => k.startsWith(".")));
  const mainRel = (pj["react-native"] && typeof pj["react-native"] === "string" ? pj["react-native"] : null) ?? pj.main ?? "index";
  const root = sugar || (exp && typeof exp === "object" && "." in exp) || fileExists(pkgDir, mainRel.replace(/^\.\//, ""), existsSync, statSync);
  const subs = [];
  if (exp && typeof exp === "object" && !sugar) {
    let files = null;
    for (const [key, val] of Object.entries(exp)) {
      if (key === "." || !key.startsWith("./") || key.endsWith(".json") || key.endsWith("/")) continue;
      const targets = targetsOf(val).filter((t) => t.startsWith("./") && !t.endsWith(".d.ts"));
      if (!key.includes("*")) {
        if (targets.some((t) => fileExists(pkgDir, t.slice(2), existsSync, statSync))) subs.push(`${name}/${key.slice(2)}`);
        continue;
      }
      const t = targets.find((x) => x.includes("*"));
      if (!t) continue;
      files ??= listFiles(pkgDir, readdirSync);
      const [pre, post] = t.slice(2).split("*");
      for (const f of files) {
        if (!f.startsWith(pre) || !f.endsWith(post) || f.length < pre.length + post.length + 1) continue;
        const star = f.slice(pre.length, f.length - post.length);
        subs.push(`${name}/${key.slice(2).replace("*", star)}`);
      }
    }
  }
  const uniq = [...new Set(subs)].slice(0, SUBPATH_CAP);
  if (!root) return { root, attempts: uniq.length ? [uniq] : [[name]] };
  return { root, attempts: uniq.length ? [[name, ...uniq], [name]] : [[name]] };
}

/** Entry-file source requiring each specifier. */
export function entrySource(specs) {
  return `module.exports = [${specs.map((s) => `require(${JSON.stringify(s)})`).join(", ")}];\n`;
}
