import { describe, expect, it, vi } from "vitest";
import { handleManual } from "../src/manual";
import { RUN_DEADLINE_MS, runDue, type Env, type RunDeps } from "../src/run";
import { FAST_TRIGGER, FIVE_MINUTES, JOBS, TRIGGER_CRON } from "../src/schedule";

const MONDAY_0817 = new Date("2026-09-28T08:17:00Z");
const TUESDAY_1417 = new Date("2026-09-29T14:17:00Z");
const MONDAY_0805 = new Date("2026-09-28T08:05:00Z");
/** The fast trigger of each env (owner ruling 2026-10-20: prod's is the minute trigger that replaced the 5-minute one;
 *  stg keeps the 5-minute one), read from the schedule's own constants: the literal each env uses is pinned in
 *  schedule.test.ts. */
const FAST_PROD = FAST_TRIGGER.prod;
const FAST_STG = FAST_TRIGGER.stg;
/** The stg Worker: same table, its own name and origin. */
const stgEnv = (over: Partial<Env> = {}): Env => env({ ENV_NAME: "stg", BASE_URL: "https://stg.seazn.club", ...over });
/** The 5-minute rows alone (stream-tick, external-play): the throttle cases below are about THEM, and the outbox row
 *  shares their trigger. */
const FIVE_MINUTE_ROWS = JOBS.filter((j) => j.id === "stream-tick" || j.id === "external-play");
/** A well-formed trigger no row names. */
const UNKNOWN = "*/7 * * * *";
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
      expect(await runDue(TUESDAY_1417, UNKNOWN, env({ ACTIVE: active }), h.deps)).toEqual([]);
      expect(h.calls).toEqual([]);
      expect(h.lines).toEqual([expect.objectContaining({ event: "unknown-trigger", cron: UNKNOWN, env: "prod" })]);
    }
  });

  it("a second trigger runs only its own rows: never news-digest or an hourly row, even at Monday 08:05", async () => {
    for (const [name, trigger, e, origin] of [
      ["prod", FAST_PROD, env(), "https://seazn.club"],
      ["stg", FAST_STG, stgEnv(), "https://stg.seazn.club"],
    ] as const) {
      const h = harness();
      const results = await runDue(MONDAY_0805, trigger, e, h.deps);
      // The fast rows, in table order: stream-tick (capture QR v2 §6.11), the external-play sweep (chess in-page §4) and
      // the email outbox's worker (owner ruling 2026-10-20). Minute 05 is a multiple of FIVE_MINUTES on both envs.
      expect(results.map((r) => r.job), name).toEqual(["stream-tick", "external-play", "email-outbox"]);
      expect(h.posts(), name).toEqual([`${origin}/api/cron/stream-tick`, `${origin}/api/cron/external-play`, `${origin}/api/cron/email-outbox`]);
      expect(h.lines.at(-1), name).toMatchObject({ event: "run", cron: trigger, jobs: 3 });
    }
  });

  it("an env answers only to its own fast trigger: stg's */5 is unknown to prod, and prod's minute trigger to stg", async () => {
    for (const [name, trigger, e] of [
      ["prod", FAST_STG, env()],
      ["stg", FAST_PROD, stgEnv()],
    ] as const) {
      const h = harness();
      expect(await runDue(MONDAY_0805, trigger, e, h.deps), name).toEqual([]);
      expect(h.calls, name).toEqual([]);
      expect(h.lines, name).toEqual([expect.objectContaining({ event: "unknown-trigger", cron: trigger, env: name })]);
    }
  });

  it("prod's minute trigger at a minute that is not a multiple of FIVE_MINUTES runs the outbox ALONE", async () => {
    const h = harness();
    const notFive = new Date(Date.parse("2026-09-28T08:00:00Z") + (FIVE_MINUTES + 1) * 60_000);
    const results = await runDue(notFive, FAST_PROD, env(), h.deps);
    expect(results.map((r) => r.job)).toEqual(["email-outbox"]);
    expect(h.posts()).toEqual(["https://seazn.club/api/cron/email-outbox"]);
  });

  it("one prod hour of minute firings posts the outbox every minute and the 5-minute jobs every FIVE_MINUTES (the Worker's own count, through runDue)", async () => {
    const h = harness();
    const HOUR = Date.parse("2026-09-28T08:00:00Z");
    let firings = 0;
    for (let m = 0; m < 60; m++, firings++) await runDue(new Date(HOUR + m * 60_000), FAST_PROD, env(), h.deps);
    expect(firings).toBe(60);
    const per = (path: string) => h.posts().filter((u) => u.endsWith(path)).length;
    expect(per("/api/cron/email-outbox")).toBe(60);
    expect(per("/api/cron/stream-tick")).toBe(60 / FIVE_MINUTES);
    expect(per("/api/cron/external-play")).toBe(60 / FIVE_MINUTES);
  });

  it("an env name the table does not know is refused by name, before any call (a misnamed ENV_NAME is a loud failure, not a silent no-op)", async () => {
    const h = harness();
    await expect(runDue(MONDAY_0805, FAST_PROD, env({ ENV_NAME: "qa" }), h.deps)).rejects.toThrow(/triggerFor: no trigger for env "qa"/);
    expect(h.posts()).toEqual([]);
  });

  describe("M3 (Task 4 review): an unknown ENV_NAME says so before it throws", () => {
    const SECRET = "cron-secret-Env8-distinctive";
    const KEY = "dsnkeyEnv8distinctive";
    const bad = (over: Partial<Env> = {}): Env => env({ ENV_NAME: "qa", CRON_SECRET: SECRET, SENTRY_DSN: `https://${KEY}@o1.ingest.sentry.io/9`, ...over });
    const refused = (h: ReturnType<typeof harness>, cron: string, e: Env, at = MONDAY_0805) =>
      runDue(at, cron, e, h.deps).then(
        () => {
          throw new Error("runDue resolved for an unknown env");
        },
        (err: unknown) => err as Error,
      );

    it("writes ONE error line naming the env, the trigger and the slot BEFORE the rejection, and calls no job", async () => {
      const h = harness();
      const err = await refused(h, FAST_PROD, bad());
      expect(err.message).toMatch(/triggerFor: no trigger for env "qa"/);
      expect(h.lines).toEqual([
        expect.objectContaining({ event: "unknown-env", level: "error", env: "qa", cron: FAST_PROD, scheduledTime: MONDAY_0805.toISOString() }),
      ]);
      expect(String(h.lines[0]!.error)).toContain('no trigger for env "qa"');
      expect(h.posts(), "no job was called").toEqual([]);
    });

    it("raises one Sentry event on the HOURLY trigger (the cron-worker job, the bad env named) and none on a faster trigger: one an hour, not sixty", async () => {
      const hourly = harness();
      await refused(hourly, TRIGGER_CRON, bad(), MONDAY_0817);
      expect(hourly.events()).toHaveLength(1);
      expect(hourly.events()[0]).toMatchObject({ level: "error", environment: "qa", tags: { job: "cron-worker", reason: "degraded", run: "scheduled" } });
      expect(String(hourly.sentry()[0]!.init!.body)).toContain("unknown-env");

      // The same misconfiguration on every minute of an hour: only the hourly trigger's firing pages.
      const fast = harness();
      for (let minute = 0; minute < 60; minute++) await refused(fast, FAST_PROD, bad(), new Date(Date.UTC(2026, 8, 28, 8, minute)));
      expect(fast.lines.filter((l) => l.event === "unknown-env"), "an error line every firing").toHaveLength(60);
      expect(fast.sentry(), "and no event from a faster trigger").toEqual([]);
    });

    it("the Sentry event is DELIVERED (its response awaited) before the rejection, not left in flight for the runtime to drop", async () => {
      const h = harness();
      let delivered = false;
      const slow = {
        ...h.deps,
        fetch: (async (url: string, init?: RequestInit) => {
          const res = await h.deps.fetch(url as never, init);
          if (isSentry(url)) {
            await new Promise((r) => setTimeout(r, 5)); // the response arrives a moment later
            delivered = true;
          }
          return res;
        }) as typeof fetch,
      };
      await runDue(MONDAY_0817, TRIGGER_CRON, bad(), slow).catch(() => undefined);
      expect(h.sentry(), "an event was sent").toHaveLength(1);
      expect(delivered, "and it finished before runDue rejected").toBe(true);
    });

    it("with no DSN there is a log line and no Sentry call; with a Sentry that answers 500 the ORIGINAL error still surfaces", async () => {
      const none = harness();
      const e1 = await refused(none, TRIGGER_CRON, bad({ SENTRY_DSN: undefined }), MONDAY_0817);
      expect(e1.message).toMatch(/no trigger for env "qa"/);
      expect(none.sentry()).toEqual([]);
      expect(none.lines).toHaveLength(1);

      const down = harness(undefined, () => new Response("down", { status: 500 }));
      const e2 = await refused(down, TRIGGER_CRON, bad(), MONDAY_0817);
      expect(e2.message, "not a Sentry error").toMatch(/no trigger for env "qa"/);
      expect(down.sentry(), "it did try").toHaveLength(1);
    });

    it("neither the log line nor the Sentry envelope carries CRON_SECRET or the DSN key", async () => {
      const h = harness();
      await refused(h, TRIGGER_CRON, bad(), MONDAY_0817);
      expect(h.lines.length, "a line was written").toBe(1);
      expect(h.sentry().length, "an event was sent").toBe(1);
      expect(h.sentry()[0]!.url, "the key really is used (positive pair)").toContain(KEY);
      const envelopes = String(h.sentry()[0]!.init!.body);
      for (const needle of [SECRET, KEY]) {
        expect(JSON.stringify(h.lines), needle).not.toContain(needle);
        expect(envelopes, needle).not.toContain(needle);
      }
    });

    it("a KNOWN env is untouched: no unknown-env line, jobs run as before (the pair)", async () => {
      const h = harness();
      await runDue(MONDAY_0805, FAST_PROD, env(), h.deps);
      expect(h.lines.some((l) => l.event === "unknown-env")).toBe(false);
      expect(h.posts().length).toBeGreaterThan(0);
    });
  });

  it("while inactive, a non-hourly trigger does nothing at all (the probe is hourly only)", async () => {
    for (const [name, trigger, e] of [
      ["prod", FAST_PROD, env({ ACTIVE: "false" })],
      ["stg", FAST_STG, stgEnv({ ACTIVE: "false" })],
    ] as const) {
      const h = harness();
      expect(await runDue(MONDAY_0805, trigger, e, h.deps), name).toEqual([]);
      expect(h.calls, name).toEqual([]);
      expect(h.lines, name).toEqual([]);
    }
  });
});

describe("R2 (option S): a fast job's failures reach Sentry at most once per UTC hour, keyed on the scheduled slot", () => {
  const HOUR = Date.parse("2026-09-28T08:00:00Z");
  const slot = (i: number) => new Date(HOUR + i * 5 * 60_000);
  const failing = () => new Response("down", { status: 500 });
  /** stream-tick's row alone: these cases are about ITS throttle. The external-play row shares the trigger, and the
   *  case after "the pair" runs both. */
  const TICK_ONLY = JOBS.filter((j) => j.id === "stream-tick");

  it("failing on all 12 firings of one hour: exactly ONE event (the :00 slot), and 11 job lines that say sentryThrottled", async () => {
    const h = harness(failing);
    let firings = 0;
    for (let i = 0; i < 12; i++, firings++) await runDue(slot(i), FAST_PROD, env(), h.deps, TICK_ONLY);
    expect(firings).toBe(12);
    expect(h.posts(), "every firing still ran the job").toHaveLength(12);
    expect(h.events().map((e) => e.tags.job)).toEqual(["stream-tick"]);
    const jobLines = h.lines.filter((l) => l.event === "job");
    expect(jobLines).toHaveLength(12);
    expect(jobLines.filter((l) => l.sentryThrottled === true).map((l) => l.scheduledTime)).toEqual(
      Array.from({ length: 11 }, (_, i) => slot(i + 1).toISOString()),
    );
    expect(jobLines[0]).toMatchObject({ scheduledTime: slot(0).toISOString(), status: "error", sentryDelivered: true });
    expect(jobLines[0]!.sentryThrottled, "the :00 slot is never throttled").toBeUndefined();
  });

  it("288 firings over 24 h, every one failing: 24 events — one per UTC hour", async () => {
    const h = harness(failing);
    let firings = 0;
    for (let i = 0; i < 288; i++, firings++) await runDue(slot(i), FAST_PROD, env(), h.deps, TICK_ONLY);
    expect(firings, "firings checked").toBe(288);
    expect(h.events()).toHaveLength(24);
    expect(h.lines.filter((l) => l.event === "job" && l.sentryThrottled === true)).toHaveLength(288 - 24);
  });

  it("the pair: a failure ONLY at :05 sends nothing and logs sentryThrottled; a failure ONLY at :00 sends one event", async () => {
    const at05 = harness(failing);
    const r05 = await runDue(slot(1), FAST_PROD, env(), at05.deps, TICK_ONLY);
    expect(r05).toEqual([expect.objectContaining({ job: "stream-tick", status: "error", sentryThrottled: true })]);
    expect(r05[0]!.sentryDelivered, "no event was attempted").toBeUndefined();
    expect(at05.events()).toEqual([]);
    expect(at05.lines.find((l) => l.event === "job")).toMatchObject({ job: "stream-tick", status: "error", sentryThrottled: true });
    const at00 = harness(failing);
    await runDue(slot(0), FAST_PROD, env(), at00.deps, TICK_ONLY);
    expect(at00.events().map((e) => e.tags.job)).toEqual(["stream-tick"]);
  });

  it("stg keeps */5 and its throttle: stream-tick failing on all 12 firings of one hour still raises ONE event, from the :00 slot", async () => {
    const h = harness(failing);
    let firings = 0;
    for (let i = 0; i < 12; i++, firings++) await runDue(slot(i), FAST_STG, stgEnv(), h.deps, TICK_ONLY);
    expect(firings).toBe(12);
    expect(h.posts(), "every firing still ran the job").toHaveLength(12);
    expect(h.events().map((e) => [e.tags.job, e.environment])).toEqual([["stream-tick", "stg"]]);
    expect(h.lines.filter((l) => l.event === "job" && l.sentryThrottled === true)).toHaveLength(11);
  });

  it("the outbox row on prod's minute trigger: failing on all 60 minutes of one hour raises exactly ONE event (the :00 slot), the other 59 say sentryThrottled", async () => {
    const OUTBOX_ONLY = JOBS.filter((j) => j.id === "email-outbox");
    const h = harness(failing);
    let firings = 0;
    for (let m = 0; m < 60; m++, firings++) await runDue(new Date(HOUR + m * 60_000), FAST_PROD, env(), h.deps, OUTBOX_ONLY);
    expect(firings).toBe(60);
    expect(h.posts(), "every minute still ran the job").toHaveLength(60);
    expect(h.events().map((e) => e.tags.job)).toEqual(["email-outbox"]);
    const jobLines = h.lines.filter((l) => l.event === "job");
    expect(jobLines).toHaveLength(60);
    expect(jobLines.filter((l) => l.sentryThrottled === true)).toHaveLength(59);
    expect(jobLines.filter((l) => l.sentryDelivered === true).map((l) => l.scheduledTime)).toEqual([new Date(HOUR).toISOString()]);
  });

  it("a 5-minute job on prod's minute trigger is throttled by the SAME rule: a failure ONLY at :05 sends nothing, ONLY at :00 sends one", async () => {
    const at05 = harness(failing);
    const [r05] = await runDue(slot(1), FAST_PROD, env(), at05.deps, TICK_ONLY);
    expect(r05).toMatchObject({ job: "stream-tick", status: "error", sentryThrottled: true });
    expect(at05.events()).toEqual([]);
    const at00 = harness(failing);
    await runDue(slot(0), FAST_PROD, env(), at00.deps, TICK_ONLY);
    expect(at00.events().map((e) => e.tags.job)).toEqual(["stream-tick"]);
  });

  it("an OK job at a throttled slot is not marked: sentryThrottled only ever names a suppressed failure", async () => {
    const h = harness();
    const [r] = await runDue(slot(1), FAST_PROD, env(), h.deps, TICK_ONLY);
    expect(r).toMatchObject({ job: "stream-tick", status: "ok" });
    expect(r!.sentryThrottled).toBeUndefined();
  });

  it("both */5 rows failing every firing of one hour: ONE event per row, each from the :00 slot (the throttle is per job, so the external-play sweep failing beside stream-tick is still heard)", async () => {
    const h = harness(failing);
    let firings = 0;
    for (let i = 0; i < 12; i++, firings++) await runDue(slot(i), FAST_PROD, env(), h.deps, FIVE_MINUTE_ROWS);
    expect(firings).toBe(12);
    expect(h.posts(), "both rows ran on every firing").toHaveLength(24);
    expect(h.events().map((e) => e.tags.job)).toEqual(["stream-tick", "external-play"]);
    const jobLines = h.lines.filter((l) => l.event === "job");
    expect(jobLines.filter((l) => l.sentryThrottled === true), "throttled: 11 slots × 2 rows").toHaveLength(22);
    expect(jobLines.filter((l) => l.sentryDelivered === true).map((l) => [l.job, l.scheduledTime])).toEqual([
      ["stream-tick", slot(0).toISOString()],
      ["external-play", slot(0).toISOString()],
    ]);
  });

  it("R6: a MANUAL run is never throttled — one failing at :07 sends its event", async () => {
    const h = harness(failing);
    h.advance(Date.parse("2026-09-28T08:07:00Z"));   // the manual run's scheduledTime is the Worker's now
    const res = await handleManual(
      new Request("https://seazn-cron-prod.example.workers.dev/run?job=stream-tick", { method: "POST", headers: { "x-cron-secret": "s" } }),
      env(), h.deps,
    );
    expect(res.status).toBe(502);
    expect(h.events()).toEqual([expect.objectContaining({ tags: expect.objectContaining({ job: "stream-tick", run: "manual" }) })]);
    expect(h.lines.find((l) => l.event === "job")).toMatchObject({ run: "manual", scheduledTime: "2026-09-28T08:07:00.000Z" });
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
