// docs/specs/35-agent-harness.md Part 1, acceptance 1-3: `--evidence` on the
// four spec-34 machine calls. Without the flag the output is byte-identical to
// the golden pinned under tests/fixtures/agent/machine-no-evidence/ (the only
// masked field is `node` in the version reply: it is the running Node version).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const FIX = join(repoRoot(), "tests", "fixtures");
const GOLD = join(FIX, "agent", "machine-no-evidence");
const F = join(FIX, "constructs", "22-nested-closures-counters", "v94.hbc");

function cli(args: readonly string[]): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout };
}
const gold = (n: string): string => readFileSync(join(GOLD, n), "utf8");
const maskNode = (s: string): string => s.replace(/"node":"[^"]*"/, '"node":"X"');

test("evidence 1: the four machine calls without --evidence are byte-identical to the pinned golden", () => {
  assert.equal(maskNode(cli(["--version", "--json"]).stdout), maskNode(gold("version.json")));
  assert.equal(cli(["--info", F, "--json"]).stdout, gold("info.json"));
  assert.equal(cli(["modules", F, "--json"]).stdout, gold("modules.json"));
  assert.equal(cli(["decompile", F, "--fn", "1", "--json"]).stdout, gold("function-fn.json"));
  assert.equal(cli(["decompile", F, "--module", "0", "--json"]).stdout, gold("function-module.json"));
});

test("evidence 1b: with --evidence every pre-existing field is unchanged (deep-equal after deleting evidence)", () => {
  const pairs: [string[], string][] = [
    [["--info", F, "--json", "--evidence"], "info.json"],
    [["modules", F, "--json", "--evidence"], "modules.json"],
    [["decompile", F, "--fn", "1", "--json", "--evidence"], "function-fn.json"],
  ];
  for (const [args, g] of pairs) {
    const j = JSON.parse(cli(args).stdout);
    assert.ok(j.evidence !== undefined, args.join(" "));
    delete j.evidence;
    assert.deepEqual(j, JSON.parse(gold(g)));
  }
  const v = JSON.parse(cli(["--version", "--json", "--evidence"]).stdout);
  assert.equal(v.evidence.provenance.producer, "hbc2js");
  delete v.evidence;
  assert.deepEqual({ ...v, node: "X" }, { ...JSON.parse(gold("version.json")), node: "X" });
});

test("evidence 2: info labels functionCount and version observed; function labels source derived; provenance.input.sha256 matches input.sha256", () => {
  const info = JSON.parse(cli(["--info", F, "--json", "--evidence"]).stdout);
  assert.equal(info.evidence.labels.functionCount, "observed");
  assert.equal(info.evidence.labels.version, "observed");
  assert.equal(info.evidence.provenance.input.sha256, info.input.sha256);
  const fn = JSON.parse(cli(["decompile", F, "--fn", "1", "--json", "--evidence"]).stdout);
  assert.equal(fn.evidence.labels.source, "derived");
  assert.equal(fn.evidence.labels.verified, "derived");
  assert.equal(fn.evidence.provenance.input.sha256, fn.input.sha256);
  assert.equal(fn.evidence.provenance.passes, "default");
  const mods = JSON.parse(cli(["modules", F, "--json", "--evidence"]).stdout);
  assert.equal(mods.evidence.provenance.input.sha256, mods.input.sha256);
});

test("evidence 3: with passes on and a name the name pass changed, `name` is inferred; with --passes=none or an unrenamed fn it is observed", () => {
  const on = JSON.parse(cli(["decompile", F, "--fn", "0", "--json", "--evidence"]).stdout);
  assert.equal(on.evidence.labels.name, "inferred");
  const off = JSON.parse(cli(["decompile", F, "--fn", "0", "--json", "--passes=none", "--evidence"]).stdout);
  assert.equal(off.evidence.labels.name, "observed");
  assert.equal(off.evidence.provenance.passes, "none");
});
