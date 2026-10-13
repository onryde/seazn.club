// Cron route auth for the external-play sweep — same x-cron-secret /
// CRON_SECRET contract as /api/cron/billing-events. The sweep is mocked so
// this stays DB-free (the sweep itself: usecases/__tests__/external-play-sweep.test.ts).
//
// Final review I-1, the seam (R3): the cron Worker reads this route's 200 body through ITS OWN `failureCountsOver0` and
// the REAL `external-play` row, both imported from apps/cron-worker (never a copy), as stream-tick/route.test.ts does.
import { afterEach, describe, expect, it, vi } from "vitest";

// apps/cron-worker is outside the Fly image's build context, and ci.yml type-checks apps/web inside that image, so the
// specifiers are computed (stream-tick/route.test.ts's reason): vitest still loads the REAL modules.
type Job = { id: string; path: string; failureCounts?: readonly string[] };
const cronSrc = (file: string) => new URL(`../../../../../../cron-worker/src/${file}`, import.meta.url).href;
const { JOB_TIMEOUT_MS, failureCountsOver0 } = (await import(/* @vite-ignore */ cronSrc("call.ts"))) as {
  JOB_TIMEOUT_MS: number;
  failureCountsOver0: (job: Job, bodyText: string | null) => Record<string, number | "unreadable">;
};
const { JOBS } = (await import(/* @vite-ignore */ cronSrc("schedule.ts"))) as { JOBS: readonly Job[] };
const ROW = JOBS.find((j) => j.id === "external-play");

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
      skipped: 0,
      bridgesClosed: 10,
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
      deferred: 11,
      failed: 1,
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

  it("I-1: the Worker reads the REAL row's counters off the route's real body — clean is healthy; a failure or a skipped pass is degraded", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
    expect(ROW, "the external-play row").toBeDefined();
    const zero = {
      skipped: 0, bridgesClosed: 0, noShows: 0, mintRetries: 0, meetingsEnded: 0, reconciled: 0, heldForOrganiser: 0,
      cameraSettled: 0, cameraFlags: 0, connectionFlags: 0, arbitersRemoved: 0, scanned: 0, deferred: 0, failed: 0, failures: [],
    };
    const cases: [string, object, Record<string, number | "unreadable">][] = [
      ["a clean pass", zero, {}],
      // `deferred` is NOT a failure: the next firing reaches those boards.
      ["a pass that ran out of budget", { ...zero, deferred: 4 }, {}],
      ["a pass with one failure", { ...zero, failed: 1, failures: [{ job: "reconcile", fixtureId: "f-1", code: "X" }] }, { "data.failed": 1 }],
      ["a pass that found the lock held", { ...zero, skipped: 1 }, { "data.skipped": 1 }],
    ];
    let checked = 0;
    for (const [name, body, want] of cases) {
      sweepMock.mockResolvedValueOnce(body);
      const text = await (await POST()).text();
      expect(failureCountsOver0(ROW!, text), name).toEqual(want);
      checked++;
    }
    expect(checked).toBe(4);
    // The pair: the boolean `skipped` this report used to carry is unreadable to the Worker, i.e. degraded on EVERY pass.
    expect(failureCountsOver0(ROW!, JSON.stringify({ ok: true, data: { ...zero, skipped: false } }))).toEqual({ "data.skipped": "unreadable" });
  });

  it("I-1: the pass's wall-clock budget stops below the Worker's per-job timeout", async () => {
    const { SWEEP_PASS_BUDGET_MS } = await vi.importActual<typeof import("@/server/usecases/external-play/sweep")>(
      "@/server/usecases/external-play/sweep",
    );
    expect(SWEEP_PASS_BUDGET_MS).toBeGreaterThan(0);
    expect(SWEEP_PASS_BUDGET_MS).toBeLessThan(JOB_TIMEOUT_MS);
  });
});
