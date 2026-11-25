// Seazn-hosted video, Phase 4 Task 37: a court streams to Seazn. Real Postgres, fake relay on an injected clock; skipped without
// DATABASE_URL. Every start goes through its REAL producer: the link is minted by `linkCourtStream` on the org's Seazn row, the court
// phone's beats go through `postBeat` (→ `maybeCourtAutoStart` → `startBroadcast`), the Machine's playing beat through `heartbeat`,
// the end of a match through the court's own handover (`endOtherCourtSessions`) and the organiser's Stop.
//
// The rules under test are the brief's and the plan's, typed here, never read back from the code:
//   - a court's match on Seazn is a COMPOSED session with the link's Seazn target, its own camera and PROGRAMME inputs, the programme
//     input created SIGNED, no output (G1) and no `youtube_broadcasts` row;
//   - a handover A→B: B is created, THEN A ends `auto_stopped` (court_handover {to: B}); each session has its own two inputs, and each
//     fixture lists its own replay part (one session's programme recording each — no split);
//   - the org's switch goes off mid-court-day (T33): the session that is up continues, and the next match's auto start is refused
//     (`seazn_unavailable` → the court's stored `no_destination`), the live match running on; on again, the same match starts;
//   - a Seazn court session has no YouTube broadcast, so the court's deferred YouTube end answers `not_court_broadcast` and calls
//     YouTube not at all;
//   - T47: the hub's camera icon reads `destination_kind = 'seazn'` off the match's session, court-started or not: live while it is up;
//   - T45: Cloudflare's camera re-connect raises the phone-live edge of the match whose input it is, and of no other match.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the destination layer never reads a sport rule; the day rides `generic`.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tails = vi.hoisted(() => ({ queue: [] as (() => unknown)[] }));
vi.mock("@/lib/deferred", () => ({ deferred: (fn: () => unknown) => { tails.queue.push(fn); } }));
// The YouTube end tail is queued by a handover; only the SCHEDULING is replaced, so `runCourtBroadcastEnd` stays the real one.
vi.mock("../stream-sessions/court-end", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stream-sessions/court-end")>()),
  endCourtBroadcastSoon: () => undefined,
}));
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: (...args: unknown[]) => unknown) => fn, revalidateTag: vi.fn() }));
async function runTails(): Promise<number> {
  let n = 0;
  const errors: unknown[] = [];
  while (tails.queue.length > 0) {
    const fn = tails.queue.shift()!;
    n += 1;
    try { await fn(); } catch (err) { errors.push(err); }
  }
  if (errors.length > 0) throw new AggregateError(errors, `a deferred tail threw (${errors.length})`);
  return n;
}
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { CaptureBeat } from "@/server/api-v1/capture-schemas";
import { AUTO_START_RETRY_SECONDS, COURT_AUTO_STOP_AFTER_RESULT_SECONDS } from "@/server/relay/config";
import { FakeIngest, FakeRecorder, FakeRunner } from "@/server/relay/fakes";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
import { readHubStreamFlags } from "@/server/public-site/hub-stream-flags";
import { FakeReplayHost } from "@/server/video/replay-fake";
import { createPlaybackTokenCache } from "@/server/video/cf-playback";
import { replayRowsOf } from "@/server/video/__tests__/_seazn-replay-rig";
import { installSeaznEnv } from "@/server/video/__tests__/_seazn-session-rig";
import { FakeYouTube } from "@/server/youtube/fake";
import { postBeat } from "../capture-phone";
import { linkCourtStream, setCourtStream } from "../court-streams";
import { grantCredits } from "../stream-credits";
import { lockSeaznRecordings } from "../seazn-recordings";
import { discoverSeaznRecordings, moveSeaznRecordings, type SeaznReplayDeps } from "../seazn-replays";
import { currentSession, heartbeat, recordLiveNotification, stopSession, type SessionDeps } from "../stream-sessions";
import { runCourtBroadcastEnd } from "../stream-sessions/court-end";
import { override, phoneId } from "./_capture-rig";
import { at, place, seedDay, setStatus, type Day } from "./_match-day-seed";

const HAS_DB = !!process.env.DATABASE_URL;
installSeaznEnv("court-seazn");
const savedMin = process.env.COURT_MIN_APP_VERSION;
beforeAll(() => { process.env.COURT_MIN_APP_VERSION = "1.0.14-1200"; });
afterAll(async () => {
  if (savedMin === undefined) delete process.env.COURT_MIN_APP_VERSION; else process.env.COURT_MIN_APP_VERSION = savedMin;
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const DAY = "2026-11-07";
const COURT_BUILD = "1.0.14-1200";
const ROOMY_STORAGE_MINUTES = 100_000_000;
const SEC = 1000;
const MIN = 60_000;
const ACTIVE = ["requested", "provisioning", "warming", "live", "ending"];
const SIGNED_FOR_SEAZN_CLUB = { signed: true, allowedOrigins: ["seazn.club"] };

describe.skipIf(!HAS_DB)("a court streams to Seazn", () => {
  let day: Day;
  let A: string; let B: string;
  let seaznId: string;
  let linkId: string;
  let qr: { code: string; tok: string };
  let now: number;
  let deps: SessionDeps;
  let ingest: FakeIngest;
  let runner: FakeRunner;
  let P: string;
  let youtube: FakeYouTube;

  beforeEach(async () => {
    tails.queue.length = 0;
    day = await seedDay();
    [A, B] = day.comp.fixtures.map((f) => f.id) as [string, string];
    await override(day.orgId, "streaming.relay", true);
    await override(day.orgId, "streaming.overlay", true);
    await grantCredits({ orgId: day.orgId, delta: 8, createdBy: await rigUser(), note: "court seazn", idempotencyKey: randomUUID() });
    const [seazn] = await sql<{ id: string }[]>`select id from org_stream_targets where org_id = ${day.orgId} and kind = 'seazn'`;
    expect(seazn, "PREMISE: V541 gave the org its Seazn destination").toBeDefined();
    seaznId = seazn!.id;
    now = at(0).getTime();
    ingest = new FakeIngest({ clock: () => now, connectAfterMs: 0, recorder: new FakeRecorder() });
    ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
    runner = new FakeRunner();
    youtube = new FakeYouTube({ now: () => new Date(now) });
    deps = { drivers: { ingest, runner }, now: () => new Date(now), appUrl: "http://app.test", youtube };
    const shown = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: seaznId, day: DAY }, at(0));
    qr = { code: shown.qr!.code, tok: shown.qr!.tok };
    linkId = shown.id;
    await place(day, A, 0, day.courts.c2);
    await place(day, B, 30, day.courts.c2);
    P = phoneId("court");
    await beat(P, { claim: "new" });
  });

  const clock = () => new Date(now);
  const atMin = (m: number) => { now = at(m).getTime(); };
  const body = (phone: string, over: Partial<CaptureBeat> = {}): CaptureBeat => CaptureBeat.parse({
    code: qr.code, slot: 0, phone, claim: null, device: null, sid: null, at: clock().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "automatic", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: COURT_BUILD, ...over,
  });
  async function beat(phone: string, over: Partial<CaptureBeat> = {}) {
    const a = await postBeat(qr.code, qr.tok, body(phone, over), deps, clock());
    await runTails();
    return a;
  }
  const kickoff = async (fixtureId: string, minute: number) => {
    await sql`insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
              values (${fixtureId}, ${day.orgId}, 1, 'core.start', '{}', ${at(minute)})`;
    await setStatus(fixtureId, "in_play");
  };
  const decide = async (fixtureId: string, minute: number) => {
    await setStatus(fixtureId, "decided");
    await sql`update fixtures set finished_at = ${at(minute)} where id = ${fixtureId}`;
  };
  const streamOn = (fixtureId: string) => setCourtStream(day.auth, fixtureId, true, clock());
  const sessionRow = async (sid: string) => (await sql<{
    state: string; mode: string; end_reason: string | null; court_link_id: string | null; target_id: string; fixture_id: string;
    destination_kind: string | null; api_backed: boolean; youtube_broadcast_id: string | null; output_uid: string | null; start_cause: string;
  }[]>`select state, mode, end_reason, court_link_id, target_id, fixture_id, destination_kind, api_backed, youtube_broadcast_id, output_uid, start_cause
         from fixture_stream_sessions where id = ${sid}`)[0]!;
  const sessionsOf = async (fixtureId: string) =>
    sql<{ id: string; state: string }[]>`select id, state from fixture_stream_sessions where fixture_id = ${fixtureId} order by created_at, id`;
  const activeOfLink = async () =>
    (await sql<{ id: string }[]>`select id from fixture_stream_sessions where court_link_id = ${linkId} and state in ${sql(ACTIVE)}`).map((r) => r.id);
  const inputsOf = (sid: string) => sql<{ role: string; ingest_input_id: string; access: unknown }[]>`
    select role, ingest_input_id, access from fixture_stream_inputs where session_id = ${sid} order by role`;
  const settingsOf = async (fixtureId: string) => (await sql<{ auto_start_refusal: string | null }[]>`
    select auto_start_refusal from fixture_stream_settings where fixture_id = ${fixtureId}`)[0];
  const broadcasts = async () => (await sql<{ n: number }[]>`select count(*)::int as n from youtube_broadcasts where org_id = ${day.orgId}`)[0]!.n;
  const netSpend = async (sid: string) =>
    (await sql<{ net: number }[]>`select coalesce(sum(delta), 0)::int as net from org_stream_credits where session_id = ${sid} and reason in ('consume','refund')`)[0]!.net;
  /** The Machine's beat that takes a composed session live (its job token is the one the fake runner was given). */
  async function machinePlays(sid: string) {
    const spec = runner.created.find((c) => c.sessionId === sid);
    expect(spec, `PREMISE: a Machine was created for ${sid}`).toBeDefined();
    await heartbeat(sid, spec!.jobToken, { state: "playing" }, deps);
    expect((await sessionRow(sid)).state, "PREMISE: the session is live").toBe("live");
  }
  /** A streamed match kicked off at `minute`, started by the court phone's beat, its Machine playing: live on Seazn. */
  const startedLive = async (fixtureId: string, minute: number, over: Partial<CaptureBeat> = {}): Promise<string> => {
    await streamOn(fixtureId);
    await kickoff(fixtureId, minute);
    await beat(P, over);
    const sid = (await sessionsOf(fixtureId)).at(-1)?.id;
    if (sid === undefined) throw new Error("PREMISE: the court's beat started a session for the match");
    await machinePlays(sid);
    return sid;
  };
  const settle = async (fixtureId: string, sid: string) => {
    for (let i = 0; i < 3 && (await sessionRow(sid)).state !== "completed"; i++) await currentSession(day.auth, fixtureId, deps);
    expect((await sessionRow(sid)).state, "PREMISE: the session completed").toBe("completed");
  };

  it("a streamed match on a Seazn link starts COMPOSED on the link's Seazn row: its own camera and programme inputs (programme created signed), no output, no broadcast row, court_link_id set; one credit when it is live", async () => {
    const broadcastsBefore = await broadcasts();
    const sid = await startedLive(A, 0);
    expect(await sessionRow(sid)).toMatchObject({
      fixture_id: A, court_link_id: linkId, target_id: seaznId, start_cause: "automatic", mode: "composed", destination_kind: "seazn",
      api_backed: false, youtube_broadcast_id: null, output_uid: null,
    });
    const inputs = await inputsOf(sid);
    expect(inputs.map((i) => i.role), "a composed session has a camera and a programme input").toEqual(["camera", "programme"]);
    expect(inputs.map((i) => i.access), "the programme input was CREATED signed for the deployment's hosts; the camera stays unsigned").toEqual([null, SIGNED_FOR_SEAZN_CLUB]);
    const programme = inputs.find((i) => i.role === "programme")!.ingest_input_id;
    expect(ingest.outputsFor(programme), "G1: no output on the programme input").toEqual([]);
    expect(ingest.outputsFor(inputs.find((i) => i.role === "camera")!.ingest_input_id), "nor on the camera").toEqual([]);
    expect(await broadcasts(), "no youtube_broadcasts row").toBe(broadcastsBefore);
    expect(youtube.calls, "YouTube is never asked").toEqual([]);
    expect(await netSpend(sid), "one credit consumed at live").toBe(-1);
    expect(await activeOfLink()).toEqual([sid]);
  });

  it("handover A→B: B is created THEN A ends auto_stopped with court_handover {to: B}; each has its own two inputs; each fixture lists its OWN replay part; both are Seazn sessions", async () => {
    const sidA = await startedLive(A, 0);
    await streamOn(B);
    await decide(A, 10);
    atMin(11);
    await kickoff(B, 11);
    await beat(P, { sid: sidA, state: "publishing" });
    const sidB = (await sessionsOf(B)).at(-1)?.id;
    if (sidB === undefined) throw new Error("PREMISE: B started");
    expect(sidB).not.toBe(sidA);
    expect(await sessionRow(sidB)).toMatchObject({ fixture_id: B, court_link_id: linkId, destination_kind: "seazn", mode: "composed", target_id: seaznId });
    const a = await sessionRow(sidA);
    expect(a.end_reason).toBe("auto_stopped");
    expect(["ending", "completed"]).toContain(a.state);
    expect((await sql<{ payload: { to: string } }[]>`select payload from fixture_stream_events where session_id = ${sidA} and type = 'court_handover'`).map((e) => e.payload))
      .toEqual([{ to: sidB }]);
    // A composed session is `ending` until its Machine is gone (the YouTube twin of this test is passthrough and completes at once).
    expect((await activeOfLink()).sort(), "the court's active sessions are B and, until its Machine is gone, A").toEqual([sidA, sidB].sort());
    expect(["warming", "live", "provisioning", "requested"], "B is the court's session now").toContain((await sessionRow(sidB)).state);
    // Two Seazn sessions of one org overlapped during the handover (Review Focus 1): the credit follows each match's first video.
    // Each session has ITS OWN inputs: four distinct ingest ids in all.
    const ia = await inputsOf(sidA);
    const ib = await inputsOf(sidB);
    expect([ia.length, ib.length]).toEqual([2, 2]);
    const ids = [...ia, ...ib].map((i) => i.ingest_input_id);
    expect(new Set(ids).size, "no input is shared between the two matches").toBe(4);
    expect(ib.map((i) => i.access), "B's programme input is signed as well").toEqual([null, SIGNED_FOR_SEAZN_CLUB]);

    // Replays: B goes live, both end, each programme input has one recording; each fixture lists its own part (one session, no split).
    await machinePlays(sidB);
    await stopSession(day.auth, B, sidB, deps);
    await settle(A, sidA);
    await settle(B, sidB);
    const progA = ia.find((i) => i.role === "programme")!.ingest_input_id;
    const progB = ib.find((i) => i.role === "programme")!.ingest_input_id;
    const base = now;
    ingest.addVideo({ videoId: `va-${randomUUID()}`, inputId: progA, createdAt: new Date(base).toISOString(), inProgress: false, durationSeconds: 600, height: 1080 });
    ingest.addVideo({ videoId: `vb-${randomUUID()}`, inputId: progB, createdAt: new Date(base + MIN).toISOString(), inProgress: false, durationSeconds: 600, height: 1080 });
    const host = new FakeReplayHost();
    const replayDeps: SeaznReplayDeps = { ingest, replay: host, tokenCache: createPlaybackTokenCache() };
    const opts = (t: number) => ({ now: new Date(t), budgetMs: 8_000, orgIds: [day.orgId] });
    const endedAt = Math.max(...(await sql<{ e: Date }[]>`select ended_at as e from fixture_stream_sessions where id in ${sql([sidA, sidB])}`).map((r) => new Date(r.e).getTime()));
    expect(await lockSeaznRecordings(deps, opts(endedAt + MIN)), "PREMISE: both recordings locked").toMatchObject({ locked: 2 });
    await sql`update fixtures set finished_at = ${new Date(endedAt)} where id = ${B}`;
    const t0 = endedAt + 15 * MIN;
    expect(await discoverSeaznRecordings(replayDeps, opts(t0)), "PREMISE: both discovered").toMatchObject({ discovered: 2 });
    await moveSeaznRecordings(replayDeps, opts(t0));
    const rowsA = await replayRowsOf(A);
    const rowsB = await replayRowsOf(B);
    expect([rowsA.length, rowsB.length], "one part each — no split, no sharing").toEqual([1, 1]);
    expect([rowsA[0]!.part_no, rowsB[0]!.part_no]).toEqual([1, 1]);
    expect(rowsA[0]!.cf_video_id, "each part is its own session's programme recording").not.toBe(rowsB[0]!.cf_video_id);
    const lockedOf = async (cf: string) => (await sql<{ ingest_input_id: string }[]>`
      select i.ingest_input_id from seazn_locked_videos v join fixture_stream_inputs i on i.id = v.input_row_id where v.cf_video_id = ${cf}`)[0]!.ingest_input_id;
    expect(await lockedOf(rowsA[0]!.cf_video_id), "A's part came off A's programme input").toBe(progA);
    expect(await lockedOf(rowsB[0]!.cf_video_id), "B's part came off B's programme input").toBe(progB);
  });

  it("T45: a court match's camera coming back nudges THAT match's relay only — A's re-connect raises A's counter; after the handover A's (ending) re-connect moves nothing, B's first connect is no edge, and B's own return raises B's alone", async () => {
    const cameraOf = async (sid: string) => (await inputsOf(sid)).find((i) => i.role === "camera")!.ingest_input_id;
    const edgeOf = async (sid: string) =>
      (await sql<{ e: number | null }[]>`select phone_live_edge as e from fixture_stream_sessions where id = ${sid}`)[0]!.e;
    /** What the match's relay reads: its Machine's heartbeat reply. */
    const relayReads = async (sid: string) => {
      const reply = await heartbeat(sid, runner.created.find((c) => c.sessionId === sid)!.jobToken, { state: "playing" }, deps);
      return (reply as { phoneLiveEdge?: number | null }).phoneLiveEdge;
    };
    const cf = (uid: string, event: "connected" | "disconnected", sec: number) => recordLiveNotification(
      { inputUid: uid, event: `live_input.${event}`, word: event, reason: null, at: new Date(at(0).getTime() + sec * SEC) }, clock());

    const sidA = await startedLive(A, 0);
    const camA = await cameraOf(sidA);
    await beat(P, { sid: sidA, state: "publishing" });
    expect(await relayReads(sidA), "PREMISE: the court phone's first live sets A's counter at 0").toBe(0);
    expect(await cf(camA, "connected", 1), "A's first connect").not.toHaveProperty("edge");
    await cf(camA, "disconnected", 30);
    expect(await cf(camA, "connected", 40), "A's return").toMatchObject({ outcome: "recorded", sessionId: sidA, edge: 1 });
    expect(await relayReads(sidA)).toBe(1);

    // The handover (the test above's sequence): B is created, A ends.
    await streamOn(B);
    await decide(A, 10);
    atMin(11);
    await kickoff(B, 11);
    await beat(P, { sid: sidA, state: "publishing" });
    const sidB = (await sessionsOf(B)).at(-1)?.id;
    if (sidB === undefined || sidB === sidA) throw new Error("PREMISE: B started");
    expect(["ending", "completed"], "PREMISE: A is over or going").toContain((await sessionRow(sidA)).state);
    const camB = await cameraOf(sidB);
    expect(camB, "PREMISE: B has its own camera input").not.toBe(camA);
    // The handover beat came after 11 silent minutes, so the PHONE's own silence rule may have raised A's counter on it (while A
    // was still up): A's value is read here, after the handover, and must not move from it.
    const aAtHandover = await edgeOf(sidA);
    expect(aAtHandover, "PREMISE: A's counter exists, at least the 1 of its return").toBeGreaterThanOrEqual(1);

    await cf(camA, "disconnected", 11 * 60);
    const late = await cf(camA, "connected", 11 * 60 + 5);
    expect(late, "A's re-connect after the handover: recorded").toMatchObject({ outcome: "recorded", sessionId: sidA });
    expect(late, "… and no edge").not.toHaveProperty("edge");
    expect(await edgeOf(sidA), "A's counter stands").toBe(aAtHandover);
    expect(await cf(camB, "connected", 11 * 60 + 6), "B's first connect").not.toHaveProperty("edge");
    await machinePlays(sidB);
    await beat(P, { sid: sidB, state: "publishing" });
    expect(await relayReads(sidB), "PREMISE: B's own counter starts at 0 (per session)").toBe(0);
    await cf(camB, "disconnected", 12 * 60);
    expect(await cf(camB, "connected", 12 * 60 + 9), "B's return").toMatchObject({ outcome: "recorded", sessionId: sidB, edge: 1 });
    expect(await relayReads(sidB)).toBe(1);
    expect(await edgeOf(sidA), "A untouched by B's return").toBe(aAtHandover);
  });

  it("the org's Seazn switch (or the deployment's flag) goes off mid-court-day: the session that is up continues, the next match's auto start is refused (stored as the court's no_destination), the live match runs on; back on, the same match starts", async () => {
    const sidA = await startedLive(A, 0);
    await streamOn(B);
    await decide(A, 10);
    atMin(11);
    await kickoff(B, 11);
    let checked = 0;
    for (const cause of ["org switch", "deployment flag"] as const) {
      if (cause === "org switch") await sql`update org_stream_targets set offered = false where id = ${seaznId}`;
      else vi.stubEnv("SEAZN_HOSTED_LIVE", "false");
      now += (AUTO_START_RETRY_SECONDS + 1) * SEC;
      await beat(P, { sid: sidA, state: "publishing" });
      expect(await sessionsOf(B), `${cause}: B is not started`).toEqual([]);
      expect((await settingsOf(B))?.auto_start_refusal, `${cause}: refused, stored on the court's match`).toBe("no_destination");
      expect((await sessionRow(sidA)).state, `${cause}: A runs on`).toBe("live");
      expect(await activeOfLink(), `${cause}: A is still the court's active session`).toEqual([sidA]);
      checked++;
    }
    expect(checked).toBe(2);
    // The positive pair: both open again and the next beat after the retry spacing starts B on Seazn.
    await sql`update org_stream_targets set offered = true where id = ${seaznId}`;
    vi.stubEnv("SEAZN_HOSTED_LIVE", "true");
    now += (AUTO_START_RETRY_SECONDS + 1) * SEC;
    await beat(P, { sid: sidA, state: "publishing" });
    const sidB = (await sessionsOf(B)).at(-1)?.id;
    expect(sidB, "back on: B starts").toBeDefined();
    expect(await sessionRow(sidB!)).toMatchObject({ destination_kind: "seazn", court_link_id: linkId });
  });

  it("a Seazn court session has no YouTube broadcast: the court's deferred YouTube end answers not_court_broadcast, calls YouTube not at all, and ends nothing", async () => {
    const sid = await startedLive(A, 0);
    const info = vi.spyOn(log, "info");
    try {
      const ran = await runCourtBroadcastEnd(sid, deps, { sleep: async () => undefined, wallClock: () => now });
      expect(ran, "the end step was not run").toBe(false);
      const missed = info.mock.calls.filter(([o]) => typeof o === "object" && o !== null && (o as { reason?: string }).reason === "not_court_broadcast");
      expect(missed, "the miss is named, with the session").toHaveLength(1);
      expect((missed[0]![0] as { sid: string; bid: string | null }).sid).toBe(sid);
      expect((missed[0]![0] as { bid: string | null }).bid).toBeNull();
    } finally {
      info.mockRestore();
    }
    expect(youtube.calls, "YouTube is never called").toEqual([]);
    expect((await sessionRow(sid)).state, "the session is untouched").toBe("live");
  });

  it("the court's tail: a live Seazn court session auto-stops COURT_AUTO_STOP_AFTER_RESULT_SECONDS after its result (not the per-fixture 180 s, not the Seazn arm's 15 min) - not a second earlier", async () => {
    const tail = COURT_AUTO_STOP_AFTER_RESULT_SECONDS * SEC;
    expect(tail, "PREMISE: the court's tail is shorter than both the per-fixture code's and the Seazn arm's").toBeLessThan(3 * MIN);
    const sid = await startedLive(A, 0);
    // The session's created_at is the database's real clock, so it is stamped back inside the injected timeline: the result lands
    // after it (A15: only a session that predates the result is stopped by the tail), and the Machine keeps beating as it would.
    await sql`update fixture_stream_sessions set created_at = ${at(-1)} where id = ${sid}`;
    await decide(A, 2);
    const finishedAt = at(2).getTime();
    const jobToken = runner.created.find((c) => c.sessionId === sid)!.jobToken;
    const tick = async () => {
      await heartbeat(sid, jobToken, { state: "playing" }, deps);
      await currentSession(day.auth, A, deps);
    };
    now = finishedAt + tail - SEC;
    await tick();
    expect(await sessionRow(sid), "a second before the tail: untouched").toMatchObject({ state: "live", end_reason: null });
    now = finishedAt + tail + SEC;
    for (let i = 0; i < 3 && (await sessionRow(sid)).state === "live"; i++) await tick();
    expect(await sessionRow(sid), "a second after: ended by the tick, as the court's own auto stop").toMatchObject({ end_reason: "auto_stopped", destination_kind: "seazn", court_link_id: linkId });
    expect(["ending", "completed"]).toContain((await sessionRow(sid)).state);
    expect(youtube.calls, "no YouTube end for a Seazn session").toEqual([]);
  });

  it("T47: the hub's camera icon shows for a court Seazn live — no change to the read: absent before the session, 'live' while it is up (destination_kind seazn off the court-started session)", async () => {
    await streamOn(A);
    await kickoff(A, 0);
    // The hub reads only what the public page shows: a division past setup (the seed's is still in setup).
    await sql`update divisions set status = 'active' where id = ${day.comp.divisionId}`;
    const flag = async () => (await readHubStreamFlags([{ id: A, status: "in_play" }], clock())).get(A);
    expect(await flag(), "PREMISE: a match in play with no stream has no camera").toBeUndefined();
    await beat(P);
    const sid = (await sessionsOf(A)).at(-1)!.id;
    expect(await sessionRow(sid), "PREMISE: a court-started Seazn session").toMatchObject({ court_link_id: linkId, destination_kind: "seazn" });
    await machinePlays(sid);
    expect(await flag(), "live: the camera icon").toBe("live");
  });
});
