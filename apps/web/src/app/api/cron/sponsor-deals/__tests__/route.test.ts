// Cron route for the hourly sponsor-deals sweep (plan 2026-11-07-sponsor-deals, Task 9; D20). next/headers is mocked so the
// route runs without a request scope, and the sweep is mocked so this stays DB-free — its logic is covered in
// usecases/__tests__/sponsor-deals-sweep.test.ts.
//
// The point of this file is the WIRING (billing-quantity/route.test.ts's #332 lesson): a sweep nothing invokes is
// indistinguishable from an absent one. What it pins: the secret is checked BEFORE any work (a refused call runs nothing), the
// refusals are the cron house shapes (503 unset, 401 missing or wrong), and the right secret answers the sweep's counts as
// they are — the keys the cron Worker's `failureCounts: ["data.failed"]` reads.
import { afterEach, describe, expect, it, vi } from "vitest";

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));
const sweep = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/server/usecases/sponsor-deals", () => ({ sweepSponsorDeals: sweep.run }));

import { POST } from "../route";

afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  sweep.run.mockReset();
});

type Body = { ok?: boolean; data?: Record<string, unknown> };
const COUNTS = { checked: 7, expired: 2, finished: 1, promoted: 1, failed: 0 };

describe("POST /api/cron/sponsor-deals", () => {
  it("503s when CRON_SECRET is not configured, running nothing", async () => {
    hdrs.store = new Headers({ "x-cron-secret": "anything" });
    expect((await POST()).status).toBe(503);
    expect(sweep.run).not.toHaveBeenCalled();
  });

  it("401s on a missing or a wrong x-cron-secret, running nothing", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const statuses = [(await POST()).status];
    hdrs.store = new Headers({ "x-cron-secret": "wrong" });
    statuses.push((await POST()).status);
    hdrs.store = new Headers({ "x-cron-secret": "s3cre" });
    statuses.push((await POST()).status);
    expect(statuses, "no header, a wrong one, and a prefix of the right one").toEqual([401, 401, 401]);
    expect(sweep.run).not.toHaveBeenCalled();
  });

  it("with the right secret it runs the sweep once and answers its counts, key for key", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
    sweep.run.mockResolvedValue(COUNTS);
    const res = await POST();
    expect(res.status).toBe(200);
    expect(sweep.run).toHaveBeenCalledTimes(1);
    expect(sweep.run.mock.calls[0], "the route sweeps every org: it passes no scope").toEqual([]);
    const body = (await res.json()) as Body;
    expect(body.data).toEqual(COUNTS);
    // The Worker alerts on `data.failed`: a renamed key reads as "unreadable", i.e. degraded, on every run.
    expect(Object.keys(body.data ?? {}).sort()).toEqual(["checked", "expired", "failed", "finished", "promoted"]);
  });

  it("a sweep that throws is an error answer, not a 200", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
    sweep.run.mockRejectedValue(new Error("the database is down"));
    expect((await POST()).status).toBeGreaterThanOrEqual(500);
  });
});
