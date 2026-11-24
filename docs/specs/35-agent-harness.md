# 35 — Agent harness: evidence labels, one contract table, supervised children, one-command setup

**Status: SPEC (process v2).** One subsystem, four parts. Everything inside it
is test-first. The landing plan is a private working note.

## Problem

Agents reach hbc2js through four surfaces: the CLI's `--json` commands, the
spec-17 MCP server (about 20 tools, including the seven spec-28 readability
tools), the `help` topics, and the spec-34 machine contract. These surfaces
have four gaps.

1. **No evidence labels.** A reply does not say which fields were read off the
   bytecode, which were computed deterministically, and which are guesses. For
   example, `screens` and `actions` say "heuristic" in prose only. LLM names
   look the same as names read from the string table. The tooling lane's
   `null` plus `*Source` convention is the only explicit way to say "unknown".
2. **Contracts are written in three places.** Tool names, descriptions and
   schemas are hand-written in `src/mcp/server.ts`. Prose about the same tools
   is in `docs/agent-help/tools.md`, which `tests/mcp/help.test.ts` cross-checks
   by name only. The CLI usage text in `src/cli.ts` is a third copy. The nine
   write tools advertise a bare `{type: "object"}` schema. Nothing records
   which tools spawn processes, write files or use the network.
3. **Each child process is supervised differently.** Children are spawned in
   about 25 places with `execFileSync`, `spawnSync`, `execFile` and `spawn`.
   Each site has its own timeout, `maxBuffer` and kill signal, or none.
   `SIGKILL` reaches the direct child but not its process group, so a
   grandchild of `claude -p` or of the Hermes VM can outlive hbc2js. No call is
   cancelled when an MCP client cancels its request.
4. **Setup is manual.** To use the MCP server, a user has to edit their
   client's config by hand and copy `.claude/skills/hbc2js/SKILL.md` into
   place.

## Choice

Adopt the four ideas that REA (MIT, studied as a reference and never copied)
gets right, at hbc2js's scale. Write each one once, in hbc2js's own terms:

- An **evidence block** is added to replies. It uses four labels and comes
  with provenance and limitations.
- **One contract table**, `src/agent/contracts.ts`. The MCP `tools/list`, the
  `help catalog` topic and the drift tests are derived from it.
- **One child-process runner**, `src/proc/run.ts`. It provides a deadline,
  cancellation through `AbortSignal`, output caps, and process-group kill with
  escalation.
- **`hbc2js setup`.** It plans the change, takes a backup, writes atomically,
  and prefers the client's own CLI. It never overwrites silently.

Naming: `src/harness/` already holds the equivalence harness, so this
subsystem lives in `src/agent/` and `src/proc/`.

**Rejected: port REA's framework.** That means zod schemas, compact and
advertised dialect projections, catalog digests, evidence IDs with a retained
ledger, PID-identity ownership proofs, and a 20-client setup transaction
engine. These features suit a 200-tool, multi-provider product. For about 20
tools they would add a dependency (the MCP server is deliberately SDK-free and
zod-free), several thousand lines, and a second lifecycle model next to spec
17's project store.

**Also rejected: a v2 reply format.** Every change here is additive to existing
shapes, so no caller has to migrate.

## Part 1 — Evidence labels

**Adopt.** Object-shaped JSON replies may carry `evidence`:

```
evidence: {
  labels: { "<top-level field or JSON pointer>": "observed" | "derived" | "inferred" },
  unknowns: [{ field, reason }],
  limitations: [string],
  provenance: { producer: "hbc2js", version, input?: { sha256 }, passes?, backend? }
}
```

The labels have fixed meanings in hbc2js:

- **observed**: decoded directly from the file. Examples: header, string
  table, function count, the operands of an `__d` registration.
- **derived**: a deterministic, checkable computation over observed facts.
  Examples: CFG, decompiled source with `verified.*`, module deps from the
  bytecode scan, the oracle-ladder verdict.
- **inferred**: a heuristic or model guess. Examples: names from the deps DB
  or an LLM, library classification, `screens`, `actions`, `trace-prop`
  orderings, and every spec-28 backend output. When a model produced the
  value, `provenance.backend` names the backend ID.

An `unknown` is a field the producer could not determine. Its value stays
`null`, as it does today. The `unknowns[]` entry gives the reason, which
generalises the `*Source` sibling. Missing coverage is reported as unknown,
never as absent.

Labels are attached where the reply is built, from one helper
(`src/agent/evidence.ts`). They are not reconstructed in an adapter.

**Spec-34 compatibility.** The four machine calls emit `evidence` only when
the caller passes `--evidence`. The field is additive, but REA's parsers
include strict object schemas, so an unrequested field could still break a
caller. On a build that predates this spec, an unknown flag already exits 2
(`E_USAGE`), and that failure is the capability probe. Exit codes, existing
fields and the no-spawn/no-write rule are unchanged.

**Migration.** The rollout differs by surface:

- **MCP tool results:** `evidence` is added inside the existing JSON text.
- **Other `--json` commands:** `evidence` is added by default. These
  commands already promise only additive change. A command whose JSON top
  level is not an object is listed in the contract table as
  `evidence: "none"` and is left alone.

**Not adopted:**
- evidence IDs and content digests per record
- a retained-evidence ledger, and import/export of evidence bundles
- an unknown-revision history
- an authority enum wider than the three labels plus `backend`
- per-relationship coverage objects (spec 17 annotations already carry
  provenance for writes)

**Acceptance (`tests/agent/evidence.test.ts`, `tests/cli/machine-evidence.test.ts`):**
1. The four machine calls without `--evidence` produce output byte-identical
   to before. Pin a golden from the current output.
2. With `--evidence`, the `info` labels mark `functionCount` and `version` as
   observed, and the `function` labels mark `source` as derived.
   `provenance.input.sha256` equals the reply's `input.sha256`.
3. `decompile --fn N --json --evidence` with passes on, run on a fixture that
   the name pass renames, labels `name` as inferred.
4. Each spec-28 readability tool result labels its model-produced fields as
   inferred and sets `provenance.backend`. A tool given the heuristic backend
   says `heuristic`.
5. `screens --json` and `actions --json` label their rows as inferred. A
   field that was `null` before has an `unknowns[]` entry.
6. Shape check: every object-shaped `--json` reply that the contract table
   marks `evidence: "default"` has a valid `evidence` block (all four label
   values legal, every label key present in the reply).

## Part 2 — One source of truth for tool contracts

**Adopt.** `src/agent/contracts.ts` exports one frozen table. Each row has:

- `name`
- `surface`: which of `mcp`, `cli`, `machine` the tool is on
- `description`
- `inputSchema`, as a JSON Schema literal in the subset that
  `validateReadabilityArgs` already checks
- `cli`: the argv form, for a CLI row
- `effects`: `{reads, writes, spawns, network}`, with each value either
  `none` or a short noun
- `evidence`: `"default" | "flag" | "none"`
- `examples`

Three things are derived from the table:

1. `buildToolTable` binds handlers to rows by name. `tools/list` is built
   from the rows and nowhere else.
2. `npm run catalog` generates `docs/agent-help/catalog.md`, which `hbc2js help
   catalog` serves. The hand-written prose in `tools.md` stays, but its tool
   list is checked against the table.
3. The drift tests below.

**Migration.** The rows first copy today's schemas verbatim, so `tools/list`
output is byte-identical (the snapshot in test 1). After that, the bare
`OBJECT_SCHEMA` of the write tools is replaced with real schemas. Only
properties that the handler already requires become `required`, so no call
that succeeds today starts failing. Extra properties stay allowed. `--json`
commands are added to the table one at a time. A command that is not in the
table yet is simply uncatalogued; nothing about it breaks.

**Not adopted:**
- zod and canonical-to-advertised schema projection
- compact schema budgets
- recorded catalog digests and per-environment catalogs
- generated CLI parsers. `src/cli.ts` keeps its hand parser; the table
  verifies the parser and does not replace it.
- output schemas for every tool. A row has one only where a machine caller
  exists: the spec-34 four and the readability tools.

**Acceptance (`tests/agent/contracts.test.ts`):**
1. `tools/list` is deep-equal to a pinned snapshot taken before the
   migration. After the schema tightening, the snapshot is updated in the same
   commit, and the change is limited to the write-tool schemas.
2. The table and the handlers are a bijection. Every `mcp` row has a handler,
   and every handler has a row.
3. Every `cli` row's argv form parses: `--help` exits 0, and its flags appear
   in the usage text.
4. `docs/agent-help/catalog.md` equals a fresh generation. This is a drift
   gate, the same pattern as the test-count baseline.
5. Effects are true. Each row that declares `spawns: none` runs, on a
   fixture, under `tests/cli/spy-child-process.mjs` without spawning. Each row
   that declares `writes: none` creates no files in an empty temporary `HOME`
   and `TMPDIR`.
6. For each row that has an `outputSchema`, a fixture reply validates against
   it.

## Part 3 — Shared process supervision

**Adopt.** `src/proc/run.ts` provides one async runner:

```
runChild({cmd, args, cwd?, env?, input?, deadlineMs, signal?, maxStdoutBytes, maxStderrBytes, killGraceMs = 2000})
  -> {status: "ok" | "exit" | "timeout" | "cancelled" | "output-limit" | "spawn-failed",
      code, signal, stdout, stderr, truncated: {stdout, stderr}, durationMs}
```

It works as follows:

- The child starts in its own process group (`detached: true`), and the
  runner keeps a reference to it.
- On a deadline, an abort or an output cap, the runner sends `SIGTERM` to the
  group. After `killGraceMs` it sends `SIGKILL` to the group. This handles
  children that ignore `SIGTERM` and their grandchildren.
- A module-level registry of live groups is killed when hbc2js exits or
  receives `SIGINT`/`SIGTERM`.
- Expected failures are returned as values, not thrown.
- `withTempDir(fn)` is a lease that removes its directory whether `fn`
  succeeds or fails. If removal fails, the path is logged.

There is also a thin `runChildSync` (`spawnSync` with `timeout`,
`killSignal: SIGKILL` and `maxBuffer`) for synchronous call sites that are not
worth converting. It cannot reach grandchildren, and its doc comment says so.

POSIX `process.kill(-pgid)` behaves the same on macOS and Linux. Windows is
out of scope.

**Migration.** Sites move to the runner in order of risk:

1. The Hermes VM (`src/harness/hermes-vm.ts`) and the trace runner
   (`src/harness/runner.ts`).
2. `claude -p` (`src/workers/backends/claude-cli.ts`,
   `src/readability/agent-driver.ts`). In the same step, the MCP server maps
   `notifications/cancelled` to an `AbortSignal` for
   `request_fidelity_check`, `recompile_edit` and readability jobs. This is
   additive: a client that never cancels sees no change.
3. hermesc (`src/harness/roundtrip.ts`, `src/harness/boot-equiv.ts`,
   `src/tooling/seams.ts`).
4. `node --check` in text mode (`src/decompile.ts`, `src/fuzzgen/mutate.ts`).

The following sites stay as they are: `adb`/`xcrun` in `src/device/`
(attended, never in a gate), `npm install` in `src/deps/confirm.ts`
(network-gated, has its own lane), and `git` and `unzip`/`aapt` (short and
bounded). The spec-34 four still spawn nothing.

**Not adopted:**
- PID and executable-identity ownership proofs
- process-tree inspection through `ps`
- per-engine leases and debugger-session registries
- cleanup-failure retention as a first-class state. A failed cleanup is
  logged, not retried.

**Acceptance (`tests/gate/proc/*.test.ts`, run on macOS and Linux):**
1. **Deadline with a stubborn child.** The fixture child ignores `SIGTERM`
   and starts a grandchild. When the deadline passes, the runner returns
   `timeout`. Within `killGraceMs + 1s`, `process.kill(pid, 0)` throws `ESRCH`
   for both the child and the grandchild.
2. **Cancellation.** Aborting the signal returns `cancelled` and kills the
   group the same way.
3. **Output cap.** A child writes 10 MB against a 1 MB cap. The runner returns
   `output-limit` with `stdout.length <= cap` and `truncated.stdout`, and the
   child is gone.
4. **Spawn failure.** A missing binary returns `spawn-failed` and does not
   throw.
5. **No orphans on hbc2js exit.** A host script starts `runChild` on a
   long-lived child and is then sent `SIGTERM`. The grandchild is gone.
6. **Temp lease.** `withTempDir` removes its directory after a successful
   `fn` and after a throwing `fn`.
7. **MCP cancellation.** `notifications/cancelled` during a
   `request_fidelity_check` that uses a stub VM kills the stub's group. The
   request gets a cancelled tool result.

## Part 4 — One-command agent setup

**Adopt.** The command is:

```
hbc2js setup [--client claude-code|codex|cursor|vscode|gemini-cli] [--project <dir>] [--hbc <bundle>] [--skill] [--dry-run] [--yes] [--replace] [--uninstall]
```

It always prints a plan first: each file it would touch, and the one entry it
would add or change. It writes nothing without `--yes` or an interactive "y"
on a TTY. With no TTY and no `--yes`, it prints the plan and exits 0.

Rules for writing client config:
1. Use the client's own CLI when it is on `PATH`, for example
   `claude mcp add --scope project`. The client then owns its own file.
2. Otherwise, edit only a plain per-project JSON file, such as `.mcp.json`
   or `.cursor/mcp.json`. Before writing:
   - copy the file to `<file>.hbc2js-backup-<UTC timestamp>`
   - parse it, and refuse with no write if it does not parse
   - touch only the `hbc2js` key
   - write a temporary file in the same directory and rename it over the
     original
3. If an `hbc2js` entry already exists and differs, refuse unless `--replace`
   is given. An identical entry is a no-op.
4. Never edit an app-owned global file such as `~/.claude.json`, or TOML. For
   those, setup prints the exact snippet or command for the user to apply.

The registered command is `node <abs path to the running cli.js> mcp-server
<abs project dir> [--hbc <abs bundle>]`. `mcp-server` needs a project, so
registration is per project. `--skill` copies `.claude/skills/hbc2js/SKILL.md`
into the project's `.claude/skills/hbc2js/`. That file has to be added to the
`files` list in `package.json`. `--uninstall` reverses the change and leaves
the backups in place.

**Clients covered:**
- **Claude Code**: required. Project scope through `claude mcp add`, or
  through `.mcp.json`.
- **Codex CLI**: through `codex mcp add`. Without that CLI, print the TOML
  snippet.
- **Cursor**: `.cursor/mcp.json`.
- **VS Code / Copilot**: `.vscode/mcp.json`, which uses the `servers` key.
- **Gemini CLI**: `.gemini/settings.json`.

Claude Desktop has no project concept, so it gets a printed snippet only.

**Not adopted:**
- the long tail of clients
- user-scope writes to app-owned global stores
- TOML editing with comment preservation
- packaged-app (MSIX) config paths
- multi-file setup transactions with rollback recovery
- installing third-party engines

**Acceptance (`tests/gate/cli/setup.test.ts`, run against a fake client home
and project in a temporary directory, with a fake `claude` and `codex` on
`PATH` that record their argv):**
1. `--dry-run` writes nothing, and the printed plan names the file and the
   entry.
2. With the fake `claude` on `PATH`, setup calls `claude mcp add` with the
   expected argv and writes no file itself.
3. Without `claude`, setup creates `.mcp.json`. If one exists with another
   server in it, setup takes a backup, the other server is preserved byte-
   for-byte as a parsed value, and only the `hbc2js` entry is added.
4. A differing existing `hbc2js` entry makes setup refuse (exit 2, no write,
   no backup). With `--replace`, it takes a backup and replaces the entry.
5. A malformed config makes setup refuse with no write.
6. Running setup twice creates no second backup and makes no change.
7. `--uninstall` removes only the `hbc2js` entry.
8. `--skill` installs a byte-identical `SKILL.md`, and the existing
   `agent-help` skill tests pass on it.
9. The registered command starts: running it with `initialize` on stdin
   returns a valid `serverInfo`.

## Constraints (all parts)

- **Spec 34 is additive only.** Without `--evidence`, the four calls produce
  byte-identical output. Their fields are never renamed or removed, exit codes
  never change, and they never spawn or write.
- **Existing callers keep working.** `tools/list`, existing `--json` shapes and
  `help` topics only gain fields or topics.
- **Platforms:** macOS and Linux. Use POSIX process groups. Paths are joined
  with `node:path`, and the user's home directory comes from `os.homedir()`.
- **Dependencies:** none new. The MCP server stays SDK-free. JSON Schema
  checks use the existing hand-written validator subset.
- **Test count:** every landing adds tests and bumps
  `docs/test-count-baseline.json`.
