// Cron route auth for the DAILY relay sweep (streaming R1 Task 12): the same x-cron-secret / CRON_SECRET contract as
// /api/cron/registrations and /api/cron/billing-events. next/headers is mocked so the route runs without a request
// scope; the sweep, the YouTube daily pass and the deps factory are mocked so this stays DB-free (the sweep itself is
// relay-sweep.test.ts, the YouTube pass is youtube/__tests__/daily.test.ts, and route.youtube.test.ts drives the real route
// against the real pass).
//
// The ORDER is the claim, not just the two codes: an UNSET secret answers 503 whatever header arrives — including a
// header equal to the empty string the unset variable would compare against — so a missing secret can never read as
// "no auth required". A request that reaches the sweep calls it with the production deps ALONE: `orgIds` is a
// test-only scope, and a route that passed one would sweep a subset of the database every night.
//
// YouTube Connect T17 (spec §6.6): the route runs the daily YouTube pass FIRST, then the relay-disabled return, then the sweep.
// The seam (R3): the cron Worker reads this route's 200 body through ITS OWN `failureCountsOver0` and the REAL `relay-sweep`
// row, both imported from apps/cron-worker - never a copy, which would be a fixture on both ends. A body whose
// `data.youtube.failed` is missing reads "unreadable" there, i.e. degraded: one Sentry event per day from every
// relay-disabled deployment. So the disabled answer must carry `youtube` too.
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "@/server/logger";

// apps/cron-worker is outside the Fly image's build context (.dockerignore), and ci.yml type-checks apps/web INSIDE that
// image, where a static import of it is TS2307. The specifiers are computed so tsc never resolves them; vitest, which runs
// outside the image, still loads the REAL modules, so the seam stays real and only its types are restated here.
type Job = { id: string; path: string; failureCounts?: readonly string[] };
const cronSrc = (file: string) => new URL(`../../../../../../cron-worker/src/${file}`, import.meta.url).href;
const { JOB_TIMEOUT_MS, failureCountsOver0 } = (await import(/* @vite-ignore */ cronSrc("call.ts"))) as {
  JOB_TIMEOUT_MS: number;
  failureCountsOver0: (job: Job, bodyText: string | null) => Record<string, number | "unreadable">;
};
const { JOBS } = (await import(/* @vite-ignore */ cronSrc("schedule.ts"))) as { JOBS: readonly Job[] };

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

const m = vi.hoisted(() => {
  const port = { isTheYoutubePort: true };
  const now = new Date("2026-10-28T04:17:00Z");
  return {
    sweep: vi.fn(), deps: vi.fn(), daily: vi.fn(), capture: vi.fn(), port, now,
    sentinel: { drivers: { disabled: false }, now: () => now, youtube: port },
  };
});
vi.mock("@/server/usecases/relay-sweep", () => ({ sweepStreamSessions: m.sweep }));
vi.mock("@/server/usecases/stream-sessions", () => ({ defaultDeps: m.deps }));
vi.mock("@/server/youtube/daily", () => ({ youtubeDaily: m.daily }));
vi.mock("@/lib/sentry", () => ({ captureError: m.capture }));

import { POST } from "./route";

const req = () => new Request("http://internal:3000/api/cron/relay-sweep", { method: "POST", headers: { "x-forwarded-host": "app.example" } });

const ROW = JOBS.find((j: Job) => j.id === "relay-sweep");
/** The YouTube pass's answer when it had nothing to do (YoutubeDailyResult, youtube/daily.ts). */
const YZERO = { checked: 0, reconnectNeeded: 0, refreshed: 0, removed: 0, keysRemoved: 0, purged: 0, failed: 0, deferred: 0 };

afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  m.sweep.mockReset();
  m.deps.mockReset();
  m.daily.mockReset();
  m.capture.mockReset();
});

const authorised = () => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.stubEnv("OAUTH_BASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "");
  hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
};

describe("POST /api/cron/relay-sweep", () => {
  it("PREMISE: the Worker's row for this route is the one the seam cases read - its path and its one failure counter (the YouTube pass's)", () => {
    expect(ROW, "the relay-sweep row exists").toBeDefined();
    expect(ROW!.path).toBe("/api/cron/relay-sweep");
    expect(ROW!.failureCounts).toEqual(["data.youtube.failed"]);
  });

  it("503 when CRON_SECRET is unset — BEFORE the header is judged: no header, a wrong one, and an empty one all read 503, and neither the YouTube pass nor the sweep ever runs", async () => {
    vi.stubEnv("CRON_SECRET", "");
    let checked = 0;
    for (const given of [null, "wrong", ""]) {
      hdrs.store = given === null ? new Headers() : new Headers({ "x-cron-secret": given });
      expect((await POST(req())).status, `header ${JSON.stringify(given)}`).toBe(503);
      checked++;
    }
    expect(checked).toBe(3);
    expect(m.deps).not.toHaveBeenCalled();
    expect(m.daily, "the YouTube pass is behind the same auth").not.toHaveBeenCalled();
    expect(m.sweep).not.toHaveBeenCalled();
  });

  it("401 with a missing or wrong x-cron-secret once the secret IS set, never running the YouTube pass or the sweep", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await POST(req())).status).toBe(401);
    hdrs.store = new Headers({ "x-cron-secret": "wrong" });
    expect((await POST(req())).status).toBe(401);
    let nearMisses = 0;
    for (const given of ["s3cre", "s3cret-and-more", "S3CRET"]) {   // no prefix match, no case folding
      hdrs.store = new Headers({ "x-cron-secret": given });
      expect((await POST(req())).status, given).toBe(401);
      nearMisses++;
    }
    expect(nearMisses).toBe(3);
    expect(m.deps).not.toHaveBeenCalled();
    expect(m.daily).not.toHaveBeenCalled();
    expect(m.sweep).not.toHaveBeenCalled();
  });

  it("the right secret runs the YouTube pass ONCE and the sweep ONCE, each with the production deps alone (no test scope), and returns the sweep's summary with the pass's counters under `youtube`", async () => {
    authorised();
    m.deps.mockReturnValue(m.sentinel);
    const summary = { backstop: { candidates: 3, visited: 3 }, machinesListed: 1, videosListed: 7 };
    const youtube = { checked: 4, reconnectNeeded: 1, refreshed: 9, removed: 2, keysRemoved: 0, purged: 1, failed: 0, deferred: 0 };
    m.sweep.mockResolvedValue(summary);
    m.daily.mockResolvedValue(youtube);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { ...summary, youtube } });
    expect(m.deps).toHaveBeenCalledTimes(1);
    expect(m.deps).toHaveBeenCalledWith("https://app.example");
    expect(m.sweep).toHaveBeenCalledTimes(1);
    expect(m.sweep.mock.calls[0]).toEqual([m.sentinel]);   // exactly one argument: no `orgIds`, no options
    // The YouTube pass: the deps' port and the deps' clock - and NOTHING else (no `orgIds`: every organisation).
    expect(m.daily).toHaveBeenCalledTimes(1);
    expect(m.daily.mock.calls[0]).toEqual([m.port, m.now]);
    expect(m.daily.mock.calls[0], "no test seam reaches the production call").toHaveLength(2);
  });

  it("ORDER: the YouTube pass runs BEFORE the sweep (call order recorded), and the sweep starts only after the pass has finished", async () => {
    authorised();
    m.deps.mockReturnValue(m.sentinel);
    const order: string[] = [];
    m.daily.mockImplementation(async () => {
      order.push("youtube:start");
      await Promise.resolve();
      order.push("youtube:end");
      return { ...YZERO };
    });
    m.sweep.mockImplementation(async () => {
      order.push("sweep");
      return { machinesListed: 0 };
    });
    expect((await POST(req())).status).toBe(200);
    expect(order).toEqual(["youtube:start", "youtube:end", "sweep"]);
  });

  it("a THROWING YouTube pass answers youtube.failed 1 (zeros elsewhere), is reported once, and the sweep STILL runs", async () => {
    authorised();
    m.deps.mockReturnValue(m.sentinel);
    m.daily.mockRejectedValue(new Error("database down: password=hunter2"));
    m.sweep.mockResolvedValue({ machinesListed: 2 });
    const logged = vi.spyOn(log, "error");
    const res = await POST(req());
    expect(logged, "logged once").toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logged.mock.calls), "the log names the class, never the message").not.toContain("hunter2");
    expect(logged.mock.calls[0]![0]).toEqual({ errClass: "Error" });
    logged.mockRestore();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, data: { machinesListed: 2, youtube: { ...YZERO, failed: 1 } } });
    expect(m.sweep, "the relay sweep still runs").toHaveBeenCalledTimes(1);
    expect(m.capture, "reported once").toHaveBeenCalledTimes(1);
    expect(m.capture.mock.calls[0]![1]).toMatchObject({ route: "cron.relay_sweep.youtube" });
    expect(text, "the answer carries counters, never the error text").not.toContain("hunter2");
    expect(failureCountsOver0(ROW!, text), "the Worker reads it as degraded on the YouTube counter").toEqual({ "data.youtube.failed": 1 });
  });

  it("a youtube driver that cannot be built (the deps' port getter throws, a misspelt YOUTUBE_DRIVER) is the same: youtube.failed 1, the pass never reached, and the sweep still runs", async () => {
    authorised();
    m.deps.mockReturnValue({
      drivers: { disabled: false }, now: () => m.now,
      get youtube(): never { throw new Error('YOUTUBE_DRIVER must be "fake" or "live", got "fkae"'); },
    });
    m.sweep.mockResolvedValue({ machinesListed: 0 });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).data.youtube).toEqual({ ...YZERO, failed: 1 });
    expect(m.daily, "the pass was never reached").not.toHaveBeenCalled();
    expect(m.sweep).toHaveBeenCalledTimes(1);
    expect(m.capture).toHaveBeenCalledTimes(1);
  });

  it("the R3 seam, enabled: the Worker reads a pass of zeros and a busy but healthy pass as healthy, and a pass with failures as degraded by its count", async () => {
    authorised();
    m.deps.mockReturnValue(m.sentinel);
    m.sweep.mockResolvedValue({ machinesListed: 0 });
    const read = async (youtube: typeof YZERO) => {
      m.daily.mockResolvedValueOnce(youtube);
      const res = await POST(req());
      expect(res.status).toBe(200);
      return failureCountsOver0(ROW!, await res.text());
    };
    expect(await read(YZERO), "nothing connected: healthy").toEqual({});
    expect(await read({ checked: 9, reconnectNeeded: 3, refreshed: 40, removed: 5, keysRemoved: 0, purged: 2, failed: 0, deferred: 0 }), "a dead grant is the pass working, not failing").toEqual({});
    expect(await read({ ...YZERO, checked: 9, failed: 2 })).toEqual({ "data.youtube.failed": 2 });
    // B6 batch review m3: connections the pass's budget cut short are tomorrow's first, not a failure - the Worker's counters are unchanged.
    expect(await read({ ...YZERO, checked: 9, deferred: 4 }), "a deferred connection is not degraded").toEqual({});
    expect(await read({ ...YZERO, checked: 9, deferred: 4, failed: 1 }), "and a failure beside it still is, by its own count").toEqual({ "data.youtube.failed": 1 });
  });

  it("the YouTube pass's YouTube calls - its slice, the dead grants' revoke allowance, and the one call that can be in flight past EACH - fit in two thirds of the Worker's per-job timeout; the relay sweep behind it keeps the rest (B6 round 2 C2)", async () => {
    const { YOUTUBE_DAILY_BUDGET_MS, YOUTUBE_DAILY_REVOKE_BUDGET_MS } = await vi.importActual<typeof import("@/server/youtube/daily")>("@/server/youtube/daily");
    const { YOUTUBE_CALL_BOUND_MS } = await vi.importActual<typeof import("@/server/youtube/port")>("@/server/youtube/port");
    expect(JOB_TIMEOUT_MS, "the Worker's timeout was read from the Worker's own module").toBeGreaterThan(0);
    expect(YOUTUBE_DAILY_BUDGET_MS, "a slice that fits at least one call").toBeGreaterThan(YOUTUBE_CALL_BOUND_MS);
    expect(YOUTUBE_DAILY_REVOKE_BUDGET_MS, "an allowance that fits at least one revoke").toBeGreaterThan(0);
    // The two budgets are spent one after the other (the connection leg, then the dead grants), each overrunning by at most one call.
    const worstCase = YOUTUBE_DAILY_BUDGET_MS + YOUTUBE_DAILY_REVOKE_BUDGET_MS + 2 * YOUTUBE_CALL_BOUND_MS;
    expect(worstCase).toBeLessThanOrEqual((JOB_TIMEOUT_MS * 2) / 3);
  });

  // R5 (Task 14b): a production deployment with RELAY_DRIVERS unset has no relay — every provider port refuses. The sweep
  // has nothing to reconcile against, so the cron answers what it is ({ disabled: true }) instead of a daily 500 from
  // the first provider read. YouTube Connect T17: what Seazn stores FROM YouTube is refreshed or deleted within 30 days
  // (DP III.E.4) whether or not a relay exists, so the YouTube pass runs on a relay-disabled deployment too, and its
  // counters ride the disabled answer.
  it("R5 relay DISABLED: the YouTube pass STILL runs (before the disabled return), the sweep does not, and the answer carries the pass's counters", async () => {
    authorised();
    m.deps.mockReturnValue({ ...m.sentinel, drivers: { disabled: true } });
    m.daily.mockResolvedValue({ ...YZERO, checked: 2, refreshed: 5 });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, data: { disabled: true, youtube: { ...YZERO, checked: 2, refreshed: 5 } } });
    expect(m.daily, "the pass ran on a relay-disabled deployment").toHaveBeenCalledTimes(1);
    expect(m.sweep).not.toHaveBeenCalled();
    expect(failureCountsOver0(ROW!, text), "the disabled answer is READABLE by the Worker: healthy, not 'unreadable'").toEqual({});
  });

  it("R5 relay DISABLED, and the pass throws: youtube.failed 1 still rides the disabled answer, and the Worker reads it as degraded", async () => {
    authorised();
    m.deps.mockReturnValue({ ...m.sentinel, drivers: { disabled: true } });
    m.daily.mockRejectedValue(new Error("boom"));
    const res = await POST(req());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, data: { disabled: true, youtube: { ...YZERO, failed: 1 } } });
    expect(m.sweep).not.toHaveBeenCalled();
    expect(failureCountsOver0(ROW!, text)).toEqual({ "data.youtube.failed": 1 });
  });
});

// PR #902 CI: `next build` collects this route's config by EVALUATING its module graph in a process with no
// DATABASE_URL. stream-sessions.ts built a `sql` fragment at module scope — which opens the pooled client — and the
// build died "Failed to collect configuration for /api/cron/relay-sweep"; every unit shard without a database failed
// to COLLECT the four suites that import it. The mocks above hide exactly that, so this loads the two REAL modules the
// route imports, with no database configured and no client cached.
describe("the route's module graph evaluates with NO database (next build collects its config without one)", () => {
  it("stream-sessions, relay-sweep and the YouTube daily pass load — and the probe is live: a query built on `sql` in the same state throws", async () => {
    vi.stubEnv("DATABASE_URL", "");
    expect((globalThis as { _sql?: unknown })._sql, "a cached client would mask a module-scope query").toBeUndefined();
    const loaded: string[] = [];
    const ss = await vi.importActual<typeof import("@/server/usecases/stream-sessions")>("@/server/usecases/stream-sessions");
    expect(typeof ss.defaultDeps).toBe("function");
    loaded.push("stream-sessions");
    const rs = await vi.importActual<typeof import("@/server/usecases/relay-sweep")>("@/server/usecases/relay-sweep");
    expect(typeof rs.sweepStreamSessions).toBe("function");
    loaded.push("relay-sweep");
    const yd = await vi.importActual<typeof import("@/server/youtube/daily")>("@/server/youtube/daily");
    expect(typeof yd.youtubeDaily).toBe("function");
    loaded.push("youtube-daily");
    expect(loaded).toEqual(["stream-sessions", "relay-sweep", "youtube-daily"]);
    // The positive twin: this state DOES refuse a query built on `sql`, so the loads above prove the modules build none.
    const { sql } = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
    expect(() => sql`select 1`).toThrow(/DATABASE_URL is not set/);
  });
});
