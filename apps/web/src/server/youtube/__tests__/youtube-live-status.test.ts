// The YouTube live status line (owner direction 2026-11-14, stream-output-health-warning design): after Go live on a YouTube Connect
// destination, the stream-tick pass AND the organiser's poll read YouTube (the broadcast's life, and - when it is live - its stream's
// status and health) and the session view carries ONE word:  live_receiving | not_live | live_no_video.
//   * the first read is 60 s after the session went live, never before;
//   * every change of word is ONE session event, written in the same transaction as the stored word; a read that changes nothing
//     writes nothing;
//   * an API error (or an answer that says nothing) is NOT a word: the previous one is carried and nothing is recorded;
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
import { YOUTUBE_STATUS_FIRST_READ_AFTER_MS, YOUTUBE_STATUS_READ_EVERY_MS } from "@/server/usecases/stream-sessions/youtube-status";
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

  it("an API ERROR is not a word: the previous word is carried, nothing is recorded, the tick does not fail - for each read, for a dead grant, the quota and an outage; the NEXT window reads again", async () => {
    const r = await rig();
    const { sid, liveAt } = await r.live();
    const stream = await r.streamOf(sid);
    let at = liveAt + FIRST_READ_MS;
    const readNow = async () => { r.setNow(at); const t = await r.cron(); at += YOUTUBE_STATUS_READ_EVERY_MS; return t; };

    r.fake.videoOn(stream);
    await readNow();
    expect((await r.view()).youtubeStatus, "premise: receiving").toBe("live_receiving");

    const errors: [("broadcastLife" | "streamStatus" | "accessToken"), YoutubeErrorCode][] = [
      ["broadcastLife", "youtube_unavailable"], ["broadcastLife", "youtube_limit_reached"], ["broadcastLife", "youtube_reconnect_needed"],
      ["streamStatus", "youtube_unavailable"], ["streamStatus", "youtube_limit_reached"], ["streamStatus", "youtube_reconnect_needed"],
      ["accessToken", "youtube_unavailable"],
    ];
    let checked = 0;
    for (const [method, code] of errors) {
      // The truth moves to "no video"; YouTube cannot tell us: the word must stay where it was.
      r.fake.videoOff(stream);
      r.fake.failNext(method, code);
      const eventsBefore = (await r.events(sid)).length;
      const m = r.mark();
      const t = await readNow();
      const what = `${method} refused ${code}`;
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

  it("a status read is READ-ONLY on our side too: a dead grant is carried, and it does NOT move the connection to reconnect_needed (the end step owns that)", async () => {
    const r = await rig();
    const { liveAt } = await r.live();
    r.setNow(liveAt + FIRST_READ_MS);
    await r.cron();
    expect((await r.view()).youtubeStatus, "premise: read once").toBe("not_live");
    const [conn] = await sql<{ status: string }[]>`select status from org_youtube_connections where id = ${r.c.connectionId}`;
    expect(conn!.status, "premise").toBe("connected");

    r.fake.failNext("accessToken", "youtube_reconnect_needed", "invalidGrant");
    r.setNow(liveAt + FIRST_READ_MS + YOUTUBE_STATUS_READ_EVERY_MS);
    await r.cron();
    expect((await r.view()).youtubeStatus, "carried").toBe("not_live");
    const [after] = await sql<{ status: string }[]>`select status from org_youtube_connections where id = ${r.c.connectionId}`;
    expect(after!.status, "the connection is left as it was").toBe("connected");
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
