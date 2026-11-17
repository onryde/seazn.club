// B1 (web batch B, owner 2026-11-17: "match decided -> 30 s stops in app -> another 30 s stop in youtube"): a court session's YouTube
// broadcast is completed when the end rule says it is due (S + 30 s for a finished match), by the session's own deferred tail, not at the
// next cron firing; the cron's end step stays the safety net and the two never complete twice. Real Postgres (skipped without
// DATABASE_URL), the court phone's real beats, the real auto-stop through the tick, the organiser's real Stop, and FakeYouTube's call log.
// Expected values are typed from the brief, never imported from the rule: 30 s after Stop (finished), 5 minutes (unfinished).
// `@/lib/deferred` is a queue (as in court-stream-money.test.ts) so a test drives the tail itself with its own sleep and clock.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tails = vi.hoisted(() => ({ queue: [] as (() => unknown)[] }));
vi.mock("@/lib/deferred", () => ({ deferred: (fn: () => unknown) => { tails.queue.push(fn); } }));
async function runTails(): Promise<void> {
  while (tails.queue.length > 0) {
    const fn = tails.queue.shift()!;
    try { await fn(); } catch { /* deferred's contract: a tail's error never reaches the caller */ }
  }
}
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { CaptureBeat, CaptureBeatAnswer } from "@/server/api-v1/capture-schemas";
import { COURT_AUTO_STOP_AFTER_RESULT_SECONDS } from "@/server/relay/config";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
import { connect } from "@/server/youtube/__tests__/_connect-rig";
import { FakeYouTube } from "@/server/youtube/fake";
import { postBeat } from "../capture-phone";
import { linkCourtStream, setCourtStream } from "../court-streams";
import { grantCredits } from "../stream-credits";
import { stopSession, tickSession, type SessionDeps } from "../stream-sessions";
import { runCourtBroadcastEnd } from "../stream-sessions/court-end";
import { endDueBroadcasts } from "@/server/youtube/end-step";
import { override, phoneId } from "./_capture-rig";
import { at, place, seedDay, setStatus, type Day } from "./_match-day-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const ENV = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "COURT_MIN_APP_VERSION", "STREAM_PLAYBACK_HOST", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  delete process.env.STREAM_PLAYBACK_HOST;
  delete process.env.OAUTH_BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  process.env.COURT_MIN_APP_VERSION = "1.0.14-1200";
});
afterAll(async () => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
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
const DELAY_MS = COURT_AUTO_STOP_AFTER_RESULT_SECONDS * SEC;

type Beat = CaptureBeat;
type Answer = CaptureBeatAnswer;

describe.skipIf(!HAS_DB)("court stream: the YouTube broadcast ends 30 s after a finished court match stops (B1)", () => {
  let day: Day;
  let A: string; let B: string; let C: string;
  let targetId: string;
  let qr: { code: string; tok: string };
  let now: number;
  let deps: SessionDeps;
  let P: string;

  beforeEach(async () => {
    tails.queue.length = 0;
    day = await seedDay();
    [A, B, C] = day.comp.fixtures.map((f) => f.id) as [string, string, string];
    await override(day.orgId, "streaming.relay", true);
    await override(day.orgId, "streaming.overlay", true);
    await grantCredits({ orgId: day.orgId, delta: 5, createdBy: await rigUser(), note: "court money", idempotencyKey: randomUUID() });
    const c = await connect({ auth: day.auth, orgId: day.orgId, userId: day.auth.userId! });
    targetId = c.targetId;
    now = at(0).getTime();
    const ingest = new FakeIngest({ clock: () => now, connectAfterMs: 0 });
    ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
    deps = {
      drivers: { ingest, runner: new FakeRunner() }, now: () => new Date(now), appUrl: "http://app.test",
      youtube: new FakeYouTube({ now: () => new Date(now) }),
    };
    (deps.youtube as FakeYouTube).setAutoVideo(true);   // video on the stream takes a ready broadcast live, as YouTube's auto-start does
    const shown = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId, day: DAY }, at(0));
    qr = { code: shown.qr!.code, tok: shown.qr!.tok };
    // Three matches on Court 2, 10:00Z, 10:30Z and 11:00Z, none switched on yet.
    await place(day, A, 0, day.courts.c2);
    await place(day, B, 30, day.courts.c2);
    await place(day, C, 60, day.courts.c2);
    // The court phone P, claimed in Automatic before anything kicks off.
    P = phoneId("court");
    await beat(P, { claim: "new" });
  });

  const clock = () => new Date(now);
  const atMin = (m: number) => { now = at(m).getTime(); };
  const body = (phone: string, over: Partial<Beat> = {}): Beat => CaptureBeat.parse({
    code: qr.code, slot: 0, phone, claim: null, device: null, sid: null, at: clock().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "automatic", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: COURT_BUILD, ...over,
  });
  async function beat(phone: string, over: Partial<Beat> = {}): Promise<Answer> {
    const a = await postBeat(qr.code, qr.tok, body(phone, over), deps, clock());
    expect(CaptureBeatAnswer.parse(a)).toEqual(a);
    await runTails();
    return a;
  }
  /** Kicked off for real: a `core.start` score event at `minute` and status in_play. */
  const kickoff = async (fixtureId: string, minute: number) => {
    await sql`insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
              values (${fixtureId}, ${day.orgId}, 1, 'core.start', '{}', ${at(minute)})`;
    await setStatus(fixtureId, "in_play");
  };
  /** The result saved at `minute`: the status trigger stamps the wall clock, the stamp is then set to the test's. */
  const decide = async (fixtureId: string, minute: number) => {
    await setStatus(fixtureId, "decided");
    await sql`update fixtures set finished_at = ${at(minute)} where id = ${fixtureId}`;
  };
  /** `created_at` is the DATABASE's wall clock (today), the result the test's (the seed's day): a session is put back on the
   *  test's day so it predates its match's result, as it would on the real day. */
  const createdOnTestDay = (sid: string, minute: number) =>
    sql`update fixture_stream_sessions set created_at = ${at(minute)} where id = ${sid}`;
  const streamOn = (fixtureId: string) => setCourtStream(day.auth, fixtureId, true, clock());
  const sessionRow = async (sid: string) => (await sql<{
    state: string; end_reason: string | null; court_link_id: string | null; target_id: string; start_cause: string; fixture_id: string;
    pairing_id: string | null;
  }[]>`select state, end_reason, court_link_id, target_id, start_cause, fixture_id, pairing_id from fixture_stream_sessions where id = ${sid}`)[0]!;
  /** `fixtureId` switched on, kicked off at `minute`, started by the court phone's beat and live on its next one. */
  const autoLive = async (fixtureId: string, minute: number, named: string | null = null): Promise<string> => {
    await streamOn(fixtureId);
    atMin(minute);
    await kickoff(fixtureId, minute);
    const over = named === null ? {} : { sid: named, state: "publishing" as const };
    // A2: the claiming beat answers before the start runs (waiting, or the old match's own answer); the next one hears it.
    const claiming = await beat(P, over);
    if (claiming.state === "go-live") throw new Error("premise: the claiming beat answers before its start runs");
    const go = await beat(P, over);
    if (go.state !== "go-live") throw new Error(`premise: the match starts, got ${go.state}`);
    expect((await sessionRow(go.sid)).fixture_id).toBe(fixtureId);
    now += SEC;
    expect((await beat(P, { sid: go.sid, state: "publishing" })).state, "premise: it went live").toBe("live");
    return go.sid;
  };
  /** Runs the queued tails with a sleep that moves the test's clock instead of waiting; answers each tail's sleeps (ms). */
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); now += ms; };
  const completes = () => (deps.youtube as FakeYouTube).calls.filter((c) => c.method === "complete").length;
  const broadcastState = async (fixtureId: string) =>
    (await sql<{ state: string }[]>`select state from youtube_broadcasts where fixture_id = ${fixtureId}`)[0]?.state;
  const endTail = (sid: string) => runCourtBroadcastEnd(sid, deps, { sleep, wallClock: () => now });

  it("a finished match: the auto-stop queues the end, which waits to S + 30 s and completes the broadcast once; the cron after it adds no call", async () => {
    sleeps.length = 0;
    const sidA = await autoLive(A, 0);
    await createdOnTestDay(sidA, 0);
    await decide(A, 10);
    now = at(10).getTime() + DELAY_MS;
    tails.queue.length = 0;
    await tickSession(sidA, deps, "sweep");
    expect((await sessionRow(sidA)).end_reason).toBe("auto_stopped");
    expect(tails.queue.length, "the auto-stop queued exactly one tail").toBe(1);
    const stoppedAt = now;
    expect(await broadcastState(A), "premise: not completed before the tail").not.toBe("complete");
    tails.queue.shift();
    expect(await endTail(sidA)).toBe(true);
    expect(completes()).toBe(1);
    expect(await broadcastState(A)).toBe("complete");
    expect(now - stoppedAt, "it waited the 30 s (the court's own tail ends at S, the rule adds 30 s)").toBe(30 * SEC);
    // The cron's step, afterwards: nothing left to end, no second call, no error.
    const r = await endDueBroadcasts(deps.youtube!, { now: () => new Date(now + 60 * SEC), budgetMs: 15_000, orgIds: [day.orgId] });
    expect(r).toMatchObject({ ended: 0, failed: 0 });
    expect(completes()).toBe(1);
  });

  it("the organiser's Stop of a decided match queues the same end", async () => {
    sleeps.length = 0;
    const sidA = await autoLive(A, 0);
    await decide(A, 1);
    now = at(1).getTime() + 5 * SEC;
    tails.queue.length = 0;
    await stopSession(day.auth, A, sidA, deps);
    expect(tails.queue.length).toBe(1);
    const stoppedAt = now;
    tails.queue.shift();
    expect(await endTail(sidA)).toBe(true);
    expect(completes()).toBe(1);
    expect(now - stoppedAt).toBe(30 * SEC);
  });

  it("an unfinished match (stopped mid-match, as O17 does): the tail does not wait or complete; the 5-minute grace is the cron's", async () => {
    sleeps.length = 0;
    const sidA = await autoLive(A, 0);
    tails.queue.length = 0;
    await stopSession(day.auth, A, sidA, deps);
    expect(tails.queue.length).toBe(1);
    tails.queue.shift();
    expect(await endTail(sidA)).toBe(false);
    expect(sleeps).toEqual([]);
    expect(completes()).toBe(0);
    expect(await broadcastState(A)).not.toBe("complete");
    // Four minutes on the cron still leaves it; at five it completes.
    const cron = (min: number) => endDueBroadcasts(deps.youtube!, { now: () => new Date(now + min * 60 * SEC), budgetMs: 15_000, orgIds: [day.orgId] });
    expect(await cron(4)).toMatchObject({ ended: 0 });
    expect(await cron(5)).toMatchObject({ ended: 1 });
    expect(completes()).toBe(1);
  });

  it("the cron got there first: the tail finds it complete and calls nothing; and a tail that dies leaves the cron to complete it", async () => {
    const sidA = await autoLive(A, 0);
    await decide(A, 1);
    now = at(1).getTime() + 5 * SEC;
    tails.queue.length = 0;
    await stopSession(day.auth, A, sidA, deps);
    expect(tails.queue.shift(), "the Stop queued its tail").toBeDefined();   // never run: the process died
    now += 31 * SEC;
    expect(await endDueBroadcasts(deps.youtube!, { now: () => new Date(now), budgetMs: 15_000, orgIds: [day.orgId] })).toMatchObject({ ended: 1 });
    expect(completes()).toBe(1);
    expect(await endTail(sidA), "the late tail, as if it had survived, finds it done").toBe(true);
    expect(completes(), "still one complete call").toBe(1);
  });

  it("a session that is not a court session, or has no broadcast, does nothing", async () => {
    sleeps.length = 0;
    expect(await endTail(randomUUID()), "no such session").toBe(false);
    expect(sleeps).toEqual([]);
  });

});
