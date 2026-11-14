// The YouTube live status line (owner direction 2026-11-14, stream-output-health-warning design): after Go live on a YouTube Connect
// destination, the stream-tick pass AND the organiser's poll read YouTube (the broadcast's life, and - when it is live - its stream's
// status and health) and the session view carries ONE word:  live_receiving | not_live | live_no_video.
//   * the first read is 60 s after the session went live, never before;
//   * every change of word is ONE session event, written in the same transaction as the stored word; a read that changes nothing
//     writes nothing;
//   * an API error (or an answer that says nothing) is NOT a word: the previous one is carried and nothing is recorded - EXCEPT a dead
//     grant, which clears the word (nothing will ever refresh it);
//   * a broadcast YouTube is still starting (`liveStarting`) is not live: not_live, even beside an active, healthy stream;
//   * a not_live that persists past NOT_LIVE_WARN_MS reads amber on the panel (the view carries the server's own age, `youtubeLiveForMs`);
//   * a stream that has said live_receiving three reads in a row is read every five minutes, not every minute, until any other word;
//   * a pasted key has no YouTube API behind it: no call, and the panel says the status is unavailable;
//   * a session that has ended is never read.
//
// Driven through the REAL producers wherever one exists (class 1, "the inert seam"): the real Go live on a connected channel (real
// prepare against a FakeYouTube), the REAL stream tick (`tickOpenSessions`, the cron's pass) and the REAL organiser poll
// (`currentSession`), the real Stop, the real restart-inside-the-grace, and a pasted key saved through the real `createStreamTarget`.
// The word is read OUT of the view the panel polls, and the events out of fixture_stream_events. The clock is the test's.
//
// Expected values are typed here from the owner's words and from the fake's own documented behaviour (a bound stream with no video is
// `ready`/`noData`; video makes it `active`/`good`); never read back out of the module under test. The 60 s is the owner's number,
// typed here; the read window is this build's own constant and is read from its export, with a pin on its relation to the cron.
//
// Sport: not applicable - streaming is sport-agnostic (every rig rides `generic`).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { pairPresentPhone, rigUser, spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import { divisionRig, seedOrg } from "@/server/usecases/__tests__/_rig";
import { grantCredits } from "@/server/usecases/stream-credits";
import { createSession as organiserStart, currentSession, stopSession, tickOpenSessions, type SessionDeps } from "@/server/usecases/stream-sessions";
import { youtubeStatusLineOf } from "@/lib/stream-session-view";
import { NOT_LIVE_WARN_MS } from "@/lib/youtube";
import {
  YOUTUBE_STATUS_FIRST_READ_AFTER_MS, YOUTUBE_STATUS_READ_EVERY_MS, YOUTUBE_STATUS_STEADY_AFTER_READS, YOUTUBE_STATUS_STEADY_EVERY_MS,
} from "@/server/usecases/stream-sessions/youtube-status";
import { createStreamTarget } from "@/server/usecases/stream-targets";
import { FakeYouTube } from "../fake";
import { type YoutubeErrorCode } from "../port";
import { connect } from "./_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;

const SEC = 1000;
/** The owner's number (the design: "first read 60 s after Go live"), typed here - not read from the module. */
const FIRST_READ_MS = 60 * SEC;
const ENV = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "RELAY_IMAGE"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:yt-status-test";
});
afterAll(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** The two calls that READ a broadcast's status. (`accessToken` rides with them; it is a token mint, not a Data API read.) */
const STATUS_READS = ["broadcastLife", "streamStatus"] as const;

async function rig() {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  const d = await divisionRig(auth, { entrants: 2 });
  const f = d.fixtureIds[0]!;
  for (const key of ["streaming.overlay", "streaming.relay"]) {
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${auth.orgId}, ${key}, true, 'yt status unit')
              on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  await invalidateOrgEntitlements(auth.orgId);
  await grantCredits({ orgId: auth.orgId, delta: 5, createdBy: await rigUser(), note: "yt status", idempotencyKey: randomUUID() });
  await spendMonthlyStreamGrant(auth.orgId);
  const c = await connect({ auth, orgId: auth.orgId, userId: auth.userId });

  let now = Date.now();
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs: 3000 });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: 100_000_000, videoCount: 0 };
  const fake = new FakeYouTube({ now: () => new Date(now) });
  const deps: SessionDeps = { drivers: { ingest, runner: new FakeRunner() }, now: () => new Date(now), appUrl: "http://app.test", youtube: fake };

  const goLive = async (targetId: string = c.targetId): Promise<string> => {
    await pairPresentPhone(f, { at: deps.now() });
    const { sessionId } = await organiserStart(auth, f, { mode: "passthrough", targetId }, deps);
    return sessionId;
  };
  const view = async () => (await currentSession(auth, f, deps))!;
  const startedAt = async (sid: string): Promise<number> => {
    const [row] = await sql<{ started_at: Date | null }[]>`select started_at from fixture_stream_sessions where id = ${sid}`;
    expect(row?.started_at, "premise: the session went live").not.toBeNull();
    return new Date(row!.started_at!).getTime();
  };
  /** Go live and wait until the phone's ingest connects: the session is `live`. Returns the session and the instant it went live. */
  const live = async (targetId?: string): Promise<{ sid: string; liveAt: number }> => {
    const sid = await goLive(targetId);
    now += 3 * SEC;
    expect((await view()).state, "premise: live").toBe("live");
    return { sid, liveAt: await startedAt(sid) };
  };
  const ytIdOf = async (sid: string): Promise<string> => {
    const [s] = await sql<{ youtube_broadcast_id: string }[]>`select youtube_broadcast_id from fixture_stream_sessions where id = ${sid}`;
    const [b] = await sql<{ yt_broadcast_id: string }[]>`select yt_broadcast_id from youtube_broadcasts where id = ${s!.youtube_broadcast_id}`;
    return b!.yt_broadcast_id;
  };
  const streamOf = async (sid: string): Promise<string> => fake.inspectBroadcast(await ytIdOf(sid))!.streamId!;
  const events = (sid: string) => sql<{ seq: number; source: string; kind: string; from_state: string | null; to_state: string | null; payload: Record<string, unknown> }[]>`
    select seq, source, kind, from_state, to_state, payload from fixture_stream_events where session_id = ${sid} and type = 'youtube_status' order by seq`;
  const stored = async (sid: string) => {
    const [r] = await sql<{ youtube_status: string | null }[]>`select youtube_status from fixture_stream_sessions where id = ${sid}`;
    return r!.youtube_status;
  };
  /** The calls the fake saw after `mark`, by name. */
  const mark = () => fake.calls.length;
  const since = (m: number) => fake.calls.slice(m).map((c) => c.method);
  const statusReadsSince = (m: number) => since(m).filter((c) => (STATUS_READS as readonly string[]).includes(c));
  return {
    auth, f, fake, deps, c, goLive, live, view, ytIdOf, streamOf, events, stored, mark, since, statusReadsSince,
    setNow: (ms: number) => { expect(ms, "the test clock only moves forward").toBeGreaterThanOrEqual(now); now = ms; },
    cron: () => tickOpenSessions(deps, { orgIds: [auth.orgId] }),
    stop: (sid: string) => stopSession(auth, f, sid, deps),
  };
}

describe("the constants", () => {
  it("the first read waits 60 s (the owner's number, pinned here: the constant is named so it is easy to change, and a change is a decision)", () => {
    expect(YOUTUBE_STATUS_FIRST_READ_AFTER_MS).toBe(FIRST_READ_MS);
  });

  it("the read window is shorter than a minute, so prod's every-minute stream tick always finds it open (and not shorter than a poll, so one open panel is not a read per poll)", () => {
    expect(YOUTUBE_STATUS_READ_EVERY_MS).toBeLessThan(60 * SEC);
    expect(YOUTUBE_STATUS_READ_EVERY_MS, "STREAM_POLL_MS is 5 s: a window at or under it is a read per poll").toBeGreaterThan(5 * SEC);
  });

  it("the back-off numbers are the ruling's, typed here: three reads in a row, then five minutes less the cron's 5 s early allowance; the warn mark is three minutes", () => {
    expect(YOUTUBE_STATUS_STEADY_AFTER_READS, "fix round 1, I3: three consecutive live_receiving reads").toBe(3);
    expect(YOUTUBE_STATUS_STEADY_EVERY_MS, "every five minutes, with the same 5 s early-firing allowance the fast window carries").toBe(5 * 60 * SEC - 5 * SEC);
    expect(YOUTUBE_STATUS_STEADY_EVERY_MS, "a firing a whole minute on finds the window open: 5 minutes of cron firings is the read").toBeLessThan(5 * 60 * SEC);
    expect(NOT_LIVE_WARN_MS, "fix round 1, I2: three minutes after live_at").toBe(3 * 60 * SEC);
  });
});

describe.skipIf(!HAS_DB)("the YouTube live status word: the real tick and the real poll, against the fake YouTube", () => {
  it("EMPTY CASE FIRST: nothing is read, recorded or shown before 60 s after the session went live; the first read is AT 60 s (both sides of the line, through the cron pass and the poll)", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    const m = r.mark();
    for (const at of [liveAt, liveAt + 1, liveAt + 30 * SEC, liveAt + FIRST_READ_MS - 1]) {
      r.setNow(at);
      const tick = await r.cron();
      const v = await r.view();
      expect(tick.failed, `cron at +${at - liveAt} ms`).toBe(0);
      expect(v.youtubeStatus, `the view at +${at - liveAt} ms shows no word yet`).toBeNull();
    }
    expect(r.statusReadsSince(m), "no read before the mark").toEqual([]);
    expect(await r.events(sid), "no event before the mark").toEqual([]);
    expect(await r.stored(sid)).toBeNull();

    r.setNow(liveAt + FIRST_READ_MS);
    expect((await r.cron()).failed).toBe(0);
    // The broadcast is bound with no video yet: not live. A broadcast that is not live needs no stream read (one quota unit saved).
    expect(r.statusReadsSince(m), "AT the mark: the broadcast is read; its stream is not (not live yet)").toEqual(["broadcastLife"]);
    expect((await r.view()).youtubeStatus).toBe("not_live");
    expect((await r.events(sid)).map((e) => [e.from_state, e.to_state])).toEqual([[null, "not_live"]]);
  });

  it("the first read through the ORGANISER'S POLL alone (no cron) is the same read: the poll IS a tick", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    r.setNow(liveAt + FIRST_READ_MS - 1);
    expect((await r.view()).youtubeStatus).toBeNull();
    r.setNow(liveAt + FIRST_READ_MS);
    expect((await r.view()).youtubeStatus, "the poll at the mark reads and answers the word in the same response").toBe("not_live");
    expect(await r.stored(sid)).toBe("not_live");
  });

  it("a SECOND tick inside the read window reads nothing (one read per window however many polls and ticks), and one past it reads again - a read that changes nothing records nothing", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    const first = liveAt + FIRST_READ_MS;
    r.setNow(first);
    await r.cron();
    const m = r.mark();
    // Polls and cron ticks, all inside the window: served the stored word, no YouTube call.
    r.setNow(first + 1 * SEC);
    await r.view();
    r.setNow(first + 10 * SEC);
    await r.view();
    await r.cron();
    r.setNow(first + YOUTUBE_STATUS_READ_EVERY_MS - 1);
    await r.view();
    await r.cron();
    expect(r.statusReadsSince(m), "inside the window: no read").toEqual([]);
    expect((await r.view()).youtubeStatus, "and the stored word is served").toBe("not_live");

    r.setNow(first + YOUTUBE_STATUS_READ_EVERY_MS);
    await r.cron();
    expect(r.statusReadsSince(m), "AT the window's end: one read").toEqual(["broadcastLife"]);
    expect((await r.events(sid)).length, "the word did not change: still the one event").toBe(1);
    r.setNow(first + YOUTUBE_STATUS_READ_EVERY_MS + 1 * SEC);
    await r.view();
    expect(r.statusReadsSince(m), "and the poll one second later is inside the NEW window").toEqual(["broadcastLife"]);
  });

  it("every CHANGE of word is exactly one event (source output, kind observed, from -> to), written with the stored word; a repeat of a word writes none - not_live, live_receiving, live_no_video, and back", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    const stream = await r.streamOf(sid);
    let at = liveAt + FIRST_READ_MS;
    const readNow = async () => { r.setNow(at); await r.cron(); at += YOUTUBE_STATUS_READ_EVERY_MS; return (await r.view()).youtubeStatus; };
    const steps: { what: string; before?: () => void; word: string; calls: string[] }[] = [
      { what: "bound, no video yet", word: "not_live", calls: ["broadcastLife"] },
      { what: "the same again", word: "not_live", calls: ["broadcastLife"] },
      { what: "video arrives: live and receiving", before: () => r.fake.videoOn(stream), word: "live_receiving", calls: ["broadcastLife", "streamStatus"] },
      { what: "the same again", word: "live_receiving", calls: ["broadcastLife", "streamStatus"] },
      { what: "video stops under a broadcast that stays live (enableAutoStop=false): the stall", before: () => r.fake.videoOff(stream), word: "live_no_video", calls: ["broadcastLife", "streamStatus"] },
      { what: "the same again", word: "live_no_video", calls: ["broadcastLife", "streamStatus"] },
      { what: "video is back", before: () => r.fake.videoOn(stream), word: "live_receiving", calls: ["broadcastLife", "streamStatus"] },
    ];
    let checked = 0;
    for (const s of steps) {
      s.before?.();
      const m = r.mark();
      expect(await readNow(), s.what).toBe(s.word);
      expect(r.statusReadsSince(m), `${s.what}: the calls`).toEqual(s.calls);
      expect(await r.stored(sid), `${s.what}: the stored word`).toBe(s.word);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(7);
    const ev = await r.events(sid);
    expect(ev.map((e) => [e.from_state, e.to_state]), "one event per CHANGE of word").toEqual([
      [null, "not_live"], ["not_live", "live_receiving"], ["live_receiving", "live_no_video"], ["live_no_video", "live_receiving"],
    ]);
    expect(ev.map((e) => e.seq), "events are ordered by the session's own seq").toEqual([...ev.map((e) => e.seq)].sort((a, b) => a - b));
    expect(new Set(ev.map((e) => e.source)), "recorded as the destination's observation").toEqual(new Set(["output"]));
    expect(new Set(ev.map((e) => e.kind))).toEqual(new Set(["observed"]));
    // What YouTube said is on the event, in words (never a token or a key): the broadcast's life, and the stream's status and health when it was read.
    expect(ev[0]!.payload).toEqual({ broadcastLife: "ready" });
    expect(ev[1]!.payload).toEqual({ broadcastLife: "live", streamStatus: "active", healthStatus: "good" });
    expect(ev[2]!.payload).toEqual({ broadcastLife: "live", streamStatus: "ready", healthStatus: "noData" });
  });

  it("an API ERROR is not a word: the previous word is carried, nothing is recorded, the tick does not fail - for each read, for the quota, an outage and a live-blocked channel; the NEXT window reads again (a DEAD GRANT is the next test: it clears)", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    const stream = await r.streamOf(sid);
    let at = liveAt + FIRST_READ_MS;
    const readNow = async () => { r.setNow(at); const t = await r.cron(); at += YOUTUBE_STATUS_READ_EVERY_MS; return t; };

    r.fake.videoOn(stream);
    await readNow();
    expect((await r.view()).youtubeStatus, "premise: receiving").toBe("live_receiving");

    // `insufficientLivePermissions` is Google's reason for "the channel may not go live" - a fact about the CHANNEL, not a dead grant
    // (port.ts isLiveBlockedRefusal): a reconnect refusal WITH that reason is carried like an outage; without it, it is a dead grant.
    const errors: [("broadcastLife" | "streamStatus" | "accessToken"), YoutubeErrorCode, string | undefined][] = [
      ["broadcastLife", "youtube_unavailable", undefined], ["broadcastLife", "youtube_limit_reached", undefined],
      ["broadcastLife", "youtube_reconnect_needed", "insufficientLivePermissions"],
      ["streamStatus", "youtube_unavailable", undefined], ["streamStatus", "youtube_limit_reached", undefined],
      ["streamStatus", "youtube_reconnect_needed", "insufficientLivePermissions"],
      ["accessToken", "youtube_unavailable", undefined],
    ];
    let checked = 0;
    for (const [method, code, reason] of errors) {
      // The truth moves to "no video"; YouTube cannot tell us: the word must stay where it was.
      r.fake.videoOff(stream);
      r.fake.failNext(method, code, reason);
      const eventsBefore = (await r.events(sid)).length;
      const m = r.mark();
      const t = await readNow();
      const what = `${method} refused ${code}${reason ? ` (${reason})` : ""}`;
      expect(r.since(m), `${what}: the call was made`).toContain(method);
      expect(t.failed, `${what}: the tick did not fail`).toBe(0);
      expect((await r.view()).youtubeStatus, `${what}: the previous word is carried, NOT live_no_video`).toBe("live_receiving");
      expect(await r.stored(sid), `${what}: stored word unchanged`).toBe("live_receiving");
      expect((await r.events(sid)).length, `${what}: nothing recorded`).toBe(eventsBefore);
      // A failed read still used its window: an outage is not hammered by every poll.
      const afterFail = r.mark();
      r.setNow(at - YOUTUBE_STATUS_READ_EVERY_MS + 1 * SEC);
      await r.view();
      expect(r.statusReadsSince(afterFail), `${what}: the next poll is inside the failed read's window`).toEqual([]);
      // The next window reads again, and now it is an answer: the stall is a word.
      const t2 = await readNow();
      expect(t2.failed).toBe(0);
      expect((await r.view()).youtubeStatus, `${what}: recovered, the stall is read`).toBe("live_no_video");
      expect((await r.events(sid)).length, `${what}: one event for the change`).toBe(eventsBefore + 1);
      r.fake.videoOn(stream);   // and back to receiving for the next case
      await readNow();
      expect((await r.view()).youtubeStatus).toBe("live_receiving");
      checked++;
    }
    expect(checked, "anti-vacuity: every error case ran").toBe(errors.length);
  });

  // A DEAD GRANT (fix round 1, m2): the club's connection is revoked, or Google refuses the grant. Nothing will ever refresh the word, so
  // the stale one is CLEARED - one event (word -> null), the panel shows no line - instead of left saying what was true before. The
  // read stays read-only on OUR side: the connection is not moved to reconnect_needed here (the end step and the daily check own that).
  it("a DEAD GRANT clears the stale word (one event, word -> null, no line) - whichever call Google refuses it on - and the connection is left as it was; once the grant works again the word comes back", async () => {
    const dead: [("accessToken" | "broadcastLife" | "streamStatus"), string | undefined][] = [
      ["accessToken", "invalidGrant"], ["broadcastLife", undefined], ["streamStatus", undefined],
    ];
    let checked = 0;
    for (const [method, reason] of dead) {
      const r = await rig();
      const { sid, liveAt } = await r.live();
      const stream = await r.streamOf(sid);
      r.fake.videoOn(stream);
      r.setNow(liveAt + FIRST_READ_MS);
      await r.cron();
      const what = `${method} refused reconnect_needed${reason ? ` (${reason})` : ""}`;
      expect((await r.view()).youtubeStatus, `${what}: premise - a word to go stale`).toBe("live_receiving");
      const [conn] = await sql<{ status: string }[]>`select status from org_youtube_connections where id = ${r.c.connectionId}`;
      expect(conn!.status, `${what}: premise`).toBe("connected");

      r.fake.failNext(method, "youtube_reconnect_needed", reason);
      r.setNow(liveAt + FIRST_READ_MS + YOUTUBE_STATUS_READ_EVERY_MS);
      expect((await r.cron()).failed, `${what}: the tick does not fail`).toBe(0);
      const v = await r.view();
      expect(v.youtubeStatus, `${what}: no word, NOT the last one`).toBeNull();
      expect(v.youtubeLiveForMs, `${what}: and no age to judge it by`).toBeNull();
      expect(youtubeStatusLineOf(v), `${what}: the panel shows no line`).toBeNull();
      expect(await r.stored(sid), `${what}: stored word cleared`).toBeNull();
      const ev = await r.events(sid);
      expect(ev.map((e) => [e.from_state, e.to_state]), `${what}: one event for the clearing`).toEqual([[null, "live_receiving"], ["live_receiving", null]]);
      expect(ev[1]!.payload, `${what}: says why, in words`).toEqual({ reason: "reconnect_needed" });
      const [after] = await sql<{ status: string }[]>`select status from org_youtube_connections where id = ${r.c.connectionId}`;
      expect(after!.status, `${what}: the connection is left as it was`).toBe("connected");

      // Still dead next window: nothing left to clear, so NOTHING more is recorded (the quiet read stays quiet).
      r.fake.failNext(method, "youtube_reconnect_needed", reason);
      r.setNow(liveAt + FIRST_READ_MS + 2 * YOUTUBE_STATUS_READ_EVERY_MS);
      await r.cron();
      expect((await r.events(sid)).length, `${what}: a second dead read records nothing`).toBe(2);
      expect((await r.view()).youtubeStatus).toBeNull();

      // The grant works again: the word comes back from null (not from the stale word), as one more event.
      r.setNow(liveAt + FIRST_READ_MS + 3 * YOUTUBE_STATUS_READ_EVERY_MS);
      await r.cron();
      expect((await r.view()).youtubeStatus, `${what}: back`).toBe("live_receiving");
      expect((await r.events(sid)).map((e) => [e.from_state, e.to_state]).at(-1), `${what}: from nothing`).toEqual([null, "live_receiving"]);
      checked++;
    }
    expect(checked, "anti-vacuity: each refusal point ran").toBe(dead.length);
  });

  it("a revoked connection (no token to read with) is a dead grant too: the word is cleared and no call is made - and a session with no word yet records nothing (the empty case)", async () => {
    // By hand: the real disconnect purges the broadcast rows first (so the claim finds nothing), which leaves this branch guarding the gap.
    const r = await rig();
    const { sid, liveAt } = await r.live();
    const stream = await r.streamOf(sid);
    r.fake.videoOn(stream);
    // empty case first: revoked BEFORE any word was ever read - nothing to clear, nothing to record
    await sql`update org_youtube_connections set status = 'revoked', refresh_token_enc = null, revoked_at = now() where id = ${r.c.connectionId}`;
    const m = r.mark();
    r.setNow(liveAt + FIRST_READ_MS);
    expect((await r.cron()).failed).toBe(0);
    expect(r.since(m), "no token, so no call to Google at all").toEqual([]);
    expect(await r.stored(sid)).toBeNull();
    expect(await r.events(sid), "no word was there to clear").toEqual([]);

    // and with a word: put one in place by hand (as if read while the grant was good), then the revoked read clears it
    await sql`update fixture_stream_sessions set youtube_status = 'live_receiving' where id = ${sid}`;
    expect((await r.view()).youtubeStatus, "premise: a word to go stale").toBe("live_receiving");
    r.setNow(liveAt + FIRST_READ_MS + YOUTUBE_STATUS_READ_EVERY_MS);
    await r.cron();
    expect((await r.view()).youtubeStatus).toBeNull();
    expect((await r.events(sid)).map((e) => [e.from_state, e.to_state])).toEqual([["live_receiving", null]]);
    expect(r.since(m), "still no call").toEqual([]);
  });

  it("an unreadable stored token (a KEK fault) is NOT a dead grant: it is carried like an outage - the grant may be fine, we just cannot open it", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    r.fake.videoOn(await r.streamOf(sid));
    r.setNow(liveAt + FIRST_READ_MS);
    await r.cron();
    expect((await r.view()).youtubeStatus, "premise").toBe("live_receiving");
    await sql`update org_youtube_connections set refresh_token_enc = decode('00112233', 'hex') where id = ${r.c.connectionId}`;
    r.setNow(liveAt + FIRST_READ_MS + YOUTUBE_STATUS_READ_EVERY_MS);
    expect((await r.cron()).failed).toBe(0);
    expect((await r.view()).youtubeStatus, "carried").toBe("live_receiving");
    expect((await r.events(sid)).length, "nothing recorded").toBe(1);
  });

  it("YouTube saying nothing is not a word either: a live broadcast whose stream is `active` with NO health carries the previous word and records nothing", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    const stream = await r.streamOf(sid);
    r.fake.videoOn(stream);
    r.setNow(liveAt + FIRST_READ_MS);
    await r.cron();
    expect((await r.view()).youtubeStatus, "premise").toBe("live_receiving");
    r.fake.setStreamStatus(stream, { status: "active", health: null });
    r.setNow(liveAt + FIRST_READ_MS + YOUTUBE_STATUS_READ_EVERY_MS);
    await r.cron();
    expect((await r.view()).youtubeStatus).toBe("live_receiving");
    expect((await r.events(sid)).length, "no second event").toBe(1);
    // The positive pair: the same stream saying `bad` IS a word.
    r.fake.setStreamStatus(stream, { status: "active", health: "bad" });
    r.setNow(liveAt + FIRST_READ_MS + 2 * YOUTUBE_STATUS_READ_EVERY_MS);
    await r.cron();
    expect((await r.view()).youtubeStatus).toBe("live_no_video");
  });

  // I1: a broadcast YouTube is still STARTING is not live. YouTube's `liveStarting` ("Transition into LIVE has been requested") used to be
  // collapsed to `live` by the adapter, so a healthy, active stream under it read live_receiving. Driven through the real tick and view.
  it("a broadcast still `liveStarting` is not_live even with an ACTIVE, GOOD stream beside it (no stream read, the raw value on the event); when YouTube finishes the transition the word moves", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    const yt = await r.ytIdOf(sid);
    r.fake.videoOn(await r.streamOf(sid));
    r.fake.setLifeCycle(yt, "liveStarting");
    const m = r.mark();
    r.setNow(liveAt + FIRST_READ_MS);
    expect((await r.cron()).failed).toBe(0);
    expect((await r.view()).youtubeStatus, "Transition into LIVE has been requested: not live yet").toBe("not_live");
    expect(r.statusReadsSince(m), "a broadcast that is not live needs no stream read").toEqual(["broadcastLife"]);
    const ev = await r.events(sid);
    expect(ev.map((e) => [e.from_state, e.to_state])).toEqual([[null, "not_live"]]);
    expect(ev[0]!.payload, "the capture says what YouTube said, raw").toEqual({ broadcastLife: "liveStarting" });

    r.fake.setLifeCycle(yt, null);   // YouTube is done starting: live, and the stream is active and good
    r.setNow(liveAt + FIRST_READ_MS + YOUTUBE_STATUS_READ_EVERY_MS);
    await r.cron();
    expect((await r.view()).youtubeStatus, "the positive pair: the same stream, now under `live`").toBe("live_receiving");
    expect((await r.events(sid)).map((e) => [e.from_state, e.to_state])).toEqual([[null, "not_live"], ["not_live", "live_receiving"]]);
  });

  // I2: not_live is "give it a moment" for a minute or two and "go and look" after that. The server measures the age (`youtubeLiveForMs`,
  // on its clock at the response); the panel's view-model turns it amber from NOT_LIVE_WARN_MS (typed above, 3 minutes after live_at).
  it("a not_live that PERSISTS turns amber at NOT_LIVE_WARN_MS after live_at - through the real view and the real view-model, both sides of the line - and one that flips to live goes emerald", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    const [row] = await sql<{ live_at: Date }[]>`select live_at from fixture_stream_sessions where id = ${sid}`;
    const liveAtMs = new Date(row!.live_at).getTime();
    expect(liveAtMs, "premise: live_at is the instant the session went live").toBe(liveAt);
    const stuck = "stream.youtube.status.not_live_stuck";
    const plain = "stream.youtube.status.not_live";

    // EMPTY first: before the first read there is no word and so no age and no line
    r.setNow(liveAtMs + 30 * SEC);
    const early = await r.view();
    expect([early.youtubeStatus, early.youtubeLiveForMs, youtubeStatusLineOf(early)], "no word, no age, no line").toEqual([null, null, null]);

    let checked = 0;
    for (const [dt, tone, key] of [
      [FIRST_READ_MS, "slate", plain],
      [2 * 60 * SEC, "slate", plain],
      [NOT_LIVE_WARN_MS - 1, "slate", plain],
      [NOT_LIVE_WARN_MS, "amber", stuck],
      [NOT_LIVE_WARN_MS + 1, "amber", stuck],
      [10 * 60 * SEC, "amber", stuck],
    ] as const) {
      r.setNow(liveAtMs + dt);
      const v = await r.view();   // the poll is a tick: it may read, and the broadcast stays `ready` (no video), so the word stays not_live
      expect(v.youtubeStatus, `+${dt} ms: the word does not change - only the line does`).toBe("not_live");
      expect(v.youtubeLiveForMs, `+${dt} ms: the server's own age, on the test clock`).toBe(dt);
      const line = youtubeStatusLineOf(v);
      expect([dt, line?.status, line?.tone, line?.key]).toEqual([dt, "not_live", tone, key]);
      checked++;
    }
    expect(checked, "anti-vacuity: every age checked").toBe(6);

    // It flips: video arrives, the broadcast goes live. The same age, a different word: emerald, never the "still not live" copy.
    r.fake.videoOn(await r.streamOf(sid));
    r.setNow(liveAtMs + 12 * 60 * SEC);
    const flipped = await r.view();
    expect(flipped.youtubeStatus, "the broadcast kept being read while it was not live, so it can flip").toBe("live_receiving");
    expect(flipped.youtubeLiveForMs).toBe(12 * 60 * SEC);
    expect(youtubeStatusLineOf(flipped)).toMatchObject({ status: "live_receiving", tone: "emerald", key: "stream.youtube.status.live_receiving" });
  });

  // I3: the quota is shared by every org (10,000 units a day). A stream that has said live_receiving three reads in a row is read every
  // five minutes; ANY other word brings the fast window back. Driven through the real tick; the run is read out of the row.
  it("BACK-OFF: after three live_receiving reads in a row the next read waits the steady window (not the fast one), and a CHANGE of word brings the fast window straight back", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    const stream = await r.streamOf(sid);
    r.fake.videoOn(stream);
    const run = async () => (await sql<{ s: number }[]>`select youtube_status_steady as s from fixture_stream_sessions where id = ${sid}`)[0]!.s;
    let reads = 0;
    /** Tick at `at` through the cron and the poll, and say whether YouTube was asked. */
    const asked = async (at: number): Promise<boolean> => {
      const m = r.mark();
      r.setNow(at);
      await r.cron();
      await r.view();
      const calls = r.statusReadsSince(m);
      if (calls.length > 0) reads++;
      return calls.length > 0;
    };

    let t = liveAt + FIRST_READ_MS;
    for (const want of [1, 2, 3]) {
      expect(await asked(t), `read ${want}: a fast-window read`).toBe(true);
      expect(await run(), `after read ${want} the run is ${want}`).toBe(want);
      t += YOUTUBE_STATUS_READ_EVERY_MS;
    }
    const third = t - YOUTUBE_STATUS_READ_EVERY_MS;
    expect((await r.view()).youtubeStatus).toBe("live_receiving");
    // The back-off: where the fast window WOULD read, nothing is read.
    expect(await asked(third + YOUTUBE_STATUS_READ_EVERY_MS), "a fast window after the third read: no read").toBe(false);
    expect(await asked(third + 2 * YOUTUBE_STATUS_READ_EVERY_MS), "two fast windows on: still no read").toBe(false);
    expect(await asked(third + YOUTUBE_STATUS_STEADY_EVERY_MS - 1), "one ms inside the steady window: no read").toBe(false);
    expect(await asked(third + YOUTUBE_STATUS_STEADY_EVERY_MS), "AT the steady window: one read").toBe(true);
    expect(await run(), "the run is capped at the threshold").toBe(YOUTUBE_STATUS_STEADY_AFTER_READS);
    expect(await asked(third + YOUTUBE_STATUS_STEADY_EVERY_MS + YOUTUBE_STATUS_READ_EVERY_MS), "and the steady window starts again from THAT read").toBe(false);

    // The stall: read at the next steady window. It is a change of word, so the run is zeroed and the fast window is back at once.
    r.fake.videoOff(stream);
    const slow = third + 2 * YOUTUBE_STATUS_STEADY_EVERY_MS;
    expect(await asked(slow - 1), "the stall is not seen before the steady window is up").toBe(false);
    expect(await asked(slow), "read at the steady window").toBe(true);
    expect((await r.view()).youtubeStatus).toBe("live_no_video");
    expect(await run(), "the word changed: the run is zero").toBe(0);
    expect(await asked(slow + YOUTUBE_STATUS_READ_EVERY_MS - 1), "inside the fast window: no read").toBe(false);
    expect(await asked(slow + YOUTUBE_STATUS_READ_EVERY_MS), "AT the fast window: read again - the fast window is back").toBe(true);
    expect(reads, "anti-vacuity: 3 fast reads, 2 steady-window reads, 1 fast read after the change").toBe(6);
    expect((await r.events(sid)).map((e) => [e.from_state, e.to_state])).toEqual([[null, "live_receiving"], ["live_receiving", "live_no_video"]]);
  });

  it("the run counts CONSECUTIVE live_receiving reads only: receiving, receiving, no video, receiving, receiving is still the fast window; the third in a row after that is not", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    const stream = await r.streamOf(sid);
    const run = async () => (await sql<{ s: number }[]>`select youtube_status_steady as s from fixture_stream_sessions where id = ${sid}`)[0]!.s;
    let t = liveAt + FIRST_READ_MS;
    const read = async (video: boolean): Promise<void> => {
      if (video) r.fake.videoOn(stream); else r.fake.videoOff(stream);
      r.setNow(t);
      await r.cron();
      t += YOUTUBE_STATUS_READ_EVERY_MS;
    };
    // the stream must be live for a "no video" word: start it receiving
    const seq: [boolean, number][] = [[true, 1], [true, 2], [false, 0], [true, 1], [true, 2], [true, 3]];
    let checked = 0;
    for (const [video, want] of seq) {
      const m = r.mark();
      await read(video);
      expect(r.statusReadsSince(m).length, `read ${checked + 1}: the fast window held, so it was read`).toBeGreaterThan(0);
      expect(await run(), `read ${checked + 1}`).toBe(want);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(6);
    const m = r.mark();
    r.setNow(t);   // one fast window after the sixth read (t already advanced by it)
    await r.cron();
    expect(r.statusReadsSince(m), "three in a row at last: the fast window no longer reads").toEqual([]);
  });

  it("a stream that is NOT receiving is never backed off - not_live and live_no_video are read every fast window, however long they hold; and an error read leaves the run where it was", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    const stream = await r.streamOf(sid);
    let t = liveAt + FIRST_READ_MS;
    let reads = 0;
    // 6 reads of a broadcast that is not live (bound, no video), then 6 of a live one that has no video
    for (let i = 0; i < 6; i++) {
      const m = r.mark();
      r.setNow(t);
      await r.cron();
      if (r.statusReadsSince(m).length > 0) reads++;
      t += YOUTUBE_STATUS_READ_EVERY_MS;
    }
    expect((await r.view()).youtubeStatus).toBe("not_live");
    r.fake.videoOn(stream);
    r.fake.videoOff(stream);   // went live, then the stall: live, nothing arriving
    for (let i = 0; i < 6; i++) {
      const m = r.mark();
      r.setNow(t);
      await r.cron();
      if (r.statusReadsSince(m).length > 0) reads++;
      t += YOUTUBE_STATUS_READ_EVERY_MS;
    }
    expect((await r.view()).youtubeStatus).toBe("live_no_video");
    expect(reads, "every one of the 12 windows read YouTube").toBe(12);
    expect((await sql<{ s: number }[]>`select youtube_status_steady as s from fixture_stream_sessions where id = ${sid}`)[0]!.s).toBe(0);

    // An error read keeps the run: reach steady, then fail one steady-window read - the run stays and the next window is the steady one.
    r.fake.videoOn(stream);
    for (let i = 0; i < YOUTUBE_STATUS_STEADY_AFTER_READS; i++) {
      r.setNow(t);
      await r.cron();
      t += YOUTUBE_STATUS_READ_EVERY_MS;
    }
    const run = async () => (await sql<{ s: number }[]>`select youtube_status_steady as s from fixture_stream_sessions where id = ${sid}`)[0]!.s;
    expect(await run(), "premise: steady").toBe(YOUTUBE_STATUS_STEADY_AFTER_READS);
    const lastRead = t - YOUTUBE_STATUS_READ_EVERY_MS;
    r.fake.failNext("broadcastLife", "youtube_unavailable");
    r.setNow(lastRead + YOUTUBE_STATUS_STEADY_EVERY_MS);
    await r.cron();
    expect(await run(), "the error read did not touch the run").toBe(YOUTUBE_STATUS_STEADY_AFTER_READS);
    const m = r.mark();
    r.setNow(lastRead + YOUTUBE_STATUS_STEADY_EVERY_MS + YOUTUBE_STATUS_READ_EVERY_MS);
    await r.cron();
    expect(r.statusReadsSince(m), "so the window after the failed read is still the steady one").toEqual([]);
  });

  it("the event and the stored word are ONE transaction: with the event refused, the word does not move (neither half alone), and the next window writes both", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    const fn = `ytstatus_refuse_${sid.replace(/-/g, "")}`;
    await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'refused by the test'; end $$`);
    await sql.unsafe(`create trigger ${fn} before insert on fixture_stream_events for each row when (new.session_id = '${sid}' and new.type = 'youtube_status') execute function ${fn}()`);
    try {
      r.setNow(liveAt + FIRST_READ_MS);
      const t = await r.cron();
      expect(t.failed, "a write that cannot land never fails the tick (the status line is a best-effort observation)").toBe(0);
      expect(await r.stored(sid), "the word did NOT move without its event").toBeNull();
      expect(await r.events(sid)).toEqual([]);
    } finally {
      await sql.unsafe(`drop trigger ${fn} on fixture_stream_events`);
      await sql.unsafe(`drop function ${fn}()`);
    }
    r.setNow(liveAt + FIRST_READ_MS + YOUTUBE_STATUS_READ_EVERY_MS);
    await r.cron();
    expect(await r.stored(sid)).toBe("not_live");
    expect((await r.events(sid)).map((e) => e.to_state)).toEqual(["not_live"]);
  });

  it("AFTER THE SESSION ENDS nothing is read: not by the cron pass (it selects open sessions), not by a poll of the ended session; the view shows no word and the events are as they were", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    const stream = await r.streamOf(sid);
    r.fake.videoOn(stream);
    r.setNow(liveAt + FIRST_READ_MS);
    await r.cron();
    expect((await r.view()).youtubeStatus, "premise: a word while live").toBe("live_receiving");
    await r.stop(sid);
    const ended = await r.view();
    expect(ended.state, "premise: stopped").toBe("completed");
    expect(ended.youtubeStatus, "no word once the session is over").toBeNull();
    expect(ended.youtubeLiveForMs, "and no age").toBeNull();

    const m = r.mark();
    const before = (await r.events(sid)).length;
    for (const dt of [1 * SEC, YOUTUBE_STATUS_READ_EVERY_MS, 10 * 60 * SEC]) {
      r.setNow(liveAt + FIRST_READ_MS + dt + 3 * SEC);
      r.fake.videoOff(stream);   // would be a word, if anything read it
      await r.cron();
      expect((await r.view()).youtubeStatus).toBeNull();
    }
    expect(r.statusReadsSince(m), "an ended session is never read (this pass is the session tick only; the end step is not run here)").toEqual([]);
    expect((await r.events(sid)).length).toBe(before);
  });

  it("a Stop that lands WHILE YouTube is being asked leaves no word and no event: the write is re-decided on the locked row, not on the live state the read began in", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    r.fake.videoOn(await r.streamOf(sid));
    const real = r.fake.broadcastLife.bind(r.fake);
    let stopped = 0;
    r.fake.broadcastLife = async (at: string, id: string) => {
      if (stopped++ === 0) await r.stop(sid);   // the organiser's Stop lands in the middle of the read
      return real(at, id);
    };
    r.setNow(liveAt + FIRST_READ_MS);
    expect((await r.cron()).failed).toBe(0);
    expect(stopped, "premise: the read reached YouTube, and the Stop landed inside it").toBe(1);
    expect((await r.view()).state, "premise: the session is no longer live").not.toBe("live");
    expect(await r.stored(sid), "no word written for a session that is over").toBeNull();
    expect(await r.events(sid)).toEqual([]);
  });

  it("a PASTED KEY has no YouTube API behind it: no call at all (live, 60 s on, cron and poll), no event, and the view says so; a non-YouTube pasted key says nothing", async () => {
    const r = await rig();
    // The sequence, not just the empty case: the org already HAS a YouTube broadcast (an earlier API-backed session on its channel,
    // ended), so a read that found "the org's broadcast" instead of the session's own would have something to read.
    const earlier = await r.live();
    await r.stop(earlier.sid);
    r.setNow(earlier.liveAt + 10 * 60 * SEC);
    expect(await r.ytIdOf(earlier.sid), "premise: the org has a broadcast on YouTube").toBeTruthy();
    const pasted = await createStreamTarget(r.auth, r.auth.orgId, { kind: "youtube", label: "Pasted", streamKey: `pasted-${randomUUID()}` });
    const { sid, liveAt } = await r.live(pasted.id);
    const m = r.mark();
    expect((await r.view()).youtubeStatus, "said at once, while live: there is nothing to wait 60 s for").toBe("pasted_key");
    expect((await r.view()).youtubeLiveForMs, "a pasted key has no word to age: no `still not live` can ever be said of it").toBeNull();
    for (const dt of [0, 30 * SEC, FIRST_READ_MS, FIRST_READ_MS + YOUTUBE_STATUS_READ_EVERY_MS, 10 * 60 * SEC]) {
      r.setNow(liveAt + dt);
      const t = await r.cron();
      expect(t.failed).toBe(0);
      expect((await r.view()).youtubeStatus, `+${dt} ms`).toBe("pasted_key");
    }
    expect(r.since(m), "not one port call").toEqual([]);
    expect(await r.events(sid)).toEqual([]);
    expect(await r.stored(sid)).toBeNull();
    await r.stop(sid);
    expect((await r.view()).youtubeStatus, "and nothing once it has ended").toBeNull();

    // The positive pair on the other side of the line: another platform's pasted key is not YouTube's to describe.
    const twitch = await createStreamTarget(r.auth, r.auth.orgId, { kind: "twitch", label: "Twitch", streamKey: `pasted-${randomUUID()}` });
    r.setNow(liveAt + 11 * 60 * SEC);
    const second = await r.live(twitch.id);
    r.setNow(second.liveAt + FIRST_READ_MS);
    expect((await r.view()).youtubeStatus, "a Twitch key").toBeNull();
  });

  it("a RESTART inside the grace reuses the broadcast but is a NEW session: its word starts empty (not the first session's), and its first read is 60 s after ITS own go-live", async () => {
    const r = await rig();
    const first = await r.live();
    const stream = await r.streamOf(first.sid);
    r.fake.videoOn(stream);
    r.setNow(first.liveAt + FIRST_READ_MS);
    await r.cron();
    expect((await r.view()).youtubeStatus, "premise: the first session reads receiving").toBe("live_receiving");
    await r.stop(first.sid);
    r.setNow(first.liveAt + FIRST_READ_MS + 2 * 60 * SEC);   // inside the 5-minute grace: the restart reuses the broadcast

    const second = await r.live();
    expect(second.sid, "premise: a new session").not.toBe(first.sid);
    expect(await r.ytIdOf(second.sid), "premise: the restart REUSED the broadcast").toBe(await r.ytIdOf(first.sid));
    const m = r.mark();
    r.setNow(second.liveAt + FIRST_READ_MS - 1);
    await r.cron();
    expect((await r.view()).youtubeStatus, "the new session has no word before its own 60 s - not the first session's").toBeNull();
    expect(r.statusReadsSince(m)).toEqual([]);
    r.setNow(second.liveAt + FIRST_READ_MS);
    await r.cron();
    expect((await r.view()).youtubeStatus, "and then its own read").toBe("live_receiving");
    expect((await r.events(first.sid)).map((e) => e.to_state), "the first session's events are its own").toEqual(["live_receiving"]);
    expect((await r.events(second.sid)).map((e) => [e.from_state, e.to_state])).toEqual([[null, "live_receiving"]]);
  });

  it("no broadcast behind the session (the channel was disconnected and its rows purged) reads nothing and does not fail", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    await sql`update fixture_stream_sessions set youtube_broadcast_id = null where id = ${sid}`;
    const m = r.mark();
    r.setNow(liveAt + FIRST_READ_MS);
    expect((await r.cron()).failed).toBe(0);
    expect(r.statusReadsSince(m)).toEqual([]);
    expect((await r.view()).youtubeStatus, "no broadcast and no pasted key either: nothing to say").toBeNull();
  });
});
