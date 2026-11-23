// Seazn-hosted Task 25b: the client-report pipeline (receive.ts) for the `video` kind, over a REAL database: real fixtures, a real Seazn
// session and a real pasted-key session made by the Seazn rig's own Go live. Only the vendors and the counter are stand-ins: Sentry's
// capture is recorded, and Redis's windowed INCR is an in-memory counter on a test clock (the limiter is the REAL `rateLimit` over it).
//
// The sequence under test, per kind of state:
//   - EMPTY FIRST: a report about an id no fixture has is dropped, nothing logged and nothing sent;
//   - a fixture that never streamed to Seazn (no session, or only a pasted-key one) is dropped the same way;
//   - a Seazn fixture's first report is logged once and sent once (level warning, its codes as tags and extras);
//   - a SECOND report in the window, from any viewer, is logged and not sent; another reason is sent; after the window it is sent again;
//   - past the per-IP-and-fixture limit a report is dropped silently; another IP is not; the cap on one fixture does not cap another; it
//     reopens;
//   - past the per-IP limit across EVERY fixture (fix round 1, review I1) a report is dropped before its fixture is looked up, on a
//     fixture that IP never named; another IP is not capped by it.
// What reaches Sentry's events and Logs, the kind's Sentry budget and a Redis outage are receive-sentry.test.ts (the real SDK).
// Expected values come from the report the test sent and from the declarations (CLIENT_REPORT_LIMIT, the window), never from the code.
// ONE SPORT, on purpose: the pipeline reads no sport rule; the rig rides `generic`.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const clock = vi.hoisted(() => ({ now: 0 }));
const counter = vi.hoisted(() => ({ off: false, windows: new Map<string, { count: number; until: number }>() }));
// `off` = no Redis configured at all (the dev-box fallback), so `cacheEnabled` reads it too.
vi.mock("@/lib/cache", async (orig) => {
  const actual = await orig<typeof import("@/lib/cache")>();
  return {
    ...actual,
    cacheEnabled: () => !counter.off,
    incrWindow: async (key: string, windowSeconds: number) => {
      if (counter.off) return null;
      const held = counter.windows.get(key);
      const live = held !== undefined && held.until > clock.now ? held : { count: 0, until: clock.now + windowSeconds * 1000 };
      live.count += 1;
      counter.windows.set(key, live);
      return { count: live.count, ttlMs: live.until - clock.now };
    },
  };
});
const sentry = vi.hoisted(() => ({ messages: [] as { message: string; context: unknown }[] }));
vi.mock("@sentry/nextjs", async (orig) => ({
  ...(await orig<typeof import("@sentry/nextjs")>()),
  captureMessage: (message: string, context: unknown) => void sentry.messages.push({ message, context }),
}));

import { __setRateLimitCounterForTests, CLIENT_REPORT_IP_LIMIT, CLIENT_REPORT_LIMIT } from "@/lib/rate-limit";
import { sql } from "@/lib/db";
import { incrWindow } from "@/lib/cache";
import { log } from "@/server/logger";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { goLive, installSeaznEnvForDescribe, kindOf, seaznRigFor } from "@/server/video/__tests__/_seazn-session-rig";
import { CLIENT_REPORT_SENTRY_WINDOW_SECONDS, ClientReport, receiveClientReport } from "..";

const HAS_DB = !!process.env.DATABASE_URL;

const IP = "203.0.113.10";
const OTHER_IP = "198.51.100.20";
const fx = { seazn: "", pasted: "", none: "" };

const player = (fixtureId: string, over: Partial<ClientReport> = {}): ClientReport => ClientReport.parse({
  kind: "video", fixtureId, stage: "player", source: "replay", partNo: 2, player: "hls", reason: "hls",
  hlsType: "networkError", hlsDetails: "manifestLoadError", httpStatus: 403, mediaCode: null, ...over,
});
const route = (fixtureId: string): ClientReport => ClientReport.parse({
  kind: "video", fixtureId, stage: "route", source: null, partNo: null, player: null, reason: "http",
  hlsType: null, hlsDetails: null, httpStatus: 503, mediaCode: null,
});
/** The pipeline's own log lines (other code logs too: a rig's Go live). */
const lines = (warn: ReturnType<typeof vi.spyOn>) =>
  warn.mock.calls.filter((c: unknown[]) => typeof c[1] === "string" && (c[1] as string).startsWith("seazn video:"));
/** A report's fields as the log line and the event carry them: everything but `kind`. */
const fields = (r: ClientReport) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "kind"));

describe.skipIf(!HAS_DB)("receiveClientReport — the video kind, over a real database", () => {
  // The Seazn env for this describe, set in ITS beforeAll so the rig's Go live below sees LIVE on (installSeaznEnv stubs per test).
  installSeaznEnvForDescribe("client-reports-receive-test");
  beforeAll(async () => {
    const seeded = await seedOrg();
    const auth = { ...seeded.auth, userId: await rigUser() };
    const { fixtureIds } = await startedDivisionWithFixture(auth, { fixtures: 2 });
    expect(fixtureIds, "PREMISE: two fixtures").toHaveLength(2);
    const r = await seaznRigFor(auth, fixtureIds as [string, string]);
    [fx.seazn, fx.pasted] = fixtureIds as [string, string];
    // A third fixture, in a division of its own, that never streams.
    fx.none = (await startedDivisionWithFixture(auth)).fixtureId;
    const seaznSid = await goLive(r, fx.seazn, r.seazn);
    const pastedSid = await goLive(r, fx.pasted, r.pasted);
    expect(await kindOf(seaznSid), "PREMISE: a Seazn session").toBe("seazn");
    expect(await kindOf(pastedSid), "PREMISE: a pasted-key session, not Seazn").not.toBe("seazn");
  });

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clock.now = Date.parse("2026-11-23T12:00:00.000Z");
    counter.off = false;
    counter.windows.clear();
    sentry.messages.length = 0;
    __setRateLimitCounterForTests((key, windowSeconds) => incrWindow(key, windowSeconds));
    warn = vi.spyOn(log, "warn");
  });
  afterEach(() => {
    __setRateLimitCounterForTests(null);
    warn.mockRestore();
  });

  it("EMPTY CASE FIRST: a report about an id no fixture has is dropped — nothing logged, nothing sent", async () => {
    expect(await receiveClientReport(player(randomUUID()), IP)).toBe("unknown");
    expect(lines(warn)).toEqual([]);
    expect(sentry.messages).toEqual([]);
  });

  it("a fixture that never streamed to Seazn — no session, or a pasted-key one only — is dropped the same way", async () => {
    expect(await receiveClientReport(player(fx.none), IP)).toBe("unknown");
    expect(await receiveClientReport(player(fx.pasted), IP)).toBe("unknown");
    expect(lines(warn)).toEqual([]);
    expect(sentry.messages).toEqual([]);
  });

  it("a Seazn fixture's first report: one warn line with its codes, one Sentry warning with them as tags and extras", async () => {
    const report = player(fx.seazn);
    expect(await receiveClientReport(report, IP)).toBe("sent");
    expect(lines(warn).map((c: unknown[]) => [c[0], c[1]])).toEqual([[{ clientReport: "video", ...fields(report) }, "seazn video: the player gave up"]]);
    expect(sentry.messages).toEqual([{
      message: "seazn video: the player gave up",
      context: {
        level: "warning",
        tags: { client_report: "video", area: "seazn-video", event: "player_fatal", reason: "hls", fixture_id: fx.seazn },
        extra: fields(report),
      },
    }]);
  });

  it("the sequence in one window: a second report is logged and not sent (any viewer's), another reason is sent, and after the window it is sent again", async () => {
    expect(await receiveClientReport(player(fx.seazn), IP)).toBe("sent");
    expect(await receiveClientReport(player(fx.seazn), IP), "the same reason again").toBe("logged");
    expect(await receiveClientReport(player(fx.seazn, { hlsDetails: "fragLoadError" }), OTHER_IP), "another viewer, the same reason").toBe("logged");
    expect(await receiveClientReport(route(fx.seazn), IP), "another reason: its own event").toBe("sent");
    expect(lines(warn), "every accepted report is a line").toHaveLength(4);
    expect(sentry.messages.map((m) => [m.message, (m.context as { tags: { reason: string } }).tags.reason])).toEqual([
      ["seazn video: the player gave up", "hls"], ["seazn video: the video route could not be read", "http"],
    ]);
    clock.now += CLIENT_REPORT_SENTRY_WINDOW_SECONDS * 1000 - 1;
    expect(await receiveClientReport(player(fx.seazn), OTHER_IP), "a millisecond before the window ends").toBe("logged");
    clock.now += 1;
    expect(await receiveClientReport(player(fx.seazn), OTHER_IP), "the window over: sent again").toBe("sent");
    expect(sentry.messages).toHaveLength(3);
  });

  it("past the per-IP limit a report is dropped silently; another IP is not; the cap on one fixture caps no other; it reopens with its window", async () => {
    for (let i = 0; i < CLIENT_REPORT_LIMIT.max; i++) {
      expect(await receiveClientReport(route(fx.seazn), IP), `report ${i + 1} of ${CLIENT_REPORT_LIMIT.max}`).not.toBe("capped");
    }
    const linesAtCap = lines(warn).length;
    const sentAtCap = sentry.messages.length;
    expect(linesAtCap, "every report under the cap was logged").toBe(CLIENT_REPORT_LIMIT.max);
    expect(await receiveClientReport(route(fx.seazn), IP), "one past the cap").toBe("capped");
    expect([lines(warn).length, sentry.messages.length], "dropped: no line, no event").toEqual([linesAtCap, sentAtCap]);
    expect(await receiveClientReport(route(fx.seazn), OTHER_IP), "another IP on the same fixture").toBe("logged");
    expect(await receiveClientReport(route(fx.none), IP), "the same IP on another fixture: its own bucket (and unknown)").toBe("unknown");
    clock.now += CLIENT_REPORT_LIMIT.windowSeconds * 1000;
    expect(await receiveClientReport(route(fx.seazn), IP), "the limit's window over").toBe("logged");
  });

  it("past the IP's limit across every fixture, a report is dropped BEFORE its fixture is looked up — one the IP never named; another IP is not", async () => {
    // A counting wrapper over the real tag: every lookup the pipeline makes goes through it.
    let lookups = 0;
    const db = ((...args: Parameters<typeof sql>) => {
      lookups++;
      return sql(...args);
    }) as unknown as typeof sql;
    for (let i = 0; i < CLIENT_REPORT_IP_LIMIT.max; i++) {
      expect(await receiveClientReport(route(randomUUID()), IP, { db }), `report ${i + 1}: a fresh id, under every cap`).toBe("unknown");
    }
    expect(lookups, "each was looked up").toBe(CLIENT_REPORT_IP_LIMIT.max);
    expect(await receiveClientReport(route(fx.seazn), IP, { db }), "a real Seazn fixture this IP never named").toBe("capped");
    expect(lookups, "and it was not looked up").toBe(CLIENT_REPORT_IP_LIMIT.max);
    expect([lines(warn).length, sentry.messages.length]).toEqual([0, 0]);
    expect(await receiveClientReport(route(fx.seazn), OTHER_IP, { db }), "another IP").toBe("sent");
  });

  it("with no Redis to count in (the limiter inert, no window), every report is logged and sent — the documented fallback", async () => {
    __setRateLimitCounterForTests(null);
    counter.off = true;
    expect(await receiveClientReport(player(fx.seazn), IP)).toBe("sent");
    expect(await receiveClientReport(player(fx.seazn), IP)).toBe("sent");
    expect(sentry.messages).toHaveLength(2);
  });
});
