// Court stream (spec seazn.club.capture docs/specs/2026-11-14-court-stream-design.md §5.3–§5.4; plan Task 8): the court's
// automatic start and its handover. Real Postgres; skipped without DATABASE_URL. Everything runs through the REAL code: the
// link is minted by `linkCourtStream`, the channel connected through the real save (`_connect-rig`), the phone's beats go
// through `postBeat`, a session goes live through the real tick (FakeIngest, connectAfterMs 0), and the credit is taken by
// the real `consumeForSession` in that tick.
//
// The rules under test, typed here from the brief and the spec, never imported from the code under test:
//   - a streamed match that kicks off on the court starts by itself on the court phone's next beat (Automatic on): go-live,
//     startedBy automatic, the LINK's target, court_link_id set; an unstreamed one never starts;
//   - start first, then stop: the new match's session opens, THEN every older session of the court ends auto_stopped with a
//     court_handover {to: new}; a refused start ends nothing (the old match's tail runs on);
//   - the beat naming the ended old sid while the new one is armed hears go-live on the new one (the handover row);
//   - once per match (A4/A16), retried only on the retry spacing (R7), never with the phone in Operator mode, never past
//     the link's day or once it is withdrawn;
//   - money: one credit per streamed match's first video, none for an unstreamed match, none for a refused start;
//   - web batch A2 (2026-11-17): the beat that claims a start answers at once, `waiting` with the starting cadence (5 s), and
//     the start itself runs after the answer (`deferred`, Next's `after()`); the phone's NEXT beat finds the session.
//
// `@/lib/deferred` is replaced by a queue the `beat` helper drains after each answer, as Next's `after()` runs a tail after
// the response: so the beat's answer is judged before its start runs, the order production has. (The real `deferred` runs a
// tail inline under vitest, racing the beat's own answer.)
//
// The link is for 2026-11-07, the seed's T0 day (Europe/Amsterdam): every clock is the test's, passed in.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tails = vi.hoisted(() => ({ queue: [] as (() => unknown)[] }));
vi.mock("@/lib/deferred", () => ({ deferred: (fn: () => unknown) => { tails.queue.push(fn); } }));
/** Runs every queued tail, and the tails those queue, as `after()` would once the response is sent. Errors are swallowed,
 *  as `deferred` swallows them. */
async function runTails(): Promise<number> {
  let n = 0;
  while (tails.queue.length > 0) {
    const fn = tails.queue.shift()!;
    n += 1;
    try { await fn(); } catch { /* deferred's contract: a tail's error never reaches the caller */ }
  }
  return n;
}
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { CaptureBeat, CaptureBeatAnswer } from "@/server/api-v1/capture-schemas";
import { AUTO_START_RETRY_SECONDS, POLL_STARTING_SECONDS } from "@/server/relay/config";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { rigUser, spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import { connect } from "@/server/youtube/__tests__/_connect-rig";
import { FakeYouTube } from "@/server/youtube/fake";
import { markReconnectNeeded } from "@/server/youtube/token-store";
import { postBeat } from "../capture-phone";
import type { ResolvedCourtCode } from "../court-stream-codes";
import { linkCourtStream, setCourtStream, withdrawCourtStream } from "../court-streams";
import { resolveAnyStreamCode } from "../stream-codes";
import { creditBreakdown, grantCredits, revokeCredits } from "../stream-credits";
import { maybeCourtAutoStart } from "../stream-auto-court";
import { startBroadcast, type SessionDeps } from "../stream-sessions";
import { streamPhone } from "../stream-phone";
import { override, phoneId } from "./_capture-rig";
import { at, labelOf, place, seedDay, setStatus, type Day } from "./_match-day-seed";

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
const ACTIVE = ["requested", "provisioning", "warming", "live", "ending"];

type Beat = CaptureBeat;
type Answer = CaptureBeatAnswer;

describe.skipIf(!HAS_DB)("a court's automatic start and handover", () => {
  let day: Day;
  let A: string; let B: string; let C: string;
  let targetId: string;
  let connectionId: string;
  let linkId: string;
  let qr: { code: string; tok: string };
  let now: number;
  let deps: SessionDeps;
  let ingest: FakeIngest;
  let P: string;

  beforeEach(async () => {
    tails.queue.length = 0;
    day = await seedDay();
    [A, B, C] = day.comp.fixtures.map((f) => f.id) as [string, string, string];
    await override(day.orgId, "streaming.relay", true);
    await override(day.orgId, "streaming.overlay", true);
    await grantCredits({ orgId: day.orgId, delta: 5, createdBy: await rigUser(), note: "court auto", idempotencyKey: randomUUID() });
    const c = await connect({ auth: day.auth, orgId: day.orgId, userId: day.auth.userId! });
    targetId = c.targetId;
    connectionId = c.connectionId;
    now = at(0).getTime();
    ingest = new FakeIngest({ clock: () => now, connectAfterMs: 0 });
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
  /** A2: the beat that claims a start answers at once — `waiting` at the starting cadence while the court is idle, still
   *  `live` on the old match when it names one — and the phone's next beat, after the start ran, is the one that hears it. */
  async function kick(over: Partial<Beat> = {}): Promise<Answer> {
    const first = await beat(P, over);
    if (over.sid != null) expect(first, "the claiming beat still answers the old match").toMatchObject({ state: "live", sid: over.sid });
    else expect(first, "the claiming beat answers waiting at the starting cadence").toMatchObject({ state: "waiting", pollSeconds: POLL_STARTING_SECONDS });
    return beat(P, over);
  }
  /** Kicked off for real: a `core.start` score event at `minute` (the kick-off courtFactsOf reads) and status in_play. */
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
  const streamOn = (fixtureId: string) => setCourtStream(day.auth, fixtureId, true, clock());
  const sessionRow = async (sid: string) => (await sql<{
    state: string; end_reason: string | null; court_link_id: string | null; target_id: string; start_cause: string; fixture_id: string;
    pairing_id: string | null;
  }[]>`select state, end_reason, court_link_id, target_id, start_cause, fixture_id, pairing_id from fixture_stream_sessions where id = ${sid}`)[0]!;
  const sessionsOf = async (fixtureId: string) =>
    sql<{ id: string; state: string }[]>`select id, state from fixture_stream_sessions where fixture_id = ${fixtureId} order by created_at, id`;
  const activeOfLink = async () =>
    (await sql<{ id: string }[]>`select id from fixture_stream_sessions where court_link_id = ${linkId} and state in ${sql(ACTIVE)}`).map((r) => r.id);
  const consumeRows = async (orgId: string) =>
    sql<{ session_id: string }[]>`select session_id from org_stream_credits where org_id = ${orgId} and reason = 'consume' order by created_at`;
  const settingsOf = async (fixtureId: string) => (await sql<{
    auto_start_refusal: string | null; auto_start_attempted_at: Date | null; auto_started_at: Date | null; auto_start_blocked_at: Date | null;
  }[]>`select auto_start_refusal, auto_start_attempted_at, auto_started_at, auto_start_blocked_at from fixture_stream_settings where fixture_id = ${fixtureId}`)[0];
  const handoverEvents = async (sid: string) =>
    (await sql<{ payload: { to: string } }[]>`select payload from fixture_stream_events where session_id = ${sid} and type = 'court_handover'`).map((e) => e.payload);
  const pairingOf = async (phone: string) =>
    sql<{ id: string; ended_at: Date | null }[]>`select p.id, p.ended_at from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
                                                  where c.court_link_id = ${linkId} and p.phone = ${phone}`;
  const court = async (): Promise<ResolvedCourtCode> => {
    const r = await resolveAnyStreamCode(qr.code, qr.tok, "get", null, clock());
    if (r.kind !== "court") throw new Error("premise: the court code resolves as a court");
    return r;
  };
  /** Zero credits: the monthly grant spent and the pack revoked. */
  const drain = async () => {
    await spendMonthlyStreamGrant(day.orgId);
    const { pack } = await creditBreakdown(sql, day.orgId);
    if (pack > 0) await revokeCredits({ orgId: day.orgId, delta: pack, createdBy: await rigUser(), note: "drain", idempotencyKey: randomUUID() });
    expect((await creditBreakdown(sql, day.orgId)).total, "premise: no credit left").toBe(0);
  };
  /** A switched on, kicked off at 10:00Z, started by the court phone's beat and live on its next one. */
  const aLive = async (): Promise<string> => {
    await streamOn(A);
    await kickoff(A, 0);
    const go = await kick();
    if (go.state !== "go-live") throw new Error(`premise: A starts, got ${go.state}`);
    now += SEC;
    expect((await beat(P, { sid: go.sid, state: "publishing" })).state, "premise: A went live").toBe("live");
    expect((await sessionRow(go.sid)).state).toBe("live");
    return go.sid;
  };

  it("A switched on kicks off: the next beat answers go-live, startedBy automatic; the session has court_link_id and A's fixture", async () => {
    await streamOn(A);
    await kickoff(A, 0);
    const ans = await kick();
    expect(ans).toMatchObject({ state: "go-live", startedBy: "automatic", label: labelOf(day.comp, day.comp.fixtures[0]!) });
    if (ans.state !== "go-live") throw new Error("unreachable");
    expect(await sessionRow(ans.sid)).toMatchObject({ fixture_id: A, court_link_id: linkId, target_id: targetId, start_cause: "automatic" });
    // Money: the credit is taken by the tick that sees its first video, once.
    expect(await consumeRows(day.orgId)).toEqual([]);
    now += SEC;
    expect((await beat(P, { sid: ans.sid, state: "publishing" })).state).toBe("live");
    expect((await consumeRows(day.orgId)).map((r) => r.session_id)).toEqual([ans.sid]);
    // And it never starts twice: the beat keeps answering live on the one session.
    now += 120 * SEC;
    expect(await beat(P, { sid: ans.sid, state: "publishing" })).toMatchObject({ state: "live", sid: ans.sid });
    expect(await sessionsOf(A)).toHaveLength(1);
  });

  it("A2: the claiming beat answers before the start runs (waiting, 5 s); a second beat while it is in flight starts nothing; the next beat after it hears go-live", async () => {
    await streamOn(A);
    await kickoff(A, 0);
    // The beat's answer, with its start still queued (not drained): no session, no input, the starting cadence.
    const first = await postBeat(qr.code, qr.tok, body(P), deps, clock());
    expect(first).toMatchObject({ state: "waiting", pollSeconds: POLL_STARTING_SECONDS });
    expect(tails.queue, "exactly one start handed to the background").toHaveLength(1);
    expect(await sessionsOf(A), "the answer did not wait on the start").toEqual([]);
    expect((await settingsOf(A))!.auto_start_attempted_at?.getTime(), "the claim was taken on the beat").toBe(at(0).getTime());
    // A second beat while that start is still running: the claim is held, so nothing more is handed over.
    now += POLL_STARTING_SECONDS * SEC;
    const second = await postBeat(qr.code, qr.tok, body(P), deps, clock());
    expect(second.state).toBe("waiting");
    expect(tails.queue, "the second beat started nothing").toHaveLength(1);
    // The start runs (after the first answer was sent); the phone's next beat finds it armed.
    expect(await runTails()).toBe(1);
    expect(await sessionsOf(A)).toHaveLength(1);
    now += POLL_STARTING_SECONDS * SEC;
    expect(await beat(P)).toMatchObject({ state: "go-live", startedBy: "automatic" });
    expect(await sessionsOf(A), "one start in all").toHaveLength(1);
    expect((await settingsOf(A))!.auto_started_at).not.toBeNull();
  });

  it("a court start with the match's mode never chosen is COMPOSED: a programme input exists and the add_output effect targets it, not the camera (A2)", async () => {
    // Every other start here runs `passthrough`, as the helpers that call startBroadcast say; the court's own start asks
    // `startModeFor`, and a fixture whose stream_mode was never stored streams the score whenever the deployment can run it.
    // A composed deployment: the compositor image configured, and the secret the runner's job token is minted under.
    const prev = { image: process.env.RELAY_IMAGE, secret: process.env.AUTH_SECRET };
    process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:court-composed-test";
    process.env.AUTH_SECRET = "stream-auto-court-composed-test-secret";
    try {
      await streamOn(A);
      await kickoff(A, 0);
      expect((await sql`select 1 from fixture_stream_settings where fixture_id = ${A} and stream_mode is not null`).length, "premise: mode never chosen").toBe(0);
      const go = await kick();
      if (go.state !== "go-live") throw new Error(`premise: A starts, got ${go.state}`);
      const inputs = await sql<{ role: string; ingest_input_id: string | null }[]>`
        select role, ingest_input_id from fixture_stream_inputs where session_id = ${go.sid} order by role`;
      expect((await sql<{ mode: string }[]>`select mode from fixture_stream_sessions where id = ${go.sid}`)[0]!.mode).toBe("composed");
      expect(inputs.map((i) => i.role), "a composed session has a camera and a programme input").toEqual(["camera", "programme"]);
      const camera = inputs.find((i) => i.role === "camera")!.ingest_input_id;
      const programme = inputs.find((i) => i.role === "programme")!.ingest_input_id;
      expect(camera, "premise: the camera input was provisioned").toBeTruthy();
      expect(programme, "premise: the programme input was provisioned").toBeTruthy();
      expect(programme).not.toBe(camera);
      // The simulcast is on the PROGRAMME input; the camera's input carries no output (the destination key never reaches the phone's input).
      expect(ingest.outputsFor(programme!), "the destination is the programme's output").toHaveLength(1);
      expect(ingest.outputsFor(camera!), "the camera input has no output").toEqual([]);
    } finally {
      if (prev.image === undefined) delete process.env.RELAY_IMAGE; else process.env.RELAY_IMAGE = prev.image;
      if (prev.secret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = prev.secret;
    }
  });

  it("O15 panel line: the organiser read for a court match serves the COURT tail (30 s), never the code's 180 s (a per-fixture code's 180 is stream-phone.test.ts's)", async () => {
    const sidA = await aLive();
    const read = () => streamPhone(day.auth, A, { now: clock });
    const court = (await read()).auto;
    expect(court, "premise: the court's switch is a settings row, so the read serves an auto block").not.toBeNull();
    expect(court, "the court session stop applies and waits the court tail, not 180").toMatchObject({ stopApplies: true, stopAfterSeconds: 30 });
    // The switch is the court's, the session is the court's: the per-fixture 180 s never shows for it, result or none.
    // `created_at` is the database's wall clock, the result the test's day: the session is put back on the test's day so it
    // predates the result (A15), as on a real day.
    await sql`update fixture_stream_sessions set created_at = ${at(0)} where id = ${sidA}`;
    await decide(A, 10);
    now = at(10).getTime() + SEC;
    expect((await read()).auto).toMatchObject({ stopApplies: true, stopAfterSeconds: 30 });
    // The tick the line promises: 30 s after the result, the same session ends auto_stopped.
    now = at(10).getTime() + 30 * SEC;
    await beat(P, { sid: sidA, state: "publishing" });
    expect(await sessionRow(sidA)).toMatchObject({ end_reason: "auto_stopped" });
  });

  it("an unstreamed match in play never starts: no session, no consume row", async () => {
    await kickoff(C, 0);
    expect((await beat(P)).state).toBe("waiting");
    now += (AUTO_START_RETRY_SECONDS + 1) * SEC;
    expect((await beat(P)).state).toBe("waiting");
    expect(await sessionsOf(C)).toEqual([]);
    expect(await consumeRows(day.orgId)).toEqual([]);
  });

  it("A in its tail, B kicks off: B starts, then A ends auto_stopped with court_handover {to: B}; the handover beat answers go-live B", async () => {
    await streamOn(B);
    const sidA = await aLive();
    await decide(A, 10);
    atMin(11);
    await kickoff(B, 11);
    // The beat names A (still publishing it): B opens, A ends, and the next beat's answer hands the phone to B.
    const ans = await kick({ sid: sidA, state: "publishing" });
    expect(ans).toMatchObject({ state: "go-live", startedBy: "automatic", label: labelOf(day.comp, day.comp.fixtures[1]!) });
    if (ans.state !== "go-live") throw new Error("unreachable");
    const sidB = ans.sid;
    expect(sidB).not.toBe(sidA);
    expect(await sessionRow(sidB)).toMatchObject({ fixture_id: B, court_link_id: linkId, start_cause: "automatic", state: "warming" });
    const a = await sessionRow(sidA);
    expect(a.end_reason).toBe("auto_stopped");
    expect(["ending", "completed"]).toContain(a.state);
    expect(await handoverEvents(sidA)).toEqual([{ to: sidB }]);
    expect(await activeOfLink()).toEqual([sidB]);
    // A was decided: the handover does not latch it (R4 latches only a match still in play).
    expect((await settingsOf(A))!.auto_start_blocked_at).toBeNull();
    // B goes live; one credit per streamed match's first video.
    now += SEC;
    expect(await beat(P, { sid: sidB, state: "publishing" })).toMatchObject({ state: "live", sid: sidB });
    expect((await consumeRows(day.orgId)).map((r) => r.session_id)).toEqual([sidA, sidB]);
  });

  it("the handover beat names A and B is armed: the answer is go-live B, again on a repeat of the same beat", async () => {
    await streamOn(B);
    const sidA = await aLive();
    await decide(A, 10);
    atMin(11);
    await kickoff(B, 11);
    const first = await kick({ sid: sidA, state: "publishing" });
    if (first.state !== "go-live") throw new Error(`premise: the handover fired, got ${first.state}`);
    // A retry of the same beat (the phone did not hear the answer): A is ended, B still armed → go-live B, never over A.
    now += SEC;
    const again = await beat(P, { sid: sidA, state: "publishing" });
    expect(again).toMatchObject({ state: "go-live", sid: first.sid, startedBy: "automatic" });
    expect(await sessionsOf(B)).toHaveLength(1);
  });

  it("phone offline across the handover: its first beat back naming A starts B; a following beat hears go-live B; never a new A", async () => {
    await streamOn(B);
    const sidA = await aLive();
    // The phone goes silent; the match ends and the next one kicks off while nobody hears it.
    await decide(A, 10);
    await kickoff(B, 11);
    atMin(20);
    expect(await sessionsOf(B), "nothing starts without the phone's beat").toHaveLength(0);
    // A2: the beat back claims B's start and answers at once. A is still open until B exists (start first, then stop), so
    // the answer is A's own (`live`), or `over` A when A has ended by itself; the beat after it, B having started, hands over.
    const back = await beat(P, { sid: sidA, state: "publishing" });
    expect(["live", "over"]).toContain(back.state);
    if (back.state === "live" || back.state === "over") expect(back.sid).toBe(sidA);
    now += SEC;
    const goLive = await beat(P, back.state === "over" ? {} : { sid: sidA, state: "publishing" });
    expect(goLive.state).toBe("go-live");
    if (goLive.state !== "go-live") throw new Error("unreachable");
    expect(goLive.sid).not.toBe(sidA);
    expect((await sessionRow(goLive.sid)).fixture_id).toBe(B);
  });

  it("two court sessions open (a desk restart and an automatic start): after the next start only the new one is active", async () => {
    await streamOn(A);
    await streamOn(B);
    await streamOn(C);
    const [pairing] = await pairingOf(P);
    // A desk restart of A (the organiser's start on the court's pairing), then an automatic start of B over it.
    await kickoff(A, 0);
    const { sessionId: deskA } = await startBroadcast(
      { userId: day.auth.userId!, orgId: day.orgId, source: "organiser", pairingId: pairing!.id }, A,
      { targetId, startCause: "organiser", phone: "present", mode: "passthrough", courtLinkId: linkId }, deps,
    );
    atMin(1);
    await kickoff(B, 1);
    const { sessionId: autoB } = await startBroadcast(
      { userId: day.auth.userId!, orgId: day.orgId, source: "auto", pairingId: pairing!.id }, B,
      { targetId, startCause: "automatic", phone: "present", mode: "passthrough", courtLinkId: linkId, autoStartedAt: clock() }, deps,
    );
    expect((await activeOfLink()).sort(), "premise: two court sessions open").toEqual([deskA, autoB].sort());
    atMin(2);
    await kickoff(C, 2);
    // A2: the claiming beat answers before C's start runs, so it still names the newest open session, B, armed; the phone's
    // next beat names B, ended by C's start, and is handed over to C.
    const claiming = await beat(P);
    expect(claiming).toMatchObject({ state: "go-live", sid: autoB });
    const ans = await beat(P, { sid: autoB, state: "publishing" });
    expect(ans).toMatchObject({ state: "go-live", startedBy: "automatic" });
    if (ans.state !== "go-live") throw new Error("unreachable");
    expect((await sessionRow(ans.sid)).fixture_id).toBe(C);
    expect(await activeOfLink()).toEqual([ans.sid]);
    expect((await sessionRow(deskA)).end_reason).toBe("auto_stopped");
    expect((await sessionRow(autoB)).end_reason).toBe("auto_stopped");
    expect(await handoverEvents(deskA)).toEqual([{ to: ans.sid }]);
    expect(await handoverEvents(autoB)).toEqual([{ to: ans.sid }]);
  });

  it("a match switched on mid-match goes live late, once; once it received video it never auto-starts again", async () => {
    await kickoff(A, 0);
    expect((await beat(P)).state, "not switched on: nothing starts").toBe("waiting");
    atMin(5);
    await streamOn(A);
    const go = await kick();
    expect(go).toMatchObject({ state: "go-live", startedBy: "automatic" });
    if (go.state !== "go-live") throw new Error("unreachable");
    now += SEC;
    expect((await beat(P, { sid: go.sid, state: "publishing" })).state).toBe("live");
    // The video ends by itself (no organiser Stop, so no A12 latch), the match still in play.
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'phone_lost', ended_at = ${clock()} where id = ${go.sid}`;
    now += (AUTO_START_RETRY_SECONDS + 1) * SEC;
    expect((await beat(P)).state).toBe("waiting");
    expect(await sessionsOf(A), "once: the automatic start ran").toHaveLength(1);
    // A16 alone: even with the once-stamp cleared, a match that received video never auto-starts again.
    await sql`update fixture_stream_settings set auto_started_at = null, auto_start_session_id = null where fixture_id = ${A}`;
    now += (AUTO_START_RETRY_SECONDS + 1) * SEC;
    expect((await beat(P)).state).toBe("waiting");
    expect(await sessionsOf(A)).toHaveLength(1);
    expect(await consumeRows(day.orgId)).toHaveLength(1);
  });

  it("the claim is a compare-and-set on the switch: a Stream switch turned off between the read and the claim loses the claim, and nothing starts", async () => {
    await streamOn(A);
    await kickoff(A, 0);
    const [pairing] = await pairingOf(P);
    // Hold A's settings row: the facts read (a plain select) goes through, the claim's UPDATE waits on the row. While it
    // waits, the organiser switches Stream off in the holding transaction; the claim then re-checks its WHERE on the new row.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const held = new Promise<void>((r) => { locked = r; });
    const holder = sql.begin(async (tx) => {
      await tx`select 1 from fixture_stream_settings where fixture_id = ${A} for update`;
      locked();
      await gate;
      await tx`update fixture_stream_settings set court_stream = false where fixture_id = ${A}`;
    });
    await held;
    const attempt = maybeCourtAutoStart({ court: await court(), pairingId: pairing!.id, phoneMode: "automatic" }, deps, clock());
    for (let i = 0; i < 200; i++) {
      const [w] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where wait_event_type = 'Lock' and query like '%update fixture_stream_settings set auto_start_attempted_at%'`;
      if (w!.n > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await holder;
    expect(await attempt).toEqual({ fired: false, why: "claim_lost" });
    expect(await sessionsOf(A)).toEqual([]);
  });

  it("the phone in Operator mode: nothing starts; the waiting answer still names A", async () => {
    await streamOn(A);
    await kickoff(A, 0);
    const ans = await beat(P, { mode: "operator" });
    expect(ans).toMatchObject({ state: "waiting", label: labelOf(day.comp, day.comp.fixtures[0]!) });
    expect(await sessionsOf(A)).toEqual([]);
    expect((await settingsOf(A))!.auto_start_attempted_at, "no attempt was claimed").toBeNull();
  });

  it("final review m-1: a link whose day has not opened yet is link_closed too — nothing starts, nothing is claimed — and opens the instant its day does", async () => {
    await streamOn(B);
    await aLive();
    atMin(11);
    await kickoff(B, 11);
    const [pairing] = await pairingOf(P);
    await sql`update fixture_stream_pairings set last_beat_at = ${clock()} where id = ${pairing!.id}`;
    const live = await court();
    const run = (c: ResolvedCourtCode, t: Date) => maybeCourtAutoStart({ court: c, pairingId: pairing!.id, phoneMode: "automatic" }, deps, t);
    const tomorrow = { ...live, link: { ...live.link, opensAt: new Date(clock().getTime() + 1) } };
    expect(await run(tomorrow, clock())).toEqual({ fired: false, why: "link_closed" });
    expect(await sessionsOf(B)).toEqual([]);
    expect((await settingsOf(B))!.auto_start_attempted_at, "a closed window claims nothing").toBeNull();
    // Positive control: the same facts with the window open this very millisecond — the handover is due and fires.
    expect(await run({ ...live, link: { ...live.link, opensAt: clock() } }, clock())).toMatchObject({ fired: true });
  });

  it("past the day's end or withdrawn: link_closed, nothing starts, the live session runs on", async () => {
    await streamOn(B);
    const sidA = await aLive();
    atMin(11);
    await kickoff(B, 11);   // a newer kick-off: a handover would be due on an open link
    const [pairing] = await pairingOf(P);
    // The phone present (its beat just now), so every other conjunct of the start holds: only the link is closed.
    await sql`update fixture_stream_pairings set last_beat_at = ${clock()} where id = ${pairing!.id}`;
    const live = await court();
    const run = (c: ResolvedCourtCode, t: Date) => maybeCourtAutoStart({ court: c, pairingId: pairing!.id, phoneMode: "automatic" }, deps, t);
    expect(await run({ ...live, link: { ...live.link, withdrawnAt: clock() } }, clock())).toEqual({ fired: false, why: "link_closed" });
    expect(await run(live, live.link.expiresAt)).toEqual({ fired: false, why: "link_closed" });
    expect(await run({ ...live, status: "finishing" }, clock())).toEqual({ fired: false, why: "link_closed" });
    expect(await run({ ...live, status: "ended" }, clock())).toEqual({ fired: false, why: "link_closed" });
    expect(await sessionsOf(B)).toEqual([]);
    expect((await settingsOf(B))!.auto_start_attempted_at, "a closed link claims nothing").toBeNull();
    // Withdrawn for real: the live session runs on.
    await withdrawCourtStream(day.auth, linkId);
    expect(await sessionRow(sidA)).toMatchObject({ state: "live", end_reason: null });
    // Positive control, on a link open in the same facts: the handover IS due, so link_closed above was the guard's answer.
    await sql`update court_stream_links set withdrawn_at = null, withdrawn_by = null where id = ${linkId}`;
    const fired = await run(live, clock());
    expect(fired).toMatchObject({ fired: true, endedSids: [sidA] });
  });

  it("the YouTube connection revoked: refused no_destination, stored on A, the beat answers 200; retried only on the spacing (R7)", async () => {
    await streamOn(A);
    await markReconnectNeeded(sql, day.orgId, connectionId);
    await kickoff(A, 0);
    expect((await beat(P)).state).toBe("waiting");
    const first = (await settingsOf(A))!;
    expect(first).toMatchObject({ auto_start_refusal: "no_destination", auto_started_at: null });
    expect(first.auto_start_attempted_at?.getTime()).toBe(at(0).getTime());
    expect(await sessionsOf(A)).toEqual([]);
    // R7: 59 s later the beat makes no second attempt.
    now += (AUTO_START_RETRY_SECONDS - 1) * SEC;
    expect((await beat(P)).state).toBe("waiting");
    expect((await settingsOf(A))!.auto_start_attempted_at?.getTime(), "no attempt inside the spacing").toBe(at(0).getTime());
    // At the spacing, one more attempt (still refused).
    now += SEC;
    expect((await beat(P)).state).toBe("waiting");
    const second = (await settingsOf(A))!;
    expect(second.auto_start_attempted_at?.getTime()).toBe(now);
    expect(second.auto_start_refusal).toBe("no_destination");
    expect(await consumeRows(day.orgId)).toEqual([]);
  });

  it("the link's target archived after linking: refused no_destination, stored", async () => {
    await streamOn(A);
    await sql`update org_stream_targets set archived_at = now() where id = ${targetId}`;
    await kickoff(A, 0);
    expect((await beat(P)).state).toBe("waiting");
    expect(await settingsOf(A)).toMatchObject({ auto_start_refusal: "no_destination", auto_started_at: null });
    expect(await sessionsOf(A)).toEqual([]);
  });

  it("zero credits: refused no_credit, stored on B; A's tail is NOT stopped", async () => {
    await streamOn(B);
    const sidA = await aLive();
    await drain();
    atMin(11);
    await kickoff(B, 11);   // a newer kick-off than A's: the handover is due
    const ans = await beat(P, { sid: sidA, state: "publishing" });
    expect(ans).toMatchObject({ state: "live", sid: sidA });
    expect(await settingsOf(B)).toMatchObject({ auto_start_refusal: "no_credit", auto_started_at: null });
    expect(await sessionsOf(B)).toEqual([]);
    expect(await sessionRow(sidA)).toMatchObject({ state: "live", end_reason: null });
    expect(await handoverEvents(sidA)).toEqual([]);
    expect(await activeOfLink()).toEqual([sidA]);
    expect((await consumeRows(day.orgId)).map((r) => r.session_id), "no credit taken for the refused start").toEqual([sidA]);
  });

  it("a streamed match with no players entered starts, labelled 'Match {n}' in the org's locale", async () => {
    await sql`update fixtures set home_entrant_id = null, away_entrant_id = null where id = ${C}`;
    const [{ fixture_no, default_locale }] = await sql<{ fixture_no: number; default_locale: string | null }[]>`
      select f.fixture_no, o.default_locale from fixtures f join organizations o on o.id = f.org_id where f.id = ${C}`;
    expect(default_locale ?? "en", "premise: the org reads English").toBe("en");
    await streamOn(C);
    await kickoff(C, 0);
    const ans = await kick();
    // en/ui.json "breadcrumb.match": "Match {no}"
    expect(ans).toMatchObject({ state: "go-live", startedBy: "automatic", label: `Match ${fixture_no}` });
  });

  it("the same phone rescanning the court code (claim resume) keeps its pairing and its live session", async () => {
    const sidA = await aLive();
    const [before] = await pairingOf(P);
    now += SEC;
    const ans = await beat(P, { claim: "resume", sid: sidA, state: "publishing" });
    expect(ans).toMatchObject({ state: "live", sid: sidA });
    const after = await pairingOf(P);
    expect(after).toEqual([{ id: before!.id, ended_at: null }]);
    expect(await sessionRow(sidA)).toMatchObject({ state: "live", pairing_id: before!.id });
    expect(await sessionsOf(A)).toHaveLength(1);
  });
});
