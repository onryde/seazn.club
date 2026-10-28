// Capture QR v2 T7b (§6.11, W22): POST /api/cron/stream-tick — the pass, on every fast firing, that ticks every open stream
// session so a phone that dies with no panel open is still ended. The same x-cron-secret / CRON_SECRET contract as
// relay-sweep, in the same order (503 before 401). next/headers is mocked so the route runs without a request scope, and
// both passes are mocked so this file stays DB-free (the session pass is stream-tick.test.ts's "tickOpenSessions" block, the
// YouTube end step is end-step.test.ts; route.youtube.test.ts drives both for real).
//
// YouTube Connect T15 (spec §9.2): the route runs the YouTube END STEP first, then the relay-disabled return, then the session
// pass with what is left of its 45 s. The three order/budget/failure cases below are about THIS file's wiring only.
//
// The seam (R3): the cron Worker reads this route's 200 body through ITS OWN `failureCountsOver0` and the REAL
// `stream-tick` row, both imported from apps/cron-worker — never a copy, which would be a fixture on both ends. A body
// whose `data.failed` is missing reads "unreadable" there, i.e. degraded: one Sentry event per hour from every
// relay-disabled deployment. So the disabled answer must carry `failed: 0`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  return {
    tick: vi.fn(), deps: vi.fn(), end: vi.fn(), capture: vi.fn(), port,
    sentinel: { drivers: { disabled: false }, now: () => new Date(), youtube: port },
  };
});
// The real STREAM_TICK_BUDGET_MS stays real (the budget case pins its value); the two passes are the spies.
vi.mock("@/server/usecases/stream-sessions", async (importOriginal) => ({
  STREAM_TICK_BUDGET_MS: (await importOriginal<typeof import("@/server/usecases/stream-sessions")>()).STREAM_TICK_BUDGET_MS,
  defaultDeps: m.deps,
  tickOpenSessions: m.tick,
}));
vi.mock("@/server/youtube/end-step", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/youtube/end-step")>()),
  endDueBroadcasts: m.end,
}));
vi.mock("@/lib/sentry", () => ({ captureError: m.capture }));

import { POST } from "./route";

const req = () => new Request("http://internal:3000/api/cron/stream-tick", { method: "POST", headers: { "x-forwarded-host": "app.example" } });
const ROW = JOBS.find((j: Job) => j.id === "stream-tick");
const ZERO = { ticked: 0, ended: 0, failed: 0, deferred: 0 };
/** The YouTube end step's answer when it had nothing to do (YoutubeEndResult, end-step.ts). */
const YZERO = { ended: 0, neverLive: 0, orphans: 0, failed: 0, deferred: 0 };

beforeEach(() => {
  // Only `Date` is faked: elapsed time is then exactly what a case scripts (a real clock would make every budget off by a ms).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
  m.end.mockResolvedValue({ ...YZERO });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  m.tick.mockReset();
  m.deps.mockReset();
  m.end.mockReset();
  m.capture.mockReset();
});

const authorised = () => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.stubEnv("OAUTH_BASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "");
  hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
};

describe("POST /api/cron/stream-tick", () => {
  it("PREMISE: the Worker's row for this route is the one the seam cases read — its path and its two failure counters (the session pass's and the YouTube step's)", () => {
    expect(ROW, "the stream-tick row exists").toBeDefined();
    expect(ROW!.path).toBe("/api/cron/stream-tick");
    expect(ROW!.failureCounts).toEqual(["data.failed", "data.youtube.failed"]);
  });

  it("503 when CRON_SECRET is unset — BEFORE the header is judged: no header, a wrong one and an empty one all read 503, and nothing is ticked or ended", async () => {
    vi.stubEnv("CRON_SECRET", "");
    let checked = 0;
    for (const given of [null, "wrong", ""]) {
      hdrs.store = given === null ? new Headers() : new Headers({ "x-cron-secret": given });
      expect((await POST(req())).status, `header ${JSON.stringify(given)}`).toBe(503);
      checked++;
    }
    expect(checked).toBe(3);
    expect(m.deps).not.toHaveBeenCalled();
    expect(m.tick).not.toHaveBeenCalled();
    expect(m.end, "the YouTube step is behind the same auth").not.toHaveBeenCalled();
  });

  it("401 with a missing or wrong x-cron-secret once the secret IS set — and neither the YouTube step nor the tick is ever called", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    let checked = 0;
    for (const given of [null, "wrong", "s3cre", "s3cret-and-more", "S3CRET"]) {   // no prefix match, no case folding
      hdrs.store = given === null ? new Headers() : new Headers({ "x-cron-secret": given });
      expect((await POST(req())).status, `header ${JSON.stringify(given)}`).toBe(401);
      checked++;
    }
    expect(checked).toBe(5);
    expect(m.deps).not.toHaveBeenCalled();
    expect(m.tick, "tickOpenSessions spy").toHaveBeenCalledTimes(0);
    expect(m.end, "endDueBroadcasts spy").toHaveBeenCalledTimes(0);
  });

  it("the right secret runs ONE YouTube step and ONE session pass with the production deps alone (no test scope) built from the request's base url, and answers both results", async () => {
    authorised();
    m.deps.mockReturnValue(m.sentinel);
    const result = { ticked: 3, ended: 1, failed: 0, deferred: 0 };
    const youtube = { ended: 2, neverLive: 1, orphans: 1, failed: 0, deferred: 0 };
    m.tick.mockResolvedValue(result);
    m.end.mockResolvedValue(youtube);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { ...result, youtube } });
    expect(m.deps).toHaveBeenCalledTimes(1);
    expect(m.deps).toHaveBeenCalledWith("https://app.example");
    // The YouTube step: the deps' port and clock, a 15 s slice of the tick, NO orgIds (every org) and no wall clock (T14's forward note).
    expect(m.end).toHaveBeenCalledTimes(1);
    expect(m.end.mock.calls[0]).toEqual([m.port, { now: m.sentinel.now, budgetMs: 15_000 }]);
    expect(Object.keys(m.end.mock.calls[0]![1]).sort(), "no test seam reaches the production call").toEqual(["budgetMs", "now"]);
    // The session pass: the deps and a budget — and nothing else (no orgIds, no wall clock).
    expect(m.tick).toHaveBeenCalledTimes(1);
    expect(m.tick.mock.calls[0]).toEqual([m.sentinel, { budgetMs: 45_000 }]);
  });

  it("ORDER: the YouTube step runs BEFORE the session pass (call order recorded), and the pass starts only after the step has finished", async () => {
    authorised();
    m.deps.mockReturnValue(m.sentinel);
    const order: string[] = [];
    m.end.mockImplementation(async () => {
      order.push("youtube:start");
      await Promise.resolve();
      order.push("youtube:end");
      return { ...YZERO };
    });
    m.tick.mockImplementation(async () => {
      order.push("sessions");
      return { ...ZERO };
    });
    expect((await POST(req())).status).toBe(200);
    expect(order).toEqual(["youtube:start", "youtube:end", "sessions"]);
  });

  it("the session pass gets 45 s MINUS what the YouTube step spent (scripted clock): 12 s spent leaves 33 s, nothing spent leaves all 45 s", async () => {
    authorised();
    m.deps.mockReturnValue(m.sentinel);
    m.tick.mockResolvedValue({ ...ZERO });
    m.end.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 12_000);
      return { ...YZERO };
    });
    expect((await POST(req())).status).toBe(200);
    expect(m.tick.mock.calls[0]![1], "12 s spent").toEqual({ budgetMs: 33_000 });
    // The pair: a step that spent nothing leaves the pass its whole budget, so the 33 s above is the subtraction and not a constant.
    expect((await POST(req())).status).toBe(200);
    expect(m.tick.mock.calls[1]![1], "nothing spent").toEqual({ budgetMs: 45_000 });
  });

  it("a step that spent MORE than the tick's whole 45 s leaves the pass a budget of 0 — never a negative one (every session deferred to the next firing)", async () => {
    authorised();
    m.deps.mockReturnValue(m.sentinel);
    m.tick.mockResolvedValue({ ...ZERO, deferred: 3 });
    m.end.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 50_000);
      return { ...YZERO };
    });
    expect((await POST(req())).status).toBe(200);
    expect(m.tick.mock.calls[0]![1]).toEqual({ budgetMs: 0 });
  });

  it("a THROWING YouTube step answers youtube.failed 1 (zeros elsewhere), is reported once, and the session pass STILL runs on its whole budget", async () => {
    authorised();
    m.deps.mockReturnValue(m.sentinel);
    m.end.mockRejectedValue(new Error("database down: password=hunter2"));
    m.tick.mockResolvedValue({ ticked: 2, ended: 1, failed: 0, deferred: 0 });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, data: { ticked: 2, ended: 1, failed: 0, deferred: 0, youtube: { ended: 0, neverLive: 0, orphans: 0, failed: 1, deferred: 0 } } });
    expect(m.tick, "the sessions are still ticked").toHaveBeenCalledTimes(1);
    expect(m.tick.mock.calls[0]![1]).toEqual({ budgetMs: 45_000 });
    expect(m.capture, "reported once").toHaveBeenCalledTimes(1);
    expect(m.capture.mock.calls[0]![1]).toMatchObject({ route: "cron.stream_tick.youtube" });
    expect(text, "the answer carries counters, never the error text").not.toContain("hunter2");
    // The Worker reads it as degraded on the YouTube counter alone: the session pass was healthy.
    expect(failureCountsOver0(ROW!, text)).toEqual({ "data.youtube.failed": 1 });
  });

  it("a youtube driver that cannot be built (the deps' port getter throws, a misspelt YOUTUBE_DRIVER) is the same: youtube.failed 1, and the sessions are still ticked", async () => {
    authorised();
    m.deps.mockReturnValue({
      drivers: { disabled: false }, now: () => new Date(),
      get youtube(): never { throw new Error('YOUTUBE_DRIVER must be "fake" or "live", got "fkae"'); },
    });
    m.tick.mockResolvedValue({ ...ZERO });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).data.youtube).toEqual({ ...YZERO, failed: 1 });
    expect(m.end, "the step was never reached").not.toHaveBeenCalled();
    expect(m.tick).toHaveBeenCalledTimes(1);
    expect(m.capture).toHaveBeenCalledTimes(1);
  });

  it("the R3 seam, enabled: the Worker reads the empty pass and a deferred-only pass as healthy, and a pass with failures as degraded by its count", async () => {
    authorised();
    m.deps.mockReturnValue(m.sentinel);
    const read = async (result: typeof ZERO, youtube: typeof YZERO = YZERO) => {
      m.tick.mockResolvedValueOnce(result);
      m.end.mockResolvedValueOnce(youtube);
      const res = await POST(req());
      expect(res.status).toBe(200);
      return failureCountsOver0(ROW!, await res.text());
    };
    expect(await read(ZERO), "nothing open: healthy").toEqual({});
    expect(await read({ ...ZERO, ticked: 4, deferred: 7 }), "deferred is reached at the next firing: not a failure").toEqual({});
    expect(await read({ ...ZERO, ticked: 4, failed: 2 })).toEqual({ "data.failed": 2 });
  });

  it("the R3 seam for the YouTube counter: failed reads degraded by its count; ended / neverLive / orphans / deferred are NOT failures; the two counters are read independently", async () => {
    authorised();
    m.deps.mockReturnValue(m.sentinel);
    const read = async (result: typeof ZERO, youtube: typeof YZERO) => {
      m.tick.mockResolvedValueOnce(result);
      m.end.mockResolvedValueOnce(youtube);
      const res = await POST(req());
      expect(res.status).toBe(200);
      return failureCountsOver0(ROW!, await res.text());
    };
    expect(await read(ZERO, { ended: 3, neverLive: 2, orphans: 4, failed: 0, deferred: 9 }), "a busy but healthy step").toEqual({});
    expect(await read(ZERO, { ...YZERO, failed: 2 }), "a broadcast that failed this pass").toEqual({ "data.youtube.failed": 2 });
    expect(await read({ ...ZERO, failed: 1 }, { ...YZERO, failed: 2 }), "both at once: both named").toEqual({ "data.failed": 1, "data.youtube.failed": 2 });
    expect(await read({ ...ZERO, failed: 1 }, YZERO), "the session counter alone").toEqual({ "data.failed": 1 });
  });

  it("R5 relay DISABLED: a due broadcast is STILL ended (the step runs before the disabled return), no session pass runs, and the answer carries failed: 0 and the step's counters", async () => {
    authorised();
    m.deps.mockReturnValue({ ...m.sentinel, drivers: { disabled: true } });
    m.end.mockResolvedValue({ ...YZERO, ended: 1 });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, data: { disabled: true, ...ZERO, youtube: { ...YZERO, ended: 1 } } });
    expect(m.end, "the step ran on a relay-disabled deployment (spec §9.2)").toHaveBeenCalledTimes(1);
    expect(m.tick).not.toHaveBeenCalled();
    expect(failureCountsOver0(ROW!, text), "the producer's real body through the consumer's real reader").toEqual({});
    // The pairs: the same envelope without a counter — what copying relay-sweep's `{ disabled: true }` would answer, or forgetting the step's.
    expect(failureCountsOver0(ROW!, JSON.stringify({ ok: true, data: { disabled: true } }))).toEqual({ "data.failed": "unreadable", "data.youtube.failed": "unreadable" });
    expect(failureCountsOver0(ROW!, JSON.stringify({ ok: true, data: { disabled: true, ...ZERO } }))).toEqual({ "data.youtube.failed": "unreadable" });
  });

  it("R5 relay DISABLED and the step throws: the answer is still complete (failed: 0, youtube.failed 1) — a disabled deployment is not made unreadable by a bad step", async () => {
    authorised();
    m.deps.mockReturnValue({ ...m.sentinel, drivers: { disabled: true } });
    m.end.mockRejectedValue(new Error("boom"));
    const res = await POST(req());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).data).toEqual({ disabled: true, ...ZERO, youtube: { ...YZERO, failed: 1 } });
    expect(failureCountsOver0(ROW!, text)).toEqual({ "data.youtube.failed": 1 });
    expect(m.tick).not.toHaveBeenCalled();
  });

  it("the pass's wall-clock budget stops below the Worker's per-job timeout, so an overrun reads deferred rather than a timeout; and the YouTube slice is a part of it, not more", async () => {
    const { STREAM_TICK_BUDGET_MS } = await vi.importActual<typeof import("@/server/usecases/stream-sessions")>("@/server/usecases/stream-sessions");
    const { YOUTUBE_END_BUDGET_MS } = await vi.importActual<typeof import("@/server/youtube/end-step")>("@/server/youtube/end-step");
    expect(STREAM_TICK_BUDGET_MS).toBeGreaterThan(0);
    expect(STREAM_TICK_BUDGET_MS).toBeLessThan(JOB_TIMEOUT_MS);
    // The spec's figures (§6.7, T15): the tick is 45 s of the Worker's 60, and the YouTube step takes at most 15 of those 45.
    expect(STREAM_TICK_BUDGET_MS).toBe(45_000);
    expect(YOUTUBE_END_BUDGET_MS).toBe(15_000);
    expect(YOUTUBE_END_BUDGET_MS).toBeLessThan(STREAM_TICK_BUDGET_MS);
  });
});
