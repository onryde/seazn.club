import { describe, expect, it, vi } from "vitest";
import { RUN_DEADLINE_MS, runDue, type Env, type RunDeps } from "../src/run";
import { JOBS, TRIGGER_CRON, type Job } from "../src/schedule";

const MONDAY_0817 = new Date("2026-09-28T08:17:00Z");
const TUESDAY_1417 = new Date("2026-09-29T14:17:00Z");
const MONDAY_0805 = new Date("2026-09-28T08:05:00Z");
const FAST = "*/5 * * * *";
const TICK: Job = { id: "stream-tick", path: "/api/cron/stream-tick", trigger: FAST, due: { kind: "every" }, retry: false, manual: true };
const WITH_TICK: readonly Job[] = [...JOBS, TICK];
// A healthy body for every route: the R3 counters read 0, the others ignore it.
const HEALTHY = JSON.stringify({ ok: true, data: { failed: 0, alerted: 0, orphanGroups: { failed: 0 }, addonPrices: { mismatched: 0 } } });
const env = (over: Partial<Env> = {}): Env => ({
  ENV_NAME: "prod",
  BASE_URL: "https://seazn.club",
  ACTIVE: "true",
  CRON_SECRET: "s",
  SENTRY_DSN: "https://k@o1.ingest.sentry.io/9",
  ...over,
});
const isSentry = (u: string) => new URL(u).host.endsWith("sentry.io");

function harness(
  route: (url: string) => Response | Error = () => new Response(HEALTHY),
  sentryReply: () => Response | Error = () => new Response("{}", { status: 200 }),
) {
  const lines: Record<string, unknown>[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  let clock = 0;
  let n = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (isSentry(url)) {
      const s = sentryReply();
      if (s instanceof Error) throw s;
      return s;
    }
    const r = route(url);
    if (r instanceof Error) throw r;
    return r;
  });
  const deps: RunDeps = {
    fetch: fetch as never,
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    log: (l) => void lines.push(l),
    uuid: () => `uuid-${++n}`,
  };
  return {
    deps,
    lines,
    calls,
    posts: () => calls.filter((c) => !isSentry(c.url)).map((c) => c.url),
    sentry: () => calls.filter((c) => isSentry(c.url)),
    events: () =>
      calls
        .filter((c) => isSentry(c.url))
        .map((c) => JSON.parse(String(c.init!.body).split("\n")[2]!) as { level: string; environment: string; tags: Record<string, string> }),
    advance: (ms: number) => void (clock += ms),
  };
}

describe("runDue: jobs and the run log", () => {
  it("runs the due jobs in table order: one result and one job line each, then one run line", async () => {
    const h = harness();
    const results = await runDue(TUESDAY_1417, TRIGGER_CRON, env(), h.deps);
    expect(results.map((r) => [r.job, r.status])).toEqual([
      ["registrations", "ok"],
      ["billing-events", "ok"],
      ["funnel-remind", "ok"],
    ]);
    expect(h.posts()).toEqual([
      "https://seazn.club/api/cron/registrations",
      "https://seazn.club/api/cron/billing-events",
      "https://seazn.club/api/funnel/remind",
    ]);
    expect(h.lines.filter((l) => l.event === "job")).toHaveLength(3);
    expect(h.lines.at(-1)).toMatchObject({ event: "run", run: "scheduled", cron: TRIGGER_CRON, jobs: 3, notOk: [], sentry: "on" });
    expect(h.sentry()).toEqual([]); // nothing failed, so nothing to report
  });

  it("one failing job does not stop the rest, and raises ONE error event tagged with that job", async () => {
    const h = harness((u) => (u.endsWith("/api/cron/registrations") ? new Response("no", { status: 401 }) : new Response(HEALTHY)));
    const results = await runDue(TUESDAY_1417, TRIGGER_CRON, env(), h.deps);
    expect(results.map((r) => r.status)).toEqual(["error", "ok", "ok"]);
    expect(h.lines.find((l) => l.job === "registrations")).toMatchObject({ event: "job", status: "error", httpStatus: 401, env: "prod" });
    expect(h.events()).toEqual([
      expect.objectContaining({ level: "error", environment: "prod", tags: expect.objectContaining({ job: "registrations", reason: "http", run: "scheduled" }) }),
    ]);
  });

  it("R3: a 200 whose failure counter reads > 0 is degraded and raises one event; zeros raise none", async () => {
    const bad = harness((u) =>
      new Response(u.endsWith("/billing-events") ? JSON.stringify({ ok: true, data: { replayed: 0, failed: 0, alerted: 2 } }) : HEALTHY),
    );
    const results = await runDue(TUESDAY_1417, TRIGGER_CRON, env(), bad.deps);
    expect(results.find((r) => r.job === "billing-events")).toMatchObject({ status: "degraded", httpStatus: 200, degraded: { "data.alerted": 2 } });
    expect(bad.lines.find((l) => l.job === "billing-events")).toMatchObject({ event: "job", status: "degraded" });
    expect(bad.events()).toEqual([expect.objectContaining({ tags: expect.objectContaining({ job: "billing-events", reason: "counts" }) })]);
    const good = harness();
    await runDue(TUESDAY_1417, TRIGGER_CRON, env(), good.deps);
    expect(good.events()).toEqual([]);
  });

  // I-3: Sentry error events are the ONLY alert path while cron monitoring is deferred, so a
  // rejected event must be visible in the log rather than reading as `sentry:"on"` and silence.
  it.each([
    ["answers 403 (a rotated DSN key or a deleted project)", () => new Response("denied", { status: 403 })],
    ["throws (unreachable)", () => new TypeError("sentry unreachable")],
  ])("a Sentry event that is not delivered (%s) is logged, and never stops the next job", async (_why, reply) => {
    const h = harness(() => new Response("down", { status: 500 }), reply);
    const results = await runDue(TUESDAY_1417, TRIGGER_CRON, env(), h.deps);
    expect(results.map((r) => [r.job, r.status, r.sentryDelivered])).toEqual([
      ["registrations", "error", false],
      ["billing-events", "error", false],
      ["funnel-remind", "error", false],
    ]);
    expect(h.posts(), "every job still ran").toHaveLength(3);
    expect(h.lines.filter((l) => l.event === "job").map((l) => l.sentryDelivered)).toEqual([false, false, false]);
    expect(h.lines.at(-1)).toMatchObject({ event: "run", sentry: "on", sentryUndelivered: ["registrations", "billing-events", "funnel-remind"] });
  });

  it("an accepted event reads sentryDelivered:true, and a job that is ok attempts none (the field is absent)", async () => {
    const h = harness((u) => (u.endsWith("/api/cron/registrations") ? new Response("no", { status: 401 }) : new Response(HEALTHY)));
    const results = await runDue(TUESDAY_1417, TRIGGER_CRON, env(), h.deps);
    expect(results.map((r) => r.sentryDelivered)).toEqual([true, undefined, undefined]);
    expect(h.lines.at(-1)).toMatchObject({ event: "run", sentryUndelivered: [] });
  });

  it("past the run deadline: the remaining jobs report error/deadline and raise events, never silence", async () => {
    const h = harness((u) => {
      if (u.endsWith("/api/cron/registrations")) h.advance(RUN_DEADLINE_MS);
      return new Response(HEALTHY);
    });
    const results = await runDue(TUESDAY_1417, TRIGGER_CRON, env(), h.deps);
    expect(results.map((r) => [r.job, r.status, r.reason])).toEqual([
      ["registrations", "ok", undefined],
      ["billing-events", "error", "deadline"],
      ["funnel-remind", "error", "deadline"],
    ]);
    expect(h.events().map((e) => e.tags.job)).toEqual(["billing-events", "funnel-remind"]);
  });

  it.each([
    [undefined, "off"],
    ["not a dsn", "misconfigured"],
  ])("SENTRY_DSN %j: jobs still run and the run line says sentry=%s", async (dsn, state) => {
    const h = harness(() => new Response("down", { status: 500 }));
    const results = await runDue(TUESDAY_1417, TRIGGER_CRON, env({ SENTRY_DSN: dsn }), h.deps);
    expect(results.map((r) => r.status)).toEqual(["error", "error", "error"]);
    expect(h.sentry()).toEqual([]);
    expect(h.lines.at(-1)).toMatchObject({ event: "run", notOk: ["registrations", "billing-events", "funnel-remind"], sentry: state });
  });
});

describe("runDue: outbound request hygiene (M-3, M-6)", () => {
  const SECRET = "cron-secret-Zq81-distinctive";
  const KEY = "dsnkeyQq7731distinctive";

  it("every fetch the Worker makes (job, Sentry, probe) refuses redirects and carries a timeout of 60 s / 5 s / 10 s", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const h = harness(() => new Response("down", { status: 500 }));
      await runDue(TUESDAY_1417, TRIGGER_CRON, env(), h.deps); // 3 failing jobs, 3 Sentry events
      await runDue(TUESDAY_1417, TRIGGER_CRON, env({ ACTIVE: "false" }), h.deps); // the probe
      expect(h.calls, "calls made: 3 jobs + 3 events + 1 probe").toHaveLength(7);
      expect(h.calls.filter((c) => c.init?.redirect !== "manual")).toEqual([]);
      expect([...new Set(timeout.mock.calls.map((c) => c[0]))].sort((a, b) => a - b)).toEqual([5_000, 10_000, 60_000]);
    } finally {
      timeout.mockRestore();
    }
  });

  it("no log line and no Sentry envelope carries CRON_SECRET or the DSN key", async () => {
    const h = harness(() => new Response(JSON.stringify({ echoed: "route body" }), { status: 500 }));
    await runDue(TUESDAY_1417, TRIGGER_CRON, env({ CRON_SECRET: SECRET, SENTRY_DSN: `https://${KEY}@o1.ingest.sentry.io/9` }), h.deps);
    await runDue(TUESDAY_1417, TRIGGER_CRON, env({ ACTIVE: "false", CRON_SECRET: SECRET, SENTRY_DSN: `https://${KEY}@o1.ingest.sentry.io/9` }), h.deps);
    // Positive pairs: the secret really is sent (as a header) and the key really is used (in the URL),
    // so the needles are the right ones and the absence below is not vacuous.
    expect(h.calls.some((c) => (c.init?.headers as Record<string, string> | undefined)?.["x-cron-secret"] === SECRET)).toBe(true);
    expect(h.sentry().length, "events sent").toBeGreaterThan(0);
    expect(h.sentry().every((c) => c.url.includes(KEY))).toBe(true);
    expect(h.lines.length, "log lines written").toBeGreaterThan(0);
    const logged = JSON.stringify(h.lines);
    const envelopes = h.sentry().map((c) => String(c.init!.body)).join("\n");
    for (const needle of [SECRET, KEY]) {
      expect(logged, `log lines must not contain ${needle}`).not.toContain(needle);
      expect(envelopes, `envelopes must not contain ${needle}`).not.toContain(needle);
    }
  });
});

describe("runDue: the R4 trigger seam", () => {
  it("refuses an unknown trigger by name: no job, no probe, no Sentry", async () => {
    for (const active of ["true", "false"]) {
      const h = harness();
      expect(await runDue(TUESDAY_1417, FAST, env({ ACTIVE: active }), h.deps)).toEqual([]);
      expect(h.calls).toEqual([]);
      expect(h.lines).toEqual([expect.objectContaining({ event: "unknown-trigger", cron: FAST, env: "prod" })]);
    }
  });

  it("a second trigger runs only its own rows: never news-digest or an hourly row, even at Monday 08:05", async () => {
    const h = harness();
    const results = await runDue(MONDAY_0805, FAST, env(), h.deps, WITH_TICK);
    expect(results.map((r) => r.job)).toEqual(["stream-tick"]);
    expect(h.posts()).toEqual(["https://seazn.club/api/cron/stream-tick"]);
    expect(h.lines.at(-1)).toMatchObject({ event: "run", cron: FAST, jobs: 1 });
  });

  it("while inactive, a non-hourly trigger does nothing at all (the probe is hourly only)", async () => {
    const h = harness();
    expect(await runDue(MONDAY_0805, FAST, env({ ACTIVE: "false" }), h.deps, WITH_TICK)).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.lines).toEqual([]);
  });
});

describe("runDue: the ACTIVE gate", () => {
  it("while inactive: the hourly firing probes /api/health only, with the cron User-Agent", async () => {
    const h = harness();
    const results = await runDue(MONDAY_0817, TRIGGER_CRON, env({ ACTIVE: "false" }), h.deps);
    expect(results).toEqual([]);
    expect(h.calls.map((c) => c.url)).toEqual(["https://seazn.club/api/health"]);
    expect((h.calls[0]!.init!.headers as Record<string, string>)["user-agent"]).toBe("seazn-cron/1 (prod)");
    expect(h.lines).toEqual([expect.objectContaining({ event: "probe", env: "prod", httpStatus: 200 })]);
  });
});

describe("R5: cron monitoring is deferred, so the Worker never calls a Sentry check-in endpoint", () => {
  it("over one full week of hourly firings with every job failing: events only, never a check-in", async () => {
    const h = harness(() => new Response("down", { status: 500 }));
    const start = Date.parse("2026-09-28T00:17:00Z"); // Monday
    let firings = 0;
    for (let i = 0; i < 168; i++, firings++) await runDue(new Date(start + i * 3_600_000), TRIGGER_CRON, env(), h.deps);
    expect(firings, "firings checked").toBe(168);
    // Spec §4 + R1: 3 every-firing rows × 168 + 4 daily rows × 7 + the weekly digest × 1. A 500 is never retried.
    expect(h.events(), "one event per failed job").toHaveLength(3 * 168 + 4 * 7 + 1);
    const paths = h.sentry().map((c) => new URL(c.url).pathname);
    expect(paths.filter((p) => !/^\/api\/9\/envelope\/$/.test(p)), "non-envelope Sentry calls").toEqual([]);
    expect(h.sentry().filter((c) => /\/cron\/|check_in/.test(c.url)), "check-in calls").toEqual([]);
  });
});
