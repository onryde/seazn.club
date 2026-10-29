// YouTube Connect T17 (spec §6.6 "Daily", §6.8, §9.2; plan T17 with the post-T2 amendment; controller overrides O2 carries a-h, O3, O4):
// the DAILY YouTube pass on the relay-sweep cron - channel health, the 25-day refresh of stored video links, the 30-day purge of a
// dead grant, and the clean-up of rows the minute-by-minute end step can never settle.
//
// Everything runs through the REAL producers wherever one exists: Go live is the organiser's `createSession` against a FakeYouTube
// (prepare, the pool, the session insert and the attach are the real ones), Stop is `stopSession`, the replay link and the complete
// row are the REAL end step's (`endDueBroadcasts`), a dead grant is the fake's `killToken` met by the daily health check, a reconnect is
// the real connect save, a revoke is token-store's `revokeConnection`, and a row that cannot settle is the real end step failing
// again and again against a refusing fake. Rows are built by SQL only where no producer can make the shape or the count (120 complete
// rows for the batch test; an `ending` row with a budget-deferred claim is made by the real step with a scripted wall clock), and a
// test says so where it does. Time is moved the way the end-step suite moves it: the rows' own timestamps are shifted back by SQL
// ("a producer's output moved in time"), or the injected clock is scripted forward.
//
// Expected values are the spec's and Google's literals, typed here and never imported from the code under test:
//   - videos.list takes at most 50 ids per call; the stored video links are refreshed after 25 days (spec §6.6 "~25 days") and every
//     stored YouTube datum is gone 30 days after a grant dies (DP III.E.4, spec §6.8) or after a broadcast failed (the same 30 days,
//     DP III.E.4: the plan names no other retention for a failed row);
//   - the end step's retry backoff is 1, 2, 4, 8, 16, 32, then 60 minutes (P6). The stuck-row bound is "a row that has failed for a
//     full DAY at the 60-minute cap": 7 failures to reach the cap (the 7th is the first to store 60) + 24 more at it = 31 failures; the
//     waits stored after failures 1-6 are 63 minutes and after failures 7-30 are 24 * 60, so 63 + 24 * 60 = 1503 minutes (typed, so a
//     change to the backoff reds this file and forces a conscious re-decision of the bound);
//   - the destination row a revoke archives is labelled "YouTube channel (disconnected)".
// Sport: not applicable - streaming is sport-agnostic (global-constraints "Test rules"); every rig rides `generic`.
// Secrets: a token / key is compared by absence or fingerprint, so a failing assertion never prints one.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

/** fireDivisionRevalidate, spied: a pass-through that records each call (a removed part must expire the public match page). */
const revalidateHook = vi.hoisted(() => ({ calls: [] as { divisionId: string; competitionId: string | undefined }[] }));
vi.mock("@/server/public-site/revalidate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/public-site/revalidate")>();
  return {
    ...real,
    fireDivisionRevalidate: vi.fn((divisionId: string, competitionId?: string) => {
      revalidateHook.calls.push({ divisionId, competitionId });
      return real.fireDivisionRevalidate(divisionId, competitionId);
    }),
  };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { youtubeWatchUrl } from "@/lib/youtube";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { pairPresentPhone, rigUser, spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import { divisionRig, seedOrg } from "@/server/usecases/__tests__/_rig";
import { grantCredits } from "@/server/usecases/stream-credits";
import { createSession as organiserStart, currentSession, stopSession, type SessionDeps } from "@/server/usecases/stream-sessions";
import type { AuthCtx } from "@/server/api-v1/auth";
import { connectionViews, saveConnectionFromGrant } from "../connections";
import {
  YOUTUBE_DATA_CEILING_DAYS, YOUTUBE_END_STUCK_AFTER_ATTEMPTS, YOUTUBE_END_STUCK_AFTER_MINUTES, deriveStuckBounds, purgeConnectionData, youtubeDaily,
  type PurgeResult, type YoutubeDailyResult,
} from "../daily";
import { CLAIM_LEASE_MINUTES, endBackoffMinutes, endDueBroadcasts, type EndStepHooks, type YoutubeEndResult } from "../end-step";
import { FakeYouTube } from "../fake";
import { YouTubeError, type YouTubePort } from "../port";
import { markReconnectNeeded, openToken, replaceConnectionToken, revokeConnection } from "../token-store";
import { connect as connectChannel, grant, refreshToken, type Ch, type Org } from "./_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;

// ---- spec and Google literals -------------------------------------------------------------------------------------------
const MIN = 60_000;
const GRACE_MINUTES = 5;
const BUDGET_MS = 15_000;
const ROOMY_STORAGE_MINUTES = 100_000_000;
const VIDEOS_PER_CALL = 50;
const STUCK_ATTEMPTS = 31;        // 7 failures to reach the 60-minute cap + 24 more at it (P6, one full day)
const STUCK_MINUTES = 1503;       // 1 + 2 + 4 + 8 + 16 + 32 + 24 * 60
const P6_BACKOFF = [1, 2, 4, 8, 16, 32, 60, 60];
const DISCONNECTED_LABEL = "YouTube channel (disconnected)";
const CLUB_LINK = "https://example.com/club-stream";
const ZERO: YoutubeDailyResult = { checked: 0, reconnectNeeded: 0, refreshed: 0, removed: 0, keysRemoved: 0, purged: 0, failed: 0 };
const NO_END: YoutubeEndResult = { ended: 0, neverLive: 0, orphans: 0, failed: 0, deferred: 0 };
/** V479's shape check on a stored error code. */
const CODE_SHAPE = /^[a-z_:]{1,64}$/;

// ---- KEKs and the composed image ----------------------------------------------------------------------------------------
const ENV = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "RELAY_IMAGE"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:t17-test";
});
afterAll(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
beforeEach(() => {
  sentry.captureError.mockClear();
  revalidateHook.calls = [];
});

// ---- the world ----------------------------------------------------------------------------------------------------------
interface Chan { connectionId: string; targetId: string; token: string; channel: Ch }
interface World {
  auth: AuthCtx; orgId: string; userId: string; org: Org; fixtures: string[]; divisionId: string;
  connectionId: string; targetId: string; token: string; channel: Ch;
  fake: FakeYouTube; ingest: FakeIngest; runner: FakeRunner; deps: SessionDeps;
  /** The one injected clock: the session deps', the fake YouTube's, and what `step` hands the end step. */
  now(): number; setNow(ms: number): void; tick(ms: number): void;
  issued: { url: string; streamKey: string }[];
  /** One pass of the REAL end step on the injected clock, scoped to this org. */
  step(over?: { at?: number; wallClock?: () => number; hooks?: EndStepHooks }): Promise<YoutubeEndResult>;
  /** Video arrives on the broadcast's stream: YouTube makes it `live` (auto-start). */
  video(ytId: string): void;
  /** A further channel connected through the real save, known to this world's fake. */
  addChannel(): Promise<Chan>;
}

async function override(orgId: string, key: string, value: boolean) {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
            values (${orgId}, ${key}, ${value}, 't17 unit')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}

/** An org with the relay, `fixtures` fixtures each with a present phone, `credits` match credits, and a channel connected through the
 *  real save and KNOWN to the fake (`seedGrant`: the connection's channel id is the one the fake lists, as at connect). */
async function world(o: { fixtures?: number; credits?: number } = {}): Promise<World> {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  const n = o.fixtures ?? 1;
  let entrants = 2;
  while ((entrants * (entrants - 1)) / 2 < n) entrants++;
  const d = await divisionRig(auth, { entrants });
  if (d.fixtureIds.length < n) throw new Error(`rig made ${d.fixtureIds.length} fixtures, the test needs ${n}`);
  await override(auth.orgId, "streaming.overlay", true);
  await override(auth.orgId, "streaming.relay", true);
  const fixtures = d.fixtureIds.slice(0, n);
  for (const f of fixtures) await pairPresentPhone(f);
  if ((o.credits ?? 1) > 0) await grantCredits({ orgId: auth.orgId, delta: o.credits ?? 1, createdBy: await rigUser(), note: "t17", idempotencyKey: randomUUID() });
  await spendMonthlyStreamGrant(auth.orgId);
  const org: Org = { auth, orgId: auth.orgId, userId: auth.userId };

  let now = Date.now();
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs: 3000 });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const runner = new FakeRunner();
  const fake = new FakeYouTube({ now: () => new Date(now) });
  const issued: World["issued"] = [];
  const insertStream = fake.insertStream.bind(fake);
  fake.insertStream = async (at, a) => {
    const s = await insertStream(at, a);
    issued.push({ url: s.ingest.url, streamKey: s.ingest.streamKey });
    return s;
  };
  const addChannel = async (): Promise<Chan> => {
    const c = await connectChannel(org);
    fake.seedGrant({ refreshToken: c.token, channelId: c.channel.id, channelTitle: c.channel.title });
    return { connectionId: c.connectionId, targetId: c.targetId, token: c.token, channel: c.channel };
  };
  const first = await addChannel();
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(now), appUrl: "http://app.test", youtube: fake };
  return {
    auth, orgId: auth.orgId, userId: auth.userId, org, fixtures, divisionId: d.divisionId, ...first,
    fake, ingest, runner, deps,
    now: () => now, setNow: (ms) => { now = ms; }, tick: (ms) => { now += ms; },
    issued,
    step: (over = {}) => {
      if (over.at !== undefined) now = over.at;
      return endDueBroadcasts(fake, {
        now: () => new Date(now), budgetMs: BUDGET_MS, orgIds: [auth.orgId], ...(over.wallClock ? { wallClock: over.wallClock } : {}), ...(over.hooks ? { hooks: over.hooks } : {}),
      });
    },
    video: (ytId) => {
      const stream = fake.inspectBroadcast(ytId)?.streamId;
      if (!stream) throw new Error("premise: the broadcast is bound to a stream");
      fake.videoOn(stream);
    },
    addChannel,
  };
}

/** One daily pass over this world's org (the `orgIds` seam: an unscoped pass would health-check, refresh and PURGE every other
 *  suite's rows in the shared database). `now` defaults to the real clock, which is the clock rows are shifted against. */
const daily = (w: Pick<World, "orgId" | "fake">, over: { now?: Date; port?: YouTubePort; orgIds?: string[] } = {}) =>
  youtubeDaily(over.port ?? w.fake, over.now ?? new Date(), { orgIds: over.orgIds ?? [w.orgId] });

/** The organiser's Go live, on the start's own clock (W5 needs the phone present at it). */
async function goLive(w: World, fixtureId: string) {
  await pairPresentPhone(fixtureId, { at: w.deps.now() });
  return organiserStart(w.auth, fixtureId, { mode: "passthrough", targetId: w.targetId }, w.deps);
}

interface SessionRow { id: string; state: string; youtube_broadcast_id: string | null; ended_at: Date | null }
const sessionRow = async (id: string): Promise<SessionRow> =>
  (await sql<SessionRow[]>`select id, state, youtube_broadcast_id, ended_at from fixture_stream_sessions where id = ${id}`)[0]!;
interface BRow {
  id: string; fixture_id: string; connection_id: string; state: string; key_id: string | null; yt_broadcast_id: string | null;
  last_error_code: string | null; attempts: number; next_attempt_at: Date | null; claimed_at: Date | null; completed_at: Date | null;
  refreshed_at: Date;
}
/** The column list, built when a query is built (never at module scope: a `sql` fragment opens the pooled client, and without a database
 *  that throws while the file is COLLECTED, before `describe.skipIf(!HAS_DB)` can skip it - the no-DB unit job). */
const bCols = () => sql`id, fixture_id, connection_id, state, key_id, yt_broadcast_id, last_error_code, attempts, next_attempt_at, claimed_at,
                  completed_at, refreshed_at`;
const broadcastRow = async (id: string): Promise<BRow> => (await sql<BRow[]>`select ${bCols()} from youtube_broadcasts where id = ${id}`)[0]!;
const broadcastsOfConnection = (connectionId: string) =>
  sql<BRow[]>`select ${bCols()} from youtube_broadcasts where connection_id = ${connectionId} order by created_at, id`;
const keysOf = async (connectionId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from youtube_stream_keys where connection_id = ${connectionId}`)[0]!.n;
const streamUrlOf = async (fixtureId: string) =>
  (await sql<{ stream_url: string | null }[]>`select stream_url from fixtures where id = ${fixtureId}`)[0]!.stream_url;
interface ConnRow {
  status: string; status_since: Date; last_health_at: Date | null; last_error_code: string | null; channel_id: string | null;
  channel_title: string | null; google_sub: string | null; revoked_at: Date | null;
}
const connRow = async (id: string): Promise<ConnRow> =>
  (await sql<ConnRow[]>`select status, status_since, last_health_at, last_error_code, channel_id, channel_title, google_sub, revoked_at
                          from org_youtube_connections where id = ${id}`)[0]!;
const targetsOf = (connectionId: string) =>
  sql<{ id: string; label: string; archived_at: Date | null; watch_url: string | null }[]>`
    select id, label, archived_at, watch_url from org_stream_targets where youtube_connection_id = ${connectionId} order by created_at, id`;
const pendingCount = async (id: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from youtube_connect_pending where id = ${id}`)[0]!.n;
/** What the DAILY pass reported to Sentry (the end step reports its own faults under its own routes; this file's end-step passes are not under test). */
const dailyReports = () => sentry.captureError.mock.calls.filter((c) => String((c[1] as { route?: string } | undefined)?.route ?? "").startsWith("youtube.daily"));
const min = (n: number) => n * MIN;
const liveStateOf = async (w: Pick<World, "orgId">, connectionId: string) => (await connectionViews(w.orgId)).get(connectionId)?.liveState;

/** Shift a column back in time on the database's clock (a producer's output moved in time). */
const shiftConnection = (id: string, days: number) =>
  sql`update org_youtube_connections set status_since = now() - (${days}::float8 * interval '1 day') where id = ${id}`;
const shiftBroadcasts = (ids: string[], col: "refreshed_at" | "completed_at", days: number) =>
  col === "refreshed_at"
    ? sql`update youtube_broadcasts set refreshed_at = now() - (${days}::float8 * interval '1 day') where id = any(${ids}::uuid[])`
    : sql`update youtube_broadcasts set completed_at = now() - (${days}::float8 * interval '1 day') where id = any(${ids}::uuid[])`;

interface KeyRow { id: string; slot: number; live_stream_id: string; retired_at: Date | null; created_at: Date }
const keyRows = (connectionId: string) =>
  sql<KeyRow[]>`select id, slot, live_stream_id, retired_at, created_at from youtube_stream_keys where connection_id = ${connectionId} order by slot, created_at`;
const keyIdOf = async (broadcastId: string): Promise<string | null> =>
  (await sql<{ key_id: string | null }[]>`select key_id from youtube_broadcasts where id = ${broadcastId}`)[0]!.key_id;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Hold a connection row `for update` in another transaction (what Go live's pick and a disconnect's purge take), until `release()`. */
async function holdConnection(connectionId: string): Promise<{ release: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  let locked!: () => void;
  const held = new Promise<void>((r) => { locked = r; });
  const tx = sql.begin(async (t) => {
    await t`select 1 from org_youtube_connections where id = ${connectionId} for update`;
    locked();
    await gate;
  });
  await held;
  return { release: async () => { open(); await tx; } };
}

/** Passthrough: the fake ingest connects 3 s after its input was made; the session goes live on the next read. */
async function reachLive(w: World, fixtureId: string): Promise<void> {
  w.tick(3000);
  expect((await currentSession(w.auth, fixtureId, w.deps))!.state, "premise: the session went live").toBe("live");
}

/** Go live → live → video arrives → a minute of play → Stop. Returns the Stop's recorded ended_at. */
interface Match { sessionId: string; broadcastId: string; ytId: string; endedAt: Date }
async function playAndStop(w: World, fixtureId: string): Promise<Match> {
  const { sessionId } = await goLive(w, fixtureId);
  await reachLive(w, fixtureId);
  const s = await sessionRow(sessionId);
  const b = await broadcastRow(s.youtube_broadcast_id!);
  w.tick(1000);
  w.video(b.yt_broadcast_id!);
  w.tick(MIN);
  await stopSession(w.auth, fixtureId, sessionId, w.deps);
  expect((await sessionRow(sessionId)).state, "premise: the Stop carried the session to its end").toBe("completed");
  w.fake.videoOff(w.fake.inspectBroadcast(b.yt_broadcast_id!)!.streamId!);
  const ended = (await sessionRow(sessionId)).ended_at;
  expect(ended, "premise: the Stop wrote ended_at").toBeInstanceOf(Date);
  return { sessionId, broadcastId: b.id, ytId: b.yt_broadcast_id!, endedAt: ended! };
}
const afterStop = (m: Match, ms: number) => m.endedAt.getTime() + ms;

/** A match played, stopped and ENDED by the real end step: a `complete` row and the replay link on the fixture. */
async function completedMatch(w: World, fixtureId: string): Promise<Match> {
  const m = await playAndStop(w, fixtureId);
  expect(await w.step({ at: afterStop(m, min(6)) }), "premise: the real end step completed it").toMatchObject({ ended: 1 });
  expect((await broadcastRow(m.broadcastId)).state).toBe("complete");
  return m;
}

/** Drive the REAL end step until the row has failed `n` times: the first pass runs at `firstAt` (when the broadcast falls due), each
 *  later one at the instant the row's own backoff says. Returns the wait (minutes) the step stored after each failure it caused. */
async function failTo(w: World, broadcastId: string, n: number, firstAt: number): Promise<number[]> {
  const waits: number[] = [];
  for (let guard = 0; guard < n + 10; guard++) {
    const b = await broadcastRow(broadcastId);
    if (b.attempts >= n) return waits;
    const at = Math.max(w.now(), b.next_attempt_at?.getTime() ?? firstAt);
    await w.step({ at });
    const after = await broadcastRow(broadcastId);
    if (after.attempts === b.attempts + 1) waits.push((after.next_attempt_at!.getTime() - at) / MIN);
  }
  throw new Error(`premise: the row never reached ${n} failures`);
}

/** The fake refuses `complete` for good: a permanent refusal (a live broadcast the API will not transition). */
const refuseComplete = (f: FakeYouTube) => {
  f.complete = async () => { throw new YouTubeError("youtube_unavailable", "invalidTransition"); };
};

/** Complete rows built by SQL (no producer makes 120 of them): real broadcasts at the fake, owned by the connection's channel. */
async function seedCompleteRows(w: World, c: Chan, n: number, ageDays: number): Promise<{ id: string; ytId: string }[]> {
  const at = await w.fake.accessToken(c.token);
  const out: { id: string; ytId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const { broadcastId } = await w.fake.insertBroadcast(at, { title: `t17 part ${i}`, description: "", scheduledStart: new Date(), privacy: "unlisted", madeForKids: false });
    const [row] = await sql<{ id: string }[]>`
      insert into youtube_broadcasts (org_id, connection_id, fixture_id, title, privacy, state, yt_broadcast_id, completed_at, refreshed_at)
      values (${w.orgId}, ${c.connectionId}, ${w.fixtures[0]!}, ${`t17 part ${i}`}, 'unlisted', 'complete', ${broadcastId}, now(),
              now() - (${ageDays}::float8 * interval '1 day'))
      returning id`;
    out.push({ id: row!.id, ytId: broadcastId });
  }
  return out;
}

describe.skipIf(!HAS_DB)("YouTube Connect T17 - the daily pass", () => {
  // ═══ the empty case, the seam, the scope ═══════════════════════════════════════════════════════════════════════════════
  it("EMPTY CASE FIRST: an org with no connection at all -> every counter 0 and YouTube is asked nothing; the same pass then checks a real one (the positive pair)", async () => {
    const empty = await seedOrg();
    const fake = new FakeYouTube();
    expect(await youtubeDaily(fake, new Date(), { orgIds: [empty.auth.orgId] })).toEqual(ZERO);
    expect(fake.calls, "nothing to check, nothing to ask").toEqual([]);

    const w = await world();
    expect(await daily(w)).toEqual({ ...ZERO, checked: 1 });
    expect(w.fake.calls.length, "a connected channel IS asked").toBeGreaterThan(0);
  });

  it("orgIds: [] is refused (an empty filter must never read as 'every org'); a named org is accepted", async () => {
    const w = await world();
    await expect(youtubeDaily(w.fake, new Date(), { orgIds: [] })).rejects.toThrow(/orgIds is empty/);
    expect(w.fake.calls, "refused before it asked YouTube anything").toEqual([]);
    await expect(youtubeDaily(w.fake, new Date(), { orgIds: [w.orgId] })).resolves.toMatchObject({ checked: 1 });
  });

  // ═══ health ════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("channel health", () => {
    it("a healthy channel: last_health_at is stamped and the Directory view reads 'enabled' (it read 'unknown' before the first check)", async () => {
      const w = await world();
      expect(await liveStateOf(w, w.connectionId), "premise: never checked").toBe("unknown");
      expect(await daily(w)).toEqual({ ...ZERO, checked: 1 });
      const row = await connRow(w.connectionId);
      expect(row).toMatchObject({ status: "connected", last_error_code: null });
      expect(row.last_health_at).toBeInstanceOf(Date);
      expect(await liveStateOf(w, w.connectionId)).toBe("enabled");
      expect(sentry.captureError, "a normal day reports nothing").not.toHaveBeenCalled();
    });

    it("O2 f: last_health_at is stamped on the DATABASE's clock, so a pass whose own clock runs BEHIND still reads as a fresh check (an app-clock stamp would sit before status_since and read 'unknown')", async () => {
      const w = await world();
      const behind = new Date(Date.now() - 60 * MIN);
      expect(await daily(w, { now: behind })).toMatchObject({ checked: 1 });
      const row = await connRow(w.connectionId);
      expect(row.last_health_at!.getTime(), "the stamp is the database's now, not the pass's").toBeGreaterThan(row.status_since.getTime() - 1);
      expect(await liveStateOf(w, w.connectionId)).toBe("enabled");
    });

    it("invalid_grant -> reconnect_needed with status_since NOW (the purge clock starts); a second pass leaves it alone and asks YouTube nothing", async () => {
      const w = await world();
      await shiftConnection(w.connectionId, 2);   // connected for two days: a flip that left status_since alone would show
      const before = await connRow(w.connectionId);
      w.fake.killToken(w.token);
      expect(await daily(w)).toEqual({ ...ZERO, checked: 1, reconnectNeeded: 1 });
      const row = await connRow(w.connectionId);
      expect(row).toMatchObject({ status: "reconnect_needed", last_error_code: "youtube_reconnect_needed" });
      expect(row.status_since.getTime(), "status_since moved to now (strictly later than two days ago)").toBeGreaterThan(before.status_since.getTime());
      expect(row.status_since.getTime() - before.status_since.getTime(), "... by about those two days").toBeGreaterThan(2 * 24 * 60 * MIN - 60 * MIN);
      expect(await liveStateOf(w, w.connectionId), "a dead grant cannot be asked, so the state is unknown").toBe("unknown");

      const calls = w.fake.calls.length;
      expect(await daily(w), "a connection that is not connected is not health-checked").toEqual(ZERO);
      expect(w.fake.calls.length).toBe(calls);
      expect((await connRow(w.connectionId)).status_since).toEqual(row.status_since);
    });

    it("liveEnabled 'not_enabled' -> last_error_code youtube_live_not_enabled, status stays connected, the view says 'not_enabled'; enabled again -> cleared (the sequence)", async () => {
      const w = await world();
      w.fake.setLive("not_enabled", { channelId: w.channel.id });
      expect(await daily(w)).toEqual({ ...ZERO, checked: 1 });
      expect(await connRow(w.connectionId)).toMatchObject({ status: "connected", last_error_code: "youtube_live_not_enabled" });
      expect(await liveStateOf(w, w.connectionId)).toBe("not_enabled");
      w.fake.setLive("enabled", { channelId: w.channel.id });
      expect(await daily(w)).toEqual({ ...ZERO, checked: 1 });
      expect(await connRow(w.connectionId)).toMatchObject({ status: "connected", last_error_code: null });
      expect(await liveStateOf(w, w.connectionId)).toBe("enabled");
    });

    it("RF5: live blocked -> the Directory view's liveState 'blocked' (status stays connected)", async () => {
      const w = await world();
      w.fake.setLive("blocked", { channelId: w.channel.id });
      await daily(w);
      expect(await connRow(w.connectionId)).toMatchObject({ status: "connected", last_error_code: "youtube_live_blocked" });
      expect(await liveStateOf(w, w.connectionId)).toBe("blocked");
    });

    it("RF5: the channel was renamed at YouTube -> channel_title AND the destination row's label follow; the next pass changes nothing; an empty title from Google is ignored", async () => {
      const w = await world();
      const [dest0] = await targetsOf(w.connectionId);
      expect(dest0!.label, "premise: the label is the channel's title").toBe(w.channel.title);
      w.fake.renameChannel(w.channel.id, "Riverside FC (renamed)");
      await daily(w);
      expect((await connRow(w.connectionId)).channel_title).toBe("Riverside FC (renamed)");
      const [dest] = await targetsOf(w.connectionId);
      expect(dest).toMatchObject({ id: dest0!.id, label: "Riverside FC (renamed)", archived_at: null });
      expect((await connectionViews(w.orgId)).get(w.connectionId)!.channelTitle).toBe("Riverside FC (renamed)");

      await daily(w);
      expect((await targetsOf(w.connectionId))[0]!.label, "a second pass: unchanged").toBe("Riverside FC (renamed)");
      w.fake.renameChannel(w.channel.id, "");
      await daily(w);
      expect((await connRow(w.connectionId)).channel_title, "an empty title never replaces a real one").toBe("Riverside FC (renamed)");
      expect((await targetsOf(w.connectionId))[0]!.label).toBe("Riverside FC (renamed)");
    });

    it("O2 g: insufficientLivePermissions on the live probe is a CHANNEL fact like live_blocked - status stays connected, NO purge clock (status_since untouched); any other reconnect refusal on the same call still flips it (the positive pair)", async () => {
      const w = await world();
      const before = await connRow(w.connectionId);
      w.fake.failNext("liveEnabled", "youtube_reconnect_needed", "insufficientLivePermissions", { channelId: w.channel.id });
      expect(await daily(w)).toEqual({ ...ZERO, checked: 1 });
      const row = await connRow(w.connectionId);
      expect(row).toMatchObject({ status: "connected", last_error_code: "youtube_live_blocked" });
      expect(row.status_since, "no purge clock").toEqual(before.status_since);
      expect(await liveStateOf(w, w.connectionId)).toBe("blocked");

      w.fake.failNext("liveEnabled", "youtube_reconnect_needed", "authError", { channelId: w.channel.id });
      expect(await daily(w)).toEqual({ ...ZERO, checked: 1, reconnectNeeded: 1 });
      expect((await connRow(w.connectionId)).status).toBe("reconnect_needed");
    });

    it("a connection revoked AFTER the pass listed it and BEFORE its token was opened is skipped: not checked, YouTube is asked nothing, nothing fails (the stranded leg then purges what it held)", async () => {
      const w = await world();
      let ran = 0;
      const out = await youtubeDaily(w.fake, new Date(), {
        orgIds: [w.orgId],
        hooks: { afterConnectionsListed: async () => { expect(await revokeConnection(sql, w.orgId, w.connectionId)).toBe(true); ran++; } },
      });
      expect(ran, "premise: the connection was listed").toBe(1);
      // Not checked, nothing failed, YouTube asked nothing; the revoked connection still holds its Google account id, so the STRANDED
      // leg (a different guard) purges it in the same pass.
      expect(out).toEqual({ ...ZERO, purged: 1 });
      expect(w.fake.calls, "no token, no call").toEqual([]);
    });

    it("the connection's channel is gone from the grant's list -> reconnect_needed (nothing to stream to; the purge clock starts); a channel that IS listed beside others stays connected", async () => {
      const w = await world();
      const other = await w.addChannel();
      w.fake.removeChannel(w.channel.id);
      expect(await daily(w)).toEqual({ ...ZERO, checked: 2, reconnectNeeded: 1 });
      expect((await connRow(w.connectionId)).status).toBe("reconnect_needed");
      expect((await connRow(other.connectionId)).status, "the other channel's own listing is intact").toBe("connected");
    });

    it("YouTube not answering is a failure to retry tomorrow, not a state: failed 1, the connection untouched, nothing reported; the next pass is clean", async () => {
      const w = await world();
      w.fake.failNext("listMyChannels", "youtube_unavailable", "backendError", { channelId: w.channel.id });
      const before = await connRow(w.connectionId);
      expect(await daily(w)).toEqual({ ...ZERO, checked: 1, failed: 1 });
      expect(await connRow(w.connectionId)).toEqual(before);
      expect(sentry.captureError, "a port refusal is an expected state: recorded in the answer, not reported").not.toHaveBeenCalled();
      expect(await daily(w)).toEqual({ ...ZERO, checked: 1 });
    });

    it("a driver that throws something that is NOT a port refusal is reported once as a fresh error naming only its class (never its message), counted failed, and the pass goes on", async () => {
      const w = await world();
      const broken = Object.create(w.fake) as FakeYouTube;
      broken.listMyChannels = async () => { throw new TypeError("refresh_token=1//hunter2-leaked"); };
      expect(await daily(w, { port: broken })).toMatchObject({ checked: 1, failed: 1 });
      expect(sentry.captureError).toHaveBeenCalledTimes(1);
      const [err, ctx] = sentry.captureError.mock.calls[0]!;
      expect(JSON.stringify({ message: (err as Error).message, ctx })).not.toContain("hunter2");
      expect(JSON.stringify(ctx)).toContain(w.connectionId);
      expect((err as Error).message).toContain("TypeError");
    });

    it("a saved token that will not open (sealed under another key) is reported with the connection id only and counted failed; the connection is left as it was", async () => {
      const w = await world();
      const kek = process.env.YOUTUBE_TOKEN_KEK;
      process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
      try {
        expect(await daily(w)).toEqual({ ...ZERO, failed: 1 });
      } finally {
        process.env.YOUTUBE_TOKEN_KEK = kek;
      }
      expect(sentry.captureError).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(sentry.captureError.mock.calls[0])).not.toContain(w.token);
      expect((await connRow(w.connectionId)).status).toBe("connected");
      expect(w.fake.calls, "an unopenable token asks YouTube nothing").toEqual([]);
    });
  });

  // ═══ the 25-day refresh ════════════════════════════════════════════════════════════════════════════════════════════════
  describe("refresh of stored video links", () => {
    it("120 rows refreshed 26 days ago -> videos.list in batches of at most 50 (50, 50, 20); every one present -> refreshed_at is the pass's now", async () => {
      const w = await world();
      const rows = await seedCompleteRows(w, { connectionId: w.connectionId, targetId: w.targetId, token: w.token, channel: w.channel }, 120, 26);
      const sizes: number[] = [];
      const ask = w.fake.existingVideos.bind(w.fake);
      w.fake.existingVideos = async (at, ids) => { sizes.push(ids.length); return ask(at, ids); };
      const now = new Date();
      expect(await daily(w, { now })).toEqual({ ...ZERO, checked: 1, refreshed: 120 });
      expect(sizes).toEqual([VIDEOS_PER_CALL, VIDEOS_PER_CALL, 20]);
      const after = await broadcastsOfConnection(w.connectionId);
      expect(after.length, "nothing was removed").toBe(120);
      expect(after.every((r) => r.refreshed_at.getTime() === now.getTime()), "every row was stamped with the pass's now").toBe(true);
      expect(rows.length).toBe(120);

      sizes.length = 0;
      expect(await daily(w, { now }), "a second pass: nothing is stale any more").toEqual({ ...ZERO, checked: 1 });
      expect(sizes).toEqual([]);
    });

    it("rows refreshed 24 days ago are not asked about (EMPTY batch -> zero calls, the check still reported) while 26-day rows beside them are - the 25-day line is the boundary", async () => {
      const w = await world();
      const c: Chan = { connectionId: w.connectionId, targetId: w.targetId, token: w.token, channel: w.channel };
      const fresh = await seedCompleteRows(w, c, 3, 24);
      const stale = await seedCompleteRows(w, c, 2, 26);
      const asked: string[][] = [];
      const ask = w.fake.existingVideos.bind(w.fake);
      w.fake.existingVideos = async (at, ids) => { asked.push([...ids]); return ask(at, ids); };
      expect(await daily(w)).toEqual({ ...ZERO, checked: 1, refreshed: 2 });
      expect(asked.length).toBe(1);
      expect(asked[0]!.sort()).toEqual(stale.map((r) => r.ytId).sort());
      for (const r of fresh) expect(asked.flat(), "a 24-day row is not asked about").not.toContain(r.ytId);
    });

    it("each connection's rows are asked under THAT connection's token (a video of another channel is 'absent' to the wrong token and would be deleted): two channels, two calls, nothing removed", async () => {
      const w = await world();
      const a: Chan = { connectionId: w.connectionId, targetId: w.targetId, token: w.token, channel: w.channel };
      const b = await w.addChannel();
      await seedCompleteRows(w, a, 2, 26);
      await seedCompleteRows(w, b, 2, 26);
      const sizes: number[] = [];
      const ask = w.fake.existingVideos.bind(w.fake);
      w.fake.existingVideos = async (at, ids) => { sizes.push(ids.length); return ask(at, ids); };
      expect(await daily(w)).toEqual({ ...ZERO, checked: 2, refreshed: 4 });
      expect(sizes).toEqual([2, 2]);
    });

    it("a batch YouTube cannot answer is retried tomorrow (its rows keep their old refreshed_at); the other batches still go through", async () => {
      const w = await world();
      const c: Chan = { connectionId: w.connectionId, targetId: w.targetId, token: w.token, channel: w.channel };
      const rows = await seedCompleteRows(w, c, 70, 26);
      w.fake.failNext("existingVideos", "youtube_unavailable", "backendError", { channelId: w.channel.id });
      const now = new Date();
      expect(await daily(w, { now })).toEqual({ ...ZERO, checked: 1, refreshed: 20, failed: 1 });
      const stamped = (await broadcastsOfConnection(w.connectionId)).filter((r) => r.refreshed_at.getTime() === now.getTime());
      expect(stamped.length).toBe(20);
      expect(rows.length - stamped.length, "the failed batch's 50 rows are still stale").toBe(50);
      expect(await daily(w, { now }), "tomorrow's pass takes them").toEqual({ ...ZERO, checked: 1, refreshed: 50 });
    });

    it("§9.2: a video DELETED on YouTube -> the row is deleted AND fixtures.stream_url is cleared when it pointed at that video (the REAL end step wrote it); a club's own link on another deleted video is untouched; a video still there keeps its link and is refreshed", async () => {
      const w = await world({ fixtures: 3, credits: 3 });
      const [f1, f2, f3] = w.fixtures as [string, string, string];
      await sql`update fixtures set stream_url = ${CLUB_LINK} where id = ${f2}`;   // the club's link first: the end step never replaces it
      const m1 = await completedMatch(w, f1);
      const m2 = await completedMatch(w, f2);
      const m3 = await completedMatch(w, f3);
      expect(await streamUrlOf(f1), "premise: the end step wrote the replay link").toBe(youtubeWatchUrl(m1.ytId));
      expect(await streamUrlOf(f2), "premise: the club's link stood").toBe(CLUB_LINK);
      expect(await streamUrlOf(f3)).toBe(youtubeWatchUrl(m3.ytId));
      await shiftBroadcasts([m1.broadcastId, m2.broadcastId, m3.broadcastId], "refreshed_at", 26);
      w.fake.deleteVideo(m1.ytId);
      w.fake.deleteVideo(m2.ytId);
      revalidateHook.calls = [];

      expect(await daily(w)).toEqual({ ...ZERO, checked: 1, refreshed: 1, removed: 2 });
      expect(await streamUrlOf(f1), "a link that pointed at the deleted video is cleared").toBeNull();
      expect(await streamUrlOf(f2), "the club's own link is untouched").toBe(CLUB_LINK);
      expect(await streamUrlOf(f3), "a video that is still there keeps its link").toBe(youtubeWatchUrl(m3.ytId));
      expect(await sql`select 1 from youtube_broadcasts where id = ${m1.broadcastId}`).toHaveLength(0);
      expect(await sql`select 1 from youtube_broadcasts where id = ${m2.broadcastId}`).toHaveLength(0);
      expect((await broadcastRow(m3.broadcastId)).state).toBe("complete");
      expect(revalidateHook.calls.length, "the public match page is expired for the parts that went").toBeGreaterThan(0);
      expect(revalidateHook.calls.map((c) => c.divisionId)).toContain(w.divisionId);

      expect(await daily(w), "a second pass: nothing left to remove").toEqual({ ...ZERO, checked: 1 });
    });

    it("a stale row whose link is the club's own link to the SAME video in another form (youtu.be) is cleared - the rule is 'points at that video', not 'is the exact string'", async () => {
      const w = await world();
      const m = await completedMatch(w, w.fixtures[0]!);
      await sql`update fixtures set stream_url = ${`https://youtu.be/${m.ytId}`} where id = ${w.fixtures[0]!}`;
      await shiftBroadcasts([m.broadcastId], "refreshed_at", 26);
      w.fake.deleteVideo(m.ytId);
      expect(await daily(w)).toMatchObject({ removed: 1 });
      expect(await streamUrlOf(w.fixtures[0]!)).toBeNull();
    });

    it("a stale row whose video is gone leaves a link to a DIFFERENT YouTube video alone (the club's own link to someone else's stream): the rule is 'points at THAT video', not 'is a YouTube link' - and the row still goes", async () => {
      const w = await world();
      const m = await completedMatch(w, w.fixtures[0]!);
      const someoneElses = "https://www.youtube.com/watch?v=zZ9yY8xX7wW";   // an 11-character id that is not m's
      expect(someoneElses, "premise: it is not the removed video").not.toContain(m.ytId);
      await sql`update fixtures set stream_url = ${someoneElses} where id = ${w.fixtures[0]!}`;
      await shiftBroadcasts([m.broadcastId], "refreshed_at", 26);
      w.fake.deleteVideo(m.ytId);
      expect(await daily(w)).toMatchObject({ removed: 1 });
      expect(await sql`select 1 from youtube_broadcasts where id = ${m.broadcastId}`).toHaveLength(0);
      expect(await streamUrlOf(w.fixtures[0]!), "the other video's link is kept").toBe(someoneElses);
    });
  });

  // ═══ the dead-grant purge ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("dead-grant purge (DP III.E.4: 30 days)", () => {
    it("reconnect_needed for 31 days -> PURGED: broadcast rows gone, the key pool gone, stream_urls pointing at its videos cleared (a club's link kept), token cleared + status revoked + destination archived (token-store's revokeConnection), sub and pending reconnect cleared; 29 days -> untouched", async () => {
      const w = await world({ fixtures: 3, credits: 3 });
      const [f1, f2, f3] = w.fixtures as [string, string, string];
      await sql`update fixtures set stream_url = ${CLUB_LINK} where id = ${f2}`;
      const m1 = await completedMatch(w, f1);
      await completedMatch(w, f2);
      const open = await goLive(w, f3);   // an OPEN broadcast on the connection when its grant dies
      const pendingReconnect = await grant(w.org, { connectionId: w.connectionId, channels: [w.channel] });
      await sql`update org_stream_targets set watch_url = 'https://www.youtube.com/@club' where youtube_connection_id = ${w.connectionId}`;   // so the clearing is visible
      expect(await keysOf(w.connectionId), "premise: the pool holds keys").toBeGreaterThan(0);
      expect((await connRow(w.connectionId)).google_sub, "premise: the grant's account is recorded").not.toBeNull();

      // The health check finds the dead grant (the real producer of reconnect_needed) ...
      w.fake.killToken(w.token);
      expect(await daily(w)).toMatchObject({ reconnectNeeded: 1, purged: 0 });
      // ... 29 days later nothing is purged ...
      await shiftConnection(w.connectionId, 29);
      expect(await daily(w)).toEqual(ZERO);
      expect((await connRow(w.connectionId)).status).toBe("reconnect_needed");
      expect((await broadcastsOfConnection(w.connectionId)).length).toBe(3);
      expect(await keysOf(w.connectionId)).toBeGreaterThan(0);
      expect(await pendingCount(pendingReconnect.id)).toBe(1);

      // ... and at 31 days it is.
      await shiftConnection(w.connectionId, 31);
      revalidateHook.calls = [];
      expect(await daily(w)).toEqual({ ...ZERO, purged: 1 });
      const row = await connRow(w.connectionId);
      expect(row).toMatchObject({ status: "revoked", channel_id: null, channel_title: null, google_sub: null });
      expect(row.revoked_at).toBeInstanceOf(Date);
      expect(await openToken(sql, w.orgId, w.connectionId), "the token is cleared").toBeNull();
      const [dest] = await targetsOf(w.connectionId);
      expect(dest!.archived_at, "the destination is archived").toBeInstanceOf(Date);
      expect(dest).toMatchObject({ label: DISCONNECTED_LABEL, watch_url: null });
      expect((await broadcastsOfConnection(w.connectionId)).length, "every broadcast row of the connection is gone").toBe(0);
      expect(await keysOf(w.connectionId), "the pooled keys are YouTube data too: zero key rows").toBe(0);
      expect(await streamUrlOf(f1), "the link that pointed at its video is cleared").toBeNull();
      expect(await streamUrlOf(f2), "a club's own link is kept").toBe(CLUB_LINK);
      expect(await pendingCount(pendingReconnect.id), "a reconnect in flight for it is gone").toBe(0);
      expect((await sessionRow(open.sessionId)).youtube_broadcast_id, "the session survives its broadcast row").toBeNull();
      expect(revalidateHook.calls.map((c) => c.divisionId), "the public pages that listed the parts are expired").toContain(w.divisionId);
      expect(m1.ytId).toBeTruthy();   // m1 is the part whose link was cleared above

      expect(await daily(w), "a second pass finds nothing to purge").toEqual(ZERO);
    });

    it("the 30-day line is per connection inside ONE pass: 31 days dead is purged beside a 29-days-dead one and a connected one, both untouched", async () => {
      const w = await world();
      const dead31 = await w.addChannel();
      const dead29 = await w.addChannel();
      for (const c of [dead31, dead29]) await markReconnectNeeded(sql, w.orgId, c.connectionId);
      await shiftConnection(dead31.connectionId, 31);
      await shiftConnection(dead29.connectionId, 29);
      expect(await daily(w)).toMatchObject({ purged: 1, reconnectNeeded: 0 });
      expect((await connRow(dead31.connectionId)).status).toBe("revoked");
      expect((await connRow(dead29.connectionId)).status).toBe("reconnect_needed");
      expect((await connRow(w.connectionId)).status).toBe("connected");
    });

    it("a reconnect before the pass resets the clock: a connection dead for 31 days that was RECONNECTED through the real save is not purged", async () => {
      const w = await world();
      await markReconnectNeeded(sql, w.orgId, w.connectionId);
      await shiftConnection(w.connectionId, 31);
      const g = await grant(w.org, { connectionId: w.connectionId, channels: [w.channel] });
      await saveConnectionFromGrant({ pendingId: g.id, channelId: w.channel.id, userId: w.userId }, w.fake);
      w.fake.seedGrant({ refreshToken: g.token, channelId: w.channel.id, channelTitle: w.channel.title });
      expect((await connRow(w.connectionId)).status).toBe("connected");
      expect(await daily(w)).toEqual({ ...ZERO, checked: 1 });
      expect((await connRow(w.connectionId)).status).toBe("connected");
    });

    it("RACE: a reconnect that lands AFTER the pass listed the dead grant and BEFORE its purge wins - the connection stays connected, its token still opens, its rows are kept, and nothing is counted purged (the purge re-checks under the lock)", async () => {
      const w = await world({ credits: 1 });
      const m = await completedMatch(w, w.fixtures[0]!);
      await markReconnectNeeded(sql, w.orgId, w.connectionId);
      await shiftConnection(w.connectionId, 31);
      let reconnected = 0;
      const out = await youtubeDaily(w.fake, new Date(), {
        orgIds: [w.orgId],
        hooks: {
          afterDeadGrantsListed: async () => {   // the organiser reconnects, through the real save, in the window
            const g = await grant(w.org, { connectionId: w.connectionId, channels: [w.channel] });
            await saveConnectionFromGrant({ pendingId: g.id, channelId: w.channel.id, userId: w.userId }, w.fake);
            reconnected++;
          },
        },
      });
      expect(reconnected, "premise: the hook ran, i.e. the dead grant WAS listed").toBe(1);
      expect(out).toMatchObject({ purged: 0, failed: 0 });
      expect((await connRow(w.connectionId)).status).toBe("connected");
      expect(await openToken(sql, w.orgId, w.connectionId), "the new grant's token survived").not.toBeNull();
      expect((await broadcastsOfConnection(w.connectionId)).length, "its rows were not purged").toBe(1);
      expect(await keysOf(w.connectionId), "its pooled keys were not deleted").toBeGreaterThan(0);
      expect(await streamUrlOf(w.fixtures[0]!)).toBe(youtubeWatchUrl(m.ytId));
    });

    it("RACE, each predicate of the lock re-check ALONE: a connection flipped back to `connected` with its 31-day-old status_since still standing is not purged (status), and one that stays reconnect_needed but whose status_since moved to now is not purged either (since); positive pair: neither window opened -> purged", async () => {
      const pokes: { name: string; poke: (id: string) => Promise<unknown>; status: string }[] = [
        { name: "status only", poke: (id) => sql`update org_youtube_connections set status = 'connected' where id = ${id}`, status: "connected" },
        { name: "since only", poke: (id) => sql`update org_youtube_connections set status_since = now() where id = ${id}`, status: "reconnect_needed" },
      ];
      let checked = 0;
      for (const v of pokes) {
        const w = await world({ credits: 1 });
        await completedMatch(w, w.fixtures[0]!);
        await markReconnectNeeded(sql, w.orgId, w.connectionId);
        await shiftConnection(w.connectionId, 31);
        let ran = 0;
        const out = await youtubeDaily(w.fake, new Date(), {
          orgIds: [w.orgId],
          hooks: { afterDeadGrantsListed: async () => { await v.poke(w.connectionId); ran++; } },
        });
        expect(ran, `${v.name}: premise: the dead grant was listed`).toBe(1);
        expect(out.purged, v.name).toBe(0);
        expect((await connRow(w.connectionId)).status, v.name).toBe(v.status);
        expect((await broadcastsOfConnection(w.connectionId)).length, `${v.name}: its rows were kept`).toBe(1);
        expect(await openToken(sql, w.orgId, w.connectionId), `${v.name}: its token was kept`).not.toBeNull();
        checked++;
      }
      expect(checked).toBe(2);
      // The positive pair: with the window left shut the same connection IS purged.
      const w = await world({ credits: 1 });
      await completedMatch(w, w.fixtures[0]!);
      await markReconnectNeeded(sql, w.orgId, w.connectionId);
      await shiftConnection(w.connectionId, 31);
      expect((await daily(w)).purged).toBe(1);
    });

    it("RACE (stream_url): a club that saves its OWN link between the purge's read of the links and its clear keeps it - the clear is a compare-and-set on the value it read (streamUrlsCleared 0); positive pair: the link that stood is cleared", async () => {
      const w = await world({ credits: 2, fixtures: 2 });
      const [f1, f2] = w.fixtures as [string, string];
      const m1 = await completedMatch(w, f1);
      const m2 = await completedMatch(w, f2);
      expect(await streamUrlOf(f1), "premise: the real end step wrote the replay link").toBe(youtubeWatchUrl(m1.ytId));
      expect(await revokeConnection(sql, w.orgId, w.connectionId)).toBe(true);
      let ran = 0;
      // One purge, two fixtures: the hook rewrites f1's link in the window; f2's is left alone.
      const out = await sql.begin((tx) => purgeConnectionData(tx, w.connectionId, {
        afterLinksRead: async () => { await sql`update fixtures set stream_url = ${CLUB_LINK} where id = ${f1}`; ran++; },
      }));
      expect(ran, "premise: the hook ran between the read and the clear").toBe(1);
      expect(await streamUrlOf(f1), "the club's concurrent link survives").toBe(CLUB_LINK);
      expect(await streamUrlOf(f2), "the link that stood is cleared").toBeNull();
      expect(out.streamUrlsCleared, "only the link that stood was cleared").toBe(1);
      expect(out.broadcasts, "both rows went").toBe(2);
      expect(m2.ytId).not.toBe(m1.ytId);
    });

    it("tenancy: the purge of org A's dead grant leaves org B's (also dead for 31 days, but out of the pass's scope) exactly as it was - its rows, keys and link included", async () => {
      const a = await world();
      const b = await world();
      const mb = await completedMatch(b, b.fixtures[0]!);
      for (const w of [a, b]) {
        await markReconnectNeeded(sql, w.orgId, w.connectionId);
        await shiftConnection(w.connectionId, 31);
      }
      const keysB = await keysOf(b.connectionId);
      expect(keysB, "premise: org B holds a pooled key").toBeGreaterThan(0);
      expect(await daily(a)).toEqual({ ...ZERO, purged: 1 });
      expect((await connRow(a.connectionId)).status).toBe("revoked");
      expect((await connRow(b.connectionId)).status).toBe("reconnect_needed");
      expect((await broadcastsOfConnection(b.connectionId)).length).toBe(1);
      expect(await keysOf(b.connectionId)).toBe(keysB);
      expect(await streamUrlOf(b.fixtures[0]!)).toBe(youtubeWatchUrl(mb.ytId));
    });

    it("purgeConnectionData: refuses a connection that is NOT revoked (a live connection's data is never purged by mistake) and changes nothing; an unknown id is a no-op; a revoked one is purged once and a second call is a no-op", async () => {
      const w = await world({ credits: 1 });
      const m = await completedMatch(w, w.fixtures[0]!);
      await expect(sql.begin((tx) => purgeConnectionData(tx, w.connectionId))).rejects.toThrow(/not revoked/);
      expect((await broadcastsOfConnection(w.connectionId)).length, "the refusal changed nothing").toBe(1);
      expect(await streamUrlOf(w.fixtures[0]!)).toBe(youtubeWatchUrl(m.ytId));

      const none: PurgeResult = { broadcasts: 0, streamUrlsCleared: 0, divisions: [] };
      expect(await sql.begin((tx) => purgeConnectionData(tx, randomUUID()))).toEqual(none);

      expect(await revokeConnection(sql, w.orgId, w.connectionId)).toBe(true);
      const first = await sql.begin((tx) => purgeConnectionData(tx, w.connectionId));
      expect(first).toMatchObject({ broadcasts: 1, streamUrlsCleared: 1 });
      expect(first.divisions).toEqual([{ divisionId: w.divisionId, competitionId: expect.any(String) }]);
      expect(await streamUrlOf(w.fixtures[0]!)).toBeNull();
      expect(await sql.begin((tx) => purgeConnectionData(tx, w.connectionId)), "idempotent").toEqual(none);
    });
  });

  // ═══ rows the end step can never settle (O2 a, b) ══════════════════════════════════════════════════════════════════════
  describe("stuck broadcasts", () => {
    it("the bound is DERIVED from the end step's backoff, and the backoff the real step stores is P6's: 1, 2, 4, 8, 16, 32, 60, 60 minutes", async () => {
      expect(P6_BACKOFF.map((_, i) => endBackoffMinutes(i + 1))).toEqual(P6_BACKOFF);
      expect(YOUTUBE_END_STUCK_AFTER_ATTEMPTS).toBe(STUCK_ATTEMPTS);
      expect(YOUTUBE_END_STUCK_AFTER_MINUTES).toBe(STUCK_MINUTES);

      const w = await world();
      refuseComplete(w.fake);
      const m = await playAndStop(w, w.fixtures[0]!);
      const waits = await failTo(w, m.broadcastId, P6_BACKOFF.length, afterStop(m, min(6)));
      expect(waits, "the waits the real end step stored after each failure").toEqual(P6_BACKOFF);
    });

    it("the derivation of the bound is BOUNDED: a backoff that never reaches its cap (or a cap that is not a positive whole number of minutes) throws a clear error instead of hanging the module load; the arithmetic is checked on inputs whose answer is worked by hand", () => {
      // Worked by hand: waits 1, 2, 3, 4, 5, 5 ... with a 5-minute cap -> 5 failures to reach it, a day at it is ceil(1440 / 5) = 288 more
      // = 293 failures, and the 292 waits between the first failure and the last are 1 + 2 + 3 + 4 + 288 * 5 = 1450 minutes.
      expect(deriveStuckBounds({ capMinutes: 5, backoffMinutes: (n) => Math.min(n, 5), daysAtCap: 1 })).toEqual({ attempts: 293, minutes: 1450 });
      // And the real schedule's (typed: 7 failures to reach 60 + 24 at it = 31; 63 + 24 * 60 = 1503 minutes).
      expect(deriveStuckBounds({ capMinutes: 60, backoffMinutes: endBackoffMinutes, daysAtCap: 1 })).toEqual({ attempts: 31, minutes: 1503 });
      expect([YOUTUBE_END_STUCK_AFTER_ATTEMPTS, YOUTUBE_END_STUCK_AFTER_MINUTES], "the exported constants are that derivation").toEqual([31, 1503]);

      let refused = 0;
      for (const bad of [
        { capMinutes: 60, backoffMinutes: () => 1, daysAtCap: 1 },              // never reaches the cap
        { capMinutes: 60, backoffMinutes: (n: number) => n, daysAtCap: 1 },     // reaches it only after 60 steps - beyond the bound
        { capMinutes: 0, backoffMinutes: () => 0, daysAtCap: 1 },               // a zero cap would divide by zero
        { capMinutes: 2.5, backoffMinutes: () => 3, daysAtCap: 1 },             // not a whole number of minutes
      ]) {
        expect(() => deriveStuckBounds(bad), JSON.stringify({ cap: bad.capMinutes })).toThrow(/stuck-broadcast bound/);
        refused++;
      }
      expect(refused, "refusals checked").toBe(4);
    });

    it("live with a PERMANENT complete refusal: untouched at 30 failures; at 31 it is finalized 'end_stuck', reported once (ids and codes only), counted failed, its KEY IS FREE (the next Go live reuses it, no second key) and its stream_url rules are unchanged", async () => {
      const w = await world({ fixtures: 2, credits: 2 });
      const [f1, f2] = w.fixtures as [string, string];
      refuseComplete(w.fake);
      const m = await playAndStop(w, f1);
      await failTo(w, m.broadcastId, STUCK_ATTEMPTS - 1, afterStop(m, min(6)));
      const held = await broadcastRow(m.broadcastId);
      expect(held).toMatchObject({ state: "ending", attempts: STUCK_ATTEMPTS - 1 });

      const daily30 = await daily(w, { now: new Date(w.now()) });
      expect(daily30, "30 failures: still within the bound").toMatchObject({ failed: 0 });
      expect((await broadcastRow(m.broadcastId)).state).toBe("ending");
      expect(dailyReports()).toHaveLength(0);

      await failTo(w, m.broadcastId, STUCK_ATTEMPTS, afterStop(m, min(6)));
      expect(await daily(w, { now: new Date(w.now()) })).toMatchObject({ failed: 1 });
      const done = await broadcastRow(m.broadcastId);
      expect(done).toMatchObject({ state: "failed", last_error_code: "end_stuck", next_attempt_at: null });
      expect(done.last_error_code).toMatch(CODE_SHAPE);
      expect(done.completed_at).toBeInstanceOf(Date);
      expect(await streamUrlOf(f1), "a failed row writes no replay link").toBeNull();

      expect(dailyReports(), "ONE report for the stuck row").toHaveLength(1);
      const report = JSON.stringify(dailyReports()[0]);
      expect(report).toContain(m.broadcastId);
      expect(report).not.toContain(w.token);
      for (const k of w.issued) expect(report, "a stream key is never reported").not.toContain(k.streamKey);

      // The key is free: the NEXT Go live is admitted on the same pooled key and the pool did not grow.
      const keys = await keysOf(w.connectionId);
      await goLive(w, f2);
      const rows = await broadcastsOfConnection(w.connectionId);
      const next = rows.find((r) => r.fixture_id === f2)!;
      expect(next.key_id, "the freed key is reused").toBe(held.key_id);
      expect(await keysOf(w.connectionId), "no second key was needed").toBe(keys);

      expect(await daily(w, { now: new Date(w.now()) }), "a second pass: a failed row is not re-reported").toMatchObject({ failed: 0 });
      expect(dailyReports()).toHaveLength(1);
    });

    it("a PERMANENT EndRuleInvariantError (a terminal session with no ended_at) is stuck the same way: the claim never succeeds, attempts climb, and at 31 the row is finalized 'end_stuck'", async () => {
      const w = await world();
      const m = await playAndStop(w, w.fixtures[0]!);
      await sql`update fixture_stream_sessions set ended_at = null where id = ${m.sessionId}`;   // the corrupt fact: hand-built, the invariant's own trigger
      await failTo(w, m.broadcastId, STUCK_ATTEMPTS - 1, afterStop(m, min(6)));
      expect(await daily(w, { now: new Date(w.now()) })).toMatchObject({ failed: 0 });
      expect((await broadcastRow(m.broadcastId)).state, "30 failures: still open").toBe("live");
      await failTo(w, m.broadcastId, STUCK_ATTEMPTS, afterStop(m, min(6)));
      expect(await daily(w, { now: new Date(w.now()) })).toMatchObject({ failed: 1 });
      expect(await broadcastRow(m.broadcastId)).toMatchObject({ state: "failed", last_error_code: "end_stuck" });
    });

    it("RACE: a row the end step COMPLETES after the pass listed it as stuck is not overwritten with 'failed' (the finalize moves only an open row); it was listed, so it was reported", async () => {
      const w = await world();
      refuseComplete(w.fake);
      const m = await playAndStop(w, w.fixtures[0]!);
      await failTo(w, m.broadcastId, STUCK_ATTEMPTS, afterStop(m, min(6)));
      let ran = 0;
      const out = await youtubeDaily(w.fake, new Date(w.now()), {
        orgIds: [w.orgId],
        hooks: {
          afterStuckListed: async () => {   // the video finally ends: the real end step's outcome, written by SQL (no producer can win this race on cue)
            await sql`update youtube_broadcasts set state = 'complete', completed_at = now(), next_attempt_at = null where id = ${m.broadcastId}`;
            ran++;
          },
        },
      });
      expect(ran, "premise: the row was listed as stuck").toBe(1);
      expect(out.failed).toBe(1);
      const row = await broadcastRow(m.broadcastId);
      expect(row.state, "a finished row is not failed after the fact").toBe("complete");
      expect(row.last_error_code).not.toBe("end_stuck");
    });

    it("a stuck row the end step has CLAIMED right now (its lease in the future, a call in flight) is reported but not finalized under it - even when the pass's own clock runs an hour BEHIND the claim; the pass after the step settles is free to (carry f, fix rounds 1 and 2)", async () => {
      const w = await world();
      refuseComplete(w.fake);
      const m = await playAndStop(w, w.fixtures[0]!);
      await failTo(w, m.broadcastId, STUCK_ATTEMPTS, afterStop(m, min(6)));
      // The hourly backoff runs out BY THE DATABASE'S CLOCK (the world's simulated one ran a day ahead of it while the failures were played);
      // the world returns to the present, where a real claim and the daily pass that races it both happen.
      await sql`update youtube_broadcasts set next_attempt_at = now() - interval '1 minute' where id = ${m.broadcastId}`;
      w.setNow(Date.now());
      const claimAt = w.now();

      // The REAL step claims the row at claim time; the daily pass - started an hour earlier by its own clock - runs while that call is in flight.
      let during: YoutubeDailyResult | null = null;
      let leaseSeen: Date | null = null;
      await w.step({
        at: claimAt,
        hooks: {
          afterClaim: async (id) => {
            if (id !== m.broadcastId) return;
            leaseSeen = (await broadcastRow(id)).next_attempt_at;
            during = await daily(w, { now: new Date(claimAt - min(60)) });
          },
        },
      });
      expect(leaseSeen, "premise: the step leased the row (next_attempt_at is the lease)").not.toBeNull();
      expect((leaseSeen as unknown as Date).getTime() - claimAt, "premise: a lease is the engine's own CLAIM_LEASE_MINUTES").toBe(CLAIM_LEASE_MINUTES * MIN);
      expect(during, "premise: the pass ran during the claim").not.toBeNull();
      expect(during).toMatchObject({ failed: 1 });   // it was stuck, so it was reported ...
      const row = await broadcastRow(m.broadcastId);
      expect(row.state, "... but a claimed row is the end step's to settle: not finalized under its call").toBe("ending");
      expect(row.last_error_code).not.toBe("end_stuck");
      expect(row.attempts, "premise: the step's own failure landed after the pass").toBe(STUCK_ATTEMPTS + 1);

      // The positive pair: once the step has settled (its lease replaced by the hourly backoff), the same row IS finalized.
      expect(await daily(w, { now: new Date(w.now() - min(60)) })).toMatchObject({ failed: 1 });
      expect(await broadcastRow(m.broadcastId)).toMatchObject({ state: "failed", last_error_code: "end_stuck" });
    });

    // The window is (now, now + lease] on the DATABASE's clock - the one a lease is written against at claim time, and later than the
    // pass's own start instant - so every case seeds next_attempt_at relative to the database and hands the pass a clock an hour BEHIND.
    // A row in the hourly backoff (the normal state of a row that fails for good) must NOT hide in the window, or no row would ever be
    // finalized. Each case is a fresh world: a finalized row cannot be un-finalized. (The instant `next_attempt_at = now()` is not a case:
    // the gate reads a later now() than the seed, so the two edges cannot be told apart from outside.)
    const LEASE_WINDOW: { name: string; nextInSeconds: number | null; finalized: boolean }[] = [
      { name: "no lease (an admission claim, or a cleared backoff)", nextInSeconds: null, finalized: true },
      { name: "a lease that ran out a minute ago (a crashed claim)", nextInSeconds: -60, finalized: true },
      { name: "a lease that ran out a second ago", nextInSeconds: -1, finalized: true },
      { name: "a lease with half its life left", nextInSeconds: (CLAIM_LEASE_MINUTES * 60) / 2, finalized: false },
      { name: "a lease that has all its life left", nextInSeconds: CLAIM_LEASE_MINUTES * 60, finalized: false },
      { name: "a wait a minute longer than any lease", nextInSeconds: (CLAIM_LEASE_MINUTES + 1) * 60, finalized: true },
      { name: "the hourly backoff of a row that fails for good", nextInSeconds: 60 * 60, finalized: true },
    ];
    for (const c of LEASE_WINDOW) {
      it(`the stuck finalize and the lease window - ${c.name}: ${c.finalized ? "finalized" : "left to the end step"}`, async () => {
        const w = await world();
        refuseComplete(w.fake);
        const m = await playAndStop(w, w.fixtures[0]!);
        await failTo(w, m.broadcastId, 1, afterStop(m, min(6)));
        await sql`
          update youtube_broadcasts
             set attempts = ${STUCK_ATTEMPTS},
                 next_attempt_at = ${c.nextInSeconds === null ? null : sql`now() + (${c.nextInSeconds}::float8 * interval '1 second')`}
           where id = ${m.broadcastId}`;
        expect(await broadcastRow(m.broadcastId), "premise: an ending row at the bound").toMatchObject({ state: "ending", attempts: STUCK_ATTEMPTS });

        expect(await daily(w, { now: new Date(Date.now() - min(60)) }), "it is stuck either way: reported").toMatchObject({ failed: 1 });
        expect((await broadcastRow(m.broadcastId)).state).toBe(c.finalized ? "failed" : "ending");
      });
    }

    it("a REAL reconnect (the save) gives the open broadcasts a fresh start - attempts 0, no backoff - so one failure after it is not a stuck row; it can still become one by failing 31 times AGAIN (controller ruling, fix round 1)", async () => {
      const w = await world();
      refuseComplete(w.fake);
      const m = await playAndStop(w, w.fixtures[0]!);
      await failTo(w, m.broadcastId, STUCK_ATTEMPTS, afterStop(m, min(6)));
      await markReconnectNeeded(sql, w.orgId, w.connectionId);   // the grant died while the row was failing
      expect(await broadcastRow(m.broadcastId), "premise: the history before the reconnect").toMatchObject({ attempts: STUCK_ATTEMPTS });

      // The club took its time: the row has been `ending` for longer than the age bound by the DATABASE's clock (the world's simulated
      // one ran ahead of it while the failures were played), so the age rule has its own say after the save.
      await sql`update youtube_broadcasts set claimed_at = now() - (${STUCK_MINUTES + 60}::float8 * interval '1 minute') where id = ${m.broadcastId}`;

      const g = await grant(w.org, { connectionId: w.connectionId, channels: [w.channel] });
      w.fake.seedGrant({ refreshToken: g.token, channelId: w.channel.id, channelTitle: w.channel.title });
      await saveConnectionFromGrant({ pendingId: g.id, channelId: w.channel.id, userId: w.userId }, w.fake);
      expect((await connRow(w.connectionId)).status).toBe("connected");
      expect(await broadcastRow(m.broadcastId), "the save cleared the failure history with the backoff").toMatchObject({ attempts: 0, next_attempt_at: null });

      // The save stamps the database's own clock (claimed_at = now()), the 31 failures ran on the world's simulated one, a day ahead of it:
      // bring the world back to the present, which is where a real reconnect and the failures after it happen together.
      w.setNow(Date.now());
      // ONE failure after the reconnect (the fake still refuses complete): attempts 1, not 32, and the row is minutes old, not days.
      await w.step({ at: w.now() + min(1) });
      expect(await broadcastRow(m.broadcastId)).toMatchObject({ state: "ending", attempts: 1 });
      expect(await daily(w, { now: new Date(w.now()) }), "one failure is not a stuck row (the reconnected channel is health-checked, nothing else)").toEqual({ ...ZERO, checked: 1 });
      expect((await broadcastRow(m.broadcastId)).state).toBe("ending");
      expect(dailyReports()).toHaveLength(0);

      // The positive pair: the fresh start did not switch the rule off - 31 failures after the reconnect is stuck again.
      await failTo(w, m.broadcastId, STUCK_ATTEMPTS, w.now());
      expect(await daily(w, { now: new Date(w.now()) })).toMatchObject({ failed: 1 });
      expect(await broadcastRow(m.broadcastId)).toMatchObject({ state: "failed", last_error_code: "end_stuck" });
    });

    it("a row on a RECONNECT-NEEDED connection is waiting for the club, not stuck: untouched and unreported at 31 failures; with only the token replaced (no save, so the failure history stands) the next pass finalizes it", async () => {
      const w = await world();
      refuseComplete(w.fake);
      const m = await playAndStop(w, w.fixtures[0]!);
      await failTo(w, m.broadcastId, STUCK_ATTEMPTS, afterStop(m, min(6)));
      await markReconnectNeeded(sql, w.orgId, w.connectionId);
      expect(await daily(w, { now: new Date(w.now()) })).toEqual(ZERO);
      expect((await broadcastRow(m.broadcastId)).state).toBe("ending");
      expect(dailyReports()).toHaveLength(0);

      const fresh = refreshToken();
      w.fake.seedGrant({ refreshToken: fresh, channelId: w.channel.id, channelTitle: w.channel.title });
      expect(await replaceConnectionToken(sql, w.orgId, w.connectionId, fresh)).toBe(true);
      expect(await daily(w, { now: new Date(w.now()) })).toMatchObject({ failed: 1 });
      expect((await broadcastRow(m.broadcastId)).state).toBe("failed");
    });

    it("never frees a key under a LIVE session: a stuck row with an active session is reported (and counted) but NOT finalized, and is finalized once the session has ended", async () => {
      const w = await world();
      const m = await playAndStop(w, w.fixtures[0]!);
      await sql`update fixture_stream_sessions set ended_at = null where id = ${m.sessionId}`;
      await failTo(w, m.broadcastId, STUCK_ATTEMPTS, afterStop(m, min(6)));
      await sql`update fixture_stream_sessions set state = 'live', end_reason = null, output_released_at = null where id = ${m.sessionId}`;   // hand-built: a session on the broadcast is active again
      expect(await daily(w, { now: new Date(w.now()) })).toMatchObject({ failed: 1 });
      expect((await broadcastRow(m.broadcastId)).state, "still open: the key is in use").toBe("live");
      expect(dailyReports()).toHaveLength(1);

      await sql`update fixture_stream_sessions set state = 'completed', ended_at = now() where id = ${m.sessionId}`;
      expect(await daily(w, { now: new Date(w.now()) })).toMatchObject({ failed: 1 });
      expect((await broadcastRow(m.broadcastId)).state).toBe("failed");
    });

    it("an `ending` row whose claim has been deferred for longer than a failing row takes to get stuck (budget spent on every firing, so attempts never climb) is finalized: 1502 minutes after the claim untouched, 1503 and a second later finalized", async () => {
      const w = await world();
      const m = await playAndStop(w, w.fixtures[0]!);
      let reads = 0;
      const spentAfterClaim = () => (reads++ < 2 ? 0 : 20_000);   // the slice has room to START the row and none for its first YouTube call
      const claimedAt = afterStop(m, min(6));
      expect(await w.step({ at: claimedAt, wallClock: spentAfterClaim })).toEqual({ ...NO_END, deferred: 1 });
      const row = await broadcastRow(m.broadcastId);
      expect(row).toMatchObject({ state: "ending", attempts: 0 });
      expect(row.claimed_at!.getTime()).toBe(claimedAt);

      expect(await daily(w, { now: new Date(claimedAt + (STUCK_MINUTES - 1) * MIN) })).toMatchObject({ failed: 0 });
      expect((await broadcastRow(m.broadcastId)).state).toBe("ending");
      expect(await daily(w, { now: new Date(claimedAt + STUCK_MINUTES * MIN + 1000) })).toMatchObject({ failed: 1 });
      expect(await broadcastRow(m.broadcastId)).toMatchObject({ state: "failed", last_error_code: "end_stuck" });
    });
  });

  // ═══ broadcasts stranded on a revoked connection (O2 c) ════════════════════════════════════════════════════════════════
  describe("stranded rows", () => {
    it("an OPEN broadcast on a connection that was revoked (the end step skips revoked connections, so it never settles) is purged with the rest of the connection's data; a healthy connection's rows beside it are untouched; a second pass is a no-op", async () => {
      const w = await world({ credits: 1 });
      const f1 = w.fixtures[0]!;
      const other = await w.addChannel();
      const stranded = await goLive(w, f1);
      const sb = (await sessionRow(stranded.sessionId)).youtube_broadcast_id!;
      expect(await revokeConnection(sql, w.orgId, w.connectionId), "premise: the revoke leaves the open row behind").toBe(true);
      expect((await broadcastRow(sb)).state, "premise: it is still open").not.toBe("failed");
      expect(await w.step({ at: w.now() + min(60) }), "premise: the end step ignores a revoked connection").toEqual(NO_END);
      expect((await broadcastRow(sb)).state).not.toBe("failed");

      expect(await daily(w)).toMatchObject({ purged: 1 });
      expect(await sql`select 1 from youtube_broadcasts where id = ${sb}`).toHaveLength(0);
      expect(await keysOf(w.connectionId)).toBe(0);
      expect((await sessionRow(stranded.sessionId)).youtube_broadcast_id).toBeNull();
      expect((await connRow(w.connectionId)).google_sub).toBeNull();
      expect((await connRow(other.connectionId)).status, "the healthy connection is untouched").toBe("connected");
      expect(await daily(w), "second pass: the revoked connection has nothing left").toMatchObject({ purged: 0 });
    });
  });

  describe("stranded remnants, one at a time", () => {
    it("EMPTY CASE: a revoked connection that holds nothing is not purged again; then each remnant ALONE (a Google account id, a watch link on the archived destination, a pending grant, a broadcast row, and - last - a pooled key) is enough to purge it, and is gone afterwards", async () => {
      const w = await world();
      const remnants: Record<string, (c: Chan) => Promise<void>> = {
        "a Google account id": async (c) => { await sql`update org_youtube_connections set google_sub = 'sub-stranded' where id = ${c.connectionId}`; },
        "a watch link on the archived destination": async (c) => {
          await sql`update org_stream_targets set watch_url = 'https://www.youtube.com/watch?v=strandedxyz' where youtube_connection_id = ${c.connectionId}`;
        },
        "a pending grant": async (c) => { await grant(w.org, { connectionId: c.connectionId, channels: [c.channel] }); },
        "a broadcast row": async (c) => {
          await sql`insert into youtube_broadcasts (org_id, connection_id, fixture_id, title, privacy, state)
                    values (${w.orgId}, ${c.connectionId}, ${w.fixtures[0]!}, 't17 stranded', 'unlisted', 'failed')`;
        },
      };
      let checked = 0;
      for (const [what, plant] of Object.entries(remnants)) {
        const c = await w.addChannel();
        expect(await revokeConnection(sql, w.orgId, c.connectionId), `${what}: premise`).toBe(true);
        await sql.begin((tx) => purgeConnectionData(tx, c.connectionId));   // a clean revoked connection ...
        const clean = await daily(w, { orgIds: [w.orgId] });
        expect(clean.purged, `${what}: a revoked connection with nothing left is not purged again`).toBe(0);
        await plant(c);                                                     // ... plus exactly ONE remnant
        const first = await daily(w);
        expect(first.purged, `${what}: the remnant alone makes it a purge`).toBe(1);
        expect(first.failed, `${what}: without a fault`).toBe(0);
        expect((await daily(w)).purged, `${what}: and it is gone afterwards`).toBe(0);
        checked++;
      }
      expect(checked, "remnant shapes checked").toBe(Object.keys(remnants).length);
      expect(checked).toBe(4);

      // A pooled key ALONE. The key is made by a REAL Go live (the column that seals it is the relay's alone: no test names it), then
      // the connection is revoked and every OTHER remnant is removed, so the key is what is left.
      const k = await w.addChannel();
      await organiserStart(w.auth, w.fixtures[0]!, { mode: "passthrough", targetId: k.targetId }, w.deps);
      expect(await keysOf(k.connectionId), "premise: the real Go live pooled a key").toBe(1);
      expect(await revokeConnection(sql, w.orgId, k.connectionId)).toBe(true);
      await sql`delete from youtube_broadcasts where connection_id = ${k.connectionId}`;
      await sql`update org_youtube_connections set google_sub = null where id = ${k.connectionId}`;
      expect(await keysOf(k.connectionId), "premise: the key outlives the revoke").toBe(1);
      expect((await daily(w)).purged, "a pooled key alone makes it a purge").toBe(1);
      expect(await keysOf(k.connectionId)).toBe(0);
      expect((await daily(w)).purged, "and it is gone afterwards").toBe(0);
    });
  });

  // ═══ retention of failed rows (O2 d) and of expired pending grants (O2 e) ══════════════════════════════════════════════
  // ═══ the 30-day ceiling for a row the pass can no longer refresh (B6 batch review I1a) ═════════════════════════════════
  describe("the 30-day ceiling for complete rows of a dead grant (DP III.E.4)", () => {
    it("the ceiling is the policy's 30 days (typed here: the pairs below are derived from the constant, so this pins the constant itself)", () => {
      expect(YOUTUBE_DATA_CEILING_DAYS).toBe(30);
    });

    it("EMPTY CASE FIRST: a dead grant that holds no complete row lapses nothing (counters flip only), a second pass is all zeros; the same channel with a stale row then loses it (the positive pair)", async () => {
      const w = await world();
      expect((await broadcastsOfConnection(w.connectionId)).length, "premise: no row").toBe(0);
      w.fake.killToken(w.token);
      expect(await daily(w)).toEqual({ ...ZERO, checked: 1, reconnectNeeded: 1 });
      expect(await daily(w), "a second pass finds nothing").toEqual(ZERO);

      const v = await world();
      const m = await completedMatch(v, v.fixtures[0]!);
      await markReconnectNeeded(sql, v.orgId, v.connectionId);
      await shiftBroadcasts([m.broadcastId], "refreshed_at", YOUTUBE_DATA_CEILING_DAYS + 1);
      expect(await daily(v), "the positive pair: a dead grant WITH a stale row loses it in the same kind of pass").toEqual({ ...ZERO, removed: 1 });
    });

    it("29 days kept, 31 days gone - for the complete rows of a dead grant only: an OPEN row beside them and another organisation's dead grant are untouched; the link and the public page follow; the sequence (second pass, reconnect, refresh)", async () => {
      const w = await world({ fixtures: 3, credits: 3 });
      const [f1, f2, f3] = w.fixtures as [string, string, string];
      const young = await completedMatch(w, f1);
      const old = await completedMatch(w, f2);
      const open = await goLive(w, f3);
      const openId = (await sessionRow(open.sessionId)).youtube_broadcast_id!;
      await shiftBroadcasts([young.broadcastId], "refreshed_at", YOUTUBE_DATA_CEILING_DAYS - 1);
      await shiftBroadcasts([old.broadcastId, openId], "refreshed_at", YOUTUBE_DATA_CEILING_DAYS + 1);
      const rows = await broadcastsOfConnection(w.connectionId);
      expect(rows.map((r) => r.state).sort(), "anti-vacuity: three rows to judge, two of them complete").toEqual(["complete", "complete", "live"]);

      // Another organisation's dead grant with a 31-day-old row: outside this pass's scope, so it must come through whole.
      const other = await world();
      const otherMatch = await completedMatch(other, other.fixtures[0]!);
      await markReconnectNeeded(sql, other.orgId, other.connectionId);
      await shiftBroadcasts([otherMatch.broadcastId], "refreshed_at", YOUTUBE_DATA_CEILING_DAYS + 1);

      revalidateHook.calls = [];
      w.fake.killToken(w.token);   // the health check finds the dead grant IN this pass: the row is lapsed in the same pass
      expect(await daily(w)).toEqual({ ...ZERO, checked: 1, reconnectNeeded: 1, removed: 1 });
      const after = await broadcastsOfConnection(w.connectionId);
      expect(after.map((r) => r.id).sort(), "only the 31-day complete row is gone").toEqual([young.broadcastId, openId].sort());
      expect(await streamUrlOf(f2), "the link that pointed at the removed video is cleared").toBeNull();
      expect(await streamUrlOf(f1), "the 29-day row's link stays").toBe(youtubeWatchUrl(young.ytId));
      expect(revalidateHook.calls.map((c) => c.divisionId), "the public page that listed the part is expired").toContain(w.divisionId);
      expect((await broadcastRow(otherMatch.broadcastId)).state, "another organisation's row is out of scope").toBe("complete");
      expect(await streamUrlOf(other.fixtures[0]!)).toBe(youtubeWatchUrl(otherMatch.ytId));

      expect(await daily(w), "a second pass finds nothing more").toEqual(ZERO);

      // The sequence: the club reconnects through the real save; the surviving row, stale again, is now CONFIRMED, never lapsed.
      const g = await grant(w.org, { connectionId: w.connectionId, channels: [w.channel] });
      await saveConnectionFromGrant({ pendingId: g.id, channelId: w.channel.id, userId: w.userId }, w.fake);
      w.fake.seedGrant({ refreshToken: g.token, channelId: w.channel.id, channelTitle: w.channel.title });
      await shiftBroadcasts([young.broadcastId], "refreshed_at", YOUTUBE_DATA_CEILING_DAYS + 1);
      expect(await daily(w)).toEqual({ ...ZERO, checked: 1, refreshed: 1 });
      expect((await broadcastRow(young.broadcastId)).state).toBe("complete");
    });

    it("a CONNECTED channel's stale row is the refresh leg's, never the lapse leg's: while YouTube cannot answer, a 31-day-old row stays (retried tomorrow), then it is confirmed", async () => {
      const w = await world();
      const m = await completedMatch(w, w.fixtures[0]!);
      await shiftBroadcasts([m.broadcastId], "refreshed_at", YOUTUBE_DATA_CEILING_DAYS + 1);
      w.fake.failNext("existingVideos", "youtube_unavailable", "backendError", { channelId: w.channel.id });
      expect(await daily(w), "YouTube down: the batch failed, nothing removed").toEqual({ ...ZERO, checked: 1, failed: 1 });
      expect((await broadcastRow(m.broadcastId)).state, "kept for tomorrow").toBe("complete");
      expect(await daily(w), "YouTube back: confirmed").toEqual({ ...ZERO, checked: 1, refreshed: 1 });
    });

    it("RACE: a reconnect that lands AFTER the pass listed the lapsed connection and BEFORE its delete wins - the row is kept (the delete re-checks the status under the lock)", async () => {
      const w = await world();
      const m = await completedMatch(w, w.fixtures[0]!);
      await markReconnectNeeded(sql, w.orgId, w.connectionId);
      await shiftBroadcasts([m.broadcastId], "refreshed_at", YOUTUBE_DATA_CEILING_DAYS + 1);
      let listed = 0;
      const out = await youtubeDaily(w.fake, new Date(), {
        orgIds: [w.orgId],
        hooks: {
          afterLapsedListed: async () => {
            listed++;
            const g = await grant(w.org, { connectionId: w.connectionId, channels: [w.channel] });
            await saveConnectionFromGrant({ pendingId: g.id, channelId: w.channel.id, userId: w.userId }, w.fake);
          },
        },
      });
      expect(listed, "premise: the hook ran, i.e. the lapsed connection WAS listed").toBe(1);
      expect(out).toMatchObject({ removed: 0, failed: 0 });
      expect((await connRow(w.connectionId)).status).toBe("connected");
      expect((await broadcastRow(m.broadcastId)).state, "the reconnect won: the row is kept").toBe("complete");
    });
  });

  // ═══ pooled stream keys: a retired key (B6 batch review I1b) ═════════════════════════════════════════════════════════
  describe("retired pooled keys", () => {
    it("EMPTY CASE FIRST (no key, then only a live key: nothing removed); a key RETIRED by a real Go live is deleted on the next pass and the finished rows that named it forget it - the replay stays; an open broadcast keeps a retired key until it finishes; the pool then regrows", async () => {
      const w = await world({ fixtures: 2, credits: 3 });
      const [f1, f2] = w.fixtures as [string, string];
      expect(await daily(w), "no key at all").toEqual({ ...ZERO, checked: 1 });
      const m1 = await completedMatch(w, f1);
      const [K] = await keyRows(w.connectionId);
      expect(K!.retired_at, "premise: a live key").toBeNull();
      expect(await daily(w), "a live key is not removed").toEqual({ ...ZERO, checked: 1 });
      expect((await keyRows(w.connectionId)).length).toBe(1);

      // The club deletes the stream in YouTube Studio; the next Go live fails at bind and RETIRES the key (the real producer).
      await w.fake.deleteStream(await w.fake.accessToken(w.token), K!.live_stream_id);
      await expect(goLive(w, f2)).rejects.toMatchObject({ status: 503 });
      expect((await keyRows(w.connectionId))[0]!.retired_at, "premise: retired by Go live").toBeInstanceOf(Date);
      const failedRow = (await broadcastsOfConnection(w.connectionId)).find((b) => b.state === "failed")!;
      expect([await keyIdOf(failedRow.id), await keyIdOf(m1.broadcastId)], "premise: both finished rows name the retired key").toEqual([K!.id, K!.id]);
      // The second Go live grows a NEW key, and its match is played to its Stop (the broadcast stays open for the grace).
      const m2 = await playAndStop(w, f2);
      const live = (await keyRows(w.connectionId)).filter((k) => k.retired_at === null);
      expect(live.length, "premise: one live key beside the retired one").toBe(1);
      expect(await keyIdOf(m2.broadcastId)).toBe(live[0]!.id);

      expect(await daily(w), "the retired key goes; the live key stays").toEqual({ ...ZERO, checked: 1, keysRemoved: 1 });
      expect((await keyRows(w.connectionId)).map((k) => k.id)).toEqual([live[0]!.id]);
      expect([await keyIdOf(failedRow.id), await keyIdOf(m1.broadcastId)], "the finished rows forgot the key").toEqual([null, null]);
      expect((await broadcastRow(m1.broadcastId)).state, "the replay part is untouched").toBe("complete");
      expect(await streamUrlOf(f1), "and so is its link").toBe(youtubeWatchUrl(m1.ytId));
      expect(await keyIdOf(m2.broadcastId), "the OPEN broadcast keeps its (live) key").toBe(live[0]!.id);
      expect(await daily(w), "a second pass is idempotent").toEqual({ ...ZERO, checked: 1 });

      // An open broadcast keeps a RETIRED key (retired under it by SQL: no producer does, a retire follows the row's failure).
      await sql`update youtube_stream_keys set retired_at = now() where id = ${live[0]!.id}`;
      expect(await daily(w), "kept while an open broadcast names it").toEqual({ ...ZERO, checked: 1 });
      expect(await keyIdOf(m2.broadcastId)).toBe(live[0]!.id);
      expect(await w.step({ at: afterStop(m2, min(6)) }), "premise: the real end step finishes it").toMatchObject({ ended: 1 });
      expect(await daily(w), "finished: the retired key goes and the row forgets it").toEqual({ ...ZERO, checked: 1, keysRemoved: 1 });
      expect(await keyRows(w.connectionId)).toEqual([]);
      expect(await keyIdOf(m2.broadcastId)).toBeNull();
      expect((await broadcastRow(m2.broadcastId)).state).toBe("complete");

      // After the deletion the pool regrows on the next Go live (a fresh liveStream), and nothing is left retired.
      await goLive(w, f1);
      const regrown = await keyRows(w.connectionId);
      expect(regrown.length).toBe(1);
      expect(regrown[0]!.retired_at).toBeNull();
      expect(regrown[0]!.id).not.toBe(K!.id);
    });

    it("a retired key of a DEAD grant is deleted too (no token is needed), and another organisation's retired key is out of the pass's scope", async () => {
      const w = await world();
      const m = await completedMatch(w, w.fixtures[0]!);
      const other = await world();
      await completedMatch(other, other.fixtures[0]!);
      await sql`update youtube_stream_keys set retired_at = now() where connection_id in ${sql([w.connectionId, other.connectionId])}`;
      await markReconnectNeeded(sql, w.orgId, w.connectionId);
      expect(await daily(w)).toEqual({ ...ZERO, keysRemoved: 1 });
      expect(await keyRows(w.connectionId)).toEqual([]);
      expect(await keyIdOf(m.broadcastId)).toBeNull();
      expect((await keyRows(other.connectionId)).length, "another organisation's key").toBe(1);
    });

    it("a FREE live key beside a retired one is left alone (the pool reuses it): only the retired key goes, and the live key's finished rows keep naming it", async () => {
      const w = await world({ fixtures: 2, credits: 2 });
      const [f1, f2] = w.fixtures as [string, string];
      const a = await playAndStop(w, f1);
      const b = await playAndStop(w, f2);   // f1's broadcast still holds its key (inside the grace): the second Go live grows a second one
      expect(await w.step({ at: afterStop(b, min(6)) }), "premise: both matches are ended by the real end step").toMatchObject({ ended: 2 });
      const [k1, k2] = await keyRows(w.connectionId);
      expect([k1?.slot, k2?.slot], "premise: two keys, both free").toEqual([1, 2]);
      expect([await keyIdOf(a.broadcastId), await keyIdOf(b.broadcastId)], "premise: each match streamed on its own key").toEqual([k1!.id, k2!.id]);
      await sql`update youtube_stream_keys set retired_at = now() where id = ${k1!.id}`;
      expect(await daily(w)).toEqual({ ...ZERO, checked: 1, keysRemoved: 1 });
      expect((await keyRows(w.connectionId)).map((k) => k.id), "the free live key stays").toEqual([k2!.id]);
      expect([await keyIdOf(a.broadcastId), await keyIdOf(b.broadcastId)]).toEqual([null, k2!.id]);
    });

    it("a REVOKED connection's retired key is the stranded purge's, not this leg's: the pass purges the connection (its key goes with it) and counts no key removed here", async () => {
      const w = await world();
      await completedMatch(w, w.fixtures[0]!);
      await sql`update youtube_stream_keys set retired_at = now() where connection_id = ${w.connectionId}`;
      expect(await revokeConnection(sql, w.orgId, w.connectionId), "premise: revoked without its purge").toBe(true);
      expect((await keyRows(w.connectionId)).length, "premise: the key row is still there").toBe(1);
      expect(await daily(w)).toEqual({ ...ZERO, purged: 1 });
      expect(await keyRows(w.connectionId)).toEqual([]);
    });

    it("the key work queues behind a holder of the connection row (Go live's pick, a disconnect's purge) instead of meeting it half-way through its row locks", async () => {
      const w = await world();
      await completedMatch(w, w.fixtures[0]!);
      await sql`update youtube_stream_keys set retired_at = now() where connection_id = ${w.connectionId}`;
      await markReconnectNeeded(sql, w.orgId, w.connectionId);   // no health write to queue on: the key leg alone meets the lock
      const hold = await holdConnection(w.connectionId);
      let settled = false;
      const pass = daily(w).then((r) => { settled = true; return r; });
      await sleep(500);
      expect(settled, "the pass is still waiting for the connection").toBe(false);
      expect((await keyRows(w.connectionId)).length, "and nothing was deleted behind the holder's back").toBe(1);
      await hold.release();
      expect(await pass).toEqual({ ...ZERO, keysRemoved: 1 });
      expect(await keyRows(w.connectionId)).toEqual([]);
    });
  });

  describe("retention", () => {
    it("a FAILED broadcast row is deleted 30 days after it failed (DP III.E.4): 29 days kept, 31 days gone; a COMPLETE row of the same age whose video was refreshed today is kept (the negative pair)", async () => {
      const w = await world({ fixtures: 2, credits: 2 });
      const [f1, f2] = w.fixtures as [string, string];
      const done = await completedMatch(w, f1);
      // A failed row from the real end step: a Go live nobody streamed into, ended as never-live.
      const { sessionId } = await goLive(w, f2);
      await reachLive(w, f2);
      await stopSession(w.auth, f2, sessionId, w.deps);
      const failedId = (await sessionRow(sessionId)).youtube_broadcast_id!;
      const S = (await sessionRow(sessionId)).ended_at!.getTime();
      expect(await w.step({ at: S + min(GRACE_MINUTES) + 1000 })).toMatchObject({ neverLive: 1 });
      expect((await broadcastRow(failedId)).state, "premise: the real step failed it").toBe("failed");

      await shiftBroadcasts([failedId], "completed_at", 29);
      await shiftBroadcasts([done.broadcastId], "completed_at", 40);
      expect(await daily(w)).toMatchObject({ removed: 0 });
      expect((await broadcastRow(failedId)).state, "29 days: kept").toBe("failed");

      await shiftBroadcasts([failedId], "completed_at", 31);
      expect(await daily(w)).toMatchObject({ removed: 1 });
      expect(await sql`select 1 from youtube_broadcasts where id = ${failedId}`).toHaveLength(0);
      expect((await broadcastRow(done.broadcastId)).state, "a complete part is the replay: not a failed row, kept").toBe("complete");
      expect(await streamUrlOf(f1)).toBe(youtubeWatchUrl(done.ytId));
    });

    it("a failed row with NO completed_at (a Go live that prepare refused fails without one) ages from created_at: 29 days kept, 31 days gone", async () => {
      const w = await world({ fixtures: 1, credits: 1 });
      const mk = async (ageDays: number) => (await sql<{ id: string }[]>`
        insert into youtube_broadcasts (org_id, connection_id, fixture_id, title, privacy, state, last_error_code, created_at)
        values (${w.orgId}, ${w.connectionId}, ${w.fixtures[0]!}, 't17 refused', 'unlisted', 'failed', 'admission_refused', now() - (${ageDays}::float8 * interval '1 day'))
        returning id`)[0]!.id;
      const young = await mk(29);
      const old = await mk(31);
      expect((await broadcastRow(old)).completed_at, "premise: no completed_at").toBeNull();
      expect(await daily(w)).toMatchObject({ removed: 1 });
      expect((await broadcastRow(young)).state, "29 days: kept").toBe("failed");
      expect(await sql`select 1 from youtube_broadcasts where id = ${old}`, "31 days: gone").toHaveLength(0);
    });

    it("O2 e: an EXPIRED pending grant (its sealed token and channel titles) is deleted - a cancelled pick included - and an unexpired one is kept; the next pass finds none", async () => {
      const w = await world();
      const expired = await grant(w.org, { startedMinutesAgo: 20 });
      const cancelledPick = await grant(w.org, { startedMinutesAgo: 60, channels: [{ id: "UCcancelledpickxxxxxxxxxx", title: "Cancelled Pick FC" }, { id: "UCsecondchannelxxxxxxxxxx", title: "Second FC" }] });
      const live = await grant(w.org, { startedMinutesAgo: 0 });
      expect([await pendingCount(expired.id), await pendingCount(cancelledPick.id), await pendingCount(live.id)], "premise").toEqual([1, 1, 1]);
      await daily(w);
      expect([await pendingCount(expired.id), await pendingCount(cancelledPick.id), await pendingCount(live.id)]).toEqual([0, 0, 1]);
      await daily(w);
      expect(await pendingCount(live.id), "an unexpired grant survives every pass").toBe(1);
    });
  });
});
