// ui/src/workers/session-heartbeat.test.ts — usability pass 2026-09-29, bug
// 6: `/api/sessions/.../heartbeat` 404ed repeatedly in the background with
// nothing surfaced. Root cause (src/workers/presence.ts): a session's TTL
// sweep (`Presence.expire()`) CLOSES a session once its `last_seen` ages
// past 30s (a backgrounded tab can miss beats to browser timer throttling),
// and a closed session is never resurrected by design
// (`Presence.heartbeat`'s own comment). `initUiSession` kept beating the
// SAME now-dead id forever, silently swallowing every failure — meaning
// every job queued after that point had no `createdBy` and nothing ever
// said so. Fixed in ./wire.ts: a 404 on heartbeat re-opens a session and
// reports it once via `setStatus`, rather than repeating the same 404
// forever with nothing visible.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setStatusMock = vi.fn();
vi.mock("../actions/store.ts", () => ({ setStatus: setStatusMock }));

describe("UI session heartbeat recovers from a 404 instead of repeating it forever", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sessionSeq: number;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    setStatusMock.mockClear();
    sessionSeq = 0;
    fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const path = String(url);
      const method = init?.method ?? "GET";
      if (method === "POST" && path.endsWith("/api/sessions")) {
        sessionSeq += 1;
        const id = `s-${sessionSeq}`;
        return new Response(JSON.stringify({ id, kind: "human", who: "ui", openedAt: "t", lastSeen: "t" }), { status: 200 });
      }
      if (method === "POST" && /\/heartbeat$/.test(path)) {
        // The FIRST session ("s-1") is always treated as already closed
        // server-side (the TTL sweep already reaped it) — every heartbeat
        // against it 404s, exactly like the live rig's repeating failure.
        const dead = path.includes("/sessions/s-1/heartbeat");
        return new Response(JSON.stringify({ reason: dead ? "sessions/s-1: no open session" : "" }), { status: dead ? 404 : 200 });
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_API_MOCK", "0");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("opens a new session and calls setStatus once, instead of 404ing on the same id forever", async () => {
    const { initUiSession } = await import("./wire.ts");
    const stop = initUiSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "POST" })));
    // First open: "s-1".
    await vi.advanceTimersByTimeAsync(10_000); // heartbeat #1 against s-1 -> 404 -> re-open
    await vi.advanceTimersByTimeAsync(10_000); // heartbeat #2 -> now against the new session
    await vi.advanceTimersByTimeAsync(10_000); // heartbeat #3 -> still the new session, no more 404s

    const heartbeatCalls = fetchMock.mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("/heartbeat") && ((args[1] as RequestInit | undefined)?.method ?? "GET") === "POST",
    );
    const targetedIds = heartbeatCalls.map((args: unknown[]) => String(args[0]).match(/sessions\/([^/]+)\/heartbeat/)?.[1]);
    // Never more than ONE heartbeat is sent against the dead id -- it must
    // not keep retrying "s-1" forever.
    expect(targetedIds.filter((id) => id === "s-1").length).toBe(1);
    expect(targetedIds.some((id) => id === "s-2")).toBe(true);
    expect(setStatusMock).toHaveBeenCalledTimes(1);

    stop();
  });
});
