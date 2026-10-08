# hbc2js TL;DR

**What it is.** A Hermes bytecode (`.hbc`, what React Native ships)
decompiler that produces runnable JavaScript checked against the real
Hermes VM, then layers an LLM-driven readability pass (naming, function
rewrites, file-tree ops) on top -- every proposal is `suggested` until a
human or an opt-in evaluator promotes it, and every accepted rewrite must
pass an equivalence oracle first.

**Install.**
```sh
npm install
npm run build      # or run TS sources directly with node's --experimental-strip-types
```

**The five commands that matter.**
```sh
# 1. Decompile a bundle to JavaScript
hbc2js decompile path/to/index.android.hbc out.js

# 2. Build a project (.hbcproj: split source + analysis index)
hbc2js init path/to/index.android.hbc --out my-project

# 3. Serve the UI's JSON API over that project
hbc2js ui-server my-project --hbc path/to/index.android.hbc

# 4. Batch-name functions with an LLM, scoped to app code only
hbc2js name llm-fill my-project --backend claude-cli --only src --limit 20

# 5. Drive an agent session over hbc2js's own MCP surface (never promotes)
hbc2js readability agent my-project --module 3 --max-turns 8
```

`--split`'s `index/functions.jsonl` and `index/modules.json` (spec 10 §2.1/
§2.6) each carry a `rendersJsx` boolean -- true for a function/module that
calls a JSX-factory (`jsx`/`jsxs`/`createElement`), computed from the call
index, never from a name grep -- the "which modules are UI components"
selection for a per-module readable render.

**Per-module readable render.** `hbc2js render-module path/to/index.android.hbc
--module N --out my-render` renders one module's factory (nested closures
placed inside it exactly as the whole-bundle render would) through the pass
ladder to `readable/module_N.js`; the batch form `hbc2js render-modules
path/to/index.android.hbc --only components --out my-render` does the same
for every `rendersJsx` module (`--only src` for every app-code module,
`--limit N` to cap it), off ONE parse + analysis for the whole batch --
usable on a bundle whose whole-bundle pass ladder + emit is multi-minute and
multi-GB (spec 10 §2.6).

**Export a buildable React Native project.** `hbc2js export path/to/index.android.hbc
--out my-export` writes a real project tree (`package.json`, `app.json`,
`babel.config.js`, `metro.config.js`, `index.js`, every module vendored
under `src/`) off ONE `splitProject` parse -- `npm install && npx
react-native bundle` is the finish line (spec 29). Every module is rendered
per-module through `renderModuleReadable` (`--tier jsx` selects `jsx` only
for a module the index tags `rendersJsx`, the rest render `passes`) with a
three-rung fallback (readable render -> the flat `--split` text -> an
empty-factory stub) recorded per module in `EXPORT.json`'s `modules[].tier`/
`tierDowngradeReason`, never a dropped module (spec 29 §7.2/§7.3).
Metro resolves `require()` statically, so every dependency edge is
rewritten to a literal `require("<relative path>")` registration next to a
numeric-id `__hbc.r(N)` call that preserves the bundle's own laziness/cycle
behaviour (`src/_hbc/registry.js`, spec 29 §4.4). `--substitute safe`
(default; `--substitute none` is the escape hatch) replaces a package with a
real `require("<package>")` when its module-graph boundary is unambiguous
(spec 29 §5's S1-S4 rule): `own(P)`'s files are deleted from the tree and
the registry redirects the one boundary module id to a literal
`require("<package>")`, so a caller anywhere in the tree resolves it
identically regardless of render tier; a package that enters at more than
one module (most real npm packages, in practice) refuses and stays vendored,
recorded as an `unresolved` manifest row.

**Where to read next.**
- `hbc2js help` (or the `help` MCP tool / `hbc2js://docs/*` resources) --
  the same agent-facing docs from inside a session: `tldr`, `tools`,
  `workflow`, `examples`, `limits`, `glossary`.
- `docs/DECISIONS.md` -- the binding architecture decisions for contributors
  working ON hbc2js's own code.
- `docs/READABILITY.md` -- the LLM naming/rewrite/file-op layer in depth.
- `.claude/skills/hbc2js/SKILL.md` -- the Claude Code skill that triggers
  on hbc2js/Hermes/decompile/readability questions.
