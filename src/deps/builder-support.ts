// Shared by `confirm.ts` (installCandidate/bundleAndCompile) and
// tools/pkgsig/bulk/build-one.mjs: the three Metro-bundle failure classes that
// capped signature recall (docs/PACKAGE-SIGNATURES.md "Builder failure classes").
//  1. Node-only built-ins (`os`, `node:util`, `fs`, ...) -> Metro cannot
//     resolve them. The builder config maps them to one empty module (only
//     when normal resolution fails, so an npm package named `events` still
//     wins). The shim is a trivial `module.exports = {}` factory.
//  2. Missing peer dependencies (strict install failed -> legacy fallback, or
//     peers are optional-by-convention) -> install the non-optional peers.
//  3. ENOSPC inotify: Metro's file map only watches when `!ci-info.isCI`;
//     `CI=true` in the child env turns the watcher off with no sysctl change.

export const NODE_BUILTINS: readonly string[] = [
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns",
  "domain", "events", "fs", "fs/promises", "http", "http2", "https", "inspector", "module", "net", "os", "path", "path/posix", "path/win32",
  "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "stream", "stream/promises", "string_decoder", "sys", "timers",
  "timers/promises", "tls", "tty", "url", "util", "util/types", "v8", "vm", "worker_threads", "zlib",
  "dns/promises", "readline/promises", "stream/web", "stream/consumers", "inspector/promises", "trace_events", "wasi", "sqlite", "test", "sea", "cluster", "tty",
];

export const BUILDER_METRO_CONFIG_NAME = "metro.hbc2js-builder.config.js";
export const BUILDER_SHIM_NAME = "hbc2js-node-shim.js";

/** Source of the Metro config (written beside the scratch project's own
 *  `metro.config.js`, passed via `--config`). Wraps that config. */
export function builderMetroConfigJs(): string {
  return `const path = require('path');
const fs = require('fs');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const BUILTINS = new Set(${JSON.stringify(NODE_BUILTINS)});
const SHIM = path.join(__dirname, ${JSON.stringify(BUILDER_SHIM_NAME)});
if (!fs.existsSync(SHIM)) fs.writeFileSync(SHIM, 'module.exports = {};\\n');
let base;
try { base = require('./metro.config.js'); } catch (e) { base = getDefaultConfig(__dirname); }
const prev = base.resolver && base.resolver.resolveRequest;
module.exports = mergeConfig(base, {
  resolver: {
    resolveRequest(context, moduleName, platform) {
      try {
        return prev ? prev(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
      } catch (err) {
        if (moduleName.startsWith('node:') || BUILTINS.has(moduleName)) return { type: 'sourceFile', filePath: SHIM };
        throw err;
      }
    },
  },
});
`;
}

/** Argv fragment selecting the builder config. */
export function builderConfigArgs(scratchDir: string): string[] {
  return ["--config", `${scratchDir}/${BUILDER_METRO_CONFIG_NAME}`];
}

/** Child env for `react-native bundle`: CI=true disables Metro's watcher. */
export function bundleEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, CI: "true" };
}

export interface PeerSpec { readonly name: string; readonly range: string }

/** Non-optional peers of a package.json that `isInstalled` says are absent.
 *  react / react-native are the scaffold's own and never installed here. */
export function missingPeers(pkgJson: { peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }, isInstalled: (name: string) => boolean): PeerSpec[] {
  const out: PeerSpec[] = [];
  for (const [name, range] of Object.entries(pkgJson.peerDependencies ?? {})) {
    if (name === "react" || name === "react-native") continue;
    if (pkgJson.peerDependenciesMeta?.[name]?.optional === true) continue;
    if (isInstalled(name)) continue;
    out.push({ name, range: typeof range === "string" && range !== "" ? range : "*" });
  }
  return out;
}

/** npm argv installing the missing peers (npm resolves the range). `spec` (the
 *  package itself) MUST be repeated: a `--no-save` install prunes earlier
 *  `--no-save` packages as extraneous, so peers alone would delete the target. */
export function peerInstallArgv(spec: string, peers: readonly PeerSpec[]): string[] {
  return ["install", spec, ...peers.map((p) => `${p.name}@${p.range}`), "--ignore-scripts", "--no-save", "--no-audit", "--no-fund", "--legacy-peer-deps"];
}

/** Bare package name of the first `Unable to resolve module X from ...` in
 *  Metro output, or null for relative paths / Node built-ins / no match. The
 *  builders install it (undeclared or optional peer, e.g. `tslib`,
 *  `drizzle-orm`) and retry, a bounded number of rounds. */
export function unresolvedBareModule(output: string): string | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const m = /Unable to resolve module (\S+?) from /.exec(text);
  if (!m) return null;
  const spec = m[1]!;
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || NODE_BUILTINS.includes(spec)) return null;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  return /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(name) ? name : null;
}
