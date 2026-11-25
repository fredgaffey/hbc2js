// src/export/boilerplate.ts — docs/specs/29-export.md §4: the project-root
// files a React Native tree needs before `npx react-native bundle` will even
// look at it, plus the toolchain table §4.3 requires (the build toolchain is
// not derivable from the bundle at all).
import type { DepsReport } from "../deps/report.ts";
import { expoCompatRange, expoSdkExpoVersion, expoSdkReactNative } from "./expo-compat.ts";
import { reactFitsRn, rnCompatPin, rnForReact, rnReactPeer } from "./rn-compat.ts";
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
  /** Set when the detected version was moved to agree with stronger evidence (the bundle's own react version). */
  readonly note?: string;
}

/** The react version the bundle's own constants carry, if any. */
function bundleReactVersion(report: DepsReport): string | null {
  const r = report.confirmedDeps.find((d) => d.package === "react" && d.versionEvidence === "bundle-string");
  return r?.version ?? null;
}

/** "RN 0.72.x-0.87.x" -> [72, 87]. */
function expectedMinorBounds(range: string | null): [number, number] | null {
  const m = range !== null ? /0\.(\d+)\.x(?:\s*-\s*0\.(\d+)\.x)?/.exec(range) : null;
  return m !== null ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
}

/** §4.3: RN version in priority order — `--rn-version`, then
 *  `DepsReport.reactNativeVersion`, then the newest RN minor the bundle's own
 *  HBC version is documented to ship. */
export function resolveReactNativeVersion(report: DepsReport, override: string | undefined): ReactNativeVersionResult {
  if (override !== undefined) {
    return { version: override, source: "flag", consistentWithHbc: report.reactNativeVersionConsistentWithHbc, expectedRange: report.reactNativeVersionExpectedRange };
  }
  if (report.reactNativeVersion !== null) {
    // A signature-matched RN is weaker than the bundle's own react version
    // constant: when the two cannot install together (npm ERESOLVE, e.g. react
    // 19 beside RN 0.73's react@18.2.0 peer), move RN to the nearest line whose
    // react peer admits the bundle's react.
    const react = bundleReactVersion(report);
    if (report.reactNativeVersionSource !== "bundle-string" && react !== null && !reactFitsRn(react, report.reactNativeVersion)) {
      const bounds = expectedMinorBounds(report.reactNativeVersionExpectedRange);
      const moved = rnForReact(react, report.reactNativeVersion, bounds?.[0], bounds?.[1]) ?? rnForReact(react, report.reactNativeVersion);
      if (moved !== null) {
        return {
          version: moved.version,
          source: "deps-signature-match",
          consistentWithHbc: report.reactNativeVersionConsistentWithHbc,
          expectedRange: report.reactNativeVersionExpectedRange,
          note: `signature match ${report.reactNativeVersion} declares react ${rnReactPeer(report.reactNativeVersion)}, which excludes the bundle's react ${react}; ${moved.note}`,
        };
      }
    }
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

/** The `@react-native-community/cli` and `metro` lines RN ships against, by RN
 *  minor (npm registry: react-native@<minor>'s own `@react-native-community/cli`
 *  dependency up to 0.75, `@react-native/community-cli-plugin`'s `metro`
 *  dependency from 0.73). From RN 0.76 RN no longer depends on the CLI and
 *  `npx react-native bundle` needs it as a project devDependency; before 0.76
 *  RN brings its own, so the devDependency only has to agree with it. Before
 *  0.70 `cli` is null (RN's own dependency serves) and `metro` is RN's own line. */
export function cliAndMetroFor(minor: number | null): { readonly cli: string | null; readonly metro: string } {
  if (minor === null || minor >= 81) return { cli: "^20.0.0", metro: "^0.83.0" };
  const rows: readonly (readonly [number, string, string])[] = [
    [80, "^19.0.0", "^0.82.0"],
    [79, "^18.0.0", "^0.82.0"],
    [76, "^15.0.0", "^0.81.0"],
    [75, "^14.0.0", "^0.80.0"],
    [74, "^13.6.0", "^0.80.0"],
    [73, "^12.3.0", "^0.80.0"],
    [72, "^11.4.0", "^0.76.0"],
    [71, "^10.2.0", "^0.73.0"],
    [70, "^9.3.0", "^0.72.0"],
  ];
  for (const [from, cli, metro] of rows) if (minor >= from) return { cli, metro };
  // Before 0.70 RN's own CLI (cli 2-8, through cli-plugin-metro from cli 6)
  // bundles with the metro line of RN's own `metro-react-native-babel-transformer`
  // dependency; the devDependencies must be that line, or the CLI's worker runs
  // under a newer metro-config's defaults (corpus a08: RN 0.66.4 + metro 0.76
  // config -> countLines(undefined) in metro-transform-worker 0.66).
  const legacy: readonly (readonly [number, string])[] = [
    [69, "^0.70.0"],
    [68, "^0.67.0"],
    [65, "^0.66.2"],
    [64, "^0.64.0"],
    [63, "^0.59.0"],
    [62, "^0.58.0"],
    [61, "^0.56.0"],
  ];
  for (const [from, metro] of legacy) if (minor >= from) return { cli: null, metro };
  return { cli: null, metro: "^0.54.1" };
}

export function TOOLCHAIN_FOR_RN(rnVersion: string | null): Record<string, string> {
  const modern = isModernRnToolchain(rnVersion);
  const tool = cliAndMetroFor(rnMinor(rnVersion));
  const common: Record<string, string> = {
    "@babel/core": "^7.25.0",
    ...(tool.cli === null ? {} : { "@react-native-community/cli": tool.cli }),
  };
  if (modern) {
    return {
      ...common,
      "@react-native/babel-preset": rnVersion!,
      "@react-native/metro-config": rnVersion!,
      metro: tool.metro,
    };
  }
  // Legacy toolchain: the babel preset and metro-config are published in
  // lockstep with metro itself.
  return {
    ...common,
    "metro-react-native-babel-preset": tool.metro,
    metro: tool.metro,
    "metro-config": tool.metro,
  };
}

/** Expo SDK major that ships with a given RN minor (Expo pins one RN per SDK). */
export function expoSdkForRn(rnVersion: string | null): number | null {
  const minor = rnMinor(rnVersion);
  const table: Readonly<Record<number, number>> = { 73: 50, 74: 51, 76: 52, 79: 53, 81: 54, 83: 55 };
  return minor === null ? null : (table[minor] ?? null);
}

export type ExportDepLevel = "confirmed" | "bundle-string" | "guessed" | "hint" | "native-channel" | "peer";
export interface ExportDep {
  readonly version: string;
  readonly level: ExportDepLevel;
  readonly confidence: number | null;
  /** True when the version is a placeholder/derived pin rather than evidence of this package's own version. */
  readonly versionDerived: boolean;
  /** Why the version differs from (or is not backed by) the signature evidence. */
  readonly note?: string;
}

const NAV_7_PACKAGES = new Set(["native", "stack", "bottom-tabs", "native-stack", "drawer", "core", "routers", "material-top-tabs"]);

/** Every dependency package.json should carry, with the evidence level of each:
 *  confirmed (signature match / bundle version constant), then guessed, hinted
 *  and native-channel detections, which a build still needs even though only
 *  their name (not their version) is evidenced. Unknown versions: Expo SDK
 *  packages get the SDK line matching the RN version, everything else `*`. */
export function exportDependencies(report: DepsReport, rnVersion: string | null): Record<string, ExportDep> {
  const out: Record<string, ExportDep> = {};
  const sdk = expoSdkForRn(rnVersion);
  // Never let the Expo table contradict the detected RN: use it only when the
  // SDK's own react-native pin is the detected RN's minor line.
  const sdkRn = sdk === null ? null : expoSdkReactNative(sdk);
  const useTable = sdk !== null && sdkRn !== null && rnMinor(sdkRn) === rnMinor(rnVersion);
  for (const d of report.confirmedDeps) {
    // A fork relabel (`forkOf`): the matched signature, and so the version,
    // is the UPSTREAM package's. The fork has its own version line (corpus
    // a06: react-native-camera-kit-no-google has no 4.2.1, npm ETARGET), so
    // its version is unknown, not the upstream's.
    if (d.forkOf !== undefined) {
      out[d.package] = { version: "*", level: "confirmed", confidence: tierConfidenceScore(d.confidence), versionDerived: true, note: `fork of ${d.forkOf}; the signature version ${d.version} is ${d.forkOf}'s, not this package's` };
      continue;
    }
    out[d.package] = { version: d.version, level: d.versionEvidence === "bundle-string" ? "bundle-string" : "confirmed", confidence: tierConfidenceScore(d.confidence), versionDerived: false };
  }
  const add = (name: string, version: string | null, level: ExportDepLevel, confidence: number | null): void => {
    if (out[name] !== undefined) return;
    out[name] = { version: version ?? "*", level, confidence, versionDerived: version === null };
  };
  for (const g of report.guessedDeps) add(g.package, g.version, "guessed", g.confidence);
  for (const h of report.hintedDeps) add(h.package, h.version, "hint", h.confidence);
  for (const n of report.nativeChannel?.deps ?? []) add(n.package, null, "native-channel", null);

  for (const [name, d] of Object.entries(out)) {
    if (d.level === "bundle-string") continue; // the bundle's own constants beat any table
    const range = useTable ? expoCompatRange(sdk!, name) : null;
    if (range !== null && range !== d.version) {
      out[name] = { ...d, version: range, note: d.versionDerived ? `pinned from Expo SDK ${sdk} bundledNativeModules.json` : `signature version ${d.version} conflicts with Expo SDK ${sdk} (${range}); using the SDK's range` };
    } else if (range === null && d.versionDerived) {
      if ((name === "expo" || name.startsWith("expo-")) && sdk !== null) out[name] = { ...d, version: `~${sdk}.0.0`, note: `Expo SDK ${sdk} line derived from the detected RN; not in the compat table` };
      else {
        const pin = rnVersion !== null ? rnCompatPin(name, rnVersion) : null;
        out[name] = pin !== null ? { ...d, version: pin.version, note: pin.note } : { ...d, note: "unpinned: no version evidence and no compatibility table for this package" };
      }
    }
  }
  // `expo` itself is not in its own bundledNativeModules.json, so a signature
  // version survived even when the RN pins another SDK (corpus a10: expo
  // 52.0.28 beside SDK 55's expo-* ranges; a06: 51.0.29 under RN 0.83). The
  // table was read from one `expo` release: pin exactly that one.
  const expoDep = out["expo"];
  const expoVersion = useTable ? expoSdkExpoVersion(sdk!) : null;
  if (expoDep !== undefined && expoVersion !== null && expoDep.level !== "bundle-string" && expoDep.version !== expoVersion) {
    out["expo"] = { ...expoDep, version: expoVersion, versionDerived: true, note: `${expoDep.versionDerived ? "no version evidence" : `signature version ${expoDep.version}`}; Expo SDK ${sdk} (the detected RN's SDK) is expo ${expoVersion}, the release the SDK table was read from` };
  }
  // Every RN app needs react-native and react themselves; a bundle whose deps
  // pass matched neither (corpus a02: 48k functions, no confirmed deps) still
  // gets them, or `npx react-native bundle` has no `bundle` command at all.
  if (rnVersion !== null && out["react-native"] === undefined) {
    out["react-native"] = { version: useTable && sdkRn !== null ? sdkRn : rnVersion, level: "peer", confidence: null, versionDerived: true, note: "every React Native app depends on react-native; version from EXPORT.json reactNative" };
  }
  if (rnVersion !== null && out["react"] === undefined) {
    const peer = (useTable ? expoCompatRange(sdk!, "react") : null) ?? rnReactPeer(rnVersion);
    if (peer !== null) out["react"] = { version: peer, level: "peer", confidence: null, versionDerived: true, note: `peer dependency of react-native ${rnVersion}` };
  }
  // react and react-native are peers of each other's line: keep the RN entry on
  // the resolved RN, and move a weaker-evidenced react onto RN's react peer.
  const rnDep = out["react-native"];
  if (rnVersion !== null && rnDep !== undefined && rnDep.version !== rnVersion && rnDep.level !== "bundle-string") {
    out["react-native"] = { ...rnDep, version: rnVersion, versionDerived: true, note: `signature version ${rnDep.version} replaced by the resolved react-native ${rnVersion} (EXPORT.json reactNative)` };
  }
  const reactDep = out["react"];
  const reactPeer = rnVersion !== null ? rnReactPeer(rnVersion) : null;
  if (reactDep !== undefined && reactPeer !== null && reactDep.level !== "bundle-string" && !(reactDep.version !== "*" && reactFitsRn(reactDep.version, rnVersion!))) {
    out["react"] = { ...reactDep, version: reactPeer, versionDerived: true, note: `react-native ${rnVersion} declares peer react ${reactPeer}; ${reactDep.version} would not install beside it` };
  }
  // reanimated >= 4 hard-requires react-native-worklets as a peer; without it
  // `npm install` fails with ERESOLVE (or pulls a worklets built for another RN).
  const reanimated = out["react-native-reanimated"];
  const workletsRange = useTable ? expoCompatRange(sdk!, "react-native-worklets") : null;
  if (reanimated !== undefined && out["react-native-worklets"] === undefined && workletsRange !== null && Number(/(\d+)\./.exec(reanimated.version)?.[1] ?? 0) >= 4) {
    out["react-native-worklets"] = { version: workletsRange, level: "peer", confidence: null, versionDerived: true, note: `peer dependency of react-native-reanimated ${reanimated.version}; pinned from Expo SDK ${sdk} bundledNativeModules.json` };
  }
  if (report.reactNavigationApi7 === true) {
    for (const [name, d] of Object.entries(out)) {
      const m = /^@react-navigation\/(.+)$/.exec(name);
      if (m === null || !NAV_7_PACKAGES.has(m[1]!) || d.level === "bundle-string") continue;
      const major = /^[~^]?(\d+)\./.exec(d.version);
      if (major !== null && Number(major[1]) >= 7) continue;
      out[name] = { ...d, version: "^7.0.0", versionDerived: true, note: `signature version ${d.version} is 6.x but the bundle uses the static-config API (createStaticNavigation), which exists only in 7.x` };
    }
  }
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
    // Every package in the tree sees the app's own react / react-native: a
    // dependency whose (often optional) peer range names another line no
    // longer fails `npm install` with ERESOLVE (corpus a06: ai@2.2.32's
    // optional peer react ^18.2.0 beside RN 0.83's react 19).
    ...frameworkOverrides(dependencies),
  };
}

/** npm `overrides` pinning react and react-native, wherever they appear in
 *  the tree (peer edges included), to the root's own spec. The literal spec,
 *  not npm's `$name` reference: npm 10.9 fails `$react` with "Unable to
 *  resolve reference" (corpus a10 re-run). */
export function frameworkOverrides(dependencies: Readonly<Record<string, string>>): { overrides?: Record<string, string> } {
  const names = ["react", "react-native"].filter((n) => dependencies[n] !== undefined);
  return names.length === 0 ? {} : { overrides: Object.fromEntries(names.map((n) => [n, dependencies[n]!])) };
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
      // Old Metro (metro-cache stableHash) hashes with md4, which OpenSSL 3
      // (Node >= 17) no longer provides: "error:0308010C:digital envelope
      // routines::unsupported" before any bundling (corpus a08, RN 0.66.4 on
      // Node 22). The cache key only needs a stable digest.
      `const crypto = require("node:crypto");`,
      `const createHash = crypto.createHash;`,
      `crypto.createHash = (algorithm, ...rest) => createHash(algorithm === "md4" ? "sha256" : algorithm, ...rest);`,
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
