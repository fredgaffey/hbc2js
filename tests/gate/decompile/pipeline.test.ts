// The M4 pipeline end to end, and the CLI surface it exposes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { m4Binaries } from "../../support/m4.ts";
import { decompile, decompileTree, nodeCheck, parseForDecompile } from "../../../src/decompile.ts";
import { enabledPasses, REGISTRY } from "../../../src/passes/registry.ts";
import { ErrorCode, Hbc2jsError } from "../../../src/errors.ts";

const CLI = join(repoRoot(), "src", "cli.ts");

function fixture(name: string, file: string): string {
  return join(repoRoot(), "tests", "fixtures", "constructs", name, file);
}

function run(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("hbc2js <in.hbc> writes JavaScript that passes node --check", () => {
  const r = run([fixture("01-if-else-chain", "v94.hbc")]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\/\/ hbc2js -- decompiled from v94\.hbc/);
  assert.equal(nodeCheck(r.stdout).ok, true);
});

test("hbc2js --emit-tree prints the structurer's tree IR", () => {
  const r = run([fixture("02-while-loop", "v94.hbc"), "--emit-tree", "--function=0"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^; fn#0 "global"/);
  assert.match(r.stdout, /loop \{/);
});

test("hbc2js --no-verify still produces the same code for a reducible function", () => {
  const withVerify = run([fixture("01-if-else-chain", "v94.hbc")]);
  const without = run([fixture("01-if-else-chain", "v94.hbc"), "--no-verify"]);
  assert.equal(withVerify.stdout, without.stdout);
});

test("the existing subcommands still work (the decompile command is additive)", () => {
  const info = run(["--info", fixture("01-if-else-chain", "v94.hbc")]);
  assert.equal(info.status, 0, info.stderr);
  assert.match(info.stdout, /version:\s+94/);
  const disasm = run(["disasm", fixture("01-if-else-chain", "v94.hbc")]);
  assert.equal(disasm.status, 0, disasm.stderr);
  assert.match(disasm.stdout, /^; hbc2js disassembly/);
});

test("ambiguous v98 fixture decompiles by default (W_LAYOUT_ASSUMED); strictLayout refuses", () => {
  const path = fixture("20-let-const-tdz", "v98.hbc");
  const r = decompile(new Uint8Array(readFileSync(path)));
  assert.equal(r.forcedOpcodeTable, false);
  assert.ok(r.diagnostics.some((d) => d.code === "W_LAYOUT_ASSUMED"));
  assert.equal(nodeCheck(r.code).ok, true);
  assert.throws(
    () => parseForDecompile(new Uint8Array(readFileSync(path)), { strictLayout: true }),
    (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_LAYOUT_AMBIGUOUS,
  );
});

test("every gate binary decompiles with strictEnv and reports no error diagnostics", () => {
  const failures: string[] = [];
  for (const b of m4Binaries(["", ".min"])) {
    try {
      const r = decompile(new Uint8Array(readFileSync(b.path)), { resolveV98Ambiguity: true, moduleName: b.path });
      // W_PASS_ABANDONED (M5): per-site abandonment is D12's designed outcome
      // for a site a rung's `check` refuses, not an error — expr-rebuild's
      // conservative deadness proof legitimately abandons many sites across
      // this corpus (see the work log's expr-rebuild entry).
      // W_PASS_VERSION_SKIP (F7) is the same kind of designed outcome: a rung
      // whose `versions` predicate excludes this module's bytecode version is
      // reported once per function rather than silently dropped. `yield-recovery`
      // (spec 25, v<=96 only) is the first registered rung that fires it.
      // W_NO_CAPTURE_HOSTED (F24-5) is one summary info line per module: a
      // function that captures nothing and is created in exactly one function
      // is emitted inside that function instead of at module level. It is a
      // placement statement, not a problem -- it exists so the count is
      // observable on a large bundle.
      // W_IIFE_RECONSTRUCTED / W_IIFE_REFUSED (docs/specs/passes/27-iife-reconstruct.md)
      // are the same kind of summary: one line per function saying how many
      // inlined IIFEs the emitter put back, and one saying how many sibling
      // environments a guard left flat (with the reason counts). Refusing is
      // the designed outcome of every guard in that spec's refusal table and
      // changes nothing about the output.
      const unexpected = r.diagnostics.filter((d) => d.code !== "W_NO_CAPTURE_HOSTED" && d.code !== "W_FORCED_OPCODE_TABLE" && d.code !== "W_LAYOUT_ASSUMED" && d.code !== "W_ORPHAN_FUNCTION" && d.code !== "W_UNUSED_LABEL" && d.code !== "W_EXPANSION_CAP" && d.code !== "W_UNREACHABLE_BLOCK" && d.code !== "W_LOOP_LOCAL_ENV" && d.code !== "W_PASS_ABANDONED" && d.code !== "W_PASS_VERSION_SKIP" && d.code !== "W_PASS_REFUSED" && d.code !== "W_IIFE_RECONSTRUCTED" && d.code !== "W_IIFE_REFUSED");
      // W_UNPAIRED_NEW is EXPECTED on exactly the two inlined-construction
      // fixtures: their nested functions keep hermesc's dead
      // `CreateThisForNew` ahead of the inlined `new` (lowered directly,
      // output correct), which inline-new leaves in place -- spec 24 section
      // 9.5 item (a), docs/BUGS.md GetOwnPrivateBySym row.
      // 343 (review-1110): a base constructor's explicit `return o` and the
      // derived constructor's super-return are `SelectObject`s outside any
      // `new` triple, lowered directly (T2 matches the VM).
      const inlined = b.fixture === "90-inlined-new" || b.fixture === "91-inlined-new-derived" || b.fixture === "343-private-return-override-stamp";
      const reported = unexpected.filter((d) => !(inlined && d.code === "W_UNPAIRED_NEW"));
      if (reported.length > 0) failures.push(`${b.fixture} v${b.version}${b.variant}: ${reported.map((d) => d.code).join(", ")}`);
    } catch (e) {
      failures.push(`${b.fixture} v${b.version}${b.variant}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("the pass registry lists the M5 passes in dependency order", () => {
  // Was "empty at M4"; spec 07 §2.3. The ordering/negative tests live in
  // tests/gate/passes/framework.test.ts.
  // D23: structure-recovery rungs all precede the renaming block
  // (`fn-naming`, `reg-split`, `var-naming`); `jsx-recover` is last of the
  // structure block but is opt-in — absent from every `enabledPasses`
  // selection below unless `optIn` names it. `reg-split` is default-on
  // (P-11b resolved by the D23 reorder), so it appears in every selection
  // below.
  assert.deepEqual(REGISTRY.map((p) => p.name), ["finally-dedup", "fcall-diamond", "loop-cond", "for-header", "for-in", "for-of", "switch-raise", "if-chain", "try-shape", "label-clean", "expr-rebuild", "global-access", "globalthis-dead-store", "call-shape", "default-params", "destructure", "spread-rest", "template-literal", "optional-chain", "object-literal", "array-literal", "yield-recovery", "yield-loop", "async-recovery", "arguments-form", "literal-forms", "try-clean", "class-recover", "super-call", "ctor-this", "inline-new", "private-fields", "jsx-recover", "object-literal-arg", "fn-naming", "reg-split", "var-naming"]);
  assert.deepEqual(enabledPasses({ stage: "A" }).map((p) => p.name), ["finally-dedup", "fcall-diamond", "loop-cond", "for-header", "for-in", "for-of", "switch-raise", "if-chain", "try-shape", "label-clean"]);
  assert.deepEqual(enabledPasses({ skip: ["loop-cond"] }).map((p) => p.name), ["finally-dedup", "fcall-diamond", "for-header", "for-in", "for-of", "switch-raise", "if-chain", "try-shape", "label-clean", "expr-rebuild", "global-access", "globalthis-dead-store", "call-shape", "default-params", "destructure", "spread-rest", "template-literal", "optional-chain", "object-literal", "array-literal", "yield-recovery", "yield-loop", "async-recovery", "arguments-form", "literal-forms", "try-clean", "class-recover", "super-call", "ctor-this", "inline-new", "private-fields", "object-literal-arg", "fn-naming", "reg-split", "var-naming"]);
  assert.deepEqual(enabledPasses({ stage: "B" }).map((p) => p.name), ["expr-rebuild", "global-access", "globalthis-dead-store", "call-shape", "default-params", "destructure", "spread-rest", "template-literal", "optional-chain", "object-literal", "array-literal", "yield-recovery", "yield-loop", "async-recovery", "arguments-form", "literal-forms", "try-clean", "class-recover", "super-call", "ctor-this", "inline-new", "private-fields", "object-literal-arg", "fn-naming", "reg-split", "var-naming"]);
});

test("decompileTree covers every function of a module", () => {
  const text = decompileTree(new Uint8Array(readFileSync(fixture("23-generator-basic", "v94.hbc"))));
  for (let i = 0; i < 5; i++) assert.ok(text.includes(`; fn#${i} `), `fn#${i} missing`);
  assert.match(text, /switch b\d+ \(generator-state\)/);
});
