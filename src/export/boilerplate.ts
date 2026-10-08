// src/export/boilerplate.ts — docs/specs/29-export.md §4: the project-root
// files a React Native tree needs before `npx react-native bundle` will even
// look at it, plus the toolchain table §4.3 requires (the build toolchain is
// not derivable from the bundle at all).
import type { DepsReport } from "../deps/report.ts";
import { newestRnVersionForHbc, packageJsonDependencies } from "../deps/report.ts";

export interface AppNameResult {
  readonly name: string;
  readonly source: "flag" | "registerComponent" | "fallback";
}

const REGISTER_COMPONENT_LITERAL_RE = /\.registerComponent\(\s*(['"])([^'"]+)\1\s*,/;
const REGISTER_COMPONENT_VAR_RE = /\.registerComponent\(\s*\w+\s*,/;
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
  readonly source: "flag" | "deps-confirmed" | "hbc-range";
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
      source: "deps-confirmed",
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

export function TOOLCHAIN_FOR_RN(rnVersion: string | null): Record<string, string> {
  const modern = isModernRnToolchain(rnVersion);
  const common = {
    "@babel/core": "^7.25.0",
    "@react-native-community/cli": "^13.0.0",
  };
  if (modern) {
    return {
      ...common,
      "@react-native/babel-preset": rnVersion!,
      "@react-native/metro-config": rnVersion!,
      metro: "^0.80.0",
    };
  }
  return {
    ...common,
    "metro-react-native-babel-preset": "^0.77.0",
    metro: "^0.76.0",
    "metro-config": "^0.76.0",
  };
}

export function buildPackageJson(opts: {
  readonly appName: string;
  readonly report: DepsReport;
  readonly rnVersion: string | null;
}): Record<string, unknown> {
  const dependencies = packageJsonDependencies(opts.report);
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

/** §4.1: boots the registry, then runs the entry module (which registers
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
export function buildIndexJs(entryModuleId: number | null, entryPath: string | null): string {
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
  lines.push(`require("./src/_hbc/registry.js");`); // installs the module registry, unused directly here
  if (entryModuleId !== null && entryPath !== null) {
    lines.push(`require("./${entryPath}");`); // the entry module registers itself, then runs
  }
  lines.push(``);
  return lines.join("\n");
}

export function buildGitignore(): string {
  return [`node_modules/`, `*.bundle`, `.metro-*`, ``].join("\n");
}
