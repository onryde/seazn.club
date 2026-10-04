// Capture QR v2 T7b (§6.11, W22): POST /api/cron/stream-tick — the 5-minute pass that ticks every open stream session so a
// phone that dies with no panel open is still ended. The same x-cron-secret / CRON_SECRET contract as relay-sweep, in the
// same order (503 before 401). next/headers is mocked so the route runs without a request scope, and the use-case is
// mocked so this file stays DB-free (the pass itself is stream-tick.test.ts's "tickOpenSessions" block).
//
// The seam (R3): the cron Worker reads this route's 200 body through ITS OWN `failureCountsOver0` and the REAL
// `stream-tick` row, both imported from apps/cron-worker — never a copy, which would be a fixture on both ends. A body
// whose `data.failed` is missing reads "unreadable" there, i.e. degraded: one Sentry event per hour from every
// relay-disabled deployment. So the disabled answer must carry `failed: 0`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { JOB_TIMEOUT_MS, failureCountsOver0 } from "../../../../../../cron-worker/src/call";
import { JOBS } from "../../../../../../cron-worker/src/schedule";

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

const m = vi.hoisted(() => ({ tick: vi.fn(), deps: vi.fn(), sentinel: { drivers: { disabled: false } } }));
vi.mock("@/server/usecases/stream-sessions", () => ({ defaultDeps: m.deps, tickOpenSessions: m.tick }));

import { POST } from "./route";

const req = () => new Request("http://internal:3000/api/cron/stream-tick", { method: "POST", headers: { "x-forwarded-host": "app.example" } });
const ROW = JOBS.find((j) => j.id === "stream-tick");
const ZERO = { ticked: 0, ended: 0, failed: 0, deferred: 0 };

afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  m.tick.mockReset();
  m.deps.mockReset();
});

const authorised = () => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.stubEnv("OAUTH_BASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "");
  hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
};

describe("POST /api/cron/stream-tick", () => {
  it("PREMISE: the Worker's row for this route is the one the seam cases read — its path and its one failure counter", () => {
    expect(ROW, "the stream-tick row exists").toBeDefined();
    expect(ROW!.path).toBe("/api/cron/stream-tick");
    expect(ROW!.failureCounts).toEqual(["data.failed"]);
  });

  it("503 when CRON_SECRET is unset — BEFORE the header is judged: no header, a wrong one and an empty one all read 503, and nothing is ticked", async () => {
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
  });

  it("401 with a missing or wrong x-cron-secret once the secret IS set — and the tick is never called", async () => {
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
  });

  it("the right secret runs ONE pass with the production deps alone (no test scope) built from the request's base url, and answers its result", async () => {
    authorised();
    m.deps.mockReturnValue(m.sentinel);
    const result = { ticked: 3, ended: 1, failed: 0, deferred: 0 };
    m.tick.mockResolvedValue(result);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: result });
    expect(m.deps).toHaveBeenCalledTimes(1);
    expect(m.deps).toHaveBeenCalledWith("https://app.example");
    expect(m.tick).toHaveBeenCalledTimes(1);
    expect(m.tick.mock.calls[0]).toEqual([m.sentinel]);   // exactly one argument: no orgIds, no wall clock
  });

  it("the R3 seam, enabled: the Worker reads the empty pass and a deferred-only pass as healthy, and a pass with failures as degraded by its count", async () => {
    authorised();
    m.deps.mockReturnValue(m.sentinel);
    const read = async (result: typeof ZERO) => {
      m.tick.mockResolvedValueOnce(result);
      const res = await POST(req());
      expect(res.status).toBe(200);
      return failureCountsOver0(ROW!, await res.text());
    };
    expect(await read(ZERO), "nothing open: healthy").toEqual({});
    expect(await read({ ...ZERO, ticked: 4, deferred: 7 }), "deferred is reached at the next firing: not a failure").toEqual({});
    expect(await read({ ...ZERO, ticked: 4, failed: 2 })).toEqual({ "data.failed": 2 });
  });

  it("R5 relay DISABLED: no pass runs, and the answer carries failed: 0 — the Worker's own reader finds it healthy, where relay-sweep's bare shape would read degraded", async () => {
    authorised();
    m.deps.mockReturnValue({ ...m.sentinel, drivers: { disabled: true } });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, data: { disabled: true, ...ZERO } });
    expect(m.tick).not.toHaveBeenCalled();
    expect(failureCountsOver0(ROW!, text), "the producer's real body through the consumer's real reader").toEqual({});
    // The pair: the same envelope without the counter — what copying relay-sweep's `{ disabled: true }` would answer.
    expect(failureCountsOver0(ROW!, JSON.stringify({ ok: true, data: { disabled: true } }))).toEqual({ "data.failed": "unreadable" });
  });

  it("the pass's wall-clock budget stops below the Worker's per-job timeout, so an overrun reads deferred rather than a timeout", async () => {
    const { STREAM_TICK_BUDGET_MS } = await vi.importActual<typeof import("@/server/usecases/stream-sessions")>("@/server/usecases/stream-sessions");
    expect(STREAM_TICK_BUDGET_MS).toBeGreaterThan(0);
    expect(STREAM_TICK_BUDGET_MS).toBeLessThan(JOB_TIMEOUT_MS);
  });
});
