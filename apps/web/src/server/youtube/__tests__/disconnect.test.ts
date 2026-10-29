// YouTube Connect T18 (spec §6.8, §9.2, §9.3; plan T18; controller overrides task-18-overrides O2, O-T17a/b/c): the organiser's
// DISCONNECT - revoke at Google, purge what Seazn stored FROM YouTube, archive the destination - in one use-case, over the REAL pieces.
//
// Everything runs through the REAL producers wherever one exists: Go live is the organiser's `createSession` against a FakeYouTube
// (prepare, the pool, the session insert and the attach are the real ones), Stop is `stopSession`, a replay link and a `complete` row
// are the REAL end step's (`endDueBroadcasts`), a dead grant is the fake's `killToken` met by the real end step, a reconnect is the real
// connect save. Rows are built by SQL only where no producer can make the shape (a `reserved` broadcast; a damaged token envelope; a
// connection revoked WITHOUT its purge), and a test says so where it does. Time is the injected clock the end-step suite uses: the
// session deps', the fake YouTube's and what the disconnect is handed as `now`.
//
// Expected values are the spec's, the brief's and the scenario's literals, typed here and never read back from the code under test:
//   - the refusal is 409 YOUTUBE_IN_USE "A match is using this channel" (plan T18);
//   - the grace after a Stop is 5 minutes (D4), so a broadcast Stopped 2 minutes ago is in grace and one Stopped 6 minutes ago is due;
//   - the destination a revoke archives is labelled "YouTube channel (disconnected)" (B1-R1 / R4);
//   - a second disconnect of a revoked connection is 404 and calls no one (plan T18).
// Sport: not applicable - streaming is sport-agnostic (global-constraints "Test rules"); every rig rides `generic`.
// Secrets: a token / key is compared by absence, so a failing assertion never prints one. No module-scope database call (the no-DB
// unit job must SKIP this file, not fail to collect it): every column list and query is built inside a test.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

/** fireDivisionRevalidate, spied: a pass-through that records each call and - when a probe is set - what ANOTHER database connection
 *  reads at that instant (a revalidation inside the open transaction would see the connection still `connected`). */
const revalidateHook = vi.hoisted(() => ({
  calls: [] as { divisionId: string; competitionId: string | undefined }[],
  probe: null as null | (() => Promise<string | undefined>),
  seen: [] as Promise<string | undefined>[],
}));
vi.mock("@/server/public-site/revalidate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/public-site/revalidate")>();
  return {
    ...real,
    fireDivisionRevalidate: vi.fn((divisionId: string, competitionId?: string) => {
      revalidateHook.calls.push({ divisionId, competitionId });
      if (revalidateHook.probe) revalidateHook.seen.push(revalidateHook.probe());
      return real.fireDivisionRevalidate(divisionId, competitionId);
    }),
  };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { pairPresentPhone, rigUser, spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import { decidingStream, divisionRig, seedOrg } from "@/server/usecases/__tests__/_rig";
import { scoreEvent } from "@/server/usecases/scoring";
import { grantCredits } from "@/server/usecases/stream-credits";
import { createSession as organiserStart, currentSession, stopSession, type SessionDeps } from "@/server/usecases/stream-sessions";
import { connectionViews, recordLiveState } from "../connections";
import { youtubeDaily } from "../daily";
import { disconnectYoutube } from "../disconnect";
import { FINISHED_STATUSES, YOUTUBE_FINISHED_END_MINUTES, YOUTUBE_GRACE_MINUTES } from "../end-rule";
import { endDueBroadcasts, type EndStepHooks, type YoutubeEndResult } from "../end-step";
import { FakeYouTube } from "../fake";
import type { YouTubePort } from "../port";
import { openToken, revokeConnection } from "../token-store";
import {
  accountLockWaiters, connect as connectChannel, grant, holdAccountLock, org as seedYoutubeOrg, waitForAccountLockWaiters, type Ch, type Org,
} from "./_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;

// ---- spec and scenario literals ------------------------------------------------------------------------------------------
const MIN = 60_000;
const BUDGET_MS = 15_000;
const ROOMY_STORAGE_MINUTES = 100_000_000;
const DISCONNECTED_LABEL = "YouTube channel (disconnected)";
const IN_USE_MESSAGE = "A match is using this channel";
const CLUB_LINK = "https://example.com/club-stream";
const SKIPPED = "revoke_skipped_shared_grant";
/** V479's shape check on a stored error code. */
const CODE_SHAPE = /^[a-z_:]{1,64}$/;

// ---- KEKs and the composed image -----------------------------------------------------------------------------------------
const ENV = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "RELAY_IMAGE"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:t18-test";
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
  revalidateHook.probe = null;
  revalidateHook.seen = [];
});

// ---- the world ------------------------------------------------------------------------------------------------------------
interface Chan { connectionId: string; targetId: string; token: string; channel: Ch }
interface World {
  auth: AuthCtx; orgId: string; userId: string; org: Org; fixtures: string[]; divisionId: string;
  connectionId: string; targetId: string; token: string; channel: Ch;
  fake: FakeYouTube; deps: SessionDeps;
  /** The one injected clock: the session deps', the fake YouTube's, and what `step` / `disconnect` are handed. */
  now(): number; setNow(ms: number): void; tick(ms: number): void;
  issued: { url: string; streamKey: string }[];
  /** One pass of the REAL end step on the injected clock, scoped to this org. */
  step(over?: { at?: number; hooks?: EndStepHooks }): Promise<YoutubeEndResult>;
  /** Video arrives on the broadcast's stream: YouTube makes it `live` (auto-start). */
  video(ytId: string): void;
  /** A further channel connected through the real save, known to this world's fake (`sub`: the Google account it reports). */
  addChannel(o?: { sub?: string | null; org?: Org }): Promise<Chan>;
}

async function override(orgId: string, key: string, value: boolean) {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
            values (${orgId}, ${key}, ${value}, 't18 unit')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}

/** An org with the relay, `fixtures` fixtures each with a present phone, `credits` match credits, and a channel connected through the
 *  real save and KNOWN to the fake (`seedGrant`: the connection's channel id is the one the fake lists, as at connect). */
async function world(o: { fixtures?: number; credits?: number; sub?: string | null } = {}): Promise<World> {
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
  if ((o.credits ?? 1) > 0) await grantCredits({ orgId: auth.orgId, delta: o.credits ?? 1, createdBy: await rigUser(), note: "t18", idempotencyKey: randomUUID() });
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
  const addChannel = async (a: { sub?: string | null; org?: Org } = {}): Promise<Chan> => {
    const c = await connectChannel(a.org ?? org, a.sub !== undefined ? { sub: a.sub } : {});
    fake.seedGrant({ refreshToken: c.token, channelId: c.channel.id, channelTitle: c.channel.title, ...(a.sub !== undefined ? { sub: a.sub } : {}) });
    return { connectionId: c.connectionId, targetId: c.targetId, token: c.token, channel: c.channel };
  };
  const first = await addChannel(o.sub !== undefined ? { sub: o.sub } : {});
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(now), appUrl: "http://app.test", youtube: fake };
  return {
    auth, orgId: auth.orgId, userId: auth.userId, org, fixtures, divisionId: d.divisionId, ...first,
    fake, deps,
    now: () => now, setNow: (ms) => { now = ms; }, tick: (ms) => { now += ms; },
    issued,
    step: (over = {}) => {
      if (over.at !== undefined) now = over.at;
      return endDueBroadcasts(fake, {
        now: () => new Date(now), budgetMs: BUDGET_MS, orgIds: [auth.orgId], ...(over.hooks ? { hooks: over.hooks } : {}),
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

/** The setup (Go live, Stop, the real end step) revalidates pages of its own: forget those, so what is counted is the DISCONNECT's. */
const forgetRevalidations = () => { revalidateHook.calls = []; revalidateHook.seen = []; };

/** The disconnect under test, on the world's injected clock (or `now`). */
const disconnect = (w: World, o: { connectionId?: string; auth?: AuthCtx; orgId?: string; port?: YouTubePort; now?: number } = {}) =>
  disconnectYoutube(o.auth ?? w.auth, o.orgId ?? w.orgId, o.connectionId ?? w.connectionId, o.port ?? w.fake, { now: () => new Date(o.now ?? w.now()) });

/** The organiser's Go live, on the start's own clock (W5 needs the phone present at it). */
async function goLive(w: World, fixtureId: string, targetId = w.targetId) {
  await pairPresentPhone(fixtureId, { at: w.deps.now() });
  return organiserStart(w.auth, fixtureId, { mode: "passthrough", targetId }, w.deps);
}

interface SessionRow { id: string; state: string; youtube_broadcast_id: string | null; ended_at: Date | null }
const sessionRow = async (id: string): Promise<SessionRow> =>
  (await sql<SessionRow[]>`select id, state, youtube_broadcast_id, ended_at from fixture_stream_sessions where id = ${id}`)[0]!;
interface BRow { id: string; fixture_id: string; connection_id: string; state: string; key_id: string | null; yt_broadcast_id: string | null; reserved_until: Date | null }
const broadcastRow = async (id: string): Promise<BRow> =>
  (await sql<BRow[]>`select id, fixture_id, connection_id, state, key_id, yt_broadcast_id, reserved_until from youtube_broadcasts where id = ${id}`)[0]!;
const broadcastsOf = (connectionId: string) =>
  sql<BRow[]>`select id, fixture_id, connection_id, state, key_id, yt_broadcast_id, reserved_until from youtube_broadcasts where connection_id = ${connectionId} order by created_at, id`;
const keysOf = async (connectionId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from youtube_stream_keys where connection_id = ${connectionId}`)[0]!.n;
const streamUrlOf = async (fixtureId: string) =>
  (await sql<{ stream_url: string | null }[]>`select stream_url from fixtures where id = ${fixtureId}`)[0]!.stream_url;
interface ConnRow {
  status: string; last_error_code: string | null; channel_id: string | null; channel_title: string | null; google_sub: string | null; revoked_at: Date | null;
}
const connRow = async (id: string): Promise<ConnRow> =>
  (await sql<ConnRow[]>`select status, last_error_code, channel_id, channel_title, google_sub, revoked_at from org_youtube_connections where id = ${id}`)[0]!;
interface TRow { id: string; label: string; archived_at: Date | null; watch_url: string | null }
const targetsOf = (connectionId: string) =>
  sql<TRow[]>`select id, label, archived_at, watch_url from org_stream_targets where youtube_connection_id = ${connectionId} order by created_at, id`;
const pendingCount = async (id: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from youtube_connect_pending where id = ${id}`)[0]!.n;
/** What the disconnect reported to Sentry. */
const disconnectReports = () => sentry.captureError.mock.calls.filter((c) => String((c[1] as { route?: string } | undefined)?.route ?? "").startsWith("youtube.disconnect"));
/** The YouTube calls made since `from` (a `calls.length` taken before the act: Go live and the end step call YouTube too). */
const methods = (f: FakeYouTube, from = 0) => f.calls.slice(from).map((c) => c.method);
const count = (f: FakeYouTube, method: string, from = 0) => methods(f, from).filter((m) => m === method).length;
const min = (n: number) => n * MIN;

/** Passthrough: the fake ingest connects 3 s after its input was made; the session goes live on the next read. */
async function reachLive(w: World, fixtureId: string): Promise<void> {
  w.tick(3000);
  expect((await currentSession(w.auth, fixtureId, w.deps))!.state, "premise: the session went live").toBe("live");
}

/** Go live -> live -> video arrives -> a minute of play -> Stop. Returns the Stop's recorded ended_at. */
interface Match { sessionId: string; broadcastId: string; ytId: string; endedAt: Date }
async function playAndStop(w: World, fixtureId: string, targetId = w.targetId): Promise<Match> {
  const { sessionId } = await goLive(w, fixtureId, targetId);
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
async function completedMatch(w: World, fixtureId: string, targetId = w.targetId): Promise<Match> {
  const m = await playAndStop(w, fixtureId, targetId);
  expect(await w.step({ at: afterStop(m, min(6)) }), "premise: the real end step completed it").toMatchObject({ ended: 1 });
  expect((await broadcastRow(m.broadcastId)).state).toBe("complete");
  return m;
}

/** A snapshot of everything a REFUSED disconnect must leave alone. The token is read back through token-store (the one reader). */
async function snapshot(w: World, c: Chan = w) {
  return {
    conn: await connRow(c.connectionId),
    token: await openToken(sql, w.orgId, c.connectionId),
    keys: await keysOf(c.connectionId),
    broadcasts: (await broadcastsOf(c.connectionId)).map((b) => [b.id, b.state, b.key_id, b.yt_broadcast_id]),
    targets: await targetsOf(c.connectionId),
    youtubeCalls: w.fake.calls.length,
    streams: w.fake.streamsCount(c.channel.id),
  };
}

describe.skipIf(!HAS_DB)("YouTube Connect T18 - disconnect", () => {
  // ═══ the empty case, then the full purge ═══════════════════════════════════════════════════════════════════════════════
  it("EMPTY CASE FIRST: a channel that never streamed (no key, no broadcast) disconnects: revoked once, nothing else asked of YouTube, zero counts; the same call after a match shows the counts are not constant zeros", async () => {
    const w = await world();
    expect(await keysOf(w.connectionId), "premise: no key").toBe(0);
    expect((await broadcastsOf(w.connectionId)).length, "premise: no broadcast").toBe(0);

    expect(await disconnect(w)).toEqual({ revokeOutcome: "revoked", keysDeleted: 0, purged: { broadcasts: 0, streamUrlsCleared: 0 } });
    expect(methods(w.fake), "an access token to act with, then the revoke: nothing to end, nothing to delete").toEqual(["accessToken", "revoke"]);
    expect(await connRow(w.connectionId)).toMatchObject({ status: "revoked", channel_id: null, channel_title: null, google_sub: null });

    // The positive pair: the same use-case over a channel that HAS streamed reports non-zero counts.
    const busy = await world({ fixtures: 1 });
    await completedMatch(busy, busy.fixtures[0]!);
    const out = await disconnect(busy);
    expect(out.purged.broadcasts).toBeGreaterThan(0);
    expect(out.keysDeleted).toBeGreaterThan(0);
  });

  it("an idle channel after played matches: token revoked at Google ONCE, the key's stream deleted at YouTube, token null, status revoked, destination archived, broadcast rows and key rows gone, the link pointing at its video cleared, a club's own link kept, a pending reconnect grant gone - and cleanup comes BEFORE the revoke", async () => {
    const w = await world({ fixtures: 3, credits: 2 });
    const [f0, f1, f2] = w.fixtures as [string, string, string];
    const m0 = await completedMatch(w, f0);
    const m1 = await completedMatch(w, f1);
    await sql`update fixtures set stream_url = ${CLUB_LINK} where id = ${f1}`;   // the club saved its own link after the replay one
    await sql`update fixtures set stream_url = ${CLUB_LINK} where id = ${f2}`;   // a match that never streamed at all
    const pending = await grant(w.org, { connectionId: w.connectionId });        // a reconnect grant started and abandoned

    // premises, typed from the scenario: 2 complete parts on 1 key (the second match reuses it), 1 stream at YouTube
    expect((await broadcastsOf(w.connectionId)).map((b) => b.state)).toEqual(["complete", "complete"]);
    expect(await keysOf(w.connectionId)).toBe(1);
    expect(w.fake.streamsCount(w.channel.id)).toBe(1);
    expect(await streamUrlOf(f0), "premise: the real end step wrote the replay link").toContain(m0.ytId);
    expect(await pendingCount(pending.id)).toBe(1);
    expect(await openToken(sql, w.orgId, w.connectionId), "premise: the token is stored").toBe(w.token);

    const from = w.fake.calls.length;
    const out = await disconnect(w);
    expect(out).toEqual({ revokeOutcome: "revoked", keysDeleted: 1, purged: { broadcasts: 2, streamUrlsCleared: 1 } });

    // At YouTube: the key's stream is deleted, the videos (complete broadcasts) are NOT touched, the grant is revoked once - last.
    expect(w.fake.streamsCount(w.channel.id)).toBe(0);
    expect(w.fake.inspectBroadcast(m0.ytId)!.life, "a finished video stays on the channel").toBe("complete");
    expect(w.fake.inspectBroadcast(m1.ytId)!.life).toBe("complete");
    expect(count(w.fake, "revoke")).toBe(1);
    expect(count(w.fake, "broadcastLife", from), "finished videos are not asked about: they need nothing").toBe(0);
    const order = methods(w.fake, from);
    expect(order[order.length - 1], "the revoke is the last call: nothing can be ended once the grant is dead").toBe("revoke");
    expect(order.indexOf("deleteStream")).toBeGreaterThan(-1);
    expect(order.indexOf("deleteStream")).toBeLessThan(order.indexOf("revoke"));
    await expect(w.fake.accessToken(w.token), "the grant is dead at Google").rejects.toMatchObject({ code: "youtube_reconnect_needed" });

    // In the database.
    expect(await connRow(w.connectionId)).toMatchObject({ status: "revoked", channel_id: null, channel_title: null, google_sub: null });
    expect((await connRow(w.connectionId)).revoked_at).toBeInstanceOf(Date);
    expect(await openToken(sql, w.orgId, w.connectionId), "the token is gone").toBeNull();
    const [dest] = await targetsOf(w.connectionId);
    expect(dest).toMatchObject({ id: w.targetId, label: DISCONNECTED_LABEL, watch_url: null });
    expect(dest!.archived_at).toBeInstanceOf(Date);
    expect(await broadcastsOf(w.connectionId)).toEqual([]);
    expect(await keysOf(w.connectionId)).toBe(0);
    expect(await pendingCount(pending.id), "the abandoned reconnect grant (a sealed token) is gone").toBe(0);
    expect(await streamUrlOf(f0), "the link that pointed at its video is cleared").toBeNull();
    expect(await streamUrlOf(f1), "a club's own link is kept (its parts row is gone all the same)").toBe(CLUB_LINK);
    expect(await streamUrlOf(f2), "a match that never streamed keeps its link").toBe(CLUB_LINK);
    expect((await connectionViews(w.orgId)).has(w.connectionId), "the Streaming page no longer lists it").toBe(false);
    expect(disconnectReports(), "a clean disconnect reports nothing").toEqual([]);
  });

  it("a RETIRED pooled key (its stream is already gone at YouTube) is purged with the rest but is not asked about: no deleteStream call for it, keysDeleted counts only the live key", async () => {
    const w = await world();
    await completedMatch(w, w.fixtures[0]!);
    await sql`update youtube_stream_keys set retired_at = now() where connection_id = ${w.connectionId}`;   // retired by SQL: only a lost stream retires a key
    expect(await keysOf(w.connectionId), "premise: the (retired) key row is there").toBe(1);

    const out = await disconnect(w);
    expect(out.keysDeleted).toBe(0);
    expect(count(w.fake, "deleteStream"), "a retired key is not a stream to delete").toBe(0);
    expect(await keysOf(w.connectionId), "its row is purged all the same").toBe(0);
  });

  it("the stranded sweep finds NOTHING after a disconnect (the sequence with T17): the daily pass checks no channel and purges no connection", async () => {
    const w = await world();
    await completedMatch(w, w.fixtures[0]!);
    await disconnect(w);
    const out = await youtubeDaily(w.fake, new Date(), { orgIds: [w.orgId] });
    expect(out).toEqual({ checked: 0, reconnectNeeded: 0, refreshed: 0, removed: 0, keysRemoved: 0, purged: 0, failed: 0, deferred: 0 });
  });

  it("O-T17a: after the transaction COMMITS, the division of a fixture that carried the watch link is revalidated - once per division, and the revalidation sees the connection already revoked (not an uncommitted tx)", async () => {
    const w = await world();
    const m = await completedMatch(w, w.fixtures[0]!);
    expect(await streamUrlOf(w.fixtures[0]!), "premise: the fixture carries the replay link").toContain(m.ytId);
    const [{ competition_id }] = await sql<{ competition_id: string }[]>`select competition_id from divisions where id = ${w.divisionId}`;
    forgetRevalidations();
    revalidateHook.probe = async () => (await sql<{ status: string }[]>`select status from org_youtube_connections where id = ${w.connectionId}`)[0]?.status;

    await disconnect(w);
    expect(revalidateHook.calls, "one division, one expiry").toEqual([{ divisionId: w.divisionId, competitionId: competition_id }]);
    expect(await Promise.all(revalidateHook.seen), "another connection already reads the commit").toEqual(["revoked"]);
  });

  it("no revalidation when no fixture was touched (nothing public changed): a channel with no broadcast expires no page", async () => {
    const w = await world();
    forgetRevalidations();
    await disconnect(w);
    expect(revalidateHook.calls).toEqual([]);
  });

  // ═══ the in-use guard (the §9.3 mutation target) ═══════════════════════════════════════════════════════════════════════
  it("disconnect while a broadcast is LIVE -> 409 YOUTUBE_IN_USE, and NOTHING changed: not a row, not a key, not the token, not one call to YouTube", async () => {
    const w = await world();
    const { sessionId } = await goLive(w, w.fixtures[0]!);
    await reachLive(w, w.fixtures[0]!);
    const b = await broadcastRow((await sessionRow(sessionId)).youtube_broadcast_id!);
    w.video(b.yt_broadcast_id!);
    const before = await snapshot(w);
    expect(before.keys, "premise: the pool holds the key").toBe(1);
    expect(before.token, "premise: the token is stored").toBe(w.token);
    expect(before.broadcasts.length, "premise: the broadcast row exists").toBe(1);
    const callsBefore = w.fake.calls.length;
    forgetRevalidations();

    await expect(disconnect(w)).rejects.toMatchObject({ status: 409, code: "YOUTUBE_IN_USE", message: IN_USE_MESSAGE });
    expect(await snapshot(w), "nothing changed").toEqual({ ...before, youtubeCalls: callsBefore });
    expect(w.fake.calls.length, "YouTube was asked nothing").toBe(callsBefore);
    expect(revalidateHook.calls).toEqual([]);

    // The positive pair: the stream stops, the grace passes, and the SAME call succeeds.
    await stopSession(w.auth, w.fixtures[0]!, sessionId, w.deps);
    w.fake.videoOff(w.fake.inspectBroadcast(b.yt_broadcast_id!)!.streamId!);
    const ended = (await sessionRow(sessionId)).ended_at!;
    w.setNow(ended.getTime() + min(6));
    await expect(disconnect(w)).resolves.toMatchObject({ revokeOutcome: "revoked" });
  });

  it("disconnect inside the grace (Stopped 2 minutes ago, the broadcast still live) -> 409; at 6 minutes it is due and disconnect succeeds, having COMPLETED the broadcast at YouTube before the revoke (R9)", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    expect((await broadcastRow(m.broadcastId)).state, "premise: still a live row, not yet ended by the step").toBe("live");
    expect(w.fake.inspectBroadcast(m.ytId)!.life, "premise: live at YouTube").toBe("live");

    w.setNow(afterStop(m, min(2)));
    await expect(disconnect(w)).rejects.toMatchObject({ status: 409, code: "YOUTUBE_IN_USE" });
    expect(w.fake.inspectBroadcast(m.ytId)!.life, "the refused call completed nothing").toBe("live");
    expect(count(w.fake, "revoke")).toBe(0);

    w.setNow(afterStop(m, min(6)));
    const from = w.fake.calls.length;
    const out = await disconnect(w);
    expect(out).toMatchObject({ revokeOutcome: "revoked", keysDeleted: 1, purged: { broadcasts: 1 } });
    expect(w.fake.inspectBroadcast(m.ytId)!.life, "no video is left live with no picture").toBe("complete");
    const order = methods(w.fake, from);
    expect(order.indexOf("complete"), "completed at YouTube ...").toBeGreaterThan(-1);
    expect(order.indexOf("complete"), "... before the revoke").toBeLessThan(order.indexOf("revoke"));
    expect(order.indexOf("complete"), "... and before its key's stream goes").toBeLessThan(order.indexOf("deleteStream"));
    expect(await broadcastsOf(w.connectionId), "its row is purged").toEqual([]);
  });

  it("every blocking state (reserved, bound, live) x not-due / due: the guard reads the END RULE, not the state - 409 while the end is not due, success once it is (anti-vacuity: 6 cases)", async () => {
    let checked = 0;
    for (const state of ["bound", "live", "reserved"] as const) {
      for (const due of [false, true] as const) {
        const w = await world();
        const m = await playAndStop(w, w.fixtures[0]!);
        // The producer leaves a `live` row; the other states are the same row moved by SQL (a producer's output moved).
        const reservedUntil = new Date(afterStop(m, due ? min(3) : min(10)));
        if (state === "bound") await sql`update youtube_broadcasts set state = 'bound' where id = ${m.broadcastId}`;
        if (state === "reserved") await sql`update youtube_broadcasts set state = 'reserved', reserved_until = ${reservedUntil} where id = ${m.broadcastId}`;
        expect((await broadcastRow(m.broadcastId)).state, "premise: the row is in the state under test").toBe(state);

        w.setNow(afterStop(m, due ? min(6) : min(2)));
        if (due) {
          await expect(disconnect(w), `${state} / due`).resolves.toMatchObject({ purged: { broadcasts: 1 } });
        } else {
          await expect(disconnect(w), `${state} / not due`).rejects.toMatchObject({ status: 409, code: "YOUTUBE_IN_USE" });
          expect((await connRow(w.connectionId)).status, `${state} / not due: untouched`).toBe("connected");
        }
        checked++;
      }
    }
    expect(checked, "all six cases ran").toBe(6);
  });

  it("a broadcast that was only CREATED (a Go live mid-flight, nothing streamed) does not block: it is deleted at YouTube and its row purged (R9 lists only reserved, bound, live)", async () => {
    const w = await world({ fixtures: 2 });
    // A producer: the real prepare would leave this row; SQL here makes the SHAPE of a created-but-unbound broadcast with a real id.
    const at = await w.fake.accessToken(w.token);
    const { broadcastId } = await w.fake.insertBroadcast(at, { title: "t18 created", description: "", scheduledStart: new Date(), privacy: "unlisted", madeForKids: false });
    await sql`insert into youtube_broadcasts (org_id, connection_id, fixture_id, title, privacy, state, yt_broadcast_id)
              values (${w.orgId}, ${w.connectionId}, ${w.fixtures[0]!}, 't18 created', 'unlisted', 'created', ${broadcastId})`;
    // ... and a created row that crashed BEFORE YouTube was asked (no video id yet - prepare.ts's header names this shape)
    await sql`insert into youtube_broadcasts (org_id, connection_id, fixture_id, title, privacy, state)
              values (${w.orgId}, ${w.connectionId}, ${w.fixtures[1]!}, 't18 no id', 'unlisted', 'created')`;
    expect(w.fake.inspectBroadcast(broadcastId)!.life, "premise: a ready broadcast at YouTube").not.toBe("live");
    const asked = count(w.fake, "broadcastLife");

    const out = await disconnect(w);
    expect(out.purged.broadcasts).toBe(2);
    expect(w.fake.inspectBroadcast(broadcastId), "never went live: deleted at YouTube").toBeNull();
    expect(count(w.fake, "broadcastLife") - asked, "YouTube was asked about the ONE broadcast it has, not about the row that never reached it").toBe(1);
    expect(await broadcastsOf(w.connectionId)).toEqual([]);
  });

  it("the states that are NOT a match using the channel never block, even inside the grace: created, ending, failed, complete (anti-vacuity: 4 cases) - the guard is the state list AND the end rule, not the rule alone", async () => {
    let checked = 0;
    for (const state of ["created", "ending", "failed", "complete"] as const) {
      const w = await world();
      const m = await playAndStop(w, w.fixtures[0]!);
      // The row is the live one the producer left, moved to the state under test by SQL; Stopped 2 minutes ago, so the END RULE alone would block it.
      if (state === "complete") await sql`update youtube_broadcasts set state = 'complete', completed_at = now() where id = ${m.broadcastId}`;
      else await sql`update youtube_broadcasts set state = ${state} where id = ${m.broadcastId}`;
      expect((await broadcastRow(m.broadcastId)).state, "premise: the row is in the state under test").toBe(state);
      w.setNow(afterStop(m, min(2)));
      await expect(disconnect(w), state).resolves.toMatchObject({ purged: { broadcasts: 1 } });
      expect(await broadcastsOf(w.connectionId), `${state}: purged`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(4);
  });

  // ═══ R9: a dead grant, a claimed row ═══════════════════════════════════════════════════════════════════════════════════
  it("R9: a reconnect_needed connection holding a CLAIMED 'ending' row -> disconnect succeeds and purges it; the dead token is not retried, and the revoke is still tried", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    w.fake.killToken(w.token);
    await w.step({ at: afterStop(m, min(6)) });
    const row = await broadcastRow(m.broadcastId);
    expect(row.state, "premise: the real end step claimed it and could not finish").toBe("ending");
    expect((await connRow(w.connectionId)).status, "premise: the dead grant moved the connection").toBe("reconnect_needed");
    const callsBefore = w.fake.calls.length;

    const out = await disconnect(w);
    expect(out).toMatchObject({ keysDeleted: 0, purged: { broadcasts: 1 } });
    expect(await broadcastsOf(w.connectionId), "the claimed row is purged").toEqual([]);
    expect(await keysOf(w.connectionId)).toBe(0);
    expect(await connRow(w.connectionId)).toMatchObject({ status: "revoked", channel_id: null });
    const newCalls = methods(w.fake).slice(callsBefore);
    expect(newCalls, "a dead token can end nothing: one failed access token, then the revoke").toEqual(["accessToken", "revoke"]);
    expect(disconnectReports(), "a dead grant is an expected state, not a report").toEqual([]);
  });

  it("O-T17c: a LIVE-BLOCKED connection (still `connected`, last_error_code youtube_live_blocked) disconnects like any other, and a not-enabled one too (anti-vacuity: 2 connections)", async () => {
    let checked = 0;
    for (const code of ["youtube_live_blocked", "youtube_live_not_enabled"] as const) {
      const w = await world();
      expect(await recordLiveState(sql, w.orgId, w.connectionId, code)).toBe(true);
      const view = (await connectionViews(w.orgId)).get(w.connectionId)!;
      expect(view.status, "premise: the connection is still connected").toBe("connected");
      expect(view.liveState, "premise: the Streaming page reads the refusal").toBe(code === "youtube_live_blocked" ? "blocked" : "not_enabled");
      await expect(disconnect(w)).resolves.toMatchObject({ revokeOutcome: "revoked" });
      expect((await connRow(w.connectionId)).status).toBe("revoked");
      checked++;
    }
    expect(checked).toBe(2);
  });

  // ═══ sequences ═════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("a SECOND disconnect -> 404 (already revoked), no Google call, nothing re-purged", async () => {
    const w = await world();
    await completedMatch(w, w.fixtures[0]!);
    forgetRevalidations();
    await disconnect(w);
    const calls = w.fake.calls.length;
    expect(calls, "premise: the first disconnect called YouTube").toBeGreaterThan(0);
    const row = await connRow(w.connectionId);
    expect(revalidateHook.calls.length, "premise: the first disconnect expired its page").toBe(1);

    await expect(disconnect(w)).rejects.toMatchObject({ status: 404 });
    expect(w.fake.calls.length, "no Google call").toBe(calls);
    expect(await connRow(w.connectionId), "the first revoke's time and state stand").toEqual(row);
    expect(revalidateHook.calls.length, "no second expiry").toBe(1);
  });

  it("a revoked connection that still HOLDS rows (T17's stranded case) is 404 - not the 409 of a broadcast that is not really in use, not a second purge, no Google call", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    expect(await revokeConnection(sql, w.orgId, w.connectionId), "premise: revoked WITHOUT its purge").toBe(true);
    expect((await broadcastsOf(w.connectionId)).length, "premise: the live row is stranded on it").toBe(1);
    w.setNow(afterStop(m, min(2)));   // inside the grace: on a connected channel this row would block
    const calls = w.fake.calls.length;

    await expect(disconnect(w)).rejects.toMatchObject({ status: 404 });
    expect(w.fake.calls.length).toBe(calls);
    expect((await broadcastsOf(w.connectionId)).length, "the stranded row is the daily sweep's, not this call's").toBe(1);
  });

  it("disconnect then RECONNECT the same channel: a NEW connection and destination (the old ones stay history), listed alone; the new one works end to end", async () => {
    const w = await world({ credits: 2 });
    await disconnect(w);
    const again = await connectChannel(w.org, { channels: [w.channel], token: `1//t18-again-${randomUUID()}` });
    w.fake.seedGrant({ refreshToken: again.token, channelId: w.channel.id, channelTitle: w.channel.title });
    expect(again.existing, "the old connection is history: a fresh connect, not a reconnect").toBe(false);
    expect(again.connectionId).not.toBe(w.connectionId);
    expect(again.targetId).not.toBe(w.targetId);
    expect(await connRow(w.connectionId), "the old one stays revoked").toMatchObject({ status: "revoked", channel_id: null });
    expect([...(await connectionViews(w.orgId)).keys()], "listed alone").toEqual([again.connectionId]);
    expect((await targetsOf(w.connectionId))[0]!.archived_at, "the old destination stays archived").toBeInstanceOf(Date);

    // The new connection can go live: the pool starts from nothing.
    const m = await playAndStop(w, w.fixtures[0]!, again.targetId);
    expect((await broadcastRow(m.broadcastId)).connection_id).toBe(again.connectionId);
    await expect(disconnect(w, { connectionId: again.connectionId, now: afterStop(m, min(6)) })).resolves.toMatchObject({ revokeOutcome: "revoked" });
  });

  it("after a disconnect the SAME channel can be connected by ANOTHER org (the global one-live-channel index is freed)", async () => {
    const w = await world();
    await disconnect(w);
    const other = await seedYoutubeOrg();
    const c = await connectChannel(other, { channels: [w.channel] });
    expect(c.existing).toBe(false);
    expect((await connRow(c.connectionId)).status).toBe("connected");
  });

  it("Go live on the archived destination after a disconnect -> the existing 404 'stream target not found'", async () => {
    const w = await world();
    await disconnect(w);
    const [dest] = await targetsOf(w.connectionId);
    expect(dest!.archived_at, "premise: archived").toBeInstanceOf(Date);
    await pairPresentPhone(w.fixtures[0]!, { at: w.deps.now() });
    await expect(organiserStart(w.auth, w.fixtures[0]!, { mode: "passthrough", targetId: w.targetId }, w.deps)).rejects.toMatchObject({
      status: 404, message: "stream target not found",
    });
  });

  it("another channel of the SAME org is untouched: its token, key, broadcast and destination all stand and it still goes live (disconnect is scoped by connection, not org)", async () => {
    const w = await world({ fixtures: 2, credits: 2 });
    const second = await w.addChannel();
    const m1 = await completedMatch(w, w.fixtures[0]!);
    const m2 = await completedMatch(w, w.fixtures[1]!, second.targetId);
    const before = await snapshot(w, second);
    expect(before.keys, "premise: the second channel has its own key").toBe(1);
    expect(before.broadcasts.length, "premise: and its own part").toBe(1);

    await disconnect(w);
    expect(await snapshot(w, second)).toEqual({ ...before, youtubeCalls: w.fake.calls.length, streams: before.streams });
    expect(await connRow(second.connectionId)).toMatchObject({ status: "connected" });
    expect(await openToken(sql, w.orgId, second.connectionId)).toBe(second.token);
    expect(w.fake.inspectBroadcast(m2.ytId)!.life).toBe("complete");
    expect(w.fake.inspectBroadcast(m1.ytId)!.life).toBe("complete");
    expect(await streamUrlOf(w.fixtures[1]!), "the second channel's replay link stands").toContain(m2.ytId);
    expect(await streamUrlOf(w.fixtures[0]!), "the first channel's is cleared").toBeNull();
    await expect(w.fake.accessToken(second.token), "the other grant still works at Google").resolves.toEqual(expect.any(String));
  });

  // ═══ the shared grant ══════════════════════════════════════════════════════════════════════════════════════════════════
  it("T6-R2: another LIVE connection (in another org) reporting the same Google account -> NO revoke call, 'revoke_skipped_shared_grant' recorded, our copy still purged; that connection still works. The positive pair: a different account is revoked", async () => {
    const sub = `sub-t18-${randomUUID()}`;
    const w = await world({ sub });
    const otherOrg = await seedYoutubeOrg();
    const b = await w.addChannel({ sub, org: otherOrg });
    await completedMatch(w, w.fixtures[0]!);
    expect((await connRow(w.connectionId)).google_sub, "premise: both report one account").toBe(sub);
    expect((await connRow(b.connectionId)).google_sub).toBe(sub);

    const out = await disconnect(w);
    expect(out).toMatchObject({ revokeOutcome: "skipped_shared_account", keysDeleted: 1, purged: { broadcasts: 1 } });
    expect(count(w.fake, "revoke"), "the grant the other club runs on is left alone").toBe(0);
    expect(await connRow(w.connectionId)).toMatchObject({ status: "revoked", last_error_code: SKIPPED, google_sub: null });
    expect((await connRow(w.connectionId)).last_error_code, "recorded as a code V479 accepts").toMatch(CODE_SHAPE);
    expect(await openToken(sql, w.orgId, w.connectionId), "our copy of the token is gone all the same").toBeNull();
    expect((await connRow(b.connectionId)).status, "the other connection is untouched").toBe("connected");
    await expect(w.fake.accessToken(b.token), "and its token still works").resolves.toEqual(expect.any(String));

    // A different account: revoked.
    const w2 = await world({ sub: `sub-t18-${randomUUID()}` });
    const o2 = await w2.addChannel({ sub: `sub-t18-other-${randomUUID()}`, org: await seedYoutubeOrg() });
    expect(await disconnect(w2)).toMatchObject({ revokeOutcome: "revoked" });
    expect(count(w2.fake, "revoke")).toBe(1);
    expect((await connRow(w2.connectionId)).last_error_code, "nothing recorded when the revoke was made").toBeNull();
    await expect(w2.fake.accessToken(o2.token), "the other account is unaffected").resolves.toEqual(expect.any(String));
  });

  it("a connection with NO Google account id is never 'shared' (two such connections are two accounts: revoked), and a REVOKED connection of the same account does not count", async () => {
    // null sub on both
    const a = await world({ sub: null });
    await a.addChannel({ sub: null, org: await seedYoutubeOrg() });
    expect(await disconnect(a)).toMatchObject({ revokeOutcome: "revoked" });
    expect(count(a.fake, "revoke"), "null never matches null").toBe(1);

    // a revoked row that kept the account id (revoked WITHOUT the purge that would clear it - SQL-shaped on purpose)
    const sub = `sub-t18-${randomUUID()}`;
    const w = await world({ sub });
    const orgB = await seedYoutubeOrg();
    const b = await w.addChannel({ sub, org: orgB });
    expect(await revokeConnection(sql, orgB.orgId, b.connectionId)).toBe(true);
    expect((await connRow(b.connectionId)).google_sub, "premise: the revoked row still holds the account id").toBe(sub);
    expect(await disconnect(w)).toMatchObject({ revokeOutcome: "revoked" });
    expect(count(w.fake, "revoke")).toBe(1);
  });

  it("M4: two connections on ONE Google account disconnected at the same moment: exactly one revokes the grant and the other is told it was shared - never both skipped, which would leave the grant alive at Google after both clubs are gone", async () => {
    const sub = `sub-t18-${randomUUID()}`;
    const w = await world({ sub });
    const orgB = await seedYoutubeOrg();
    const b = await w.addChannel({ sub, org: orgB });
    // The window between "is the account shared?" and the write that acts on it: both disconnects are held there until BOTH have read (or
    // 400 ms pass, which is what happens when the account lock makes the second wait for the first to commit).
    let arrived = 0;
    let meet!: () => void;
    const met = new Promise<void>((r) => { meet = r; });
    const hooks = { afterSharedRead: async () => { arrived++; if (arrived === 2) meet(); await Promise.race([met, new Promise((r) => setTimeout(r, 400))]); } };
    const at = { now: () => new Date(w.now()), hooks };
    const [x, y] = await Promise.all([
      disconnectYoutube(w.auth, w.orgId, w.connectionId, w.fake, at),
      disconnectYoutube(orgB.auth, orgB.orgId, b.connectionId, w.fake, at),
    ]);
    expect(arrived, "anti-vacuity: both disconnects reached the window").toBe(2);
    expect([x.revokeOutcome, y.revokeOutcome].sort(), "one revoked, one was shared").toEqual(["revoked", "skipped_shared_account"]);
    expect(count(w.fake, "revoke"), "the grant was revoked once").toBe(1);
    await expect(w.fake.accessToken(w.token), "dead at Google").rejects.toMatchObject({ code: "youtube_reconnect_needed" });
    await expect(w.fake.accessToken(b.token), "for the other club's connection too").rejects.toMatchObject({ code: "youtube_reconnect_needed" });
    expect((await connRow(w.connectionId)).status).toBe("revoked");
    expect((await connRow(b.connectionId)).status).toBe("revoked");
  });

  it("M4: a disconnect of an account whose lock is held WAITS for it (the key is hashtextextended('yt-sub:' || sub, 0)), then goes ahead; one with no account id is not held by it", async () => {
    const sub = `sub-t18-${randomUUID()}`;
    const w = await world({ sub });
    const hold = await holdAccountLock(sub);
    let settled = false;
    const done = disconnect(w).then((r) => { settled = true; return r; });
    await waitForAccountLockWaiters(sub, 1);
    expect(settled, "queued behind the holder").toBe(false);
    expect((await connRow(w.connectionId)).status, "nothing was written behind the holder's back").toBe("connected");
    await hold.release();
    expect(await done).toMatchObject({ revokeOutcome: "revoked" });
    expect(await accountLockWaiters(sub), "and nobody is left queued").toBe(0);

    // No account id: nothing to lock on, so the same act is not held by anyone's lock.
    const n = await world({ sub: null });
    expect(await disconnect(n)).toMatchObject({ revokeOutcome: "revoked" });
  });

  it("F1 - the revoke outcome is tri-state, and a Google answer, a damaged token and a shared account are told apart: revoked | skipped_shared_account | not_confirmed (anti-vacuity: 4 scenarios, all 3 values seen)", async () => {
    const seen = new Set<string>();
    const check = (out: { revokeOutcome: string }, want: string, why: string) => {
      expect(out.revokeOutcome, why).toBe(want);
      seen.add(out.revokeOutcome);
    };
    // Google refused the revoke: attempted and failed
    const refused = await world();
    refused.fake.failNext("revoke", "youtube_unavailable", "backendError", { channelId: refused.channel.id });
    check(await disconnect(refused), "not_confirmed", "Google did not answer the revoke");
    expect(count(refused.fake, "revoke"), "premise: the revoke WAS attempted").toBe(1);

    // a damaged envelope: never attempted, and that is not 'skipped on purpose'
    const damaged = await world();
    await sql`update org_youtube_connections set refresh_token_enc = decode('deadbeef', 'hex') where id = ${damaged.connectionId}`;
    check(await disconnect(damaged), "not_confirmed", "no usable token");
    expect(count(damaged.fake, "revoke"), "premise: no revoke was attempted").toBe(0);

    // a shared account whose token will not open is still 'skipped on purpose' (it was never ours to revoke)
    const sub = `sub-t18-${randomUUID()}`;
    const sharedDamaged = await world({ sub });
    await sharedDamaged.addChannel({ sub, org: await seedYoutubeOrg() });
    await sql`update org_youtube_connections set refresh_token_enc = decode('deadbeef', 'hex') where id = ${sharedDamaged.connectionId}`;
    check(await disconnect(sharedDamaged), "skipped_shared_account", "shared account, damaged token");

    // and the plain case is the positive pair
    check(await disconnect(await world()), "revoked", "a plain revoke");
    expect([...seen].sort(), "all three values were produced").toEqual(["not_confirmed", "revoked", "skipped_shared_account"]);
  });

  // ═══ who may ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("org B probing org A's BUSY connection gets the same 404 as for a missing one - never the 409 that would say 'this channel exists and a match is using it'", async () => {
    const w = await world();
    const { sessionId } = await goLive(w, w.fixtures[0]!);
    await reachLive(w, w.fixtures[0]!);
    expect((await sessionRow(sessionId)).state, "premise: the channel is in use").toBe("live");
    const intruder = await seedYoutubeOrg();

    await expect(disconnect(w, { auth: intruder.auth, orgId: intruder.orgId })).rejects.toMatchObject({ status: 404 });
    await expect(disconnect(w, { auth: intruder.auth, orgId: intruder.orgId, connectionId: randomUUID() })).rejects.toMatchObject({ status: 404 });
    // the owner of the busy channel does get the 409 (the positive pair: the busy state is real)
    await expect(disconnect(w)).rejects.toMatchObject({ status: 409, code: "YOUTUBE_IN_USE" });
  });

  it("org B cannot disconnect org A's connection -> 404 and nothing changes (the org in the auth, and the org in the SQL, each scope it)", async () => {
    const w = await world();
    const intruder = await seedYoutubeOrg();
    const before = await snapshot(w);

    // (a) the URL names A, the caller is B
    await expect(disconnect(w, { auth: intruder.auth })).rejects.toMatchObject({ status: 404 });
    // (b) the URL names B (the caller's own org) and A's connection id: the SQL's org scope is the only guard left
    await expect(disconnect(w, { auth: intruder.auth, orgId: intruder.orgId })).rejects.toMatchObject({ status: 404 });
    expect(await snapshot(w)).toEqual(before);
    expect(w.fake.calls.length, "YouTube was never asked").toBe(before.youtubeCalls);
    // a missing id answers the same
    await expect(disconnect(w, { connectionId: randomUUID() })).rejects.toMatchObject({ status: 404 });
    // the positive pair: A's own call succeeds
    await expect(disconnect(w)).resolves.toMatchObject({ revokeOutcome: "revoked" });
  });

  // ═══ YouTube fails in the middle: the purge never stops; no secret escapes ═════════════════════════════════════════════
  it("a YouTube failure at every step (complete, deleteStream, revoke) never stops the purge: the connection is revoked and every row gone, the result says what did not happen, and Sentry gets CODES only - no token, key or ingest URL anywhere", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    const key = w.issued[0]!;
    w.fake.failNext("complete", "youtube_unavailable", "backendError", { channelId: w.channel.id });
    w.fake.failNext("deleteStream", "youtube_unavailable", "backendError", { channelId: w.channel.id });
    w.fake.failNext("revoke", "youtube_unavailable", "backendError", { channelId: w.channel.id });

    const out = await disconnect(w, { now: afterStop(m, min(6)) });
    expect(out).toEqual({ revokeOutcome: "not_confirmed", keysDeleted: 0, purged: { broadcasts: 1, streamUrlsCleared: 0 } });
    expect(await connRow(w.connectionId)).toMatchObject({ status: "revoked", channel_id: null, google_sub: null });
    expect(await openToken(sql, w.orgId, w.connectionId)).toBeNull();
    expect(await broadcastsOf(w.connectionId)).toEqual([]);
    expect(await keysOf(w.connectionId)).toBe(0);
    expect(disconnectReports().length, "each of the three failures was reported").toBe(3);

    const everything = JSON.stringify({ reports: sentry.captureError.mock.calls.map(([e, c]) => [(e as Error).message, (e as Error).name, c]), calls: w.fake.calls });
    for (const secret of [w.token, key.streamKey, key.url]) expect(everything, "a secret reached a report").not.toContain(secret);
    for (const [e] of disconnectReports()) expect((e as Error).message).toMatch(/youtube_unavailable/);
    // The stranded sweep is the safety net: nothing is left for it
    expect(await youtubeDaily(w.fake, new Date(), { orgIds: [w.orgId] })).toMatchObject({ purged: 0 });
  });

  it("a driver that throws something that is NOT a port refusal is reported as a fresh error naming only its class - its message (which may hold a token) never reaches the report - and the purge still happens", async () => {
    const w = await world();
    await completedMatch(w, w.fixtures[0]!);
    const broken = Object.create(w.fake) as FakeYouTube;
    broken.deleteStream = async () => { throw new TypeError("refresh_token=1//hunter2-leaked"); };

    const out = await disconnect(w, { port: broken });
    expect(out).toMatchObject({ keysDeleted: 0, revokeOutcome: "revoked", purged: { broadcasts: 1 } });
    expect((await connRow(w.connectionId)).status).toBe("revoked");
    const reports = disconnectReports();
    expect(reports.length).toBe(1);
    expect(JSON.stringify(reports.map(([e, c]) => [(e as Error).message, c]))).not.toContain("hunter2");
    expect((reports[0]![0] as Error).message).toContain("TypeError");
  });

  it("a saved token that will not open (a damaged envelope) does not make the channel undeletable: it is revoked and purged here, YouTube is asked nothing, the revoke is not_confirmed", async () => {
    const w = await world();
    await completedMatch(w, w.fixtures[0]!);
    await sql`update org_youtube_connections set refresh_token_enc = decode('deadbeef', 'hex') where id = ${w.connectionId}`;   // SQL: no producer damages an envelope
    const calls = w.fake.calls.length;

    const out = await disconnect(w);
    expect(out).toMatchObject({ revokeOutcome: "not_confirmed", keysDeleted: 0, purged: { broadcasts: 1 } });
    expect(w.fake.calls.length, "no token, no call").toBe(calls);
    expect(await connRow(w.connectionId)).toMatchObject({ status: "revoked", channel_id: null });
    expect(await broadcastsOf(w.connectionId)).toEqual([]);
    expect(await keysOf(w.connectionId)).toBe(0);
  });

  it("the clean-up has a wall-clock BUDGET: past it the remaining broadcasts and keys are left (one report, counts only) but the Google revoke is STILL made - the policy's step - and the purge stands", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    const key = w.issued[0]!;
    // the first reading of the clock starts the budget, every later one is ten minutes on
    let reads = 0;
    const wallClock = () => (reads++ === 0 ? 0 : 10 * MIN);
    const from = w.fake.calls.length;

    const out = await disconnectYoutube(w.auth, w.orgId, w.connectionId, w.fake, { now: () => new Date(afterStop(m, min(6))), wallClock });
    expect(out, "no broadcast ended, no key deleted - and the grant revoked").toEqual({ revokeOutcome: "revoked", keysDeleted: 0, purged: { broadcasts: 1, streamUrlsCleared: 0 } });
    expect(methods(w.fake, from), "an access token, then the revoke: the two steps the budget does not cover").toEqual(["accessToken", "revoke"]);
    expect(w.fake.inspectBroadcast(m.ytId)!.life, "left live at YouTube: that is what the report is for").toBe("live");
    const reports = disconnectReports();
    expect(reports.length).toBe(1);
    expect(reports[0]![1]).toMatchObject({ route: "youtube.disconnect.budget", extra: { skipped: 2 } });   // one broadcast + one key
    expect(JSON.stringify(reports)).not.toContain(key.streamKey);
    expect((await connRow(w.connectionId)).status).toBe("revoked");
  });

  it("no row lock is held across a YouTube call: every call of the cleanup finds the connection row free (`for update nowait`), and the probe really ran (anti-vacuity)", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    let probes = 0;
    const probe = async () => {
      probes++;
      await sql.begin(async (tx) => { await tx`select id from org_youtube_connections where id = ${w.connectionId} for update nowait`; });
    };
    const f = w.fake;
    const probed = Object.create(f) as FakeYouTube;
    probed.accessToken = async (rt) => { await probe(); return f.accessToken(rt); };
    probed.broadcastLife = async (at, id) => { await probe(); return f.broadcastLife(at, id); };
    probed.complete = async (at, id) => { await probe(); return f.complete(at, id); };
    probed.deleteBroadcast = async (at, id) => { await probe(); return f.deleteBroadcast(at, id); };
    probed.deleteStream = async (at, id) => { await probe(); return f.deleteStream(at, id); };
    probed.revoke = async (rt) => { await probe(); return f.revoke(rt); };

    await expect(disconnect(w, { port: probed, now: afterStop(m, min(6)) })).resolves.toMatchObject({ revokeOutcome: "revoked", keysDeleted: 1 });
    expect(probes, "accessToken, broadcastLife, complete, deleteStream, revoke").toBeGreaterThanOrEqual(5);
    expect(disconnectReports(), "no probe failed inside the cleanup").toEqual([]);
  });

  it("two disconnects racing: exactly one wins (200), the other is the 404 of a revoked connection; YouTube is revoked once", async () => {
    const w = await world();
    await completedMatch(w, w.fixtures[0]!);
    const results = await Promise.allSettled([disconnect(w), disconnect(w)]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won.length, "one winner").toBe(1);
    expect(lost.length, "one loser").toBe(1);
    expect(lost[0]!.reason).toMatchObject({ status: 404 });
    expect(count(w.fake, "revoke"), "revoked at Google once").toBe(1);
  });

  // ═══ guards the first mutation sweep found undefended ══════════════════════════════════════════════════════════════════
  it("the grace boundary is the end step's own: Stopped exactly 5 minutes ago the broadcast is DUE (disconnect proceeds); one millisecond earlier it is not (409) - and the real end step agrees at both instants", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    w.setNow(afterStop(m, min(5) - 1));
    await expect(disconnect(w), "1 ms before the grace ends").rejects.toMatchObject({ status: 409, code: "YOUTUBE_IN_USE" });
    expect(await w.step({ at: afterStop(m, min(5) - 1) }), "the end step also leaves it").toMatchObject({ ended: 0 });
    expect((await connRow(w.connectionId)).status).toBe("connected");

    w.setNow(afterStop(m, min(5)));
    await expect(disconnect(w), "exactly at the end of the grace").resolves.toMatchObject({ revokeOutcome: "revoked", purged: { broadcasts: 1 } });
    // the same instant, through the real end step on a second channel: it claims and ends the broadcast (parity of the two clocks)
    const v = await world();
    const mv = await playAndStop(v, v.fixtures[0]!);
    expect(await v.step({ at: afterStop(mv, min(5)) }), "the end step ends it at exactly the same instant").toMatchObject({ ended: 1 });
  });

  // ═══ F2: the end rule refuses to answer from broken facts ═════════════════════════════════════════════════════════════
  it("F2: a broadcast whose facts break the end rule's invariant (a Stopped session with no ended_at; a finished fixture with no finished_at) is a NAMED refusal 409 YOUTUBE_END_UNKNOWN, reported with ids only, nothing changed, YouTube asked nothing - and once the facts are whole the same call succeeds (anti-vacuity: 2 breaks)", async () => {
    const breaks: { name: string; break: (w: World, m: Match) => Promise<void>; repair: (w: World, m: Match) => Promise<void> }[] = [
      {
        name: "a terminal session with no ended_at",
        break: async (_w, m) => { await sql`update fixture_stream_sessions set ended_at = null where id = ${m.sessionId}`; },
        repair: async (_w, m) => { await sql`update fixture_stream_sessions set ended_at = ${m.endedAt} where id = ${m.sessionId}`; },
      },
      {
        // SQL on purpose: no producer writes a finished fixture without its finished_at. The V430/V432 trigger stamps it on the update
        // that names status, so the stamp is removed by a second statement that does not.
        name: "a finished fixture with no finished_at",
        break: async (w) => {
          await sql`update fixtures set status = 'decided' where id = ${w.fixtures[0]!}`;
          await sql`update fixtures set finished_at = null where id = ${w.fixtures[0]!}`;
          expect((await sql<{ finished_at: Date | null }[]>`select finished_at from fixtures where id = ${w.fixtures[0]!}`)[0]!.finished_at, "premise: the break took").toBeNull();
        },
        repair: async (w, m) => { await sql`update fixtures set finished_at = ${m.endedAt} where id = ${w.fixtures[0]!}`; },
      },
    ];
    let reached = 0;
    for (const b of breaks) {
      sentry.captureError.mockClear();
      const w = await world();
      const m = await playAndStop(w, w.fixtures[0]!);
      await b.break(w, m);
      const at = afterStop(m, min(6));
      const before = await snapshot(w);

      const err = await disconnect(w, { now: at }).then(() => null, (e: unknown) => e);
      expect(err, `${b.name}: refused`).toMatchObject({ status: 409, code: "YOUTUBE_END_UNKNOWN" });
      expect((err as { code: string }).code, `${b.name}: not the in-use code - nobody said a match is using it`).not.toBe("YOUTUBE_IN_USE");
      expect(await snapshot(w), `${b.name}: nothing changed`).toEqual(before);
      expect(w.fake.calls.length, `${b.name}: YouTube was asked nothing`).toBe(before.youtubeCalls);
      const reports = disconnectReports();
      expect(reports.length, `${b.name}: reported once`).toBe(1);
      expect(reports[0]![1], b.name).toMatchObject({ orgId: w.orgId, route: "youtube.disconnect.end_rule", extra: { connectionId: w.connectionId, broadcastId: m.broadcastId } });
      expect(Object.keys((reports[0]![1] as { extra: object }).extra).sort(), `${b.name}: ids only`).toEqual(["broadcastId", "connectionId"]);
      expect(JSON.stringify(sentry.captureError.mock.calls.map(([e, c]) => [(e as Error).message, c])), `${b.name}: no secret`).not.toContain(w.token);

      await b.repair(w, m);
      await expect(disconnect(w, { now: at }), `${b.name}: whole facts disconnect`).resolves.toMatchObject({ revokeOutcome: "revoked" });
      reached++;
    }
    expect(reached).toBe(breaks.length);
  });

  it("F2: only the end rule's own refusal is named - any other failure inside the guard still fails loudly and changes nothing (no catch-all)", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    await sql`update youtube_broadcasts set state = 'reserved', reserved_until = ${new Date(afterStop(m, min(30)))} where id = ${m.broadcastId}`;   // SQL on purpose: a reservation the rule must compare with `now`
    class Exploding extends Date { override getTime(): number { throw new TypeError("not an end-rule refusal"); } }
    const before = await snapshot(w);
    const failure = await disconnectYoutube(w.auth, w.orgId, w.connectionId, w.fake, { now: () => new Exploding(afterStop(m, min(6))) }).then(() => null, (e: unknown) => e);
    expect(failure, "it rejected").toBeInstanceOf(TypeError);
    expect((failure as { code?: string }).code, "and it is not the named refusal").toBeUndefined();
    expect(await snapshot(w)).toEqual(before);
    expect(disconnectReports(), "and not reported as an end-rule break").toEqual([]);
  });

  // ═══ F4: a FINISHED match ends sooner than the grace ═══════════════════════════════════════════════════════════════════
  it("F4: a match that was DECIDED by a real result is due at Stop + the finished-end minutes, not the grace's: the channel disconnects 1 ms later than that, is refused 1 ms before - and the same instant on an UNFINISHED match is still 409 (the right answer differs from the wrong one's)", async () => {
    // premises from the rule's own constants: the two answers are different instants, so a test at +FINISHED_END+1 can tell them apart
    expect(YOUTUBE_FINISHED_END_MINUTES, "the finished end comes first").toBeLessThan(YOUTUBE_GRACE_MINUTES);
    const finishedDue = min(YOUTUBE_FINISHED_END_MINUTES);
    const betweenTheTwo = finishedDue + min(1);
    expect(betweenTheTwo, "an instant after the finished end and inside the grace").toBeLessThan(min(YOUTUBE_GRACE_MINUTES));

    // an UNFINISHED match, checked inside the grace but after the finished end: still using the channel
    const open = await world();
    const mo = await playAndStop(open, open.fixtures[0]!);
    open.setNow(afterStop(mo, betweenTheTwo));
    await expect(disconnect(open), "no result: the grace applies").rejects.toMatchObject({ status: 409, code: "YOUTUBE_IN_USE" });

    // the SAME match once a REAL result is recorded (start, result, finalize through the scoring write path)
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    let seq = 0;
    for (const ev of decidingStream()) await scoreEvent(w.auth, w.fixtures[0]!, { expected_seq: seq++, type: ev.type, payload: ev.payload } as never);
    const [fx] = await sql<{ status: string; finished_at: Date | null }[]>`select status, finished_at from fixtures where id = ${w.fixtures[0]!}`;
    expect(FINISHED_STATUSES as readonly string[], "premise: the real result made the fixture finished").toContain(fx!.status);
    expect(fx!.finished_at, "premise: and the database stamped when").toBeInstanceOf(Date);
    // finished_at is the database's clock, the Stop is the injected one a minute ahead of it: the Stop is the later of the two
    const due = Math.max(m.endedAt.getTime(), fx!.finished_at!.getTime()) + finishedDue;

    w.setNow(due - 1);
    await expect(disconnect(w), "1 ms before the finished end").rejects.toMatchObject({ status: 409, code: "YOUTUBE_IN_USE" });
    expect(await w.step({ at: due - 1 }), "the end step also leaves it").toMatchObject({ ended: 0 });
    expect((await connRow(w.connectionId)).status).toBe("connected");
    w.setNow(afterStop(m, betweenTheTwo));
    expect(w.now(), "premise: this is the instant the unfinished match was refused at").toBeGreaterThanOrEqual(due);
    await expect(disconnect(w), "after the finished end, inside the grace").resolves.toMatchObject({ revokeOutcome: "revoked", purged: { broadcasts: 1 } });
    expect((await connRow(w.connectionId)).status).toBe("revoked");
  });

  it("O-T17a for MANY divisions: every division whose fixture carried a replay link is revalidated, not only the first (anti-vacuity: two divisions)", async () => {
    const w = await world({ credits: 2 });
    const second = await divisionRig(w.auth, { entrants: 2 });
    await pairPresentPhone(second.fixtureIds[0]!);
    await completedMatch(w, w.fixtures[0]!);
    await completedMatch(w, second.fixtureIds[0]!);
    const divisions = await sql<{ id: string; competition_id: string }[]>`
      select id, competition_id from divisions where id in ${sql([w.divisionId, second.divisionId])} order by id`;
    expect(divisions.length, "premise: two distinct divisions").toBe(2);
    for (const f of [w.fixtures[0]!, second.fixtureIds[0]!]) expect(await streamUrlOf(f), "premise: each carries a replay link").not.toBeNull();
    forgetRevalidations();

    await disconnect(w);
    const seen = [...revalidateHook.calls].sort((a, b) => a.divisionId.localeCompare(b.divisionId));
    expect(seen, "one expiry per division").toEqual(divisions.map((d) => ({ divisionId: d.id, competitionId: d.competition_id })));
  });

  it("a missing token KEK is the deployment's fault, not 'no token': the disconnect fails loudly and NOTHING changes (the transaction rolls back), then works once the KEK is back", async () => {
    const w = await world();
    await completedMatch(w, w.fixtures[0]!);
    const before = await snapshot(w);
    const kek = process.env.YOUTUBE_TOKEN_KEK;
    delete process.env.YOUTUBE_TOKEN_KEK;
    try {
      const failure = await disconnect(w).then(() => null, (e: unknown) => e);
      expect(failure, "it rejected").not.toBeNull();
      expect((failure as { status?: number }).status, "not the 404/409 of a business refusal").toBeUndefined();
    } finally {
      process.env.YOUTUBE_TOKEN_KEK = kek;
    }
    expect(await snapshot(w), "nothing changed").toEqual(before);
    await expect(disconnect(w)).resolves.toMatchObject({ revokeOutcome: "revoked" });
  });

  it("the connection lock is scoped to the caller's org: org B asking for org A's connection while A's row is locked is the 404 at once - it does not queue behind A", async () => {
    const w = await world();
    const intruder = await seedYoutubeOrg();
    let release!: () => void;
    let taken!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const locked = new Promise<void>((r) => { taken = r; });
    const holder = sql.begin(async (tx) => {
      await tx`select id from org_youtube_connections where id = ${w.connectionId} for update`;
      taken();
      await gate;
    });
    try {
      await locked;
      const answer = await Promise.race([
        disconnect(w, { auth: intruder.auth, orgId: intruder.orgId }).then(() => "resolved", (e: { status?: number }) => `rejected ${e.status}`),
        new Promise<string>((r) => setTimeout(() => r("hung behind the lock"), 3000)),
      ]);
      expect(answer).toBe("rejected 404");
    } finally {
      release();
      await holder;
    }
  });

  it("the broadcast rows are locked before the guard reads them: a change committed while the disconnect waits is SEEN - a 'created' row that becomes 'bound' under it makes the call a 409, not a purge of a channel a match just took", async () => {
    const w = await world();
    const [{ id: rowId }] = await sql<{ id: string }[]>`
      insert into youtube_broadcasts (org_id, connection_id, fixture_id, title, privacy, state)
      values (${w.orgId}, ${w.connectionId}, ${w.fixtures[0]!}, 't18 lock', 'unlisted', 'created') returning id`;
    let release!: () => void;
    let taken!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const locked = new Promise<void>((r) => { taken = r; });
    const holder = sql.begin(async (tx) => {
      await tx`select id from youtube_broadcasts where id = ${rowId} for update`;
      taken();
      await gate;
      await tx`update youtube_broadcasts set state = 'bound' where id = ${rowId}`;
    });
    await locked;
    let settled = false;
    const run = disconnect(w).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 600));
    expect(settled, "the disconnect waits for the row's lock instead of reading around it").toBe(false);
    release();
    await holder;
    const out = await run;
    expect(out.ok, "the committed 'bound' state was seen").toBe(false);
    if (!out.ok) expect(out.e).toMatchObject({ status: 409, code: "YOUTUBE_IN_USE" });
    expect((await connRow(w.connectionId)).status).toBe("connected");
    expect(await broadcastsOf(w.connectionId), "the row is still there").toHaveLength(1);
  });
});
