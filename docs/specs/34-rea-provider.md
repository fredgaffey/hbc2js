# 34 — A stable machine contract for the REA provider

**Status: SPEC (process v2).** New subsystem: the CLI surface an external
orchestrator (REA, "Reverse Engineer Anything", MIT) calls as a
caller-supplied provider. The REA-side plan is a private working note.

## Problem

REA integrates outside tools by launching a caller-selected executable,
admitting its version, and parsing its output into Evidence. It needs to:
identify a Hermes bundle, list its Metro modules, and decompile one function or
module. Today `--info --json` has no schema tag, digest or warnings;
`--version` prints a bare string; module listing requires a full `--split`;
`decompile --fn N` prints text only; and the syntax check spawns `node --check`
on a temporary file. REA would have to scrape text and declare process and
file-write effects for what is a read-only analysis.

## Choice

Add a small, versioned JSON contract (`hbc2js-machine/1`) to existing commands,
plus one new read-only `modules` command. Every JSON reply is one object on
stdout, carrying `schema`, the producer version, the input digest and
`warnings[]`. The contract is additive: text output and other `--json` shapes
stay as they are. REA calls only the commands below. It never calls `equiv`
(runs a Hermes VM), `deps --confirm` (network) or `--split`/`export`/`init`
(writes trees).

**Rejected: drive REA through `hbc2js mcp-server`.** It needs a project
directory (spec 17), which is a persistent writable store with an annotation
model. REA's providers are one-shot static reads with their own Evidence and
session model. Bridging two session models would double the lifecycle surface
REA reviews, and the MCP tools are designed for the readability loop, not for
format inspection.

## Contract (`schema: "hbc2js-machine/1"`)

| Call | Reply `kind` | Notes |
|---|---|---|
| `hbc2js --version --json` | `version` | `{hbc2js, contract: 1, hbcVersions: number[], node}`; `hbcVersions` is the sorted list of bytecode versions the opcode-table registry (`src/tables/registry.ts`) accepts, derived from it, never hand-written (the supported set has gaps). REA admits `contract === 1`. |
| `hbc2js --info <in.hbc> --json` | `info` | Today's fields (version, layoutClass, opcodeTable, probe, functionCount, stringCount, sections) plus `input: {sha256, bytes}` and `warnings` (e.g. `W_LAYOUT_ASSUMED` with its override text). |
| `hbc2js modules <in.hbc> --json [--offset N] [--limit N]` | `modules` | **New.** Metro `__d` registrations found by scanning the global function's bytecode only (no decompile): `{total, offset, rows:[{id, factoryFn, deps:[id], fnCount}], next}`, sorted by `id`. Default limit 500. `metro: false, rows: []` for a non-Metro bundle. That is a fact, not an error. |
| `hbc2js decompile <in.hbc> --fn N --json [--passes=none]` | `function` | `{fn, name, moduleId, factoryOf, source, verified: {structurer, syntax}, passes}`. `--module M` resolves to M's factory fn and sets `factoryOf: M`. |

Common rules:
- **Errors.** In JSON mode, the reply is `{schema, kind:"error", ok:false, error:{code, message, context}}` on stdout. Exit codes follow spec 00 §6.3: 0 ok, 1 internal, 2 usage, 3 decode, 4 unsupported/ambiguous version or layout, 5 verification failure. Exit 5 still returns `source`, with `verified.syntax:false`.
- **No side effects.** The four calls read only the input file. They write nothing outside stdout/stderr and spawn no children. In JSON mode the syntax check compiles with `vm.Script` (compile only, never run) instead of `node --check` on a temp file. No network.
- **Size and time.** hbc2js sets no wall-clock limit of its own. REA owns the deadline and kills the process; a kill leaves no state behind. Memory: honour `NODE_OPTIONS=--max-old-space-size=<MB>`. When the heap estimate exceeds the limit, fail fast with `E_RESOURCE` (exit 3) and `context.requiredMb`, never an OOM crash. `source` is never truncated: REA pages or caps its own projection.
- **Stability.** Within `contract: 1`, fields are only added, never renamed or removed. A breaking change bumps `contract` and the schema tag.

## Acceptance tests (`tests/cli/machine-contract.test.ts`)

1. `--version --json` parses, and `contract === 1` and `hbc2js === VERSION`.
2. `--info --json` on a construct fixture has `schema`, `input.sha256`, which matches `sha256(file)`, and `warnings: []`. An ambiguous-v98 fixture carries `W_LAYOUT_ASSUMED`.
3. `modules --json` on the RN template bundle matches `modules.json` ids/deps from `--split` (paging: `offset+limit` covers `total` exactly once). On a non-Metro construct fixture it returns `metro:false`.
4. `decompile --fn N --json` has `source` byte-equal to text-mode `decompile --fn N`. `--module M` equals `--fn <factoryFn of M>`.
5. Error envelope plus exit code for: missing file (2), truncated file (3), a bad `--fn` (2/`E_BAD_FUNCTION_ID`), and an unsupported version (4).
6. No side effects: run all four under an empty temporary `HOME`/`TMPDIR` with a spawn spy. No files are created, and `child_process` is not called.
