// Shared helpers for the spec 29 (`docs/specs/29-export.md`) acceptance tests.
//
// These tests ship WITH the spec and before the implementation: every test in
// this directory is guarded by `IMPLEMENTED` and skips itself until
// `src/export/index.ts` exists (spec 29 §9). That keeps the test count stable
// across the spec -> implementation boundary: the export implementation does not add gate
// tests, it turns these green.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { repoRoot } from "../../support/paths.ts";

export const CLI = join(repoRoot(), "src", "cli.ts");

/** Spec 29 §9: the guard that keeps these tests skipped-by-design until the
 *  export implementation lands. */
export const IMPLEMENTED = existsSync(join(repoRoot(), "src", "export", "index.ts"));

export const RN_TEMPLATE = join(
  repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.debug.hbc",
);
export const HELD_OUT = join(
  repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3",
  "react-navigation-example.debug.hbc",
);

export interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function runCli(args: readonly string[]): CliRun {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const OUT_TOKEN = "\u0000OUT\u0000";
let fingerprintMemo: string | undefined;

/** sha1 of path+CONTENT of every file under src/ and third_party/ plus the
 *  lockfile: any change to the exporter or its data tables invalidates the
 *  export cache (see docs/TESTING.md "Test suite performance"). */
function inputFingerprint(): string {
  if (fingerprintMemo !== undefined) return fingerprintMemo;
  const h = createHash("sha1");
  const visit = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else { h.update(`${p.slice(repoRoot().length)}\0`); h.update(readFileSync(p)); h.update("\0"); }
    }
  };
  visit(join(repoRoot(), "src"));
  visit(join(repoRoot(), "third_party"));
  h.update(readFileSync(join(repoRoot(), "package-lock.json")));
  fingerprintMemo = h.digest("hex");
  return fingerprintMemo;
}

/** Export `bundle` into a fresh temp dir and return it. Callers pass the dir to
 *  `cleanup` when done. Successful exports are memoised on disk (keyed by bundle
 *  bytes + args + inputFingerprint) and each call gets its own fresh COPY of the
 *  cached tree, so tests may still mutate or build inside `out`. The output path in
 *  stdout/stderr is stored as a token and re-substituted on a hit. */
export function exportTo(bundle: string, extra: readonly string[] = []): { out: string; run: CliRun } {
  const out = mkdtempSync(join(tmpdir(), "hbc2js-export-"));
  const key = createHash("sha1").update(readFileSync(bundle)).update("\0").update(JSON.stringify(extra)).update("\0").update(inputFingerprint()).digest("hex");
  const root = join(tmpdir(), "hbc2js-test-export-cache-v1", key);
  try {
    const meta = JSON.parse(readFileSync(join(root, "meta.json"), "utf8")) as CliRun;
    cpSync(join(root, "tree"), out, { recursive: true });
    const back = (x: string): string => x.split(OUT_TOKEN).join(out);
    return { out, run: { status: meta.status, stdout: back(meta.stdout), stderr: back(meta.stderr) } };
  } catch { /* miss: fall through */ }
  const run = runCli(["export", bundle, "--out", out, "--overwrite", ...extra]);
  if (run.status === 0) {
    const tmp = `${root}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      mkdirSync(tmp, { recursive: true });
      cpSync(out, join(tmp, "tree"), { recursive: true });
      writeFileSync(join(tmp, "meta.json"), JSON.stringify({ status: run.status, stdout: run.stdout.split(out).join(OUT_TOKEN), stderr: run.stderr.split(out).join(OUT_TOKEN) }));
      renameSync(tmp, root);
    } catch {
      rmSync(tmp, { recursive: true, force: true }); // lost a race or disk issue: cache is best-effort
    }
  }
  return { out, run };
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Every file under `dir`, as paths relative to `dir`, POSIX separators. */
export function walk(dir: string, base: string = dir): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walk(full, base));
    else found.push(relative(base, full).split("\\").join("/"));
  }
  return found;
}

export interface ExportManifest {
  readonly schema: string;
  readonly producer: { readonly hbc2js: string; readonly ts: string };
  readonly source: { readonly bundleSha256: string; readonly hbcVersion: number; readonly moduleCount: number; readonly entryModule: number | null };
  readonly app: { readonly name: string; readonly nameSource: string };
  readonly reactNative: { readonly version: string | null; readonly source: string };
  readonly dependencies: Readonly<Record<string, { readonly version: string; readonly kind: string; readonly source: string; readonly confidence: number | null }>>;
  readonly modules: readonly {
    readonly id: number;
    readonly path: string;
    readonly bucket: string;
    readonly tier: string;
    readonly tierDowngradeReason: string | null;
    readonly rendersJsx: boolean;
    readonly eagerDeps: number;
    readonly lazyDeps: number;
  }[];
  readonly substitutions: readonly {
    readonly package: string;
    readonly version: string;
    readonly confidence: number;
    readonly boundaryModule: number;
    readonly replacedModules: readonly number[];
    readonly edgesRewritten: number;
  }[];
  readonly unresolved: readonly { readonly kind: string; readonly detail: string }[];
  readonly counts: Readonly<Record<string, unknown>>;
  readonly leftOut: readonly string[];
}

export function readManifest(out: string): ExportManifest {
  return JSON.parse(readFileSync(join(out, "EXPORT.json"), "utf8")) as ExportManifest;
}

export interface PackageJson {
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

export function readPackageJson(out: string): PackageJson {
  return JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as PackageJson;
}

/** Every module id the split tree registered, read from the export tree's own
 *  MODULES.json when present, else from a separate `--split` run's copy. */
export function moduleIdsOf(modulesJsonPath: string): number[] {
  const parsed = JSON.parse(readFileSync(modulesJsonPath, "utf8")) as {
    readonly modules: readonly { readonly id: number }[];
  };
  return parsed.modules.map((m) => m.id);
}

/** Literal `require("...")` specifiers in a file. Spec 29 §4.4: Metro resolves
 *  statically, so every edge must be one of these. */
export function requireSpecifiers(text: string): string[] {
  const out: string[] = [];
  const re = /require\((['"])([^'"]+)\1\)/g;
  for (const m of text.matchAll(re)) {
    const spec = m[2];
    if (spec !== undefined) out.push(spec);
  }
  return out;
}
