---
name: hbc2js
description: Decompile, browse, and rename/rewrite React Native Hermes bytecode (.hbc); use for any hbc2js, Hermes bytecode, decompile, or readability-pass question or task.
---

# hbc2js -- operator's TL;DR

hbc2js decompiles Hermes bytecode (`.hbc`, what React Native ships) into
runnable JavaScript checked against the real Hermes VM, then layers an
LLM-driven readability pass (naming, function rewrites, file-tree ops) on
top. Full docs ship with the package: `hbc2js help <topic>` (tldr, tools,
workflow, examples, limits, glossary).

## The five commands that matter

```sh
# 1. Decompile a bundle straight to JavaScript
hbc2js decompile path/to/index.android.hbc out.js

# 2. Build a project: split source tree + analysis index in one .hbcproj
hbc2js init path/to/index.android.hbc --out my-project

# 3. Serve the project over the Stage-3 UI's JSON API
hbc2js ui-server my-project --hbc path/to/index.android.hbc

# 4. Batch-name functions with an LLM, scoped to app code, bounded
hbc2js name llm-fill my-project --backend claude-cli --only src --limit 20

# 5. Drive an agent session over hbc2js's own MCP tools (never promotes)
hbc2js readability agent my-project --module 3 --max-turns 8

# Per-module readable render: every UI-component module, off ONE bundle parse
hbc2js render-modules path/to/index.android.hbc --only components --out my-render

# Export a buildable React Native project tree (spec 29; --substitute safe is default)
hbc2js export path/to/index.android.hbc --out my-export
```

Run `hbc2js <verb> --help` for any of these; `hbc2js help` prints the deeper
agent docs (`tldr`, `tools`, `workflow`, `examples`, `limits`, `glossary`) --
call that first if you are about to drive hbc2js's tools rather than read
this file.

## Using hbc2js as an MCP server from another session

```sh
hbc2js mcp-server my-project --hbc path/to/index.android.hbc --llm-backend claude-cli
```

`claude -p --mcp-config` snippet (what `hbc2js readability agent` builds for
you automatically -- write this yourself only when driving a session by
hand):

```json
{
  "mcpServers": {
    "hbc2js": {
      "command": "node",
      "args": ["/path/to/hbc2js/src/cli.ts", "mcp-server", "my-project",
                "--hbc", "path/to/index.android.hbc"]
    }
  }
}
```

```sh
claude -p --mcp-config mcp-config.json --strict-mcp-config \
  --allowedTools "mcp__hbc2js__*" "read function 188 and suggest a name"
```

The server always exposes a `help` tool (call it first from inside a
session) and `hbc2js://docs/*` resources with the same text. It always
serves the spec-17 read/annotate tools; the seven spec-28 readability tools
(`suggest_names`, `rewrite_function`, `classify_module`, `file_op`,
`promote_change`, `revert_change`, `list_suggestions`) appear only when the
project directory has a readable `src/` tree.

## Where outputs go

- `hbc2js decompile` writes the `.js` file you named on the command line.
- `hbc2js render-module`/`render-modules` write `readable/module_<id>.js`
  under `--out <dir>` (a split-tree directory) plus a `readable` field per
  module in that directory's `MODULES.json` -- one bundle parse for the
  whole batch, never per module.
- `hbc2js export` writes a full project tree under `--out <dir>`
  (`package.json`, `index.js`, `src/**`, `EXPORT.json`) -- `npm install &&
  npx react-native bundle` is the finish line.
  `--substitute safe` (default) replaces an unambiguously-entered package
  with a real `require("<package>")`; a package entered at more than one
  module refuses and stays vendored under `src/_vendor/<pkg>/` (spec 29
  §5; `EXPORT.json`'s `substitutions`/`unresolved` record which).
- `hbc2js init` writes `<out>/project.hbcproj` (one SQLite file: split
  source + analysis index + annotations) plus a `src/`-shaped tree under
  `<out>/` a human or another tool can read directly.
- `name llm-fill` and the readability tools write `suggested`-tier records
  into that same project (an overlay sidecar for names, a transaction log
  for rewrites/file ops) -- never into the original `.hbc`.
- `readability agent` never promotes anything it writes; review with
  `hbc2js readability review <project>` or the UI's suggestion pane.

## The safety model (five lines)

Every LLM-proposed name, rewrite, or file op is `suggested`, not final, until
a human (the UI) or an opt-in evaluator promotes it. Every accepted rewrite
or file op must PASS an equivalence oracle first (DIVERGENT and INCONCLUSIVE
both reject; the faithful original decompile always survives). An agent can
never promote its own suggestion -- `promote_change`/`promote` refuse any
`who` identifying a worker. Abstaining (writing nothing) is a correct,
expected outcome when the evidence is thin, not a failure to route around.

## Common failure messages

- `UNIQUE constraint failed: ix_ranges.fn` from `hbc2js init` -- a known open
  bug on some Metro-shaped bundles; use a bundle
  `init` already succeeds on (the committed `rn-template-0.72` fixture) if
  you hit this mid-task.
- `"no range recorded"` from `get_context`/`get_source`/`decompile --fn` --
  the project was built from a single-script fixture with no `__d()`
  modules, so no source ranges exist for any function; point `--hbc`/the
  project at a real Metro bundle instead.
- `help: unknown topic "..."` -- see the error text itself for the valid
  topic list (`tldr`, `tools`, `workflow`, `examples`, `limits`, `glossary`).
- A `suggest_names`/`rewrite_function` call that returns empty is not an
  error: both backends (and a real model with thin evidence) abstain by
  design.
- `claude -p` refuses stdin over 10 MB -- keep `--fn`/`--module` scope small;
  never hand it a whole large bundle's render as a prompt.

## Installed from npm: Hermes VM and long runs

- `equiv --boot` needs a Hermes VM. `hbc2js setup-vm 96` fetches a prebuilt
  one (explicit, pinned `npm pack`, into `~/.cache/hbc2js/hermesc`); or pass
  `--vm <path>`, set `HERMES_VM_V<version>`, or build with
  `tools/build-hermes-vm.sh`. Without one the verdict is INCONCLUSIVE (exit 2).
- `export` and `deps` take minutes on a real app; they print phase progress
  on stderr (suppressed by `--json`). `hbc2js help skill` reprints this file.

## Read next

`hbc2js help workflow` and `hbc2js help limits`; the source repo
(github.com/fredgaffey/hbc2js) holds the specs for implementers.
