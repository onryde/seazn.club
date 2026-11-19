// Court stream (spec seazn.club.capture docs/specs/2026-11-14-court-stream-design.md §5.4, §7 "Web"; plan Task 9): the tail,
// the latches, a desk restart, and money across handovers. Real Postgres; skipped without DATABASE_URL. Everything runs
// through the REAL code: the link is minted by `linkCourtStream`, the channel connected through the real save
// (`_connect-rig`), the phone's beats go through `postBeat`, the organiser's Stop and Go live are the match page's own
// `stopSession` and `createSession`, a session goes live through the real tick (FakeIngest, connectAfterMs 0), and every
// credit is taken by the real `consumeForSession` in that tick — never a ledger row inserted by the test.
//
// The rules under test, typed here from the brief and the spec, never imported from the code under test:
//   - nothing follows: a court session ends auto_stopped COURT_AUTO_STOP_AFTER_RESULT_SECONDS (30 s, O15) after the result, not before,
//     and never while its phone is in Operator; the court's Stream switch stands in for the match's auto_stream (§5.3);
//   - the organiser's Stop ends that video only: the link and the phone's pairing stay, the match is never re-offered (A12);
//   - the phone's Stop hold latches the match; the match page's Go live restarts it on the court phone, court_link_id set,
//     on the LINK's target whatever the body names (O9), and ends every older session of the court (one at a time);
//   - R3: the desk's restart (start_cause organiser) holds the court: the next beat never auto-starts a newer match over it;
//   - money: one consume per streamed match's first video, each on its own session and fixture; none for an unstreamed
//     match; none for a free restart (W23); none for a refused start; each match its own YouTube broadcast and input.
//
// Web batch A2 (2026-11-17): a court beat that claims a start answers at once and the start runs after the answer
// (`deferred`); here `@/lib/deferred` is a queue the `beat` helper drains after each answer, as Next's `after()` runs a tail
// once the response is sent, so the phone's NEXT beat is the one that hears the start.
//
// The link is for 2026-11-07, the seed's T0 day (Europe/Amsterdam): every clock is the test's, passed in.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tails = vi.hoisted(() => ({ queue: [] as (() => unknown)[] }));
vi.mock("@/lib/deferred", () => ({ deferred: (fn: () => unknown) => { tails.queue.push(fn); } }));
// B1: the YouTube end tail waits up to 45 s for its due time; this file is about the start, the tail and the money, and
// court-stream-youtube-end.test.ts drives the end tail with its own clock.
vi.mock("../stream-sessions/court-end", () => ({ endCourtBroadcastSoon: () => undefined }));
/** `deferred` swallows a tail's error in production; here one fails the test (fix round 1, finding 7). */
async function runTails(): Promise<void> {
  const errors: unknown[] = [];
  while (tails.queue.length > 0) {
    const fn = tails.queue.shift()!;
    try { await fn(); } catch (err) { errors.push(err); }
  }
  if (errors.length > 0) throw new AggregateError(errors, `a deferred tail threw (${errors.length})`);
}
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { CaptureBeat, CaptureBeatAnswer } from "@/server/api-v1/capture-schemas";
import { CreateStreamSession } from "@/server/api-v1/schemas/streaming";
import { AUTO_START_RETRY_SECONDS, COURT_AUTO_STOP_AFTER_RESULT_SECONDS } from "@/server/relay/config";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { rigTarget, rigUser, spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import { connect } from "@/server/youtube/__tests__/_connect-rig";
import { FakeYouTube } from "@/server/youtube/fake";
import { postBeat } from "../capture-phone";
import { linkCourtStream, setCourtStream } from "../court-streams";
import { creditBreakdown, grantCredits, revokeCredits } from "../stream-credits";
import { createSession, stopSession, tickSession, type SessionDeps } from "../stream-sessions";
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
const ACTIVE = ["requested", "provisioning", "warming", "live", "ending"];
const ENDED = ["ending", "completed"];

type Beat = CaptureBeat;
type Answer = CaptureBeatAnswer;

describe.skipIf(!HAS_DB)("court stream: the tail, the latches, a desk restart, and money across handovers", () => {
  let day: Day;
  let A: string; let B: string; let C: string;
  let targetId: string;
  let linkId: string;
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
    const shown = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId, day: DAY }, at(0));
    qr = { code: shown.qr!.code, tok: shown.qr!.tok };
    linkId = shown.id;
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
  const deskGoLive = (fixtureId: string, target = targetId) =>
    createSession(day.auth, fixtureId, CreateStreamSession.parse({ mode: "passthrough", targetId: target }), deps);
  const sessionRow = async (sid: string) => (await sql<{
    state: string; end_reason: string | null; court_link_id: string | null; target_id: string; start_cause: string; fixture_id: string;
    pairing_id: string | null;
  }[]>`select state, end_reason, court_link_id, target_id, start_cause, fixture_id, pairing_id from fixture_stream_sessions where id = ${sid}`)[0]!;
  const sessionsOf = async (fixtureId: string) =>
    sql<{ id: string; state: string }[]>`select id, state from fixture_stream_sessions where fixture_id = ${fixtureId} order by created_at, id`;
  const activeOfLink = async () =>
    (await sql<{ id: string }[]>`select id from fixture_stream_sessions where court_link_id = ${linkId} and state in ${sql(ACTIVE)}`).map((r) => r.id);
  /** The ledger's consume rows, each with the fixture of the session it names. */
  const consumes = async () => sql<{ session_id: string; fixture_id: string }[]>`
    select c.session_id, s.fixture_id from org_stream_credits c join fixture_stream_sessions s on s.id = c.session_id
     where c.org_id = ${day.orgId} and c.reason = 'consume' order by c.created_at, c.id`;
  const latchedAt = async (fixtureId: string) =>
    (await sql<{ b: Date | null }[]>`select auto_start_blocked_at as b from fixture_stream_settings where fixture_id = ${fixtureId}`)[0]?.b ?? null;
  const handoverEvents = async (sid: string) =>
    (await sql<{ payload: { to: string } }[]>`select payload from fixture_stream_events where session_id = ${sid} and type = 'court_handover'`).map((e) => e.payload);
  const handoverTrail = async (sid: string) =>
    sql<{ type: string; source: string }[]>`select type, source from fixture_stream_events
                                             where session_id = ${sid} and (type = 'court_handover' or (type = 'stop' and kind = 'action')) order by type`;
  const pairingOf = async (phone: string) =>
    sql<{ id: string; ended_at: Date | null }[]>`select p.id, p.ended_at from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
                                                  where c.court_link_id = ${linkId} and p.phone = ${phone}`;
  const linkOpen = async () =>
    (await sql<{ withdrawn_at: Date | null }[]>`select withdrawn_at from court_stream_links where id = ${linkId}`)[0]!.withdrawn_at === null;
  const prePick = async (fixtureId: string) =>
    (await sql<{ target_id: string | null }[]>`select target_id from fixture_stream_settings where fixture_id = ${fixtureId}`)[0]?.target_id ?? null;
  /** Zero credits: the monthly grant spent and the pack revoked. */
  const drain = async () => {
    await spendMonthlyStreamGrant(day.orgId);
    const { pack } = await creditBreakdown(sql, day.orgId);
    if (pack > 0) await revokeCredits({ orgId: day.orgId, delta: pack, createdBy: await rigUser(), note: "drain", idempotencyKey: randomUUID() });
    expect((await creditBreakdown(sql, day.orgId)).total, "premise: no credit left").toBe(0);
  };
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
  /** The phone takes the sid the beat hands it and publishes it: the beat's own tick takes it live. */
  const publish = async (sid: string) => {
    now += SEC;
    expect(await beat(P, { sid, state: "publishing" })).toMatchObject({ state: "live", sid });
  };

  // ── The tail and the latches ────────────────────────────────────────────────────────────────────────────────────────────

  it("nothing follows: A's court session ends auto_stopped 30 s after finished_at (O15, tunable), not before", async () => {
    const sidA = await autoLive(A, 0);
    await createdOnTestDay(sidA, 0);
    await decide(A, 10);
    expect(DELAY_MS, "the declared tail: the owner's 30 s court tail (2026-11-16)").toBe(30 * SEC);
    // The fixture's own auto_stream is never set: the court's Stream switch is what stops it.
    expect((await sql`select 1 from fixture_stream_settings where fixture_id = ${A} and auto_stream`).length, "premise: auto_stream off").toBe(0);
    now = at(10).getTime() + DELAY_MS - 1;
    await tickSession(sidA, deps, "sweep");
    expect(await sessionRow(sidA), "1 ms short of the tail").toMatchObject({ state: "live", end_reason: null });
    now = at(10).getTime() + DELAY_MS;
    await tickSession(sidA, deps, "sweep");
    const a = await sessionRow(sidA);
    expect(a.end_reason).toBe("auto_stopped");
    expect(ENDED).toContain(a.state);
    expect(await handoverEvents(sidA), "a tail's end, not a handover").toEqual([]);
    // The phone's next beat hears it over, and the court then waits: nothing else is streamed.
    expect(await beat(P, { sid: sidA, state: "publishing" })).toMatchObject({ state: "over", sid: sidA, endReason: "auto_stopped" });
    expect((await beat(P)).state).toBe("waiting");
    expect(await activeOfLink()).toEqual([]);
  });

  it("a court session with its phone in Operator is never auto-stopped", async () => {
    const sidA = await autoLive(A, 0);
    await createdOnTestDay(sidA, 0);
    // The phone switches to Operator: its beat records the mode on the pairing.
    now += SEC;
    expect((await beat(P, { sid: sidA, state: "publishing", mode: "operator" })).state).toBe("live");
    await decide(A, 10);
    now = at(10).getTime() + DELAY_MS;
    await tickSession(sidA, deps, "sweep");
    expect(await sessionRow(sidA)).toMatchObject({ state: "live", end_reason: null });
    now += 10 * 60 * SEC;
    expect(await beat(P, { sid: sidA, state: "publishing", mode: "operator" })).toMatchObject({ state: "live", sid: sidA });
    expect(await sessionRow(sidA)).toMatchObject({ state: "live", end_reason: null });
  });

  it("organiser Stop on A ends A only; the link and the phone's pairing stay; A is never re-offered", async () => {
    const sidA = await autoLive(A, 0);
    const [before] = await pairingOf(P);
    await stopSession(day.auth, A, sidA, deps);
    expect(await sessionRow(sidA)).toMatchObject({ end_reason: "stopped" });
    expect(ENDED).toContain((await sessionRow(sidA)).state);
    expect(await latchedAt(A), "A12: the organiser's Stop latches the match").not.toBeNull();
    expect(await linkOpen(), "the link stays").toBe(true);
    expect(await pairingOf(P), "the phone's pairing stays").toEqual([{ id: before!.id, ended_at: null }]);
    expect(await beat(P, { sid: sidA, state: "publishing" })).toMatchObject({ state: "over", sid: sidA });
    // A is still in play: past the retry spacing, the court never offers it again.
    for (let i = 0; i < 3; i++) {
      now += (AUTO_START_RETRY_SECONDS + 1) * SEC;
      const a = await beat(P);
      expect(a.state, `beat ${i}: A is not re-offered`).toBe("waiting");
    }
    expect(await sessionsOf(A)).toHaveLength(1);
    expect((await consumes()).map((r) => r.session_id)).toEqual([sidA]);
  });

  it("phone Stop on A latches A; the match page's Go live restarts it on the court phone, court_link_id set, target the link's even when the body names another", async () => {
    const sidA = await autoLive(A, 0);
    const other = await rigTarget(day.orgId, "Another channel");
    const pickBefore = await prePick(A);
    now += SEC;
    expect(await beat(P, { stopped: sidA })).toMatchObject({ state: "over", sid: sidA });
    expect((await sessionRow(sidA)).end_reason).toBe("operator_stopped");
    expect(await latchedAt(A), "the phone's Stop hold latches A").not.toBeNull();
    // Latched: A is not re-offered by itself, and the court says why (finding B).
    now += (AUTO_START_RETRY_SECONDS + 1) * SEC;
    expect(await beat(P)).toMatchObject({ state: "waiting", autoRefusal: "match_stopped" });
    // The desk restarts it from the match page, the body naming ANOTHER destination.
    const { sessionId: again } = await deskGoLive(A, other);
    expect(await sessionRow(again)).toMatchObject({
      fixture_id: A, court_link_id: linkId, target_id: targetId, start_cause: "organiser", pairing_id: (await pairingOf(P))[0]!.id,
    });
    // Court device check (2026-11-19, finding B; controller ruling): the desk's Go live is a person's start — it clears the latch.
    expect(await latchedAt(A), "the desk's restart cleared A's latch").toBeNull();
    // The match's own destination choice is untouched: no pre-pick written by a court start.
    expect(await prePick(A)).toBe(pickBefore);
    // The court phone is handed the restart, and it goes live.
    now += SEC;
    expect(await beat(P)).toMatchObject({ state: "go-live", sid: again });
    await publish(again);
    expect(await activeOfLink()).toEqual([again]);
  });

  // Review of #1265, hardening + R10's real case: A's own saved destination is a channel since archived (target_chosen, a
  // reconnected YouTube), and the desk's Go live sends ANOTHER org's destination. A court start ignores the body: it streams to
  // the court link's channel only, and saves nothing as A's pre-pick.
  it("#1265 review: R10 — A latched with its own choice archived, the desk's Go live sending another org's destination: streams to the court's channel, saves no pre-pick, clears the latch", async () => {
    const sidA = await autoLive(A, 0);
    const archived = await rigTarget(day.orgId, "Old channel");
    await sql`update org_stream_targets set archived_at = now() where id = ${archived}`;
    await sql`update fixture_stream_settings set target_id = ${archived}, target_chosen = true where fixture_id = ${A}`;
    now += SEC;
    expect(await beat(P, { stopped: sidA })).toMatchObject({ state: "over", sid: sidA });
    expect(await latchedAt(A), "premise: latched").not.toBeNull();
    const foreignOrg = await seedDay();
    const foreign = await rigTarget(foreignOrg.orgId, "Someone else's channel");
    const { sessionId: again } = await deskGoLive(A, foreign);
    expect(await sessionRow(again)).toMatchObject({ fixture_id: A, court_link_id: linkId, target_id: targetId, start_cause: "organiser" });
    expect(await prePick(A), "the match's own (archived) choice is untouched; the foreign one is never saved").toBe(archived);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_settings where target_id = ${foreign}`)[0]!.n).toBe(0);
    expect(await latchedAt(A), "the desk's start cleared the latch").toBeNull();
  });

  it("a match-page restart of A while B's court session is live ends B (one active session per court link)", async () => {
    await streamOn(B);
    const sidA = await autoLive(A, 0);
    await stopSession(day.auth, A, sidA, deps);   // the organiser's Stop: A latched, still in play
    const sidB = await autoLive(B, 5);
    expect(await activeOfLink(), "premise: B's court session is the one live").toEqual([sidB]);
    atMin(6);
    const { sessionId: deskA } = await deskGoLive(A);
    expect(await sessionRow(deskA)).toMatchObject({ fixture_id: A, court_link_id: linkId, start_cause: "organiser" });
    // B's session is older than the restart: it ends, handed over to the restart.
    expect(await sessionRow(sidB)).toMatchObject({ end_reason: "auto_stopped" });
    expect(await handoverEvents(sidB)).toEqual([{ to: deskA }]);
    // Final review m-5: the desk's restart is the organiser's act in the trail (source client), not the phone's — the stop and the handover.
    expect(await handoverTrail(sidB)).toEqual([{ type: "court_handover", source: "client" }, { type: "stop", source: "client" }]);
    expect(await activeOfLink()).toEqual([deskA]);
    // R4: B was still in play, so it is latched — and R3 holds the court for the desk: no ping-pong back to B.
    expect(await latchedAt(B)).not.toBeNull();
    now += SEC;
    expect(await beat(P, { sid: sidB, state: "publishing" })).toMatchObject({ state: "go-live", sid: deskA });
    await publish(deskA);
    for (let i = 0; i < 3; i++) {
      now += (AUTO_START_RETRY_SECONDS + 1) * SEC;
      expect(await beat(P, { sid: deskA, state: "publishing" }), `beat ${i}: still A`).toMatchObject({ state: "live", sid: deskA });
    }
    expect(await sessionsOf(B)).toHaveLength(1);
    expect(await activeOfLink()).toEqual([deskA]);
  });

  it("R3: a desk start of A holds the court over a NEWER streamed match in play with no session — the next beat never auto-starts it", async () => {
    await streamOn(A);
    await streamOn(B);
    await kickoff(A, 0);
    // B kicks off later while the phone is in Operator, so nothing starts by itself.
    atMin(5);
    await kickoff(B, 5);
    expect((await beat(P, { mode: "operator" })).state).toBe("waiting");
    expect(await sessionsOf(B)).toEqual([]);
    // The desk starts A by hand; then the phone goes back to Automatic.
    const { sessionId: deskA } = await deskGoLive(A);
    expect(await sessionRow(deskA)).toMatchObject({ court_link_id: linkId, start_cause: "organiser" });
    now += SEC;
    expect(await beat(P)).toMatchObject({ state: "go-live", sid: deskA });
    await publish(deskA);
    for (let i = 0; i < 3; i++) {
      now += (AUTO_START_RETRY_SECONDS + 1) * SEC;
      expect(await beat(P, { sid: deskA, state: "publishing" }), `beat ${i}: B never displaces the desk's A`).toMatchObject({ state: "live", sid: deskA });
    }
    expect(await sessionsOf(B)).toEqual([]);
    expect(await latchedAt(B), "B is not latched: it is held off, not stopped").toBeNull();
  });

  // ── Money and retention (spec §7 Web) ───────────────────────────────────────────────────────────────────────────────────

  it("A then B streamed back to back: two consume rows, one per session, each session's fixture its own", async () => {
    await streamOn(B);
    const sidA = await autoLive(A, 0);
    await decide(A, 10);
    const sidB = await autoLive(B, 11, sidA);
    expect(sidB).not.toBe(sidA);
    expect(await consumes()).toEqual([{ session_id: sidA, fixture_id: A }, { session_id: sidB, fixture_id: B }]);
    // A later beat of the same video takes nothing more.
    now += 120 * SEC;
    await publish(sidB);
    expect(await consumes()).toHaveLength(2);
  });

  it("A streamed, C (switch off) played between, then B: C has no session and no consume row", async () => {
    await streamOn(B);
    const sidA = await autoLive(A, 0);
    await createdOnTestDay(sidA, 0);
    await decide(A, 10);
    // C kicks off unstreamed; A's tail ends on its own.
    atMin(11);
    await kickoff(C, 11);
    now = at(10).getTime() + DELAY_MS - SEC;
    expect(await beat(P, { sid: sidA, state: "publishing" })).toMatchObject({ state: "live", sid: sidA });
    now = at(10).getTime() + DELAY_MS;
    expect(await beat(P, { sid: sidA, state: "publishing" })).toMatchObject({ state: "over", sid: sidA, endReason: "auto_stopped" });
    atMin(40);
    expect((await beat(P)).state, "C is not streamed").toBe("waiting");
    await decide(C, 40);
    const sidB = await autoLive(B, 41);
    expect(await sessionsOf(C)).toEqual([]);
    expect(await consumes()).toEqual([{ session_id: sidA, fixture_id: A }, { session_id: sidB, fixture_id: B }]);
  });

  it("A restarted by the desk inside the reuse window: no second consume (W23 free restart)", async () => {
    const sidA = await autoLive(A, 0);
    expect((await consumes()).map((r) => r.session_id)).toEqual([sidA]);
    const { total: before } = await creditBreakdown(sql, day.orgId);
    await stopSession(day.auth, A, sidA, deps);
    atMin(5);
    expect((await beat(P)).state, "the court phone, present and waiting").toBe("waiting");
    const { sessionId: again } = await deskGoLive(A);
    expect((await sessionRow(again)).court_link_id).toBe(linkId);
    expect(await beat(P)).toMatchObject({ state: "go-live", sid: again });
    await publish(again);
    expect((await sessionRow(again)).state).toBe("live");
    expect((await consumes()).map((r) => r.session_id), "the restart is free").toEqual([sidA]);
    expect((await creditBreakdown(sql, day.orgId)).total).toBe(before);
  });

  it("each streamed match gets its own YouTube broadcast row (fixture_id = that match), and each session its own recording uids", async () => {
    await streamOn(B);
    const sidA = await autoLive(A, 0);
    await decide(A, 10);
    const sidB = await autoLive(B, 11, sidA);
    const broadcasts = await sql<{ fixture_id: string; last_session_id: string | null }[]>`
      select fixture_id, last_session_id from youtube_broadcasts where org_id = ${day.orgId} order by fixture_id`;
    expect(broadcasts.map((b) => ({ fixture_id: b.fixture_id, last_session_id: b.last_session_id })).sort((x, y) => (x.fixture_id < y.fixture_id ? -1 : 1)))
      .toEqual([{ fixture_id: A, last_session_id: sidA }, { fixture_id: B, last_session_id: sidB }].sort((x, y) => (x.fixture_id < y.fixture_id ? -1 : 1)));
    const inputs = await sql<{ session_id: string; ingest_input_id: string | null }[]>`
      select session_id, ingest_input_id from fixture_stream_inputs where session_id in (${sidA}, ${sidB})`;
    const uidsOf = (sid: string) => inputs.filter((i) => i.session_id === sid).map((i) => i.ingest_input_id);
    expect(uidsOf(sidA).length).toBeGreaterThan(0);
    expect(uidsOf(sidB).length).toBeGreaterThan(0);
    for (const u of [...uidsOf(sidA), ...uidsOf(sidB)]) expect(u, "every input has its uid").not.toBeNull();
    expect(uidsOf(sidA).filter((u) => uidsOf(sidB).includes(u)), "no recording uid shared across the handover").toEqual([]);
  });

  it("a refused start (no_credit) writes no session and no consume row", async () => {
    await drain();
    await streamOn(A);
    await kickoff(A, 0);
    expect((await beat(P)).state).toBe("waiting");
    expect((await sql<{ r: string | null }[]>`select auto_start_refusal as r from fixture_stream_settings where fixture_id = ${A}`)[0]!.r).toBe("no_credit");
    // The desk's Go live on the court phone is refused the same way.
    await expect(deskGoLive(A)).rejects.toMatchObject({ status: 402 });
    expect(await sessionsOf(A)).toEqual([]);
    expect(await consumes()).toEqual([]);
  });
});
