// docs/specs/24-compute-node.md §5 item 5 — the load-aware host picker in
// tools/remote/pick.mjs, exercised with fake /load and /jobs responses so this
// is unit-testable without a network. Also a bash -n parse check on run.sh,
// install.sh and start-local.sh (spec §3/§2, docs/REMOTE-CI.md "Load-aware
// picking"), since the client-side logic they carry is not otherwise
// typechecked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { computeLoadScore, pickHost } from "../../../tools/remote/pick.mjs";

const root = repoRoot();

test("pickHost chooses the host with the lowest score", async () => {
  const scores = new Map<string, number>([
    ["http://a", 1.5],
    ["http://b", 0.4],
    ["http://c", 2.0],
  ]);
  const result = await pickHost(["http://a", "http://b", "http://c"], async (h) => ({
    score: scores.get(h) ?? Infinity,
  }));
  assert.equal(result.host, "http://b");
  assert.equal(result.score, 0.4);
  assert.deepEqual(result.skipped, []);
});

test("pickHost: queue pressure matters even when loadavg alone would pick differently", async () => {
  // Host "idle-but-queued" has zero CPU load but a queue at capacity;
  // host "busy-but-clear" has some CPU load but nothing queued. The queue
  // term must be able to swing the decision (docs/REMOTE-CI.md GET /load
  // formula: loadavg[0]/nproc + (queued+running)/maxParallel).
  const idleButQueued = computeLoadScore(0, 8, 4, 0, 4); // 0/8 + 4/4 = 1
  const busyButClear = computeLoadScore(2, 8, 0, 0, 4); // 2/8 + 0/4 = 0.25
  assert.ok(busyButClear < idleButQueued);
  const result = await pickHost(["http://idle-but-queued", "http://busy-but-clear"], async (h) =>
    h === "http://idle-but-queued" ? { score: idleButQueued } : { score: busyButClear },
  );
  assert.equal(result.host, "http://busy-but-clear");
});

test("pickHost falls back to a count-based score for a host with no /load (older server)", async () => {
  const result = await pickHost(["http://old-server", "http://new-server"], async (h) => {
    if (h === "http://old-server") return { score: 3, fallback: true }; // e.g. 3 queued+running
    return { score: 0.1, fallback: false };
  });
  assert.equal(result.host, "http://new-server");
  const old = result.results.find((r) => r.host === "http://old-server");
  assert.equal(old?.fallback, true);
});

test("pickHost skips unreachable/timed-out hosts", async () => {
  const result = await pickHost(["http://timeout", "http://good"], async (h) => {
    if (h === "http://timeout") throw new Error("timed out");
    return { score: 0.2 };
  });
  assert.equal(result.host, "http://good");
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.host, "http://timeout");
});

test("pickHost ties go to list order", async () => {
  const result = await pickHost(["http://first", "http://second"], async () => ({ score: 0.5 }));
  assert.equal(result.host, "http://first");
});

test("pickHost throws with a clear message when every host is unreachable", async () => {
  await assert.rejects(
    () =>
      pickHost(["http://x", "http://y"], async () => {
        throw new Error("unreachable");
      }),
    /no host reachable/,
  );
});

test("pickHost with a single host returns it directly when reachable", async () => {
  const result = await pickHost(["http://only"], async () => ({ score: 0.9 }));
  assert.equal(result.host, "http://only");
  assert.equal(result.score, 0.9);
});

test("computeLoadScore combines cpu pressure and queue pressure", () => {
  assert.equal(computeLoadScore(4, 4, 0, 0, 4), 1); // 4/4 + 0/4
  assert.equal(computeLoadScore(0, 4, 2, 2, 4), 1); // 0/4 + 4/4
  assert.equal(computeLoadScore(2, 8, 1, 1, 4), 0.75); // 2/8 + 2/4
});

test("computeLoadScore guards against zero nproc/maxParallel (never divides by zero)", () => {
  assert.equal(Number.isFinite(computeLoadScore(1, 0, 0, 0, 0)), true);
});

test("run.sh, install.sh, start-local.sh and seed-fixtures.sh parse cleanly under bash (macOS/Linux bash 3.2-compatible)", () => {
  execFileSync("bash", ["-n", join(root, "tools", "remote", "run.sh")]);
  execFileSync("bash", ["-n", join(root, "tools", "remote", "install.sh")]);
  execFileSync("bash", ["-n", join(root, "tools", "remote", "start-local.sh")]);
  execFileSync("bash", ["-n", join(root, "tools", "remote", "seed-fixtures.sh")]);
});

test("run.sh and seed-fixtures.sh do not use bash-4+-only constructs (mapfile, ${var,,})", () => {
  // Strip comment lines (# ...) first so mentioning these constructs by name
  // in a doc comment — as this repo's own comments do, to say they're
  // avoided — doesn't self-trigger the check; only actual code matters.
  for (const script of ["run.sh", "seed-fixtures.sh"]) {
    const code = readFileSync(join(root, "tools", "remote", script), "utf8")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    assert.ok(!/\bmapfile\b/.test(code), `${script} must not use mapfile (bash 4+ only)`);
    assert.ok(!/\$\{[A-Za-z_][A-Za-z0-9_]*,,\}/.test(code), `${script} must not use \${var,,} (bash 4+ only)`);
  }
});

test("run.sh has no built-in remote host name; the host comes from env or local/remote-host", () => {
  const code = readFileSync(join(root, "tools", "remote", "run.sh"), "utf8");
  assert.match(code, /HBC2JS_REMOTE_HOST/, "run.sh must read $HBC2JS_REMOTE_HOST");
  assert.match(code, /local\/remote-host/, "run.sh must fall back to <repo>/local/remote-host");
  const m = code.match(/HOSTS="\$\{HBC2JS_CI_HOSTS:-([^}]+)\}"/);
  assert.ok(m, "run.sh must set a default for HBC2JS_CI_HOSTS");
  assert.doesNotMatch(code, /https?:\/\/(?!127\.0\.0\.1|\$)[A-Za-z][\w.-]*:\d+/, "no hard-coded remote host URL");
  assert.match(code, /DEFAULT_HOSTS="http:\/\/127\.0\.0\.1:8788"/, "the local instance is always a candidate");
});
