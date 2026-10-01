import { describe, expect, it, vi } from "vitest";
import { callJob, failureCountsOver0, userAgent, type CallDeps, type CallTarget } from "../src/call";
import { JOBS, type Job } from "../src/schedule";

const job = (id: string): Job => JOBS.find((j) => j.id === id)!;
const res = (status: number, body = "{}") => new Response(body, { status });
const billing = (data: unknown) => res(200, JSON.stringify({ ok: true, data }));
const timeoutErr = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });
/** A response that ARRIVED but whose body then fails to read (m1). */
const brokenBody = (status: number) =>
  ({ ok: status >= 200 && status < 300, status, text: () => Promise.reject(new TypeError("body stream broke")) }) as unknown as Response;
const T: CallTarget = { baseUrl: "https://x", secret: "s", userAgent: userAgent("stg") };

function deps(responses: Array<Response | Error>): CallDeps & { fetch: ReturnType<typeof vi.fn>; sleeps: number[] } {
  const sleeps: number[] = [];
  const queue = [...responses];
  const fetch = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra fetch");
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch, sleep: async (ms: number) => void sleeps.push(ms), now: () => 0, sleeps } as never;
}

describe("callJob", () => {
  it("POSTs the route with the cron secret and a User-Agent, and reports ok", async () => {
    const d = deps([res(200, '{"swept":3}')]);
    const out = await callJob(job("registrations"), { ...T, baseUrl: "https://stg.seazn.club", secret: "s3cret" }, d, Infinity);
    expect(out).toMatchObject({ status: "ok", httpStatus: 200, attempts: 1, body: '{"swept":3}' });
    const [url, init] = d.fetch.mock.calls[0]!;
    expect(url).toBe("https://stg.seazn.club/api/cron/registrations");
    expect(init.method).toBe("POST");
    expect(init.headers["x-cron-secret"]).toBe("s3cret");
    // m2: the zone's Browser Integrity Check challenges a request with no UA.
    expect(init.headers["user-agent"]).toBe("seazn-cron/1 (stg)");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([502, 503, 504])("retries a %i twice with 2s then 8s backoff", async (code) => {
    const d = deps([res(code), res(code), res(200)]);
    const out = await callJob(job("registrations"), T, d, Infinity);
    expect(out).toMatchObject({ status: "ok", attempts: 3 });
    // Literal on purpose (spec §5): the title's 2 s then 8 s, not whatever BACKOFF_MS currently holds.
    expect(d.sleeps).toEqual([2_000, 8_000]);
  });

  it("gives up after 3 attempts and reports the last status", async () => {
    const d = deps([res(503), res(503), res(503)]);
    expect(await callJob(job("registrations"), T, d, Infinity)).toMatchObject({
      status: "error", httpStatus: 503, attempts: 3, reason: "http",
    });
  });

  it.each([400, 401, 403, 404, 500])("never retries a %i", async (code) => {
    const d = deps([res(code)]);
    expect(await callJob(job("registrations"), T, d, Infinity)).toMatchObject({
      status: "error", httpStatus: code, attempts: 1, reason: "http",
    });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds each attempt at 60 s (the plan's per-job HTTP timeout, spec §13: not today's 60/120/300 mix)", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await callJob(job("registrations"), T, deps([res(200)]), Infinity);
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(60_000);
    } finally {
      timeout.mockRestore();
    }
  });

  // M-3: fetch follows redirects by default, replaying the POST as a GET and forwarding the secret.
  it("never follows a redirect: a 302 is a non-ok response, reported and not retried", async () => {
    const d = deps([new Response(null, { status: 302, headers: { location: "https://elsewhere.example/ok" } })]);
    expect(await callJob(job("registrations"), T, d, Infinity)).toMatchObject({
      status: "error", httpStatus: 302, attempts: 1, reason: "http",
    });
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(d.fetch.mock.calls[0]![1].redirect).toBe("manual");
  });

  it("a thrown AbortError is a timeout too: reported once, never re-sent", async () => {
    const d = deps([Object.assign(new Error("aborted"), { name: "AbortError" })]);
    expect(await callJob(job("registrations"), T, d, Infinity)).toMatchObject({ status: "error", attempts: 1, reason: "timeout" });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("never retries a timeout: the server may already be running the job", async () => {
    const d = deps([timeoutErr()]);
    expect(await callJob(job("registrations"), T, d, Infinity)).toMatchObject({
      status: "error", httpStatus: null, attempts: 1, reason: "timeout",
    });
  });

  it("retries a network error for an idempotent job", async () => {
    const d = deps([new TypeError("connection reset"), res(200)]);
    expect(await callJob(job("funnel-remind"), T, d, Infinity)).toMatchObject({ status: "ok", attempts: 2 });
  });

  it.each(["news-digest", "relay-sweep"])("never retries %s, not even on a 503 or a network error", async (id) => {
    for (const first of [res(503), new TypeError("reset")]) {
      const d = deps([first]);
      expect(await callJob(job(id), T, d, Infinity)).toMatchObject({ status: "error", attempts: 1 });
      expect(d.fetch).toHaveBeenCalledTimes(1);
    }
  });

  // M-2: the deadline is checked BETWEEN attempts too, and BEFORE the backoff sleep.
  it("a deadline reached after attempt 1 stops the retry without sleeping first", async () => {
    let t = 0;
    const d = { ...deps([res(503)]), now: () => t };
    d.fetch.mockImplementationOnce(async () => {
      t = 1_000;
      return res(503);
    });
    expect(await callJob(job("registrations"), T, d, 1_000)).toMatchObject({
      status: "error", httpStatus: 503, attempts: 1, reason: "deadline",
    });
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(d.sleeps, "no backoff wait for an attempt it will refuse").toEqual([]);
  });

  it("a deadline that the backoff sleep itself crosses refuses the next attempt", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const d = { ...deps([res(503), res(200)]), now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)) };
    expect(await callJob(job("registrations"), T, d, 1_500)).toMatchObject({ status: "error", httpStatus: 503, attempts: 1, reason: "deadline" });
    expect(sleeps).toEqual([2_000]);
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not start an attempt past the deadline", async () => {
    const d = { ...deps([res(503)]), now: () => 1_000 };
    expect(await callJob(job("registrations"), T, d, 1_000)).toMatchObject({
      status: "error", attempts: 0, reason: "deadline",
    });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  // m1: once a response has arrived, its STATUS decides. A body that fails to
  // read is reported, never retried as "network" (spec §5: only before a response).
  it("a 200 whose body read fails is still ok, and is not re-sent", async () => {
    const d = deps([brokenBody(200)]);
    expect(await callJob(job("registrations"), T, d, Infinity)).toMatchObject({ status: "ok", httpStatus: 200, attempts: 1 });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("a 503 whose body read fails is retried because of its status", async () => {
    const d = deps([brokenBody(503), res(200)]);
    expect(await callJob(job("registrations"), T, d, Infinity)).toMatchObject({ status: "ok", attempts: 2 });
  });
});

describe("R3: failure counters inside a 200", () => {
  it("a counter above 0 makes the run degraded, never ok, and it is not re-sent", async () => {
    const d = deps([billing({ replayed: 2, failed: 1, alerted: 0 })]);
    expect(await callJob(job("billing-events"), T, d, Infinity)).toMatchObject({
      status: "degraded", httpStatus: 200, attempts: 1, reason: "counts", degraded: { "data.failed": 1 },
    });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("every counter at 0 is ok", async () => {
    const d = deps([billing({ replayed: 4, failed: 0, alerted: 0 })]);
    expect(await callJob(job("billing-events"), T, d, Infinity)).toMatchObject({ status: "ok" });
  });

  it("reads nested counters, from the FULL body rather than the 500-char log excerpt", async () => {
    const mismatches = Array.from({ length: 40 }, (_, i) => ({ orgId: `org-${i}`, priceId: `price_${i}` }));
    // addonPrices has sweepStaleOrgAddonPrices' real shape: `mismatched` counts the stale riders and
    // `alerted` counts staff emails, which is 0 whenever STAFF_ALERT_EMAIL is unset.
    const addonPrices = { total: 40, checked: 40, mismatched: 40, unresolved: 0, vanished: 0, unreadable: 0, alerted: 0, mismatches };
    const data = { checked: 3, corrected: 0, failed: 0, orphanOrgs: 0, addonPrices, orphanGroups: { failed: 2 } };
    expect(JSON.stringify({ ok: true, data }).length, "this case's premise").toBeGreaterThan(500);
    const out = await callJob(job("billing-quantity"), T, deps([billing(data)]), Infinity);
    expect(out).toMatchObject({ status: "degraded" });
    expect(out.degraded).toEqual({ "data.orphanGroups.failed": 2, "data.addonPrices.mismatched": 40 });
    expect(out.body).toHaveLength(500);
  });

  // I-4 (owner ruling): the addon price check alerts on `mismatched`, never on `alerted`.
  it("a stale rider price is degraded even though no staff alert was sent (alerted 0: STAFF_ALERT_EMAIL unset)", async () => {
    const addonPrices = { total: 5, checked: 5, mismatched: 3, unresolved: 0, vanished: 0, unreadable: 0, alerted: 0, mismatches: [] };
    const body = { checked: 2, corrected: 0, failed: 0, orphanOrgs: 0, addonPrices, orphanGroups: { checked: 0, retired: 0, stillLive: 0, failed: 0 } };
    expect(await callJob(job("billing-quantity"), T, deps([billing(body)]), Infinity)).toMatchObject({
      status: "degraded", degraded: { "data.addonPrices.mismatched": 3 },
    });
  });

  it("a healthy price sweep is ok, and `alerted` alone is no longer a failure counter", async () => {
    const addonPrices = { total: 5, checked: 5, mismatched: 0, unresolved: 0, vanished: 0, unreadable: 0, alerted: 4, mismatches: [] };
    const body = { checked: 2, corrected: 0, failed: 0, orphanOrgs: 0, addonPrices, orphanGroups: { checked: 0, retired: 0, stillLive: 0, failed: 0 } };
    expect(await callJob(job("billing-quantity"), T, deps([billing(body)]), Infinity)).toMatchObject({ status: "ok" });
  });

  it("a counter that cannot be read is degraded ('unreadable'), so a renamed field never reads as healthy", async () => {
    for (const r of [res(200, "<html>challenge</html>"), billing({ wallets: 3, granted: 3 }), brokenBody(200)]) {
      expect(await callJob(job("billing-grant"), T, deps([r]), Infinity)).toMatchObject({
        status: "degraded", degraded: { "data.failed": "unreadable" },
      });
    }
  });

  it("a job with no counters ignores its body", async () => {
    expect(await callJob(job("registrations"), T, deps([res(200, "<html>whatever</html>")]), Infinity)).toMatchObject({ status: "ok" });
  });

  it("a counter that is not a finite number is unreadable (1e999 parses to Infinity)", () => {
    expect(failureCountsOver0(job("billing-grant"), '{"ok":true,"data":{"failed":1e999}}')).toEqual({ "data.failed": "unreadable" });
    expect(failureCountsOver0(job("billing-grant"), '{"ok":true,"data":{"failed":"0"}}')).toEqual({ "data.failed": "unreadable" });
  });

  it("failureCountsOver0 reports only the offenders", () => {
    expect(failureCountsOver0(job("billing-events"), JSON.stringify({ ok: true, data: { failed: 0, alerted: 3 } }))).toEqual({
      "data.alerted": 3,
    });
    expect(failureCountsOver0(job("registrations"), "<html>")).toEqual({});
  });
});
