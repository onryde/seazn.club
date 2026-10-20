// Owner ruling 2026-10-20 ("fix both gap"): two ways a COMPOSED (score) stream could run for free, closed. Every case drives the
// REAL producers — createSession → the compositor's beats through `heartbeat` → the tick (`tickSession`) — on fake drivers and
// an injected clock, and asserts the CREDIT LEDGER (the consume and refund rows), never a flag alone. Expected values are the
// rulings' text and the config's constants, never `restartAllowance`'s or `neverLiveRefundStanding`'s own answer.
//
// GAP 2 — composed restarts were never counted. W23's rule is "inside the reuse window, the first THREE restarts that reach
// video are free; the 4th pays". `first_ingest_at` is the evidence of video, and only the passthrough poll writes it, so every
// composed restart was free for the whole window. A composed restart now reaches video when the compositor said the camera was
// LIVE (a `live` programme phase), the same evidence R2008's refund reads; `restartAllowance` stays the one authority.
//
// GAP 1 — the no-camera refund could repeat for ever. A session that went live and never had a camera is cancelled after
// PHONE_LOST_LIVE_MINUTES and its credit returned (R2008). Without a bound, start → 15 min "Starting soon" → refund → start again
// ran a score stream for nothing. The platform now returns AT MOST NEVER_LIVE_REFUNDS_PER_WINDOW such credit per fixture per
// CREDIT_REUSE_HOURS; a later never-live end inside the window still ends the stream, and the charge stands. The organiser's
// copy says which of the two will happen, from the SAME predicate the end uses.
//
// ONE SPORT (TEST-STRATEGY rule 6): neither rule reads the sport (the allowance counts sessions; the refund reads the ledger),
// and stream-tick.test.ts already sweeps the never-live end across every sport the catalog holds.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { STREAM_POLL_MS } from "@/lib/stream-session-view";
import {
  CREDIT_REUSE_HOURS, FREE_RESTARTS_PER_WINDOW, NEVER_LIVE_REFUNDS_PER_WINDOW, PHONE_LOST_LIVE_MINUTES, RECONNECT_QUIET_SECONDS,
} from "@/server/relay/config";
import { admit } from "@/server/relay/domain/session";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import type { ProgrammePhaseWire } from "@/lib/relay-phase";
import { pairPresentPhone, rigUser, spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import { creditBalance, grantCredits, refundCredits } from "../stream-credits";
import { type SessionDeps, createSession, currentSession, heartbeat, stopSession, tickSession } from "../stream-sessions";
import { createStreamTarget } from "../stream-targets";
import { seedOrg, startedDivisionWithFixture } from "./_rig";

// `admit`, spied — a PASS-THROUGH — so the agreement case can read the waiver admission actually weighed.
vi.mock("@/server/relay/domain/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/relay/domain/session")>();
  return { ...real, admit: vi.fn(real.admit) };
});

const HAS_DB = !!process.env.DATABASE_URL;

const savedKek = process.env.RELAY_KEK;
const savedImage = process.env.RELAY_IMAGE;
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:free-gaps-test";   // R2001: a composed start is refused while it is unset
});
afterAll(() => {
  if (savedKek === undefined) delete process.env.RELAY_KEK; else process.env.RELAY_KEK = savedKek;
  if (savedImage === undefined) delete process.env.RELAY_IMAGE; else process.env.RELAY_IMAGE = savedImage;
});

const MIN = 60_000;
const LOST_MS = PHONE_LOST_LIVE_MINUTES * MIN;
const QUIET_MS = RECONNECT_QUIET_SECONDS * 1000;
const WINDOW_MIN = CREDIT_REUSE_HOURS * 60;
const ROOMY_STORAGE_MINUTES = 100_000_000;
const CONNECT_AFTER_MS = 1000;
/** A passthrough read must be a FRESH provider read (restart-allowance.test.ts's constant, same reason). */
const FRESH_READ_MS = Math.max(CONNECT_AFTER_MS, 2 * STREAM_POLL_MS) + 500;

type Phase = ProgrammePhaseWire;

async function rig(o: { credits: number; fixtures?: 1 | 2 }) {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  const { fixtureIds } = await startedDivisionWithFixture(auth, { fixtures: o.fixtures ?? 1 });
  for (const key of ["streaming.overlay", "streaming.relay"]) {
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${auth.orgId}, ${key}, true, 'free-gaps unit')
              on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  await invalidateOrgEntitlements(auth.orgId);
  await grantCredits({ orgId: auth.orgId, delta: o.credits, createdBy: await rigUser(), note: "unit", idempotencyKey: randomUUID() });
  await spendMonthlyStreamGrant(auth.orgId);   // the balance is exactly the pack credits granted above
  const target = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "Club", streamKey: `k-${randomUUID().slice(0, 8)}` });
  let now = Date.now();
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs: CONNECT_AFTER_MS });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const runner = new FakeRunner();
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(now), appUrl: "http://app.test" };
  const tick = (ms: number) => { now += ms; };
  const fixtureId = fixtureIds[0]!;

  type Live = { sessionId: string; token: string; fixtureId: string };
  /** A composed Go live with the phone present (W5). */
  const composed = async (fx: string = fixtureId, targetId: string = target.id): Promise<Live> => {
    await pairPresentPhone(fx, { at: deps.now() });
    const { sessionId } = await createSession(auth, fx, { mode: "composed", targetId }, deps);
    return { sessionId, token: runner.created.find((x) => x.sessionId === sessionId)!.jobToken, fixtureId: fx };
  };
  /** The compositor's beat, through the REAL `heartbeat`. */
  const beat = (s: Live, phase: Phase | null) =>
    heartbeat(s.sessionId, s.token, phase === null ? { state: "playing" } : { state: "playing", programmePhase: phase }, deps);
  const stateOf = async (sid: string) =>
    (await sql<{ state: string; fail_reason: string | null; end_reason: string | null }[]>`select state, fail_reason, end_reason from fixture_stream_sessions where id = ${sid}`)[0]!;
  /** The compositor's beat while its OUTPUT to the platform has not connected (supervisor.rs `health()`: pipeline running, sink not
   *  connected → `starting`), which still carries the programme phase — so `starting` + `live` is a real beat, and the session
   *  has not gone on air (only a `playing` beat takes it live). */
  const beatStarting = (s: Live, phase: Phase) => heartbeat(s.sessionId, s.token, { state: "starting", programmePhase: phase }, deps);
  const startedAtOf = async (sid: string) =>
    (await sql<{ started_at: string | null }[]>`select started_at from fixture_stream_sessions where id = ${sid}`)[0]!.started_at;
  /** The first playing beat takes the session live (and decides its credit). `live`: the camera is in; `waiting`: it is not. */
  const reach = async (s: Live, phase: Phase) => {
    await beat(s, phase);
    expect((await stateOf(s.sessionId)).state, `PREMISE: the first playing beat (${phase}) took ${s.sessionId} live`).toBe("live");
  };
  /** An organiser's Stop, then the ticks that finish the composed Machine's goodbye. */
  const stop = async (s: Live) => {
    await stopSession(auth, s.fixtureId, s.sessionId, deps);
    for (let i = 0; i < 6; i++) {
      tick(STREAM_POLL_MS);
      const t = (await tickSession(s.sessionId, deps, "sweep")).session;
      if (t?.state === "completed" || t?.state === "failed") return;
    }
    throw new Error(`PREMISE: ${s.sessionId} did not finish within six ticks of its Stop`);
  };
  const current = async (fx: string = fixtureId) => (await currentSession(auth, fx, deps))!;
  const consumes = async () => (await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${auth.orgId} and reason = 'consume'`)[0]!.n;
  const refundsOf = async (sid: string) => (await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where session_id = ${sid} and reason = 'refund'`)[0]!.n;
  const ledgerOf = (sid: string) => sql<{ reason: string; delta: number; created_by: string | null }[]>`
    select reason, delta, created_by from org_stream_credits where session_id = ${sid} order by created_at, id`;
  const balance = () => creditBalance(sql, auth.orgId);
  /** The camera never appears: tick to `at` after go-live, keep the Machine's beat fresh, and let the tick decide. */
  const tickAfterGoLive = async (s: Live, ms: number) => {
    tick(ms);
    await beat(s, "waiting");
    await sql`update fixture_stream_sessions set ingest_polled_at = null where id = ${s.sessionId}`;
  };
  /** Run a never-live session to the limit and return the session the tick left. */
  const neverLiveEnd = async (s: Live) => {
    await tickAfterGoLive(s, LOST_MS);
    return (await tickSession(s.sessionId, deps, "sweep")).session;
  };
  /** The countdown the organiser's panel is served, once the quiet hold has passed since go-live. */
  const countdownOf = async (s: Live) => {
    await tickAfterGoLive(s, QUIET_MS + 1000);
    return (await current(s.fixtureId)).countdown;
  };
  /** A passthrough Go live whose phone's video arrives (restart-allowance.test.ts's `start` + `video`). */
  const passthrough = async () => {
    await pairPresentPhone(fixtureId, { at: deps.now() });
    const { sessionId } = await createSession(auth, fixtureId, { mode: "passthrough", targetId: target.id }, deps);
    tick(FRESH_READ_MS);
    expect((await current()).state, "PREMISE: the passthrough phone's video took it live").toBe("live");
    return sessionId;
  };
  const programmeLiveRows = async (sid: string) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${sid} and type = 'programme_phase' and to_state = 'live'`)[0]!.n;
  return { auth, orgId: auth.orgId, fixtureId, fixtureIds, target, deps, runner, ingest, tick, composed, beat, beatStarting, startedAtOf, reach, stop, current, consumes,
    refundsOf, ledgerOf, balance, neverLiveEnd, countdownOf, tickAfterGoLive, passthrough, programmeLiveRows, stateOf };
}

// ===========================================================================================================================
// GAP 2
// ===========================================================================================================================
describe.skipIf(!HAS_DB)("GAP 2: composed restarts that reach video count toward W23's three free", () => {
  it("BOUNDARY: a paid composed live, then three restarts that each reach video are free (no consume row added); the 4th pays; the paid 4th re-anchors, so the 5th is free again — and `used` counts them", async () => {
    const r = await rig({ credits: 3 });
    const s0 = await r.composed();
    await r.reach(s0, "live");
    expect(await r.consumes(), "the first live pays").toBe(1);
    await r.stop(s0);
    const paidAt: boolean[] = [];
    const used: number[] = [];
    for (let restart = 1; restart <= FREE_RESTARTS_PER_WINDOW + 2; restart++) {
      const before = await r.consumes();
      const s = await r.composed();
      await r.reach(s, "live");
      paidAt.push((await r.consumes()) === before + 1);
      await r.stop(s);
      used.push((await r.current()).restart!.used);
    }
    // W23's text: restarts 1..3 free, the 4th pays and becomes the anchor (O4), the 5th is free again; `used` is the number of
    // restarts that reached video since the anchor — 1, 2, 3, then 0 (a new anchor), then 1.
    expect(paidAt).toEqual([false, false, false, true, false]);
    expect(used).toEqual([1, 2, 3, 0, 1]);
    expect(await r.consumes()).toBe(2);
  });

  it("NO VIDEO: a composed restart that never reached video never counts — five that went live on `waiting` (the camera never appeared) and one stopped before it went live leave `used` at 0 and every one free; the next three with video are free and the one after them pays", async () => {
    const r = await rig({ credits: 3 });
    const s0 = await r.composed();
    await r.reach(s0, "live");
    await r.stop(s0);
    let dark = 0;
    for (let i = 0; i < FREE_RESTARTS_PER_WINDOW + 2; i++) {
      const s = await r.composed();
      await r.reach(s, "waiting");
      await r.stop(s);
      expect((await r.current()).restart, `after dark restart ${i + 1}`).toMatchObject({ used: 0, free: true });
      dark++;
    }
    // …and one that was created and stopped before the Machine ever beat: no phase at all.
    const never = await r.composed();
    await r.stop(never);
    expect((await r.current()).restart, "created, stopped, never went live").toMatchObject({ used: 0, free: true });
    expect(dark, "anti-vacuity: the dark restarts ran").toBe(FREE_RESTARTS_PER_WINDOW + 2);
    expect(await r.consumes(), "the dark restarts were all free").toBe(1);
    for (let i = 0; i < FREE_RESTARTS_PER_WINDOW; i++) {
      const s = await r.composed();
      await r.reach(s, "live");
      await r.stop(s);
    }
    expect(await r.consumes(), "three that reached video are free").toBe(1);
    const fourth = await r.composed();
    await r.reach(fourth, "live");
    expect(await r.consumes(), "the 4th that reaches video pays").toBe(2);
  });

  it("SAME SESSION: a camera that drops and returns inside one composed session (several `live` rows in its log) is ONE restart, not several", async () => {
    const r = await rig({ credits: 2 });
    const s0 = await r.composed();
    await r.reach(s0, "live");
    await r.stop(s0);
    const s = await r.composed();
    await r.reach(s, "live");
    for (const phase of ["reconnecting", "live", "reconnecting", "live"] as const) { r.tick(1000); await r.beat(s, phase); }
    expect(await r.programmeLiveRows(s.sessionId), "PREMISE: the log holds three `live` rows for the one session").toBe(3);
    expect((await r.current()).restart, "one counted restart").toMatchObject({ used: 1, free: true });
    expect(await r.consumes()).toBe(1);
  });

  it("ON AIR (review I1): a composed attempt whose compositor said `starting` with the camera `live` (its output never connected, so it never went on air) never counts — however many; the same attempt with ONE `playing` beat does", async () => {
    const r = await rig({ credits: 3 });
    const s0 = await r.composed();
    await r.reach(s0, "live");
    await r.stop(s0);
    // The dark attempts: the log holds a camera-`live` row, the session never took a `playing` beat. More than W23's three of
    // them — the overcharge was the working attempt that FOLLOWED a window's worth of these paying for what is free.
    let dark = 0;
    for (let i = 0; i < FREE_RESTARTS_PER_WINDOW + 1; i++) {
      const s = await r.composed();
      await r.beatStarting(s, "live");
      expect(await r.programmeLiveRows(s.sessionId), `PREMISE: dark attempt ${i + 1} logged the camera live`).toBe(1);
      expect(await r.startedAtOf(s.sessionId), `PREMISE: dark attempt ${i + 1} never went on air`).toBeNull();
      await r.stop(s);
      expect((await r.current()).restart, `after dark attempt ${i + 1}`).toMatchObject({ used: 0, free: true });
      dark++;
    }
    expect(dark, "anti-vacuity: the dark attempts ran").toBe(FREE_RESTARTS_PER_WINDOW + 1);
    // The pair: the SAME opening beat, then ONE `playing` beat — on air, so it counts, and (as the first counted restart) is free.
    const on = await r.composed();
    await r.beatStarting(on, "live");
    await r.reach(on, "live");
    expect(await r.startedAtOf(on.sessionId), "PREMISE: the playing beat took it on air").not.toBeNull();
    expect(await r.consumes(), "the working attempt took nothing: the dark ones before it counted for nothing").toBe(1);
    await r.stop(on);
    expect((await r.current()).restart, "one counted restart: the one that went on air").toMatchObject({ used: 1, free: true });
  });

  it("AGREEMENT: at every step of the boundary sequence, admission's waiver, consumeForSession's decision and the projection's `restart.free` are all equal — five steps compared, composed", async () => {
    const r = await rig({ credits: 3 });
    const s0 = await r.composed();
    await r.reach(s0, "live");
    await r.stop(s0);
    const spy = vi.mocked(admit);
    const seen: boolean[] = [];
    let compared = 0;
    for (let restart = 1; restart <= FREE_RESTARTS_PER_WINDOW + 2; restart++) {
      const view = await r.current();
      spy.mockClear();
      const before = await r.consumes();
      const s = await r.composed();
      const waived = spy.mock.calls.at(-1)![0].restartWithinReuseWindow;
      await r.reach(s, "live");
      const consumeFree = (await r.consumes()) === before;
      expect(view.restart, `restart ${restart}: a window is open`).not.toBeNull();
      const answers = { admission: waived, consume: consumeFree, restart: view.restart!.free };
      expect(new Set(Object.values(answers)).size, `restart ${restart}: ${JSON.stringify(answers)}`).toBe(1);
      seen.push(waived);
      compared++;
      await r.stop(s);
    }
    expect(compared).toBe(FREE_RESTARTS_PER_WINDOW + 2);
    expect(seen, "W23's text, step by step").toEqual([true, true, true, false, true]);
  });

  it("MIXED MODES: the window is the FIXTURE's — a paid composed live, then a passthrough restart that reaches video and two composed ones make three; the next, in either mode, is not free", async () => {
    const r = await rig({ credits: 3 });
    const s0 = await r.composed();
    await r.reach(s0, "live");
    await r.stop(s0);
    const p = await r.passthrough();
    await stopSession(r.auth, r.fixtureId, p, r.deps);
    expect((await r.current()).restart, "one (passthrough)").toMatchObject({ used: 1, free: true });
    for (let i = 0; i < 2; i++) {
      const s = await r.composed();
      await r.reach(s, "live");
      await r.stop(s);
    }
    expect((await r.current()).restart, "three (one passthrough, two composed)").toMatchObject({ used: FREE_RESTARTS_PER_WINDOW, free: false });
    const before = await r.consumes();
    const next = await r.composed();
    await r.reach(next, "live");
    expect(await r.consumes(), "the 4th pays, whatever the modes before it").toBe(before + 1);
  });
});

// ===========================================================================================================================
// GAP 1
// ===========================================================================================================================
describe.skipIf(!HAS_DB)("GAP 1: the platform returns at most one never-live credit per fixture per reuse window", () => {
  it("THE LOOP: a 1st no-camera end is refunded; a 2nd, minutes later, ends the same way and the charge STANDS; a 3rd (a free restart: nothing was taken) has nothing to return — one credit spent in all, and the countdown names each outcome BEFORE the end", async () => {
    const r = await rig({ credits: 3 });
    const bal0 = await r.balance();
    expect(NEVER_LIVE_REFUNDS_PER_WINDOW, "the ruling's number").toBe(1);

    // 1st: refunded.
    const s1 = await r.composed();
    await r.reach(s1, "waiting");
    expect((await r.countdownOf(s1))?.reason, "S1: the credit comes back").toBe("camera_never_live");
    expect(await r.neverLiveEnd(s1), "S1: ended at the limit").toMatchObject({ state: "failed", failReason: "camera_never_live" });
    expect((await r.ledgerOf(s1.sessionId)).map((x) => [x.reason, x.delta]), "S1's ledger").toEqual([["consume", -1], ["refund", 1]]);
    expect(await r.balance(), "S1: nothing spent").toBe(bal0);
    expect(await r.current(), "S1: what the panel reads").toMatchObject({ state: "failed", failReason: "camera_never_live", creditUsed: false });

    // 2nd: the window already holds a never-live refund for this fixture.
    const s2 = await r.composed();
    await r.reach(s2, "waiting");
    expect((await r.countdownOf(s2))?.reason, "S2: the charge will stand").toBe("camera_never_live_charged");
    expect(await r.neverLiveEnd(s2), "S2: still ends").toMatchObject({ state: "failed", failReason: "camera_never_live" });
    expect((await r.ledgerOf(s2.sessionId)).map((x) => [x.reason, x.delta]), "S2's ledger: the consume stands").toEqual([["consume", -1]]);
    expect(await r.balance(), "S2: one credit spent").toBe(bal0 - 1);
    expect(await r.current(), "S2: what the panel reads").toMatchObject({ state: "failed", failReason: "camera_never_live", creditUsed: true });
    const declined = await sql<{ payload: Record<string, unknown>; result: string | null }[]>`select payload, result from fixture_stream_events where session_id = ${s2.sessionId} and type = 'refund_credit'`;
    // (review m2) a refund that was NOT written claims no success: the column holds 'ok' | 'failed' | null (V410's check), and a
    // declined refund is neither a success nor a failure, so it is null — the `reason` below says why.
    expect(declined.map((e) => e.result), "a declined refund does not record itself as 'ok'").toEqual([null]);
    const returned = await sql<{ result: string | null }[]>`select result from fixture_stream_events where session_id = ${s1.sessionId} and type = 'refund_credit'`;
    expect(returned.map((e) => e.result), "…and a refund that was written still does (the positive pair)").toEqual(["ok"]);
    expect(declined.map((e) => e.payload), "the session's history names the refund the platform declined").toEqual([
      { delta: 0, balanceAfter: bal0 - 1, ledgerId: null, reason: "refund_capped" },
    ]);

    // 3rd: S2's consume stands, so this is a FREE restart; nothing was taken, nothing is owed, and the copy stays true.
    const s3 = await r.composed();
    await r.reach(s3, "waiting");
    expect(await r.ledgerOf(s3.sessionId), "PREMISE: a free restart consumes nothing").toEqual([]);
    expect((await r.countdownOf(s3))?.reason, "S3: nothing was charged, so the line that says so is true").toBe("camera_never_live");
    expect(await r.neverLiveEnd(s3)).toMatchObject({ state: "failed", failReason: "camera_never_live" });
    expect(await r.ledgerOf(s3.sessionId)).toEqual([]);
    expect(await r.current(), "S3").toMatchObject({ state: "failed", creditUsed: false });
    expect(await r.balance(), "three attempts, one credit").toBe(bal0 - 1);
    expect(await r.refundsOf(s1.sessionId) + await r.refundsOf(s2.sessionId) + await r.refundsOf(s3.sessionId), "one platform refund in all").toBe(1);
  });

  it("AGREEMENT: for every end, the countdown's reason before it says 'charged' EXACTLY when the panel reads a credit used after it — both answers seen (the sequence's three ends)", async () => {
    const r = await rig({ credits: 3 });
    const outcomes: { charged: boolean; creditUsed: boolean }[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await r.composed();
      await r.reach(s, "waiting");
      const reason = (await r.countdownOf(s))?.reason;
      expect(["camera_never_live", "camera_never_live_charged"], `end ${i + 1}: a never-live countdown is shown`).toContain(reason);
      await r.neverLiveEnd(s);
      outcomes.push({ charged: reason === "camera_never_live_charged", creditUsed: (await r.current()).creditUsed });
    }
    expect(outcomes.map((o) => o.charged === o.creditUsed), "the line promised is the one that happened").toEqual([true, true, true]);
    expect(outcomes.map((o) => o.charged), "refunded, charged, then nothing owed").toEqual([false, true, false]);
  });

  it("THE WINDOW: a never-live refund a minute INSIDE CREDIT_REUSE_HOURS caps the next; one a minute PAST it does not — and that next end is refunded again", async () => {
    let checked = 0;
    for (const [label, ageMin, refunded] of [["a minute inside", WINDOW_MIN - 1, false], ["a minute past", WINDOW_MIN + 1, true]] as const) {
      const r = await rig({ credits: 3 });
      const s1 = await r.composed();
      await r.reach(s1, "waiting");
      await r.neverLiveEnd(s1);
      expect(await r.refundsOf(s1.sessionId), `${label}: PREMISE: S1 was refunded`).toBe(1);
      const s2 = await r.composed();
      await r.reach(s2, "waiting");
      await r.tickAfterGoLive(s2, LOST_MS);
      // The refund row is re-dated against the RIG's clock, which is the `now` the end judges on.
      await sql`update org_stream_credits set created_at = ${r.deps.now()}::timestamptz - make_interval(mins => ${ageMin}) where session_id = ${s1.sessionId} and reason = 'refund'`;
      expect((await tickSession(s2.sessionId, r.deps, "sweep")).session, label).toMatchObject({ state: "failed", failReason: "camera_never_live" });
      expect(await r.refundsOf(s2.sessionId), `${label}: S2 refunded`).toBe(refunded ? 1 : 0);
      expect((await r.current()).creditUsed, `${label}: creditUsed`).toBe(!refunded);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("THE OLD ONE (review I2): with TWO earlier platform refunds on the fixture — one two windows old, one a minute old — the newest decides: the next never-live end is capped, and the countdown says so", async () => {
    const r = await rig({ credits: 4 });
    const s1 = await r.composed();
    await r.reach(s1, "waiting");
    await r.neverLiveEnd(s1);
    expect(await r.refundsOf(s1.sessionId), "PREMISE: S1 was refunded").toBe(1);
    // S1's refund ages out of the window (re-dated against the rig's clock, the `now` the end judges on)…
    await sql`update org_stream_credits set created_at = ${r.deps.now()}::timestamptz - make_interval(mins => ${2 * WINDOW_MIN}) where session_id = ${s1.sessionId} and reason = 'refund'`;
    // …so S2 is refunded again, and S2's refund is the fresh one. (S1's and S2's consumes were both returned, so neither stands:
    // S3 below pays at go-live.)
    const s2 = await r.composed();
    await r.reach(s2, "waiting");
    await r.neverLiveEnd(s2);
    expect(await r.refundsOf(s2.sessionId), "PREMISE: S2 was refunded, S1's refund being a window old").toBe(1);
    await sql`update org_stream_credits set created_at = ${r.deps.now()}::timestamptz - make_interval(mins => 1) where session_id = ${s2.sessionId} and reason = 'refund'`;
    const priors = await sql<{ n: number }[]>`
      select count(*)::int as n from org_stream_credits c join fixture_stream_sessions s on s.id = c.session_id
       where c.org_id = ${r.orgId} and s.fixture_id = ${r.fixtureId} and c.reason = 'refund' and c.created_by is null`;
    expect(priors[0]!.n, "PREMISE: two platform refunds sit on this fixture's ledger").toBe(2);
    const s3 = await r.composed();
    await r.reach(s3, "waiting");
    expect(await r.consumes(), "PREMISE: S3 paid at go-live (no consume of S1 or S2 stands)").toBe(3);
    expect((await r.countdownOf(s3))?.reason, "S3: the fresh refund caps it, however old the other is").toBe("camera_never_live_charged");
    await r.neverLiveEnd(s3);
    expect(await r.refundsOf(s3.sessionId), "S3's refund is withheld").toBe(0);
    expect((await r.current()).creditUsed, "S3 spent its credit").toBe(true);
  });

  it("THE FIXTURE: the cap is per fixture — a refund on fixture A does not cap fixture B's no-camera end in the same org", async () => {
    const r = await rig({ credits: 3, fixtures: 2 });
    const [a, b] = r.fixtureIds as [string, string];
    const targetB = await createStreamTarget(r.auth, r.orgId, { kind: "youtube", label: "B", streamKey: `kb-${randomUUID().slice(0, 8)}` });
    const sa = await r.composed(a);
    await r.reach(sa, "waiting");
    await r.neverLiveEnd(sa);
    expect(await r.refundsOf(sa.sessionId), "PREMISE: A's end was refunded").toBe(1);
    const sb = await r.composed(b, targetB.id);
    await r.reach(sb, "waiting");
    expect((await r.countdownOf(sb))?.reason, "B: the credit comes back").toBe("camera_never_live");
    await r.neverLiveEnd(sb);
    expect(await r.refundsOf(sb.sessionId), "B was refunded too").toBe(1);
    // …and a second on A is capped, where B's was not (the positive pair).
    const sa2 = await r.composed(a);
    await r.reach(sa2, "waiting");
    await r.neverLiveEnd(sa2);
    expect(await r.refundsOf(sa2.sessionId), "A's second is capped").toBe(0);
  });

  it("A STAFF refund does not use the platform's allowance: a never-live session the staff already refunded leaves the next end refunded", async () => {
    const r = await rig({ credits: 3 });
    const s1 = await r.composed();
    await r.reach(s1, "waiting");
    await refundCredits({ orgId: r.orgId, delta: 1, sessionId: s1.sessionId, createdBy: await rigUser(), note: "goodwill: the camera never worked", idempotencyKey: randomUUID() });
    await r.neverLiveEnd(s1);
    expect((await r.ledgerOf(s1.sessionId)).map((x) => [x.reason, x.delta, x.created_by === null]), "S1: the staff refund only").toEqual([["consume", -1, true], ["refund", 1, false]]);
    const s2 = await r.composed();
    await r.reach(s2, "waiting");
    expect((await r.countdownOf(s2))?.reason, "S2: the allowance is untouched").toBe("camera_never_live");
    await r.neverLiveEnd(s2);
    expect((await r.ledgerOf(s2.sessionId)).map((x) => [x.reason, x.delta]), "S2 is refunded by the platform").toEqual([["consume", -1], ["refund", 1]]);
  });

  it("A STAFF refund MID-COUNTDOWN: the line flips to 'not charged' and the end writes nothing — the organiser is not refunded twice", async () => {
    const r = await rig({ credits: 3 });
    const s1 = await r.composed();
    await r.reach(s1, "waiting");
    await r.neverLiveEnd(s1);                       // spends the allowance
    const s2 = await r.composed();
    await r.reach(s2, "waiting");
    expect((await r.countdownOf(s2))?.reason, "PREMISE: the charge would stand").toBe("camera_never_live_charged");
    await refundCredits({ orgId: r.orgId, delta: 1, sessionId: s2.sessionId, createdBy: await rigUser(), note: "goodwill", idempotencyKey: randomUUID() });
    expect((await r.countdownOf(s2))?.reason, "nothing is owed any more: the 'not charged' line is true").toBe("camera_never_live");
    await r.neverLiveEnd(s2);
    expect((await r.ledgerOf(s2.sessionId)).map((x) => [x.reason, x.delta, x.created_by === null]), "the staff refund only").toEqual([["consume", -1, true], ["refund", 1, false]]);
    expect(await r.current(), "not charged").toMatchObject({ creditUsed: false });
  });

  it("CONCURRENT ticks end a capped session once and refund nothing; the same three ticks on an uncapped one refund exactly once", async () => {
    const r = await rig({ credits: 3 });
    const tickThrice = async (s: { sessionId: string }) => {
      await Promise.all([0, 1, 2].map(async () => {
        await sql`update fixture_stream_sessions set ingest_polled_at = null where id = ${s.sessionId}`;
        return tickSession(s.sessionId, r.deps, "sweep");
      }));
    };
    const endsOf = async (sid: string) => (await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_stream_events where session_id = ${sid} and kind = 'transition' and to_state = 'failed'`)[0]!.n;
    const uncapped = await r.composed();
    await r.reach(uncapped, "waiting");
    await r.tickAfterGoLive(uncapped, LOST_MS);
    await tickThrice(uncapped);
    expect(await r.refundsOf(uncapped.sessionId), "uncapped: exactly one refund").toBe(1);
    expect(await endsOf(uncapped.sessionId), "uncapped: one end").toBe(1);
    const capped = await r.composed();
    await r.reach(capped, "waiting");
    await r.tickAfterGoLive(capped, LOST_MS);
    await tickThrice(capped);
    expect((await r.stateOf(capped.sessionId)).fail_reason).toBe("camera_never_live");
    expect(await r.refundsOf(capped.sessionId), "capped: none").toBe(0);
    expect(await endsOf(capped.sessionId), "capped: one end").toBe(1);
    expect((await r.ledgerOf(capped.sessionId)).map((x) => [x.reason, x.delta])).toEqual([["consume", -1]]);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${capped.sessionId} and type = 'refund_credit'`)[0]!.n, "one decision recorded").toBe(1);
  });

  it("A free restart whose camera never appears, with NO refund anywhere in the window: ended, nothing owed, and the line that says so is the true one", async () => {
    const r = await rig({ credits: 2 });
    const first = await r.composed();
    await r.reach(first, "live");
    await r.stop(first);
    const bal = await r.balance();
    const s = await r.composed();
    await r.reach(s, "waiting");
    expect(await r.ledgerOf(s.sessionId), "PREMISE: a free restart").toEqual([]);
    expect((await r.countdownOf(s))?.reason).toBe("camera_never_live");
    await r.neverLiveEnd(s);
    expect(await r.ledgerOf(s.sessionId)).toEqual([]);
    expect(await r.balance()).toBe(bal);
    expect(await r.current()).toMatchObject({ state: "failed", creditUsed: false });
  });
});
