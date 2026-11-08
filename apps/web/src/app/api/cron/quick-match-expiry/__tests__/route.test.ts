// POST /api/cron/quick-match-expiry: one pass of the quick match sweep (plan 3 Task 2). Same x-cron-secret / CRON_SECRET contract as
// every cron route here, in the same order (503 when the secret is unset BEFORE 401 on a mismatch, so an unset secret can never read
// as "no auth required"). next/headers is mocked so the route runs without a request scope, and the sweep is mocked so this file
// stays DB-free and never sweeps the shared database: the sweep itself is server/usecases/__tests__/quick-match-sweep.test.ts, and the
// real route over the real sweep is the `quick_match_reminder` scenario of server/email-outbox/__tests__/outbox-kind-sweep.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

const sweepMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/usecases/quick-match-sweep", () => ({ sweepQuickMatches: sweepMock }));

import { POST } from "../route";

const ZERO = { checked: 0, rearmed: 0, reminded: 0, expired: 0, orphans: 0, failed: 0, deferred: 0 };
/** The base the reminder's links are built on, pinned through the override `baseUrl(req)` prefers (lib/oauth.ts). */
const BASE = "https://qm-cron.test";
const req = () => new Request("http://0.0.0.0:3000/api/cron/quick-match-expiry", { method: "POST" });

afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  sweepMock.mockReset();
});

const authorised = () => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
};

describe("POST /api/cron/quick-match-expiry: the auth contract", () => {
  it("503 when CRON_SECRET is not configured, even with a secret header sent, and the sweep never runs", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(req())).status).toBe(503);
    hdrs.store = new Headers({ "x-cron-secret": "anything" });
    expect((await POST(req())).status, "503 comes BEFORE 401: an unset secret is never 'no auth'").toBe(503);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("401 with a missing, wrong or near-miss x-cron-secret, never running the sweep", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await POST(req())).status, "missing header").toBe(401);
    hdrs.store = new Headers({ "x-cron-secret": "wrong" });
    expect((await POST(req())).status, "wrong header").toBe(401);
    hdrs.store = new Headers({ "x-cron-secret": "s3cret2" });
    expect((await POST(req())).status, "near miss").toBe(401);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("200 with the report under data on the right secret: ONE sweep, with the request's base URL and nothing else (no scope, no clock)", async () => {
    authorised();
    vi.stubEnv("OAUTH_BASE_URL", BASE);
    const report = { ...ZERO, checked: 9, reminded: 2, expired: 1, deferred: 3 };
    sweepMock.mockResolvedValue(report);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: report });
    expect(sweepMock).toHaveBeenCalledTimes(1);
    // The test-only seams (onlyIds, an injected clock, a failing delete) are never reachable from the route.
    expect(sweepMock).toHaveBeenCalledWith({ baseUrl: BASE });
  });

  it("an empty run answers its zero counts as they are", async () => {
    authorised();
    sweepMock.mockResolvedValue(ZERO);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: ZERO });
  });

  it("a sweep that throws is a 5xx, never a 200 that reads healthy", async () => {
    authorised();
    sweepMock.mockRejectedValue(new Error("database down"));
    const res = await POST(req());
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
