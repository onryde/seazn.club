// Phase 0 (YouTube channel safety) Task 6: the SEAM PROOF. Tasks 1-5 each have their own suite; this one drives the REAL producers and
// consumers of all five end to end, on ONE channel, in one journey, against the fake port (the only fake): a unit-green seam that nothing
// in production reaches (AGENTS.md failure class 1, "the inert seam") fails here.
//
//   1. connect through the real save (pickYoutubeChannel = saveConnectionFromGrant + recordChannelCreatedAt) -> channel_created_at stored
//   2. the REAL safety route handler warns for that 5-day-old channel, reading the STORED date (the fake is then told a different one)
//   3. the AUTOMATIC start, through its real caller (a phone beat -> postBeat -> maybeAutoStart -> startBroadcast, cause "automatic"):
//      two beats YouTube refuses `youtube_limit_reached` open and double the backoff; the third beat, inside the window, is refused from
//      it with the fake's call count UNCHANGED
//   4. the organiser's Go live, through its real caller (createSession, cause "organiser"), inside the window asks YouTube, succeeds and
//      clears the backoff
//   5. the description the fake recorded for that broadcast carries the fact lines (sport . round, competition, venue, date and time)
//
// Phase 0 review m5: the cause is set by each CALLER, never handed to prepare here, so a caller that sends the wrong cause turns this red
// (an automatic start sent as "organiser" would ask YouTube in step 3; a Go live sent as "automatic" would be refused in step 4).
// Three beats, not two: the base window (60 s) equals the retry spacing (AUTO_START_RETRY_SECONDS) and ends at its own instant, so the
// window bites from the second refusal in a row (lib/youtube.ts, accepted at Task 1).
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
import { YOUTUBE_AUTO_BACKOFF_BASE_SECONDS, YOUTUBE_YOUNG_CHANNEL_DAYS } from "@/lib/youtube";
import { GET as safetyRoute } from "@/app/api/v1/orgs/[id]/youtube-connections/[connectionId]/safety/route";
import { CaptureBeat } from "@/server/api-v1/capture-schemas";
import { AUTO_START_RETRY_SECONDS } from "@/server/relay/config";
import { postBeat } from "@/server/usecases/capture-phone";
import { saveStreamSettings } from "@/server/usecases/stream-codes";
import { createSession } from "@/server/usecases/stream-sessions";
import { captureRig, phoneId, type CaptureRig } from "@/server/usecases/__tests__/_capture-rig";
import { setYoutubeDriverForTest } from "@/server/youtube/driver";
import { FakeYouTube } from "@/server/youtube/fake";
import { pickYoutubeChannel } from "@/server/youtube/connections";
import { channelId, grant, type Org } from "./_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const DAY = 86_400_000;
const SEC = 1000;

// The capture rig's environment (as stream-auto.test.ts sets it): the KEKs fresh, the relay's own switches at their defaults.
const ENV_KEYS = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.AUTH_SECRET = "channel-safety-seam-secret";
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
afterEach(() => setYoutubeDriverForTest(null));

/** One AUTOMATIC phone's beat at the rig's clock, through the real postBeat (which calls maybeAutoStart). */
async function beat(r: CaptureRig, phone: string, over: Record<string, unknown> = {}) {
  return postBeat(r.code, r.tok, CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "automatic", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "channel-safety-seam/1", ...over,
  }), r.deps, r.now());
}

describe.skipIf(!HAS_DB)("Phase 0 channel safety: one journey through every seam", () => {
  it("connect -> safety warns -> automatic refusals back off -> Go live clears it -> the description carries the facts", async () => {
    const r = await captureRig({ credits: 3 });
    const o: Org = { auth: r.auth, orgId: r.auth.orgId, userId: r.auth.userId! };
    // The rig's organiser is a fresh user: a member of the org, so the session door of the safety route admits them.
    await sql`insert into org_members (org_id, user_id, role) values (${o.orgId}, ${o.userId}, 'owner')`;
    authState.userId = o.userId;
    const fake = new FakeYouTube({ now: r.now });
    setYoutubeDriverForTest(fake);
    r.deps.youtube = fake;
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

    // ── the match: the rig's fixture, with a venue and a start time, streaming automatically to the connected channel ────────
    const fx = r.fixtureId;
    const startsAt = "2026-12-05T14:30:00Z";
    await sql`update organizations set default_locale = 'en', timezone = 'Europe/London' where id = ${o.orgId}`;
    await sql`update fixtures set scheduled_at = ${startsAt}, venue = 'Hall 2', status = 'in_play' where id = ${fx}`;
    const phone = phoneId("a");
    await beat(r, phone, { claim: "new", mode: "operator" });
    await saveStreamSettings(r.auth, fx, { autoStream: true, targetId: saved.targetId });
    const backoff = async () => (await sql<{ auto_backoff_count: number; auto_retry_after: Date | null; auto_backoff_code: string | null }[]>`
      select auto_backoff_count, auto_retry_after, auto_backoff_code from org_youtube_connections where id = ${saved.connectionId}`)[0]!;
    const refusalStored = async () => (await sql<{ auto_start_refusal: string | null; auto_start_attempted_at: Date | null }[]>`
      select auto_start_refusal, auto_start_attempted_at from fixture_stream_settings where fixture_id = ${fx}`)[0]!;
    const inserts = () => fake.calls.filter((c) => c.method === "insertBroadcast").length;

    // ── 3. the automatic start (Task 1), through its real caller: YouTube refuses twice, the window opens and doubles; the third beat
    //       is refused from the window with NO call to YouTube ──────────────────────────────────────────────────────────────────
    const T0 = r.now();
    fake.failNext("insertBroadcast", "youtube_limit_reached");
    await beat(r, phone);
    expect(inserts(), "the first refusal was YouTube's: one call").toBe(1);
    expect((await refusalStored()).auto_start_refusal, "the automatic start ran and was refused").toBe("unavailable");
    expect(await backoff()).toMatchObject({
      auto_backoff_count: 1, auto_backoff_code: "youtube_limit_reached",
      auto_retry_after: new Date(T0.getTime() + YOUTUBE_AUTO_BACKOFF_BASE_SECONDS * SEC),
    });
    r.tick(AUTO_START_RETRY_SECONDS * SEC);
    fake.failNext("insertBroadcast", "youtube_limit_reached");
    await beat(r, phone);
    expect(inserts(), "at the spacing the base window has closed: YouTube asked again").toBe(2);
    expect((await backoff()).auto_backoff_count, "the second refusal in a row doubles the window").toBe(2);
    const callsBefore = fake.calls.length;
    r.tick(AUTO_START_RETRY_SECONDS * SEC);
    await beat(r, phone);
    expect((await refusalStored()).auto_start_attempted_at?.getTime(), "PREMISE: the third beat made an attempt").toBe(r.now().getTime());
    expect(fake.calls.length, "the third refusal came from the window: no call to YouTube").toBe(callsBefore);

    // ── 4. the organiser's Go live inside the window, through its real caller, asks YouTube, proceeds and clears the backoff ──────────
    r.tick(10 * SEC);
    const { sessionId } = await createSession(r.auth, fx, { mode: "passthrough", targetId: saved.targetId }, r.deps);
    expect(fake.calls.length, "a person's tap is not held by the window").toBeGreaterThan(callsBefore);
    expect(await backoff()).toEqual({ auto_backoff_count: 0, auto_retry_after: null, auto_backoff_code: null });
    const [human] = await sql<{ broadcastId: string }[]>`
      select youtube_broadcast_id as "broadcastId" from fixture_stream_sessions where id = ${sessionId}`;
    expect(human?.broadcastId, "the Go live streams into a prepared broadcast").toBeTruthy();

    // ── 5. the description the fake recorded carries the facts (Task 5), in the order the dictionary words them ──────────
    const [row] = await sql<{ yt: string }[]>`
      select yt_broadcast_id as yt from youtube_broadcasts where id = ${human!.broadcastId}`;
    const recorded = fake.inspectBroadcast(row!.yt)!.description;
    const [{ comp, sportKey, roundNo }] = await sql<{ comp: string; sportKey: string; roundNo: number }[]>`
      select c.name as comp, d.sport_key as "sportKey", f.round_no as "roundNo"
        from fixtures f join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id where f.id = ${fx}`;
    const lines = recorded.split("\n\n")[0]!.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(`${(en as Record<string, string>)[`sport.${sportKey}`]} · ${en["schedule.round"].replace("{n}", String(roundNo))}`);
    expect(lines[1]).toBe(comp);
    expect(lines[2]).toBe("Hall 2");
    expect(lines[3]).toContain("Saturday, December 5, 2026");
    expect(lines[3]).toMatch(/2:30\sPM/);   // 14:30 UTC is 14:30 in London in December
  });
});
