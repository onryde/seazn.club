// POST /api/cron/email-outbox: one tick of the email outbox's retry worker. Same x-cron-secret / CRON_SECRET contract as
// every cron route here, in the same order (503 when the secret is unset BEFORE 401 on a mismatch, so an unset secret can
// never read as "no auth required"). next/headers is mocked so the route runs without a request scope, and the worker is
// mocked so this file stays DB-free (the tick itself is server/email-outbox/__tests__/worker.test.ts).
//
// The seam (R3): the cron Worker reads this route's 200 body through ITS OWN `failureCountsOver0` and the REAL
// `email-outbox` row, both imported from apps/cron-worker - never a copy, which would be a fixture on both ends.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIN_SEND_INTERVAL_MS, SEND_TIMEOUT_MS, TICK_BUDGET_MS } from "@/server/email-outbox/constants";

// apps/cron-worker is outside the Fly image's build context (.dockerignore), and ci.yml type-checks apps/web INSIDE that
// image, where a static import of it is TS2307. The specifiers are computed so tsc never resolves them; vitest, which runs
// outside the image, still loads the REAL modules, so the seam stays real and only its types are restated here.
type Job = { id: string; path: string; failureCounts?: readonly string[] };
const cronSrc = (file: string) => new URL(`../../../../../../../cron-worker/src/${file}`, import.meta.url).href;
const { JOB_TIMEOUT_MS, failureCountsOver0 } = (await import(/* @vite-ignore */ cronSrc("call.ts"))) as {
  JOB_TIMEOUT_MS: number;
  failureCountsOver0: (job: Job, bodyText: string | null) => Record<string, number | "unreadable">;
};
const { JOBS, MINUTE_CRON } = (await import(/* @vite-ignore */ cronSrc("schedule.ts"))) as { JOBS: readonly Job[]; MINUTE_CRON: string };
const ROW = JOBS.find((j) => j.id === "email-outbox");

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

const tickMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/worker", () => ({ runOutboxTick: tickMock }));

import { POST } from "../route";

const ZERO = { claimed: 0, sent: 0, retried: 0, dead: 0, suppressed: 0, expired: 0, failed: 0, deferred: 0, purged: 0 };

afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  tickMock.mockReset();
});

const authorised = () => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
};

describe("POST /api/cron/email-outbox: the auth contract", () => {
  it("503 when CRON_SECRET is not configured - even with a secret header sent, and the tick never runs", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST()).status).toBe(503);
    hdrs.store = new Headers({ "x-cron-secret": "anything" });
    expect((await POST()).status, "503 comes BEFORE 401: an unset secret is never 'no auth'").toBe(503);
    expect(tickMock).not.toHaveBeenCalled();
  });

  it("401 with a missing or wrong x-cron-secret, never running the tick", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await POST()).status, "missing header").toBe(401);
    hdrs.store = new Headers({ "x-cron-secret": "wrong" });
    expect((await POST()).status, "wrong header").toBe(401);
    hdrs.store = new Headers({ "x-cron-secret": "s3cret2" });
    expect((await POST()).status, "near miss").toBe(401);
    expect(tickMock).not.toHaveBeenCalled();
  });

  it("200 with the report under data on the right secret, and ONE tick with the production defaults (no scope, no injected clock)", async () => {
    authorised();
    const report = { ...ZERO, claimed: 3, sent: 2, retried: 1, deferred: 4 };
    tickMock.mockResolvedValue(report);
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: report });
    expect(tickMock).toHaveBeenCalledTimes(1);
    // The test-only seams (onlyIds, an injected sleep or clock) are never reachable from the route.
    expect(tickMock).toHaveBeenCalledWith();
  });

  it("a tick that throws is a 5xx, not a 200 that reads healthy", async () => {
    authorised();
    tickMock.mockRejectedValue(new Error("database down"));
    const res = await POST();
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe("POST /api/cron/email-outbox: the seam with the cron Worker (R3)", () => {
  it("PREMISE: the Worker's row for this route is the one the cases read - its path and its one failure counter", () => {
    expect(ROW, "the email-outbox row").toBeDefined();
    expect(ROW!.path).toBe("/api/cron/email-outbox");
    expect(ROW!.failureCounts).toEqual(["data.failed"]);
  });

  it("the Worker reads the REAL row's counter off the route's real body: a clean or deferred tick is healthy; a failed row is degraded; a missing counter is unreadable", async () => {
    authorised();
    const cases: [string, object, Record<string, number | "unreadable">][] = [
      ["an idle tick", ZERO, {}],
      // `deferred` is NOT a failure: the next firing reaches those rows.
      ["a tick that ran out of batch or budget", { ...ZERO, claimed: 20, sent: 20, deferred: 7 }, {}],
      ["a tick that retried and ended rows", { ...ZERO, claimed: 4, retried: 2, dead: 1, suppressed: 1 }, {}],
      ["a tick with one failed row", { ...ZERO, claimed: 2, sent: 1, failed: 1 }, { "data.failed": 1 }],
      // A tick that could not run at all (the database role cannot write the outbox) reports failed 1 too.
      ["a skipped tick", { ...ZERO, failed: 1 }, { "data.failed": 1 }],
    ];
    let checked = 0;
    for (const [name, body, want] of cases) {
      tickMock.mockResolvedValueOnce(body);
      const text = await (await POST()).text();
      expect(failureCountsOver0(ROW!, text), name).toEqual(want);
      checked++;
    }
    expect(checked).toBe(cases.length);
    // The pair: a body that lost its `failed` counter reads unreadable (degraded), never clean.
    const noFailed = Object.fromEntries(Object.entries(ZERO).filter(([k]) => k !== "failed"));
    expect(Object.keys(noFailed).length, "the other seven counters").toBe(Object.keys(ZERO).length - 1);
    tickMock.mockResolvedValueOnce(noFailed);
    expect(failureCountsOver0(ROW!, await (await POST()).text())).toEqual({ "data.failed": "unreadable" });
  });

  it("the worst-case tick - the budget, one more pacing wait and one more request to its timeout - ends inside the Worker's per-job timeout, and the budget inside one minute", () => {
    expect(TICK_BUDGET_MS + MIN_SEND_INTERVAL_MS + SEND_TIMEOUT_MS).toBeLessThan(JOB_TIMEOUT_MS);
    // Prod runs the tick on the minute trigger: a tick that fits a minute never overlaps the next firing by design
    // (an overlap is still safe: skip locked and the lease).
    expect(MINUTE_CRON).toBe("* * * * *");
    expect(TICK_BUDGET_MS).toBeLessThan(60_000);
  });
});
