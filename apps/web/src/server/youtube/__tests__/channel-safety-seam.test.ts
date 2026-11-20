// Phase 0 (YouTube channel safety) Task 6: the SEAM PROOF. Tasks 1-5 each have their own suite; this one drives the REAL producers and
// consumers of all five end to end, on ONE channel, in one journey, against the fake port (the only fake): a unit-green seam that nothing
// in production reaches (AGENTS.md failure class 1, "the inert seam") fails here.
//
//   1. connect through the real save (pickYoutubeChannel = saveConnectionFromGrant + recordChannelCreatedAt) -> channel_created_at stored
//   2. the REAL safety route handler warns for that 5-day-old channel, reading the STORED date (the fake is then told a different one)
//   3. an AUTOMATIC start the fake refuses `youtube_limit_reached` opens the backoff; the next automatic start is refused the same code
//      from the window with the fake's call count UNCHANGED
//   4. the organiser's Go live inside the window asks YouTube, succeeds and clears the backoff
//   5. the description the fake recorded for that broadcast carries the fact lines (sport . round, competition, venue, date and time)
//
// Reading of the brief's "refused twice, the second without a port call": the first refusal is YouTube's (one port call); the second comes
// from Task 1's backoff window, which is what makes a port call unnecessary. That is how the code documents it, and what is asserted.
//
// Sport: generic only - the seam under test (connection, backoff, description facts) never reads a sport rule; the fact line's sport label
// is derived from the dictionary for the division's own sport_key.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import en from "@/dictionaries/en/ui.json";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { YOUTUBE_AUTO_BACKOFF_BASE_SECONDS, YOUTUBE_YOUNG_CHANNEL_DAYS } from "@/lib/youtube";
import { GET as safetyRoute } from "@/app/api/v1/orgs/[id]/youtube-connections/[connectionId]/safety/route";
import { divisionRig } from "@/server/usecases/__tests__/_rig";
import { setYoutubeDriverForTest } from "@/server/youtube/driver";
import { FakeYouTube } from "@/server/youtube/fake";
import { prepareYoutubeBroadcast } from "@/server/youtube/prepare";
import { pickYoutubeChannel } from "@/server/youtube/connections";
import type { StartCause } from "@/server/relay/domain/session";
import { channelId, grant, org } from "./_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const DAY = 86_400_000;

const KEKS = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK"] as const;
const savedKeks = Object.fromEntries(KEKS.map((k) => [k, process.env[k]]));
beforeAll(() => { for (const k of KEKS) process.env[k] = randomBytes(32).toString("hex"); });
afterAll(() => {
  for (const k of KEKS) {
    if (savedKeks[k] === undefined) delete process.env[k];
    else process.env[k] = savedKeks[k];
  }
});
afterEach(() => setYoutubeDriverForTest(null));

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error("expected a refusal, got an answer");
}

describe.skipIf(!HAS_DB)("Phase 0 channel safety: one journey through every seam", () => {
  it("connect -> safety warns -> automatic refusal backs off -> Go live clears it -> the description carries the facts", async () => {
    const o = await org();
    authState.userId = o.userId;
    const fake = new FakeYouTube();
    setYoutubeDriverForTest(fake);
    const ch = { id: channelId(), title: "Seam FC" };
    const fiveDaysAgo = new Date(Date.now() - 5 * DAY);
    expect(5, "PREMISE: five days is inside the young window").toBeLessThan(YOUTUBE_YOUNG_CHANNEL_DAYS);

    // ── 1. connect: the real save, then the real recordChannelCreatedAt (Task 3) ─────────────────────────────────────────
    const p = await grant(o, { channels: [ch] });
    fake.seedGrant({ refreshToken: p.token, channelId: ch.id, channelTitle: ch.title });
    fake.setChannelCreatedAt(ch.id, fiveDaysAgo);
    const saved = await pickYoutubeChannel(o.auth, o.orgId, { pendingId: p.id, channelId: ch.id }, fake);
    expect(saved.existing).toBe(false);
    const [stored] = await sql<{ channel_created_at: Date | null }[]>`
      select channel_created_at from org_youtube_connections where id = ${saved.connectionId}`;
    expect(stored!.channel_created_at?.toISOString(), "the connect stored the channel's creation date").toBe(fiveDaysAgo.toISOString());

    // ── 2. the safety route (Task 4) warns, from the STORED date ────────────────────────────────────────────────────────
    // YouTube is now told the channel is OLD: only a read of the stored column can still answer "young".
    fake.setChannelCreatedAt(ch.id, new Date(Date.now() - 400 * DAY));
    const callsBeforeSafety = fake.calls.length;
    const res = await safetyRoute(
      new Request(`http://localhost/api/v1/orgs/${o.orgId}/youtube-connections/${saved.connectionId}/safety`),
      { params: Promise.resolve({ id: o.orgId, connectionId: saved.connectionId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { warn: boolean; young: boolean; shortRecent: number } };
    expect(body.data).toEqual({ warn: true, young: true, shortRecent: 0 });
    expect(fake.calls.slice(callsBeforeSafety).map((c) => c.method), "the stored date is read, not asked of YouTube again")
      .not.toContain("channelCreatedAt");
    expect(fake.calls.slice(callsBeforeSafety).map((c) => c.method), "the route's facts are read at YouTube").toContain("recentBroadcasts");

    // ── the match: a division of three fixtures, one with a venue and a start time ──────────────────────────────────────
    const d = await divisionRig(o.auth, { entrants: 3 });
    const [fAuto, fHuman, fAfter] = d.fixtureIds as [string, string, string];
    const startsAt = "2026-12-05T14:30:00Z";
    await sql`update organizations set default_locale = 'en', timezone = 'Europe/London' where id = ${o.orgId}`;
    await sql`update fixtures set scheduled_at = ${startsAt}, venue = 'Hall 2' where id = ${fHuman}`;
    const targetId = saved.targetId;
    const T0 = new Date();
    const prep = (fixtureId: string, now: Date, startCause: StartCause) =>
      prepareYoutubeBroadcast({ orgId: o.orgId, fixtureId, targetId, now, startCause }, fake);
    const backoff = async () => (await sql<{ auto_backoff_count: number; auto_retry_after: Date | null; auto_backoff_code: string | null }[]>`
      select auto_backoff_count, auto_retry_after, auto_backoff_code from org_youtube_connections where id = ${saved.connectionId}`)[0]!;
    const inserts = () => fake.calls.filter((c) => c.method === "insertBroadcast").length;

    // ── 3. an automatic start YouTube refuses opens the backoff (Task 1); the next is refused from the window, no port call ─
    fake.failNext("insertBroadcast", "youtube_limit_reached");
    const first = await refusal(prep(fAuto, T0, "automatic"));
    expect([first.code, first.status]).toEqual(["youtube_limit_reached", 429]);
    expect(inserts(), "the first refusal was YouTube's: one call").toBe(1);
    expect(await backoff()).toMatchObject({
      auto_backoff_count: 1, auto_backoff_code: "youtube_limit_reached",
      auto_retry_after: new Date(T0.getTime() + YOUTUBE_AUTO_BACKOFF_BASE_SECONDS * 1000),
    });
    const callsBefore = fake.calls.length;
    const second = await refusal(prep(fAuto, new Date(T0.getTime() + 10_000), "automatic"));
    expect([second.code, second.status]).toEqual(["youtube_limit_reached", 429]);
    expect(fake.calls.length, "the second refusal came from the window: no call to YouTube").toBe(callsBefore);

    // ── 4. the organiser's Go live inside the window asks YouTube, proceeds and clears the backoff ─────────────────────────
    const human = await prep(fHuman, new Date(T0.getTime() + 20_000), "organiser");
    expect(human).not.toBeNull();
    expect(fake.calls.length, "a person's tap is not held by the window").toBeGreaterThan(callsBefore);
    expect(await backoff()).toEqual({ auto_backoff_count: 0, auto_retry_after: null, auto_backoff_code: null });
    // and the automatic start asks YouTube again (the window no longer exists)
    const insertsBefore = inserts();
    expect(await prep(fAfter, new Date(T0.getTime() + 21_000), "automatic")).not.toBeNull();
    expect(inserts()).toBe(insertsBefore + 1);

    // ── 5. the description the fake recorded carries the facts (Task 5), in the order the dictionary words them ──────────
    const [row] = await sql<{ yt: string }[]>`
      select yt_broadcast_id as yt from youtube_broadcasts where id = ${human!.broadcastId}`;
    const recorded = fake.inspectBroadcast(row!.yt)!.description;
    const [{ comp, sportKey, roundNo }] = await sql<{ comp: string; sportKey: string; roundNo: number }[]>`
      select c.name as comp, d.sport_key as "sportKey", f.round_no as "roundNo"
        from fixtures f join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id where f.id = ${fHuman}`;
    const lines = recorded.split("\n\n")[0]!.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(`${(en as Record<string, string>)[`sport.${sportKey}`]} · ${en["schedule.round"].replace("{n}", String(roundNo))}`);
    expect(lines[1]).toBe(comp);
    expect(lines[2]).toBe("Hall 2");
    expect(lines[3]).toContain("Saturday, December 5, 2026");
    expect(lines[3]).toMatch(/2:30\sPM/);   // 14:30 UTC is 14:30 in London in December
  });
});
