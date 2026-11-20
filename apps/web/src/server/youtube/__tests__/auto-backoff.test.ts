// Phase 0, YouTube channel safety, Task 1: the AUTOMATIC start backs off a channel after a rate / availability refusal.
// A refusal of youtube_limit_reached, youtube_channel_busy or youtube_unavailable on a new broadcast records a window on the
// connection (60 s, doubling, capped at 1800 s); inside it an automatic start is refused with the stored code and NO call to
// YouTube. A person's tap never reads the window, and any successful prepare clears it.
//
// Expected numbers are the plan's literals, typed here: 60 s base, 1800 s cap, doubling. The sequence runs through the REAL
// prepareYoutubeBroadcast against the fake port, on an injected clock.
//
// Sport: not applicable — the backoff reads a connection, never a sport rule.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { YOUTUBE_AUTO_BACKOFF_BASE_SECONDS, YOUTUBE_AUTO_BACKOFF_CODES, YOUTUBE_AUTO_BACKOFF_MAX_SECONDS } from "@/lib/youtube";
import type { StartCause } from "@/server/relay/domain/session";
import { divisionRig } from "@/server/usecases/__tests__/_rig";
import { autoBackoffRefusal, backoffSeconds } from "@/server/youtube/connections";
import { FakeYouTube } from "@/server/youtube/fake";
import { prepareYoutubeBroadcast } from "@/server/youtube/prepare";
import { connect, org } from "./_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const T0 = new Date("2026-11-20T12:00:00.000Z");
const secondsAfter = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

describe("backoffSeconds (60 s, doubling, capped at 1800 s)", () => {
  it("the plan's table for 1..8 refusals in a row", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffSeconds)).toEqual([60, 120, 240, 480, 960, 1800, 1800, 1800]);
  });
  it("derives from the constants: base on the first refusal, the cap at and past it", () => {
    expect(backoffSeconds(1)).toBe(YOUTUBE_AUTO_BACKOFF_BASE_SECONDS);
    expect(backoffSeconds(2)).toBe(2 * YOUTUBE_AUTO_BACKOFF_BASE_SECONDS);
    expect(backoffSeconds(40)).toBe(YOUTUBE_AUTO_BACKOFF_MAX_SECONDS);
    // 60 * 2^5 = 1920 is past the cap: the literal answer differs from the uncapped doubling.
    expect(backoffSeconds(6)).toBe(1800);
  });
  it("the three codes that back off, all of them refusal codes", () => {
    expect([...YOUTUBE_AUTO_BACKOFF_CODES].sort()).toEqual(["youtube_channel_busy", "youtube_limit_reached", "youtube_unavailable"]);
  });
});

describe("autoBackoffRefusal", () => {
  it("true before auto_retry_after, false at and after it, false when null", () => {
    const until = secondsAfter(T0, 60);
    expect(autoBackoffRefusal({ auto_retry_after: until }, secondsAfter(T0, 59))).toBe(true);
    expect(autoBackoffRefusal({ auto_retry_after: until }, until)).toBe(false);
    expect(autoBackoffRefusal({ auto_retry_after: until }, secondsAfter(T0, 61))).toBe(false);
    expect(autoBackoffRefusal({ auto_retry_after: null }, T0)).toBe(false);
  });
});

// ---- the sequence, through the real prepare --------------------------------------------------------------------------------
const KEKS = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK"] as const;
const savedKeks = Object.fromEntries(KEKS.map((k) => [k, process.env[k]]));
beforeAll(() => { for (const k of KEKS) process.env[k] = randomBytes(32).toString("hex"); });
afterAll(() => {
  for (const k of KEKS) {
    if (savedKeks[k] === undefined) delete process.env[k];
    else process.env[k] = savedKeks[k];
  }
});

async function world() {
  const o = await org();
  const c = await connect(o);
  const d = await divisionRig(o.auth, { entrants: 3 });   // 3 fixtures
  return { orgId: o.orgId, connectionId: c.connectionId, targetId: c.targetId, fixtures: d.fixtureIds, fake: new FakeYouTube() };
}
type W = Awaited<ReturnType<typeof world>>;
const prep = (w: W, fixtureId: string, now: Date, startCause: StartCause) =>
  prepareYoutubeBroadcast({ orgId: w.orgId, fixtureId, targetId: w.targetId, now, startCause }, w.fake);
async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error("expected a refusal, got an answer");
}
const backoff = async (w: W) =>
  (await sql<{ auto_backoff_count: number; auto_retry_after: Date | null; auto_backoff_code: string | null; last_error_code: string | null; last_health_at: Date | null }[]>`
    select auto_backoff_count, auto_retry_after, auto_backoff_code, last_error_code, last_health_at
      from org_youtube_connections where id = ${w.connectionId}`)[0]!;
const rowStates = async (w: W) =>
  (await sql<{ state: string }[]>`select state from youtube_broadcasts where org_id = ${w.orgId}`).map((r) => r.state).sort();
const keyCount = async (w: W) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from youtube_stream_keys where connection_id = ${w.connectionId}`)[0]!.n;
const insertBroadcasts = (w: W) => w.fake.calls.filter((c) => c.method === "insertBroadcast").length;

describe.skipIf(!HAS_DB)("prepareYoutubeBroadcast — the automatic start's backoff", () => {
  it("SEQUENCE: refused limit_reached (one YouTube insert) → automatic inside the window refused with ZERO port calls and no row → organiser inside the window asks YouTube and succeeds → cleared → automatic asks again", async () => {
    const w = await world();
    const [f1, f2, f3] = w.fixtures as [string, string, string];

    // 1. The automatic start is refused by YouTube: one insertBroadcast, and the window opens for 60 s.
    w.fake.failNext("insertBroadcast", "youtube_limit_reached");
    const first = await refusal(prep(w, f1, T0, "automatic"));
    expect([first.code, first.status]).toEqual(["youtube_limit_reached", 429]);
    expect(insertBroadcasts(w)).toBe(1);
    expect(await backoff(w)).toMatchObject({
      auto_backoff_count: 1, auto_retry_after: secondsAfter(T0, 60), auto_backoff_code: "youtube_limit_reached",
      last_error_code: null, last_health_at: null,   // the live-state record is untouched
    });
    const statesAfterFirst = await rowStates(w);
    const keysAfterFirst = await keyCount(w);
    expect(statesAfterFirst).toEqual(["failed"]);

    // 2. A second automatic start inside the window: the stored code, NO port call, and nothing written.
    const callsBefore = w.fake.calls.length;
    const second = await refusal(prep(w, f1, secondsAfter(T0, 59), "automatic"));
    expect([second.code, second.status, second.extra]).toEqual(["youtube_limit_reached", 429, { connectionId: w.connectionId }]);
    expect(w.fake.calls.length).toBe(callsBefore);
    expect(await rowStates(w)).toEqual(statesAfterFirst);   // no created / bound / reserved row
    expect(await keyCount(w)).toBe(keysAfterFirst);         // no key pooled or held
    expect((await backoff(w)).auto_backoff_count).toBe(1);  // a backed-off refusal does not extend its own window

    // 3. The organiser's tap inside the window asks YouTube, succeeds, and clears the backoff.
    const human = await prep(w, f2, secondsAfter(T0, 30), "organiser");
    expect(human).not.toBeNull();
    expect(w.fake.calls.length).toBeGreaterThan(callsBefore);
    expect(await backoff(w)).toMatchObject({ auto_backoff_count: 0, auto_retry_after: null, auto_backoff_code: null });

    // 4. An automatic start, still inside the old window's time, asks YouTube again.
    const insertsBefore = insertBroadcasts(w);
    expect(await prep(w, f3, secondsAfter(T0, 31), "automatic")).not.toBeNull();
    expect(insertBroadcasts(w)).toBe(insertsBefore + 1);
  });

  it("consecutive refusals double the window: at its end the automatic start asks again, and a second refusal opens 120 s", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    w.fake.failNext("insertBroadcast", "youtube_unavailable");
    expect((await refusal(prep(w, f, T0, "automatic"))).code).toBe("youtube_unavailable");
    const at = secondsAfter(T0, 60);   // exactly at auto_retry_after: no longer refused
    w.fake.failNext("bind", "youtube_unavailable");
    const inserts = insertBroadcasts(w);
    expect((await refusal(prep(w, f, at, "automatic"))).code).toBe("youtube_unavailable");
    expect(insertBroadcasts(w)).toBe(inserts + 1);
    expect(await backoff(w)).toMatchObject({ auto_backoff_count: 2, auto_retry_after: secondsAfter(at, 120) });
  });

  it("a refusal that is not a backoff code (not enabled for live) opens no window", async () => {
    const w = await world();
    w.fake.failNext("insertBroadcast", "youtube_live_not_enabled");
    await refusal(prep(w, w.fixtures[0]!, T0, "organiser"));
    expect(await backoff(w)).toMatchObject({ auto_backoff_count: 0, auto_retry_after: null, auto_backoff_code: null });
  });
});
