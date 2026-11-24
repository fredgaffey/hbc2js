// src/export/boilerplate.ts — docs/specs/29-export.md §4: the project-root
// files a React Native tree needs before `npx react-native bundle` will even
// look at it, plus the toolchain table §4.3 requires (the build toolchain is
// not derivable from the bundle at all).
import type { DepsReport } from "../deps/report.ts";
import { tierConfidenceScore } from "./substitute.ts";
import { newestRnVersionForHbc } from "../deps/report.ts";

export interface AppNameResult {
  readonly name: string;
  readonly source: "flag" | "registerComponent" | "fallback";
}

const REGISTER_COMPONENT_LITERAL_RE = /\.registerComponent\(\s*(['"])([^'"]+)\1\s*,/;
// Any non-literal first argument: a bare name, or (spec 05 section 7.4: the
// method read stays before the argument's require) `require(N).name` inline.
// Also the unfused `rF = rO.registerComponent; ...; Reflect.apply(rF, rO, [arg, ...])`.
const REGISTER_COMPONENT_VAR_RE = /\.registerComponent\(\s*[^,'"]+,|(\w+) = (\w+)\.registerComponent;[\s\S]*?Reflect\.apply\(\1, \2, \[/;
const NAME_DISPLAYNAME_RE = /\bname\s*:\s*(['"])([^'"]+)\1\s*,\s*displayName\s*:\s*\1\2\1/;

export interface RecoverAppNameModule {
  readonly file: string;
  readonly deps: readonly number[];
}

/** §4.2: `name` in priority order — `--app-name`, then the literal argument
 *  to a real `AppRegistry....registerComponent("Name", ...)` call found
 *  anywhere in the tree's own module text, else the documented fallback.
 *  Two shapes of that call are resolved, both observed on large bundles
 *  (rn-template-0.72's own module 0, at every render tier):
 *   1. a literal string argument; or
 *   2. the one-hop indirection spec 08 §2.1 step 2 also recognises for
 *      naming purposes — some other required module's `.name` property fed
 *      into the call. That hop is NOT resolved by matching call-site text
 *      (the shape of the call itself differs across render tiers: a literal
 *      `require('./module_N.js')` at the `flat` tier, a plain call through
 *      the `require` parameter once the pass ladder's copy-propagation runs
 *      at the `passes`/`jsx` tiers — see `docs/BUGS.md`-worthy dead end
 *      this function used to take, replaced here). Instead it walks the
 *      module's own REAL dependency ids (`SplitModuleInfo.deps`, tier-
 *      independent) and looks for the one dependency whose body is a
 *      `{name: "X", displayName: "X"}` object literal — the `app.json`
 *      shape Metro embeds as its own module (rn-template-0.72: module 434).
 *      Specific enough (both properties present and equal) not to fire on
 *      an unrelated object that merely has a `name` field. */
export function recoverAppName(
  splitFiles: ReadonlyMap<string, string>,
  modules: readonly RecoverAppNameModule[],
  override: string | undefined,
): AppNameResult {
  if (override !== undefined) return { name: override, source: "flag" };
  for (const mod of modules) {
    const text = splitFiles.get(mod.file);
    if (text === undefined) continue;
    const literal = REGISTER_COMPONENT_LITERAL_RE.exec(text);
    if (literal !== null) return { name: literal[2]!, source: "registerComponent" };
    if (!REGISTER_COMPONENT_VAR_RE.test(text)) continue;
    for (const depId of mod.deps) {
      const depText = splitFiles.get(`module_${depId}.js`);
      if (depText === undefined) continue;
      const nameProp = NAME_DISPLAYNAME_RE.exec(depText);
      if (nameProp !== null) return { name: nameProp[2]!, source: "registerComponent" };
    }
  }
  return { name: "DecompiledApp", source: "fallback" };
}

export interface ReactNativeVersionResult {
  readonly version: string | null;
  readonly source: "flag" | "bundle-string" | "deps-signature-match" | "hbc-range";
  readonly consistentWithHbc: boolean | null;
  readonly expectedRange: string | null;
}

/** §4.3: RN version in priority order — `--rn-version`, then
 *  `DepsReport.reactNativeVersion`, then the newest RN minor the bundle's own
 *  HBC version is documented to ship. */
export function resolveReactNativeVersion(report: DepsReport, override: string | undefined): ReactNativeVersionResult {
  if (override !== undefined) {
    return { version: override, source: "flag", consistentWithHbc: report.reactNativeVersionConsistentWithHbc, expectedRange: report.reactNativeVersionExpectedRange };
  }
  if (report.reactNativeVersion !== null) {
    return {
      version: report.reactNativeVersion,
      // A signature-DB nearest match is NOT a confirmation: only the bundle's own
      // version constants are evidence of the version.
      source: report.reactNativeVersionSource === "bundle-string" ? "bundle-string" : "deps-signature-match",
      consistentWithHbc: report.reactNativeVersionConsistentWithHbc,
      expectedRange: report.reactNativeVersionExpectedRange,
    };
  }
  const fallback = newestRnVersionForHbc(report.hbcVersion);
  return { version: fallback, source: "hbc-range", consistentWithHbc: null, expectedRange: report.reactNativeVersionExpectedRange };
}

/** §4.3: the build toolchain, keyed by RN minor (`"<major>.<minor>"`) —
 *  not derivable from the bundle itself (the table is maintained by hand).
 *  RN 0.73 is when `@react-native/babel-preset`/`@react-native/metro-config`
 *  replaced the old `metro-react-native-babel-preset` package, published in
 *  lockstep with `react-native` itself from that point on. */
/** Whether `rnVersion` is on the modern (`@react-native/babel-preset` +
 *  `@react-native/metro-config`, RN >=0.73) or legacy toolchain — one place
 *  so `TOOLCHAIN_FOR_RN`'s `devDependencies` and the `babel.config.js`/
 *  `metro.config.js` boilerplate below can never disagree about which
 *  package the tree actually requires (spec 29 §4.4's own "every bare
 *  specifier must be installed" rule, `tests/gate/export/substitutions.test.ts`). */
export function isModernRnToolchain(rnVersion: string | null): boolean {
  const m = rnVersion !== null ? /^(\d+)\.(\d+)/.exec(rnVersion) : null;
  const minor = m !== null ? Number(m[2]) : null;
  return minor !== null && minor >= 73;
}

function rnMinor(rnVersion: string | null): number | null {
  const m = rnVersion !== null ? /^(\d+)\.(\d+)/.exec(rnVersion) : null;
  return m !== null ? Number(m[2]) : null;
}

/** The `@react-native-community/cli` and `metro` lines RN ships against, by
 *  RN minor (RN 0.83 bundles with cli 20 / metro 0.83; the old 13 / 0.80 pair
 *  cannot drive it). */
function cliAndMetroFor(minor: number | null): { readonly cli: string; readonly metro: string } {
  if (minor !== null && minor >= 81) return { cli: "^20.0.0", metro: "^0.83.0" };
  if (minor === 80) return { cli: "^19.0.0", metro: "^0.82.0" };
  if (minor === 79) return { cli: "^18.0.0", metro: "^0.82.0" };
  return { cli: "^13.0.0", metro: "^0.80.0" };
}

export function TOOLCHAIN_FOR_RN(rnVersion: string | null): Record<string, string> {
  const modern = isModernRnToolchain(rnVersion);
  const tool = cliAndMetroFor(rnMinor(rnVersion));
  const common = {
    "@babel/core": "^7.25.0",
    "@react-native-community/cli": tool.cli,
  };
  if (modern) {
    return {
      ...common,
      "@react-native/babel-preset": rnVersion!,
      "@react-native/metro-config": rnVersion!,
      metro: tool.metro,
    };
  }
  return {
    ...common,
    "metro-react-native-babel-preset": "^0.77.0",
    metro: "^0.76.0",
    "metro-config": "^0.76.0",
  };
}

/** Expo SDK major that ships with a given RN minor (Expo pins one RN per SDK). */
export function expoSdkForRn(rnVersion: string | null): number | null {
  const minor = rnMinor(rnVersion);
  const table: Readonly<Record<number, number>> = { 73: 50, 74: 51, 76: 52, 79: 53, 81: 54, 83: 55 };
  return minor === null ? null : (table[minor] ?? null);
}

export type ExportDepLevel = "confirmed" | "bundle-string" | "guessed" | "hint" | "native-channel";
export interface ExportDep {
  readonly version: string;
  readonly level: ExportDepLevel;
  readonly confidence: number | null;
  /** True when the version is a placeholder/derived pin rather than evidence of this package's own version. */
  readonly versionDerived: boolean;
}

/** Every dependency package.json should carry, with the evidence level of each:
 *  confirmed (signature match / bundle version constant), then guessed, hinted
 *  and native-channel detections, which a build still needs even though only
 *  their name (not their version) is evidenced. Unknown versions: Expo SDK
 *  packages get the SDK line matching the RN version, everything else `*`. */
export function exportDependencies(report: DepsReport, rnVersion: string | null): Record<string, ExportDep> {
  const out: Record<string, ExportDep> = {};
  const sdk = expoSdkForRn(rnVersion);
  const derived = (name: string): string => (name === "expo" || name.startsWith("expo-")) && sdk !== null ? `~${sdk}.0.0` : "*";
  for (const d of report.confirmedDeps) {
    out[d.package] = { version: d.version, level: d.versionEvidence === "bundle-string" ? "bundle-string" : "confirmed", confidence: tierConfidenceScore(d.confidence), versionDerived: false };
  }
  const add = (name: string, version: string | null, level: ExportDepLevel, confidence: number | null): void => {
    if (out[name] !== undefined) return;
    out[name] = { version: version ?? derived(name), level, confidence, versionDerived: version === null };
  };
  for (const g of report.guessedDeps) add(g.package, g.version, "guessed", g.confidence);
  for (const h of report.hintedDeps) add(h.package, h.version, "hint", h.confidence);
  for (const n of report.nativeChannel?.deps ?? []) add(n.package, null, "native-channel", null);
  return out;
}

export function buildPackageJson(opts: {
  readonly appName: string;
  readonly report: DepsReport;
  readonly rnVersion: string | null;
}): Record<string, unknown> {
  const dependencies = Object.fromEntries(Object.entries(exportDependencies(opts.report, opts.rnVersion)).map(([k, v]) => [k, v.version]).sort(([a], [b]) => (a! < b! ? -1 : 1)));
  return {
    name: opts.appName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "decompiled-app",
    version: "0.0.0",
    private: true,
    scripts: {
      start: "react-native start",
      android: "react-native run-android",
      ios: "react-native run-ios",
      bundle: "react-native bundle --entry-file index.js --platform android --dev false --bundle-output android.bundle",
    },
    dependencies,
    devDependencies: TOOLCHAIN_FOR_RN(opts.rnVersion),
  };
}

export function buildAppJson(name: string): Record<string, unknown> {
  return { name, displayName: name };
}

export function buildBabelConfigJs(rnVersion: string | null): string {
  const preset = isModernRnToolchain(rnVersion) ? "module:@react-native/babel-preset" : "module:metro-react-native-babel-preset";
  return `module.exports = {\n  presets: [${JSON.stringify(preset)}],\n};\n`;
}

export function buildMetroConfigJs(rnVersion: string | null): string {
  if (!isModernRnToolchain(rnVersion)) {
    // Pre-0.73 toolchains have no `@react-native/metro-config` package;
    // `metro-config`'s own loader is the RN-version-agnostic equivalent.
    return [
      `const { getDefaultConfig, mergeConfig } = require("metro-config");`,
      ``,
      `const config = {};`,
      ``,
      `module.exports = mergeConfig(getDefaultConfig.getDefaultValues(__dirname), config);`,
      ``,
    ].join("\n");
  }
  return [
    `const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");`,
    ``,
    `const config = {};`,
    ``,
    `module.exports = mergeConfig(getDefaultConfig(__dirname), config);`,
    ``,
  ].join("\n");
}

/** §4.1: boots the registry, registers and runs the run-before-main modules
 *  and then the entry module (which registers
 *  itself with `AppRegistry`). No second registration is synthesised here —
 *  see the module comment on `entryModuleId === null`.
 *
 *  `entryPath` is the entry module's REAL export-tree path
 *  (`ExportModuleInfo.path`, e.g. `"src/module_986.js"` or
 *  `"src/_vendor/react-native/module_986.js"` when the entry module's own
 *  bucket is not `app`) — a bare `src bucket -> "src/module_N.js"`
 *  convention was never guaranteed to equal a fixed `"src/index.js"` (that
 *  name only happens for a module the name-overlay heuristic separately
 *  recognises, e.g. a `store/index.js` shape), so a literal
 *  `require("./src/index.js")` here silently pointed at a file that may not
 *  exist. See `docs/BUGS.md` (build-proof). */
export function buildIndexJs(
  entryModuleId: number | null,
  entryPath: string | null,
  runBeforeMain: readonly { readonly id: number; readonly path: string }[] = [],
): string {
  const lines: string[] = [
    `// hbc2js export -- React Native entry point.`,
  ];
  if (entryModuleId === null) {
    lines.push(`// The entry module could not be resolved (MODULES.json's "entry" was null);`);
    lines.push(`// only the registry boots below. See EXPORT.json's "unresolved" (no-entry-module).`);
  } else if (entryPath === null) {
    lines.push(`// The entry module's export-tree path could not be determined (it was`);
    lines.push(`// substituted away); only the registry boots below. See EXPORT.json's`);
    lines.push(`// "unresolved" (entry-module-path-unknown).`);
  }
  lines.push(`require("./src/_hbc/helpers.js");`); // installs __hbc_b_* on globalThis
  lines.push(`var __hbc = require("./src/_hbc/registry.js");`); // installs the module registry
  // Requiring a module FILE only registers it (`__hbc.define`, §4.4); the
  // factories run through `__hbc.r(id)`, in the original bundle's own
  // top-level `__r` order: run-before-main modules first, entry last
  // (spec 33 L1: requiring the entry file alone ran no factory at all).
  for (const m of runBeforeMain) lines.push(`require("./${m.path}");`);
  if (entryModuleId !== null && entryPath !== null) lines.push(`require("./${entryPath}");`);
  for (const m of runBeforeMain) lines.push(`__hbc.r(${m.id});`);
  if (entryModuleId !== null && entryPath !== null) lines.push(`__hbc.r(${entryModuleId});`);
  lines.push(``);
  return lines.join("\n");
}

export function buildGitignore(): string {
  return [`node_modules/`, `*.bundle`, `.metro-*`, ``].join("\n");
}
