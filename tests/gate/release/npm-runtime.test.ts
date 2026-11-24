// 2026-11-24 benchmark findings: `npm i -g hbc2js` must work for an agent out
// of the box. Covers shipped docs/skill, runtime dependencies, the no-VM
// message, and progress output on the long-running commands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const root = repoRoot();
const CLI = join(root, "src", "cli.ts");
const RN_TEMPLATE = join(root, "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  files: string[];
  dependencies?: Record<string, string>;
};

function cli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// Imported lazily behind a try/catch with an actionable message; they power
// the dev-loop only (offline Metro bundling, seams), never a default command.
const OPTIONAL_DEV_LOOP = new Set(["metro", "metro-transform-worker", "@react-native/babel-preset", "@babel/core"]);

test("npm package: every bare import in src/ is a runtime dependency (or a documented dev-loop optional)", () => {
  const bad: string[] = [];
  const re = /(?:from\s+|import\(\s*)"([^".\/][^"]*)"/g;
  for (const f of tsFiles(join(root, "src"))) {
    const text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const m of text.matchAll(re)) {
      const spec = m[1]!;
      if (spec.startsWith("node:")) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
      if (pkg.dependencies?.[name] !== undefined || OPTIONAL_DEV_LOOP.has(name)) continue;
      bad.push(`${f.slice(root.length + 1)} imports ${name}`);
    }
  }
  assert.deepEqual(bad, [], "shipped code imports packages that are not in `dependencies`");
});

test("npm package: files ship the agent docs, skill and VM helper scripts", () => {
  for (const f of ["docs/agent-help", ".claude/skills/hbc2js", "tools/get-hermesc.sh"]) {
    assert.ok(pkg.files.includes(f), `package.json files must include ${f}`);
    assert.ok(existsSync(join(root, f)));
  }
});

test("help skill prints the SKILL.md; --help mentions it", () => {
  const r = cli(["help", "skill"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), readFileSync(join(root, ".claude", "skills", "hbc2js", "SKILL.md"), "utf8").trim());
  assert.match(cli(["--help"]).stdout, /help skill/);
});

test("equiv --boot with no VM gives an actionable message naming setup-vm", () => {
  const r = spawnSync(process.execPath, [CLI, "equiv", "--boot", RN_TEMPLATE, RN_TEMPLATE, "--vm", "/nonexistent/hermes"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  const none = spawnSync(process.execPath, [CLI, "equiv", "--boot", RN_TEMPLATE, RN_TEMPLATE], {
    encoding: "utf8",
    env: { ...process.env, HBC2JS_VM_SEARCH_ROOT: "/nonexistent-root" },
  });
  assert.match(none.stdout + none.stderr, /hbc2js setup-vm/);
  assert.match(none.stdout + none.stderr, /--vm/);
});

test("deps prints phase progress on stderr, silent under --json", () => {
  const r = cli(["deps", RN_TEMPLATE, "--offline"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^hbc2js deps: /m);
  const j = cli(["deps", RN_TEMPLATE, "--offline", "--json"]);
  assert.equal(j.status, 0, j.stderr);
  assert.doesNotMatch(j.stderr, /hbc2js deps: /);
});

test("setup-vm --help documents the pinned fetch and exits 0", () => {
  const r = cli(["setup-vm", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /setup-vm/);
});
