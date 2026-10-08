# Remote job server — running heavy commands on a compute node

A compute node (Linux, x86_64) runs a tiny HTTP job server
(`tools/remote/server.mjs`) so agents and maintainers can run `npm test`,
`npm run test:sweep`, tier-1 corpus sweeps, and bulk jobs with **one tool
call** and a short (`≤40`-line) result, instead of tying up a local shell for
minutes.

LAN-only, no auth: the compute node is on the same LAN as the developer machine
(`<remote-host>`), so the server binds to `0.0.0.0:8787` with no auth. Do not expose this port outside the LAN.

## Install / redeploy

```
tools/remote/install.sh <host>            # deploy to an ssh-reachable Debian/Ubuntu host
```

This copies `server.mjs` to `~/hbc2js-ci-bin/` on the target, writes a
`systemd --user` unit (`hbc2js-ci.service`, `Restart=always`) with
`MAX_PARALLEL` set to `nproc/2` (min 1) computed on the target node itself
(each node gets its own value automatically — see
`docs/specs/24-compute-node.md` §2), enables lingering (so the service
survives logout/reboot) and (re)starts it. Also checks (warn-only, never
fails the install) that `~/hbc2js-dev/tools/{hermesc,hermes-vm}` exist on the
target — without them, oracle-dependent tests just skip on that node
(`docs/TOOLCHAIN.md`). Re-run after editing `server.mjs` to redeploy. Note:
`install.sh` is generalised to any Debian/Ubuntu host reachable over SSH, but
is only ever run by hand against a named node — never invoked by an agent or
by this repo's own tests/CI.

**Other one-time, by-hand environment setup on a compute node** (not done by
`install.sh` — these are host package installs, not repo deploys, and are
each idempotent to re-run):

```
tools/get-hermesc.sh all              # hermesc (+hermes where upstream ships it), all 5 versions
pipx install hermes-dec==0.1.7        # hbc-file-parser, hbc-disassembler (AGPL oracle, never vendored)
pipx install semgrep                  # semgrep
tools/remote/seed-fixtures.sh <host>     # see "Fixture cache" below
cd ui && npx playwright install chromium   # browsers land in ~/.cache/ms-playwright, machine-wide
```

`pipx` puts binaries in
`~/.local/bin`, already on the systemd unit's `PATH` (above) — no
`server.mjs`/`install.sh` change or redeploy needed after running these.

## Use

```
tools/remote/run.sh -- npm test                       # push current branch, run, poll, print tail
tools/remote/run.sh --sha <sha> --timeout 15 -- npm run test:sweep
tools/remote/run.sh --keep -- npm run test:all         # keep the worktree afterwards for inspection
tools/remote/run.sh --status                           # list recent jobs
tools/remote/run.sh --status <id>                      # one job's status + tail
tools/remote/run.sh --log <id>                         # full log
tools/remote/run.sh --host http://<remote-host>:8787 -- npm test   # pin a host, skip the pick
```

`run.sh` with no `--sha` pushes the current local branch to `origin` first
(`git push -q origin HEAD`) so the server can fetch it by name. Pass `--sha
<commit>` to skip the push and run an already-pushed commit (works for any
SHA reachable on GitHub, since the repo is public).

Exit code of `run.sh` is the job's exit code (or 1 if the job errored before
running the command).

### Multi-node host picking (docs/specs/24-compute-node.md §3)

`HBC2JS_CI_HOSTS` is a space-separated list of candidate compute-node URLs
(default `http://<remote-host>:8787 http://127.0.0.1:8788` — the compute node, plus a local
second instance started via `tools/remote/start-local.sh`, see below).
`REMOTE_CI_URL` still works as a one-host override, for a single-node setup.
`--host <url>` pins a host outright and skips picking.

With more than one candidate host, `run.sh` polls each host's `GET /load`
(2 s timeout each, via `tools/remote/pick.mjs`) before every POST, skips any
host that doesn't answer in time, and picks the reachable host with the
**lowest load score** (ties go to list order) — see "Load-aware picking"
below for the formula. The chosen host, every reachable host's score, and
any skipped/unreachable host are printed on stderr. If every candidate is
unreachable, `run.sh` exits non-zero with one clear line. With a single
candidate host, no picking happens; the one host is used directly.

`tools/remote/pick.mjs` exports a pure `pickHost(hosts, fetchLoad)` (an
injectable fetcher takes a host URL and resolves with `{score, fallback?}`)
so the picking logic is unit-tested without a network in
`tests/gate/tools/remote-pick.test.ts`; the file also has a CLI entry that
`run.sh` shells out to with the real `fetch`, and exports the pure
`computeLoadScore(loadavg1, nproc, queued, running, maxParallel)` formula
used both by the CLI's fallback path and by `server.mjs`'s `GET /load`.

`run.sh --status` with no id lists jobs from every candidate host (or just
the pinned host with `--host`), each line prefixed with its host — useful
once there's more than one node, since a single `GET /jobs` only shows one
host's queue.

### Raw HTTP (if you need it directly)

```
curl -s -X POST http://<remote-host>:8787/jobs -H 'content-type: application/json' \
  -d '{"ref":"main","cmd":"npm test","timeoutMin":15}'
curl -s http://<remote-host>:8787/jobs/<id>
curl -s http://<remote-host>:8787/jobs/<id>/log
curl -s http://<remote-host>:8787/jobs
curl -s http://<remote-host>:8787/load
```

## What a job does

1. `git fetch origin +<ref>:refs/heads/<ref>` into a shared bare mirror at
   `~/hbc2js-ci/mirror.git` (created once, reused).
2. `git worktree add --detach ~/hbc2js-ci/jobs/<id> <sha>`.
3. Symlinks `tools/hermesc` and `tools/hermes-vm` from `~/hbc2js-dev/tools/`
   into the job worktree if present there (both are gitignored, so a fresh
   worktree never has them — this reuses the toolchain already fetched on
   the compute node instead of rebuilding per job; see `docs/TOOLCHAIN.md`). If absent,
   any test that needs an oracle skips (`HBC2JS_REQUIRE_ORACLES=1` would
   turn that into a failure — the current job server does not set it).
   Right after this, `linkFixtureCache` (`tools/remote/fixture-cache.mjs`)
   symlinks every file under `~/hbc2js-ci/fixture-cache/` (mirroring the
   repo layout, e.g. `fixture-cache/tests/fixtures/bundles/<name>/...`)
   into the matching path in the job worktree, for any path the worktree
   doesn't already have — see "Fixture cache" below.
4. `npm ci`, cached by `package-lock.json` hash: the resulting
   `node_modules` is moved into `~/hbc2js-ci/nm-cache/<hash>/` once and
   symlinked back for every job sharing that lockfile, so repeat runs skip
   the install. The same is then done for `ui/` (`npm ci --ignore-scripts`,
   its own lock hash): `tests/ui-core/*.test.ts` import `@dagrejs/dagre` and
   `react` from `ui/node_modules`, and without it the full gate fails on
   `tests/ui-core/graph-layout.test.ts` (seen once). **If the running service is not redeployed after this
   step's code was added,** a job gets only
   the root install; `ui/` install silently never ran (the deployed
   server.mjs had no such loop), so the job "succeeded" through setup and
   then failed ~200 lines into `npm run typecheck` on a missing
   `@dagrejs/dagre` instead of at the real problem. The fix is to
   redeploy (`tools/remote/install.sh <host>`). `install.sh` once had a
   second, independent bug — it only `scp`'d
   `server.mjs`, never its sibling `pick.mjs`/`install-check.mjs`, so the
   moment `server.mjs` grew a second local import the service crash-looped
   at startup (`ERR_MODULE_NOT_FOUND`). Both are fixed now: `install.sh`
   ships all of `tools/remote/*.mjs`, and after this loop the job runner calls
   `tools/remote/install-check.mjs`'s `findBrokenInstalls`/`installCheckError`
   — any lockfile whose install ends without a `node_modules` fails the job
   immediately with an actionable message, instead of letting it proceed
   to a confusing downstream error. **Takeaway: redeploy
   (`tools/remote/install.sh <host>`) is not automatic — editing `server.mjs`
   or `install.sh` and not redeploying is exactly the kind of silent gap
   this loud-failure check exists to catch faster next time, but it does
   not catch a stale *deploy* itself, only a stale *install result*.**
5. Runs `cmd` via `bash -lc` with `PATH` pointed at a Node 22 resolved once
   at server startup via `fnm exec --using 22`, under `timeoutMin` (default
   30; SIGKILL on timeout).
6. stdout+stderr go to `~/hbc2js-ci/logs/<id>.log`; job metadata (status,
   exit code, duration, ref, sha, cmd) is written to
   `~/hbc2js-ci/meta/<id>.json` after every state change, so a server
   restart doesn't lose history (an in-flight job found on startup is marked
   `done` with `exitCode: -1` — it is not resumed).
7. The worktree is removed (`git worktree remove --force`) unless the
   request set `"keep": true`.

Jobs run FIFO with `MAX_PARALLEL` (default 4, override via the `MAX_PARALLEL`
env var in the systemd unit) concurrent slots; extra jobs queue.

## Restart / logs / disk

```
ssh "$HBC2JS_REMOTE_HOST" systemctl --user restart hbc2js-ci.service
ssh "$HBC2JS_REMOTE_HOST" systemctl --user status hbc2js-ci.service
ssh "$HBC2JS_REMOTE_HOST" journalctl --user -u hbc2js-ci.service -n 100
```

Server-side state lives under `~/hbc2js-ci/{mirror.git,jobs,logs,meta,nm-cache}`.
Logs and metadata older than `LOG_RETENTION_DAYS` (default 14) are pruned on
server startup. `nm-cache/` is not size-bounded — if disk pressure shows up
clear it by
hand: `rm -rf ~/hbc2js-ci/nm-cache/*` (next job just reinstalls). Any job with
`"keep": true` leaves its worktree in `~/hbc2js-ci/jobs/<id>/` — clean those
up manually (`git worktree remove`) once you're done inspecting them.

## Load-aware picking + running a local node

Every `server.mjs` instance exposes `GET /load`:

```
{ "host": "<host>", "platform": "linux", "nproc": 32,
  "loadavg": [1.2, 0.9, 0.7], "running": 1, "queued": 0,
  "maxParallel": 16, "score": 0.0875 }
```

`score = loadavg[0] / nproc + (queued + running) / maxParallel` — the first
term is instantaneous CPU pressure normalised by core count, the second is
queue pressure normalised by that host's own `MAX_PARALLEL`. The queue term
matters on its own: a host that is CPU-idle but already has a full queue of
`hbc2js` jobs should not "win" over a host that is a bit busy but has
headroom to accept another job right now. Lower score wins; `tools/remote/pick.mjs`
picks the reachable host with the lowest score (ties go to list order — see
`computeLoadScore` and `pickHost` above). A host that answers `GET /jobs`
but 404s on `GET /load` (i.e. it's still running server.mjs from before this
section existed) falls back to a `queued + running` count for itself only,
noted on stderr — mixing that count with other hosts' load scores is a
known rough edge of the fallback, not a bug; redeploy that host
(`tools/remote/install.sh <host>`) to fix it properly.

**Adding more servers.** `HBC2JS_CI_HOSTS` is just a space-separated list —
add a URL and it is scanned like every other candidate. There is no
per-host configuration beyond that list; each server reports its own
`nproc`/`maxParallel`, so heterogeneous hosts (a large Linux box, a
laptop) compare fairly via the normalised score above.

**Running a node on macOS.** `server.mjs` runs on macOS as well as Linux
(`os.loadavg()`, `os.cpus()` are both cross-platform; Node 22 resolution
falls back to `process.execPath` when `fnm` isn't installed, which is the
normal case on a plain Mac). Three env vars make a second instance
possible without colliding with a Linux-node-style deployment:

- `HBC2JS_TOOLCHAIN_DIR` (default `~/hbc2js-dev/tools`) — where to look for
  `hermesc`/`hermes-vm` to symlink into each job; on macOS this should
  point at this repo's own `tools/` (already populated for local dev).
- `HBC2JS_CI_DIR` (default `~/hbc2js-ci`) — where job state (mirror,
  worktrees, logs, meta, node_modules cache) lives; keep it separate from
  any Linux node's state dir if they ever share a filesystem (they don't
  here).
- `PORT` (default `8787`) — `8787` is the compute node's port, so a local
  instance uses `8788` to run alongside it as a second candidate host.

`tools/remote/start-local.sh` wires these up for macOS (or any other non-remote,
non-systemd machine) and starts `server.mjs` under `nohup`:

```
tools/remote/start-local.sh
# PORT=8788, HBC2JS_CI_DIR=~/hbc2js-ci-local, HBC2JS_TOOLCHAIN_DIR=<repo>/tools,
# MAX_PARALLEL=nproc/2 (min 1), logs to $HBC2JS_CI_DIR/server.log.
```

It is idempotent: if something is already answering on the target port, it
prints that and exits 0 rather than starting a second copy. This is a
`nohup`-backgrounded process, not a systemd unit — macOS has no systemd —
so it does not survive a reboot; re-run `start-local.sh` after one. This
script only ever starts a server on the machine it runs on; it never
touches the compute node and is not what `tools/remote/install.sh` does (that remains the
SSH-based systemd deploy path for Debian/Ubuntu hosts, unchanged by this
section).

With the local instance running and the compute node reachable, no flag is needed:
`HBC2JS_CI_HOSTS`'s default already lists both, so `tools/remote/run.sh -- npm
test` picks whichever is less loaded.

## Fixture cache

A fresh job worktree is a plain `git worktree add` from the shared mirror,
so it has every *tracked* file (including, it turns out,
`tests/fixtures/bundles/rn-template-0.72/**` in full, `.hbc`/`.bundle`
files and all — that fixture is committed to git, not gitignored, so it
needs no seeding and was never actually part of the gap) but none of the
*gitignored* fixture artifacts a fixture's own `fetch.sh` produces (e.g.
`tests/fixtures/bundles/react-navigation-example-0.85.3/index.android.bundle`,
`*.hbc`, `*.map`, `deps-truth.json` — 5 files, ~23 MB; downloaded bundles are never committed).

`tools/remote/seed-fixtures.sh [host]` (`<host>` is the ssh target) closes that gap
the same way `tools/get-hermesc.sh` closes the toolchain gap: run **by
hand**, **once**, from a checkout that already ran the fixture's `fetch.sh`,
it `rsync`s whatever `git status --ignored=matching` currently reports as
ignored under `tests/fixtures/bundles/` into `~/hbc2js-ci/fixture-cache/`
on the target host, mirroring the repo's own path layout. It is
non-hardcoded on purpose — re-running it after a fixture is re-fetched, or
after a new fixture grows its own `fetch.sh`, picks up the change with no
edit to this script.

`tools/remote/server.mjs`'s `linkFixtureCache` (backed by the pure
`planFixtureLinks` in `tools/remote/fixture-cache.mjs`, unit-tested in
`tests/gate/tools/remote-fixture-cache.test.ts`) then runs on every job, right
after the `tools/hermesc`/`tools/hermes-vm` symlink step: it walks the
cache and symlinks in any path the job worktree doesn't already have. A
node with no cache seeded gets an empty list and is a no-op — this is not
a hard dependency, just a gap-closer.

`react-navigation-example-0.85.3`'s 5
gitignored files (~23 MB) are the usual seed. This is a manual-but-reproducible step, same status as fetching
the toolchain itself (`docs/TOOLCHAIN.md`) — it is not re-run
automatically by `install.sh` or by any job, so re-seed by hand
(`tools/remote/seed-fixtures.sh <host>`) if the fixture is ever re-fetched with
different content.

## Limits / known gaps

- No auth — LAN-only by design (see above).
- `ref` must be a branch name (or a SHA GitHub already has, since the repo
  is public) fetchable from `origin`; the server never pushes anywhere.
- `--sha` support depends on GitHub allowing fetch-by-SHA for public repos;
  it does not work against a private fork.
- Hermes VMs on the compute node may cover fewer versions than hermesc (see
  `docs/TOOLCHAIN.md`); jobs needing a missing oracle skip those cases, they
  don't fail, unless the job's `cmd` itself sets
  `HBC2JS_REQUIRE_ORACLES=1`. A developer machine may have more
  VM builds than the node (for example v94 and v99), so a skip on the node
  is not necessarily a skip locally. Building Hermes from source is out of scope for
  `tools/remote` (CLAUDE.md: never build Hermes from source in core code;
  `tools/build-hermes-vm.sh` is explicitly local-only) — closing this
  needs someone to run that script on the node by hand, not a `tools/remote`
  change.
- No `--profile` flag yet (queued as follow-up; today, wrap the job's `cmd`
  in whatever profiler you need, e.g. `node --prof ...`, and fetch results
  via `--keep` + inspecting the worktree over ssh).
- A remote-node job worktree is a plain `git worktree add` from the shared
  mirror — without the fixture cache it has no *gitignored* local fixture
  that only exists because a developer fetched it by hand on their own
  machine (e.g. `tests/fixtures/bundles/*/*.map`). The "Fixture cache"
  section above closes this for `react-navigation-example-0.85.3`; a
  *new* such fixture (or `expensify-*`, mentioned in the `.gitignore` but
  never actually fetched/used by any test as of this writing) still needs
  its own `tools/remote/seed-fixtures.sh` run once it's fetched somewhere.
- Recommended one-line full gate:
  `tools/remote/run.sh --host http://<remote-host>:8787 --timeout 30 -- 'npm run typecheck && npm test'`
  (pin `--host` to skip multi-node picking if only one node is up; drop it to
  let `run.sh` pick the least-loaded candidate from `HBC2JS_CI_HOSTS`).
