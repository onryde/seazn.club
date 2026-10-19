// Capture QR v2 T7 (§6.11, §6.8.3, §6.8.5): `tickSession` — the organiser poll's reconcile-and-ingest block, extracted so a
// phone beat and the stream-tick job advance a session nobody is watching, plus ask 10 and W19's phone-lost ends and the
// controller's m-5 ruling. Real Postgres; skipped without DATABASE_URL.
//
// Clocks. Each rig's clock is FROZEN at creation and tickable; every instant the tick judges (first_ingest_at, the poll
// samples, warming_at, phone_beat_at, the pairing's last_beat_at) is written on that same clock, so each boundary is
// exact to the millisecond. Expected thresholds are read from the spec's constants (config.ts, §6.8.3/§6.8.5/§6.9),
// never from the functions under test.
//
// Sports: every case but the sport sweep rides seedOrg's `generic` division — the tick reads no sport (relay is
// sport-agnostic); the sweep at the end runs W19 and ask 10 on every sport the catalog holds to prove it.
//
// T7b (W22): `tickOpenSessions`, the stream-tick job's pass, is at the end — several sessions, each in its own org, on ONE
// deps (one clock, one fake ingest), scoped to their orgs by the test-only `orgIds` (the cron route passes none).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql, statementCount } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { PROGRAMME_PHASES, type ProgrammePhaseWire } from "@/lib/relay-phase";
import { STREAM_POLL_MS } from "@/lib/stream-session-view";
import { StreamLostCountdown } from "@/server/api-v1/schemas";
import {
  MAX_DURATION_MINUTES, PHONE_LOST_LIVE_MINUTES, PHONE_SILENT_FLOOR_SECONDS, PHONE_SILENT_SLACK_SECONDS, POLL_FAR_SECONDS, POLL_NEAR_SECONDS,
  RECONNECT_QUIET_SECONDS, WARMING_TIMEOUT_MINUTES,
} from "@/server/relay/config";
import { OPEN_SESSION_MAX_POLL_SECONDS } from "@/server/relay/domain/poll-seconds";
import { RECORDINGS_PER_SESSION } from "@/server/relay/domain/credits";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import type { IngestProvider, IngestState, IngestStatus, ProviderCallRecord } from "@/server/relay/ports";
import { mintRelayToken } from "@/server/relay/tokens";
import { pairPresentPhone, rigUser } from "@/server/relay/__tests__/_session-rig";
import { seedOrg, startedDivisionWithFixture } from "./_rig";
import { creditBalance, grantCredits, refundCredits } from "../stream-credits";
import { createStreamTarget } from "../stream-targets";
import { reissueStreamCode } from "../stream-codes";
import {
  type SessionDeps, STREAM_TICK_BUDGET_MS, createSession, currentSession, heartbeat, stopSession, storageReservations, tickOpenSessions, tickSession,
} from "../stream-sessions";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));
// A pass-through seam on the org money lock `apply` takes first (A7): a race test parks a phone beat there, between the
// tick's unlocked judgement and its locked decision; the stream-tick pass's failure case throws there for ONE org. It is
// handed the org being locked. Null = pass straight through.
const hook = vi.hoisted(() => ({ onLockOrg: null as null | ((orgId: string) => Promise<void>) }));
vi.mock("../stream-credits", async (importOriginal) => {
  const real = await importOriginal<typeof import("../stream-credits")>();
  return { ...real, lockOrg: async (...a: Parameters<typeof real.lockOrg>) => { if (hook.onLockOrg) await hook.onLockOrg(a[1]); return real.lockOrg(...a); } };
});

const HAS_DB = !!process.env.DATABASE_URL;

// A KEK of this file's own (relay-sweep.test.ts precedent): CI supplies no RELAY_KEK. Restored afterwards, never printed.
const savedKek = process.env.RELAY_KEK;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
afterAll(() => {
  if (savedKek === undefined) delete process.env.RELAY_KEK;
  else process.env.RELAY_KEK = savedKek;
});

// R2001: a composed start is refused 503 composed_unavailable while RELAY_IMAGE is unset (drivers.ts `composedUnavailable`).
// This file's composed sessions run on the fake runner, which needs no image, so the file names one of its own — put
// back afterwards the KEK's way.
const savedImage = process.env.RELAY_IMAGE;
beforeAll(() => { process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:tick-test"; });
afterAll(() => {
  if (savedImage === undefined) delete process.env.RELAY_IMAGE;
  else process.env.RELAY_IMAGE = savedImage;
});

const MIN = 60_000;
const ROOMY_STORAGE_MINUTES = 100_000_000;
const CONNECT_AFTER_MS = 3000;
/** §6.8.5: W19's limit, from the spec's constant. */
const LOST_MS = PHONE_LOST_LIVE_MINUTES * MIN;
/** §6.9 + §6.8.3: a phone that has not heard go-live is silent at max(floor, its waiting cadence + slack). The rig pairs
 *  on the far cadence (pairPresentPhone), so this is the spec's figure for it. */
const ASK10_SILENT_MS = Math.max(PHONE_SILENT_FLOOR_SECONDS, POLL_FAR_SECONDS + PHONE_SILENT_SLACK_SECONDS) * 1000;
/** §6.8.3's other clock: a phone that has beaten SINCE the session was created has heard the go-live and is answered at
 *  an open session's cadence (at most OPEN_SESSION_MAX_POLL_SECONDS), so its stale far cadence no longer stretches the
 *  silence — "silent is exactly ask 10's 60 s with no beat". */
const HEARD_SILENT_MS = Math.max(PHONE_SILENT_FLOOR_SECONDS, Math.min(POLL_FAR_SECONDS, OPEN_SESSION_MAX_POLL_SECONDS) + PHONE_SILENT_SLACK_SECONDS) * 1000;

/** One frozen, tickable clock and the fakes that read it: the deps every session of a rig (or a fleet) shares. */
function clockedDeps(connectAfterMs = CONNECT_AFTER_MS) {
  let now = Date.now();
  // Every provider call the fake makes, as the adapter would record it (Review Focus 3: counted on the recorder).
  const calls: ProviderCallRecord[] = [];
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs, recorder: { record: (c) => { calls.push(c); } } });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const runner = new FakeRunner();
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(now), appUrl: "http://app.test" };
  return {
    ingest, runner, deps, calls,
    tick: (ms: number) => { now += ms; },
    /** Bring the clock up to the wall clock, never back: the pairing and the session are written on it, as they always were. */
    catchUp: () => { now = Math.max(now, Date.now()); },
  };
}
type Clocked = ReturnType<typeof clockedDeps>;

/** A fresh org with one fixture, a present phone and a session created on `c`'s deps. */
async function seedSession(c: Clocked, o: { mode?: "passthrough" | "composed"; sport?: string } = {}) {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  const { fixtureId, divisionId } = await startedDivisionWithFixture(auth);
  if (o.sport) await sql`update divisions set sport_key = ${o.sport} where id = ${divisionId}`;
  for (const key of ["streaming.overlay", "streaming.relay"]) {
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${auth.orgId}, ${key}, true, 't7 unit')
              on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  await invalidateOrgEntitlements(auth.orgId);
  await grantCredits({ orgId: auth.orgId, delta: 2, createdBy: await rigUser(), note: "unit", idempotencyKey: randomUUID() });
  const target = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "T", streamKey: "k", watchUrl: "https://www.youtube.com/watch?v=tick" });
  c.catchUp();
  const paired = await pairPresentPhone(fixtureId, { at: c.deps.now() });
  const { sessionId } = await createSession(auth, fixtureId, { mode: o.mode ?? "passthrough", targetId: target.id }, c.deps);
  const [{ ingest_input_id: inputId }] = await sql<{ ingest_input_id: string }[]>`
    select ingest_input_id from fixture_stream_inputs where session_id = ${sessionId} and slot = 0`;
  const row = async () => (await sql<{
    state: string; fail_reason: string | null; end_reason: string | null; first_ingest_at: Date | null; fixture_id: string | null;
  }[]>`select state, fail_reason, end_reason, first_ingest_at, fixture_id from fixture_stream_sessions where id = ${sessionId}`)[0]!;
  return { auth, orgId: auth.orgId, fixtureId, divisionId, sessionId, inputId, paired, row };
}

async function rig(o: { mode?: "passthrough" | "composed"; sport?: string; connectAfterMs?: number } = {}) {
  const c = clockedDeps(o.connectAfterMs);
  return { ...(await seedSession(c, o)), ...c };
}
type Rig = Awaited<ReturnType<typeof rig>>;

/** The session's phone beats 1 s after the session's OWN created_at (the database's clock, which the rig's clock trails),
 *  and the rig's clock moves there: the phone has now beaten since the session was created (heard_go_live). */
async function beatAfterCreation(r: Rig): Promise<Date> {
  const [{ created_at }] = await sql<{ created_at: Date }[]>`select created_at from fixture_stream_sessions where id = ${r.sessionId}`;
  const at = new Date(created_at.getTime() + 1000);
  const gap = at.getTime() - r.deps.now().getTime();
  expect(gap, "PREMISE: the rig's clock is still before the beat").toBeGreaterThan(0);
  r.tick(gap);
  await sql`update fixture_stream_pairings set last_beat_at = ${at} where id = ${r.paired.pairingId}`;
  return at;
}

/** A row as every session open when V430 deploys reads: no phone (`pairing_id`), no warming entry, no phone beat. */
const asLegacy = (r: Rig) => sql`update fixture_stream_sessions set pairing_id = null, warming_at = null, phone_beat_at = null where id = ${r.sessionId}`;

/** The recorder is best-effort and asynchronous (FakeIngest.record defers to a microtask): drain before counting. */
const settle = () => new Promise<void>((res) => setImmediate(res));
const inputStatusCalls = async (r: Rig) => { await settle(); return r.calls.filter((c) => c.operation === "inputStatus").length; };

/** The connect delay elapses and a beat-cause tick takes the session live — the clock is now first_ingest_at. */
async function goLive(r: Rig): Promise<Date> {
  r.tick(CONNECT_AFTER_MS);
  const t = await tickSession(r.sessionId, r.deps, "beat");
  expect(t.session?.state, "PREMISE: the tick took it live").toBe("live");
  return r.deps.now();
}

/** Net credit spend of the session (its consume, less any linked refund) — D3's own arithmetic. */
const netSpend = async (sid: string) =>
  (await sql<{ net: number }[]>`select coalesce(sum(delta), 0)::int as net from org_stream_credits where session_id = ${sid} and reason in ('consume','refund')`)[0]!.net;
const refunds = async (sid: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where session_id = ${sid} and reason = 'refund'`)[0]!.n;
/** How many times the session ENDED: transition rows into a terminal state, and SessionEnded events. */
const ends = async (sid: string) => (await sql<{ transitions: number; ended: number }[]>`
  select count(*) filter (where kind = 'transition' and to_state in ('completed','failed'))::int as transitions,
         count(*) filter (where kind = 'event' and type = 'SessionEnded')::int as ended
    from fixture_stream_events where session_id = ${sid}`)[0]!;
/** A connected poll sample at `at` — the video clock W19's third clause reads. */
const connectedSampleAt = (sid: string, at: Date) =>
  sql`insert into fixture_stream_samples (session_id, source, ingest_state, output_state, sampled_at) values (${sid}, 'poll', 'connected', 'ok', ${at})`;

describe.skipIf(!HAS_DB)("tickSession — the tick (§6.11)", () => {
  it("advances WITHOUT a panel: a beat-cause tick takes warming → live and consumes the credit, with no organiser poll at all", async () => {
    const r = await rig();
    expect((await r.row()).state, "PREMISE: created warming").toBe("warming");
    r.tick(CONNECT_AFTER_MS - 1);
    expect((await tickSession(r.sessionId, r.deps, "beat")).session?.state, "1 ms before the phone connects: still warming").toBe("warming");
    r.tick(STREAM_POLL_MS);   // the next claim window: this beat reads again, and the phone is sending
    const t = await tickSession(r.sessionId, r.deps, "beat");
    expect(t.session?.state).toBe("live");
    expect(t.ingestState?.state).toBe("connected");
    expect(await netSpend(r.sessionId), "the go-live consumed one credit").toBe(-1);
    expect((await r.row()).first_ingest_at?.getTime()).toBe(r.deps.now().getTime());
  });

  it("an UNKNOWN session id is not a throw: the empty observation, every field at its 'read nothing' value", async () => {
    const r = await rig();
    expect(await tickSession(randomUUID(), r.deps, "sweep")).toEqual({ session: null, ingestState: null, outputObserved: null, coalescedSince: undefined, phoneReadFailed: false, camera: null });
  });

  it("coalescing: two organiser polls and one beat inside one STREAM_POLL_MS make exactly ONE inputStatus call — concurrently and in sequence", async () => {
    const r = await rig();
    await goLive(r);
    let checked = 0;
    // Concurrently, one claim window after the go-live read.
    r.tick(STREAM_POLL_MS);
    let before = await inputStatusCalls(r);
    const views = await Promise.all([
      currentSession(r.auth, r.fixtureId, r.deps), currentSession(r.auth, r.fixtureId, r.deps), tickSession(r.sessionId, r.deps, "beat"),
    ]);
    expect(await inputStatusCalls(r) - before, "concurrent: one read").toBe(1);
    expect(views[0]!.state).toBe("live");
    checked++;
    // In sequence, inside the next window: poll, poll 1 ms later, beat 2 ms later.
    r.tick(STREAM_POLL_MS);
    before = await inputStatusCalls(r);
    await currentSession(r.auth, r.fixtureId, r.deps);
    r.tick(1);
    await currentSession(r.auth, r.fixtureId, r.deps);
    r.tick(1);
    const served = await tickSession(r.sessionId, r.deps, "beat");
    expect(await inputStatusCalls(r) - before, "sequential: one read").toBe(1);
    expect(served.ingestState?.state, "the beat was answered from the coalesced sample").toBe("connected");
    expect(served.coalescedSince, "served, so it carries the sample's own since (B0 I-1)").not.toBeUndefined();
    checked++;
    expect(checked).toBe(2);
  });

  it("T35: a LIVE session whose fixture was DELETED (fixture_id set null) ticks without a throw, and the deletion does not move its state", async () => {
    const r = await rig();
    await goLive(r);
    await sql`delete from fixtures where id = ${r.fixtureId}`;
    expect((await r.row()).fixture_id, "PREMISE: V410 set it null").toBeNull();
    r.tick(STREAM_POLL_MS);
    const t = await tickSession(r.sessionId, r.deps, "sweep");
    expect(t.session?.state).toBe("live");
    expect((await r.row()).state).toBe("live");
  });
});

describe.skipIf(!HAS_DB)("ask 10 (§6.8.3): a warming broadcast whose phone is lost is ended phone_lost, no credit spent", () => {
  it("a silent phone, no ingest: NOT ended 1 ms before §6.9's silence, ended AT it — phone_lost, a completion, and the credit rows sum to 0", async () => {
    const r = await rig({ connectAfterMs: 10 * MIN });   // never connects inside this case
    // The pairing beat at the rig's clock; the session was created on it.
    r.tick(ASK10_SILENT_MS - 1);
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, "1 ms short of silent").toBe("warming");
    r.tick(1);
    const t = await tickSession(r.sessionId, r.deps, "sweep");
    expect(t.session).toMatchObject({ state: "completed", endReason: "phone_lost", failReason: null });
    expect(await r.row()).toMatchObject({ state: "completed", end_reason: "phone_lost", fail_reason: null, first_ingest_at: null });
    expect(await netSpend(r.sessionId), "no credit spent").toBe(0);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where session_id = ${r.sessionId}`)[0]!.n, "no ledger row at all").toBe(0);
    expect(await ends(r.sessionId)).toEqual({ transitions: 1, ended: 1 });
  });

  it("a phone that BEATS keeps its warming session: past the silence on the session's clock, with a fresh beat, it is not ended", async () => {
    const r = await rig({ connectAfterMs: 10 * MIN });
    r.tick(ASK10_SILENT_MS * 2);
    await sql`update fixture_stream_pairings set last_beat_at = ${r.deps.now()} where id = ${r.paired.pairingId}`;
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state).toBe("warming");
  });

  it("a session WITH first_ingest_at is never ended by ask 10 — a warming reconnect with a long-silent phone stays open (W19 owns it)", async () => {
    const r = await rig({ connectAfterMs: 10 * MIN });
    await sql`update fixture_stream_sessions set first_ingest_at = ${r.deps.now()} where id = ${r.sessionId}`;
    r.tick(ASK10_SILENT_MS + MIN);
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state).toBe("warming");
    expect((await r.row()).end_reason).toBeNull();
  });

  it("C1b/C3 (T30): after Revoke & reissue the old code still serves the open session's phone — beating, its warming session stays OPEN; falling silent, it is ended at §6.9's boundary and not 1 ms before — exactly as with no reissue", async () => {
    let checked = 0;
    for (const reissue of [false, true]) {
      const label = reissue ? "reissued" : "no reissue";
      const r = await rig({ connectAfterMs: 10 * MIN });
      await beatAfterCreation(r);
      if (reissue) {
        await reissueStreamCode(r.auth, r.fixtureId);
        const [c] = await sql<{ ended_at: Date | null }[]>`select ended_at from fixture_stream_codes where id = ${r.paired.codeId}`;
        expect(c!.ended_at, "PREMISE (C3): the old code ENDED").not.toBeNull();
      }
      const [p] = await sql<{ ended_at: Date | null }[]>`select ended_at from fixture_stream_pairings where id = ${r.paired.pairingId}`;
      expect(p!.ended_at, "PREMISE (C1): the old code's pairing is untouched until it calls").toBeNull();
      expect((await tickSession(r.sessionId, r.deps, "poll")).session?.state, `${label}: the organiser's poll, phone beating`).toBe("warming");
      r.tick(HEARD_SILENT_MS - 1);
      expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, `${label}: 1 ms short of silent`).toBe("warming");
      r.tick(1);
      expect((await tickSession(r.sessionId, r.deps, "sweep")).session, `${label}: silent`).toMatchObject({ state: "completed", endReason: "phone_lost" });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("heard_go_live: a phone that has beaten SINCE the session was created is ended HEARD_SILENT_MS after its beat (not 1 ms before) — its stale 60 s waiting cadence no longer stretches the clock to ASK10_SILENT_MS", async () => {
    expect(HEARD_SILENT_MS, "PREMISE: the two clocks differ, so this case can tell them apart").toBeLessThan(ASK10_SILENT_MS);
    const r = await rig({ connectAfterMs: 10 * MIN });
    await beatAfterCreation(r);
    const [p] = await sql<{ answered_poll_seconds: number }[]>`select answered_poll_seconds from fixture_stream_pairings where id = ${r.paired.pairingId}`;
    expect(p!.answered_poll_seconds, "PREMISE: the stale far cadence is what is stored").toBe(POLL_FAR_SECONDS);
    r.tick(HEARD_SILENT_MS - 1);
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, "1 ms short").toBe("warming");
    r.tick(1);
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session).toMatchObject({ state: "completed", endReason: "phone_lost" });
  });

  it("a session whose pairing has ENDED (each end_cause) no longer has a current phone (§6.8.3) — a fresh beat does not hold it: ended phone_lost; the same fresh beat on a CURRENT pairing holds it", async () => {
    const causes = [null, "replaced", "operator_stopped", "code_ended"] as const;
    let checked = 0;
    for (const cause of causes) {
      const r = await rig({ connectAfterMs: 10 * MIN });
      await beatAfterCreation(r);
      if (cause) await sql`update fixture_stream_pairings set ended_at = ${r.deps.now()}, end_cause = ${cause} where id = ${r.paired.pairingId}`;
      const t = await tickSession(r.sessionId, r.deps, "sweep");
      if (cause) expect(t.session, `ended ${cause}`).toMatchObject({ state: "completed", endReason: "phone_lost" });
      else expect(t.session?.state, "current").toBe("warming");
      checked++;
    }
    expect(checked).toBe(causes.length);
  });

  it("two ticks in a row are idempotent: the second finds the session ended and ends nothing again", async () => {
    const r = await rig({ connectAfterMs: 10 * MIN });
    r.tick(ASK10_SILENT_MS);
    await tickSession(r.sessionId, r.deps, "sweep");
    r.tick(1000);
    const again = await tickSession(r.sessionId, r.deps, "sweep");
    expect(again.session?.state).toBe("completed");
    expect(await ends(r.sessionId)).toEqual({ transitions: 1, ended: 1 });
  });
});

// C-1 (controller ruling, B5 review): a session with NO phone — `pairing_id` null: every row open when V430 deploys, and a
// session whose fixture was deleted (T35: the code and its pairings cascade, `on delete set null`) — keeps TODAY's rules.
// Ask 10, W19 and m-5 judge a session's phone; with none they never judge it. Every expected value is a BASE rule's: the
// warming timeout from (warming_at ?? created_at), the max-duration deadline from started_at — never the tick's own.
describe.skipIf(!HAS_DB)("C-1: a session with NO phone (pairing_id null) keeps today's rules — the phone rules never judge it", () => {
  it("LEGACY warming: the organiser polls at 5 s and it is still warming (the bug ended it here); its phone connects at 30 s and the next poll takes it live", async () => {
    const r = await rig({ connectAfterMs: 30_000 });
    await asLegacy(r);
    r.tick(5000);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))?.state, "the 5 s poll").toBe("warming");
    expect((await r.row()).end_reason).toBeNull();
    r.tick(30_000 - 5000);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))?.state, "the poll once the phone sends").toBe("live");
  });

  it("LEGACY warming whose phone never sends: still warming past ask 10's silence; failed no_inbound_timeout at created_at + WARMING_TIMEOUT_MINUTES (no warming_at: the base fallback), not 1 ms before", async () => {
    const r = await rig({ connectAfterMs: 24 * 60 * MIN });
    await asLegacy(r);
    r.tick(ASK10_SILENT_MS);
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, "silent as long as ask 10's boundary").toBe("warming");
    const [{ created_at }] = await sql<{ created_at: Date }[]>`select created_at from fixture_stream_sessions where id = ${r.sessionId}`;
    r.tick(created_at.getTime() + WARMING_TIMEOUT_MINUTES * MIN - 1 - r.deps.now().getTime());
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, "1 ms before the base warming timeout").toBe("warming");
    r.tick(1);
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session).toMatchObject({ state: "failed", failReason: "no_inbound_timeout", endReason: null });
  });

  it("LEGACY live, input down and no beat ever: still LIVE past PHONE_LOST_LIVE_MINUTES (W19 never judges it); the base max-duration deadline still ends it — max_duration, not phone_lost", async () => {
    const r = await rig();
    await asLegacy(r);
    await goLive(r);
    r.ingest.setState(r.inputId, "disconnected");
    r.tick(LOST_MS);
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, "no video and no beat for the W19 limit").toBe("live");
    r.tick(LOST_MS);
    expect((await tickSession(r.sessionId, r.deps, "poll")).session?.state, "twice the limit, the organiser's poll").toBe("live");
    const [{ started_at, max_duration_minutes }] = await sql<{ started_at: Date; max_duration_minutes: number }[]>`
      select started_at, max_duration_minutes from fixture_stream_sessions where id = ${r.sessionId}`;
    r.tick(started_at.getTime() + max_duration_minutes * MIN - 1 - r.deps.now().getTime());
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, "1 ms before the base deadline").toBe("live");
    r.tick(1);
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.endReason).toBe("max_duration");
    expect(await ends(r.sessionId), "one end").toEqual({ transitions: 1, ended: 1 });
  });

  it("T35 while WARMING: the fixture is deleted, its code and pairing cascade and pairing_id is nulled — not ended at ask 10's silence; failed no_inbound_timeout at warming_at + WARMING_TIMEOUT_MINUTES, not 1 ms before", async () => {
    const r = await rig({ connectAfterMs: 24 * 60 * MIN });
    await sql`delete from fixtures where id = ${r.fixtureId}`;
    const [after] = await sql<{ fixture_id: string | null; pairing_id: string | null }[]>`select fixture_id, pairing_id from fixture_stream_sessions where id = ${r.sessionId}`;
    expect(after, "PREMISE: V410 nulled the fixture, V430 the pairing").toEqual({ fixture_id: null, pairing_id: null });
    r.tick(ASK10_SILENT_MS);
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, "silent as long as ask 10's boundary").toBe("warming");
    const deadline = await warmingDeadline(r.sessionId);
    r.tick(deadline - 1 - r.deps.now().getTime());
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, "1 ms before the base warming timeout").toBe("warming");
    r.tick(1);
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session).toMatchObject({ state: "failed", failReason: "no_inbound_timeout" });
  });
});

describe.skipIf(!HAS_DB)("W19 (§6.8.5): a live phone stream whose phone AND video are gone for PHONE_LOST_LIVE_MINUTES", () => {
  it("no beat, the fake set NOT connected, the last connected sample at exactly the limit: ended phone_lost — no refund row, no second consume", async () => {
    const r = await rig();
    await goLive(r);
    r.ingest.setState(r.inputId, "disconnected");
    r.tick(LOST_MS);
    const t = await tickSession(r.sessionId, r.deps, "sweep");
    expect(t.session).toMatchObject({ state: "completed", endReason: "phone_lost", failReason: null });
    expect(await refunds(r.sessionId), "no refund").toBe(0);
    expect(await netSpend(r.sessionId), "the one go-live consume, nothing more").toBe(-1);
    expect(await ends(r.sessionId)).toEqual({ transitions: 1, ended: 1 });
  });

  it("14 min 59 s on EACH clock alone is not ended, and one second later it is — the beat clock, then the video clock", async () => {
    let checked = 0;
    for (const clock of ["beat", "video"] as const) {
      const r = await rig();
      const live = await goLive(r);
      r.ingest.setState(r.inputId, "disconnected");
      const lastAt = new Date(live.getTime() + 1000);   // this clock's last sign of life, 1 s after first ingest
      if (clock === "beat") await sql`update fixture_stream_sessions set phone_beat_at = ${lastAt} where id = ${r.sessionId}`;
      else await connectedSampleAt(r.sessionId, lastAt);
      r.tick(LOST_MS);   // the OTHER clock is at exactly the limit; this one at the limit less a second
      expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, `${clock} at 14:59`).toBe("live");
      r.tick(1000);
      expect((await tickSession(r.sessionId, r.deps, "sweep")).session, `${clock} at 15:00`).toMatchObject({ state: "completed", endReason: "phone_lost" });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("BEATING while the input is down, for 20 min: not ended; once the beats stop, it ends exactly the limit after the last one", async () => {
    const r = await rig();
    await goLive(r);
    r.ingest.setState(r.inputId, "disconnected");
    let ticks = 0;
    for (let m = 1; m <= 20; m++) {
      r.tick(MIN);
      await sql`update fixture_stream_sessions set phone_beat_at = ${r.deps.now()} where id = ${r.sessionId}`;
      expect((await tickSession(r.sessionId, r.deps, "beat")).session?.state, `minute ${m}`).toBe("live");
      ticks++;
    }
    expect(ticks).toBe(20);
    r.tick(LOST_MS - 1);
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, "1 ms short of the limit after the last beat").toBe("live");
    r.tick(1);
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session).toMatchObject({ state: "completed", endReason: "phone_lost" });
  });

  it("SILENT while the input is connected, for 20 min: not ended — every tick's fresh read is connected", async () => {
    const r = await rig();
    await goLive(r);
    let ticks = 0;
    for (let m = 1; m <= 20; m++) {
      r.tick(MIN);
      expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, `minute ${m}`).toBe("live");
      ticks++;
    }
    expect(ticks).toBe(20);
  });

  it("the FRESH read alone holds it: both silences past the limit and a read that says connected but records no sample (a failed outputs read) — not ended; the same read saying disconnected ends it", async () => {
    let checked = 0;
    for (const word of ["connected", "disconnected"] as const) {
      const r = await rig();
      await goLive(r);
      r.ingest.setState(r.inputId, word);
      const outs = vi.spyOn(r.ingest as IngestProvider, "outputState").mockResolvedValue(null);   // m-2 (ports.ts): a failed outputs read records no sample
      try {
        r.tick(LOST_MS);
        const t = await tickSession(r.sessionId, r.deps, "sweep");
        if (word === "connected") expect(t.session?.state, "a fresh connected read").toBe("live");
        else expect(t.session).toMatchObject({ state: "completed", endReason: "phone_lost" });
        const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_samples where session_id = ${r.sessionId} and source = 'poll'`;
        expect(n, "PREMISE: only the go-live read recorded a sample").toBe(1);
        checked++;
      } finally {
        outs.mockRestore();
      }
    }
    expect(checked).toBe(2);
  });

  it("FP17, B0's freshness bound: with the claim held elsewhere, a coalesced sample 1.5 × STREAM_POLL_MS old IS the fresh read (ended); one exactly COALESCED_SAMPLE_MAX_AGE_MS old is not (W19 skips the tick)", async () => {
    const MAX_AGE = 2 * STREAM_POLL_MS;   // B0's COALESCED_SAMPLE_MAX_AGE_MS (stream-sessions.ts, I-1)
    let checked = 0;
    for (const [age, ends_] of [[1.5 * STREAM_POLL_MS, true], [MAX_AGE, false]] as const) {
      const r = await rig();
      await goLive(r);
      r.ingest.setState(r.inputId, "disconnected");
      r.tick(LOST_MS - age);
      // A claimed read records the disconnected sample this many ms before the limit.
      expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, "PREMISE: short of the limit").toBe("live");
      r.tick(age);
      await sql`update fixture_stream_sessions set ingest_polled_at = ${r.deps.now()} where id = ${r.sessionId}`;   // another caller holds the claim
      const before = await inputStatusCalls(r);
      const t = await tickSession(r.sessionId, r.deps, "sweep");
      expect(await inputStatusCalls(r) - before, "coalesced: no read").toBe(0);
      if (ends_) expect(t.session, `sample ${age} ms old`).toMatchObject({ state: "completed", endReason: "phone_lost" });
      else expect(t.session?.state, `sample ${age} ms old`).toBe("live");
      checked++;
    }
    expect(checked).toBe(2);
    expect(1.5 * STREAM_POLL_MS > STREAM_POLL_MS, "the case differs from a 1× bound's answer").toBe(true);
  });

  it("m-3 (controller ruling): an UNKNOWN read never advances a phone-lost end — a W19-due session read `unknown` stays live, CLAIMED or COALESCED; the same read `disconnected` ends it phone_lost", async () => {
    let checked = 0;
    for (const path of ["claimed", "coalesced"] as const) {
      for (const word of ["unknown", "disconnected"] as const) {
        const label = `${path} ${word}`;
        const r = await rig();
        await goLive(r);
        r.ingest.setState(r.inputId, word);
        let t;
        if (path === "claimed") {
          r.tick(LOST_MS);
          const before = await inputStatusCalls(r);
          t = await tickSession(r.sessionId, r.deps, "sweep");
          expect(await inputStatusCalls(r) - before, `PREMISE ${label}: this tick read`).toBe(1);
        } else {
          r.tick(LOST_MS - 1000);
          expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, `PREMISE ${label}: short of the limit`).toBe("live");
          const [last] = await sql<{ ingest_state: string }[]>`
            select ingest_state from fixture_stream_samples where session_id = ${r.sessionId} and source = 'poll' order by sampled_at desc limit 1`;
          expect(last!.ingest_state, `PREMISE ${label}: the sample carries the word`).toBe(word);
          r.tick(1000);
          await sql`update fixture_stream_sessions set ingest_polled_at = ${r.deps.now()} where id = ${r.sessionId}`;   // another caller holds the claim
          const before = await inputStatusCalls(r);
          t = await tickSession(r.sessionId, r.deps, "sweep");
          expect(await inputStatusCalls(r) - before, `PREMISE ${label}: served, not read`).toBe(0);
        }
        if (word === "unknown") {
          expect(t.session?.state, label).toBe("live");
          expect(await ends(r.sessionId), `${label}: no end`).toEqual({ transitions: 0, ended: 0 });
        } else {
          expect(t.session, label).toMatchObject({ state: "completed", endReason: "phone_lost" });
        }
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("two ticks AT ONCE on one W19-due session end it exactly once, with one end event — both judge it due (a fresh coalesced sample), one decision lands", async () => {
    const r = await rig();
    await goLive(r);
    r.ingest.setState(r.inputId, "disconnected");
    r.tick(LOST_MS - 1000);
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, "PREMISE: a claimed read 1 s short of the limit").toBe("live");
    r.tick(1000);
    // Both inside the claim window of that read: neither reads, both are served its sample (1 s old: fresh) and both find W19 due.
    const before = await inputStatusCalls(r);
    const both = await Promise.all([tickSession(r.sessionId, r.deps, "sweep"), tickSession(r.sessionId, r.deps, "beat")]);
    expect(await inputStatusCalls(r) - before, "PREMISE: both coalesced").toBe(0);
    expect(both.every((t) => t.session !== null)).toBe(true);
    expect((await r.row())).toMatchObject({ state: "completed", end_reason: "phone_lost" });
    expect(await ends(r.sessionId)).toEqual({ transitions: 1, ended: 1 });
    expect(await netSpend(r.sessionId)).toBe(-1);
  });

  it("a tick racing a phone BEAT: the beat lands after the tick judged the session due and before its end decision locks the row — the decision is re-taken on the LOCKED row, and the session lives", async () => {
    const r = await rig();
    await goLive(r);
    r.ingest.setState(r.inputId, "disconnected");
    r.tick(LOST_MS);
    // `apply` takes the org's money lock first (A7). A live session's tick applies twice: the reconcile's expiry (1st), then
    // the end decision (2nd) — so the beat lands at the 2nd, after the tick's unlocked read judged W19 due.
    let applies = 0;
    hook.onLockOrg = async () => {
      applies++;
      if (applies === 2) await sql`update fixture_stream_sessions set phone_beat_at = ${r.deps.now()} where id = ${r.sessionId}`;
    };
    try {
      expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state).toBe("live");
    } finally {
      hook.onLockOrg = null;
    }
    expect(applies, "PREMISE: the reconcile's apply, then the end decision's").toBe(2);
    expect(await ends(r.sessionId)).toEqual({ transitions: 0, ended: 0 });
  });
});

describe.skipIf(!HAS_DB)("m-5 (controller ruling): a PASSTHROUGH session live with no first_ingest_at is judged by the warming rule", () => {
  it("before warming_at + WARMING_TIMEOUT_MINUTES it is still open; at it, it is failed no_inbound_timeout", async () => {
    const r = await rig();
    await goLive(r);
    const [{ warming_at }] = await sql<{ warming_at: Date }[]>`select warming_at from fixture_stream_sessions where id = ${r.sessionId}`;
    // The row D3 admits: live, no first ingest recorded. The phone stays away, so no read records one.
    await sql`update fixture_stream_sessions set first_ingest_at = null where id = ${r.sessionId}`;
    r.ingest.setState(r.inputId, "disconnected");
    const deadline = warming_at.getTime() + WARMING_TIMEOUT_MINUTES * MIN;
    r.tick(deadline - 1 - r.deps.now().getTime());
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, "1 ms before the warming deadline").toBe("live");
    r.tick(1);
    const t = await tickSession(r.sessionId, r.deps, "sweep");
    expect(t.session).toMatchObject({ state: "failed", failReason: "no_inbound_timeout", endReason: null });
    expect(await ends(r.sessionId)).toEqual({ transitions: 1, ended: 1 });
  });

  it("a COMPOSED live session (which never records first ingest) is NOT ended at its warming deadline — the guard's positive pair", async () => {
    const r = await rig({ mode: "composed" });
    await heartbeat(r.sessionId, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
    expect(await r.row()).toMatchObject({ state: "live", first_ingest_at: null });
    const [{ warming_at }] = await sql<{ warming_at: Date }[]>`select warming_at from fixture_stream_sessions where id = ${r.sessionId}`;
    r.tick(warming_at.getTime() + WARMING_TIMEOUT_MINUTES * MIN + MIN - r.deps.now().getTime());
    await heartbeat(r.sessionId, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);   // the Machine is healthy
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session).toMatchObject({ state: "live", failReason: null });
  });
});

// T9 (W24, §6.12): `current` carries the countdown to the end the tick will make. It lives HERE, beside the tick it must
// agree with (the brief named stream-sessions.test.ts; this file holds the W19 rig and its clocks — one rig, not two).
// Every expected value is the spec's arithmetic over the clocks this file wrote (PHONE_LOST_LIVE_MINUTES,
// RECONNECT_QUIET_SECONDS, WARMING_TIMEOUT_MINUTES); the AGREEMENT is checked against the real tick, never lostCountdown.
describe.skipIf(!HAS_DB)("W24 (§6.12, T9): current's countdown agrees with the tick's own end", () => {
  const QUIET_MS = RECONNECT_QUIET_SECONDS * 1000;
  const countdownOf = async (r: Rig) => (await currentSession(r.auth, r.fixtureId, r.deps))!.countdown;

  it("LIVE, input down, phone silent: none inside RECONNECT_QUIET_SECONDS of the SHORTER silence; at it, a live countdown — and a tick at now + remainingMs ends it phone_lost, one 1 s earlier does not", async () => {
    const r = await rig();
    const live = await goLive(r);
    r.ingest.setState(r.inputId, "disconnected");
    // Video last seen 30 s after go-live; the phone beat for another minute, so the BEAT clock is the shorter silence.
    await connectedSampleAt(r.sessionId, new Date(live.getTime() + 30_000));
    const lastBeat = new Date(live.getTime() + 90_000);
    await sql`update fixture_stream_sessions set phone_beat_at = ${lastBeat} where id = ${r.sessionId}`;
    r.tick(lastBeat.getTime() + QUIET_MS - 1 - r.deps.now().getTime());
    expect(await countdownOf(r), "1 ms inside the quiet hold").toBeNull();
    r.tick(STREAM_POLL_MS);   // a fresh claim window: this poll reads the input again
    const elapsedMs = r.deps.now().getTime() - lastBeat.getTime();
    const c = await countdownOf(r);
    expect(c).toEqual({ kind: "live", reason: "phone_lost", elapsedMs, remainingMs: LOST_MS - elapsedMs });
    r.tick(c!.remainingMs - 1000);
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, "1 s before the countdown's end").toBe("live");
    r.tick(1000);
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session, "at the countdown's end").toMatchObject({ state: "completed", endReason: "phone_lost" });
  });

  it("O5: a phone that still BEATS while the input is down has no countdown, even 20 min on (W19 cannot fire); a connected input has none either", async () => {
    const r = await rig();
    await goLive(r);
    r.ingest.setState(r.inputId, "disconnected");
    for (let m = 1; m <= 20; m++) {
      r.tick(MIN);
      await sql`update fixture_stream_sessions set phone_beat_at = ${r.deps.now()} where id = ${r.sessionId}`;
    }
    expect(await countdownOf(r), "beating").toBeNull();
    const silentButStreaming = await rig();
    await goLive(silentButStreaming);
    silentButStreaming.tick(20 * MIN);
    expect(await countdownOf(silentButStreaming), "the input is connected").toBeNull();
    // The read ITSELF holds it, not only the sample it records: a connected read whose outputs read failed records no
    // sample (m-2), so both stored silences are 5 min old (past the quiet hold, short of W19's limit, which would end the
    // session on this very poll) — still no countdown; the same read saying disconnected shows one (the positive pair).
    let checked = 0;
    for (const word of ["connected", "disconnected"] as const) {
      const q = await rig();
      await goLive(q);
      q.ingest.setState(q.inputId, word);
      const outs = vi.spyOn(q.ingest as IngestProvider, "outputState").mockResolvedValue(null);   // m-2: no sample recorded
      try {
        q.tick(5 * MIN);
        const c = await countdownOf(q);
        if (word === "connected") expect(c, "a fresh connected read, no sample").toBeNull();
        else expect(c?.kind, "a fresh disconnected read").toBe("live");
        const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_samples where session_id = ${q.sessionId} and source = 'poll'`;
        expect(n, "PREMISE: only the go-live read recorded a sample").toBe(1);
        checked++;
      } finally {
        outs.mockRestore();
      }
    }
    expect(checked).toBe(2);
  });

  it("WARMING (no video yet): after the quiet hold, remainingMs runs to warming_at + WARMING_TIMEOUT_MINUTES — and the tick fails it no_inbound_timeout exactly there, not 1 ms before", async () => {
    const r = await rig({ connectAfterMs: 60 * MIN });
    const [{ warming_at }] = await sql<{ warming_at: Date }[]>`select warming_at from fixture_stream_sessions where id = ${r.sessionId}`;
    const deadline = warming_at.getTime() + WARMING_TIMEOUT_MINUTES * MIN;
    // The phone keeps beating (ask 10 must not end it first): its pairing's last beat moves with the clock.
    const keepBeating = () => sql`update fixture_stream_pairings set last_beat_at = ${r.deps.now()} where id = ${r.paired.pairingId}`;
    r.tick(warming_at.getTime() + QUIET_MS - 1 - r.deps.now().getTime());
    await keepBeating();
    expect(await countdownOf(r), "1 ms inside the quiet hold").toBeNull();
    r.tick(1);
    await keepBeating();
    const c = await countdownOf(r);
    expect(c).toEqual({ kind: "warming", reason: "no_inbound_timeout", elapsedMs: QUIET_MS, remainingMs: deadline - r.deps.now().getTime() });
    r.tick(c!.remainingMs - 1);
    await keepBeating();
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, "1 ms before the countdown's end").toBe("warming");
    r.tick(1);
    await keepBeating();
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session).toMatchObject({ state: "failed", failReason: "no_inbound_timeout" });
  });

  it("C-1: a LEGACY live session (no phone) shows NO countdown where the same session WITH its phone shows one (the positive pair)", async () => {
    let checked = 0;
    for (const legacy of [false, true]) {
      const r = await rig();
      await goLive(r);
      r.ingest.setState(r.inputId, "disconnected");
      if (legacy) await asLegacy(r);
      r.tick(5 * MIN);
      const c = await countdownOf(r);
      if (legacy) expect(c, "no phone: today's panel, no countdown").toBeNull();
      else expect(c?.kind, "with its phone: the live countdown").toBe("live");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("I-1 (B7 review, controller ruling): an UNKNOWN read shows NO countdown — CLAIMED by this poll or CARRIED from another's sample — where the same read `disconnected` shows the live one; past the limit the unknown session stays live through a poll and a sweep and still shows none (m-3: W19 will not end it)", async () => {
    let checked = 0;
    for (const path of ["claimed", "carried"] as const) {
      for (const word of ["unknown", "disconnected"] as const) {
        const label = `${path} ${word}`;
        const r = await rig();
        await goLive(r);
        r.ingest.setState(r.inputId, word);
        if (path === "claimed") {
          r.tick(5 * MIN);
        } else {
          r.tick(5 * MIN - 1000);
          expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, `PREMISE ${label}: short of the limit`).toBe("live");
          r.tick(1000);
          await sql`update fixture_stream_sessions set ingest_polled_at = ${r.deps.now()} where id = ${r.sessionId}`;   // another caller holds the claim
        }
        const before = await inputStatusCalls(r);
        const cur = (await currentSession(r.auth, r.fixtureId, r.deps))!;
        expect(await inputStatusCalls(r) - before, `PREMISE ${label}: ${path === "claimed" ? "this poll read" : "served, not read"}`).toBe(path === "claimed" ? 1 : 0);
        expect(cur.ingest?.state, `PREMISE ${label}: current carries the word`).toBe(word);
        if (word === "unknown") expect(cur.countdown, label).toBeNull();
        else expect(cur.countdown, label).toMatchObject({ kind: "live" });
        checked++;
      }
    }
    expect(checked).toBe(4);
    const r = await rig();
    await goLive(r);
    r.ingest.setState(r.inputId, "unknown");
    r.tick(LOST_MS + MIN);
    expect(await countdownOf(r), "unknown, a minute past W19's limit: nothing to count down to").toBeNull();
    expect((await tickSession(r.sessionId, r.deps, "poll")).session?.state, "the poll does not end it").toBe("live");
    await tickOpenSessions(r.deps, { orgIds: [r.auth.orgId] });
    const [{ state }] = await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${r.sessionId}`;
    expect(state, "nor does the sweep").toBe("live");
    expect(await countdownOf(r), "still none").toBeNull();
  });

  it("I-1: a FAILED read (inputStatus throws: `ingest` null) shows NO countdown, live or warming, where the same sessions read `disconnected` show one (the positive pair)", async () => {
    let checked = 0;
    for (const kind of ["live", "warming"] as const) {
      for (const fails of [false, true]) {
        const label = `${kind}${fails ? ", the read throws" : ", disconnected"}`;
        const r = kind === "live" ? await rig() : await rig({ connectAfterMs: 60 * MIN });
        if (kind === "live") {
          await goLive(r);
          r.ingest.setState(r.inputId, "disconnected");
        }
        r.tick(5 * MIN);
        // ask 10 must not end the warming one first: its phone keeps beating.
        await sql`update fixture_stream_pairings set last_beat_at = ${r.deps.now()} where id = ${r.paired.pairingId}`;
        const read = fails ? vi.spyOn(r.ingest as IngestProvider, "inputStatus").mockRejectedValue(new Error("cloudflare: 503")) : null;
        try {
          const cur = (await currentSession(r.auth, r.fixtureId, r.deps))!;
          expect(cur.state, `PREMISE ${label}`).toBe(kind);
          if (fails) {
            expect(read!.mock.calls.length, `PREMISE ${label}: the read was attempted`).toBeGreaterThan(0);
            expect(cur.ingest, `PREMISE ${label}: no word`).toBeNull();
            expect(cur.countdown, label).toBeNull();
          } else {
            expect(cur.countdown, label).toMatchObject({ kind });
          }
        } finally {
          read?.mockRestore();
        }
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  // Controller ruling 2026-10-04: `current` shows a countdown IF AND ONLY IF the end it counts down to fires at that
  // deadline. Each case is ONE session under ONE read condition, held from the poll through the tick at the rule's
  // deadline. The countdown is read off the poll and the end off that tick, and the assertion is their AGREEMENT, never a
  // table of which cases should show. Both sides must occur, or the iff was checked on one side only.
  type Hold = {
    label: string; word?: IngestState; carried?: boolean; status?: "no-evidence" | "throws"; outputsThrow?: boolean; beats?: boolean;
    /** PREMISE: what `current.ingest` serves under this condition (null = no word). */
    served: IngestState | null;
  };
  const NO_EVIDENCE: IngestStatus = { state: null, protocol: null, enteredAt: null, lastSeenAt: null, reason: null };

  /** Holds `h` on `r` for every read from `install()` on. `at(t)` moves the clock to `t` and readies the next read there:
   *  a CLAIMED read (the claim reset, so the read is this one's own), or, carried, a coalesced one served from the sample
   *  a claimed read wrote 1 s before. The phone beats at each instant `keepBeating` is given (a no-op when it does not). */
  function holding(r: Rig, h: Hold, keepBeating: () => Promise<unknown>) {
    const spies: { mockRestore(): void }[] = [];
    return {
      install: () => {
        if (h.status === "no-evidence") spies.push(vi.spyOn(r.ingest as IngestProvider, "inputStatus").mockResolvedValue(NO_EVIDENCE));
        if (h.status === "throws") spies.push(vi.spyOn(r.ingest as IngestProvider, "inputStatus").mockRejectedValue(new Error("cloudflare: 503")));
        if (h.outputsThrow) spies.push(vi.spyOn(r.ingest as IngestProvider, "outputState").mockRejectedValue(new Error("cloudflare: 503")));
      },
      at: async (t: number) => {
        r.tick(t - (h.carried ? 1000 : 0) - r.deps.now().getTime());
        await sql`update fixture_stream_sessions set ingest_polled_at = null where id = ${r.sessionId}`;
        await keepBeating();
        if (!h.carried) return;
        await tickSession(r.sessionId, r.deps, "sweep");   // the claimed read whose sample the next read is served
        r.tick(1000);
        await sql`update fixture_stream_sessions set ingest_polled_at = ${r.deps.now()} where id = ${r.sessionId}`;   // another caller holds the claim
        await keepBeating();
      },
      restore: () => { for (const s of spies) s.mockRestore(); },
    };
  }

  it("W24 ⇔ W19: under every read condition the tick meets, the LIVE countdown shows exactly when the tick at its end ends the session phone_lost — a fresh `disconnected` only (m-3), never a carried word, a failed read or a beating phone", async () => {
    const cases: Hold[] = [
      { label: "claimed disconnected", word: "disconnected", served: "disconnected" },
      { label: "claimed unknown", word: "unknown", served: "unknown" },
      { label: "carried disconnected", word: "disconnected", carried: true, served: "disconnected" },
      { label: "carried unknown", word: "unknown", carried: true, served: "unknown" },
      { label: "no-evidence read carrying disconnected (G-a)", word: "disconnected", status: "no-evidence", served: "disconnected" },
      { label: "the status read throws", word: "disconnected", status: "throws", served: null },
      { label: "the outputs read throws", word: "disconnected", outputsThrow: true, served: null },
      { label: "disconnected, the phone still beats (O5)", word: "disconnected", beats: true, served: "disconnected" },
    ];
    const seen = { shown: 0, none: 0 };
    for (const h of cases) {
      const r = await rig();
      const live = await goLive(r);
      // Both of W19's clocks start at go-live: the last beat and the last connected sample.
      await sql`update fixture_stream_sessions set phone_beat_at = ${live} where id = ${r.sessionId}`;
      await connectedSampleAt(r.sessionId, live);
      const deadline = live.getTime() + LOST_MS;
      const beat = () => (h.beats ? sql`update fixture_stream_sessions set phone_beat_at = ${r.deps.now()} where id = ${r.sessionId}` : Promise.resolve());
      const hold = holding(r, h, beat);
      if (h.word) r.ingest.setState(r.inputId, h.word);
      if (h.status === "no-evidence") {
        r.tick(5 * MIN);
        await tickSession(r.sessionId, r.deps, "sweep");   // a real read records `disconnected`: the word the no-evidence reads carry
      }
      hold.install();
      try {
        await hold.at(live.getTime() + 10 * MIN);
        const cur = (await currentSession(r.auth, r.fixtureId, r.deps))!;
        expect(cur.ingest?.state ?? null, `PREMISE ${h.label}: the word served`).toBe(h.served);
        const c = cur.countdown;
        if (c) {
          expect([c.kind, c.reason], h.label).toEqual(["live", "phone_lost"]);
          expect(r.deps.now().getTime() + c.remainingMs, `${h.label}: the countdown names W19's deadline`).toBe(deadline);
        }
        const phoneLost = (s: Awaited<ReturnType<typeof tickSession>>["session"]) => s?.state === "completed" && s.endReason === "phone_lost";
        await hold.at(deadline - 1000);
        expect(phoneLost((await tickSession(r.sessionId, r.deps, "sweep")).session), `${h.label}: 1 s before the deadline`).toBe(false);
        await hold.at(deadline);
        const end = (await tickSession(r.sessionId, r.deps, "sweep")).session;
        expect(phoneLost(end), `${h.label}: countdown ${c ? "shown" : "none"}, the tick at W19's deadline left ${end?.state}/${end?.endReason}`).toBe(c !== null);
        if (c) seen.shown++; else seen.none++;
      } finally {
        hold.restore();
      }
    }
    expect(seen.shown, "anti-vacuity: some case showed one").toBeGreaterThan(0);
    expect(seen.none, "anti-vacuity: some case showed none").toBeGreaterThan(0);
    expect(seen.shown + seen.none).toBe(cases.length);
  });

  it("W24 ⇔ the EARLIEST warming end (controller ruling 2026-10-04): under every read condition and every beat pattern, the warming countdown names an end and its reason exactly when the tick at that instant makes it — the timeout whatever the word (M-4, held only by a status read that throws, N1), or ask 10 once beats have stopped, whichever lands first", async () => {
    // `phone`: "beats" at every instant (ask 10 out of reach); "silent" since the rig paired it, before the session was
    // created (it has not heard go-live); or one beat `stopAt` after warming entry (it has heard go-live), then silent.
    // `pollAfter` is when the countdown is read: after warming entry for a beating phone, after the last beat otherwise.
    type Row = Hold & { phone: "beats" | "silent" | { stopAt: number }; pollAfter: number };
    const cases: Row[] = [
      { label: "claimed disconnected", served: "disconnected", phone: "beats", pollAfter: 5 * MIN },
      { label: "claimed unknown", word: "unknown", served: "unknown", phone: "beats", pollAfter: 5 * MIN },
      { label: "carried unknown", word: "unknown", carried: true, served: "unknown", phone: "beats", pollAfter: 5 * MIN },
      { label: "no-evidence read with nothing to carry", status: "no-evidence", served: null, phone: "beats", pollAfter: 5 * MIN },
      { label: "the status read throws", status: "throws", served: null, phone: "beats", pollAfter: 5 * MIN },
      { label: "the outputs read throws (the status read answers)", outputsThrow: true, served: null, phone: "beats", pollAfter: 5 * MIN },
      { label: "silent since pairing, disconnected", served: "disconnected", phone: "silent", pollAfter: 75_000 },
      { label: "silent since pairing, the status read throws", status: "throws", served: null, phone: "silent", pollAfter: 75_000 },
      { label: "silent since pairing, no-evidence read", status: "no-evidence", served: null, phone: "silent", pollAfter: 75_000 },
      { label: "heard go-live, silent from +20 s, unknown", word: "unknown", served: "unknown", phone: { stopAt: 20_000 }, pollAfter: 45_000 },
      { label: "heard go-live, silent from +9:20, disconnected", served: "disconnected", phone: { stopAt: 9 * MIN + 20_000 }, pollAfter: 35_000 },
      { label: "heard go-live, silent from +9:20, the status read throws", status: "throws", served: null, phone: { stopAt: 9 * MIN + 20_000 }, pollAfter: 35_000 },
    ];
    type S = Awaited<ReturnType<typeof tickSession>>["session"];
    /** The end the tick made, as the countdown names it: a failure's reason or a completion's; null = still open. */
    const endOf = (x: S) => (x === null ? "no session" : x.state === "failed" ? x.failReason : x.state === "completed" ? x.endReason : null);
    const seen = { no_inbound_timeout: 0, phone_lost: 0, none: 0 };
    for (const h of cases) {
      const r = await rig({ connectAfterMs: 60 * MIN });   // the phone never connects: FakeIngest reads it disconnected
      const [{ warming_at, created_at }] = await sql<{ warming_at: Date; created_at: Date }[]>`
        select warming_at, created_at from fixture_stream_sessions where id = ${r.sessionId}`;
      const deadline = warming_at.getTime() + WARMING_TIMEOUT_MINUTES * MIN;
      if (typeof h.phone === "object") {
        r.tick(warming_at.getTime() + h.phone.stopAt - r.deps.now().getTime());
        await sql`update fixture_stream_pairings set last_beat_at = ${r.deps.now()} where id = ${r.paired.pairingId}`;
        expect(r.deps.now().getTime(), `PREMISE ${h.label}: the beat is after creation, so the phone has heard go-live`).toBeGreaterThan(created_at.getTime());
      }
      const [{ last_beat_at }] = await sql<{ last_beat_at: Date }[]>`select last_beat_at from fixture_stream_pairings where id = ${r.paired.pairingId}`;
      if (h.phone === "silent") expect(last_beat_at.getTime(), `PREMISE ${h.label}: the last beat predates creation`).toBeLessThan(created_at.getTime());
      const beat = () => (h.phone === "beats" ? sql`update fixture_stream_pairings set last_beat_at = ${r.deps.now()} where id = ${r.paired.pairingId}` : Promise.resolve());
      const hold = holding(r, h, beat);
      if (h.word) r.ingest.setState(r.inputId, h.word);
      hold.install();
      try {
        await hold.at((h.phone === "beats" ? warming_at.getTime() : last_beat_at.getTime()) + h.pollAfter);
        const cur = (await currentSession(r.auth, r.fixtureId, r.deps))!;
        expect(cur.state, `PREMISE ${h.label}`).toBe("warming");
        expect(cur.ingest?.state ?? null, `PREMISE ${h.label}: the word served`).toBe(h.served);
        const c = cur.countdown;
        if (c) {
          expect(c.kind, h.label).toBe("warming");
          const at = r.deps.now().getTime() + c.remainingMs;
          await hold.at(at - 1000);
          const early = (await tickSession(r.sessionId, r.deps, "sweep")).session;
          expect(endOf(early), `${h.label}: 1 s before the countdown's end (${c.reason}) it is still open`).toBeNull();
          await hold.at(at);
          const end = (await tickSession(r.sessionId, r.deps, "sweep")).session;
          expect(endOf(end), `${h.label}: the tick at the countdown's end makes the end it named`).toBe(c.reason);
          seen[c.reason as "no_inbound_timeout" | "phone_lost"]++;   // `warming` only counts down these two (asserted just above)
        } else {
          // Nothing named: nothing may fire, out to past every end these clocks can make.
          await hold.at(deadline + ASK10_SILENT_MS + MIN);
          const later = (await tickSession(r.sessionId, r.deps, "sweep")).session;
          expect(endOf(later), `${h.label}: no countdown, so no end`).toBeNull();
          seen.none++;
        }
      } finally {
        hold.restore();
      }
    }
    expect(seen.no_inbound_timeout, "anti-vacuity: the timeout was named").toBeGreaterThan(0);
    expect(seen.phone_lost, "anti-vacuity: ask 10 was named").toBeGreaterThan(0);
    expect(seen.none, "anti-vacuity: some case named none").toBeGreaterThan(0);
    expect(seen.no_inbound_timeout + seen.phone_lost + seen.none).toBe(cases.length);
  });

  it("m-a through the poll: a far-cadence phone right after Go live, its go-live beat in flight → NO countdown; the same beat a full near poll late → phone_lost at its deadline; the beat lands → gone, and nothing ends there", async () => {
    const r = await rig({ connectAfterMs: 60 * MIN });
    const [{ warming_at, created_at }] = await sql<{ warming_at: Date; created_at: Date }[]>`
      select warming_at, created_at from fixture_stream_sessions where id = ${r.sessionId}`;
    // Polled 2 s after warming entry. The phone has not heard go-live, so it is on its waiting (far) cadence: its last beat
    // was one cadence plus a 3 s round trip before the poll, and the beat that hears go-live is due now.
    const poll = warming_at.getTime() + 2000;
    const lastBeat = new Date(poll - (POLL_FAR_SECONDS + 3) * 1000);
    await sql`update fixture_stream_pairings set last_beat_at = ${lastBeat}, answered_poll_seconds = ${POLL_FAR_SECONDS} where id = ${r.paired.pairingId}`;
    expect(lastBeat.getTime(), "PREMISE: the last beat predates creation, so the phone has not heard go-live").toBeLessThan(created_at.getTime());
    const at = async (t: number) => {
      r.tick(t - r.deps.now().getTime());
      await sql`update fixture_stream_sessions set ingest_polled_at = null where id = ${r.sessionId}`;
    };
    await at(poll);
    const inFlight = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect([inFlight.state, inFlight.countdown], "the go-live beat in flight: no countdown").toEqual(["warming", null]);
    await at(lastBeat.getTime() + (POLL_FAR_SECONDS + POLL_NEAR_SECONDS) * 1000);
    const late = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(late.countdown?.reason, "a full near poll late: ask 10 is armed").toBe("phone_lost");
    expect(r.deps.now().getTime() + late.countdown!.remainingMs, "it names ask 10's deadline").toBe(lastBeat.getTime() + ASK10_SILENT_MS);
    await sql`update fixture_stream_pairings set last_beat_at = ${r.deps.now()} where id = ${r.paired.pairingId}`;   // the beat lands
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.countdown, "the beat landed: nothing armed, inside the warming hold").toBeNull();
    await at(lastBeat.getTime() + ASK10_SILENT_MS);
    const kept = (await tickSession(r.sessionId, r.deps, "sweep")).session;
    expect([kept?.state, kept?.endReason ?? null], "the old deadline passes: nothing ends").toEqual(["warming", null]);
  });

  it("the outage gap (B7 re-review): a LONE tab whose polls coalesce onto the beating phone's claimed reads during a Cloudflare outage holds the warming countdown exactly as a claimed failed read does — with a fresh sample to serve and with none — and shows the timeout again once a claimed read answers; the tick agrees at the deadline", async () => {
    const r = await rig({ connectAfterMs: 60 * MIN });   // the phone never connects: FakeIngest reads it disconnected
    const [{ warming_at }] = await sql<{ warming_at: Date }[]>`select warming_at from fixture_stream_sessions where id = ${r.sessionId}`;
    const W = warming_at.getTime();
    const deadline = W + WARMING_TIMEOUT_MINUTES * MIN;
    const to = (t: number) => r.tick(t - r.deps.now().getTime());
    // The session's phone beats, and every beat ticks the session (§6.11), so its tick can claim the interval's read.
    const beat = async (t: number) => {
      to(t);
      await sql`update fixture_stream_pairings set last_beat_at = ${r.deps.now()} where id = ${r.paired.pairingId}`;
      await tickSession(r.sessionId, r.deps, "beat");
    };
    const poll = async (t: number) => {
      to(t);
      await sql`update fixture_stream_pairings set last_beat_at = ${r.deps.now()} where id = ${r.paired.pairingId}`;   // still beating
      return (await currentSession(r.auth, r.fixtureId, r.deps))!;
    };
    const flag = async () => (await sql<{ f: boolean }[]>`select ingest_read_failed as f from fixture_stream_sessions where id = ${r.sessionId}`)[0]!.f;
    const steps: string[] = [];

    // Before the outage: the tab's own claimed read answers `disconnected`, past the warming hold → the timeout shows.
    await sql`update fixture_stream_sessions set ingest_polled_at = null where id = ${r.sessionId}`;
    const before = await poll(W + 115_000);
    expect(before.countdown, "before the outage").toMatchObject({ kind: "warming", reason: "no_inbound_timeout" });
    expect(r.deps.now().getTime() + before.countdown!.remainingMs).toBe(deadline);
    expect(await flag(), "a claimed read that answered").toBe(false);

    const outage = vi.spyOn(r.ingest as IngestProvider, "inputStatus").mockRejectedValue(new Error("cloudflare: 503"));
    try {
      await beat(W + 120_000);   // the beat's tick claims the read (the tab's claim is 5 s old) and it throws
      const fresh = await poll(W + 121_000);   // coalesced: the 1:55 sample is 6 s old, young enough to serve
      expect([fresh.countdown, fresh.ingest], "coalesced, a fresh sample to serve: held, and served as the failed read").toEqual([null, null]);
      expect(await flag(), "the beat's claimed read threw").toBe(true);
      steps.push("coalesced-fresh-sample");
      const own = await poll(W + 126_000);     // the tab's own claim, failing too
      expect(own.countdown, "the tab's own failed read: held (N1)").toBeNull();
      steps.push("claimed");
      await beat(W + 130_000);
      const stale = await poll(W + 131_000);   // coalesced: no sample young enough
      expect(stale.countdown, "coalesced, nothing to serve: held").toBeNull();
      steps.push("coalesced-no-sample");
    } finally {
      outage.mockRestore();
    }

    // The outage ends: the beat's claimed read answers, the flag clears, and the tab's coalesced poll shows the timeout.
    await beat(W + 180_000);
    const after = await poll(W + 181_000);
    expect(after.countdown, "after the outage (coalesced)").toMatchObject({ kind: "warming", reason: "no_inbound_timeout" });
    expect(await flag(), "a claimed read answered again").toBe(false);
    expect(r.deps.now().getTime() + after.countdown!.remainingMs, "it names the warming deadline").toBe(deadline);
    steps.push("recovered");
    // The iff at the deadline, the phone beating throughout: 1 s before it, still warming; at it, the timeout ends it.
    await beat(deadline - 1000);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state, "1 s before").toBe("warming");
    to(deadline);
    await sql`update fixture_stream_sessions set ingest_polled_at = null where id = ${r.sessionId}`;
    const end = (await tickSession(r.sessionId, r.deps, "sweep")).session;
    expect([end?.state, end?.failReason ?? end?.endReason], "the deadline").toEqual(["failed", "no_inbound_timeout"]);
    expect(steps, "every leg ran").toEqual(["coalesced-fresh-sample", "claimed", "coalesced-no-sample", "recovered"]);
  });

  it("ask 10 reads no ingest word: under every read condition a warming session whose phone stops beating ends phone_lost at its silence deadline, and the same session whose phone beats does not (the pair) — so no read gate touches it", async () => {
    const cases: Hold[] = [
      { label: "disconnected", served: "disconnected" },
      { label: "unknown", word: "unknown", served: "unknown" },
      { label: "no-evidence read with nothing to carry", status: "no-evidence", served: null },
      { label: "the status read throws", status: "throws", served: null },
    ];
    const seen = { ended: 0, kept: 0 };
    for (const h of cases) {
      for (const beats of [false, true]) {
        const label = `${h.label}, the phone ${beats ? "beats" : "is silent"}`;
        const r = await rig({ connectAfterMs: 60 * MIN });
        const [{ last_beat_at }] = await sql<{ last_beat_at: Date }[]>`select last_beat_at from fixture_stream_pairings where id = ${r.paired.pairingId}`;
        const deadline = last_beat_at.getTime() + ASK10_SILENT_MS;
        const beat = () => (beats ? sql`update fixture_stream_pairings set last_beat_at = ${r.deps.now()} where id = ${r.paired.pairingId}` : Promise.resolve());
        const hold = holding(r, { ...h, beats }, beat);
        if (h.word) r.ingest.setState(r.inputId, h.word);
        hold.install();
        try {
          const phoneLost = (s: Awaited<ReturnType<typeof tickSession>>["session"]) => s?.state === "completed" && s.endReason === "phone_lost";
          await hold.at(deadline - 1000);
          const early = (await currentSession(r.auth, r.fixtureId, r.deps))!;
          expect(early.ingest?.state ?? null, `PREMISE ${label}: the word served`).toBe(h.served);
          expect(early.state, `${label}: 1 s before the deadline`).toBe("warming");
          await hold.at(deadline);
          const end = (await tickSession(r.sessionId, r.deps, "sweep")).session;
          expect(phoneLost(end), `${label}: left ${end?.state}/${end?.endReason}`).toBe(!beats);
          if (beats) seen.kept++; else seen.ended++;
        } finally {
          hold.restore();
        }
      }
    }
    expect(seen).toEqual({ ended: cases.length, kept: cases.length });
  });
});

describe.skipIf(!HAS_DB)("another sport: the tick reads no sport — W19 and ask 10 end every catalogued sport's session alike", () => {
  it("each sport in the catalog: ask 10 ends a silent warming session and W19 a gone live one", async () => {
    const sports = (await sql<{ key: string }[]>`select key from sports where key <> 'generic' order by key`).map((s) => s.key);
    expect(sports.length, "PREMISE: the catalog is synced (sync:sports)").toBeGreaterThanOrEqual(2);
    let checked = 0;
    for (const sport of sports) {
      const w = await rig({ sport, connectAfterMs: 10 * MIN });
      w.tick(ASK10_SILENT_MS);
      expect((await tickSession(w.sessionId, w.deps, "sweep")).session, `${sport} ask 10`).toMatchObject({ state: "completed", endReason: "phone_lost" });
      const l = await rig({ sport });
      await goLive(l);
      l.ingest.setState(l.inputId, "disconnected");
      l.tick(LOST_MS);
      expect((await tickSession(l.sessionId, l.deps, "sweep")).session, `${sport} W19`).toMatchObject({ state: "completed", endReason: "phone_lost" });
      const [{ sport_key }] = await sql<{ sport_key: string }[]>`select sport_key from fixture_stream_sessions where id = ${l.sessionId}`;
      expect(sport_key, "PREMISE: the session carries the sport").toBe(sport);
      checked++;
    }
    expect(checked).toBe(sports.length);
  });
});

/** W22: several sessions, each in its own org, on ONE deps — one clock, one fake ingest, one runner — as one stream-tick
 *  pass meets them. `orgIds` is the test-only scope (the cron route passes none, route.test.ts pins it). */
function fleet(connectAfterMs = CONNECT_AFTER_MS) {
  const c = clockedDeps(connectAfterMs);
  const sessions: Awaited<ReturnType<typeof seedSession>>[] = [];
  return {
    ...c,
    add: async (o: { sport?: string } = {}) => { const s = await seedSession(c, o); sessions.push(s); return s; },
    scope: () => ({ orgIds: sessions.map((s) => s.orgId) }),
  };
}
const warmingDeadline = async (sid: string) =>
  (await sql<{ warming_at: Date }[]>`select warming_at from fixture_stream_sessions where id = ${sid}`)[0]!.warming_at.getTime() + WARMING_TIMEOUT_MINUTES * MIN;
const ZERO = { ticked: 0, ended: 0, failed: 0, deferred: 0 };

describe.skipIf(!HAS_DB)("tickOpenSessions (W22, T7b): the stream-tick job's pass over every open session", () => {
  it("the EMPTY case: a scope with no session at all answers all zeros and reads no provider", async () => {
    const f = fleet();
    const lonely = await seedOrg();
    expect(await tickOpenSessions(f.deps, { orgIds: [lonely.auth.orgId] })).toEqual(ZERO);
    await settle();
    expect(f.calls, "no provider read").toEqual([]);
  });

  it("an EMPTY orgIds list is refused by name — it never reads as 'no filter', which would tick every org", async () => {
    const f = fleet();
    await expect(tickOpenSessions(f.deps, { orgIds: [] })).rejects.toThrow(/orgIds is empty/);
  });

  it("a W19-due live session (another sport) and a warming session past its deadline: both ticked, both ended — phone_lost and no_inbound_timeout — and a second pass finds nothing open", async () => {
    const [sport] = (await sql<{ key: string }[]>`select key from sports where key <> 'generic' order by key limit 1`).map((x) => x.key);
    expect(sport, "PREMISE: the catalog is synced").toBeTruthy();
    const f = fleet();
    const gone = await f.add({ sport });
    const stuck = await f.add();
    f.ingest.setState(stuck.inputId, "disconnected");   // the second phone never sends
    f.tick(CONNECT_AFTER_MS);
    expect((await tickSession(gone.sessionId, f.deps, "beat")).session?.state, "PREMISE: the first went live").toBe("live");
    f.ingest.setState(gone.inputId, "disconnected");
    f.tick(LOST_MS);
    expect(f.deps.now().getTime(), "PREMISE: the warming one is past its deadline").toBeGreaterThanOrEqual(await warmingDeadline(stuck.sessionId));
    expect(await tickOpenSessions(f.deps, f.scope())).toEqual({ ticked: 2, ended: 2, failed: 0, deferred: 0 });
    expect(await gone.row()).toMatchObject({ state: "completed", end_reason: "phone_lost", fail_reason: null });
    expect(await stuck.row()).toMatchObject({ state: "failed", fail_reason: "no_inbound_timeout" });
    expect(await ends(gone.sessionId)).toEqual({ transitions: 1, ended: 1 });
    expect(await ends(stuck.sessionId)).toEqual({ transitions: 1, ended: 1 });
    expect(await netSpend(gone.sessionId), "W19: the one consume, no refund").toBe(-1);
    expect(await netSpend(stuck.sessionId), "never live: nothing spent").toBe(0);
    // The sequence: the next firing.
    f.tick(5 * MIN);
    expect(await tickOpenSessions(f.deps, f.scope()), "the second pass: both terminal, neither selected").toEqual(ZERO);
    expect(await ends(gone.sessionId)).toEqual({ transitions: 1, ended: 1 });
  });

  it("two passes AT ONCE (an overlapping firing): each session ends exactly once, with one end event and one consume", async () => {
    const f = fleet();
    const gone = await f.add();
    const stuck = await f.add();
    f.ingest.setState(stuck.inputId, "disconnected");
    f.tick(CONNECT_AFTER_MS);
    expect((await tickSession(gone.sessionId, f.deps, "beat")).session?.state, "PREMISE: live").toBe("live");
    f.ingest.setState(gone.inputId, "disconnected");
    f.tick(LOST_MS);
    const both = await Promise.all([tickOpenSessions(f.deps, f.scope()), tickOpenSessions(f.deps, f.scope())]);
    expect(both.map((r) => r.failed), "neither pass threw on the other's end").toEqual([0, 0]);
    expect(both.map((r) => r.ticked + r.failed + r.deferred), "each pass accounted for both").toEqual([2, 2]);
    expect(await ends(gone.sessionId)).toEqual({ transitions: 1, ended: 1 });
    expect(await ends(stuck.sessionId)).toEqual({ transitions: 1, ended: 1 });
    expect(await netSpend(gone.sessionId)).toBe(-1);
    expect(await netSpend(stuck.sessionId)).toBe(0);
  });

  it("a session whose tick THROWS is counted in failed, and the pass goes on to tick the next", async () => {
    const f = fleet();
    const first = await f.add();
    const bad = await f.add();
    const last = await f.add();
    for (const s of [first, bad, last]) f.ingest.setState(s.inputId, "disconnected");
    f.tick((await warmingDeadline(last.sessionId)) - f.deps.now().getTime());   // every one at or past its deadline
    hook.onLockOrg = async (orgId) => { if (orgId === bad.orgId) throw new Error("injected: the org lock failed"); };
    let r;
    try {
      r = await tickOpenSessions(f.deps, f.scope());
    } finally {
      hook.onLockOrg = null;
    }
    expect(r).toEqual({ ticked: 2, ended: 2, failed: 1, deferred: 0 });
    expect((await first.row()).state).toBe("failed");
    expect((await bad.row()).state, "the throwing one is left as it was, for the next firing").toBe("warming");
    expect((await last.row()).state, "the one AFTER the throw was still ticked").toBe("failed");
  });

  it("an ENDED session is never ticked: not counted, and no provider read for it", async () => {
    const f = fleet();
    const done = await f.add();
    f.ingest.setState(done.inputId, "disconnected");
    f.tick((await warmingDeadline(done.sessionId)) - f.deps.now().getTime());
    expect((await tickSession(done.sessionId, f.deps, "sweep")).session?.state, "PREMISE: ended before the pass").toBe("failed");
    const open = await f.add();
    await settle();
    const before = f.calls.length;
    expect(await tickOpenSessions(f.deps, f.scope())).toEqual({ ticked: 1, ended: 0, failed: 0, deferred: 0 });
    await settle();
    expect(f.calls.slice(before).filter((c) => c.sessionId === done.sessionId), "no read of the ended one").toEqual([]);
    expect(f.calls.slice(before).filter((c) => c.sessionId === open.sessionId).length, "PREMISE: the open one WAS read").toBeGreaterThan(0);
  });

  it("T35: a session whose fixture was DELETED is ticked like any other — not counted as failed", async () => {
    const f = fleet();
    const orphan = await f.add();
    f.tick(CONNECT_AFTER_MS);
    expect((await tickSession(orphan.sessionId, f.deps, "beat")).session?.state, "PREMISE: live").toBe("live");
    await sql`delete from fixtures where id = ${orphan.fixtureId}`;
    expect((await orphan.row()).fixture_id, "PREMISE: V410 set it null").toBeNull();
    f.tick(STREAM_POLL_MS);
    expect(await tickOpenSessions(f.deps, f.scope())).toEqual({ ticked: 1, ended: 0, failed: 0, deferred: 0 });
    expect((await orphan.row()).state).toBe("live");
  });

  it("the wall-clock budget: once it is SPENT the pass starts no further tick and counts the rest deferred — never failed", async () => {
    const f = fleet();
    const a = await f.add();
    const b = await f.add();
    const c = await f.add();
    // A scripted wall clock. The pass looks once at its start, then once before each session it would start.
    const scripted = (reads: number[]) => {
      let looks = 0;
      return { wallClock: () => reads[Math.min(looks++, reads.length - 1)]!, looks: () => looks };
    };
    const B = STREAM_TICK_BUDGET_MS;
    // Which sessions a pass READ from the provider: a warming passthrough tick claims its first read, so a ticked session
    // shows one inputStatus call under its id, and a deferred one none. This is also what pins OLDEST FIRST.
    const readBy = async (from: number) => {
      await settle();
      const ids = new Set(f.calls.slice(from).filter((x) => x.operation === "inputStatus").map((x) => x.sessionId));
      return [a, b, c].filter((s) => ids.has(s.sessionId)).map((s) => s.sessionId);
    };
    await settle();
    let from = f.calls.length;
    // Start 0; before a: B/2 (ticked); before b: exactly B (spent) — b and c deferred.
    const spent = scripted([0, B / 2, B]);
    expect(await tickOpenSessions(f.deps, { ...f.scope(), wallClock: spent.wallClock })).toEqual({ ticked: 1, ended: 0, failed: 0, deferred: 2 });
    expect(spent.looks(), "PREMISE: start, before a, before b — and no look after it stopped").toBe(3);
    expect(await readBy(from), "the OLDEST was the one ticked; the deferred two were never read").toEqual([a.sessionId]);
    // The pair: 1 ms short of the budget before b, so b is ticked; spent before c, the one deferred. (a's read is still
    // inside its claim window — the clock has not moved — so a coalesces and only b reads.)
    from = f.calls.length;
    const short = scripted([0, 0, B - 1, B]);
    expect(await tickOpenSessions(f.deps, { ...f.scope(), wallClock: short.wallClock })).toEqual({ ticked: 2, ended: 0, failed: 0, deferred: 1 });
    expect(await readBy(from), "b read; c, the newest, deferred").toEqual([b.sessionId]);
    for (const s of [a, b, c]) expect((await s.row()).state, "no pass ended anything (none was due)").toBe("warming");
  });
});

// ===========================================================================================================================
// R2008 (owner ruling 2026-10-19, "apply your rec"): a COMPOSED (score) stream ends after the same PHONE_LOST_LIVE_MINUTES
// without a camera as a passthrough one does, with the same `phone_lost` reason. W19's three clauses, the composed way:
//   (a) the phone's beat silent for the limit;
//   (b) the compositor's programme phase `reconnecting` — since a `programme_phase` event, written by the beat route in
//       the beat's own transaction and keyed to its attempt — for the limit, the session having been `live` once;
//   (c) a fresh Cloudflare read of the camera's input (A) saying it is not connected — made ONLY once (a) and (b) hold.
// Every beat here goes through the REAL `heartbeat` (the route's use-case) and every end through the REAL `tickSession` /
// `tickOpenSessions`: the evidence the rule judges is what the producer wrote, never a row typed into the test. The expected
// thresholds are the config's constants and the compositor's own phase list (PROGRAMME_PHASES), not the rule's.
// ===========================================================================================================================
describe.skipIf(!HAS_DB)("R2008: a COMPOSED live stream whose camera is gone for PHONE_LOST_LIVE_MINUTES ends phone_lost (W19, the composed way)", () => {
  type Composed = Awaited<ReturnType<typeof composedLive>>;
  /** §6.12: the hold before the countdown (W24), from the spec's constant. */
  const QUIET_MS = RECONNECT_QUIET_SECONDS * 1000;
  // Every phase that ENDS a camera-outage run: not `reconnecting`, and not `waiting` either — a compositor restarted during an
  // outage opens on `waiting` and the camera is exactly as gone (review I2; its own tests are below).
  const BREAKS_THE_RUN = PROGRAMME_PHASES.filter((p) => p !== "reconnecting" && p !== "waiting");
  const cameraInputOf = async (sid: string) =>
    (await sql<{ ingest_input_id: string }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${sid} and role = 'camera' order by slot limit 1`)[0]!.ingest_input_id;
  const phaseEvents = async (sid: string) => sql<{ from_state: string | null; to_state: string | null; attempt: number | null; occurred_at: Date; kind: string; source: string }[]>`
    select from_state, to_state, attempt, occurred_at, kind, source from fixture_stream_events where session_id = ${sid} and type = 'programme_phase' order by seq`;

  /** A composed session taken live by its first playing beat, which reports `live` (the camera is in). Beats go through
   *  `heartbeat`, as the Machine's do; `beat(null)` is a beat that reports no phase. */
  async function composedLive(o: { sport?: string } = {}) {
    const r = await rig({ mode: "composed", ...o });
    const cam = await cameraInputOf(r.sessionId);
    const token = r.runner.created[0]!.jobToken;
    const beatWith = (phase: ProgrammePhaseWire | null, tok: string = token) =>
      heartbeat(r.sessionId, tok, phase === null ? { state: "playing" } : { state: "playing", programmePhase: phase }, r.deps);
    await beatWith("live");
    expect(await r.row(), "PREMISE: the first playing beat took it live").toMatchObject({ state: "live", first_ingest_at: null });
    const phoneBeat = (at: Date = r.deps.now()) => sql`update fixture_stream_sessions set phone_beat_at = ${at} where id = ${r.sessionId}`;
    await phoneBeat();
    r.ingest.setState(cam, "disconnected");
    return { ...r, cam, token, beat: beatWith, phoneBeat, liveAt: r.deps.now() };
  }
  /** The machine beats at its cadence: a beat at the clock's instant keeps the stale-beat window (3 beats) from reading a
   *  15-minute jump as a dead Machine. The phase it reports is the same one, so this writes no event. */
  const hold = (r: Composed, phase: ProgrammePhaseWire = "reconnecting") => r.beat(phase);
  /** A tick one claim window after the last (a real tick is STREAM_POLL_MS or more behind the previous one): the claim is
   *  free, so each tick here is the one that may read the camera's input. `o.claimHeld` keeps another reader's claim. */
  const tickOf = async (r: Composed, cause: "poll" | "beat" | "sweep" = "sweep", o: { claimHeld?: boolean } = {}) => {
    if (!o.claimHeld) await sql`update fixture_stream_sessions set ingest_polled_at = null where id = ${r.sessionId}`;
    return (await tickSession(r.sessionId, r.deps, cause)).session;
  };
  /** After the end decision a composed session is `ending` (the runner's SIGINT); a later tick completes it. */
  async function settled(r: Composed) {
    for (let i = 0; i < 4; i++) {
      r.tick(STREAM_POLL_MS);
      const s = await tickOf(r);
      if (s?.state === "completed") return s;
    }
    throw new Error("PREMISE: the composed session did not complete within four ticks of its end");
  }
  const readsOf = (r: Composed) => inputStatusCalls(r);

  it("the programme_phase log: one event per CHANGE, in the beat's own transaction — never one per beat; `attempt`, the words and the chain are the beat's", async () => {
    const r = await composedLive();
    const seq: (ProgrammePhaseWire | null)[] = ["live", "live", "frozen", "reconnecting", "reconnecting", "live", null, null];
    for (const p of seq) { r.tick(1000); await r.beat(p); }
    const events = await phaseEvents(r.sessionId);
    // live (the go-live beat, from nothing), reconnecting (whose `from` is the stored `frozen` — which, a blip out of `live`,
    // wrote no row of its own: see the toggle test below), live, then the beat that stopped reporting a phase.
    expect(events.map((e) => [e.from_state, e.to_state])).toEqual([[null, "live"], ["frozen", "reconnecting"], ["reconnecting", "live"], ["live", null]]);
    expect(events.every((e) => e.attempt === 1 && e.source === "runner" && e.kind === "observed"), "attempt 1, the runner's observation").toBe(true);
    expect(events.length, "anti-vacuity: the log was read").toBeGreaterThan(0);
    // The empty case: a Machine that never reports a phase writes none.
    const quiet = await rig({ mode: "composed" });
    for (let i = 0; i < 3; i++) { quiet.tick(1000); await heartbeat(quiet.sessionId, quiet.runner.created[0]!.jobToken, { state: "playing" }, quiet.deps); }
    expect((await quiet.row()).state, "PREMISE: it beat, and went live on the first").toBe("live");
    expect(await phaseEvents(quiet.sessionId), "no phase reported, no event").toEqual([]);
  });

  it("review minor: `frozen` blips write no row — a camera that flickers live ↔ frozen all match long adds NOTHING to the log; a frozen that follows a phase that is not `live` (a break in a run) IS written", async () => {
    const r = await composedLive();
    let beats = 0;
    for (let i = 0; i < 40; i++) { r.tick(1000); await r.beat(i % 2 === 0 ? "frozen" : "live"); beats++; }
    expect(beats, "anti-vacuity: the toggles were sent").toBe(40);
    expect((await phaseEvents(r.sessionId)).map((e) => [e.from_state, e.to_state]), "the go-live `live` is the only row: forty toggles wrote none").toEqual([[null, "live"]]);
    // The other side: reconnecting, then a (table-impossible, but a compositor bug is what a guard is for) frozen — it ends the run, so it is a row.
    r.tick(1000); await r.beat("reconnecting");
    r.tick(1000); await r.beat("frozen");
    expect((await phaseEvents(r.sessionId)).map((e) => [e.from_state, e.to_state]).slice(-2)).toEqual([["live", "reconnecting"], ["reconnecting", "frozen"]]);
  });

  it("15:00 reconnecting, the phone silent, the camera's input not connected: ended phone_lost — one end, one consume, no refund; 14:59.999 is not", async () => {
    const r = await composedLive();
    r.tick(MIN); await r.beat("reconnecting");   // the camera is lost one minute in; the phone's last beat was at go-live
    const lostAt = r.deps.now();
    r.tick(LOST_MS - 1); await hold(r);
    expect(await readsOf(r), "PREMISE: nothing has read the input").toBe(0);
    expect((await tickOf(r))?.state, "1 ms short of the limit").toBe("live");
    expect(await readsOf(r), "the camera has been gone past the quiet hold, so the tick READS its input (the organiser's countdown needs the word) — and the answer is still 'not yet'").toBe(1);
    r.tick(1); await hold(r);
    expect(r.deps.now().getTime() - lostAt.getTime(), "PREMISE: exactly the limit since reconnecting").toBe(LOST_MS);
    const t = await tickOf(r);
    expect(t, "at the limit").toMatchObject({ state: "ending", endReason: "phone_lost", failReason: null });
    expect(await readsOf(r), "one read per tick: the 14:59.999 tick's and the one that decided it").toBe(2);
    expect(await settled(r)).toMatchObject({ state: "completed", endReason: "phone_lost", failReason: null });
    expect(await ends(r.sessionId)).toEqual({ transitions: 1, ended: 1 });
    expect(await netSpend(r.sessionId), "the go-live consume stands, nothing more").toBe(-1);
    expect(await refunds(r.sessionId), "no refund").toBe(0);
  });

  it("each clock alone: the phone's beat 14:59 old (the video clock past the limit), then the reconnecting run 14:59 old (the beat clock past it) — one second later each ends it", async () => {
    let checked = 0;
    for (const clock of ["beat", "video"] as const) {
      const r = await composedLive();
      r.tick(MIN); await r.beat("reconnecting");
      const lostAt = r.deps.now();
      // This clock's last sign of life is 1 s after the camera was lost (the beat), or the reconnecting run began then (the video).
      if (clock === "beat") await r.phoneBeat(new Date(lostAt.getTime() + 1000));
      else { r.tick(1000); await r.beat("live"); r.tick(0); await r.beat("reconnecting"); }
      const runStart = r.deps.now();
      const limit = clock === "beat" ? lostAt.getTime() + 1000 + LOST_MS : runStart.getTime() + LOST_MS;
      r.tick(limit - 1000 - r.deps.now().getTime()); await hold(r);
      expect((await tickOf(r))?.state, `${clock} at 14:59`).toBe("live");
      r.tick(1000); await hold(r);
      expect(await tickOf(r), `${clock} at 15:00`).toMatchObject({ endReason: "phone_lost" });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a phone that has NEVER beaten (phone_beat_at null): its silence runs from the first `live` — so the video clock alone decides, at exactly the limit; and with the camera in, the same session is never ended", async () => {
    const r = await composedLive();
    await sql`update fixture_stream_sessions set phone_beat_at = null where id = ${r.sessionId}`;
    // Camera in for ever: the phone's silence alone (a floor of `live` + limit, long past) ends nothing.
    r.tick(3 * LOST_MS); await r.beat("live");
    expect((await tickOf(r))?.state, "no beat ever, but the camera is in").toBe("live");
    expect(await readsOf(r), "not gone, so not read").toBe(0);
    // Camera lost: the video clock decides, on its own limit.
    r.tick(1000); await r.beat("reconnecting");
    r.tick(LOST_MS - 1); await hold(r);
    expect((await tickOf(r))?.state, "1 ms short of the limit").toBe("live");
    r.tick(1); await hold(r);
    expect(await tickOf(r), "the limit").toMatchObject({ endReason: "phone_lost" });
  });

  it("the camera comes back at minute 14: the clock RESETS — the original deadline passes unended, and the second loss ends it a full limit after ITS first reconnecting beat", async () => {
    const r = await composedLive();
    r.tick(MIN); await r.beat("reconnecting");
    const firstLost = r.deps.now();
    r.tick(14 * MIN); await r.beat("live");
    expect(await tickOf(r), "back at 14:00").toMatchObject({ state: "live" });
    r.tick(1000); await r.beat("frozen");   // the half-second hold that always precedes the slate
    r.tick(1000); await r.beat("reconnecting");
    const secondLost = r.deps.now();
    r.tick(firstLost.getTime() + LOST_MS - r.deps.now().getTime() + 1000); await hold(r);
    expect(r.deps.now().getTime(), "PREMISE: past the FIRST loss's deadline").toBeGreaterThan(firstLost.getTime() + LOST_MS);
    expect((await tickOf(r))?.state, "the first deadline passed; the clock was reset").toBe("live");
    expect(await readsOf(r), "the SECOND run is a minute old, past the quiet hold: read once, and the clocks say not yet").toBe(1);
    r.tick(secondLost.getTime() + LOST_MS - 1 - r.deps.now().getTime()); await hold(r);
    expect((await tickOf(r))?.state, "1 ms short of the SECOND limit").toBe("live");
    r.tick(1); await hold(r);
    expect(await tickOf(r), "the second limit").toMatchObject({ endReason: "phone_lost" });
  });

  it("a phone beat inside the window holds it: not ended at the limit after the camera was lost, ended exactly the limit after the LAST beat", async () => {
    const r = await composedLive();
    r.tick(MIN); await r.beat("reconnecting");
    r.tick(10 * MIN); await hold(r);
    await r.phoneBeat();                        // the phone checks in at minute 10 of the loss
    const lastBeat = r.deps.now();
    r.tick(LOST_MS - 10 * MIN); await hold(r);  // the camera has now been gone the full limit
    expect((await tickOf(r))?.state, "the video clock is due, the beat clock is not").toBe("live");
    expect(await readsOf(r), "the phone has been silent past the quiet hold and the camera gone: read once; the beat clock still says no").toBe(1);
    r.tick(lastBeat.getTime() + LOST_MS - 1 - r.deps.now().getTime()); await hold(r);
    expect((await tickOf(r))?.state, "1 ms short of the limit after the last beat").toBe("live");
    r.tick(1); await hold(r);
    expect(await tickOf(r)).toMatchObject({ endReason: "phone_lost" });
  });

  it("a fresh read of the camera's input that says CONNECTED holds it however long both other clocks run; the same read saying disconnected ends it next tick", async () => {
    const r = await composedLive();
    r.tick(MIN); await r.beat("reconnecting");
    r.ingest.setState(r.cam, "connected");   // the compositor says reconnecting (its own link), Cloudflare says the phone still pushes
    let ticks = 0;
    for (let m = 0; m < 5; m++) {
      r.tick(LOST_MS / 5 + STREAM_POLL_MS); await hold(r);
      expect((await tickOf(r))?.state, `minute ${Math.round((r.deps.now().getTime() - r.liveAt.getTime()) / MIN)}`).toBe("live");
      ticks++;
    }
    expect(ticks).toBe(5);
    expect(await readsOf(r), "PREMISE: due and READ at least once").toBeGreaterThan(0);
    r.ingest.setState(r.cam, "disconnected");
    r.tick(STREAM_POLL_MS); await hold(r);
    expect(await tickOf(r), "the same clocks, the read now disconnected").toMatchObject({ endReason: "phone_lost" });
  });

  it("m-3: an UNKNOWN read, a read that THROWS and a read with no evidence never end it (the throw is reported); the next fresh disconnected word does", async () => {
    const r = await composedLive();
    r.tick(MIN); await r.beat("reconnecting");
    r.tick(LOST_MS); await hold(r);
    let checked = 0;
    r.ingest.setState(r.cam, "unknown");
    expect((await tickOf(r))?.state, "unknown").toBe("live");
    checked++;
    r.tick(STREAM_POLL_MS); await hold(r);
    sentry.captureError.mockClear();
    const throwing = vi.spyOn(r.ingest as IngestProvider, "inputStatus").mockRejectedValue(new Error("injected: Cloudflare 503"));
    try { expect((await tickOf(r))?.state, "a read that throws").toBe("live"); checked++; } finally { throwing.mockRestore(); }
    expect(sentry.captureError, "reported once, the way a failed passthrough read is").toHaveBeenCalledTimes(1);
    expect(sentry.captureError.mock.calls[0]![1], "the route names the status read").toMatchObject({ route: "relay.ingest_status" });
    r.tick(STREAM_POLL_MS); await hold(r);
    const noEvidence = vi.spyOn(r.ingest as IngestProvider, "inputStatus").mockResolvedValue({ state: null, protocol: null, enteredAt: null, lastSeenAt: null, reason: null } satisfies IngestStatus);
    try { expect((await tickOf(r))?.state, "a read with no evidence").toBe("live"); checked++; } finally { noEvidence.mockRestore(); }
    expect(checked, "three non-words judged").toBe(3);
    expect(await ends(r.sessionId), "nothing ended").toEqual({ transitions: 0, ended: 0 });
    r.ingest.setState(r.cam, "disconnected");
    r.tick(STREAM_POLL_MS); await hold(r);
    expect(await tickOf(r), "the next fresh word decides").toMatchObject({ endReason: "phone_lost" });
  });

  it("`frozen`, `live` and `final` are not `reconnecting`: each as the latest phase holds it past the limit, and each in the window resets the clock (every phase the compositor declares that is neither `reconnecting` nor `waiting`)", async () => {
    expect(BREAKS_THE_RUN.length, "anti-vacuity: the compositor declares phases besides reconnecting and waiting").toBeGreaterThanOrEqual(2);
    let checked = 0;
    for (const phase of BREAKS_THE_RUN) {
      // (1) reconnecting, then this phase for good: well past the limit, never ended.
      const held = await composedLive();
      held.tick(MIN); await held.beat("reconnecting");
      held.tick(MIN); await held.beat(phase);
      held.tick(2 * LOST_MS); await held.beat(phase);
      expect((await tickOf(held))?.state, `${phase} as the latest phase`).toBe("live");
      expect(await readsOf(held), `${phase}: not gone, so not read`).toBe(0);
      // (2) this phase for one beat at 14:59, then reconnecting again: the limit from the FIRST loss passes unended.
      const reset = await composedLive();
      reset.tick(MIN); await reset.beat("reconnecting");
      const lostAt = reset.deps.now();
      reset.tick(LOST_MS - 1000); await reset.beat(phase);
      reset.tick(500); await reset.beat("reconnecting");
      const runStart = reset.deps.now();
      reset.tick(lostAt.getTime() + LOST_MS + 1000 - reset.deps.now().getTime()); await hold(reset);
      expect((await tickOf(reset))?.state, `${phase} at 14:59, then reconnecting again: past the first deadline`).toBe("live");
      reset.tick(runStart.getTime() + LOST_MS - reset.deps.now().getTime()); await hold(reset);
      expect(await tickOf(reset), `${phase}: a full limit after the new run`).toMatchObject({ endReason: "phone_lost" });
      checked++;
    }
    expect(checked).toBe(BREAKS_THE_RUN.length);
  });

  it("a camera-gone end is for a camera that WAS live: a `reconnecting` phase with no `live` ever reported is judged by NEITHER rule, however old (the log is not the whole story: `reconnecting` is reachable only from `live`)", async () => {
    const r = await rig({ mode: "composed" });
    const cam = await cameraInputOf(r.sessionId);
    const token = r.runner.created[0]!.jobToken;
    await heartbeat(r.sessionId, token, { state: "playing", programmePhase: "reconnecting" }, r.deps);
    expect(await r.row(), "PREMISE: live, and never `live`").toMatchObject({ state: "live" });
    expect((await phaseEvents(r.sessionId)).some((e) => e.to_state === "live"), "PREMISE: no live phase was ever reported").toBe(false);
    await sql`update fixture_stream_sessions set phone_beat_at = ${r.deps.now()} where id = ${r.sessionId}`;
    r.ingest.setState(cam, "disconnected");
    let ticks = 0;
    for (let h = 0; h < 4; h++) {
      r.tick(LOST_MS * 2);
      await heartbeat(r.sessionId, token, { state: "playing", programmePhase: "reconnecting" }, r.deps);
      await sql`update fixture_stream_sessions set ingest_polled_at = null where id = ${r.sessionId}`;
      expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, `${2 * (h + 1)} limits in`).toBe("live");
      ticks++;
    }
    expect(ticks).toBe(4);
    expect(await ends(r.sessionId)).toEqual({ transitions: 0, ended: 0 });
    expect(await refunds(r.sessionId), "never judged, never refunded").toBe(0);
  });

  it("superseded attempts: a stray attempt-1 `live` beat does NOT reset attempt 2's clock, and a stray attempt-1 `reconnecting` run does NOT end an attempt-2 session that is live", async () => {
    // A. The current attempt (2) lost its camera at t; the stray's `live` beat at minute 10 must not move it.
    const a = await composedLive();
    await sql`update fixture_stream_sessions set runner_attempts = 2 where id = ${a.sessionId}`;
    const exp = new Date(Date.now() + 3_600_000);
    const att1 = await mintRelayToken({ sid: a.sessionId, scope: "relay-job", expiresAt: exp, attempt: 1 });
    const att2 = await mintRelayToken({ sid: a.sessionId, scope: "relay-job", expiresAt: exp, attempt: 2 });
    a.tick(1000); await a.beat("live", att2);
    a.tick(MIN); await a.beat("reconnecting", att2);
    const lostAt = a.deps.now();
    a.tick(10 * MIN);
    expect(await a.beat("live", att1), "the stray is told to drain").toEqual({ desiredState: "ending" });
    await a.beat("reconnecting", att2);
    a.tick(LOST_MS - 10 * MIN - 1); await a.beat("reconnecting", att2);
    expect((await tickOf(a))?.state, "1 ms short of the limit since attempt 2's loss").toBe("live");
    a.tick(1); await a.beat("reconnecting", att2);
    expect(await tickOf(a), "the stray's live beat reset nothing").toMatchObject({ endReason: "phone_lost" });
    expect(a.deps.now().getTime() - lostAt.getTime()).toBe(LOST_MS);
    expect((await phaseEvents(a.sessionId)).filter((e) => e.attempt === 1).map((e) => e.to_state), "the stray wrote no event: only attempt 1's own go-live beat did").toEqual(["live"]);

    // B. The current attempt is live; the stray reports a 20-minute reconnecting run, which counts for nothing.
    const b = await composedLive();
    await sql`update fixture_stream_sessions set runner_attempts = 2 where id = ${b.sessionId}`;
    const b1 = await mintRelayToken({ sid: b.sessionId, scope: "relay-job", expiresAt: exp, attempt: 1 });
    const b2 = await mintRelayToken({ sid: b.sessionId, scope: "relay-job", expiresAt: exp, attempt: 2 });
    b.tick(1000); await b.beat("live", b2);
    for (let m = 0; m < 4; m++) { b.tick(LOST_MS / 3); await b.beat("reconnecting", b1); await b.beat("live", b2); }
    expect((await tickOf(b))?.state, "attempt 2 is live; the stray's reconnecting beats are not its camera").toBe("live");
    expect(await readsOf(b), "not gone, so not read").toBe(0);
    // C. The pair: attempt 2's own reconnecting run, the stray silent, ends it — so B's `live` is the stray's doing, not a defect of the rig.
    b.tick(MIN); await b.beat("reconnecting", b2);
    b.tick(LOST_MS); await b.beat("reconnecting", b2);
    expect(await tickOf(b), "attempt 2's own run").toMatchObject({ endReason: "phone_lost" });
  });

  it("a RETRY (review I2): attempt 1's outage continues into attempt 2 — whose first beat is `waiting`, the only phase a freshly booted compositor can report — and the clock runs from the outage's FIRST reconnecting beat, not from the restart", async () => {
    const r = await composedLive();
    r.tick(MIN); await r.beat("reconnecting");
    const outageAt = r.deps.now();
    r.tick(10 * MIN); await hold(r);
    // The retry: attempt 2 owns the row and its beat window restarts (domain/session.ts `retry`, I4) — no beat of its own yet.
    await sql`update fixture_stream_sessions set runner_attempts = 2, beat_window_at = ${r.deps.now()} where id = ${r.sessionId}`;
    expect((await tickOf(r))?.state, "attempt 2 has not beaten: attempt 1's run is another Machine's, nothing of the current attempt to judge").toBe("live");
    expect(await readsOf(r), "nothing judged, nothing read").toBe(0);
    const att2 = await mintRelayToken({ sid: r.sessionId, scope: "relay-job", expiresAt: new Date(Date.now() + 3_600_000), attempt: 2 });
    r.tick(MIN); await r.beat("waiting", att2);   // 11 minutes into the outage
    const own = (await phaseEvents(r.sessionId)).filter((e) => e.attempt === 2);
    expect(own.map((e) => [e.from_state, e.to_state]), "attempt 2's first beat is its own row, though it differs from nothing the stored beat said but its attempt").toEqual([["reconnecting", "waiting"]]);
    r.tick(outageAt.getTime() + LOST_MS - 1 - r.deps.now().getTime()); await r.beat("waiting", att2);
    expect((await tickOf(r))?.state, "1 ms short of the limit since the OUTAGE began").toBe("live");
    r.tick(1); await r.beat("waiting", att2);
    expect(await tickOf(r), "the limit from the outage's first reconnecting beat — attempt 2's own `waiting` is 4 minutes younger").toMatchObject({ endReason: "phone_lost" });
    expect(own[0]!.occurred_at.getTime() - outageAt.getTime(), "PREMISE: the restart came 11 minutes after the outage began").toBe(11 * MIN);
  });

  it("review I2, the other side: a restarted compositor after a camera that was FINE opens on `waiting` and the clock starts THERE — the same limit, counted from attempt 2's first beat; a `live` after it resets it", async () => {
    const r = await composedLive();
    r.tick(5 * MIN); await r.beat("live");
    await sql`update fixture_stream_sessions set runner_attempts = 2, beat_window_at = ${r.deps.now()} where id = ${r.sessionId}`;
    const att2 = await mintRelayToken({ sid: r.sessionId, scope: "relay-job", expiresAt: new Date(Date.now() + 3_600_000), attempt: 2 });
    r.tick(STREAM_POLL_MS); await r.beat("waiting", att2);
    const runStart = r.deps.now();
    expect((await phaseEvents(r.sessionId)).filter((e) => e.attempt === 2).map((e) => [e.from_state, e.to_state])).toEqual([["live", "waiting"]]);
    r.tick(LOST_MS - 1); await r.beat("waiting", att2);
    expect((await tickOf(r))?.state, "1 ms short of the limit since attempt 2's first `waiting`").toBe("live");
    // The camera arrives at 14:59.999: `live` ends the run; a later `waiting` (another restart) is a NEW run from ITS first beat.
    await r.beat("live", att2);
    r.tick(5 * MIN); await r.beat("live", att2);
    expect((await tickOf(r))?.state, "the old deadline passed; the run was reset by `live`").toBe("live");
    r.tick(1); await r.beat("waiting", att2);
    const second = r.deps.now();
    r.tick(LOST_MS - 1); await r.beat("waiting", att2);
    expect((await tickOf(r))?.state, "1 ms short of the SECOND run's limit").toBe("live");
    r.tick(1); await r.beat("waiting", att2);
    expect(await tickOf(r), "the second run's limit").toMatchObject({ endReason: "phone_lost" });
    expect(second.getTime() - runStart.getTime(), "PREMISE: the second run began long after the first's start").toBeGreaterThan(LOST_MS);
  });

  it("a session that has no phone (pairing_id null, C-1) is never judged: everything due, nothing ended, nothing read", async () => {
    const r = await composedLive();
    await asLegacy(r);
    r.tick(MIN); await r.beat("reconnecting");
    r.tick(2 * LOST_MS); await hold(r);
    expect((await tickOf(r))?.state).toBe("live");
    expect(await readsOf(r)).toBe(0);
  });

  it("the Cloudflare read is rate-limited exactly as a passthrough poll is: two ticks inside one claim window make ONE read, and the one that did not claim decides nothing", async () => {
    const r = await composedLive();
    r.tick(MIN); await r.beat("reconnecting");
    r.tick(LOST_MS); await hold(r);
    await sql`update fixture_stream_sessions set ingest_polled_at = ${r.deps.now()} where id = ${r.sessionId}`;   // another caller holds the claim
    expect((await tickOf(r, "sweep", { claimHeld: true }))?.state, "the claim is held elsewhere: no read, no decision").toBe("live");
    expect(await readsOf(r)).toBe(0);
    r.tick(STREAM_POLL_MS); await hold(r);
    const both = await Promise.all([tickSession(r.sessionId, r.deps, "sweep"), tickSession(r.sessionId, r.deps, "beat")]);
    expect(await readsOf(r), "two ticks, one claim, one read").toBe(1);
    expect(both.every((t) => t.session !== null)).toBe(true);
    expect((await r.row()).end_reason, "the claimant decided").toBe("phone_lost");
    const again = await tickOf(r, "sweep", { claimHeld: true });
    expect(["ending", "completed"], "SECOND CALL: a session already ending is not re-decided").toContain(again?.state);
    expect(await settled(r)).toMatchObject({ endReason: "phone_lost" });
    expect(await ends(r.sessionId)).toEqual({ transitions: 1, ended: 1 });
  });

  it("a tick racing a camera RETURN: the beat that says `live` lands after the tick judged the session due and before its end decision locks the row — the decision is re-taken on the locked row, and the session lives", async () => {
    const r = await composedLive();
    r.tick(MIN); await r.beat("reconnecting");
    r.tick(LOST_MS); await hold(r);
    let applies = 0;
    let landedAt = 0;
    hook.onLockOrg = async () => {
      applies++;
      // The tick's applies: the reconcile's expiry, the observation's runner step, then the end decision. The beat the hook
      // sends makes applies of its own (its expiry tick), which are not the tick's — `landedAt` fixes which one it met.
      if (applies === 3 && landedAt === 0) { landedAt = applies; await r.beat("live"); }
    };
    try {
      expect((await tickOf(r))?.state).toBe("live");
    } finally {
      hook.onLockOrg = null;
    }
    expect(landedAt, "PREMISE: the beat landed at the tick's third apply — the end decision, after its unlocked judgement found it due").toBe(3);
    expect(await ends(r.sessionId)).toEqual({ transitions: 0, ended: 0 });
  });

  it("an organiser's Stop that landed first keeps its reason (the first reason wins): the tick at the limit does not turn `stopped` into `phone_lost`", async () => {
    const r = await composedLive();
    r.tick(MIN); await r.beat("reconnecting");
    r.tick(LOST_MS - 1); await hold(r);
    await stopSession(r.auth, r.fixtureId, r.sessionId, r.deps);
    r.tick(1);
    const t = await tickOf(r);
    expect(t?.endReason, "stopped first").toBe("stopped");
    expect(await settled(r)).toMatchObject({ endReason: "stopped" });
    expect(await readsOf(r), "an ending session is not judged, so nothing was read").toBe(0);
  });

  it("the money and the storage are what any composed end gets: no refund, one consume, and the reservation after the end is the one an organiser's Stop leaves — the camera's share, one recording", async () => {
    const lostOne = await composedLive();
    lostOne.tick(MIN); await lostOne.beat("reconnecting");
    const stopped = await composedLive();
    expect((await storageReservations(sql, lostOne.deps.now())).find((x) => x.sessionId === lostOne.sessionId)?.minutes, "PREMISE: running = every recording it makes")
      .toBe(RECORDINGS_PER_SESSION.composed * MAX_DURATION_MINUTES);
    lostOne.tick(LOST_MS); await hold(lostOne);
    expect(await tickOf(lostOne)).toMatchObject({ endReason: "phone_lost" });
    await stopSession(stopped.auth, stopped.fixtureId, stopped.sessionId, stopped.deps);
    await settled(lostOne);
    await settled(stopped);
    const reserved = async (r: Composed) => (await storageReservations(sql, r.deps.now())).find((x) => x.sessionId === r.sessionId)?.minutes;
    expect(await reserved(lostOne), "the camera's share is kept until the daily sweep deletes A's recording").toBe(MAX_DURATION_MINUTES);
    expect(await reserved(lostOne), "phone_lost reserves what a Stop does").toBe(await reserved(stopped));
    expect(await netSpend(lostOne.sessionId)).toBe(await netSpend(stopped.sessionId));
    expect(await netSpend(lostOne.sessionId)).toBe(-1);
    expect(await refunds(lostOne.sessionId)).toBe(0);
  });

  it("through the stream-tick job (W22): a due composed session and a healthy one in one pass — the due one ends phone_lost, the healthy one is untouched and its camera never read", async () => {
    const c = clockedDeps();   // one clock, one fake ingest and one runner for both sessions, as one pass meets them
    const due = await seedSession(c, { mode: "composed" });
    const healthy = await seedSession(c, { mode: "composed" });
    for (const s of [due, healthy]) {
      await heartbeat(s.sessionId, c.runner.created.find((x) => x.sessionId === s.sessionId)!.jobToken, { state: "playing", programmePhase: "live" }, c.deps);
      await sql`update fixture_stream_sessions set phone_beat_at = ${c.deps.now()} where id = ${s.sessionId}`;
      c.ingest.setState(await cameraInputOf(s.sessionId), "disconnected");
    }
    const tokenOf = (sid: string) => c.runner.created.find((x) => x.sessionId === sid)!.jobToken;
    c.tick(MIN);
    await heartbeat(due.sessionId, tokenOf(due.sessionId), { state: "playing", programmePhase: "reconnecting" }, c.deps);
    c.tick(LOST_MS);
    await heartbeat(due.sessionId, tokenOf(due.sessionId), { state: "playing", programmePhase: "reconnecting" }, c.deps);
    await heartbeat(healthy.sessionId, tokenOf(healthy.sessionId), { state: "playing", programmePhase: "live" }, c.deps);
    await sql`update fixture_stream_sessions set phone_beat_at = ${c.deps.now()} where id = ${healthy.sessionId}`;
    const scope = { orgIds: [due.orgId, healthy.orgId] };
    const before = c.calls.length;
    const pass = await tickOpenSessions(c.deps, scope);
    expect(pass, "two ticked, none failed").toMatchObject({ ticked: 2, failed: 0, deferred: 0 });
    expect((await due.row()), "the due one").toMatchObject({ end_reason: "phone_lost" });
    expect((await healthy.row()).state, "the healthy one").toBe("live");
    await settle();
    const reads = c.calls.slice(before).filter((x) => x.operation === "inputStatus");
    expect(reads.map((x) => x.sessionId), "only the due one's camera was read").toEqual([due.sessionId]);
  });

  it("another sport: every sport the catalog holds ends a due composed session phone_lost the same way (the relay reads no sport; the sweep proves it)", async () => {
    const sports = (await sql<{ key: string }[]>`select key from sports where key <> 'generic' order by key`).map((s) => s.key);
    expect(sports.length, "PREMISE: the catalog is synced (sync:sports)").toBeGreaterThanOrEqual(2);
    let checked = 0;
    for (const sport of sports) {
      const r = await composedLive({ sport });
      r.tick(MIN); await r.beat("reconnecting");
      r.tick(LOST_MS); await hold(r);
      expect(await tickOf(r), sport).toMatchObject({ endReason: "phone_lost" });
      const [{ sport_key }] = await sql<{ sport_key: string }[]>`select sport_key from fixture_stream_sessions where id = ${r.sessionId}`;
      expect(sport_key, "PREMISE: the session carries the sport").toBe(sport);
      checked++;
    }
    expect(checked).toBe(sports.length);
  });

  // =========================================================================================================================
  // R2008, owner ruling 2026-10-19 ("apply rec"): a composed session that went LIVE and whose camera NEVER appeared — no `live`
  // programme phase from ANY attempt — is cancelled after PHONE_LOST_LIVE_MINUTES counted from when it went live, and the
  // credit is returned: the viewer never saw video. `failed` / `camera_never_live` (the organiser's copy says nothing was
  // ever received), the go-live consume reversed by a `refund` row on the same ledger and bucket, in the same transaction.
  // =========================================================================================================================
  /** A composed session taken live by its first playing beat, which reports `waiting` — the compositor's first phase
   *  (`Programme::default`): the camera has not appeared. The session boots for two minutes first, so the clock the rule
   *  counts (go-live) is not the creation's. */
  async function composedWaiting(o: { sport?: string } = {}) {
    const r = await rig({ mode: "composed", ...o });
    const cam = await cameraInputOf(r.sessionId);
    const token = r.runner.created[0]!.jobToken;
    const beatWith = (phase: ProgrammePhaseWire | null, tok: string = token) =>
      heartbeat(r.sessionId, tok, phase === null ? { state: "playing" } : { state: "playing", programmePhase: phase }, r.deps);
    const balanceBefore = await creditBalance(sql, r.orgId);
    r.tick(2 * MIN);
    await beatWith("waiting");
    expect(await r.row(), "PREMISE: the first playing beat took it live").toMatchObject({ state: "live", first_ingest_at: null });
    const phoneBeat = (at: Date = r.deps.now()) => sql`update fixture_stream_sessions set phone_beat_at = ${at} where id = ${r.sessionId}`;
    await phoneBeat();
    r.ingest.setState(cam, "disconnected");
    return { ...r, cam, token, beat: beatWith, phoneBeat, liveAt: r.deps.now(), balanceBefore };
  }
  type Waiting = Awaited<ReturnType<typeof composedWaiting>>;
  const ledgerOf = (sid: string) => sql<{ reason: string; delta: number; bucket: string; created_by: string | null; idempotency_key: string | null; session_id: string | null; balance_after: number; note: string | null }[]>`
    select reason, delta, bucket, created_by, idempotency_key, session_id, balance_after, note from org_stream_credits where session_id = ${sid} order by created_at, id`;
  /** What the ruling says, typed from it and never read off the code: ONE consume of one credit, ONE refund of one, the same bucket. */
  async function expectCreditReturned(r: Waiting, label: string) {
    const rows = await ledgerOf(r.sessionId);
    expect(rows.map((x) => [x.reason, x.delta]), `${label}: the ledger's rows for the session`).toEqual([["consume", -1], ["refund", 1]]);
    expect(rows[1]!.bucket, `${label}: a refunded credit returns to the bucket it was drawn from`).toBe(rows[0]!.bucket);
    expect(rows[1]!.created_by, `${label}: the platform's refund, no staff member`).toBeNull();
    expect(rows[1]!.session_id).toBe(r.sessionId);
    expect(await netSpend(r.sessionId), `${label}: net spend on the ledger`).toBe(0);
    expect(await creditBalance(sql, r.orgId), `${label}: the balance is what it was before the go-live`).toBe(r.balanceBefore);
    // The event row says what was written (the ledger's own id and balance), once: the session's history names the refund.
    const [refund] = await sql<{ id: string }[]>`select id from org_stream_credits where session_id = ${r.sessionId} and reason = 'refund'`;
    expect(await refundEventsOf(r.sessionId), `${label}: the refund_credit event`).toEqual([{ delta: 1, balanceAfter: rows[1]!.balance_after, ledgerId: refund!.id }]);
  }
  const refundEventsOf = async (sid: string) =>
    (await sql<{ payload: Record<string, unknown> }[]>`select payload from fixture_stream_events where session_id = ${sid} and type = 'refund_credit' order by seq`).map((e) => e.payload);

  it("never-live: 14:59.999 after it went live → still live, still charged; 15:00 → failed camera_never_live, the Machine told to stop, the credit returned (net 0 on the ledger, the balance back), and NO Cloudflare read", async () => {
    const r = await composedWaiting();
    expect((await ledgerOf(r.sessionId)).map((x) => x.reason), "PREMISE: the go-live consumed").toEqual(["consume"]);
    expect(await creditBalance(sql, r.orgId), "PREMISE: one credit taken").toBe(r.balanceBefore - 1);
    r.tick(LOST_MS - 1); await hold(r, "waiting");
    expect((await tickOf(r))?.state, "14:59.999 after go-live").toBe("live");
    expect(await refunds(r.sessionId), "not refunded before the end").toBe(0);
    r.tick(1); await hold(r, "waiting");
    expect(r.deps.now().getTime() - r.liveAt.getTime(), "PREMISE: exactly the limit since go-live").toBe(LOST_MS);
    expect(await tickOf(r), "15:00").toMatchObject({ state: "failed", failReason: "camera_never_live", endReason: null });
    await expectCreditReturned(r, "15:00");
    expect(await readsOf(r), "the rule reads nothing: there was never a camera to look for").toBe(0);
    expect(r.runner.stops.map((x) => x.signal), "the compositor is told to stop, once").toEqual(["SIGINT"]);
    expect(await ends(r.sessionId)).toEqual({ transitions: 1, ended: 1 });
    const view = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(view, "what the organiser's panel reads").toMatchObject({ state: "failed", failReason: "camera_never_live", endReason: null, creditUsed: false, countdown: null });
  });

  it("never-live: the clock is GO-LIVE's — a session that boots for 8 minutes (inside the warming timeout) is not ended 7 minutes early by it; and the end is counted from the first playing beat, not from any later `waiting` beat", async () => {
    const r = await rig({ mode: "composed" });
    const cam = await cameraInputOf(r.sessionId);
    const token = r.runner.created[0]!.jobToken;
    r.tick(8 * MIN);   // boots for eight minutes: the limit counted from CREATION would land seven minutes before go-live's
    await heartbeat(r.sessionId, token, { state: "playing", programmePhase: "waiting" }, r.deps);
    const liveAt = r.deps.now();
    await sql`update fixture_stream_sessions set phone_beat_at = ${liveAt} where id = ${r.sessionId}`;
    r.ingest.setState(cam, "disconnected");
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, "8 minutes after creation, 0 after go-live").toBe("live");
    // Later `waiting` beats are the same phase: they move nothing (no row, no clock).
    for (let i = 0; i < 5; i++) { r.tick(3 * MIN); await heartbeat(r.sessionId, token, { state: "playing", programmePhase: "waiting" }, r.deps); }
    r.tick(LOST_MS - 5 * 3 * MIN - 1); await heartbeat(r.sessionId, token, { state: "playing", programmePhase: "waiting" }, r.deps);
    await sql`update fixture_stream_sessions set ingest_polled_at = null where id = ${r.sessionId}`;
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session?.state, "1 ms short, measured from go-live").toBe("live");
    r.tick(1); await heartbeat(r.sessionId, token, { state: "playing", programmePhase: "waiting" }, r.deps);
    expect(r.deps.now().getTime() - liveAt.getTime()).toBe(LOST_MS);
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session, "the limit").toMatchObject({ state: "failed", failReason: "camera_never_live" });
  });

  it("never-live, a `live` at minute 10: the camera appeared, so this rule NEVER fires — not at minute 15, not at hour 5 (the normal rule applies: it is judged only if the camera is lost later), and nothing is refunded", async () => {
    const r = await composedWaiting();
    r.tick(10 * MIN); await r.beat("live");
    let ticks = 0;
    for (const at of [5 * MIN, 5 * MIN, 5 * MIN, 4 * 60 * MIN]) {
      r.tick(at); await r.beat("live"); await r.phoneBeat();
      expect((await tickOf(r))?.state, `${Math.round((r.deps.now().getTime() - r.liveAt.getTime()) / MIN)} minutes after go-live`).toBe("live");
      ticks++;
    }
    expect(ticks).toBe(4);
    expect(await refunds(r.sessionId), "no refund for a stream that had a camera").toBe(0);
    expect(await netSpend(r.sessionId)).toBe(-1);
    expect(await ends(r.sessionId)).toEqual({ transitions: 0, ended: 0 });
    // The normal rule applies from here: the camera lost for the limit ends it phone_lost, and is NOT refunded.
    r.tick(MIN); await r.beat("reconnecting");
    r.tick(LOST_MS); await hold(r);
    expect(await tickOf(r)).toMatchObject({ endReason: "phone_lost" });
    expect(await refunds(r.sessionId), "a lost camera is not a never-live camera: the viewer saw video").toBe(0);
  });

  it("never-live, each guard ALONE keeps it off for hours: a compositor that reports no phase; a log that began long after go-live; `waiting` then a beat that reports no phase — and the pair, the plain `waiting` session, ends", async () => {
    const hours = async (r: Waiting, phase: ProgrammePhaseWire | null) => {
      for (let h = 0; h < 4; h++) {
        r.tick(LOST_MS); await r.beat(phase); await r.phoneBeat();
        expect((await tickOf(r))?.state, `${h + 1} limits in`).toBe("live");
      }
    };
    let checked = 0;
    // (1) an image that reports no phase at all: no log, nothing judged.
    const none = await rig({ mode: "composed" });
    const noneCam = await cameraInputOf(none.sessionId);
    const noneToken = none.runner.created[0]!.jobToken;
    const noneBeat = () => heartbeat(none.sessionId, noneToken, { state: "playing" }, none.deps);
    await noneBeat();
    none.ingest.setState(noneCam, "disconnected");
    for (let h = 0; h < 4; h++) {
      none.tick(LOST_MS); await noneBeat();
      await sql`update fixture_stream_sessions set phone_beat_at = ${none.deps.now()}, ingest_polled_at = null where id = ${none.sessionId}`;
      expect((await tickSession(none.sessionId, none.deps, "sweep")).session?.state, `no phase reported, ${h + 1} limits in`).toBe("live");
    }
    expect(await phaseEvents(none.sessionId), "PREMISE: a compositor that reports no phase writes no log").toEqual([]);
    checked++;
    // (2) the log began late: the compositor only started reporting a phase 30 minutes after go-live (a session already
    // running when the log did, as a deploy mid-broadcast makes). Judged by nothing.
    const late = await rig({ mode: "composed" });
    const lateCam = await cameraInputOf(late.sessionId);
    const lateToken = late.runner.created[0]!.jobToken;
    const lateBeat = (phase: ProgrammePhaseWire | null) => heartbeat(late.sessionId, lateToken, phase === null ? { state: "playing" } : { state: "playing", programmePhase: phase }, late.deps);
    await lateBeat(null);
    late.ingest.setState(lateCam, "disconnected");
    late.tick(30 * MIN); await lateBeat(null);
    late.tick(1000); await lateBeat("waiting");
    expect((await phaseEvents(late.sessionId)).map((e) => e.to_state), "PREMISE: the log began with a `waiting` 30 minutes after go-live").toEqual(["waiting"]);
    for (let h = 0; h < 4; h++) {
      late.tick(LOST_MS); await lateBeat("waiting"); await sql`update fixture_stream_sessions set phone_beat_at = ${late.deps.now()}, ingest_polled_at = null where id = ${late.sessionId}`;
      expect((await tickSession(late.sessionId, late.deps, "sweep")).session?.state, `late log, ${h + 1} limits in`).toBe("live");
    }
    checked++;
    // (3) `waiting`, then a beat that reports NO phase: the compositor has stopped saying anything — not a verdict.
    const mute = await composedWaiting();
    mute.tick(MIN); await mute.beat(null);
    await hours(mute, null);
    checked++;
    expect(checked).toBe(3);
    for (const r of [none, late, mute]) expect(await refunds(r.sessionId), "never refunded").toBe(0);
    // The pair: the same session with none of those faults ends at the limit.
    const plain = await composedWaiting();
    plain.tick(LOST_MS); await hold(plain, "waiting");
    expect(await tickOf(plain)).toMatchObject({ failReason: "camera_never_live" });
  });

  it("never-live ends EXACTLY ONCE: a second tick, two ticks at once and a later poll write one refund and one end — the ledger nets 0, never +1", async () => {
    const r = await composedWaiting();
    r.tick(LOST_MS); await hold(r, "waiting");
    await Promise.all([tickOf(r), tickOf(r, "poll"), tickOf(r, "beat")]);
    expect((await r.row()).state).toBe("failed");
    await tickOf(r);
    r.tick(STREAM_POLL_MS);
    await currentSession(r.auth, r.fixtureId, r.deps);
    await tickOf(r);
    expect(await refunds(r.sessionId), "one refund row after three ticks, two at once, and a poll").toBe(1);
    await expectCreditReturned(r, "after the repeats");
    expect(await ends(r.sessionId)).toEqual({ transitions: 1, ended: 1 });
    expect((await ledgerOf(r.sessionId)).map((x) => x.reason)).toEqual(["consume", "refund"]);
  });

  it("never-live after a STAFF refund: the credit was already returned, so the platform writes none — one refund in all, net 0, never +1", async () => {
    const r = await composedWaiting();
    await refundCredits({ orgId: r.orgId, delta: 1, sessionId: r.sessionId, createdBy: await rigUser(), note: "goodwill: the camera never worked", idempotencyKey: randomUUID() });
    r.tick(LOST_MS); await hold(r, "waiting");
    expect(await tickOf(r)).toMatchObject({ failReason: "camera_never_live" });
    const rows = await ledgerOf(r.sessionId);
    expect(rows.map((x) => [x.reason, x.delta, x.created_by === null]), "the staff refund only").toEqual([["consume", -1, true], ["refund", 1, false]]);
    expect(await netSpend(r.sessionId)).toBe(0);
    expect(await creditBalance(sql, r.orgId)).toBe(r.balanceBefore);
  });

  it("never-live on a FREE restart (the go-live consumed nothing): ended and failed all the same, and nothing is refunded — the ledger, not 'a live session consumed', says what is owed", async () => {
    // Session 1 consumes and ends (the organiser stops it); session 2 on the SAME fixture, inside the reuse window, restarts free.
    const first = await composedLive();
    await stopSession(first.auth, first.fixtureId, first.sessionId, first.deps);
    await settled(first);
    const [{ id: targetId }] = await sql<{ id: string }[]>`select id from org_stream_targets where org_id = ${first.orgId} limit 1`;
    first.tick(MIN);
    const { sessionId } = await createSession(first.auth, first.fixtureId, { mode: "composed", targetId }, first.deps);
    const token = first.runner.created.find((x) => x.sessionId === sessionId)!.jobToken;
    await heartbeat(sessionId, token, { state: "playing", programmePhase: "waiting" }, first.deps);
    expect((await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${sessionId}`)[0]!.state, "PREMISE: it went live").toBe("live");
    expect((await ledgerOf(sessionId)).length, "PREMISE: a free restart consumes nothing — no ledger row of its own").toBe(0);
    const balance = await creditBalance(sql, first.orgId);
    await sql`update fixture_stream_sessions set phone_beat_at = ${first.deps.now()} where id = ${sessionId}`;
    first.tick(LOST_MS);
    await heartbeat(sessionId, token, { state: "playing", programmePhase: "waiting" }, first.deps);
    await sql`update fixture_stream_sessions set ingest_polled_at = null where id = ${sessionId}`;
    expect((await tickSession(sessionId, first.deps, "sweep")).session, "the limit").toMatchObject({ state: "failed", failReason: "camera_never_live" });
    expect((await ledgerOf(sessionId)).length, "nothing refunded: nothing was taken").toBe(0);
    expect(await creditBalance(sql, first.orgId), "the balance did not move").toBe(balance);
  });

  it("never-live loses to an organiser's Stop that landed first (the first reason wins) and to a `live` beat that lands between the tick's judgement and its locked decision — no end, no refund either way", async () => {
    // A Stop at 14:59.999: it keeps its reason; the credit stays spent (a Stop is not a cancellation).
    const stopped = await composedWaiting();
    stopped.tick(LOST_MS - 1); await hold(stopped, "waiting");
    await stopSession(stopped.auth, stopped.fixtureId, stopped.sessionId, stopped.deps);
    stopped.tick(1);
    expect((await tickOf(stopped))?.endReason, "stopped first").toBe("stopped");
    await settled(stopped);
    expect(await refunds(stopped.sessionId)).toBe(0);
    expect(await netSpend(stopped.sessionId), "a Stop keeps the consume").toBe(-1);
    // The race: the camera appears after the tick judged the session due and before the end decision locks the row.
    const r = await composedWaiting();
    r.tick(LOST_MS); await hold(r, "waiting");
    let applies = 0, landedAt = 0;
    hook.onLockOrg = async () => {
      applies++;
      if (applies === 3 && landedAt === 0) { landedAt = applies; await r.beat("live"); }
    };
    try { expect((await tickOf(r))?.state).toBe("live"); } finally { hook.onLockOrg = null; }
    expect(landedAt, "PREMISE: the beat landed at the end decision's apply, after the unlocked judgement found it due").toBe(3);
    expect(await ends(r.sessionId)).toEqual({ transitions: 0, ended: 0 });
    expect(await refunds(r.sessionId)).toBe(0);
  });

  it("never-live: the money and the storage — the reservation after the end is what an organiser's Stop leaves for the same session (the camera's share, one recording), and a session with no phone (C-1) is never judged", async () => {
    const never = await composedWaiting();
    const stopped = await composedWaiting();
    never.tick(LOST_MS); await hold(never, "waiting");
    expect(await tickOf(never)).toMatchObject({ failReason: "camera_never_live" });
    stopped.tick(LOST_MS - 1); await hold(stopped, "waiting");
    await stopSession(stopped.auth, stopped.fixtureId, stopped.sessionId, stopped.deps);
    await settled(stopped);
    const reserved = async (r: Waiting) => (await storageReservations(sql, r.deps.now())).find((x) => x.sessionId === r.sessionId)?.minutes;
    expect(await reserved(never), "the camera's share is kept until the daily sweep deletes A's recording").toBe(MAX_DURATION_MINUTES);
    expect(await reserved(never), "the same share a Stop leaves").toBe(await reserved(stopped));
    const legacy = await composedWaiting();
    await asLegacy(legacy);
    legacy.tick(LOST_MS * 3); await hold(legacy, "waiting");
    expect((await tickOf(legacy))?.state, "no phone, no phone rules").toBe("live");
    expect(await refunds(legacy.sessionId)).toBe(0);
  });

  it("never-live, every sport the catalog holds: the same end and the same refund (the relay reads no sport)", async () => {
    const sports = (await sql<{ key: string }[]>`select key from sports where key <> 'generic' order by key`).map((s) => s.key);
    expect(sports.length, "PREMISE: the catalog is synced (sync:sports)").toBeGreaterThanOrEqual(2);
    let checked = 0;
    for (const sport of sports) {
      const r = await composedWaiting({ sport });
      r.tick(LOST_MS); await hold(r, "waiting");
      expect(await tickOf(r), sport).toMatchObject({ failReason: "camera_never_live" });
      await expectCreditReturned(r, sport);
      checked++;
    }
    expect(checked).toBe(sports.length);
  });

  // ---- I1: the organiser's countdown (W24: shown IFF the end fires) -------------------------------------------------
  const countdownOf = async (r: Composed) => {
    await sql`update fixture_stream_sessions set ingest_polled_at = null where id = ${r.sessionId}`;
    return (await currentSession(r.auth, r.fixtureId, r.deps))!.countdown;
  };

  it("I1, the lost camera: the organiser sees the SAME countdown a passthrough session shows — nothing inside the quiet hold, from it `phone_lost` counting down from the shorter silence, and the session ENDS at exactly the deadline it names", async () => {
    const r = await composedLive();
    r.tick(MIN); await r.beat("reconnecting");
    r.tick(QUIET_MS - 1); await hold(r);
    expect(await countdownOf(r), "29.999 s into the outage").toBeNull();
    r.tick(1); await hold(r);
    const c = await countdownOf(r);
    // The phone's last beat was MIN + QUIET ago, the run QUIET ago: the end needs both clocks, so it counts from the SHORTER.
    expect(c, "30 s in").toEqual({ kind: "live", reason: "phone_lost", elapsedMs: QUIET_MS, remainingMs: LOST_MS - QUIET_MS });
    expect(StreamLostCountdown.safeParse(c).success, "the wire schema declares this shape").toBe(true);
    // The deadline it names is the end: 1 ms before, live; at it, ended.
    r.tick(c!.remainingMs - 1); await hold(r);
    expect((await tickOf(r))?.state, "1 ms before the named deadline").toBe("live");
    expect((await countdownOf(r))?.remainingMs, "1 ms left").toBe(1);
    r.tick(1); await hold(r);
    expect(await tickOf(r), "at the named deadline").toMatchObject({ endReason: "phone_lost" });
  });

  it("I1, shown IFF the end fires: a `connected` word, an `unknown` one, a phone that still beats, an outage inside the quiet hold, and a claim held by another reader each show NOTHING — and none of them ends at the limit (the pair of the case above)", async () => {
    const setups: [string, (r: Composed) => Promise<void>][] = [
      ["a connected read", async (r) => r.ingest.setState(r.cam, "connected")],
      ["an unknown read", async (r) => r.ingest.setState(r.cam, "unknown")],
    ];
    let hidden = 0;
    for (const [why, setup] of setups) {
      const r = await composedLive();
      r.tick(MIN); await r.beat("reconnecting");
      r.tick(QUIET_MS); await hold(r);
      await setup(r);
      expect(await countdownOf(r), why).toBeNull();
      r.tick(LOST_MS); await hold(r);
      expect((await tickOf(r))?.state, `${why}: nothing ends at the limit`).toBe("live");
      hidden++;
    }
    // The phone still beats (its last beat is inside the quiet hold): W19 cannot fire, so there is no countdown (O5).
    const beating = await composedLive();
    beating.tick(MIN); await beating.beat("reconnecting");
    beating.tick(10 * MIN); await hold(beating); await beating.phoneBeat();
    beating.tick(QUIET_MS - 1000); await hold(beating);
    expect(await countdownOf(beating), "a phone that beat 29 s ago").toBeNull();
    hidden++;
    // An outage inside the quiet hold.
    const young = await composedLive();
    young.tick(LOST_MS * 2); await young.beat("live");
    young.tick(1000); await young.beat("reconnecting");
    young.tick(QUIET_MS - 1000); await hold(young);
    expect(await countdownOf(young), "an outage 29 s old, the phone long silent").toBeNull();
    hidden++;
    // Another reader holds the claim: this poll has no fresh word, so it shows nothing — and a tick in the same state, AT the
    // limit, cannot end it either (the tick that did not claim decides nothing).
    const held = await composedLive();
    held.tick(MIN); await held.beat("reconnecting");
    held.tick(5 * MIN); await hold(held);
    await sql`update fixture_stream_sessions set ingest_polled_at = ${held.deps.now()} where id = ${held.sessionId}`;
    expect((await currentSession(held.auth, held.fixtureId, held.deps))!.countdown, "no fresh word on this poll").toBeNull();
    held.tick(LOST_MS); await hold(held);
    await sql`update fixture_stream_sessions set ingest_polled_at = ${held.deps.now()} where id = ${held.sessionId}`;
    expect((await tickOf(held, "sweep", { claimHeld: true }))?.state, "and the tick that did not claim cannot end it, past the limit").toBe("live");
    hidden++;
    expect(hidden, "anti-vacuity: five hidden cases").toBe(5);
    // The pair: the same session with the claim free and the word `disconnected` ENDS at once (the read is the third clause).
    expect(await tickOf(held), "the same clocks, a claim of its own").toMatchObject({ endReason: "phone_lost" });
  });

  it("I1, never live: the countdown names `camera_never_live` from the quiet hold after go-live, counting down to the limit from go-live, and the session ends at exactly the deadline it names, refunded; a `live` at minute 10 takes it away", async () => {
    const r = await composedWaiting();
    r.tick(QUIET_MS - 1); await hold(r, "waiting");
    expect(await countdownOf(r), "29.999 s after go-live").toBeNull();
    r.tick(1); await hold(r, "waiting");
    const c = await countdownOf(r);
    expect(c, "30 s after go-live").toEqual({ kind: "live", reason: "camera_never_live", elapsedMs: QUIET_MS, remainingMs: LOST_MS - QUIET_MS });
    expect(StreamLostCountdown.safeParse(c).success).toBe(true);
    r.tick(c!.remainingMs - 1); await hold(r, "waiting");
    expect((await tickOf(r))?.state, "1 ms before the deadline").toBe("live");
    r.tick(1); await hold(r, "waiting");
    expect(await tickOf(r), "at the deadline").toMatchObject({ failReason: "camera_never_live" });
    await expectCreditReturned(r, "I1");
    // The other side: the camera appears at minute 10 — no countdown, ever.
    const seen = await composedWaiting();
    seen.tick(10 * MIN); await seen.beat("live");
    seen.tick(5 * MIN); await seen.beat("live"); await seen.phoneBeat();
    expect(await countdownOf(seen), "a live phase at minute 10 → this end cannot fire").toBeNull();
  });

  it("never-live across a RETRY: attempt 2 also says only `waiting`, six minutes later — the end is still counted from go-live (the log began with the session), at exactly the limit, refunded once", async () => {
    const r = await composedWaiting();
    r.tick(6 * MIN);
    await sql`update fixture_stream_sessions set runner_attempts = 2, beat_window_at = ${r.deps.now()} where id = ${r.sessionId}`;
    const att2 = await mintRelayToken({ sid: r.sessionId, scope: "relay-job", expiresAt: new Date(Date.now() + 3_600_000), attempt: 2 });
    await r.beat("waiting", att2);
    expect((await phaseEvents(r.sessionId)).map((e) => [e.attempt, e.to_state]), "PREMISE: the log holds attempt 1's `waiting` and attempt 2's own").toEqual([[1, "waiting"], [2, "waiting"]]);
    r.tick(r.liveAt.getTime() + LOST_MS - 1 - r.deps.now().getTime()); await r.beat("waiting", att2);
    expect((await tickOf(r))?.state, "1 ms short of the limit since GO-LIVE").toBe("live");
    expect(await refunds(r.sessionId)).toBe(0);
    r.tick(1); await r.beat("waiting", att2);
    expect(await tickOf(r), "the limit since go-live, though attempt 2 is only nine minutes old").toMatchObject({ failReason: "camera_never_live" });
    await expectCreditReturned(r, "retry");
  });

  it("never-live is judged only on a log that is WHOLE: a beat that reported NO phase between two `waiting`s (a compositor that stopped saying) means the camera is not known absent — no end at the limit and no countdown (the pair of the clean `waiting`-only log, which does both)", async () => {
    const r = await composedWaiting();
    r.tick(MIN); await r.beat(null);
    r.tick(MIN); await r.beat("waiting");
    expect((await phaseEvents(r.sessionId)).map((e) => e.to_state), "PREMISE: waiting, none, waiting").toEqual(["waiting", null, "waiting"]);
    r.tick(QUIET_MS); await hold(r, "waiting");
    expect(await countdownOf(r), "past the quiet hold, no countdown: the end will not fire").toBeNull();
    r.tick(LOST_MS); await hold(r, "waiting");
    expect((await tickOf(r))?.state, "and the limit ends nothing").toBe("live");
    expect(await refunds(r.sessionId)).toBe(0);
  });

  it("never-live after a STAFF refund: the end returns nothing more (the ledger is the authority, not 'a live session consumed'), the event row says nothing was owed, and the balance holds", async () => {
    const r = await composedWaiting();
    await refundCredits({ orgId: r.orgId, delta: 1, sessionId: r.sessionId, createdBy: await rigUser(), note: "goodwill first", idempotencyKey: randomUUID() });
    const balance = await creditBalance(sql, r.orgId);
    expect(balance, "PREMISE: the staff refund returned the go-live consume").toBe(r.balanceBefore);
    r.tick(LOST_MS); await hold(r, "waiting");
    expect(await tickOf(r), "the end still happens").toMatchObject({ failReason: "camera_never_live" });
    expect((await ledgerOf(r.sessionId)).map((x) => [x.reason, x.delta, x.created_by === null]), "consume, the staff's refund, and no second").toEqual([["consume", -1, true], ["refund", 1, false]]);
    expect(await creditBalance(sql, r.orgId), "no credit was manufactured").toBe(balance);
    expect(await refundEventsOf(r.sessionId), "nothing was owed: delta 0, no ledger row").toEqual([{ delta: 0, balanceAfter: balance, ledgerId: null }]);
  });

  // ---- m1 (review): the phase-change decision must be taken on the LOCKED row --------------------------------------------
  /** How many backends wait, directly or down a chain, on the one `pid` holds — a lock queue on the session row. */
  async function queuedBehind(pid: number, want: number): Promise<number> {
    let n = 0;
    for (let i = 0; i < 150 && n < want; i++) {
      await new Promise((res) => setTimeout(res, 20));
      [{ n }] = await sql<{ n: number }[]>`
        with recursive chain(pid) as (
          select ${pid}::int
          union
          select a.pid from pg_stat_activity a join chain c on c.pid = any(pg_blocking_pids(a.pid))
        ) select (count(*) - 1)::int as n from chain`;
    }
    return n;
  }

  it("m1: two beats race for the row — each was peeked against the SAME stored phase, and the second's phase-change decision is taken on the row the first LEFT, so the log ends on the phase the stored beat has (both orders)", async () => {
    let staged = 0;
    for (const [start, first, second] of [["live", "reconnecting", "live"], ["reconnecting", "live", "reconnecting"]] as const) {
      const r = await composedLive();
      if (start === "reconnecting") { r.tick(1000); await r.beat("reconnecting"); }
      expect((await sql<{ p: string }[]>`select last_heartbeat->>'programmePhase' as p from fixture_stream_sessions where id = ${r.sessionId}`)[0]!.p, "PREMISE: the stored phase both beats will peek").toBe(start);
      r.tick(1000);
      let release!: () => void;
      const mayCommit = new Promise<void>((res) => (release = res));
      let signalHeld!: (pid: number) => void;
      const held = new Promise<number>((res) => (signalHeld = res));
      const holder = sql.begin(async (tx) => {
        const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        await tx`select id from fixture_stream_sessions where id = ${r.sessionId} for update`;
        signalHeld(pid);
        await mayCommit;
      });
      const holderPid = await held;
      const a = r.beat(first);
      expect(await queuedBehind(holderPid, 1), `${first}: the race was not staged — the first beat never queued on the row`).toBeGreaterThanOrEqual(1);
      const b = r.beat(second);
      expect(await queuedBehind(holderPid, 2), `${second}: the race was not staged — the second beat never queued behind it`).toBeGreaterThanOrEqual(2);
      release();
      await holder;
      await Promise.all([a, b]);
      const log = (await phaseEvents(r.sessionId)).map((e) => e.to_state);
      expect(log.at(-1), `${start}, then ${first}, then ${second}: the log ends on the phase the STORED beat has`).toBe(second);
      expect((await sql<{ p: string }[]>`select last_heartbeat->>'programmePhase' as p from fixture_stream_sessions where id = ${r.sessionId}`)[0]!.p).toBe(second);
      // …and the rule acts on that log: `live` last → survives the limit; `reconnecting` last → ends a limit after ITS beat.
      r.tick(LOST_MS); await r.beat(second);
      if (second === "live") expect((await tickOf(r))?.state, "the camera is live: nothing ends").toBe("live");
      else expect(await tickOf(r), "the camera is lost: the run began at the second beat").toMatchObject({ endReason: "phone_lost" });
      staged++;
    }
    expect(staged).toBe(2);
  });

  // ---- minor: the camera facts are read only when a rule could fire ---------------------------------------------------
  it("minor: a healthy `live` composed session's tick runs ONE statement fewer than the same tick over one whose latest phase is `reconnecting` — the camera facts are read only when a rule could fire", async () => {
    const healthy = await composedLive();
    const outage = await composedLive();
    for (const r of [healthy, outage]) r.tick(MIN);
    await healthy.beat("live");
    await outage.beat("reconnecting");
    const cost = async (r: Composed) => {
      await sql`update fixture_stream_sessions set ingest_polled_at = null where id = ${r.sessionId}`;
      const before = statementCount();
      await tickSession(r.sessionId, r.deps, "sweep");
      return statementCount() - before;
    };
    await cost(healthy); await cost(outage);   // warm-up: plans, caches
    const a = await cost(healthy);
    const b = await cost(outage);
    expect(a, "anti-vacuity: the tick ran statements at all").toBeGreaterThan(3);
    expect(b - a, "the one statement is the camera-facts read").toBe(1);
    // …and a phase that cannot decide anything (`frozen`, `final`) is as cheap as `live`.
    let cheap = 0;
    for (const phase of PROGRAMME_PHASES.filter((p) => p !== "reconnecting" && p !== "waiting")) {
      const r = await composedLive();
      r.tick(MIN); await r.beat(phase);
      await cost(r);
      expect(await cost(r), `${phase}: no facts read`).toBe(a);
      cheap++;
    }
    expect(cheap, "anti-vacuity").toBeGreaterThanOrEqual(2);
  });
});
