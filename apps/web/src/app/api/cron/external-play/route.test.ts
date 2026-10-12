// Cron route auth for the external-play sweep — same x-cron-secret /
// CRON_SECRET contract as /api/cron/billing-events. The sweep is mocked so
// this stays DB-free (the sweep itself: usecases/__tests__/external-play-sweep.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

const sweepMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/usecases/external-play", () => ({
  sweepExternalPlay: sweepMock,
}));

import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  sweepMock.mockReset();
});

describe("POST /api/cron/external-play", () => {
  it("401s with a missing or wrong x-cron-secret, never running the sweep", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await POST()).status).toBe(401);
    hdrs.store = new Headers({ "x-cron-secret": "wrong" });
    expect((await POST()).status).toBe(401);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("503s when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST()).status).toBe(503);
  });

  it("runs ONE sweep pass with production deps and answers its report with the right secret", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
    const report = {
      skipped: false,
      noShows: 1,
      mintRetries: 2,
      meetingsEnded: 3,
      reconciled: 4,
      heldForOrganiser: 5,
      cameraSettled: 6,
      cameraFlags: 7,
      connectionFlags: 8,
      arbitersRemoved: 9,
      scanned: 15,
      failures: [
        {
          job: "reconcile",
          fixtureId: "f-1",
          code: "LICHESS_TOKEN_UNAVAILABLE",
        },
      ],
    };
    sweepMock.mockResolvedValue(report);
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: report });
    expect(sweepMock).toHaveBeenCalledTimes(1);
    // No deps: every org, the real clock, the real Lichess/RealtimeKit —
    // never the test seam (orgIds) or an injected `now`.
    expect(sweepMock).toHaveBeenCalledWith();
  });
});
