// Seazn-hosted Task 25b, fix rounds 1-3 (review I1, m1, N1, N2, I2, m-r2b): what of a client report reaches SENTRY — its events AND its Logs — read off the
// envelopes the REAL SDK would post. The SDK is initialised by the REAL sentry.server.config.ts (its enableLogs, beforeSendLog and
// pinoIntegration, which forwards every pino line to Sentry Logs), with only the transport swapped so the envelopes can be read (the
// db-error-redaction.test.ts rig). The pipeline is the REAL receive.ts with the real `log`, the real limiter and the real
// `Sentry.captureMessage`. Stand-ins: Redis's windowed INCR (an in-memory counter on a test clock, which can be configured, down, or
// absent), and ONE registered kind, `probe`, added beside the real ones so a kind's own Sentry budget (3 here) can be driven without a
// database (its subject check is a counted stub). The real `video` kind takes the registry default; kinds.test.ts pins that.
//
// The sequence:
//   - only the FIRST report of a dedupe key reaches Sentry (one Log and one event, together); a repeat is a line on the server log only
//     and spends nothing (N1), so one fixture's repeats can never keep another fixture's first report out of Sentry;
//   - within the kind's budget each first report reaches Sentry; past it, neither; the budget's window over, Sentry again. The
//     POSITIVE control is the same rig: the in-budget lines ARE seen as Sentry Logs, so a missing one is not a harness that cannot see;
//   - one client IP reaches Sentry at most CLIENT_REPORT_IP_SENTRY_SHARE times a window, across every kind; another IP is not held;
//   - a first report the share OR the budget refuses gives its dedupe slot back (I2): the next report of that failure, from another
//     IP, is a FIRST and reaches Sentry, so one IP over its share cannot silence a failure for everyone;
//   - Redis configured but giving no count (an outage), on any of the three counters: server log only (review m1);
//   - no Redis configured (a dev box): every report a Log and an event, as before (the house fallback, unchanged);
//   - the client IP's bucket across every subject is spent before the subject is looked up;
//   - a line kept out of Sentry is written into PINO'S OWN destination (N2: one writer, one order, pino's base fields), never beside
//     it on process.stdout, and never through pino's serialiser (which is what Sentry listens to); and only at a level the logger
//     writes (m-r2b: LOG_LEVEL=error silences it, as it silences pino's own warn).
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
  // Redis DEL on the same keyspace: the key is gone, so its next INCR starts a new window at 1.
  cacheDel: async (...keys: string[]) => {
    if (!redis.configured) return;
    for (const key of keys) if (!redis.down(key)) redis.windows.delete(key);
  },
}));

const probe = vi.hoisted(() => ({ asked: 0, budget: { max: 3, windowSeconds: 60 } }));
// Two probe kinds (`probe`, `probe2`), so the per-IP share can be shown to hold ACROSS kinds; `probe2` has a budget no test reaches.
vi.mock("../kinds", async (orig) => {
  const actual = await orig<typeof import("../kinds")>();
  const { z } = await import("zod");
  const { defineClientReportKind } = await import("../define");
  const define = (name: "probe" | "probe2", sentryBudget: { max: number; windowSeconds: number }) =>
    defineClientReportKind(
      z.strictObject({ kind: z.literal(name), subject: z.string(), reason: z.enum(["a", "b"]) }),
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
      { sentryBudget },
    );
  const kinds = { probe: define("probe", probe.budget), probe2: define("probe2", { max: 10_000, windowSeconds: 60 }) };
  return { ...actual, clientReportKind: (name: string) => (name in kinds ? kinds[name as keyof typeof kinds] : actual.clientReportKind(name)) };
});

import os from "node:os";
import pino from "pino";
import { CLIENT_REPORT_IP_LIMIT } from "@/lib/rate-limit";
import { log } from "@/server/logger";
import { CLIENT_REPORT_IP_SENTRY_SHARE, CLIENT_REPORT_SENTRY_WINDOW_SECONDS, type ClientReport } from "..";

const MESSAGE = "probe: a client report";
const IP = "203.0.113.41";
const OTHER_IP = "198.51.100.42";
const THIRD_IP = "192.0.2.43";
const report = (subject: string, reason: "a" | "b" = "a", kind: "probe" | "probe2" = "probe") => ({ kind, subject, reason }) as unknown as ClientReport;

let Sentry: typeof import("@sentry/nextjs");
let receive: typeof import("..").receiveClientReport;
/** What reached pino's own destination stream (the app's one writer on fd 1), and what was written to process.stdout beside it. */
const written: string[] = [];
const direct: string[] = [];
const destination = () => (log as unknown as Record<symbol, { write: (s: string) => boolean }>)[pino.symbols.streamSym]!;

beforeAll(async () => {
  vi.stubEnv("SENTRY_DSN", "https://publickey@o0.ingest.sentry.io/0");
  await import("../../../../sentry.server.config");
  Sentry = await import("@sentry/nextjs");
  receive = (await import("..")).receiveClientReport;
});
afterAll(() => vi.unstubAllEnvs());

beforeEach(async () => {
  // Drain whatever a previous test left buffered (Sentry Logs are batched), so each test reads only its own envelopes.
  await Sentry.flush(5000);
  clock.now = Date.parse("2026-11-23T12:00:00.000Z");
  redis.configured = true;
  redis.down = () => false;
  redis.windows.clear();
  probe.asked = 0;
  sent.length = 0;
  written.length = 0;
  direct.length = 0;
  vi.spyOn(destination(), "write").mockImplementation((chunk: string) => {
    written.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    direct.push(String(chunk));
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
/** The lines kept out of Sentry, by why: written into pino's destination, never beside it (none may appear on process.stdout). */
const unforwarded = (why: string) => {
  expect(direct.filter((l) => l.includes(MESSAGE)), "no report line is written beside pino's destination").toEqual([]);
  return written.filter((l) => l.includes(`"clientReportSentry":"${why}"`) && l.includes(`"msg":"${MESSAGE}"`)).length;
};

describe("a client report's reach into Sentry, events and Logs, read off the real SDK's envelopes", () => {
  it("PREMISE: the probe kind carries its own budget, smaller than the registry default, so the budget read is the kind's", async () => {
    const { clientReportKind } = await import("../kinds");
    const { CLIENT_REPORT_SENTRY_BUDGET } = await import("../define");
    expect(clientReportKind("probe").sentryBudget).toEqual(probe.budget);
    expect(probe.budget.max).toBeLessThan(CLIENT_REPORT_SENTRY_BUDGET.max);
  });

  it("within the kind's budget each FIRST report is a Sentry Log and an event; past it, neither (server log only); the window over, Sentry again", async () => {
    const outcomes: string[] = [];
    for (let i = 1; i <= probe.budget.max; i++) outcomes.push(await receive(report(`s${i}`), i === 1 ? IP : OTHER_IP));
    expect(outcomes, "each a new key: each sent").toEqual(Array(probe.budget.max).fill("sent"));
    expect(await reachedSentry(), "POSITIVE control: the in-budget lines ARE Sentry Logs").toEqual({ logs: probe.budget.max, events: probe.budget.max });
    sent.length = 0;
    expect(await receive(report("s-past"), IP), "a new key, one past the budget").toBe("over-budget");
    expect(await receive(report("s-past-2"), THIRD_IP), "from another client: the budget is the kind's, across clients").toBe("over-budget");
    expect(await reachedSentry(), "past the budget: no Log, no event").toEqual({ logs: 0, events: 0 });
    expect(unforwarded("over-budget"), "but each is a line on the server log").toBe(2);
    clock.now += probe.budget.windowSeconds * 1000;
    expect(await receive(report("s-next"), THIRD_IP), "the budget's window over").toBe("sent");
    expect(await reachedSentry()).toEqual({ logs: 1, events: 1 });
  });

  it("a REPEAT is a server-log line only and spends no budget: one fixture's repeats never keep another fixture's first report out of Sentry", async () => {
    expect(await receive(report("fixture-a"), IP)).toBe("sent");
    const repeats = probe.budget.max * 4;
    for (let i = 0; i < repeats; i++) expect(await receive(report("fixture-a"), i % 2 ? IP : OTHER_IP), `repeat ${i + 1}`).toBe("logged");
    expect(await reachedSentry(), "only the first reached Sentry").toEqual({ logs: 1, events: 1 });
    expect(unforwarded("repeat"), "every repeat is a server-log line").toBe(repeats);
    sent.length = 0;
    // The budget is untouched by the repeats: the rest of it is still there for other fixtures' first reports.
    for (let i = 2; i <= probe.budget.max; i++) expect(await receive(report(`fixture-${i}`), OTHER_IP), `fixture ${i}'s first report`).toBe("sent");
    expect(await receive(report("fixture-a", "b"), THIRD_IP), "another reason is its own key, a first report: the budget is now spent by first reports only").toBe("over-budget");
    expect(await reachedSentry()).toEqual({ logs: probe.budget.max - 1, events: probe.budget.max - 1 });
  });

  it("one client IP reaches Sentry at most its share a window, across every kind; another IP is not held by it; the window over, again", async () => {
    probe.budget.max = 10_000; // this test is about the IP's share, not the kind's budget (restored below)
    try {
      const share = CLIENT_REPORT_IP_SENTRY_SHARE.max;
      for (let i = 0; i < share; i++) {
        expect(await receive(report(`k${i}`, "a", i % 2 ? "probe2" : "probe"), IP), `first report ${i + 1} of the share, kinds alternating`).toBe("sent");
      }
      expect(await receive(report("k-past", "a", "probe"), IP), "one past the share, kind probe").toBe("over-share");
      expect(await receive(report("k-past-2", "a", "probe2"), IP), "and kind probe2: the share is across kinds").toBe("over-share");
      expect(await reachedSentry()).toEqual({ logs: share, events: share });
      expect(unforwarded("over-share")).toBe(2);
      sent.length = 0;
      expect(await receive(report("k-other"), OTHER_IP), "another IP").toBe("sent");
      clock.now += CLIENT_REPORT_IP_SENTRY_SHARE.windowSeconds * 1000;
      expect(await receive(report("k-later"), IP), "the share's window over").toBe("sent");
      expect(await reachedSentry()).toEqual({ logs: 2, events: 2 });
    } finally {
      probe.budget.max = 3;
    }
  });

  it("I2: a first report the IP's SHARE refuses gives back its dedupe slot: another IP's report of that failure is a first, and sent", async () => {
    probe.budget.max = 10_000; // this test is about the share, not the kind's budget (restored below)
    try {
      const share = CLIENT_REPORT_IP_SENTRY_SHARE.max;
      for (let i = 0; i < share; i++) expect(await receive(report(`venue-${i}`), IP), `the venue IP's first report ${i + 1}`).toBe("sent");
      expect(await receive(report("court-x"), IP), "the venue IP, over its share, reports court X first").toBe("over-share");
      expect(await receive(report("court-x"), IP), "and again: still a first (the slot was given back), still refused").toBe("over-share");
      expect(await receive(report("court-x"), OTHER_IP), "a viewer elsewhere: court X's FIRST report, sent").toBe("sent");
      expect(await receive(report("court-x"), THIRD_IP), "after it, court X is a repeat again").toBe("logged");
      expect(await reachedSentry()).toEqual({ logs: share + 1, events: share + 1 });
    } finally {
      probe.budget.max = 3;
    }
  });

  it("I2: a first report the kind's BUDGET refuses gives back its dedupe slot: once the budget's window turns, another IP's is sent", async () => {
    for (let i = 1; i <= probe.budget.max; i++) expect(await receive(report(`s${i}`), OTHER_IP), `first report ${i}`).toBe("sent");
    expect(await receive(report("court-x"), IP), "court X's first report, past the budget").toBe("over-budget");
    // The budget's window (60 s) turns well inside the dedupe window (CLIENT_REPORT_SENTRY_WINDOW_SECONDS): a slot still held would
    // make the next report a repeat.
    expect(probe.budget.windowSeconds, "PREMISE: the budget turns inside the dedupe window").toBeLessThan(CLIENT_REPORT_SENTRY_WINDOW_SECONDS);
    clock.now += probe.budget.windowSeconds * 1000;
    expect(await receive(report("court-x"), THIRD_IP), "court X from another IP, the budget's window turned: a first, sent").toBe("sent");
    expect(await receive(report("court-x"), IP), "then a repeat").toBe("logged");
    expect(await reachedSentry()).toEqual({ logs: probe.budget.max + 1, events: probe.budget.max + 1 });
  });

  it("m-r2b: a line kept out of Sentry is written only at a level the logger writes (LOG_LEVEL=error: not, like pino's own warn)", async () => {
    const level = log.level;
    try {
      log.level = "error";
      expect(await receive(report("s1"), IP)).toBe("sent");
      expect(await receive(report("s1"), IP)).toBe("logged");
      expect(unforwarded("repeat"), "the repeat's warn line: not written").toBe(0);
      expect(written.filter((l) => l.includes(`"msg":"${MESSAGE}"`)), "nor pino's own warn for the first").toEqual([]);
      log.level = "warn";
      expect(await receive(report("s1"), IP)).toBe("logged");
      expect(unforwarded("repeat"), "POSITIVE pair: at warn, written").toBe(1);
    } finally {
      log.level = level;
    }
  });

  it("a line kept out of Sentry is written into pino's own destination, with pino's base fields, as ONE line", async () => {
    expect(await receive(report("s1"), IP)).toBe("sent");
    expect(await receive(report("s1"), IP)).toBe("logged");
    const ours = written.filter((l) => l.includes(`"clientReportSentry":"repeat"`));
    expect(ours).toHaveLength(1);
    expect(ours[0]!.endsWith("\n") && ours[0]!.indexOf("\n") === ours[0]!.length - 1, "one line, newline-terminated").toBe(true);
    expect(JSON.parse(ours[0]!)).toMatchObject({
      level: 40, pid: process.pid, hostname: os.hostname(), name: "web", clientReport: "probe", subject: "s1", reason: "a", msg: MESSAGE,
    });
    expect(unforwarded("repeat")).toBe(1);
  });

  it("Redis configured and giving no count (an outage), on the dedupe, the IP's share or the budget: server log only, no Log, no event", async () => {
    let checked = 0;
    for (const prefix of ["client-report-sentry:", "client-report-sentry-ip:", "client-report-sentry-budget:"]) {
      redis.windows.clear();
      sent.length = 0;
      written.length = 0;
      redis.down = (key) => key.startsWith(prefix);
      expect([prefix, await receive(report("s1"), IP)]).toEqual([prefix, "uncounted"]);
      expect([prefix, await receive(report("s2"), IP)]).toEqual([prefix, "uncounted"]);
      expect([prefix, await reachedSentry()]).toEqual([prefix, { logs: 0, events: 0 }]);
      expect([prefix, unforwarded("uncounted")]).toEqual([prefix, 2]);
      checked++;
    }
    expect(checked).toBe(3);
    // The whole of Redis down: the limiter fails open (the house posture) and the report is still kept out of Sentry.
    redis.down = () => true;
    sent.length = 0;
    expect(await receive(report("s9"), IP)).toBe("uncounted");
    expect(await reachedSentry()).toEqual({ logs: 0, events: 0 });
  });

  it("no Redis configured (a dev box, e2e): unchanged — every report, repeats too, a Sentry Log and an event; nothing kept out", async () => {
    redis.configured = false;
    const n = Math.max(probe.budget.max, CLIENT_REPORT_IP_SENTRY_SHARE.max) + 2;
    for (let i = 0; i < n; i++) expect(await receive(report("s1"), IP)).toBe("sent");
    expect(await reachedSentry()).toEqual({ logs: n, events: n });
    expect(unforwarded("over-budget") + unforwarded("uncounted") + unforwarded("over-share") + unforwarded("repeat")).toBe(0);
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
