// POST /api/cron/external-play-premint: one pass of the pre-mint job. Same x-cron-secret / CRON_SECRET contract as every cron
// route here, in the same order (503 when the secret is unset BEFORE 401 on a mismatch, so an unset secret can never read as
// "no auth required"). next/headers is mocked so the route runs without a request scope, and the pass is mocked so this file
// stays DB-free (the pass itself: usecases/__tests__/external-play-premint.test.ts; the route over the REAL pass with the
// flag off: route-flag-off.test.ts beside this file).
//
// The seam (R3): the cron Worker reads this route's 200 body through ITS OWN `failureCountsOver0` and the REAL
// `external-play-premint` row, both imported from apps/cron-worker, never a copy (stream-tick/route.test.ts's reason).
import { afterEach, describe, expect, it, vi } from "vitest";

// apps/cron-worker is outside the Fly image's build context (.dockerignore), and ci.yml type-checks apps/web INSIDE that image,
// where a static import of it is TS2307. The specifiers are computed so tsc never resolves them; vitest, which runs outside the
// image, still loads the REAL modules, so the seam stays real and only its types are restated here.
type Job = { id: string; path: string; failureCounts?: readonly string[] };
const cronSrc = (file: string) => new URL(`../../../../../../../cron-worker/src/${file}`, import.meta.url).href;
const { JOB_TIMEOUT_MS, failureCountsOver0 } = (await import(/* @vite-ignore */ cronSrc("call.ts"))) as {
  JOB_TIMEOUT_MS: number;
  failureCountsOver0: (job: Job, bodyText: string | null) => Record<string, number | "unreadable">;
};
const { JOBS } = (await import(/* @vite-ignore */ cronSrc("schedule.ts"))) as { JOBS: readonly Job[] };
const ROW = JOBS.find((j) => j.id === "external-play-premint");

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

const passMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/usecases/external-play", () => ({ premintExternalPlay: passMock }));

import type { PremintReport } from "@/server/usecases/external-play/premint";
import { POST } from "../route";

/** A clean, enabled pass's report, typed by the REAL `PremintReport` (a type-only import: erased at run time, so the pass stays
 *  mocked, but tsc ties this fixture's field names to the producer's declaration): every field it declares, so a field the
 *  route dropped would show. */
const ZERO: PremintReport = { skipped: 0, disabled: 0, scanned: 0, roomsMade: 0, deferred: 0, failed: 0, windowsOpen: 0, failures: [] };

afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  passMock.mockReset();
});

const authorised = () => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
};

describe("POST /api/cron/external-play-premint: the auth contract", () => {
  it("503 when CRON_SECRET is not configured - even with a secret header sent, and the pass never runs", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST()).status).toBe(503);
    hdrs.store = new Headers({ "x-cron-secret": "anything" });
    expect((await POST()).status, "503 comes BEFORE 401: an unset secret is never 'no auth'").toBe(503);
    expect(passMock).not.toHaveBeenCalled();
  });

  it("401 with a missing or wrong x-cron-secret, never running the pass", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await POST()).status, "missing header").toBe(401);
    hdrs.store = new Headers({ "x-cron-secret": "wrong" });
    expect((await POST()).status, "wrong header").toBe(401);
    hdrs.store = new Headers({ "x-cron-secret": "s3cret2" });
    expect((await POST()).status, "near miss").toBe(401);
    expect(passMock).not.toHaveBeenCalled();
  });

  it("200 with the report under data on the right secret, and ONE pass with the production defaults (no scope, no injected clock, no lock bypass)", async () => {
    authorised();
    const report = { ...ZERO, scanned: 6, roomsMade: 4, deferred: 2 };
    passMock.mockResolvedValue(report);
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: report });
    expect(passMock).toHaveBeenCalledTimes(1);
    // The test-only seams (orgIds, serialise: false, an injected clock, wait, rtk, callCap) are never reachable from the route.
    expect(passMock).toHaveBeenCalledWith();
  });

  it("a pass that throws is a 5xx, not a 200 that reads healthy", async () => {
    authorised();
    passMock.mockRejectedValue(new Error("database down"));
    expect((await POST()).status).toBeGreaterThanOrEqual(500);
  });
});

describe("POST /api/cron/external-play-premint: the Worker reads the REAL row's counters off the route's real body (R3)", () => {
  it("clean, disabled, window-open and deferred passes are healthy; a failed room, a down vendor, a skipped pass and an unconfigured vendor are degraded - never swallowed", async () => {
    authorised();
    expect(ROW, "the external-play-premint row").toBeDefined();
    const failure = (fixtureId: string, code: string): PremintReport["failures"][number] => ({ fixtureId, side: "home", code });
    // A vendor that is down is at most PREMINT_FAILURES_BEFORE_BREAK failures a pass (3, the T4 ruling), then the rest is
    // deferred: the monitor must still see all three, and `deferred` beside them must not hide them.
    const down = [failure("f-1", "unavailable"), failure("f-2", "unavailable"), failure("f-3", "unavailable")];
    const cases: [string, object, Record<string, number | "unreadable">][] = [
      ["a clean pass", { ...ZERO, scanned: 2, roomsMade: 2 }, {}],
      // The flag is off (the default until Task 8): not a failure, or every minute would page.
      ["a flag-off pass", { ...ZERO, disabled: 1 }, {}],
      ["a pass that found a check-in window open", { ...ZERO, windowsOpen: 1 }, {}],
      // `deferred` is NOT a failure: the next firing reaches those rows.
      ["a pass that ran out of budget", { ...ZERO, scanned: 8, roomsMade: 2, deferred: 6 }, {}],
      ["a pass with one failed room", { ...ZERO, scanned: 2, failed: 1, failures: [failure("f-1", "unavailable")] }, { "data.failed": 1 }],
      ["a vendor outage: 3 failures, the rest deferred", { ...ZERO, scanned: 8, failed: 3, deferred: 5, failures: down }, { "data.failed": 3 }],
      ["RealtimeKit unconfigured: one failure, the rest deferred", { ...ZERO, scanned: 6, failed: 1, deferred: 5, failures: [failure("f-1", "unconfigured")] }, { "data.failed": 1 }],
      ["a pass that found the lock held", { ...ZERO, skipped: 1 }, { "data.skipped": 1 }],
    ];
    let checked = 0;
    for (const [name, body, want] of cases) {
      passMock.mockResolvedValueOnce(body);
      const res = await POST();
      const text = await res.text();
      expect(res.status, `${name}: a failed pass is a 200 whose body the Worker reads`).toBe(200);
      // The route hands the report over verbatim: a stripped or summarised body would read healthy to the Worker.
      expect(JSON.parse(text), `${name}: the body is the report, untouched`).toEqual({ ok: true, data: body });
      expect(failureCountsOver0(ROW!, text), name).toEqual(want);
      checked++;
    }
    expect(checked, "cases checked").toBe(8);
    expect(passMock, "one pass per request").toHaveBeenCalledTimes(8);
    // The pair: a boolean `skipped` (the shape a pass could drift to) is unreadable to the Worker, i.e. degraded on EVERY pass.
    expect(failureCountsOver0(ROW!, JSON.stringify({ ok: true, data: { ...ZERO, skipped: false } }))).toEqual({ "data.skipped": "unreadable" });
  });

  it("the row's counters are exactly the report's two failure fields, and neither `disabled`, `windowsOpen` nor `deferred` is one", () => {
    expect(ROW!.failureCounts).toEqual(["data.failed", "data.skipped"]);
    for (const informational of ["disabled", "windowsOpen", "deferred"]) {
      expect(ROW!.failureCounts, informational).not.toContain(`data.${informational}`);
    }
  });
});

describe("POST /api/cron/external-play-premint: the pass's wall-clock budget", () => {
  // posthog-node's default `requestTimeout` (posthog-node 5.40.0, `requestTimeout ?? 10000`): a club's flag ask can hang that long.
  // It exports no constant, so it is typed here from the library; the vendor's own is the adapter's exported REALTIMEKIT_TIMEOUT_MS.
  const FLAG_ASK_TIMEOUT_MS = 10_000;

  it("stops below the Worker's per-job timeout with room for the ONE slowest request already in flight (arithmetic on the constants; the behaviour is external-play-premint.test.ts)", async () => {
    const { PREMINT_PASS_BUDGET_MS } = await vi.importActual<typeof import("@/server/usecases/external-play/premint")>("@/server/usecases/external-play/premint");
    const { REALTIMEKIT_TIMEOUT_MS } = await vi.importActual<typeof import("@/server/external-play/video/realtimekit")>("@/server/external-play/video/realtimekit");
    expect(PREMINT_PASS_BUDGET_MS).toBeGreaterThan(0);
    expect(PREMINT_PASS_BUDGET_MS).toBeLessThan(JOB_TIMEOUT_MS);
    // The pass starts no request and no row (so no flag ask) once the budget is spent (premintBudget for vendor requests, the row
    // loop's own check for flag asks), so what can run past it is the request already in flight: a vendor request OR a flag ask,
    // never both, since the row that follows an ask is refused by the same spent budget. This pins that sum only. It does NOT
    // bound the candidate scan before the loop, the lock transaction, or the work after a request returns.
    const inFlight = Math.max(REALTIMEKIT_TIMEOUT_MS, FLAG_ASK_TIMEOUT_MS);
    expect(inFlight, "premise: the slowest in-flight request is read from both constants").toBeGreaterThan(0);
    expect(PREMINT_PASS_BUDGET_MS + inFlight, "budget plus the one slowest in-flight request").toBeLessThan(JOB_TIMEOUT_MS);
  });
});
