// Court stream (spec seazn.club.capture docs/specs/2026-11-14-court-stream-design.md §5.3–§5.4, §6.1; plan Task 7): the
// phone's calls on a COURT code — the descriptor, the beat, the operator's start and the record — and the two seams every
// court start shares: `startBroadcast`'s court-link guard and `endOtherCourtSessions`. Real Postgres; skipped without
// DATABASE_URL. Everything runs through the REAL code: the link is minted by `linkCourtStream`, the channel is connected
// through the real save (`_connect-rig`), a start goes through `startBroadcast` against a FakeYouTube and FakeIngest.
//
// The rules under test, typed here from the brief and the spec, never imported from the code under test:
//   - a court descriptor carries `court: {name}`; idle it is the court's own waiting shape (label = the court's name, no
//     stage, no scheduledStart, autoAllowed true, the LINK's destination); with a match to stream, that match's fields;
//   - its shape follows the court's CURRENT session only, and never answers completed or failed;
//   - a court beat answer carries `next` {label, scheduledStart} when a streamed match waits; a fixture code's never does;
//   - the court phone's `stopped: X` ends X operator_stopped AND latches X's match; the pairing stays (§5.4, §6.3);
//   - the operator's start streams the court's in-play match to the LINK's target, cause operator, court_link_id set;
//   - O13: a claim from a build older than COURT_MIN_APP_VERSION is refused with no pairing — court device check (2026-11-19,
//     finding A): 426 app_outdated, its own answer, never the unknown code's (401 code_ended) or a malformed one's (404);
//   - R4 (controller): a session ended by a handover latches its match while it is still in play;
//   - web batch A1 (2026-11-17): while the court's link is live (not withdrawn, its day open) the court phone is never told to
//     beat slower than the near cadence (10 s), idle or with a match far off; a withdrawn link keeps the fixture's rules;
//   - web batch A3: a withdrawn court serves its live session's phone, and once that session is no longer streaming (ending or
//     ended) the phone's next beat is 401 code_ended and its pairing ends; a withdrawn court that never went live is 401 at once;
//   - web batch A4 (O17, owner 2026-11-17: "switching Stream off should stop the video now"): the match's Stream switch OFF
//     ends its court session at once as the organiser's Stop (end reason stopped), and latches the match.
//
// The link is for 2026-11-07, the seed's T0 day (Europe/Amsterdam, UTC+1): every clock is the test's, passed in.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { hashDeviceLinkToken } from "../device-links";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { CaptureRefusalError } from "@/server/api-v1/capture-http";
import { CaptureBeat, CaptureBeatAnswer, CaptureDescriptor, CaptureScoringLinkOk } from "@/server/api-v1/capture-schemas";
import { POLL_FAR_SECONDS, POLL_NEAR_SECONDS } from "@/server/relay/config";
import { tokenTag } from "@/server/relay/domain/capture-record";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { rigApiTarget, rigUser } from "@/server/relay/__tests__/_session-rig";
import { connect } from "@/server/youtube/__tests__/_connect-rig";
import { FakeYouTube } from "@/server/youtube/fake";
import { getCode, postBeat, postScoringLink, postStart } from "../capture-phone";
import { courtCommon } from "../capture-court";
import { courtFocusOf } from "../court-stream-codes";
import { postCaptureRecord } from "../capture-record";
import { captureStageOf } from "../capture-stage";
import { linkCourtStream, setCourtStream, withdrawCourtStream } from "../court-streams";
import { endOtherCourtSessions } from "../court-stream-sessions";
import { reissueStreamCode, resolveAnyStreamCode } from "../stream-codes";
import { grantCredits } from "../stream-credits";
import { startBroadcast, stopSession, tickSession, type SessionDeps } from "../stream-sessions";
import { captureRig, override, phoneId } from "./_capture-rig";
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
});
beforeEach(() => { process.env.COURT_MIN_APP_VERSION = "1.0.14-1200"; });
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
/** 14:00 in Amsterdam on the link's day is 13:00Z, 180 minutes after T0 (10:00Z). */
const AT_14 = 180;
const AT_15 = 240;
const epochS = (d: Date) => Math.floor(d.getTime() / 1000);

type Beat = CaptureBeat;
type Answer = CaptureBeatAnswer;

/** "<http status>:<code>" for a capture refusal; anything else is rethrown. */
const refusal = (p: Promise<unknown>): Promise<string> =>
  p.then((v) => { throw new Error(`expected a refusal, got ${JSON.stringify(v)}`); }, (e: unknown) => {
    if (e instanceof CaptureRefusalError) return `${e.status}:${e.code}`;
    throw e;
  });

describe.skipIf(!HAS_DB)("a court code's descriptor, beat, start and record", () => {
  let day: Day;
  let A: string; let B: string; let C: string;
  let targetId: string;
  let linkId: string;
  let qr: { code: string; tok: string };
  let codeId: string;
  let now: number;
  let deps: SessionDeps;

  beforeEach(async () => {
    day = await seedDay();
    [A, B, C] = day.comp.fixtures.map((f) => f.id) as [string, string, string];
    await override(day.orgId, "streaming.relay", true);
    await override(day.orgId, "streaming.overlay", true);
    await grantCredits({ orgId: day.orgId, delta: 5, createdBy: await rigUser(), note: "court capture", idempotencyKey: randomUUID() });
    const c = await connect({ auth: day.auth, orgId: day.orgId, userId: day.auth.userId! });
    targetId = c.targetId;
    await sql`update org_stream_targets set label = 'API rig' where id = ${targetId}`;
    now = at(0).getTime();
    const ingest = new FakeIngest({ clock: () => now, connectAfterMs: 3000 });
    ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
    deps = {
      drivers: { ingest, runner: new FakeRunner() }, now: () => new Date(now), appUrl: "http://app.test",
      youtube: new FakeYouTube({ now: () => new Date(now) }),
    };
    const shown = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId, day: DAY }, at(0));
    qr = { code: shown.qr!.code, tok: shown.qr!.tok };
    linkId = shown.id;
    codeId = (await sql<{ id: string }[]>`select id from fixture_stream_codes where court_link_id = ${linkId}`)[0]!.id;
  });

  const clock = () => new Date(now);
  const body = (phone: string, over: Partial<Beat> = {}): Beat => CaptureBeat.parse({
    code: qr.code, slot: 0, phone, claim: null, device: null, sid: null, at: clock().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: COURT_BUILD, ...over,
  });
  const beat = async (phone: string, over: Partial<Beat> = {}): Promise<Answer> => {
    const a = await postBeat(qr.code, qr.tok, body(phone, over), deps, clock());
    expect(CaptureBeatAnswer.parse(a)).toEqual(a);
    return a;
  };
  const describeAs = async (phone: string | null) => {
    const d = await getCode(qr.code, qr.tok, { slot: 0, phone }, deps, clock());
    expect(CaptureDescriptor.parse(d)).toEqual(d);
    return d;
  };
  /** A match on Court 2 at `minutes`, its Stream switch on. */
  const streamed = async (fixtureId: string, minutes: number) => {
    await place(day, fixtureId, minutes, day.courts.c2);
    await setCourtStream(day.auth, fixtureId, true, at(0));
  };
  const claimed = async (phone: string) => { await beat(phone, { claim: "new" }); };
  const sessionRow = async (sid: string) => (await sql<{
    state: string; end_reason: string | null; court_link_id: string | null; target_id: string; start_cause: string; code_id: string | null;
    pairing_id: string | null; fixture_id: string;
  }[]>`select state, end_reason, court_link_id, target_id, start_cause, code_id, pairing_id, fixture_id from fixture_stream_sessions where id = ${sid}`)[0]!;
  const latchedAt = async (fixtureId: string) =>
    (await sql<{ at: Date | null }[]>`select auto_start_blocked_at as at from fixture_stream_settings where fixture_id = ${fixtureId}`)[0]?.at ?? null;
  const pairingOf = async (phone: string) =>
    (await sql<{ id: string; ended_at: Date | null }[]>`select id, ended_at from fixture_stream_pairings where code_id = ${codeId} and phone = ${phone}`);
  const sessionsOf = async (fixtureId: string) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${fixtureId}`)[0]!.n;
  /** The court phone's own start of the court's in-play match (Automatic off). */
  const operatorStart = async (phone: string) => (await postStart(qr.code, qr.tok, { phone }, deps, clock())).sid;

  it("descriptor on a court with nothing streamed: waiting, label 'Court 2', court {name:'Court 2'}, no scheduledStart, no stage", async () => {
    const phone = phoneId("idle");
    await claimed(phone);
    const d = await describeAs(phone);
    expect(d).toMatchObject({
      state: "waiting", label: "Court 2", court: { name: "Court 2" }, autoAllowed: true, destinationName: "API rig",
      overlayUrl: null, pollSeconds: POLL_NEAR_SECONDS, venueTimezone: "Europe/Amsterdam", code: qr.code,
      heartbeatUrl: `http://app.test/api/v1/capture/codes/${qr.code}/beats`, startUrl: `http://app.test/api/v1/capture/codes/${qr.code}/start`,
    });
    expect(d).not.toHaveProperty("stage");
    expect(d).not.toHaveProperty("scheduledStart");
    // With no phone too: the same idle court.
    expect(await describeAs(null)).toEqual(d);
    // The beat answer: waiting on the court, no next.
    const a = await beat(phone);
    expect(a).toMatchObject({ state: "waiting", label: "Court 2", autoAllowed: true, destinationName: "API rig", scheduledStart: null });
    expect(a).not.toHaveProperty("next");
  });

  it("E1: an archived target (a disconnected channel) is no destination — null on the descriptor and the beat; the live target names itself", async () => {
    await streamed(A, AT_14);
    const phone = phoneId("e1");
    await claimed(phone);
    expect(await describeAs(phone), "premise: live target").toMatchObject({ destinationName: "API rig" });
    expect(await beat(phone)).toMatchObject({ destinationName: "API rig" });
    await sql`update org_stream_targets set archived_at = now(), label = 'YouTube channel (disconnected)' where id = ${targetId}`;
    expect((await describeAs(phone)).destinationName).toBeNull();
    expect((await beat(phone)).destinationName).toBeNull();
    // The idle court (no match) says the same.
    await sql`update fixture_stream_settings set court_stream = false where fixture_id = ${A}`;
    expect((await describeAs(null)).destinationName).toBeNull();
  });

  it("E2: a stored refusal word is told to the court phone, on the waiting descriptor and beat only; cleared with the refusal; never on a session shape or a fixture code", async () => {
    await streamed(A, AT_14);
    await setStatus(A, "in_play");
    const phone = phoneId("e2");
    await claimed(phone);
    expect(await describeAs(phone), "premise: none").not.toHaveProperty("autoRefusal");
    expect(await beat(phone)).not.toHaveProperty("autoRefusal");
    for (const word of ["no_destination", "no_credit", "not_entitled", "destination_in_use", "unavailable"]) {
      await sql`update fixture_stream_settings set auto_start_refusal = ${word}, auto_start_attempted_at = ${at(0)} where fixture_id = ${A}`;
      expect(await describeAs(phone), word).toMatchObject({ state: "waiting", autoRefusal: word });
      expect(await beat(phone), word).toMatchObject({ state: "waiting", autoRefusal: word });
    }
    // competition_frozen is derived from a stored not_entitled, never stored.
    await sql`update fixture_stream_settings set auto_start_refusal = 'not_entitled' where fixture_id = ${A}`;
    const spy = vi.spyOn(await import("../entitlement-freeze"), "frozenCompetitionIds").mockResolvedValue(new Set([day.comp.id]));
    expect(await describeAs(phone)).toMatchObject({ autoRefusal: "competition_frozen" });
    expect(await beat(phone)).toMatchObject({ autoRefusal: "competition_frozen" });
    spy.mockRestore();
    // Cleared when the refusal clears.
    await sql`update fixture_stream_settings set auto_start_refusal = null where fixture_id = ${A}`;
    expect(await describeAs(phone)).not.toHaveProperty("autoRefusal");
    expect(await beat(phone)).not.toHaveProperty("autoRefusal");
    // A session open: never on the answer (a stale word on a match that now streams is settled).
    await sql`update fixture_stream_settings set auto_start_refusal = 'unavailable', auto_start_attempted_at = ${at(0)} where fixture_id = ${A}`;
    const sid = await operatorStart(phone);
    now += 3000;
    await tickSession(sid, deps, "beat");
    expect(await describeAs(phone)).not.toHaveProperty("autoRefusal");
    expect(await beat(phone, { sid, state: "publishing" })).not.toHaveProperty("autoRefusal");
  });

  it("E2/M1: a refusal stored against a match that is no longer the court's start is not told (latched A, B waiting)", async () => {
    await streamed(A, AT_14);
    await streamed(B, AT_15);
    await setStatus(A, "in_play");
    const phone = phoneId("m1");
    await claimed(phone);
    await sql`update fixture_stream_settings set auto_start_refusal = 'no_credit', auto_start_attempted_at = ${at(0)} where fixture_id = ${A}`;
    expect(await describeAs(phone), "premise: A is the start").toMatchObject({ autoRefusal: "no_credit" });
    await sql`update fixture_stream_settings set auto_start_blocked_at = now() where fixture_id = ${A}`;
    // The stale no_credit is never told; finding B (2026-11-19): latched A is the court's only match in play, so it says why.
    expect(await describeAs(phone)).toMatchObject({ autoRefusal: "match_stopped" });
    expect(await beat(phone)).toMatchObject({ autoRefusal: "match_stopped" });
  });

  it("E2: while a start is in flight (startingFixtureId) the stored word is not told; without it, it is", async () => {
    await streamed(A, AT_14);
    await streamed(B, AT_15);
    await setStatus(A, "in_play");
    await sql`update fixture_stream_settings set auto_start_refusal = 'unavailable', auto_start_attempted_at = ${at(0)} where fixture_id = ${A}`;
    const resolved = await resolveAnyStreamCode(qr.code, qr.tok, "get", null, clock());
    if (resolved.kind !== "court") throw new Error("premise: a court code");
    const view = await courtFocusOf(resolved.link);
    const common = (starting: string | null) => courtCommon(resolved, qr.code, view, { open: null, themeId: null }, deps, clock(), starting);
    expect((await common(null)).autoRefusal, "premise").toBe("unavailable");
    expect((await common(B)).autoRefusal).toBeNull();
  });

  it("A switched on, planned 14:00: descriptor label A's, beat next {label: A's, scheduledStart: 14:00 epoch s}", async () => {
    await streamed(A, AT_14);
    const phone = phoneId("next");
    await claimed(phone);
    const fxA = day.comp.fixtures[0]!;
    const d = await describeAs(phone);
    expect(d).toMatchObject({
      state: "waiting", label: labelOf(day.comp, fxA), scheduledStart: epochS(at(AT_14)), court: { name: "Court 2" },
      autoAllowed: true, destinationName: "API rig",
    });
    expect(d.stage).toEqual((await captureStageOf(day.orgId, A)) ?? undefined);
    const a = await beat(phone);
    expect(a.next).toEqual({ label: labelOf(day.comp, fxA), scheduledStart: epochS(at(AT_14)) });
    expect(a).toMatchObject({ state: "waiting", label: labelOf(day.comp, fxA), scheduledStart: epochS(at(AT_14)) });
  });

  it("A live: descriptor is A's session shape with cred to the court phone only, A's stage", async () => {
    await streamed(A, AT_14);
    await streamed(B, AT_15);
    await setStatus(A, "in_play");
    const phone = phoneId("live");
    await claimed(phone);
    const sid = await operatorStart(phone);
    now += 3000;
    await tickSession(sid, deps, "beat");
    expect((await sessionRow(sid)).state, "premise: A's session went live").toBe("live");

    const mine = await describeAs(phone);
    expect(mine).toMatchObject({ state: "live", sid, label: labelOf(day.comp, day.comp.fixtures[0]!), court: { name: "Court 2" }, destinationName: "API rig" });
    expect(mine).toHaveProperty("cred");
    expect(mine.stage).toEqual((await captureStageOf(day.orgId, A)) ?? undefined);
    const other = await describeAs(phoneId("stranger"));
    expect(other).toMatchObject({ state: "live", sid });
    expect(other).not.toHaveProperty("cred");
    // The beat from the phone that holds it: live on A's sid, and `next` names B.
    const a = await beat(phone, { sid, state: "publishing" });
    expect(a).toMatchObject({ state: "live", sid, label: labelOf(day.comp, day.comp.fixtures[0]!) });
    expect(a.next).toEqual({ label: labelOf(day.comp, day.comp.fixtures[1]!), scheduledStart: epochS(at(AT_15)) });
  });

  it("after A's session completed, nothing open: descriptor is WAITING on B (next), never completed A", async () => {
    await streamed(A, AT_14);
    await streamed(B, AT_15);
    await setStatus(A, "in_play");
    const phone = phoneId("after");
    await claimed(phone);
    const sid = await operatorStart(phone);
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', ended_at = ${clock()} where id = ${sid}`;
    await sql`update fixtures set status = 'decided', finished_at = ${clock()} where id = ${A}`;
    const d = await describeAs(phone);
    expect(d.state).toBe("waiting");
    expect(d).toMatchObject({ label: labelOf(day.comp, day.comp.fixtures[1]!), scheduledStart: epochS(at(AT_15)), court: { name: "Court 2" } });
    expect(d).not.toHaveProperty("sid");
  });

  it("a fixture code's descriptor and beat answer carry no court and no next", async () => {
    const r = await captureRig();
    const phone = phoneId("fixture");
    // E2: a stored refusal on the fixture itself is never told on a fixture code.
    await sql`insert into fixture_stream_settings (fixture_id, org_id, auto_start_refusal, auto_start_attempted_at)
              values (${r.fixtureId}, ${r.auth.orgId}, 'no_credit', now()) on conflict (fixture_id) do update set auto_start_refusal = 'no_credit'`;
    const a = await postBeat(r.code, r.tok, CaptureBeat.parse({ ...body(phone, { claim: "new" }), code: r.code, appVersion: "1.0.13-1150" }), r.deps, r.now());
    expect(a.state).toBe("waiting");
    expect(a).not.toHaveProperty("autoRefusal");
    expect(a).not.toHaveProperty("next");
    const d = await getCode(r.code, r.tok, { slot: 0, phone }, r.deps, r.now());
    expect(d).not.toHaveProperty("court");
    expect(d).not.toHaveProperty("autoRefusal");
  });

  it("the first beat claims the court code; a second phone's new claim on a silent holder takes over (A9)", async () => {
    const first = phoneId("first");
    const second = phoneId("second");
    expect((await beat(first, { claim: "new" })).state).toBe("waiting");
    expect((await pairingOf(first))[0]).toMatchObject({ ended_at: null });
    now += 10 * 60_000;
    expect((await beat(second, { claim: "new" })).state).toBe("waiting");
    expect((await pairingOf(first))[0]!.ended_at).not.toBeNull();
    expect((await pairingOf(second))[0]).toMatchObject({ ended_at: null });
    expect((await beat(first)).state).toBe("replaced");
  });

  it("stopped: X from the court phone ends X operator_stopped and latches X's match; the pairing stays", async () => {
    await streamed(A, AT_14);
    await setStatus(A, "in_play");
    const phone = phoneId("stop");
    await claimed(phone);
    const sid = await operatorStart(phone);
    expect(await latchedAt(A), "premise: A is not latched before the Stop").toBeNull();
    const a = await beat(phone, { stopped: sid });
    // operator_stopped is "stopped" on the wire (end-reason.ts: only the phone that stopped it ever names this sid).
    expect(a).toMatchObject({ state: "over", sid, endReason: "stopped" });
    expect((await sessionRow(sid)).end_reason).toBe("operator_stopped");
    expect(await latchedAt(A)).not.toBeNull();
    expect((await pairingOf(phone))[0]).toMatchObject({ ended_at: null });
  });

  // Court device check (2026-11-19, finding B; controller ruling): an explicit human start clears the latch; Automatic never does.
  it("finding B: a latched match — the court says match_stopped; Automatic (beat after beat, past the retry spacing) starts nothing; the phone's own Go live hold starts it, clears the latch, and the word goes", async () => {
    await streamed(A, AT_14);
    await setStatus(A, "in_play");
    const phone = phoneId("latched");
    await claimed(phone);
    const first = await operatorStart(phone);
    await beat(phone, { stopped: first });
    expect(await latchedAt(A), "premise: the court phone's Stop latched A").not.toBeNull();
    expect(await sessionsOf(A)).toBe(1);
    // The court's waiting answer says why nothing starts, on the descriptor and the beat.
    expect(await describeAs(phone)).toMatchObject({ state: "waiting", autoRefusal: "match_stopped" });
    expect(await beat(phone)).toMatchObject({ state: "waiting", autoRefusal: "match_stopped" });
    // Automatic: no human, so never a restart — over several beats spread past any retry spacing.
    for (let i = 0; i < 4; i++) {
      now += 90_000;
      expect((await beat(phone, { mode: "automatic" })).state, `automatic beat ${i}`).toBe("waiting");
    }
    expect(await sessionsOf(A), "Automatic started nothing").toBe(1);
    expect(await latchedAt(A), "Automatic left the latch").not.toBeNull();
    // The phone's own Go live hold is a person's start: it starts A, on the link's target, and clears the latch.
    const again = await operatorStart(phone);
    expect(await sessionRow(again)).toMatchObject({ fixture_id: A, target_id: targetId, start_cause: "operator", court_link_id: linkId });
    expect(await latchedAt(A), "the human start cleared the latch").toBeNull();
    expect(await beat(phone, { sid: again, state: "armed", cause: "operator" })).not.toHaveProperty("autoRefusal");
  });

  it("finding B: the hold prefers the court's own (unlatched) match, and the word is not told while one exists", async () => {
    const phone = phoneId("prefer");
    await claimed(phone);
    await streamed(A, AT_14);
    await streamed(B, AT_14 + 30);
    await setStatus(A, "in_play");
    await setStatus(B, "in_play");
    await sql`update fixture_stream_settings set auto_start_blocked_at = ${at(0)} where fixture_id = ${A}`;
    expect(await describeAs(phone), "an unlatched candidate: no match_stopped").not.toHaveProperty("autoRefusal");
    const sid = await operatorStart(phone);
    expect((await sessionRow(sid)).fixture_id, "B, the court's own, not latched A").toBe(B);
    expect(await latchedAt(A), "A's latch is not touched by B's start").not.toBeNull();
  });

  it("a REPLACED court phone's stale stopped: X ends X (T24a) but never latches its match (fix M1)", async () => {
    await streamed(A, AT_14);
    await setStatus(A, "in_play");
    const old = phoneId("stale");
    await claimed(old);
    const sid = await operatorStart(old);
    // The old phone is replaced by a new one, and X is held by no current pairing (T24a: a stop from anyone applies).
    const [mine] = await pairingOf(old);
    await sql`update fixture_stream_pairings set ended_at = ${clock()}, end_cause = 'replaced' where id = ${mine!.id}`;
    await sql`insert into fixture_stream_pairings (org_id, code_id, slot, phone, claim_kind, claimed_at, last_beat_at, answered_poll_seconds)
              values (${day.orgId}, ${codeId}, 0, ${phoneId("new")}, 'new', ${clock()}, ${clock()}, 60)`;
    await sql`update fixture_stream_sessions set pairing_id = null where id = ${sid}`;
    const a = await beat(old, { stopped: sid });
    expect(a.state).toBe("replaced");
    expect((await sessionRow(sid)).end_reason, "premise: the stale stop still ends X").toBe("operator_stopped");
    expect(await latchedAt(A)).toBeNull();
  });

  it("a fixture code's stopped: X does NOT stamp auto_start_blocked_at (unchanged)", async () => {
    const r = await captureRig({ credits: 2 });
    const phone = phoneId("fixture-stop");
    const sid = await r.start(phone);
    const a = await postBeat(r.code, r.tok, CaptureBeat.parse({ ...body(phone, { stopped: sid }), code: r.code, at: r.now().toISOString() }), r.deps, r.now());
    expect(a).toMatchObject({ state: "over", sid });
    expect((await sessionRow(sid)).end_reason).toBe("operator_stopped");
    expect(await latchedAt(r.fixtureId)).toBeNull();
  });

  it("operator start with Automatic off and A in play: starts A on the link's target, cause operator, court_link_id set", async () => {
    await streamed(A, AT_14);
    await setStatus(A, "in_play");
    const phone = phoneId("start");
    await claimed(phone);
    const sid = await operatorStart(phone);
    const [pairing] = await pairingOf(phone);
    expect(await sessionRow(sid)).toMatchObject({
      fixture_id: A, target_id: targetId, start_cause: "operator", court_link_id: linkId, code_id: codeId, pairing_id: pairing!.id,
    });
  });

  it("operator start with nothing in play is 409 no_match; with A open is 409 already_live naming A's sid", async () => {
    const phone = phoneId("refused");
    await claimed(phone);
    expect(await refusal(operatorStart(phone))).toBe("409:no_match");
    await streamed(A, AT_14);
    expect(await refusal(operatorStart(phone)), "a match not yet in play is never started by the hold").toBe("409:no_match");
    await setStatus(A, "in_play");
    const sid = await operatorStart(phone);
    const again = await postStart(qr.code, qr.tok, { phone }, deps, clock()).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(CaptureRefusalError);
    expect(again).toMatchObject({ status: 409, code: "already_live", extras: { sid, startedBy: "operator" } });
    expect(await refusal(postStart(qr.code, qr.tok, { phone: phoneId("not-current") }, deps, clock()))).toBe("409:replaced");
  });

  it("final review m-1: a court code for a later day starts nothing today — the phone's start is 409 no_match and startBroadcast itself refuses the pairing; the same call inside the day starts", async () => {
    const phone = phoneId("future-day");
    await claimed(phone);
    await streamed(A, 0);
    await setStatus(A, "in_play");
    const [pairing] = await pairingOf(phone);
    const actor = { userId: day.auth.userId!, orgId: day.orgId, source: "phone" as const, pairingId: pairing!.id };
    const opts = { targetId, startCause: "operator" as const, phone: "present" as const, mode: "passthrough" as const, courtLinkId: linkId };
    // The link's day is tomorrow: the phone has scanned today's printout of a code for a later day.
    await sql`update court_stream_links set opens_at = opens_at + interval '1 day', expires_at = expires_at + interval '1 day' where id = ${linkId}`;
    expect(await refusal(operatorStart(phone))).toBe("409:no_match");
    await expect(startBroadcast(actor, A, opts, deps)).rejects.toThrow(/is not on fixture .*'s court link \(the link's day is not open\)/);
    expect(await sessionsOf(A), "nothing was written").toBe(0);
    // Positive control: the day brought back to now — the same phone, match and call start.
    await sql`update court_stream_links set opens_at = opens_at - interval '1 day', expires_at = expires_at - interval '1 day' where id = ${linkId}`;
    const sid = await operatorStart(phone);
    expect(await sessionRow(sid)).toMatchObject({ fixture_id: A, court_link_id: linkId });
  });

  it("startBroadcast refuses a court pairing for a fixture on another court, with the switch off, on a withdrawn link, or with another targetId", async () => {
    const phone = phoneId("guard");
    await claimed(phone);
    const [pairing] = await pairingOf(phone);
    const actor = { userId: day.auth.userId!, orgId: day.orgId, source: "phone" as const, pairingId: pairing!.id };
    const opts = { targetId, startCause: "operator" as const, phone: "present" as const, mode: "passthrough" as const, courtLinkId: linkId };
    const courtLinkRefusal = /is not on fixture .*'s court link/;

    // Another court: C is on Court 1, its switch written on by hand (no link there to switch it on through).
    await place(day, C, AT_14, day.courts.c1);
    await sql`insert into fixture_stream_settings (fixture_id, org_id, court_stream) values (${C}, ${day.orgId}, true)`;
    await expect(startBroadcast(actor, C, opts, deps)).rejects.toThrow(courtLinkRefusal);
    // The switch off: A on Court 2, never switched on.
    await place(day, A, AT_14, day.courts.c2);
    await expect(startBroadcast(actor, A, opts, deps)).rejects.toThrow(courtLinkRefusal);
    // Another target: A switched on, the right court, a target that is not the link's.
    await setCourtStream(day.auth, A, true, at(0));
    const other = await rigApiTarget(day.orgId, "Other channel");
    await expect(startBroadcast(actor, A, { ...opts, targetId: other.targetId }, deps)).rejects.toThrow(courtLinkRefusal);
    // Another link id than the pairing's code's.
    await expect(startBroadcast(actor, A, { ...opts, courtLinkId: randomUUID() }, deps)).rejects.toThrow(courtLinkRefusal);
    // A court pairing with no courtLinkId at all: today's guard, the fixture's own code.
    await expect(startBroadcast(actor, A, { targetId, startCause: "operator", phone: "present", mode: "passthrough" }, deps))
      .rejects.toThrow(/is not on fixture .*'s stream code/);
    // Withdrawn.
    await withdrawCourtStream(day.auth, linkId);
    await expect(startBroadcast(actor, A, opts, deps)).rejects.toThrow(courtLinkRefusal);
    // Refused before anything was written.
    expect(await sessionsOf(A)).toBe(0);
    expect(await sessionsOf(C)).toBe(0);
  });

  it("startBroadcast admits a court pairing for its court's switched-on match on the link's target", async () => {
    await streamed(A, AT_14);
    const phone = phoneId("guard-ok");
    await claimed(phone);
    const [pairing] = await pairingOf(phone);
    const { sessionId } = await startBroadcast(
      { userId: day.auth.userId!, orgId: day.orgId, source: "phone", pairingId: pairing!.id }, A,
      { targetId, startCause: "operator", phone: "present", mode: "passthrough", courtLinkId: linkId }, deps,
    );
    expect(await sessionRow(sessionId)).toMatchObject({ court_link_id: linkId, code_id: codeId, pairing_id: pairing!.id });
  });

  it("O13: COURT_MIN_APP_VERSION=1.0.14-1200 → a 1.0.13-1150 court claim is 426 app_outdated, no pairing; 1.0.14-1200 and 1.0.15-1300 pair; a fixture code's 1.0.13-1150 claim pairs", async () => {
    const old = phoneId("old");
    expect(await refusal(postBeat(qr.code, qr.tok, body(old, { claim: "new", appVersion: "1.0.13-1150" }), deps, clock()))).toBe("426:app_outdated");
    expect(await pairingOf(old)).toHaveLength(0);
    // A resume claim is refused the same way, and so is a build with no count at all; one below the minimum by one build too.
    expect(await refusal(postBeat(qr.code, qr.tok, body(old, { claim: "resume", appVersion: "1.0.13-1150" }), deps, clock()))).toBe("426:app_outdated");
    expect(await refusal(postBeat(qr.code, qr.tok, body(old, { claim: "new", appVersion: "capture-test/1" }), deps, clock()))).toBe("426:app_outdated");
    expect(await refusal(postBeat(qr.code, qr.tok, body(old, { claim: "new", appVersion: "1.0.14-1199" }), deps, clock()))).toBe("426:app_outdated");
    expect(await pairingOf(old)).toHaveLength(0);
    // Finding A: the outdated build's answer is NOT the unknown code's — the same old build's claim on a code nobody issued is
    // 401 code_ended, and on a malformed one 404 not_a_stream_code — and its message carries neither the code nor the tok.
    const unknown = "zzzzzzzzzzzz";
    expect(await refusal(postBeat(unknown, qr.tok, CaptureBeat.parse({ ...body(old, { claim: "new", appVersion: "1.0.13-1150" }), code: unknown }), deps, clock()))).toBe("401:code_ended");
    const outdated = await postBeat(qr.code, qr.tok, body(old, { claim: "new", appVersion: "1.0.13-1150" }), deps, clock()).then(() => null, (e: unknown) => e);
    expect(outdated).toBeInstanceOf(CaptureRefusalError);
    for (const secret of [qr.code, qr.tok]) expect((outdated as Error).message.includes(secret), "no code or tok in the message").toBe(false);

    const same = phoneId("same");
    expect((await beat(same, { claim: "new", appVersion: "1.0.14-1200" })).state).toBe("waiting");
    expect(await pairingOf(same)).toHaveLength(1);
    now += 10 * 60_000;
    const newer = phoneId("newer");
    expect((await beat(newer, { claim: "new", appVersion: "1.0.15-1300" })).state).toBe("waiting");
    expect(await pairingOf(newer)).toHaveLength(1);

    const r = await captureRig();
    const fixturePhone = phoneId("fixture-old");
    const a = await postBeat(r.code, r.tok, CaptureBeat.parse({ ...body(fixturePhone, { claim: "new", appVersion: "1.0.13-1150" }), code: r.code }), r.deps, r.now());
    expect(a.state).toBe("waiting");
  });

  it("O13: an unset or malformed COURT_MIN_APP_VERSION admits no court claim (fail closed, 503 unavailable — the server's state, not the app's); a beat without a claim is not judged", async () => {
    const phone = phoneId("unset");
    await claimed(phone);
    for (const v of [undefined, "1.0.14", "latest"]) {
      if (v === undefined) delete process.env.COURT_MIN_APP_VERSION; else process.env.COURT_MIN_APP_VERSION = v;
      expect(await refusal(postBeat(qr.code, qr.tok, body(phoneId("x"), { claim: "new", appVersion: "9.9.9-99999" }), deps, clock())), String(v))
        .toBe("503:unavailable");
      expect((await beat(phone)).state, `an already-paired phone's beat is answered (${String(v)})`).toBe("waiting");
    }
  });

  it("a record upload on a court code is stored with fixture_id null and the code's id", async () => {
    // A device line is kept inside the window this code's own pair line opens (§6 A2: its tokenTag).
    const AT = "2026-11-07T10:00:00.000Z";
    const lines = [
      { at: AT, kind: "pair", claim: "new", slot: 0, tokenTag: tokenTag(qr.tok), message: "pair" },
      { at: AT, kind: "thermal", level: "warn", status: 3, message: "court" },
    ];
    const req = new Request("http://localhost/api/v1/capture/codes/x/records", {
      method: "POST", body: lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    });
    const ok = await postCaptureRecord(qr.code, qr.tok, req, clock());
    expect(ok).toMatchObject({ kept: 2, dropped: 0 });
    const [row] = await sql<{ fixture_id: string | null; code_id: string; competition_id: string; org_id: string }[]>`
      select fixture_id, code_id, competition_id, org_id from capture_records where ref = ${ok.ref}`;
    expect(row).toEqual({ fixture_id: null, code_id: codeId, competition_id: day.comp.id, org_id: day.orgId });
  });

  describe("web batch A1: the court's cadence while its link is live", () => {
    it("an idle linked court answers 10 s, descriptor and beat, and stores 10 s as the answered cadence", async () => {
      const phone = phoneId("a1-idle");
      const first = await beat(phone, { claim: "new" });
      expect(first).toMatchObject({ state: "waiting", pollSeconds: POLL_NEAR_SECONDS });
      expect((await beat(phone)).pollSeconds).toBe(POLL_NEAR_SECONDS);
      expect((await describeAs(phone)).pollSeconds).toBe(POLL_NEAR_SECONDS);
      const [p] = await sql<{ s: number }[]>`select answered_poll_seconds as s from fixture_stream_pairings where code_id = ${codeId} and phone = ${phone}`;
      expect(p!.s).toBe(POLL_NEAR_SECONDS);
    });

    it("a streamed match four hours off (a fixture code's 60 s) answers 10 s on the court", async () => {
      await streamed(A, AT_14);
      const phone = phoneId("a1-far");
      await claimed(phone);
      const a = await beat(phone);
      expect(a).toMatchObject({ state: "waiting", label: labelOf(day.comp, day.comp.fixtures[0]!), pollSeconds: POLL_NEAR_SECONDS });
      expect((await describeAs(phone)).pollSeconds).toBe(POLL_NEAR_SECONDS);
    });

    it("a withdrawn link, or one outside its day, keeps the fixture's cadence (60 s idle, 60 s for a far match)", async () => {
      const resolved = await resolveAnyStreamCode(qr.code, qr.tok, "get", null, clock());
      if (resolved.kind !== "court") throw new Error("premise: a court code");
      const common = async (c: typeof resolved, t: Date) =>
        (await courtCommon(c, qr.code, await courtFocusOf(c.link), { open: null, themeId: null }, deps, t)).pollSeconds;
      // Positive control: the same link, live, is capped.
      expect(await common(resolved, clock())).toBe(POLL_NEAR_SECONDS);
      expect(await common({ ...resolved, link: { ...resolved.link, withdrawnAt: clock() } }, clock())).toBe(POLL_FAR_SECONDS);
      expect(await common({ ...resolved, link: { ...resolved.link, opensAt: new Date(now + 1) } }, clock())).toBe(POLL_FAR_SECONDS);
      await streamed(A, AT_14);
      expect(await common(resolved, clock())).toBe(POLL_NEAR_SECONDS);
      expect(await common({ ...resolved, link: { ...resolved.link, withdrawnAt: clock() } }, clock())).toBe(POLL_FAR_SECONDS);
    });
  });

  describe("web batch A3: a withdrawn court releases its phone once the session stops streaming", () => {
    /** A in play, started by the court phone, live on the tick; then the link withdrawn. */
    const liveThenWithdrawn = async (phone: string) => {
      await streamed(A, AT_14);
      await setStatus(A, "in_play");
      await claimed(phone);
      const sid = await operatorStart(phone);
      now += 3000;
      await tickSession(sid, deps, "beat");
      expect((await sessionRow(sid)).state, "premise: A's session went live").toBe("live");
      await withdrawCourtStream(day.auth, linkId);
      // One clock: the withdrawal and the session's creation are database stamps (wall clock), its end the test's clock.
      // Put both on the test's day, as on a real day where every clock agrees.
      await sql`update fixture_stream_sessions set created_at = ${at(0)} where id = ${sid}`;
      await sql`update fixture_stream_codes set ended_at = ${clock()} where id = ${codeId}`;
      return sid;
    };

    it("withdrawn while live: the live session's phone is served; once the match ends and the session auto-stops, 401 code_ended", async () => {
      const phone = phoneId("a3-live");
      const sid = await liveThenWithdrawn(phone);
      expect(await beat(phone, { sid, state: "publishing", mode: "automatic" })).toMatchObject({ state: "live", sid });
      expect((await describeAs(phone)).state).toBe("live");
      // The result 1 s after the session (which predates it, A15), and the court's 30 s tail elapsed.
      await sql`update fixture_stream_sessions set created_at = ${at(0)} where id = ${sid}`;
      now += 1000;
      await setStatus(A, "decided");
      await sql`update fixtures set finished_at = ${clock()} where id = ${A}`;
      now += 31_000;
      expect(await beat(phone, { sid, state: "publishing", mode: "automatic" })).toMatchObject({ state: "over", sid, endReason: "auto_stopped" });
      now += 5000;
      expect(await refusal(postBeat(qr.code, qr.tok, body(phone, { mode: "automatic" }), deps, clock()))).toBe("401:code_ended");
      expect((await pairingOf(phone))[0]!.ended_at, "the refused beat ends the pairing").not.toBeNull();
    });

    it("withdrawn while live, the session lingering in ending (a composed teardown): the beat naming it hears over; the next one is 401 code_ended", async () => {
      const phone = phoneId("a3-ending");
      const sid = await liveThenWithdrawn(phone);
      expect((await beat(phone, { sid, state: "publishing" })).state, "premise: served while live").toBe("live");
      // The stop decided and the runner still tearing down: `ending` stays open (ACTIVE_STATES) until the runner reports.
      await sql`update fixture_stream_sessions set state = 'ending', end_reason = 'auto_stopped' where id = ${sid}`;
      now += 5000;
      // Fix round 1 (finding 1): the phone still names its session, so it hears `over` (never a 401 while it publishes).
      expect(await beat(phone, { sid, state: "publishing" })).toMatchObject({ state: "over", sid, endReason: "auto_stopped" });
      expect((await pairingOf(phone))[0]!.ended_at, "served: the pairing stands").toBeNull();
      now += 5000;
      expect(await refusal(postBeat(qr.code, qr.tok, body(phone), deps, clock()))).toBe("401:code_ended");
      expect(await refusal(getCode(qr.code, qr.tok, { slot: 0, phone }, deps, clock()))).toBe("401:code_ended");
      expect((await pairingOf(phone))[0]!.ended_at).not.toBeNull();
    });

    it("fix round 1: withdrawn while live, the desk's Stop lands between beats: the beat naming the session hears over stopped; the next beat without a sid is 401", async () => {
      const phone = phoneId("a3-desk-stop");
      const sid = await liveThenWithdrawn(phone);
      expect((await beat(phone, { sid, state: "publishing" })).state, "premise: served while live").toBe("live");
      now += 2000;
      await stopSession(day.auth, A, sid, deps);
      expect(["ending", "completed"], "premise: stopped outside a beat").toContain((await sessionRow(sid)).state);
      now += 5000;
      expect(await beat(phone, { sid, state: "publishing" })).toMatchObject({ state: "over", sid, endReason: "stopped" });
      now += 5000;
      expect(await refusal(postBeat(qr.code, qr.tok, body(phone), deps, clock()))).toBe("401:code_ended");
      expect((await pairingOf(phone))[0]!.ended_at).not.toBeNull();
    });

    it("fix round 1: a named session is served only to its own phone, and only when it stopped after the withdrawal", async () => {
      const phone = phoneId("a3-named");
      const sid = await liveThenWithdrawn(phone);
      now += 2000;
      await stopSession(day.auth, A, sid, deps);
      now += 5000;
      // Another phone naming that session: refused (it never held it).
      const stranger = phoneId("a3-stranger");
      expect(await refusal(postBeat(qr.code, qr.tok, body(stranger, { sid, state: "publishing" }), deps, clock()))).toBe("401:code_ended");
      // A session that had already stopped before the withdrawal: its name serves nothing.
      // (created at T0, stopped at T0+1 s, the code withdrawn at T0+2 s: everything else about the beat as above)
      await sql`update fixture_stream_sessions set ended_at = ${new Date(at(0).getTime() + 1000)} where id = ${sid}`;
      await sql`update fixture_stream_codes set ended_at = ${new Date(at(0).getTime() + 2000)} where id = ${codeId}`;
      expect(await refusal(postBeat(qr.code, qr.tok, body(phone, { sid, state: "publishing" }), deps, clock()))).toBe("401:code_ended");
    });

    it("withdrawn with nothing ever live: the court phone's next beat is 401 code_ended at once", async () => {
      const phone = phoneId("a3-never");
      await claimed(phone);
      expect((await beat(phone)).state, "premise: served before the withdrawal").toBe("waiting");
      await withdrawCourtStream(day.auth, linkId);
      expect(await refusal(postBeat(qr.code, qr.tok, body(phone), deps, clock()))).toBe("401:code_ended");
      expect((await pairingOf(phone))[0]!.ended_at).not.toBeNull();
    });

    it("a fixture code's reissued code still serves its ending session's phone (A3 is the court's only)", async () => {
      const r = await captureRig();
      const phone = phoneId("a3-fixture");
      const fbody = (over: Partial<Beat> = {}) => CaptureBeat.parse({ ...body(phone, over), code: r.code, appVersion: "1.0.13-1150" });
      const sid = await r.start(phone);
      // Stopping and still open, the code ended after the session began (a reissue): C1b serves its phone, as before A3.
      await sql`update fixture_stream_sessions set state = 'ending', end_reason = 'stopped', first_ingest_at = now() where id = ${sid}`;
      await reissueStreamCode(r.auth, r.fixtureId);
      const a = await postBeat(r.code, r.tok, fbody({ sid }), r.deps, r.now());
      expect(a).toMatchObject({ state: "over", sid });
    });

    it("fix round 2 (item 3): a fixture code reissued, its session then stopped outside a beat: the beat naming it hears over; the next one without a sid is 401", async () => {
      const r = await captureRig();
      const phone = phoneId("a3-fixture-stopped");
      const fbody = (over: Partial<Beat> = {}) => CaptureBeat.parse({ ...body(phone, over), code: r.code, appVersion: "1.0.13-1150" });
      const sid = await r.start(phone);
      await reissueStreamCode(r.auth, r.fixtureId);
      await stopSession(r.auth, r.fixtureId, sid, r.deps);
      expect((await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${sid}`)[0]!.state, "premise: stopped, nothing open").toBe("completed");
      // One clock (database stamps are the wall's): created T0, the code reissued at T0+1 s, the session stopped at T0+2 s.
      const t0 = r.now().getTime() - 60_000;
      const code = (await sql<{ id: string }[]>`select id from fixture_stream_codes where code = ${r.code}`)[0]!.id;
      await sql`update fixture_stream_sessions set created_at = ${new Date(t0)}, ended_at = ${new Date(t0 + 2000)} where id = ${sid}`;
      await sql`update fixture_stream_codes set ended_at = ${new Date(t0 + 1000)} where id = ${code}`;
      expect(await postBeat(r.code, r.tok, fbody({ sid, state: "publishing" }), r.deps, r.now())).toMatchObject({ state: "over", sid, endReason: "stopped" });
      expect(await refusal(postBeat(r.code, r.tok, fbody(), r.deps, r.now()))).toBe("401:code_ended");
    });
  });

  describe("web batch A4 (O17): the Stream switch off stops the match's court session now", () => {
    it("live: OFF ends it at once as the organiser's Stop (stopped), latches A, and the court never starts A again", async () => {
      await streamed(A, AT_14);
      await setStatus(A, "in_play");
      const phone = phoneId("a4-live");
      await claimed(phone);
      const sid = await operatorStart(phone);
      now += 3000;
      await tickSession(sid, deps, "beat");
      expect((await sessionRow(sid)).state, "premise: live").toBe("live");
      expect(await latchedAt(A), "premise: not latched").toBeNull();
      expect(await setCourtStream(day.auth, A, false, clock(), deps)).toEqual({ on: false });
      const row = await sessionRow(sid);
      expect(["ending", "completed"]).toContain(row.state);
      expect(row.end_reason).toBe("stopped");
      expect(await latchedAt(A)).not.toBeNull();
      // The phone hears the end on its next beat, and the operator's start finds nothing to start.
      expect(await beat(phone, { sid, state: "publishing" })).toMatchObject({ state: "over", sid, endReason: "stopped" });
      expect(await refusal(operatorStart(phone))).toBe("409:no_match");
      // Switched back on: still latched, so nothing restarts it by ITSELF (Automatic) — finding B (2026-11-19, controller ruling):
      // a person's start does, the phone's own hold among them, and it clears the latch.
      await setCourtStream(day.auth, A, true, clock());
      expect(await latchedAt(A), "the latch outlives the switch").not.toBeNull();
      now += 120_000;
      expect((await beat(phone, { mode: "automatic" })).state, "Automatic does not restart it").toBe("waiting");
      expect(await sessionsOf(A)).toBe(1);
      const again = await operatorStart(phone);
      expect((await sessionRow(again)).fixture_id).toBe(A);
      expect(await latchedAt(A), "the hold cleared it").toBeNull();
    });

    it("armed (warming) and requested: OFF ends it too", async () => {
      for (const state of ["warming", "requested"] as const) {
        const fx = state === "warming" ? A : B;
        await place(day, fx, AT_14, day.courts.c2);
        await setCourtStream(day.auth, fx, true, at(0));
        await setStatus(fx, "in_play");
        const phone = phoneId(`a4-${state}`);
        await claimed(phone);
        const sid = await operatorStart(phone);
        if (state === "requested") await sql`update fixture_stream_sessions set state = 'requested' where id = ${sid}`;
        expect((await sessionRow(sid)).state, `premise: ${state}`).toBe(state);
        await setCourtStream(day.auth, fx, false, clock(), deps);
        const row = await sessionRow(sid);
        expect(["ending", "completed", "failed"], state).toContain(row.state);
        expect(await latchedAt(fx), state).not.toBeNull();
        await sql`update fixtures set status = 'decided' where id = ${fx}`;
      }
    });

    it("OFF with no session stops nothing and latches nothing; another match's session runs on", async () => {
      await streamed(A, AT_14);
      await streamed(B, AT_15);
      await setStatus(A, "in_play");
      const phone = phoneId("a4-other");
      await claimed(phone);
      const sid = await operatorStart(phone);
      expect(await setCourtStream(day.auth, B, false, clock(), deps)).toEqual({ on: false });
      expect(await latchedAt(B)).toBeNull();
      expect((await sessionRow(sid)).end_reason).toBeNull();
      expect(["requested", "provisioning", "warming", "live"]).toContain((await sessionRow(sid)).state);
    });

    it("OFF that finds a session to stop without the relay's deps refuses rather than leave it running", async () => {
      await streamed(A, AT_14);
      await setStatus(A, "in_play");
      const phone = phoneId("a4-nodeps");
      await claimed(phone);
      const sid = await operatorStart(phone);
      await expect(setCourtStream(day.auth, A, false, clock())).rejects.toThrow(/no session deps/);
      expect((await sessionRow(sid)).end_reason).toBeNull();
    });
  });

  describe("endOtherCourtSessions (R4: a handover latches the ended match while it is still in play)", () => {
    /** A open, then B started over it on the same link (the handover's start-first order). */
    const twoOpen = async () => {
      await streamed(A, AT_14);
      await streamed(B, AT_15);
      await setStatus(A, "in_play");
      const phone = phoneId("handover");
      await claimed(phone);
      const a = await operatorStart(phone);
      await setStatus(B, "in_play");
      const [pairing] = await pairingOf(phone);
      const { sessionId: b } = await startBroadcast(
        { userId: day.auth.userId!, orgId: day.orgId, source: "phone", pairingId: pairing!.id }, B,
        { targetId, startCause: "automatic", phone: "present", mode: "passthrough", courtLinkId: linkId }, deps,
      );
      return { a, b };
    };
    const handoverEvents = async (sid: string) =>
      sql<{ payload: { to: string } }[]>`select payload from fixture_stream_events where session_id = ${sid} and type = 'court_handover'`;

    it("ends every other open session of the link auto_stopped, with a court_handover event naming the kept one; the kept one stays", async () => {
      const { a, b } = await twoOpen();
      const ended = await endOtherCourtSessions({ linkId, keepSid: b, actorUserId: day.auth.userId! }, deps);
      expect(ended).toEqual([a]);
      expect((await sessionRow(a)).end_reason).toBe("auto_stopped");
      expect(["ending", "completed"]).toContain((await sessionRow(a)).state);
      expect((await handoverEvents(a)).map((e) => e.payload)).toEqual([{ to: b }]);
      expect(["requested", "provisioning", "warming", "live"]).toContain((await sessionRow(b)).state);
      expect(await handoverEvents(b)).toHaveLength(0);
      // A second call ends nothing more.
      expect(await endOtherCourtSessions({ linkId, keepSid: b, actorUserId: day.auth.userId! }, deps)).toEqual([]);
      expect(await handoverEvents(a)).toHaveLength(1);
    });

    it("final review m-5: the handover's source is the phone's by default and the caller's when it names one (the desk's restart: client)", async () => {
      const { a, b } = await twoOpen();
      const trail = (sid: string) => sql<{ type: string; source: string }[]>`
        select type, source from fixture_stream_events where session_id = ${sid} and (type = 'court_handover' or (type = 'stop' and kind = 'action')) order by type`;
      await endOtherCourtSessions({ linkId, keepSid: b, actorUserId: day.auth.userId! }, deps);
      expect(await trail(a)).toEqual([{ type: "court_handover", source: "phone" }, { type: "stop", source: "phone" }]);
      // A second pair on the same link, ended with an explicit client source.
      await streamed(C, AT_15);
      await setStatus(C, "in_play");
      const [pairing] = await sql<{ id: string }[]>`select id from fixture_stream_pairings where code_id = ${codeId} order by claimed_at limit 1`;
      const { sessionId: c } = await startBroadcast(
        { userId: day.auth.userId!, orgId: day.orgId, source: "phone", pairingId: pairing!.id }, C,
        { targetId, startCause: "automatic", phone: "present", mode: "passthrough", courtLinkId: linkId }, deps,
      );
      expect(await endOtherCourtSessions({ linkId, keepSid: c, actorUserId: day.auth.userId!, source: "client" }, deps)).toEqual([b]);
      expect(await trail(b)).toEqual([{ type: "court_handover", source: "client" }, { type: "stop", source: "client" }]);
    });

    it("latches the ended session's match when it is still in play", async () => {
      const { a, b } = await twoOpen();
      await endOtherCourtSessions({ linkId, keepSid: b, actorUserId: day.auth.userId! }, deps);
      expect((await sessionRow(a)).fixture_id).toBe(A);
      expect(await latchedAt(A)).not.toBeNull();
      expect(await latchedAt(B)).toBeNull();
    });

    it("does not latch the ended session's match once it is decided", async () => {
      const { b } = await twoOpen();
      await sql`update fixtures set status = 'decided', finished_at = ${clock()} where id = ${A}`;
      await endOtherCourtSessions({ linkId, keepSid: b, actorUserId: day.auth.userId! }, deps);
      expect(await latchedAt(A)).toBeNull();
    });

    it("never ends a session NEWER than the kept one: of two racing starts the newest survives (fix I1)", async () => {
      const { a, b } = await twoOpen();
      expect(await endOtherCourtSessions({ linkId, keepSid: a, actorUserId: day.auth.userId! }, deps)).toEqual([]);
      expect(["requested", "provisioning", "warming", "live"]).toContain((await sessionRow(b)).state);
      expect(await handoverEvents(b)).toHaveLength(0);
      expect(await latchedAt(B)).toBeNull();
      expect(await endOtherCourtSessions({ linkId, keepSid: b, actorUserId: day.auth.userId! }, deps)).toEqual([a]);
    });

    it("never touches another link's sessions", async () => {
      const { a } = await twoOpen();
      expect(await endOtherCourtSessions({ linkId: randomUUID(), keepSid: a, actorUserId: day.auth.userId! }, deps)).toEqual([]);
    });
  });

  describe("the scoring link on a court code (§5.6)", () => {
    const savedLinkEnv = { base: process.env.OAUTH_BASE_URL, kek: process.env.DEVICE_LINK_KEK };
    let minted: string[];
    beforeEach(() => {
      process.env.OAUTH_BASE_URL = "https://court-scoring.test";
      process.env.DEVICE_LINK_KEK = randomBytes(32).toString("hex");
      minted = [];
      __setRateLimitCounterForTests(async (key) => {
        if (key.startsWith("rl:dlmint:")) minted.push(key);
        return { count: 1, ttlMs: 60_000 };
      });
    });
    afterEach(() => {
      __setRateLimitCounterForTests(null);
      for (const [k, v] of [["OAUTH_BASE_URL", savedLinkEnv.base], ["DEVICE_LINK_KEK", savedLinkEnv.kek]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    });
    const tap = (phone: string) => postScoringLink(qr.code, qr.tok, { phone }, deps, clock(), "203.0.113.9");
    const linkRows = async () => (await sql<{ fixture_id: string; token_hash: string }[]>`
      select fixture_id, token_hash from device_links where org_id = ${day.orgId} order by created_at`);
    const secretOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);
    const labelFor = (i: number) => labelOf(day.comp, day.comp.fixtures[i]!);

    it("during A's video the tap gets C's link (the next unstarted match on the court), streamed or not, with C's label", async () => {
      await streamed(A, AT_14);
      await place(day, B, AT_15 + 60, day.courts.c2);
      await place(day, C, AT_15, day.courts.c2); // C is before B in queue order, and not streamed
      await setStatus(A, "in_play");
      const phone = phoneId("score-c");
      await claimed(phone);
      await operatorStart(phone);
      const ok = await tap(phone);
      expect(CaptureScoringLinkOk.parse(ok)).toEqual(ok);
      expect(ok.label).toBe(labelFor(2));
      const rows = await linkRows();
      expect(rows.map((r) => r.fixture_id)).toEqual([C]);
      expect(rows[0]!.token_hash).toBe(hashDeviceLinkToken(secretOf(ok.url)));
      expect(minted).toHaveLength(1);
    });

    it("a held call outranks an earlier planned match", async () => {
      await place(day, A, AT_14, day.courts.c2);
      await place(day, C, AT_15, day.courts.c2);
      await sql`insert into fixture_calls (fixture_id, org_id, court_id, called_at, called_by, prev_court_id, prev_venue_id, prev_scheduled_at)
                values (${C}, ${day.orgId}, ${day.courts.c2}, ${at(AT_15)}, ${day.auth.userId!}, null, null, null)`;
      const phone = phoneId("score-call");
      await claimed(phone);
      const ok = await tap(phone);
      expect(ok.label).toBe(labelFor(2));
      expect((await linkRows()).map((r) => r.fixture_id)).toEqual([C]);
    });

    it("no match queued on the court: 409 no_match, no device link written, the mint budget untouched", async () => {
      const phone = phoneId("score-none");
      await claimed(phone);
      expect(await refusal(tap(phone))).toBe("409:no_match");
      expect(await linkRows()).toEqual([]);
      expect(minted).toEqual([]);
    });

    it("a refusal on a non-https origin writes nothing and spends no budget", async () => {
      process.env.OAUTH_BASE_URL = "http://court-scoring.test";
      await place(day, A, AT_14, day.courts.c2);
      const phone = phoneId("score-http");
      await claimed(phone);
      expect(await refusal(tap(phone))).toBe("503:unavailable");
      expect(await linkRows()).toEqual([]);
      expect(minted).toEqual([]);
    });

    it("a second tap returns the same url (no revoke), even after C's switch flips", async () => {
      await place(day, A, AT_14, day.courts.c2);
      const phone = phoneId("score-twice");
      await claimed(phone);
      const first = await tap(phone);
      await setCourtStream(day.auth, A, true, at(0));
      const second = await tap(phone);
      expect(second).toEqual(first);
      const rows = await sql<{ revoked_at: Date | null }[]>`select revoked_at from device_links where fixture_id = ${A}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.revoked_at).toBeNull();
    });

    it("a phone that is not the court's current phone: 409 replaced before anything is read", async () => {
      await place(day, A, AT_14, day.courts.c2);
      await claimed(phoneId("score-holder"));
      expect(await refusal(tap(phoneId("score-stranger")))).toBe("409:replaced");
      expect(await linkRows()).toEqual([]);
      expect(minted).toEqual([]);
    });
  });

  it("the court code resolves as a court (premise of every case above)", async () => {
    expect((await resolveAnyStreamCode(qr.code, qr.tok, "get", null, clock())).kind).toBe("court");
  });
});
