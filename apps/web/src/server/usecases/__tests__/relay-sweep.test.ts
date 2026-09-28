// The DAILY relay sweep (design §6.3 row, §6.5; C1, C2, C3; owner ruling 3; recommendation B; lane C amendments A10,
// A13, A16, A22). Real Postgres; skipped without DATABASE_URL. The expiry RULES are proven in Task 2B (pure) and Task 10
// (lazy, no sweep); here the sweep proves it reaches sessions nobody reads, destroys orphan Machines through the shared
// forceDestroy, marks a confirmed destroy for admission, and runs retention through retentionPlan with a 409 retried the
// NEXT day.
//
// SCOPED, on purpose: every sweep here passes `orgIds` naming only its own rigs' orgs. The sweep is account-wide in
// production, and vitest runs files in parallel against ONE database — an unscoped sweep would visit every other file's
// sessions (and fail their warming rows under them) and judge their Machines through THIS file's FakeRunner. Scoping is
// what makes every counter below exact rather than `>= 1` (the brief's floors could be met by a leftover row). Headroom is
// the one number that stays global — recording storage is ONE account-wide pool — so it is bracketed, never equated.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): every rig rides seedOrg's `generic` division. Relay is sport-agnostic —
// nothing in relay-sweep.ts or the stream-sessions.ts paths it drives reads the sport.
//
// Clocks: each rig's clock is FROZEN at creation and tickable (the fake ingest connects on it). A fixture seeded with the
// database's now() is judged on the rig's clock, which by then lags the database by however long the rig took to build,
// so `sweep()` first moves a lagging rig clock forward to the real now (never backward — the retention test runs days
// ahead on purpose). Second-scale thresholds carry a 60 s margin for the same reason.
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { StreamFailReason } from "@/server/api-v1/schemas";
import { log } from "@/server/logger";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import type { IngestProvider, RunnerProvider } from "@/server/relay/ports";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
import {
  ENDING_TIMEOUT_SECONDS, MAX_DURATION_MINUTES, PROVISION_TIMEOUT_SECONDS, RECORDING_RETENTION_DAYS, REQUESTED_TIMEOUT_SECONDS,
  RUNNER_OBSERVE_SLACK_SECONDS, RUNNER_STOP_GRACE_SECONDS, SAMPLE_RETENTION_DAYS, STALE_HEARTBEAT_SECONDS, WARMING_TIMEOUT_MINUTES,
} from "@/server/relay/config";
import { LIST_VIDEOS_PAGE_LIMIT } from "@/server/relay/ingest-cf";
import { machineNameFor } from "@/server/relay/domain/runner";
import { type FailReason, TERMINAL_STATES } from "@/server/relay/domain/session";
import { mintRelayToken } from "@/server/relay/tokens";
import { seedOrg, startedDivisionWithFixture } from "./_rig";
import { grantCredits } from "../stream-credits";
import { createStreamTarget } from "../stream-targets";
import { type SessionDeps, createSession, currentSession, heartbeat, stopSession } from "../stream-sessions";
import { type BackstopBucket, SweepScopeEmpty, backstopOutcome, isOrphan, sweepSessionLockKey, sweepStreamSessions } from "../relay-sweep";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

const HAS_DB = !!process.env.DATABASE_URL;
const DAY_MS = 86_400_000;
/** A storage pool no plausible number of foreign reservations can exhaust (stream-sessions.test.ts's, int4-safe). */
const ROOMY_STORAGE_MINUTES = 100_000_000;
/** Past the runner's stop grace + observe slack — the grace clause `evaluate` reads — with the clock margin above. */
const PAST_GRACE_SECONDS = RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS + 60;
/** A beat older than the stale threshold, with the same margin. */
const STALE_BEAT_SECONDS = STALE_HEARTBEAT_SECONDS + 60;

async function rig(mode: "passthrough" | "composed" = "passthrough") {
  const seeded = await seedOrg();
  // A8: seedOrg's auth.userId is null and createSession refuses a start nobody made (403) — a REAL users row starts it.
  const auth = { ...seeded.auth, userId: await rigUser() };
  const { fixtureId } = await startedDivisionWithFixture(auth);
  for (const key of ["streaming.overlay", "streaming.relay"]) {
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${auth.orgId}, ${key}, true, 'r1 unit')
              on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  await invalidateOrgEntitlements(auth.orgId);
  await grantCredits({ orgId: auth.orgId, delta: 2, createdBy: await rigUser(), note: "unit", idempotencyKey: randomUUID() });
  const target = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "T", rtmpUrl: "rtmps://a.rtmps.youtube.com/live2", streamKey: "k", watchUrl: "https://www.youtube.com/watch?v=sweep" });
  let now = Date.now();
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs: 3000 });
  // Admission reserves against EVERY active session in the database (one account-wide pool), so the fake's default
  // 1000-minute pool is exhausted by other files' leftovers and every start would read 503 storage_exhausted.
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const runner = new FakeRunner();
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(now), appUrl: "http://app.test" };
  const { sessionId } = await createSession(auth, fixtureId, { mode, targetId: target.id }, deps);
  const state = async (sid = sessionId) => (await sql<{
    state: string; fail_reason: string | null; machine_id: string | null; runner_retries: number; runner_state: string; runner_gone_confirmed_at: Date | null;
  }[]>`
    select state, fail_reason, machine_id, runner_retries, runner_state, runner_gone_confirmed_at from fixture_stream_sessions where id = ${sid}`)[0]!;
  // `fixtureId` is returned because the ruling-13 tests drive `currentSession` and `stopSession`, both of which take it.
  return { auth, orgId: auth.orgId, fixtureId, targetId: target.id, sessionId, ingest, runner, deps, state, tick: (ms: number) => { now += ms; } };
}
type Rig = Awaited<ReturnType<typeof rig>>;

/** The sweep under test, SCOPED to `orgIds` (default: the rig's own org), on the rig's clock moved up to the real now. */
async function sweep(r: Rig, o: { orgIds?: string[]; runner?: RunnerProvider; ingest?: IngestProvider; sampleRetentionDays?: number | null } = {}) {
  const lag = Date.now() - r.deps.now().getTime();
  if (lag > 0) r.tick(lag);
  const { orgIds = [r.orgId], runner, ingest, ...rest } = o;
  return sweepStreamSessions({ ...r.deps, drivers: { ingest: ingest ?? r.ingest, runner: runner ?? r.runner } }, { ...rest, orgIds });
}

/** A recording made a minute ago. NOT `new Date()`: the port lists videos created strictly BEFORE the sweep's now, and a
 *  video stamped in the same millisecond as the synced clock is — correctly — not listed at all. */
const justBefore = () => new Date(Date.now() - 60_000).toISOString();

/** A composed rig's Machine calls back `playing`: the session goes live on attempt 1's Machine. */
async function goLive(r: Rig): Promise<string> {
  await heartbeat(r.sessionId, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
  return (await r.state()).machine_id!;
}

/** A runner whose FIRST `list()` answers empty — a create still in flight when the backstop's reconcile looks for it —
 *  so the backstop cannot adopt the Machine and the ORPHAN pass is the one that meets the `creating` row. */
function createInFlight(real: FakeRunner): RunnerProvider {
  let calls = 0;
  return Object.assign(Object.create(real) as FakeRunner, { async list() { calls += 1; return calls === 1 ? [] : real.list(); } });
}

const effects = (sid: string, type: string) => sql<{ source: string; result: string | null; payload: Record<string, unknown> }[]>`
  select source, result, payload from fixture_stream_events where session_id = ${sid} and kind = 'effect' and type = ${type} order by seq`;

describe.skipIf(!HAS_DB)("relay sweep (daily)", () => {
  it("EMPTY: a scope with no sessions, Machines or videos → every counter zero, the runner never listed, videos listed once, headroom still reported and snapshotted", async () => {
    const { auth } = await seedOrg();
    const ingest = new FakeIngest();
    ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
    const runner = new FakeRunner();
    const listMachines = vi.spyOn(runner, "list");
    const listVideos = vi.spyOn(ingest, "listVideos");
    const at = new Date();
    const deps: SessionDeps = { drivers: { ingest, runner }, now: () => at, appUrl: "x" };
    const res = await sweepStreamSessions(deps, { orgIds: [auth.orgId] });
    // Sums EVERY backstop counter, so a bucket added later is held to the empty case without an edit here.
    const counters = Object.values(res.backstop);
    expect(counters.length).toBeGreaterThan(0);
    expect(counters.reduce((a, b) => a + b, 0)).toBe(0);
    expect(res).toMatchObject({
      runnerListing: "not_needed", machinesListed: 0, orphansDestroyed: 0, orphanDestroysFailed: 0, runnerGoneConfirmed: 0,
      videosListed: 0, listingTruncated: false, videosDeleted: 0, videosDeferred: 0, inputsDeleted: 0, inputsDeferred: 0, retentionFailed: 0,
      videosSeen: 0, recordingsFinalised: 0, summariesWritten: 0, samplesDeleted: 0,
    });
    expect(listMachines).not.toHaveBeenCalled();   // no composed session in scope ever held a runner
    expect(listVideos).toHaveBeenCalledTimes(1);
    // Headroom is the ACCOUNT's, not the scope's — other files reserve from the same pool concurrently — so it is bounded
    // (nothing is stored; reservations only subtract) and equated with the snapshot the run wrote, never with a literal.
    expect(Number.isInteger(res.headroomMinutes)).toBe(true);
    expect(res.headroomMinutes).toBeLessThanOrEqual(ROOMY_STORAGE_MINUTES);
    expect(res.headroomMinutes).toBeGreaterThan(0);
    const snaps = await sql<{ used_minutes: number; limit_minutes: number; reserved_minutes: number; headroom_minutes: number; videos_deleted: number; deferred: number }[]>`
      select used_minutes, limit_minutes, reserved_minutes, headroom_minutes, videos_deleted, deferred from stream_storage_snapshots where source = 'sweep' and taken_at = ${at}`;
    expect(snaps).toEqual([{ used_minutes: 0, limit_minutes: ROOMY_STORAGE_MINUTES, reserved_minutes: ROOMY_STORAGE_MINUTES - res.headroomMinutes, headroom_minutes: res.headroomMinutes, videos_deleted: 0, deferred: 0 }]);
  });

  it("BACKSTOP: a warming session nobody reads past the warming timeout is failed by the sweep, and counted in ITS bucket (mutant: delete the sweep's reconcileSession call → red)", async () => {
    const r = await rig();
    await sql`update fixture_stream_sessions set created_at = now() - make_interval(mins => ${WARMING_TIMEOUT_MINUTES + 1}) where id = ${r.sessionId}`;
    const res = await sweep(r);
    expect(res.backstop).toMatchObject({ candidates: 1, visited: 1, skippedLocked: 0, errored: 0, warmingTimedOut: 1, crashed: 0 });
    expect(await r.state()).toMatchObject({ state: "failed", fail_reason: "no_inbound_timeout" });
  });

  it("BACKSTOP: a live composed session with a stale beat is retried once by the sweep, and crashed on the next day's pass", async () => {
    const r = await rig("composed");
    const first = await goLive(r);
    await sql`update fixture_stream_sessions set heartbeat_at = now() - make_interval(secs => ${STALE_BEAT_SECONDS}) where id = ${r.sessionId}`;
    expect((await sweep(r)).backstop).toMatchObject({ candidates: 1, visited: 1, retried: 1, crashed: 0 });
    const after = await r.state();
    expect(after).toMatchObject({ state: "live", runner_retries: 1 });
    expect(after.machine_id).not.toBe(first);
    expect(r.runner.destroyed).toContain(first);
    // G1 (Task 2C re-review 1): the retry wrote beat_window_at; age BOTH anchors, or `evaluate` (the later of the two) reads `none`.
    await sql`update fixture_stream_sessions set heartbeat_at = now() - make_interval(secs => ${STALE_BEAT_SECONDS}),
                  beat_window_at = now() - make_interval(secs => ${STALE_BEAT_SECONDS}) where id = ${r.sessionId}`;
    expect((await sweep(r)).backstop).toMatchObject({ candidates: 1, visited: 1, crashed: 1, retried: 0 });
    expect(await r.state()).toMatchObject({ state: "failed", fail_reason: "machine_crash" });
    expect(r.runner.destroyed).toContain(after.machine_id!);
  });

  it("BACKSTOP: a session stuck in `stopping` (Fly never reports destroyed) is FORCED and COMPLETED after grace + slack, and a Machine observed gone without our stop is `lost` → retried (mutant: replace reconcileSession with applyExpiry → the LOST half red)", async () => {
    const stuck = await rig("composed");
    const m1 = await goLive(stuck);
    // C16: derived from the constants, never a literal interval. `ending_at` is set too, or the F22 backstop falls through.
    await sql`update fixture_stream_sessions set state = 'ending', desired_state = 'ending', end_reason = 'stopped', runner_state = 'stopping',
                  ending_at = now(), runner_stop_requested_at = now() - make_interval(secs => ${PAST_GRACE_SECONDS}) where id = ${stuck.sessionId}`;
    stuck.runner.setObserved(m1, "stopping");
    const forced = await sweep(stuck);
    expect(stuck.runner.destroyed).toContain(m1);
    expect(await stuck.state()).toMatchObject({ state: "completed" });
    expect(forced.backstop).toMatchObject({ candidates: 1, visited: 1, graceForced: 1, endingTimedOut: 0, completedObserved: 0 });

    const lost = await rig("composed");
    const m2 = await goLive(lost);
    lost.runner.setObserved(m2, "failed", { exitCode: 1, oomKilled: false, requestedStop: false });
    const res = await sweep(lost);
    expect(res.backstop).toMatchObject({ candidates: 1, visited: 1, retried: 1 });
    expect(await lost.state()).toMatchObject({ state: "live", runner_retries: 1 });
    expect((await lost.state()).machine_id).not.toBe(m2);
  });

  it("ORPHANS: a Machine with no session, one whose metadata names no session at all, and one whose session is terminal are destroyed — the terminal one through the shared forceDestroy, on EVERY pass (A22(a)); a live session's Machine is kept", async () => {
    const live = await rig("composed");
    const liveMachine = await goLive(live);
    live.runner.addOrphan("fake-machine-nobody", null);
    live.runner.addOrphan("fake-machine-junk-meta", "not-a-session-uuid");   // a malformed id must not abort the pass (22P02 on `id in (…)`)
    const dead = await rig("composed");
    await sql`update fixture_stream_sessions set state = 'completed', ended_at = now() where id = ${dead.sessionId}`;
    const deadMachine = (await dead.state()).machine_id!;
    live.runner.addOrphan(deadMachine, dead.sessionId);   // separate FakeRunners: plant the dead one's Machine in the runner the sweep reads
    const scope = [live.orgId, dead.orgId];
    const res = await sweep(live, { orgIds: scope });
    expect(res.runnerListing).toBe("listed");
    expect(res.machinesListed).toBe(4);
    expect(res.orphansDestroyed).toBe(3);
    expect(res.orphanDestroysFailed).toBe(0);
    expect(live.runner.destroyed).toEqual(expect.arrayContaining(["fake-machine-nobody", "fake-machine-junk-meta", deadMachine]));
    expect(live.runner.destroyed).not.toContain(liveMachine);
    expect((await live.runner.list()).map((m) => m.runnerId)).toEqual([liveMachine]);
    // T12-a: the orphan pass never feeds `orphan_listed` to `decide` — least of all for a LIVE row.
    expect(await live.state()).toMatchObject({ state: "live", machine_id: liveMachine, runner_retries: 0 });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id in (${live.sessionId}, ${dead.sessionId}) and type = 'orphan_listed'`;
    expect(n).toBe(0);
    // A22(b): the terminal session's destroy went through the SHARED forceDestroy — one effect row on ITS ledger, source sweep.
    const fx = await effects(dead.sessionId, "force_destroy");
    expect(fx).toHaveLength(1);
    expect(fx[0]).toMatchObject({ source: "sweep", result: "ok", payload: { machineId: deadMachine, reason: "sweep" } });

    // A22(a) — EVERY pass: a second Machine for the same terminal session (a late create's) is destroyed by the next pass too.
    live.runner.addOrphan("fake-machine-dead-again", dead.sessionId);
    const again = await sweep(live, { orgIds: scope });
    expect(again.machinesListed).toBe(2);
    expect(again.orphansDestroyed).toBe(1);
    expect(live.runner.destroyed).toContain("fake-machine-dead-again");
    expect((await live.runner.list()).map((m) => m.runnerId)).toEqual([liveMachine]);
  });

  it("A22(b): a LIVE session's stale Machine (one its row no longer names) is destroyed through the shared forceDestroy; a FAILED destroy is recorded, alarmed with site `sweep`, and retried by the NEXT pass", async () => {
    const r = await rig("composed");
    const m1 = await goLive(r);
    // The row moved on to attempt 2's Machine while attempt 1's is still listed — what a stale_create whose destroy failed,
    // or a force_destroy that threw, leaves behind. Nothing lazy owns it on a live session.
    const { runnerId: m2 } = await r.runner.create({ ...r.runner.created[0]!, attempt: 2 });
    await sql`update fixture_stream_sessions set runner_attempts = 2, runner_retries = 1, runner_name = ${machineNameFor(r.sessionId, 2)}, machine_id = ${m2} where id = ${r.sessionId}`;
    const failure = new Error("fly 503 on destroy");
    let calls = 0;
    const flaky = Object.assign(Object.create(r.runner) as FakeRunner, {
      async destroy(id: string) { if (id === m1 && calls++ === 0) throw failure; return r.runner.destroy(id); },
    });
    sentry.captureError.mockClear();
    const first = await sweep(r, { runner: flaky });
    expect(first).toMatchObject({ machinesListed: 2, orphansDestroyed: 0, orphanDestroysFailed: 1 });
    expect((await r.runner.list()).map((m) => m.runnerId).sort()).toEqual([m1, m2].sort());
    expect(sentry.captureError).toHaveBeenCalledTimes(1);
    expect(sentry.captureError).toHaveBeenCalledWith(failure, {
      orgId: r.orgId, route: "relay.force_destroy",
      extra: { sessionId: r.sessionId, machineId: m1, machineName: machineNameFor(r.sessionId, 1), attempt: 2, site: "sweep" },
    });
    expect(await effects(r.sessionId, "force_destroy")).toEqual([expect.objectContaining({ source: "sweep", result: "failed" })]);
    expect(await r.state()).toMatchObject({ state: "live", machine_id: m2 });   // the live row itself is never touched

    const second = await sweep(r, { runner: flaky });
    expect(second).toMatchObject({ machinesListed: 2, orphansDestroyed: 1, orphanDestroysFailed: 0 });
    expect((await r.runner.list()).map((m) => m.runnerId)).toEqual([m2]);
    expect((await effects(r.sessionId, "force_destroy")).map((e) => e.result)).toEqual(["failed", "ok"]);
  });

  it("C6/A35: a session mid-create keeps its Machine, while a genuinely orphaned one is destroyed in the SAME pass", async () => {
    const creating = await rig("composed");
    const mine = (await creating.state()).machine_id!;
    // Invariant 4's order: `runner_state = 'creating'` is persisted BEFORE the create call, so machine_id is still null while
    // a Machine already exists. The first list is empty (the create in flight), so the backstop cannot adopt it first.
    await sql`update fixture_stream_sessions set runner_state = 'creating', machine_id = null where id = ${creating.sessionId}`;
    creating.runner.addOrphan("machine-nobody-owns", null);
    const res = await sweep(creating, { runner: createInFlight(creating.runner) });
    expect(creating.runner.destroyed).toContain("machine-nobody-owns");   // the positive pair: the pass still destroys
    expect(creating.runner.destroyed).not.toContain(mine);
    expect(res.machinesListed).toBe(2);
    expect(res.orphansDestroyed).toBe(1);
  });

  it("C6, the other attempt: a row CREATING attempt 2 keeps attempt 2's Machine (its name) and destroys attempt 1's, whose name it no longer carries", async () => {
    const r = await rig("composed");
    const m1 = (await r.state()).machine_id!;
    const { runnerId: m2 } = await r.runner.create({ ...r.runner.created[0]!, attempt: 2 });
    await sql`update fixture_stream_sessions set runner_state = 'creating', runner_attempts = 2, runner_retries = 1,
                  runner_name = ${machineNameFor(r.sessionId, 2)}, machine_id = null where id = ${r.sessionId}`;
    const res = await sweep(r, { runner: createInFlight(r.runner) });
    expect(res).toMatchObject({ machinesListed: 2, orphansDestroyed: 1 });
    expect(r.runner.destroyed).toContain(m1);
    expect(r.runner.destroyed).not.toContain(m2);
    expect(await effects(r.sessionId, "force_destroy")).toEqual([expect.objectContaining({ source: "sweep", result: "ok", payload: expect.objectContaining({ machineId: m1 }) })]);
  });

  it("A22(c): a terminal session whose Machine the listing no longer carries is MARKED confirmed once, and admission on its fixture then skips the provider — a Fly outage no longer refuses a passthrough start; the unmarked twin still asks and is refused", async () => {
    const settle = async (r: Rig) => {
      const m = await goLive(r);
      await sql`update fixture_stream_sessions set state = 'completed', desired_state = 'ending', end_reason = 'stopped', ended_at = now(), runner_state = 'destroyed' where id = ${r.sessionId}`;
      r.runner.setObserved(m, "destroyed");   // gone from the provider's listing
    };
    const outage = (real: FakeRunner) => Object.assign(Object.create(real) as FakeRunner, { async list(): Promise<never> { throw new Error("fly is down"); } });

    const r = await rig("composed");
    await settle(r);
    expect((await r.state()).runner_gone_confirmed_at).toBeNull();
    const res = await sweep(r);
    expect(res).toMatchObject({ runnerListing: "listed", machinesListed: 0, runnerGoneConfirmed: 1 });
    expect((await r.state()).runner_gone_confirmed_at).toBeInstanceOf(Date);
    expect((await sweep(r)).runnerGoneConfirmed).toBe(0);   // the second pass confirms nothing new

    const down = outage(r.runner);
    const asked = vi.spyOn(down, "list");
    const next = await createSession(r.auth, r.fixtureId, { mode: "passthrough", targetId: r.targetId }, { ...r.deps, drivers: { ingest: r.ingest, runner: down } });
    expect(next.sessionId).not.toBe(r.sessionId);
    expect(asked).not.toHaveBeenCalled();

    const u = await rig("composed");
    await settle(u);   // the same shape, never swept
    await expect(createSession(u.auth, u.fixtureId, { mode: "passthrough", targetId: u.targetId }, { ...u.deps, drivers: { ingest: u.ingest, runner: outage(u.runner) } }))
      .rejects.toThrow("fly is down");
  });

  it("A22(c): admission reads BOTH halves — a marked row whose runner LEFT `destroyed` (a late create_ok: destroyed → lost) is asked about again", async () => {
    const r = await rig("composed");
    const m = await goLive(r);
    await sql`update fixture_stream_sessions set state = 'completed', desired_state = 'ending', end_reason = 'stopped', ended_at = now(), runner_state = 'destroyed' where id = ${r.sessionId}`;
    r.runner.setObserved(m, "destroyed");
    expect((await sweep(r)).runnerGoneConfirmed).toBe(1);
    await sql`update fixture_stream_sessions set runner_state = 'lost' where id = ${r.sessionId}`;   // the mark itself is untouched
    expect((await r.state()).runner_gone_confirmed_at).toBeInstanceOf(Date);
    const down = Object.assign(Object.create(r.runner) as FakeRunner, { async list(): Promise<never> { throw new Error("fly is down"); } });
    await expect(createSession(r.auth, r.fixtureId, { mode: "passthrough", targetId: r.targetId }, { ...r.deps, drivers: { ingest: r.ingest, runner: down } }))
      .rejects.toThrow("fly is down");
  });

  it("A22(c): the mark is CLEARED when a Machine reappears for a marked session and its destroy fails — and admission asks the provider again", async () => {
    const r = await rig("composed");
    const m = await goLive(r);
    await sql`update fixture_stream_sessions set state = 'completed', desired_state = 'ending', end_reason = 'stopped', ended_at = now(), runner_state = 'destroyed' where id = ${r.sessionId}`;
    r.runner.setObserved(m, "destroyed");
    expect((await sweep(r)).runnerGoneConfirmed).toBe(1);
    r.runner.addOrphan("fake-machine-late-create", r.sessionId);   // a late create's Machine the row never learned
    const failing = Object.assign(Object.create(r.runner) as FakeRunner, { async destroy(): Promise<never> { throw new Error("fly 500"); } });
    const res = await sweep(r, { runner: failing });
    expect(res).toMatchObject({ machinesListed: 1, orphansDestroyed: 0, orphanDestroysFailed: 1, runnerGoneConfirmed: 0 });
    expect((await r.state()).runner_gone_confirmed_at).toBeNull();
    const down = Object.assign(Object.create(r.runner) as FakeRunner, { async list(): Promise<never> { throw new Error("fly is down"); } });
    await expect(createSession(r.auth, r.fixtureId, { mode: "passthrough", targetId: r.targetId }, { ...r.deps, drivers: { ingest: r.ingest, runner: down } }))
      .rejects.toThrow("fly is down");
  });

  it("headroom below one retained match → warned with the number; reservations are included; a roomy pool is NOT warned (the differential pair)", async () => {
    const r = await rig();   // one warming session reserves MAX_DURATION_MINUTES
    r.ingest.storage = { totalStorageMinutes: 450, totalStorageMinutesLimit: 1000, videoCount: 1 };
    const warn = vi.spyOn(log, "warn");
    try {
      const tight = await sweep(r);
      expect(tight.headroomMinutes).toBeLessThanOrEqual(1000 - 450 - MAX_DURATION_MINUTES);   // this rig's own reservation is in it
      expect(tight.headroomMinutes).toBeLessThan(MAX_DURATION_MINUTES);
      const warned = warn.mock.calls.filter(([, msg]) => typeof msg === "string" && /headroom below one retained match/.test(msg));
      expect(warned).toHaveLength(1);
      expect(warned[0]![0]).toMatchObject({ headroomMinutes: tight.headroomMinutes, reservedForOneMatch: MAX_DURATION_MINUTES });

      warn.mockClear();
      r.ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
      const roomy = await sweep(r);
      // Upper bounds only: other files' sessions reserve from the same pool concurrently, and a bracket read before and
      // after the sweep is NOT sound — a foreign session can start after the first read and end before the second.
      expect(roomy.headroomMinutes).toBeLessThanOrEqual(ROOMY_STORAGE_MINUTES - MAX_DURATION_MINUTES);
      expect(roomy.headroomMinutes).toBeGreaterThanOrEqual(MAX_DURATION_MINUTES);
      expect(warn.mock.calls.filter(([, msg]) => typeof msg === "string" && /headroom below/.test(msg))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("G7: Cloudflare's FRACTIONAL storage minutes reach the integer columns conservatively — used rounds UP, the limit rounds DOWN — instead of 22P02-ing the sweep", async () => {
    const r = await rig();
    // 396.34 and +0.84 are chosen so Math.round would give the OTHER answer on both — a rounding mutant cannot pass.
    r.ingest.storage = { totalStorageMinutes: 396.34, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES + 0.84, videoCount: 2 };
    const res = await sweep(r);
    const at = r.deps.now();
    expect(Number.isInteger(res.headroomMinutes)).toBe(true);
    const [snap] = await sql<{ used_minutes: number; limit_minutes: number; headroom_minutes: number }[]>`
      select used_minutes, limit_minutes, headroom_minutes from stream_storage_snapshots where source = 'sweep' and taken_at = ${at} order by id desc limit 1`;
    expect(snap).toEqual({ used_minutes: 397, limit_minutes: ROOMY_STORAGE_MINUTES, headroom_minutes: res.headroomMinutes });
  });

  it("RETENTION: videos older than 3 days are deleted; a 409 is deferred to the NEXT DAY's pass; an input goes only after its videos are gone (C1, C2)", async () => {
    const r = await rig();
    await sql`update fixture_stream_sessions set state = 'completed', ended_at = now() - interval '4 days' where id = ${r.sessionId}`;
    const [inp] = await sql<{ ingest_input_id: string }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${r.sessionId}`;
    const inputId = inp!.ingest_input_id;
    const T = r.deps.now().getTime();
    r.ingest.addVideo({ videoId: "v_old", inputId, createdAt: new Date(T - (RECORDING_RETENTION_DAYS * 86_400 + 60) * 1000).toISOString(), inProgress: false });
    r.ingest.addVideo({ videoId: "v_new", inputId, createdAt: new Date(T - 3600 * 1000).toISOString(), inProgress: false });
    r.ingest.scriptDeleteVideo("v_old", ["in_progress"]);

    let res = await sweep(r);          // day 1: the 409
    expect(res).toMatchObject({ videosListed: 2, videosDeferred: 1, videosDeleted: 0, inputsDeleted: 0, inputsDeferred: 1 });
    expect(r.ingest.deletedInputs).toEqual([]);

    r.tick(DAY_MS);                    // day 2: the 409 is gone, v_new still holds the input
    res = await sweep(r);
    expect(res).toMatchObject({ videosListed: 2, videosDeleted: 1, videosDeferred: 0, inputsDeleted: 0, inputsDeferred: 1 });
    expect(r.ingest.deletedVideos).toEqual(["v_old"]);
    expect(r.ingest.deletedInputs).toEqual([]);

    r.tick(3 * DAY_MS);                // day 5: v_new past retention → deleted; nothing then names the input → deleted in the SAME pass
    res = await sweep(r);
    expect(res).toMatchObject({ videosListed: 1, videosDeleted: 1, inputsDeleted: 1, inputsDeferred: 0 });
    expect(r.ingest.deletedInputs).toEqual([inputId]);
    const [after] = await sql<{ ingest_input_id: string | null }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${r.sessionId}`;
    expect(after!.ingest_input_id).toBeNull();
  });

  it("RETENTION isolation: a video whose delete THROWS and an input whose delete throws are counted, the rest of the plan still runs, the input keeps its id — and the next day's healthy pass finishes both", async () => {
    const r = await rig();
    await stopSession(r.auth, r.fixtureId, r.sessionId, r.deps);
    await sql`update fixture_stream_sessions set ended_at = now() - make_interval(days => ${RECORDING_RETENTION_DAYS + 1}) where id = ${r.sessionId}`;
    const [inp] = await sql<{ ingest_input_id: string }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${r.sessionId}`;
    const old = new Date(r.deps.now().getTime() - (RECORDING_RETENTION_DAYS + 1) * DAY_MS).toISOString();
    r.ingest.addVideo({ videoId: "v-bad", inputId: null, createdAt: old, inProgress: false });
    r.ingest.addVideo({ videoId: "v-good", inputId: null, createdAt: old, inProgress: false });
    const failure = new Error("cloudflare 500");
    const flaky = Object.assign(Object.create(r.ingest) as FakeIngest, {
      async deleteVideo(id: string) { if (id === "v-bad") throw failure; return r.ingest.deleteVideo(id); },
      async deleteInput(): Promise<never> { throw failure; },
    });
    const res = await sweep(r, { ingest: flaky });
    expect(res).toMatchObject({ videosListed: 2, videosDeleted: 1, retentionFailed: 2, inputsDeleted: 0 });
    expect(r.ingest.deletedVideos).toEqual(["v-good"]);
    const kept = await sql<{ ingest_input_id: string | null }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${r.sessionId}`;
    expect(kept).toEqual([{ ingest_input_id: inp!.ingest_input_id }]);   // never nulled for a delete that did not happen

    const next = await sweep(r);
    expect(next).toMatchObject({ videosDeleted: 1, inputsDeleted: 1, retentionFailed: 0 });
    expect(r.ingest.deletedInputs).toEqual([inp!.ingest_input_id]);
  });

  it("A13: a FULL page (exactly LIST_VIDEOS_PAGE_LIMIT) is flagged and warned — and no input is deleted on a listing that may be missing its videos; one short of it is not flagged, lists once, and the input goes", async () => {
    const r = await rig();
    await stopSession(r.auth, r.fixtureId, r.sessionId, r.deps);
    await sql`update fixture_stream_sessions set ended_at = now() - make_interval(days => ${RECORDING_RETENTION_DAYS + 1}) where id = ${r.sessionId}`;
    const recent = new Date(r.deps.now().getTime() - 3600_000).toISOString();
    for (let i = 0; i < LIST_VIDEOS_PAGE_LIMIT; i++) r.ingest.addVideo({ videoId: `page-${i}`, inputId: null, createdAt: recent, inProgress: false });
    const listed = vi.spyOn(r.ingest, "listVideos");
    const warn = vi.spyOn(log, "warn");
    const truncation = () => warn.mock.calls.filter(([, msg]) => typeof msg === "string" && /full page/.test(msg));
    try {
      const full = await sweep(r);
      expect(listed).toHaveBeenCalledTimes(1);
      expect(full).toMatchObject({ videosListed: LIST_VIDEOS_PAGE_LIMIT, listingTruncated: true, inputsDeleted: 0, inputsDeferred: 1 });
      expect(r.ingest.deletedInputs).toEqual([]);
      expect(truncation()).toHaveLength(1);
      expect(truncation()[0]![0]).toMatchObject({ videosListed: LIST_VIDEOS_PAGE_LIMIT, pageLimit: LIST_VIDEOS_PAGE_LIMIT });

      await r.ingest.deleteVideo("page-0");   // one short of a page
      warn.mockClear();
      const short = await sweep(r);
      expect(listed).toHaveBeenCalledTimes(2);   // once per pass: no second page is asked for
      expect(short).toMatchObject({ videosListed: LIST_VIDEOS_PAGE_LIMIT - 1, listingTruncated: false, inputsDeleted: 1, inputsDeferred: 0 });
      expect(truncation()).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("the sweep lock: a session held by another sweep's transaction is skipped; released → visited", async () => {
    const r = await rig();
    await sql`update fixture_stream_sessions set created_at = now() - make_interval(mins => ${WARMING_TIMEOUT_MINUTES + 1}) where id = ${r.sessionId}`;
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    let locked!: () => void;
    const lockedP = new Promise<void>((res) => (locked = res));
    const holder = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${sweepSessionLockKey(r.sessionId)}))`;
      locked();
      await held;
    });
    await lockedP;
    const skipped = await sweep(r);
    expect(skipped.backstop).toMatchObject({ candidates: 1, visited: 0, skippedLocked: 1, warmingTimedOut: 0 });
    expect((await r.state()).state).toBe("warming");
    release();
    await holder;
    const visited = await sweep(r);
    expect(visited.backstop).toMatchObject({ candidates: 1, visited: 1, skippedLocked: 0, warmingTimedOut: 1 });
    expect((await r.state()).state).toBe("failed");
  });

  it("BACKSTOP isolation: a visit that THROWS is counted and alarmed, and the next session is still visited", async () => {
    const bad = await rig("composed");
    const mb = await goLive(bad);
    const good = await rig();
    await sql`update fixture_stream_sessions set created_at = now() - make_interval(mins => ${WARMING_TIMEOUT_MINUTES + 1}) where id = ${good.sessionId}`;
    const boom = new Error("observe exploded");
    const runner = Object.assign(Object.create(bad.runner) as FakeRunner, {
      async observe(id: string) { if (id === mb) throw boom; return bad.runner.observe(id); },
    });
    sentry.captureError.mockClear();
    const res = await sweep(bad, { runner, orgIds: [bad.orgId, good.orgId] });
    expect(res.backstop).toMatchObject({ candidates: 2, visited: 1, errored: 1, skippedLocked: 0, warmingTimedOut: 1 });
    expect(await good.state()).toMatchObject({ state: "failed", fail_reason: "no_inbound_timeout" });
    expect(sentry.captureError).toHaveBeenCalledWith(boom, { orgId: bad.orgId, route: "relay.sweep.backstop", extra: { sessionId: bad.sessionId } });
  });

  it("the runner listing FAILING does not stop the sweep: counted, alarmed, nothing destroyed or marked from a listing that never arrived, and retention still runs", async () => {
    const r = await rig("composed");
    const m = await goLive(r);
    await sql`update fixture_stream_sessions set state = 'completed', desired_state = 'ending', end_reason = 'stopped', ended_at = now(), runner_state = 'destroyed' where id = ${r.sessionId}`;
    r.runner.setObserved(m, "destroyed");
    r.ingest.addVideo({ videoId: "old-1", inputId: null, createdAt: new Date(r.deps.now().getTime() - (RECORDING_RETENTION_DAYS + 1) * DAY_MS).toISOString(), inProgress: false });
    const down = new Error("fly is down");
    const outage = Object.assign(Object.create(r.runner) as FakeRunner, { async list(): Promise<never> { throw down; } });
    sentry.captureError.mockClear();
    const res = await sweep(r, { runner: outage });
    expect(res).toMatchObject({ runnerListing: "failed", machinesListed: 0, orphansDestroyed: 0, runnerGoneConfirmed: 0, videosDeleted: 1 });
    expect((await r.state()).runner_gone_confirmed_at).toBeNull();
    expect(sentry.captureError).toHaveBeenCalledWith(down, { route: "relay.sweep.runner_list" });
  });

  it("BACKSTOP buckets: each timed exit lands in its OWN counter, an ending_timeout is a COMPLETION, and a grace-FORCED completion (F-A) is `graceForced`, never an ending timeout (2C-post m2)", async () => {
    const prov = await rig();
    await sql`update fixture_stream_sessions set state = 'provisioning', created_at = now() - make_interval(secs => ${PROVISION_TIMEOUT_SECONDS + 60}) where id = ${prov.sessionId}`;
    const adm = await rig();
    await sql`update fixture_stream_sessions set state = 'requested', created_at = now() - make_interval(secs => ${REQUESTED_TIMEOUT_SECONDS + 60}) where id = ${adm.sessionId}`;
    const end = await rig();
    await sql`update fixture_stream_sessions set state = 'ending', desired_state = 'ending', end_reason = 'stopped',
                  ending_at = now() - make_interval(secs => ${ENDING_TIMEOUT_SECONDS + 60}) where id = ${end.sessionId}`;
    // A SECOND ending timeout makes the two completion counters differ (2 vs 1), so a classifier that swaps the labels cannot pass.
    const end2 = await rig();
    await sql`update fixture_stream_sessions set state = 'ending', desired_state = 'ending', end_reason = 'stopped',
                  ending_at = now() - make_interval(secs => ${ENDING_TIMEOUT_SECONDS + 60}) where id = ${end2.sessionId}`;
    const forced = await rig("composed");
    await goLive(forced);
    await sql`update fixture_stream_sessions set state = 'ending', desired_state = 'ending', end_reason = 'stopped', runner_state = 'stopping', ending_at = now(),
                  runner_stop_requested_at = now() - make_interval(secs => ${PAST_GRACE_SECONDS}) where id = ${forced.sessionId}`;
    const res = await sweep(prov, { orgIds: [prov, adm, end, end2, forced].map((x) => x.orgId) });
    // The SPECIFIC counter, never a non-zero total: folding these into `crashed` would keep every "did something" assertion green.
    expect(res.backstop).toMatchObject({
      candidates: 5, visited: 5, errored: 0,
      provisionTimedOut: 1, admissionTimedOut: 1, endingTimedOut: 2, graceForced: 1, completedObserved: 0, crashed: 0, warmingTimedOut: 0, otherFailures: 0,
    });
    const at = async (sid: string) => (await sql<{ state: string; fail_reason: string | null }[]>`select state, fail_reason from fixture_stream_sessions where id = ${sid}`)[0]!;
    expect(await at(prov.sessionId)).toMatchObject({ state: "failed", fail_reason: "provision_timeout" });
    expect(await at(adm.sessionId)).toMatchObject({ state: "failed", fail_reason: "admission_timeout" });
    expect(await at(end.sessionId)).toMatchObject({ state: "completed", fail_reason: null });   // F22: it ended as asked
    expect(await at(end2.sessionId)).toMatchObject({ state: "completed", fail_reason: null });
    expect(await at(forced.sessionId)).toMatchObject({ state: "completed", fail_reason: null });   // F-A: a completion, its destroy forced
  });

  it("a NORMAL completion the backstop observes (the Machine auto-destroyed after our stop) is `completedObserved` — neither an ending timeout nor a forced one — and its now-gone Machine is marked confirmed", async () => {
    const r = await rig("composed");
    const m = await goLive(r);
    await sql`update fixture_stream_sessions set state = 'ending', desired_state = 'ending', end_reason = 'stopped', runner_state = 'stopping',
                  ending_at = now(), runner_stop_requested_at = now() where id = ${r.sessionId}`;
    r.runner.setObserved(m, "destroyed");
    const res = await sweep(r);
    expect(res.backstop).toMatchObject({ candidates: 1, visited: 1, completedObserved: 1, endingTimedOut: 0, graceForced: 0 });
    expect(await r.state()).toMatchObject({ state: "completed", runner_state: "destroyed" });
    expect(res.runnerGoneConfirmed).toBe(1);
  });

  it("G3: `retried` counts a REAL retry — a create call made during the visit — never a change in runner_retries (mutant: count by `runnerRetries` → red at retried 0)", async () => {
    const r = await rig("composed");
    await goLive(r);
    // I1 made runner_retries track the retry DECISION, so the persisted counter is already 1 when retry_runner never ran.
    await sql`update fixture_stream_sessions set runner_state = 'destroyed', machine_id = null, runner_retries = 1,
                  heartbeat_at = now() - make_interval(secs => ${STALE_BEAT_SECONDS}) where id = ${r.sessionId}`;
    const res = await sweep(r);
    expect(r.runner.created).toHaveLength(2);                                   // destroyed × stale_beat re-signalled, and the ONE retry ran…
    expect(res.backstop).toMatchObject({ candidates: 1, visited: 1, retried: 1 });   // …so it is counted
    expect(await r.state()).toMatchObject({ state: "live", runner_retries: 1 });
    const [{ runner_attempts }] = await sql<{ runner_attempts: number }[]>`select runner_attempts from fixture_stream_sessions where id = ${r.sessionId}`;
    expect(runner_attempts).toBe(2);
    const again = await sweep(r);
    expect(r.runner.created).toHaveLength(2);
    expect(again.backstop.retried).toBe(0);
  });

  it("C27: a TERMINAL session whose Machine is still alive is visited and cleaned up — the runner advances, the session state does not — and the confirmed-gone Machine is then marked", async () => {
    const r = await rig("composed");
    const machine = await goLive(r);
    await sql`update fixture_stream_sessions set state = 'failed', fail_reason = 'machine_crash', end_reason = null, runner_state = 'stopping',
                  runner_stop_requested_at = now() - make_interval(secs => ${PAST_GRACE_SECONDS}) where id = ${r.sessionId}`;
    r.runner.setObserved(machine, "stopping");
    const res = await sweep(r);
    expect(r.runner.destroyed).toContain(machine);
    expect(await r.state()).toMatchObject({ state: "failed", fail_reason: "machine_crash", runner_state: "destroyed" });
    expect(res.backstop).toMatchObject({ candidates: 1, visited: 1, terminalRunnersSettled: 1, crashed: 0 });   // not a NEW failure
    expect(res.runnerGoneConfirmed).toBe(1);
  });

  it("2C-post m1: a TERMINAL session holding a LOST runner whose Machine still runs gets its force_destroy RE-ISSUED by the backstop, and the confirmation settles the row (mutant: delete the re-issue → red at `orphansDestroyed` 1 and `runner_state` lost)", async () => {
    const r = await rig("composed");
    const machine = await goLive(r);
    await sql`update fixture_stream_sessions set state = 'completed', desired_state = 'ending', end_reason = 'stopped', ended_at = now(),
                  runner_state = 'lost' where id = ${r.sessionId}`;
    const res = await sweep(r);
    expect(r.runner.destroyed.filter((id) => id === machine)).toEqual([machine]);   // destroyed exactly once…
    expect(res.orphansDestroyed).toBe(0);                                             // …by the re-issue, so the orphan pass found nothing left
    expect(res.backstop).toMatchObject({ candidates: 1, visited: 1, terminalRunnersSettled: 1 });
    const [row] = await sql<{ state: string; runner_state: string }[]>`select state, runner_state from fixture_stream_sessions where id = ${r.sessionId}`;
    expect(row).toMatchObject({ state: "completed", runner_state: "destroyed" });      // the runner settled; the SESSION state did not move (C27)
    const rt = await sql<{ type: string; from_state: string; to_state: string }[]>`
      select type, from_state, to_state from fixture_stream_events
       where session_id = ${r.sessionId} and kind = 'runner_transition' and type in ('grace_expired', 'destroy_ok') order by seq`;
    expect(rt).toEqual([
      { type: "grace_expired", from_state: "lost", to_state: "lost" },
      { type: "destroy_ok", from_state: "lost", to_state: "destroyed" },
    ]);
  });

  it("C15: a terminal session with NO ended_at gets no summary — and its raw samples are never deleted unsummarised", async () => {
    const r = await rig();
    const token = await mintRelayToken({ sid: r.sessionId, scope: "relay-job", expiresAt: new Date(Date.now() + 60_000) });
    await heartbeat(r.sessionId, token, { state: "playing", fps: 30 }, r.deps);
    await sql`update fixture_stream_sessions set state = 'failed', fail_reason = 'machine_crash', ended_at = null, sample_summary = null where id = ${r.sessionId}`;
    const res = await sweep(r, { sampleRetentionDays: 0 });   // cutoff = now; a null ended_at is neither summarised nor "older than" it
    expect(res.summariesWritten).toBe(0);
    expect(res.samplesDeleted).toBe(0);
    const [row] = await sql<{ summary: unknown; n: number }[]>`
      select sample_summary as summary, (select count(*)::int from fixture_stream_samples where session_id = ${r.sessionId}) as n
        from fixture_stream_sessions where id = ${r.sessionId}`;
    expect(row!.summary).toBeNull();
    expect(row!.n).toBeGreaterThan(0);
  });

  it("C15, the deletion's OWN guard: a row the summary phase skips while its ended_at is old enough to prune keeps its samples — and the same row made terminal is summarised, then pruned, in one pass (mutant: drop `sample_summary is not null` → red)", async () => {
    // The summary phase writes TERMINAL rows only; the deletion reads ended_at. The domain stamps ended_at only on a
    // terminal transition, so a non-terminal row carrying one is exactly the assumption the summary guard exists for.
    const r = await rig();
    const token = await mintRelayToken({ sid: r.sessionId, scope: "relay-job", expiresAt: new Date(Date.now() + 60_000) });
    await heartbeat(r.sessionId, token, { state: "playing", fps: 30 }, r.deps);
    await sql`update fixture_stream_sessions set ended_at = now() - interval '2 days' where id = ${r.sessionId}`;
    const samplesOf = async () => (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_samples where session_id = ${r.sessionId}`)[0]!.n;
    const n = await samplesOf();
    expect(n).toBeGreaterThan(0);
    const [live] = await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${r.sessionId}`;
    expect(TERMINAL_STATES as readonly string[]).not.toContain(live!.state);
    const skipped = await sweep(r, { sampleRetentionDays: 1 });
    expect(skipped.summariesWritten).toBe(0);
    expect(skipped.samplesDeleted).toBe(0);
    expect(await samplesOf()).toBe(n);
    // the positive pair: the SAME row, now terminal with the same old ended_at, is summarised and then pruned
    await sql`update fixture_stream_sessions set state = 'failed', fail_reason = 'machine_crash' where id = ${r.sessionId}`;
    const pruned = await sweep(r, { sampleRetentionDays: 1 });
    expect(pruned.summariesWritten).toBe(1);
    expect(pruned.samplesDeleted).toBe(n);
    expect(await samplesOf()).toBe(0);
  });

  it("RETENTION default is the OWNER-RULED constant, not null: ended (constant + 1) days ago loses its raw samples, (constant − 1) keeps them", async () => {
    expect(SAMPLE_RETENTION_DAYS).toBe(90);   // the ruling itself — a silent return to null reds HERE first
    const old = await rig();
    const recent = await rig();
    for (const r of [old, recent]) {
      const token = await mintRelayToken({ sid: r.sessionId, scope: "relay-job", expiresAt: new Date(Date.now() + 60_000) });
      await heartbeat(r.sessionId, token, { state: "playing", fps: 30 }, r.deps);
      await stopSession(r.auth, r.fixtureId, r.sessionId, r.deps);
    }
    await sql`update fixture_stream_sessions set ended_at = now() - make_interval(days => ${SAMPLE_RETENTION_DAYS + 1}) where id = ${old.sessionId}`;
    await sql`update fixture_stream_sessions set ended_at = now() - make_interval(days => ${SAMPLE_RETENTION_DAYS - 1}) where id = ${recent.sessionId}`;
    const n = async (sid: string) => (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_samples where session_id = ${sid}`)[0]!.n;
    const oldSamples = await n(old.sessionId);
    expect(oldSamples).toBeGreaterThan(0);
    const res = await sweep(old, { orgIds: [old.orgId, recent.orgId] });        // NO sampleRetentionDays: the ruled default
    expect(res.summariesWritten).toBe(2);
    expect(res.samplesDeleted).toBe(oldSamples);
    expect(await n(old.sessionId)).toBe(0);
    expect(await n(recent.sessionId)).toBeGreaterThan(0);   // the differential: a blanket delete fails here
  });

  it("Dd: recording_bytes is the summed size, ONE recording_finalised event per videoUid, idempotent — and a video that finalises LATER still gets its row", async () => {
    const r = await rig();
    const [{ ingest_input_uid }] = await sql<{ ingest_input_uid: string }[]>`select ingest_input_uid from fixture_stream_sessions where id = ${r.sessionId}`;
    await stopSession(r.auth, r.fixtureId, r.sessionId, r.deps);
    r.ingest.addVideo({ videoId: "v-1", inputId: ingest_input_uid, createdAt: justBefore(), inProgress: false, durationSeconds: 60, sizeBytes: 1000, width: 1920, height: 1080 });
    r.ingest.addVideo({ videoId: "v-live", inputId: ingest_input_uid, createdAt: justBefore(), inProgress: true });
    const bytes = async () => (await sql<{ b: string }[]>`select recording_bytes::text as b from fixture_stream_sessions where id = ${r.sessionId}`)[0]!.b;
    const finalised = async () => (await sql<{ uid: string }[]>`
      select payload->>'videoUid' as uid from fixture_stream_events where session_id = ${r.sessionId} and type = 'recording_finalised' order by uid`).map((x) => x.uid);

    expect((await sweep(r)).recordingsFinalised).toBe(1);
    expect(await bytes()).toBe("1000");                 // the in-progress video's nulls contribute nothing
    expect(await finalised()).toEqual(["v-1"]);         // and it gets NO event while it is still live
    expect((await sweep(r)).recordingsFinalised).toBe(0);
    expect(await finalised()).toEqual(["v-1"]);         // idempotent across runs

    r.ingest.addVideo({ videoId: "v-2", inputId: ingest_input_uid, createdAt: justBefore(), inProgress: false, durationSeconds: 30, sizeBytes: 500 });
    expect((await sweep(r)).recordingsFinalised).toBe(1);
    expect(await bytes()).toBe("1500");
    expect(await finalised()).toEqual(["v-1", "v-2"]);  // the late arrival is not skipped by the guard
  });

  it("partial retention never SHRINKS the facts: after the older recording is deleted, the listing's smaller sum does not overwrite what the session recorded", async () => {
    const r = await rig();
    const [{ ingest_input_uid }] = await sql<{ ingest_input_uid: string }[]>`select ingest_input_uid from fixture_stream_sessions where id = ${r.sessionId}`;
    await stopSession(r.auth, r.fixtureId, r.sessionId, r.deps);
    const T = r.deps.now().getTime();
    r.ingest.addVideo({ videoId: "v-old", inputId: ingest_input_uid, createdAt: new Date(T - (RECORDING_RETENTION_DAYS + 1) * DAY_MS).toISOString(), inProgress: false, durationSeconds: 60, sizeBytes: 1000 });
    r.ingest.addVideo({ videoId: "v-new", inputId: ingest_input_uid, createdAt: new Date(T - 3600_000).toISOString(), inProgress: false, durationSeconds: 30, sizeBytes: 500 });
    const facts = async () => (await sql<{ video_uids: string[]; recording_seconds: number; b: string }[]>`
      select video_uids, recording_seconds, recording_bytes::text as b from fixture_stream_sessions where id = ${r.sessionId}`)[0]!;
    const first = await sweep(r);
    expect(first).toMatchObject({ videosListed: 2, videosDeleted: 1 });
    expect(await facts()).toEqual({ video_uids: ["v-new", "v-old"], recording_seconds: 90, b: "1500" });
    const second = await sweep(r);
    expect(second).toMatchObject({ videosListed: 1, videosSeen: 1 });
    expect(await facts()).toEqual({ video_uids: ["v-new", "v-old"], recording_seconds: 90, b: "1500" });
  });

  it("ONE storage snapshot per run, carrying the run's deletion counts and the same headroom the result reports — a second run is a second row, never a rewrite", async () => {
    const r = await rig();
    r.ingest.addVideo({ videoId: "old-1", inputId: null, createdAt: new Date(r.deps.now().getTime() - (RECORDING_RETENTION_DAYS + 1) * DAY_MS).toISOString(), inProgress: false, durationSeconds: 100 });
    const res = await sweep(r);
    const at = r.deps.now();
    const snaps = async () => sql<{ id: number; source: string; headroom_minutes: number; videos_deleted: number; deferred: number }[]>`
      select id, source, headroom_minutes, videos_deleted, deferred from stream_storage_snapshots where source = 'sweep' and taken_at = ${at} order by id`;
    const one = await snaps();
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ source: "sweep", headroom_minutes: res.headroomMinutes, videos_deleted: 1, deferred: 0 });
    const again = await sweepStreamSessions(r.deps, { orgIds: [r.orgId] });   // unsynced: the frozen clock gives the same taken_at
    const two = await snaps();
    expect(two).toHaveLength(2);
    expect(two[0]!.id).toBe(one[0]!.id);
    expect(two[1]).toMatchObject({ headroom_minutes: again.headroomMinutes, videos_deleted: 0 });
  });

  it("summary ONCE, retention behind the constant: null deletes nothing; 1 day deletes the raw samples of a session ended 2 days ago and keeps its summary", async () => {
    const r = await rig();
    const token = await mintRelayToken({ sid: r.sessionId, scope: "relay-job", expiresAt: new Date(Date.now() + 60_000) });
    r.tick(3001); await currentSession(r.auth, r.fixtureId, r.deps);
    for (const fps of [30, 24, 30]) await heartbeat(r.sessionId, token, { state: "playing", fps, bitrateKbps: 4000, egressBytes: 0 }, r.deps);
    await stopSession(r.auth, r.fixtureId, r.sessionId, r.deps);
    await sql`update fixture_stream_sessions set ended_at = now() - interval '2 days' where id = ${r.sessionId}`;
    const first = await sweep(r, { sampleRetentionDays: null });
    expect(first.summariesWritten).toBe(1); expect(first.samplesDeleted).toBe(0);
    const [s] = await sql<{ sample_summary: { count: number; fpsMin: number; fpsMax: number; stalls: number } }[]>`select sample_summary from fixture_stream_sessions where id = ${r.sessionId}`;
    expect(s!.sample_summary).toMatchObject({ count: 4, fpsMin: 24, fpsMax: 30, stalls: 0 });   // 3 beats + 1 poll
    const again = await sweep(r, { sampleRetentionDays: null });
    expect(again.summariesWritten).toBe(0);                                                        // once
    const pruned = await sweep(r, { sampleRetentionDays: 1 });
    expect(pruned.samplesDeleted).toBe(4);
    const [after] = await sql<{ sample_summary: unknown; n: number }[]>`select sample_summary, (select count(*)::int from fixture_stream_samples where session_id = ${r.sessionId}) as n from fixture_stream_sessions where id = ${r.sessionId}`;
    expect(after!.sample_summary).toBeTruthy(); expect(after!.n).toBe(0);
  });

  it("video facts: listed recordings land on the session by input uid — video_uids (distinct, ordered) and recording_seconds — and the sweep lists videos ONCE", async () => {
    const r = await rig();
    const [{ ingest_input_uid }] = await sql<{ ingest_input_uid: string }[]>`select ingest_input_uid from fixture_stream_sessions where id = ${r.sessionId}`;
    r.ingest.addVideo({ videoId: "v-b", inputId: ingest_input_uid, createdAt: justBefore(), inProgress: false, durationSeconds: 61 });
    r.ingest.addVideo({ videoId: "v-a", inputId: ingest_input_uid, createdAt: justBefore(), inProgress: false, durationSeconds: 30 });
    const listSpy = vi.spyOn(r.ingest, "listVideos");
    const res = await sweep(r);
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ videosListed: 2, videosSeen: 2 });
    const [f] = await sql<{ video_uids: string[]; recording_seconds: number }[]>`select video_uids, recording_seconds from fixture_stream_sessions where id = ${r.sessionId}`;
    expect(f).toEqual({ video_uids: ["v-a", "v-b"], recording_seconds: 91 });
    await sweep(r);                                                                                  // idempotent: no duplicate uid, same seconds
    const [g] = await sql<{ video_uids: string[]; recording_seconds: number }[]>`select video_uids, recording_seconds from fixture_stream_sessions where id = ${r.sessionId}`;
    expect(g).toEqual(f);
  });
});

describe("relay sweep — pure parts", () => {
  /** The outcome each FailReason is DECLARED to be for the daily report. `Record<FailReason, …>` makes tsc refuse a reason
   *  the domain adds without a row here; the loop walks the API's own runtime enum of the same reasons. */
  const FAILURE_BUCKET: Record<FailReason, BackstopBucket> = {
    no_inbound_timeout: "warmingTimedOut", machine_boot_timeout: "warmingTimedOut",
    provision_timeout: "provisionTimedOut", admission_timeout: "admissionTimedOut",
    machine_create_failed: "crashed", machine_exit_nonzero: "crashed", machine_oom: "crashed", machine_crash: "crashed",
    // Neither is an outcome the backstop's reconcile produces (the poll and the go-live consume do): a visit that sees one
    // raced another request, and it is counted apart rather than folded into a timeout or a crash.
    target_rejected: "otherFailures", no_credits: "otherFailures",
  };

  it("every fail reason the API declares lands in its declared bucket — the table and the enum are the same set", () => {
    const declared = [...StreamFailReason.options].sort();
    expect(Object.keys(FAILURE_BUCKET).sort()).toEqual(declared);
    let checked = 0;
    for (const reason of declared) {
      const got = backstopOutcome(
        { state: "warming", runnerState: "none", runnerAttempts: 0 },
        { state: "failed", failReason: reason as FailReason, runner: { state: "none", attempt: 0 } },
        null,
      );
      expect(got, reason).toBe(FAILURE_BUCKET[reason as FailReason]);
      checked++;
    }
    expect(checked).toBe(declared.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("the non-failure outcomes: a retry, the three completions from ending, the wall clock, a terminal runner settling, and nothing", () => {
    const live = { state: "live" as const, runnerState: "playing" as const, runnerAttempts: 1 };
    const cases: [string, Parameters<typeof backstopOutcome>, BackstopBucket | null][] = [
      ["retry", [live, { state: "live", failReason: null, runner: { state: "creating", attempt: 2 } }, null], "retried"],
      ["grace-forced", [{ ...live, state: "ending" }, { state: "completed", failReason: null, runner: { state: "destroyed", attempt: 1 } }, "grace_expired"], "graceForced"],
      ["ending timeout", [{ ...live, state: "ending" }, { state: "completed", failReason: null, runner: { state: "destroyed", attempt: 1 } }, "ending_timeout"], "endingTimedOut"],
      ["observed completion", [{ ...live, state: "ending" }, { state: "completed", failReason: null, runner: { state: "destroyed", attempt: 1 } }, null], "completedObserved"],
      ["wall clock", [live, { state: "ending", failReason: null, runner: { state: "stopping", attempt: 1 } }, "wall_clock"], "wallClockEnded"],
      ["terminal runner settles", [{ state: "completed", runnerState: "lost", runnerAttempts: 1 }, { state: "completed", failReason: null, runner: { state: "destroyed", attempt: 1 } }, null], "terminalRunnersSettled"],
      ["terminal runner unchanged", [{ state: "failed", runnerState: "playing", runnerAttempts: 1 }, { state: "failed", failReason: "machine_crash", runner: { state: "playing", attempt: 1 } }, null], null],
      ["a failed row with no reason", [live, { state: "failed", failReason: null, runner: { state: "destroyed", attempt: 1 } }, null], "otherFailures"],
      ["nothing moved", [live, { state: "live", failReason: null, runner: { state: "playing", attempt: 1 } }, null], null],
    ];
    let checked = 0;
    for (const [name, args, want] of cases) {
      expect(backstopOutcome(...args), name).toBe(want);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("the ownership rule for one listed Machine: no row, a terminal row, a creating row by NAME, any other row by ID — and a row that names no Machine owns none", () => {
    const m = { runnerId: "m-1", name: "relay-s-r1" };
    const row = (state: "live" | "completed" | "failed" | "warming", runner_state: "creating" | "booting" | "playing" | "lost" | "none" | "destroyed", runner_name: string | null, machine_id: string | null) =>
      ({ state, runner_state, runner_name, machine_id });
    const cases: [string, Parameters<typeof isOrphan>[1], boolean][] = [
      ["no session row", null, true],
      ["terminal, even naming this very Machine (A22(a))", row("completed", "playing", "relay-s-r1", "m-1"), true],
      ["failed, runner destroyed", row("failed", "destroyed", "relay-s-r1", null), true],
      ["creating, this attempt's name (C6)", row("live", "creating", "relay-s-r1", null), false],
      ["creating, another attempt's name", row("live", "creating", "relay-s-r2", null), true],
      ["booting, its id", row("warming", "booting", "relay-s-r1", "m-1"), false],
      ["playing, another id (a stale Machine, A22(b))", row("live", "playing", "relay-s-r2", "m-2"), true],
      ["lost with no id learned", row("live", "lost", "relay-s-r1", null), true],
      ["passthrough: no runner at all", row("live", "none", null, null), true],
    ];
    let checked = 0;
    for (const [name, r, want] of cases) {
      expect(isOrphan(m, r), name).toBe(want);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(cases.filter(([, , w]) => w).length * cases.filter(([, , w]) => !w).length).toBeGreaterThan(0);   // both verdicts reached
  });

  it("an EMPTY scope is refused by name — `org_id in ()` is not a query, and an empty list must never read as 'everything'", async () => {
    const deps: SessionDeps = { drivers: { ingest: new FakeIngest(), runner: new FakeRunner() }, now: () => new Date(), appUrl: "x" };
    await expect(sweepStreamSessions(deps, { orgIds: [] })).rejects.toBeInstanceOf(SweepScopeEmpty);
  });
});
