# Naming overlay (Design D) — usage

A non-destructive layer of names over a decompiled bundle, for the LLM
vulnerability-analysis loop: assign meaningful names to `rN` registers many
times, cheaply, safely, reversibly, searchably. A name is an annotation on a
binary-derived binding, not a text edit; the emitted JS is a *rendered view* of
binary-plus-overlay.

## What a name is keyed to

Every nameable binding has a stable id derived from the compiled binary, so it
survives re-decompilation and is independent of emitted text. v1 owns register
locals: `{ fn: <bytecode function index>, reg: <register number> }`. Env slots
(`{fn,env}`) and function names (`{fn}`) are reserved in the id shape but
deferred to `closure-naming` / `fn-naming` (spec §8) and are refused for now.

**Live ranges (`{fn, reg, web}`, key `reg:F:R:W`).** hermesc reuses one
register for unrelated values, and `reg-split` already renders each disjoint
live range as its own binding (`r4`, `r4_2`, ...), but a `{fn,reg}` name has
to fit every range at once (the readability loop's "r4 is the require
function, then StyleSheet" abstentions). A register `reg-split` split is
therefore named per web: `web` is reg-split's own range number, so web 1 is the
range rendered `rN` and web W >= 2 the range rendered `rN_W`
(`registerIdent`). Web numbers follow reg-split's first-occurrence order over
the post-structure-recovery tree, so they are stable across re-decompilation
by the same decompiler but may renumber when an upstream pass changes shape;
a web name whose ident is no longer live is skipped, never misapplied. Web
names apply AFTER reg-split and BEFORE var-naming (the `beforeVarNaming`
interposition of `astPassHook`), as the same guarded alpha-rename; the gate
for a web checks name validity and that the web is live in the post-split
body (one def-web by construction, so the register-wide reuse gate does not
apply), and `{fn,reg,1}` is accepted only when the register really was split.
**Old overlays stay valid unchanged:** a whole-register `reg:F:R` record is
still applied to the raw frame before stage B, exactly as before; it renames
every range (and, as before, protects the register from inlining), and any web
names for that register then find no ident and are skipped. Unsplit registers
keep the whole-register id; readability targets, the nameable denominator
(`NameableIndex.bindings`, `<app>.nameable.json` entries `R` or `"R:W"`) and
the `hbc-name` skill (v5) all speak the same identity.

## The store

A versioned JSON sidecar, one per bundle — by default `<input.hbc>.names.json`,
or `--store <path>`. Append-only: a new name for a binding *supersedes* the old
one (the timeline is kept); `revert` re-activates a prior record, or clears back
to `rN` when there is none. It is never the emitted `.js`.

Each record: `{ id, name, confidence, evidence, source, gate, ts, supersedes }`
(plus a store-local `rid` and an `active` flag). Evidence and confidence are
mandatory; a name without evidence is discipline debt.

## The reuse gate

An externally supplied name passes through var-naming's existing reuse gate. It
is **refused** when the register's uses span more than one role
(`reuse-conflict`) or it aliases `globalThis` (`globalthis-alias`) — a wrong
name is worse than a plain `rN`. `--override` forces past those, but the record
is stamped `gate:"overridden"` and forced to `confidence:"low"`, so every
override is visible and searchable. A reserved word, an emitter-shaped name
(`r5`, `_fn0`, …), or a register that is not a live binding in its frame (e.g. a
property/string key — never a binding) is refused **unconditionally**: an
override can never emit invalid JS or name a non-binding.

## Rendering

`render` applies the active names at emit time, as a pure frame-local
alpha-rename (the same `renameRegistersInFrame` var-naming uses), keyed on the
raw `rN` *before* var-naming runs — so the external name fills the very slot the
heuristic would have, and un-named registers still get their heuristic name.
Behaviour cannot change by construction (no text rewrite); the trace-oracle is
the backstop (0-DIVERGENT). Two names colliding in one frame are disambiguated
with a deterministic suffix (`dup`, `dup_2`) and the collision is flagged back
into the store.

**Render cost follows the functions touched.** `render({fn})` passes
`emitModule` its `onlyFunction`, so only `fn`'s subtree (the function and the
closures emitted inside it) is emitted and run through the passes; the stage-A
and stage-B hooks (each builds a whole-module view) are built once by
`NameService` and reused. `RenderOptions.wholeModule: true` keeps the old
re-emit-and-slice path as the byte-for-byte oracle
(`tests/gate/name-overlay/render-cost.test.ts`), and `onEmit` is the
instrumented counter. The reuse gate reads one function's raw frame
(`rawFramesFor`) instead of the whole module's. `runNamePass`'s apply-then-revert
backstop renders only the functions its targets name (`backstopScope`
`"touched"`, default; `"module"` is the old whole-module pair).

## CLI

```
hbc2js name set  <fn> <reg> <newName> --hbc <in.hbc> [--conf low|med|high] \
                 [--evidence <s>] [--source llm|heuristic|human] [--override] [--json]
hbc2js name get    <fn> <reg> [--store <path>|--hbc <in.hbc>] [--json]
hbc2js name revert <fn> <reg> [--to <ts>] [--store <path>]
hbc2js name search [--conf low] [--source llm] [--gate overridden] [--fn 42] [--text foo] [--json]
hbc2js render --hbc <in.hbc> [--fn N] [--store <path>] [--out <file>]
```

`name set` needs `--hbc` (to run the gate); `get`/`revert`/`search` are
store-only and take `--store` (or `--hbc`, from which the default store path is
derived). Output is token-minimal (spec §10):

```
$ hbc2js name set 0 9 loopLimit --hbc app.hbc --conf med --evidence "loop bound 10" --source llm
named {0,9} → loopLimit [med, gate:passed]

$ hbc2js name set 0 6 g --hbc app.hbc
refused {0,6} g [globalthis-alias] (use --override to force)      # exit 3

$ hbc2js name set 0 6 g --hbc app.hbc --override
named {0,6} → g [low, gate:overridden]
```

`--json` on `set`/`get`/`search` emits the full record(s) instead.

## `name llm-fill` — batch naming through an LLM (spec 28 landing 1)

```
hbc2js name llm-fill <in.hbc> [--backend claude-cli|haiku|replay|heuristic|fake] \
                      [--budget-tokens N] [--recording <file>] \
                      [--store <path>] [--json]
```

Enumerates every nameable, not-yet-named register (`listNameable`, the same
query `name list` uses) and runs spec 28's per-target loop
(`src/readability/name-pass.ts`: cache -> skill -> generate -> validate ->
write -> equiv backstop) over each one:

- `--backend claude-cli` (**default**, spec 28 section 9.1: the CLI, not the metered API) spawns
  `claude -p` (`src/workers/backends/claude-cli.ts`); it needs the `claude`
  binary on `PATH` (or `HBC2JS_CLAUDE_BIN`), nothing else. `--backend haiku`
  opts into the real Anthropic API (`src/workers/backends/haiku.ts`, needs
  `ANTHROPIC_API_KEY`) -- kept because it is easy to integrate, but never the
  default (API calls are metered; the CLI runs on an existing subscription). `--backend replay` answers from a committed recording
  (`--recording <file>`, see `tools/readability/record.ts`); `--backend
  heuristic` is the offline spec-23 backend, which does not speak the JSON
  contract yet, so it abstains on every target rather than crash.
  `HBC2JS_LLM_BACKEND` overrides the default; `--backend` overrides the env.
  One place resolves an id to a backend: `src/readability/backends.ts`.
- A written name lands in the overlay as `source:"llm"`, `gate:"passed"` (or
  `"overridden"`) exactly like `name set` would — **never** `tier:"confirmed"`;
  promotion is a separate, human (or stronger-model) action (spec 28 D28-1).
  This landing writes directly through `NameService.setName`, the same call
  `name set` makes; the DB transaction log's own `suggested`/`confirmed` tier
  is spec 28 landing 3's file-op surface, not this one.
- Every run ends with the section 9.4 NAME-row backstop: revert every name the
  run wrote, render, and compare against the pre-run render. `PASS` re-applies
  the writes; anything else discards the WHOLE batch (spec 28 section 0a: "no
  silently-wrong subset").
- Budget (`--budget-tokens`, tokens, not USD) is checked between targets, so a
  cut-off run always finishes writing whichever target it started.

```
$ hbc2js name llm-fill app.hbc --backend heuristic --json
{"targets":16,"named":0,"tokensUsed":0,"stoppedAtBudget":false,"equiv":"PASS"}
```

## Programmatic (resident) API — the loop's primary form

```ts
import { NameService, OverlayStore, regId } from "./src/name-overlay/index.ts";

const svc = new NameService(analysis, OverlayStore.load(storePath, bundle));
svc.setName(regId(42, 7), "userInput", { confidence: "med", evidence: "…", source: "llm" });
svc.getName(regId(42, 7));       // NameRecord | null
svc.history(regId(42, 7));       // full supersession chain, newest first
svc.revert(regId(42, 7));        // rollback; returns now-active record or null (rN)
svc.search({ gate: "overridden", fn: 42 });
svc.render({ fn: 42 });          // { code, collisions }
```

The bytecode is parsed once; the raw frame bodies and overlay stay warm, so
successive `setName` calls run the gate with no re-parse and no `.js` round-trip
(spec §5). No network is used anywhere; an LLM is just a `source` label.

## v1 non-goals

Env slots and function names (deferred, spec §8); property / string-key /
dynamic-access renaming (never — they are contract, not bindings); writing names
into the `.hbc`; new heuristic name *invention* (that is var-naming's job — this
is the addressable, tracked, external-fed layer over it).
