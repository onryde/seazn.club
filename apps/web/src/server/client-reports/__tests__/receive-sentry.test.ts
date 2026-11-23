// Seazn-hosted Task 25b, fix round 1 (review I1, m1): what of a client report reaches SENTRY — its events AND its Logs — read off the
// envelopes the REAL SDK would post. The SDK is initialised by the REAL sentry.server.config.ts (its enableLogs, beforeSendLog and
// pinoIntegration, which forwards every pino line to Sentry Logs), with only the transport swapped so the envelopes can be read (the
// db-error-redaction.test.ts rig). The pipeline is the REAL receive.ts with the real `log`, the real limiter and the real
// `Sentry.captureMessage`. Stand-ins: Redis's windowed INCR (an in-memory counter on a test clock, which can be configured, down, or
// absent), and ONE registered kind, `probe`, added beside the real ones so a kind's own Sentry budget (3 here) can be driven without a
// database (its subject check is a counted stub). The real `video` kind takes the registry default; kinds.test.ts pins that.
//
// The sequence:
//   - within the budget each report is a Sentry Log, the first of its key an event too, and a repeat a Log only; past the budget a
//     report reaches neither (it is a line on stdout only); the budget's window over, it reaches Sentry again. The POSITIVE control is
//     the same rig: the in-budget lines ARE seen as Sentry Logs, so the missing one is not a harness that cannot see Logs;
//   - Redis configured but giving no count (an outage), on either counter: stdout only, no Log, no event (review m1);
//   - no Redis configured (a dev box): every report a Log and an event, as before (the house fallback, unchanged);
//   - the client IP's bucket across every subject is spent before the subject is looked up: the report past it never reaches the
//     subject check, and another IP still does.
// Expected numbers come from the declarations (the probe's budget, CLIENT_REPORT_IP_LIMIT), never from the pipeline.
// Sport: not applicable. A client's failure report is sport-agnostic.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as unknown[]);
vi.mock("@sentry/nextjs", async () => {
  const real = await vi.importActual<typeof import("@sentry/nextjs")>("@sentry/nextjs");
  const init = (options: Parameters<typeof real.init>[0]) =>
    real.init({
      ...options,
      transport: () => ({
        send: async (envelope: unknown) => {
          sent.push(envelope);
          return {};
        },
        flush: async () => true,
      }),
    });
  return new Proxy(real, { get: (target, prop, receiver) => (prop === "init" ? init : Reflect.get(target, prop, receiver)) });
});

const clock = vi.hoisted(() => ({ now: 0 }));
/** Redis as the pipeline sees it: configured or not, and per key prefix whether it answers. */
const redis = vi.hoisted(() => ({
  configured: true,
  down: ((): boolean => false) as (key: string) => boolean,
  windows: new Map<string, { count: number; until: number }>(),
}));
vi.mock("@/lib/cache", async (orig) => ({
  ...(await orig<typeof import("@/lib/cache")>()),
  cacheEnabled: () => redis.configured,
  incrWindow: async (key: string, windowSeconds: number) => {
    if (!redis.configured || redis.down(key)) return null;
    const held = redis.windows.get(key);
    const live = held !== undefined && held.until > clock.now ? held : { count: 0, until: clock.now + windowSeconds * 1000 };
    live.count += 1;
    redis.windows.set(key, live);
    return { count: live.count, ttlMs: live.until - clock.now };
  },
}));

const probe = vi.hoisted(() => ({ asked: 0, budget: { max: 3, windowSeconds: 60 } }));
vi.mock("../kinds", async (orig) => {
  const actual = await orig<typeof import("../kinds")>();
  const { z } = await import("zod");
  const { defineClientReportKind } = await import("../define");
  const kind = defineClientReportKind(
    z.strictObject({ kind: z.literal("probe"), subject: z.string(), reason: z.enum(["a", "b"]) }),
    (r) => ({
      rateSubject: r.subject,
      dedupeSubject: `${r.subject}:${r.reason}`,
      subjectExists: async () => {
        probe.asked++;
        return true;
      },
      message: "probe: a client report",
      tags: { reason: r.reason },
      fields: { subject: r.subject, reason: r.reason },
    }),
    { sentryBudget: probe.budget },
  );
  return { ...actual, clientReportKind: (name: string) => (name === "probe" ? kind : actual.clientReportKind(name)) };
});

import { CLIENT_REPORT_IP_LIMIT } from "@/lib/rate-limit";
import type { ClientReport } from "..";

const MESSAGE = "probe: a client report";
const IP = "203.0.113.41";
const OTHER_IP = "198.51.100.42";
const report = (subject: string, reason: "a" | "b" = "a") => ({ kind: "probe", subject, reason }) as unknown as ClientReport;

let Sentry: typeof import("@sentry/nextjs");
let receive: typeof import("..").receiveClientReport;
const stdout: string[] = [];

beforeAll(async () => {
  vi.stubEnv("SENTRY_DSN", "https://publickey@o0.ingest.sentry.io/0");
  await import("../../../../sentry.server.config");
  Sentry = await import("@sentry/nextjs");
  receive = (await import("..")).receiveClientReport;
});
afterAll(() => vi.unstubAllEnvs());

beforeEach(() => {
  clock.now = Date.parse("2026-11-23T12:00:00.000Z");
  redis.configured = true;
  redis.down = () => false;
  redis.windows.clear();
  probe.asked = 0;
  sent.length = 0;
  stdout.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});
afterEach(() => vi.restoreAllMocks());

/** What the SDK posted, after a flush: this probe's Sentry Logs (by body) and events (by message). */
async function reachedSentry(): Promise<{ logs: number; events: number }> {
  await Sentry.flush(5000);
  let logs = 0;
  let events = 0;
  for (const envelope of sent as [unknown, [{ type: string }, unknown][]][]) {
    for (const [header, payload] of envelope[1]) {
      if (header.type === "log") logs += ((payload as { items: { body: string }[] }).items ?? []).filter((i) => i.body === MESSAGE).length;
      if (header.type === "event" && JSON.stringify(payload).includes(MESSAGE)) events++;
    }
  }
  return { logs, events };
}
/** The lines written to stdout outside pino, by why they are there. */
const unforwarded = (why: string) => stdout.filter((l) => l.includes(`"clientReportSentry":"${why}"`) && l.includes(`"msg":"${MESSAGE}"`)).length;

describe("a client report's reach into Sentry, events and Logs, read off the real SDK's envelopes", () => {
  it("PREMISE: the probe kind carries its own budget, smaller than the registry default, so the budget read is the kind's", async () => {
    const { clientReportKind } = await import("../kinds");
    const { CLIENT_REPORT_SENTRY_BUDGET } = await import("../define");
    expect(clientReportKind("probe").sentryBudget).toEqual(probe.budget);
    expect(probe.budget.max).toBeLessThan(CLIENT_REPORT_SENTRY_BUDGET.max);
  });

  it("within the budget each report is a Sentry Log (an event when first of its key); past it, neither: stdout only; the window over, Sentry again", async () => {
    const outcomes: string[] = [];
    for (let i = 1; i <= probe.budget.max; i++) outcomes.push(await receive(report(`s${i}`), IP));
    expect(outcomes, "each a new key: each sent").toEqual(Array(probe.budget.max).fill("sent"));
    expect(await reachedSentry(), "POSITIVE control: the in-budget lines ARE Sentry Logs").toEqual({ logs: probe.budget.max, events: probe.budget.max });
    sent.length = 0;
    expect(await receive(report("s-past"), IP), "one past the budget").toBe("over-budget");
    expect(await receive(report("s1"), OTHER_IP), "another client: the budget is the kind's, across clients").toBe("over-budget");
    expect(await reachedSentry(), "past the budget: no Log, no event").toEqual({ logs: 0, events: 0 });
    expect(unforwarded("over-budget"), "but each is a line on stdout").toBe(2);
    clock.now += probe.budget.windowSeconds * 1000;
    expect(await receive(report("s-next"), IP), "the budget's window over").toBe("sent");
    expect(await reachedSentry()).toEqual({ logs: 1, events: 1 });
  });

  it("a repeat of a key within the budget is a Sentry Log and not an event, and it spends the budget like any line", async () => {
    expect(await receive(report("s1"), IP)).toBe("sent");
    expect(await receive(report("s1"), IP)).toBe("logged");
    expect(await receive(report("s1", "b"), IP), "another reason: its own event").toBe("sent");
    expect(await reachedSentry()).toEqual({ logs: 3, events: 2 });
    expect(await receive(report("s2"), IP), "three lines spent the budget of three").toBe("over-budget");
  });

  it("Redis configured and giving no count (an outage), on the budget's counter or the dedupe's: stdout only, no Log, no event", async () => {
    let checked = 0;
    for (const prefix of ["client-report-sentry-budget:", "client-report-sentry:"]) {
      redis.windows.clear();
      sent.length = 0;
      stdout.length = 0;
      redis.down = (key) => key.startsWith(prefix);
      expect([prefix, await receive(report("s1"), IP)]).toEqual([prefix, "uncounted"]);
      expect([prefix, await receive(report("s1"), IP)]).toEqual([prefix, "uncounted"]);
      expect([prefix, await reachedSentry()]).toEqual([prefix, { logs: 0, events: 0 }]);
      expect([prefix, unforwarded("uncounted")]).toEqual([prefix, 2]);
      checked++;
    }
    expect(checked).toBe(2);
    // The whole of Redis down: the limiter fails open (the house posture) and the report is still kept out of Sentry.
    redis.down = () => true;
    sent.length = 0;
    expect(await receive(report("s9"), IP)).toBe("uncounted");
    expect(await reachedSentry()).toEqual({ logs: 0, events: 0 });
  });

  it("no Redis configured (a dev box, e2e): unchanged — every report a Sentry Log and an event, nothing on stdout outside pino", async () => {
    redis.configured = false;
    const n = probe.budget.max + 2;
    for (let i = 0; i < n; i++) expect(await receive(report("s1"), IP)).toBe("sent");
    expect(await reachedSentry()).toEqual({ logs: n, events: n });
    expect(unforwarded("over-budget") + unforwarded("uncounted")).toBe(0);
  });

  it("the client IP's bucket across every subject is spent BEFORE the subject is looked up; another IP is not capped by it", async () => {
    probe.budget.max = 10_000; // this test is about the IP bucket, not the budget (restored below)
    try {
      for (let i = 0; i < CLIENT_REPORT_IP_LIMIT.max; i++) {
        expect(await receive(report(`subject-${i}`), IP), `report ${i + 1} of ${CLIENT_REPORT_IP_LIMIT.max}, each a new subject`).not.toBe("capped");
      }
      expect(probe.asked, "every report under the cap was looked up").toBe(CLIENT_REPORT_IP_LIMIT.max);
      expect(await receive(report("subject-new"), IP), "one past the IP's cap, on a subject it never named").toBe("capped");
      expect(probe.asked, "the subject was never looked up").toBe(CLIENT_REPORT_IP_LIMIT.max);
      expect(await receive(report("subject-new"), OTHER_IP)).not.toBe("capped");
      clock.now += CLIENT_REPORT_IP_LIMIT.windowSeconds * 1000;
      expect(await receive(report("subject-later"), IP), "the IP's window over").not.toBe("capped");
    } finally {
      probe.budget.max = 3;
    }
  });
});
