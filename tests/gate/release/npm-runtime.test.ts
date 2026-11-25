// 2026-11-24 benchmark findings: `npm i -g hbc2js` must work for an agent out
// of the box. Covers shipped docs/skill, runtime dependencies, the no-VM
// message, and progress output on the long-running commands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
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
// the dev-loop only (`seams`), never a default command. NOT metro or its babel
// transformer: `equiv --boot` (a shipped command) bundles with them, so they
// must come from the export tree's own node_modules (0.1.2 benchmark b1:
// "Cannot find package 'metro'" from an npm install).
const OPTIONAL_DEV_LOOP = new Set(["metro-transform-worker", "@react-native/babel-preset", "@babel/core"]);

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

test("npm package: no shipped .cjs/.mjs in src/ requires a package that is not a runtime dependency", () => {
  const bad: string[] = [];
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((e) => { const p = join(dir, e); return statSync(p).isDirectory() ? walk(p) : /\.(c|m)js$/.test(p) ? [p] : []; });
  for (const f of walk(join(root, "src"))) {
    const text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const m of text.matchAll(/(?:require\(\s*|from\s+|import\(\s*)"([^".\/][^"]*)"/g)) {
      const spec = m[1]!;
      if (spec.startsWith("node:")) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
      if (pkg.dependencies?.[name] === undefined) bad.push(`${f.slice(root.length + 1)} requires ${name}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("offline bundle check: an export with no node_modules (npm-installed hbc2js) says to npm install there", async () => {
  const { offlineBundle } = await import("../../../src/export/offline-check.ts");
  const tree = mkdtempSync(join(tmpdir(), "hbc2js-noinstall-"));
  const fakeHbc2js = mkdtempSync(join(tmpdir(), "hbc2js-pkg-"));
  try {
    writeFileSync(join(tree, "package.json"), "{}");
    writeFileSync(join(fakeHbc2js, "package.json"), "{}");
    await assert.rejects(offlineBundle(tree, fakeHbc2js), (e: Error) => {
      assert.match(e.message, /npm install/);
      assert.ok(e.message.includes(tree), e.message);
      return true;
    });
    assert.ok(!existsSync(join(tree, "node_modules")), "must not symlink a toolchain-less node_modules into the tree");
    // 0.1.2 benchmark b2: a RELATIVE export dir reached createRequire raw
    // ("argument 'filename' must be a file URL ... Received 'out/package.json'").
    await assert.rejects(offlineBundle(relative(process.cwd(), tree), relative(process.cwd(), fakeHbc2js)), /npm install/);
  } finally {
    rmSync(tree, { recursive: true, force: true });
    rmSync(fakeHbc2js, { recursive: true, force: true });
  }
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

test("worker modules resolve with the caller's own extension (a .ts-only URL breaks every npm install)", async () => {
  const { siblingWorkerPath } = await import("../../../src/util/worker-path.ts");
  assert.match(siblingWorkerPath("stage-a-worker", "file:///pkg/dist/parallel/pool.js"), /stage-a-worker\.js$/);
  assert.match(siblingWorkerPath("stage-a-worker", "file:///repo/src/parallel/pool.ts"), /stage-a-worker\.ts$/);
  for (const f of ["src/parallel/pool.ts", "src/workers/runner.ts"]) {
    assert.doesNotMatch(readFileSync(join(root, f), "utf8"), /new URL\("\.\/[\w-]+-worker\.ts"/, `${f} hardcodes a .ts worker URL`);
  }
});

test("hermesc discovery: env override, package tools/, user cache -- never cwd", async () => {
  const { findHermescBinary } = await import("../../../src/harness/hermes-vm.ts");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "hermesc-"));
  const savedEnv = { ...process.env };
  try {
    mkdirSync(join(dir, "cache", "hbc2js", "hermesc", "v77"), { recursive: true });
    writeFileSync(join(dir, "cache", "hbc2js", "hermesc", "v77", "hermesc"), "x");
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    assert.equal(findHermescBinary(77), join(dir, "cache", "hbc2js", "hermesc", "v77", "hermesc"));
    writeFileSync(join(dir, "env-hermesc"), "x");
    process.env.HERMESC_V77 = join(dir, "env-hermesc");
    assert.equal(findHermescBinary(77), join(dir, "env-hermesc"));
    delete process.env.HERMESC_V77;
    const cwd = process.cwd();
    mkdirSync(join(dir, "elsewhere", "tools", "hermesc", "v78"), { recursive: true });
    writeFileSync(join(dir, "elsewhere", "tools", "hermesc", "v78", "hermesc"), "x");
    process.chdir(join(dir, "elsewhere"));
    try {
      assert.equal(findHermescBinary(78), null, "cwd/tools/hermesc must not be consulted");
    } finally {
      process.chdir(cwd);
    }
  } finally {
    process.env = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("npm pack --dry-run contains the skill, agent docs and every runtime-read asset", () => {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const files = new Set((JSON.parse(r.stdout) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path));
  const required = [
    ".claude/skills/hbc2js/SKILL.md",
    "tools/get-hermesc.sh",
    "tools/build-hermes-vm.sh",
    ...["tldr", "tools", "workflow", "examples", "limits", "glossary", "boot"].map((t) => `docs/agent-help/${t}.md`),
  ];
  for (const f of required) assert.ok(files.has(f), `${f} is not in the npm tarball`);
  assert.ok([...files].some((f) => f.startsWith("tools/pkgsig/db/")), "signature db missing from tarball");
  // Every docs/ path SKILL.md cites must be packed.
  const skill = readFileSync(join(root, ".claude", "skills", "hbc2js", "SKILL.md"), "utf8");
  for (const m of skill.matchAll(/`(docs\/[A-Za-z0-9_./-]+\.md)`/g)) assert.ok(files.has(m[1]!), `SKILL.md cites ${m[1]} which is not packed`);
});

// 0.1.2 corpus benchmark: dist/export/offline-babel-transformer.cjs was not
// built (a hand-kept asset list), so `equiv --boot` from the npm package failed
// "the export does not bundle offline". Every file src/ reads at runtime by a
// path relative to its own module must land in dist (via tsc for .ts, via
// tools/copy-build-assets.mjs for anything else) or, when it resolves outside
// src/, in package.json `files`. Dev-checkout-only references are listed.
const DEV_CHECKOUT_ONLY = new Set([
  "ui/dist", // `hbc2js ui` serves a 404 page with a build hint when absent
  "tests/fixtures/constructs", // fuzzgen corpus, dev tooling only
]);

function runtimeRefs(): { from: string; target: string }[] {
  const refs: { from: string; target: string }[] = [];
  const strArgs = (list: string) => [...list.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  for (const f of tsFiles(join(root, "src"))) {
    if (f.includes(".test.")) continue;
    const text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const dir = dirname(f);
    const here = new Set(["dirname(fileURLToPath(import.meta.url))"]);
    for (const m of text.matchAll(/const (\w+) = dirname\(fileURLToPath\(import\.meta\.url\)\)/g)) here.add(m[1]!);
    for (const m of text.matchAll(/new URL\(\s*"(\.{1,2}\/[^"]*)",\s*import\.meta\.url\s*\)/g)) refs.push({ from: f, target: resolve(dir, m[1]!) });
    for (const m of text.matchAll(/siblingWorkerPath\(\s*"([^"]+)",\s*import\.meta\.url\s*\)/g)) refs.push({ from: f, target: resolve(dir, `${m[1]!}.ts`) });
    for (const h of here) {
      const esc = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const m of text.matchAll(new RegExp(`join\\(${esc},((?:\\s*"[^"]*"\\s*,?)+)\\)`, "g"))) refs.push({ from: f, target: resolve(dir, ...strArgs(m[1]!)) });
    }
  }
  return refs;
}

test("npm package: every file src/ loads at runtime by path is built into dist or packed", () => {
  const out = mkdtempSync(join(tmpdir(), "hbc2js-assets-"));
  try {
    const cp = spawnSync(process.execPath, [join(root, "tools", "copy-build-assets.mjs"), "--out", out], { encoding: "utf8" });
    assert.equal(cp.status, 0, cp.stderr);
    const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const packed = (JSON.parse(r.stdout) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path);
    const refs = runtimeRefs();
    assert.ok(refs.some((x) => x.target.endsWith("offline-babel-transformer.cjs")), "scanner must see the offline transformer");
    const bad: string[] = [];
    const srcRoot = join(root, "src");
    for (const { from, target } of refs) {
      const who = relative(root, from);
      if (target.startsWith(srcRoot + "/")) {
        const rel = relative(srcRoot, target);
        if (!existsSync(target)) bad.push(`${who} -> src/${rel} does not exist`);
        else if (rel.endsWith(".ts")) continue; // compiled by tsc (literal .ts URLs: next test)
        else if (!existsSync(join(out, rel))) bad.push(`${who} -> src/${rel} is not copied into dist by tools/copy-build-assets.mjs`);
        continue;
      }
      // Outside src/: dist sits at the same depth, so the path is package-relative.
      const rel = relative(root, target);
      if (rel === "") continue; // the package root itself
      if ([...DEV_CHECKOUT_ONLY].some((d) => rel === d || rel.startsWith(d + "/"))) continue;
      if (!packed.some((p) => p === rel || p.startsWith(rel + "/"))) bad.push(`${who} -> ${rel} is not in the npm tarball`);
    }
    assert.deepEqual(bad, [], "runtime-read files missing from the built package");
    assert.ok(packed.length > 0 && pkg.files.includes("dist"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("npm package: no module loads a sibling by a literal .ts URL (dist ships .js)", () => {
  const bad: string[] = [];
  for (const f of tsFiles(join(root, "src"))) {
    if (f.includes(".test.")) continue;
    if (/new URL\(\s*"[^"]*\.ts",\s*import\.meta\.url/.test(readFileSync(f, "utf8"))) bad.push(relative(root, f));
  }
  assert.deepEqual(bad, []);
});
