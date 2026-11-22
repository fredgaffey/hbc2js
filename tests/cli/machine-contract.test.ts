// docs/specs/34-rea-provider.md — the `hbc2js-machine/1` JSON contract, exercised
// through the real CLI in a child process (argv arrays, never a shell string).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { VERSION } from "../../src/version.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const FIX = join(repoRoot(), "tests", "fixtures");
const construct = (name: string, v: string): string => join(FIX, "constructs", name, `${v}.hbc`);
const RN = join(FIX, "bundles", "rn-template-0.72", "index.android.hbc");

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}
function cli(args: readonly string[], opts: { env?: Record<string, string>; execArgv?: string[] } = {}): Run {
  const r = spawnSync(process.execPath, [...(opts.execArgv ?? []), CLI, ...args], { encoding: "utf8", shell: false, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...opts.env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function json(args: readonly string[], opts: Parameters<typeof cli>[1] = {}): { status: number | null; j: any } {
  const r = cli(args, opts);
  return { status: r.status, j: JSON.parse(r.stdout) };
}

test("machine 1: --version --json reports contract 1, VERSION and registry-derived hbcVersions", () => {
  const { status, j } = json(["--version", "--json"]);
  assert.equal(status, 0);
  assert.equal(j.schema, "hbc2js-machine/1");
  assert.equal(j.kind, "version");
  assert.equal(j.contract, 1);
  assert.equal(j.hbc2js, VERSION);
  assert.deepEqual(j.hbcVersions, [84, 94, 96, 98, 99]);
  assert.equal(typeof j.node, "string");
  // Text mode is unchanged.
  assert.equal(cli(["--version"]).stdout.trim(), VERSION);
});

test("machine 2: --info --json carries schema, input digest and warnings (W_LAYOUT_ASSUMED on ambiguous v98)", () => {
  const f = construct("01-if-else-chain", "v94");
  const { status, j } = json(["--info", f, "--json"]);
  assert.equal(status, 0);
  assert.equal(j.schema, "hbc2js-machine/1");
  assert.equal(j.kind, "info");
  assert.equal(j.input.sha256, createHash("sha256").update(readFileSync(f)).digest("hex"));
  assert.equal(j.input.bytes, readFileSync(f).length);
  assert.deepEqual(j.warnings, []);
  assert.equal(j.version, 94); // pre-contract fields still present
  const amb = json(["--info", construct("20-let-const-tdz", "v98"), "--json"]).j;
  assert.equal(amb.warnings.length, 1);
  assert.equal(amb.warnings[0].code, "W_LAYOUT_ASSUMED");
  assert.match(amb.warnings[0].message, /--opcode-table/);
});

test("machine 3: modules --json matches --split modules, pages exactly once; non-Metro is metro:false", () => {
  const out = mkdtempSync(join(tmpdir(), "hbc2js-mc-split-"));
  try {
    assert.equal(cli([RN, "--split", out]).status, 0);
    const split = JSON.parse(readFileSync(join(out, "MODULES.json"), "utf8")) as { modules: { id: number; factoryFunctionIndex: number; deps: number[] }[] };
    const full = json(["modules", RN, "--json", "--limit", "100000"]).j;
    assert.equal(full.kind, "modules");
    assert.equal(full.metro, true);
    assert.equal(full.total, split.modules.length);
    assert.equal(full.next, null);
    const want = [...split.modules].sort((a, b) => a.id - b.id).map((m) => ({ id: m.id, factoryFn: m.factoryFunctionIndex, deps: m.deps }));
    assert.deepEqual(full.rows.map((r: any) => ({ id: r.id, factoryFn: r.factoryFn, deps: r.deps })), want);
    for (const r of full.rows) assert.ok(Number.isInteger(r.fnCount) && r.fnCount >= 1);
    // Paging: offset+limit walks the list exactly once.
    const seen: number[] = [];
    let offset = 0;
    for (;;) {
      const p = json(["modules", RN, "--json", "--offset", String(offset), "--limit", "150"]).j;
      assert.equal(p.offset, offset);
      seen.push(...p.rows.map((r: any) => r.id));
      if (p.next === null) break;
      offset = p.next;
    }
    assert.deepEqual(seen, full.rows.map((r: any) => r.id));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  const non = json(["modules", construct("01-if-else-chain", "v94"), "--json"]);
  assert.equal(non.status, 0);
  assert.equal(non.j.metro, false);
  assert.deepEqual(non.j.rows, []);
  assert.equal(non.j.total, 0);
});

test("machine 4: decompile --fn N --json source is byte-equal to text mode; --module M equals its factory --fn", () => {
  const f = construct("22-nested-closures-counters", "v94");
  const text = cli(["decompile", f, "--fn", "2"]);
  const { status, j } = json(["decompile", f, "--fn", "2", "--json"]);
  assert.equal(status, 0);
  assert.equal(j.kind, "function");
  assert.equal(j.fn, 2);
  assert.equal(j.source, text.stdout);
  assert.equal(j.verified.syntax, true);
  assert.equal(j.verified.structurer, true);
  assert.equal(j.input.sha256, createHash("sha256").update(readFileSync(f)).digest("hex"));
  const row = json(["modules", RN, "--json", "--limit", "1"]).j.rows[0];
  const byModule = json(["decompile", RN, "--module", String(row.id), "--json"]).j;
  const byFn = json(["decompile", RN, "--fn", String(row.factoryFn), "--json"]).j;
  assert.equal(byModule.factoryOf, row.id);
  assert.equal(byModule.fn, row.factoryFn);
  assert.equal(byModule.source, byFn.source);
  assert.equal(byFn.moduleId, row.id);
});

test("machine 5: errors are a JSON envelope with spec 00 section 6.3 exit codes", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-mc-err-"));
  try {
    const good = construct("22-nested-closures-counters", "v94");
    const bytes = readFileSync(good);
    const truncated = join(dir, "trunc.hbc");
    writeFileSync(truncated, bytes.subarray(0, 100));
    const future = join(dir, "future.hbc");
    const b = Buffer.from(bytes);
    b.writeUInt32LE(200, 8);
    writeFileSync(future, b);
    const cases: { args: string[]; status: number; code: string }[] = [
      { args: ["--info", join(dir, "missing.hbc"), "--json"], status: 2, code: "E_IO" },
      { args: ["modules", join(dir, "missing.hbc"), "--json"], status: 2, code: "E_IO" },
      { args: ["--info", truncated, "--json"], status: 3, code: "E_TRUNCATED" },
      { args: ["decompile", truncated, "--fn", "0", "--json"], status: 3, code: "E_TRUNCATED" },
      { args: ["decompile", good, "--fn", "99999", "--json"], status: 2, code: "E_BAD_FUNCTION_ID" },
      { args: ["decompile", good, "--fn", "abc", "--json"], status: 2, code: "E_BAD_FUNCTION_ID" },
      { args: ["--info", future, "--json"], status: 4, code: "E_UNSUPPORTED_VERSION" },
      { args: ["modules", future, "--json"], status: 4, code: "E_UNSUPPORTED_VERSION" },
    ];
    for (const c of cases) {
      const { status, j } = json(c.args);
      assert.equal(status, c.status, c.args.join(" "));
      assert.equal(j.schema, "hbc2js-machine/1");
      assert.equal(j.kind, "error");
      assert.equal(j.ok, false);
      assert.equal(j.error.code, c.code, c.args.join(" "));
      assert.equal(typeof j.error.message, "string");
      assert.equal(typeof j.error.context, "object");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("machine 6: the four calls create no files and spawn no children", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hbc2js-mc-home-"));
  const logDir = mkdtempSync(join(tmpdir(), "hbc2js-mc-spy-"));
  const log = join(logDir, "spy.log");
  try {
    const env = { HOME: sandbox, TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox, HBC2JS_SPY_LOG: log };
    const execArgv = ["--import", join(repoRoot(), "tests", "cli", "spy-child-process.mjs")];
    const f = construct("22-nested-closures-counters", "v94");
    const calls: string[][] = [
      ["--version", "--json"],
      ["--info", f, "--json"],
      ["modules", f, "--json"],
      ["decompile", f, "--fn", "2", "--json"],
    ];
    for (const c of calls) {
      const r = cli(c, { env, execArgv });
      assert.equal(r.status, 0, `${c.join(" ")}: ${r.stderr}`);
      assert.equal(JSON.parse(r.stdout).ok, true);
    }
    assert.deepEqual(readdirSync(sandbox), [], "no file created under HOME/TMPDIR");
    assert.equal(existsSync(log), false, "child_process was called");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("machine 7: a heap limit too small for the input is E_RESOURCE (exit 3) with requiredMb, never an OOM", () => {
  const r = cli(["decompile", RN, "--fn", "1", "--json"], { env: { NODE_OPTIONS: "--max-old-space-size=64" } });
  assert.equal(r.status, 3);
  const j = JSON.parse(r.stdout);
  assert.equal(j.error.code, "E_RESOURCE");
  assert.ok(j.error.context.requiredMb > 64);
});

test("machine 8 (orchestrator review of L1): --module without --json is a usage error, never a silent whole-bundle decompile", () => {
  const good = construct(readdirSync(join(FIX, "constructs")).find((d) => existsSync(construct(d, "v96")))!, "v96");
  const r = cli(["decompile", good, "--module", "0"]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /E_USAGE/);
  assert.match(r.stderr, /--module.*--json/);
});
