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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { STREAM_POLL_MS } from "@/lib/stream-session-view";
import {
  PHONE_LOST_LIVE_MINUTES, PHONE_SILENT_FLOOR_SECONDS, PHONE_SILENT_SLACK_SECONDS, POLL_FAR_SECONDS, WARMING_TIMEOUT_MINUTES,
} from "@/server/relay/config";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import type { IngestProvider, ProviderCallRecord } from "@/server/relay/ports";
import { pairPresentPhone, rigUser } from "@/server/relay/__tests__/_session-rig";
import { seedOrg, startedDivisionWithFixture } from "./_rig";
import { grantCredits } from "../stream-credits";
import { createStreamTarget } from "../stream-targets";
import { reissueStreamCode } from "../stream-codes";
import { type SessionDeps, createSession, currentSession, heartbeat, tickSession } from "../stream-sessions";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));
// A pass-through seam on the org money lock `apply` takes first (A7): a race test parks a phone beat there, between the
// tick's unlocked judgement and its locked decision. Null = pass straight through.
const hook = vi.hoisted(() => ({ onLockOrg: null as null | (() => Promise<void>) }));
vi.mock("../stream-credits", async (importOriginal) => {
  const real = await importOriginal<typeof import("../stream-credits")>();
  return { ...real, lockOrg: async (...a: Parameters<typeof real.lockOrg>) => { if (hook.onLockOrg) await hook.onLockOrg(); return real.lockOrg(...a); } };
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

async function rig(o: { mode?: "passthrough" | "composed"; sport?: string; connectAfterMs?: number } = {}) {
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
  let now = Date.now();
  // Every provider call the fake makes, as the adapter would record it (Review Focus 3: counted on the recorder).
  const calls: ProviderCallRecord[] = [];
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs: o.connectAfterMs ?? CONNECT_AFTER_MS, recorder: { record: (c) => { calls.push(c); } } });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const runner = new FakeRunner();
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(now), appUrl: "http://app.test" };
  const paired = await pairPresentPhone(fixtureId, { at: deps.now() });
  const { sessionId } = await createSession(auth, fixtureId, { mode: o.mode ?? "passthrough", targetId: target.id }, deps);
  const [{ ingest_input_id: inputId }] = await sql<{ ingest_input_id: string }[]>`
    select ingest_input_id from fixture_stream_inputs where session_id = ${sessionId} and slot = 0`;
  const row = async () => (await sql<{
    state: string; fail_reason: string | null; end_reason: string | null; first_ingest_at: Date | null; fixture_id: string | null;
  }[]>`select state, fail_reason, end_reason, first_ingest_at, fixture_id from fixture_stream_sessions where id = ${sessionId}`)[0]!;
  return {
    auth, orgId: auth.orgId, fixtureId, divisionId, sessionId, inputId, ingest, runner, deps, calls, paired, row,
    tick: (ms: number) => { now += ms; },
  };
}
type Rig = Awaited<ReturnType<typeof rig>>;

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

  it("T35: a session whose fixture was DELETED (fixture_id set null) ticks without a throw, and the deletion does not move its state", async () => {
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

  it("T30: after Revoke & reissue the session's phone is no longer CURRENT (its code ended), so a beating phone's warming session is ended — and without the reissue, the same tick leaves it", async () => {
    let checked = 0;
    for (const reissue of [false, true]) {
      const r = await rig({ connectAfterMs: 10 * MIN });
      r.tick(1000);
      await sql`update fixture_stream_pairings set last_beat_at = ${r.deps.now()} where id = ${r.paired.pairingId}`;   // fresh: not silent
      if (reissue) await reissueStreamCode(r.auth, r.fixtureId);
      const [p] = await sql<{ ended_at: Date | null }[]>`select ended_at from fixture_stream_pairings where id = ${r.paired.pairingId}`;
      expect(p!.ended_at, "PREMISE (T30): a reissue leaves the old code's pairing current").toBeNull();
      const t = await tickSession(r.sessionId, r.deps, "sweep");
      if (reissue) expect(t.session).toMatchObject({ state: "completed", endReason: "phone_lost" });
      else expect(t.session?.state).toBe("warming");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a session with NO pairing at all (pairing_id null) has no current pairing and is ended at the next tick", async () => {
    const r = await rig({ connectAfterMs: 10 * MIN });
    await sql`update fixture_stream_sessions set pairing_id = null where id = ${r.sessionId}`;
    expect((await tickSession(r.sessionId, r.deps, "sweep")).session).toMatchObject({ state: "completed", endReason: "phone_lost" });
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
