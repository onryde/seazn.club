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
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { STREAM_POLL_MS } from "@/lib/stream-session-view";
import {
  PHONE_LOST_LIVE_MINUTES, PHONE_SILENT_FLOOR_SECONDS, PHONE_SILENT_SLACK_SECONDS, POLL_FAR_SECONDS, WARMING_TIMEOUT_MINUTES,
} from "@/server/relay/config";
import { OPEN_SESSION_MAX_POLL_SECONDS } from "@/server/relay/domain/poll-seconds";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import type { IngestProvider, ProviderCallRecord } from "@/server/relay/ports";
import { pairPresentPhone, rigUser } from "@/server/relay/__tests__/_session-rig";
import { seedOrg, startedDivisionWithFixture } from "./_rig";
import { grantCredits } from "../stream-credits";
import { createStreamTarget } from "../stream-targets";
import { reissueStreamCode } from "../stream-codes";
import {
  type SessionDeps, STREAM_TICK_BUDGET_MS, createSession, currentSession, heartbeat, tickOpenSessions, tickSession,
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
    expect(await tickSession(randomUUID(), r.deps, "sweep")).toEqual({ session: null, ingestState: null, outputObserved: null, coalescedSince: undefined });
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
