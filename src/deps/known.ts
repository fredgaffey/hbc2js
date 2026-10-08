
import { readFileSync } from "node:fs";

export interface KnownPackage {
  readonly name: string;
  /** Exact version if known, `null` when only the name is (a lockfile
   *  entry with no resolved version, or a flat map that recorded null). */
  readonly version: string | null;
}

/** Strips a semver range prefix (`^`, `~`, `>=`, ` - `, ...) down to the
 *  first version-shaped token -- package.json ranges are for npm's
 *  resolver, not useful as an exact version to compare a signature against;
 *  informed mode only needs the bare version for reporting/tie-breaking,
 *  the candidate NAME is what drives the DB filter. `"*"`/`"latest"`/a
 *  workspace or git spec all fall back to `null` (no usable version). */
function stripRange(spec: string): string | null {
  const m = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(spec);
  return m === null ? null : m[0];
}

function isPackageJsonShape(raw: Record<string, unknown>): boolean {
  return typeof raw["dependencies"] === "object" || typeof raw["devDependencies"] === "object";
}

function fromDepsObject(deps: unknown, out: Map<string, string | null>): void {
  if (deps === null || typeof deps !== "object") return;
  for (const [name, rawVersion] of Object.entries(deps as Record<string, unknown>)) {
    const version = typeof rawVersion === "string" ? stripRange(rawVersion) : null;
    out.set(name, version);
  }
}

/** Parses an already-JSON.parse'd known-deps document. Two shapes accepted:
 *  (1) a real `package.json` (`dependencies`/`devDependencies` objects --
 *      version ranges are stripped to a bare version); (2) a flat
 *      `{ name: version | null }` map, which is what a resolved lockfile
 *      (or this repo's own `deps-truth.json`-shaped `packages` field, for
 *      test fixture-prep only) reduces to. Throws on anything else rather
 *      than silently returning an empty list. */
export function parseKnownDeps(raw: unknown): KnownPackage[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("parseKnownDeps: expected a JSON object (package.json or a flat name->version map)");
  }
  const obj = raw as Record<string, unknown>;
  const out = new Map<string, string | null>();
  if (isPackageJsonShape(obj)) {
    fromDepsObject(obj["dependencies"], out);
    fromDepsObject(obj["devDependencies"], out);
    return [...out.entries()].map(([name, version]) => ({ name, version }));
  }
  // Flat map shape: every value must be a string or null/undefined -- this
  // is how we reject an arbitrary unrelated JSON object (e.g. a truth file
  // passed by mistake, whose values are objects/arrays, not version
  // strings) rather than silently accepting garbage as package names.
  const entries = Object.entries(obj);
  if (entries.length === 0 || !entries.every(([, v]) => v === null || v === undefined || typeof v === "string")) {
    throw new Error("parseKnownDeps: not a package.json (no dependencies/devDependencies) and not a flat name->version map");
  }
  for (const [name, v] of entries) {
    out.set(name, typeof v === "string" ? (stripRange(v) ?? v) : null);
  }
  return [...out.entries()].map(([name, version]) => ({ name, version }));
}

/** Reads and parses a `--known` file from disk. */
export function loadKnownFile(path: string): KnownPackage[] {
  return parseKnownDeps(JSON.parse(readFileSync(path, "utf8")));
}
