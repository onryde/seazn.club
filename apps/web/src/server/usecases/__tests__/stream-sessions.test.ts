// The application layer over the PURE domain (design §6.3, §6.4, §7.6;
// corrections C3, C9; M3; R-A; recommendation B). Real Postgres; skipped
// without DATABASE_URL. The domain's own truth table is Task 2A/2B's tests —
// this file proves the WIRING: that a row goes through `decide`, that the
// consume happens in the same transaction, that the lazy expiry path fires
// with NO sweep call, and that every effect reaches its port. Empty case
// FIRST. Killers for the PR table: r1 (double start), r5 (implication),
// r6/r7/r8/r9 (M3 and the dual-credential qr), m1's wiring twin, C3, C9, and
// the three "delete the lazy applyExpiry call" mutants.
//
// Lane C amendments (authorities/laneC-amendments.md) folded in: A2 (the runner's deadline is runnerDeadlineOf), A3
// (a create failure is classified by createFailedFrom — made-nothing vs unknown), A4/A6 (signatures), A5 (exit facts
// in V410's three columns), A7 (lockOrg before the row lock), A8 (real users rows), A9 (no *_enc column named here),
// A19/A20 (one destination one row; the stored url re-checked at provision).
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): every rig rides seedOrg's `generic` division. Relay is sport-agnostic
// because nothing in stream-sessions.ts reads the sport except the admission SNAPSHOT, which copies `divisions.sport_key`
// verbatim — and the Db test compares that copy to its source row rather than to a sport literal.
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements, overrideRow } from "@/lib/entitlements";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { inputEnvelopesHex, resealTargetDestination, rigUser } from "@/server/relay/__tests__/_session-rig";
import { mintRelayToken } from "@/server/relay/tokens";
import {
  CLOUDFLARE_STORED_MICROS_PER_MINUTE, ENDING_TIMEOUT_SECONDS, EST_COST_CURRENCY, FLY_BILLING_SECONDS_PER_MONTH,
  FLY_PERFORMANCE_CPU_MICROS_PER_MONTH, FLY_RAM_MICROS_PER_GB_MONTH, MAX_ANCHOR_DRIFT_SECONDS, MAX_DURATION_MINUTES,
  PROVISION_TIMEOUT_SECONDS, QR_PREFERRED_DEFAULT, REQUESTED_TIMEOUT_SECONDS, RUNNER_DEFAULT_GUEST, RUNNER_DEFAULT_REGION,
  RUNNER_MAX_ATTEMPTS, RUNNER_OBSERVE_SLACK_SECONDS, RUNNER_STOP_GRACE_SECONDS, SRT_LATENCY_MS, STALE_HEARTBEAT_SECONDS,
  TOKEN_GRACE_MINUTES, WARMING_TIMEOUT_MINUTES,
} from "@/server/relay/config";
import { failReasonFromExit, machineNameFor, type ExitInfo } from "@/server/relay/domain/runner";
import type { RunnerSpec } from "@/server/relay/ports";
import * as telemetry from "@/server/relay/telemetry";
import { seedOrg, startedDivisionWithFixture } from "./_rig";
import { creditBalance, grantCredits, orgMoneyLockKey, revokeCredits } from "../stream-credits";
import { createStreamTarget } from "../stream-targets";
import {
  ACTIVE_STATES, TERMINAL_STATES,
  type SessionDeps, apply, applyExpiry, createSession, currentSession, estimateCostMinor, heartbeat,
  reconcileSession, relayBalance, retryRunner, sessionFactsForJob, stopSession, storageHeadroomMinutes,
} from "../stream-sessions";

const HAS_DB = !!process.env.DATABASE_URL;

/** The exit an OOM-killed Machine reports (Fly's event shape, C1). Its expected fail reason is DERIVED from the
 *  domain's table (`failReasonFromExit`), never typed — and the differential below proves it is not the default. */
const OOM_EXIT: ExitInfo = { exitCode: 137, oomKilled: true, requestedStop: false };

/** A storage pool no plausible number of foreign reservations can exhaust (int4-safe in the snapshot columns). */
const ROOMY_STORAGE_MINUTES = 100_000_000;

/** Drawn sequences per run of the lifecycle model (the last describe). Each draws a fresh org, two fixtures and one destination. */
const MODEL_RUNS = 15;

/** A C3 test's pool: `used` minutes recorded, and exactly `headroomBeforeOthers` minutes of headroom once the database's
 *  FOREIGN reservations are subtracted. Two moves make that exact while other suites write sessions concurrently:
 *   1. the rig's clock jumps FAR past every foreign row (400 days) — a row another suite inserts at the real now is by
 *      then past its wall clock / warming / requested / provision timeout, so the policy excludes it, and it cannot move
 *      the baseline mid-test. The test's own rows are seeded relative to the RIG's clock, not the database's.
 *   2. what the policy still keeps at that instant (a stop-marked runner past its grace: `grace_expired` still records)
 *      is MEASURED through the admission read itself — the foreign baseline is observed, never typed. The assertions then
 *      rest on the DELTA the test's own rows make, which is the claim. */
async function poolFor(r: { deps: SessionDeps; tick: (ms: number) => void }, used: number, headroomBeforeOthers: number) {
  r.tick(400 * 86_400_000);
  const foreign = ROOMY_STORAGE_MINUTES - (await storageHeadroomMinutes(sql, { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 }, r.deps.now()));
  expect(foreign, "the foreign baseline cannot be negative").toBeGreaterThanOrEqual(0);
  return { totalStorageMinutes: used, totalStorageMinutesLimit: used + foreign + headroomBeforeOthers, videoCount: 3 };
}

async function override(orgId: string, key: string, value: boolean) {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
            values (${orgId}, ${key}, ${value}, 'r1 unit')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}

async function rig(opts: { connectAfterMs?: number; overlay?: boolean; relay?: boolean; credits?: number; fixtures?: 1 | 2; targetHost?: string; watchUrl?: string; kind?: "youtube" | "twitch" } = {}) {
  const seeded = await seedOrg();
  // A8: seedOrg's auth.userId is null (_rig.ts:37), and fixture_stream_sessions.created_by is `uuid not null` — the
  // organiser who starts a stream is a REAL users row, so every `created_by` / `actor_user_id` below is a real id and
  // "action rows carry the caller" is not satisfied by null == null.
  const auth = { ...seeded.auth, userId: await rigUser() };
  const d = await startedDivisionWithFixture(auth, opts.fixtures === 2 ? { fixtures: 2 } : {});
  await override(auth.orgId, "streaming.overlay", opts.overlay ?? true);
  await override(auth.orgId, "streaming.relay", opts.relay ?? true);
  // The grant's in-transaction audit row needs a real users row (staff_audit_log.actor_id NOT NULL, V103:16) and every
  // staff write needs a key (Task 7).
  if (opts.credits) await grantCredits({ orgId: auth.orgId, delta: opts.credits, createdBy: await rigUser(), note: "unit", idempotencyKey: randomUUID() });
  const target = await createStreamTarget(auth, auth.orgId, {
    kind: opts.kind ?? "youtube", label: "Club",
    rtmpUrl: `rtmps://${opts.targetHost ?? "a.rtmps.youtube.com"}/live2`, streamKey: "yt-key",
    ...(opts.watchUrl ? { watchUrl: opts.watchUrl } : {}),
  });
  // The clock is LIVE (rows carry the DB's now()) and tickable: the fake
  // ingest connects `connectAfterMs` after creation on this same clock.
  let now = Date.now();
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs: opts.connectAfterMs ?? 3000 });
  // Recording storage is ONE account-wide pool, so admission reserves against EVERY active session in the database —
  // including the ones other suites (stream-credits.test.ts seats `live` rows) and earlier runs left behind, which run
  // concurrently in CI's thread pool. The fake's default 1000-minute pool is exhausted by four of them, and every start
  // below would read 503 storage_exhausted for a reason no test here controls. So the pool is ROOMY by default; the two
  // C3 tests, which are ABOUT the pool, pin their own arithmetic against a measured foreign baseline (`poolFor`).
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const runner = new FakeRunner();
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(now), appUrl: "http://app.test" };
  const row = async (sid: string) => (await sql<{
    state: string; fail_reason: string | null; end_reason: string | null; machine_id: string | null; runner_retries: number; runner_state: string;
    desired_state: string; ending_at: string | null; heartbeat_at: string | null; beat_window_at: string | null; created_at: Date;
    runner_exit_code: number | null; runner_oom_killed: boolean | null; runner_requested_stop: boolean | null;
  }[]>`
    select state, fail_reason, end_reason, machine_id, runner_retries, runner_state, desired_state, ending_at, heartbeat_at, beat_window_at, created_at,
           runner_exit_code, runner_oom_killed, runner_requested_stop
      from fixture_stream_sessions where id = ${sid}`)[0]!;
  return { auth, fixtureId: d.fixtureId, fixtureIds: d.fixtureIds, divisionId: d.divisionId, target, ingest, runner, deps, row, tick: (ms: number) => { now += ms; } };
}

const body = (targetId: string, mode: "passthrough" | "composed" = "passthrough") => ({ mode, targetId });

describe.skipIf(!HAS_DB)("stream sessions — the application layer", () => {
  it("EMPTY: no session → current is null, never a default object", async () => {
    const r = await rig();
    expect(await currentSession(r.auth, r.fixtureId, r.deps)).toBeNull();
  });

  it("create refusals map 1:1 from admit, in §6.3 order: no overlay → 402; relay without overlay → 409 overlay_required (r5); overlay without relay → 402; balance 0 → 402 no_credits; no row is written", async () => {
    const none = await rig({ overlay: false, relay: false });
    await expect(createSession(none.auth, none.fixtureId, body(none.target.id), none.deps)).rejects.toMatchObject({ status: 402, featureKey: "streaming.overlay" });
    const relayOnly = await rig({ overlay: false, relay: true });
    await expect(createSession(relayOnly.auth, relayOnly.fixtureId, body(relayOnly.target.id), relayOnly.deps)).rejects.toMatchObject({ status: 409, code: "overlay_required" });
    const overlayOnly = await rig({ overlay: true, relay: false });
    await expect(createSession(overlayOnly.auth, overlayOnly.fixtureId, body(overlayOnly.target.id), overlayOnly.deps)).rejects.toMatchObject({ status: 402, featureKey: "streaming.relay" });
    const broke = await rig({ credits: 0 });
    await expect(createSession(broke.auth, broke.fixtureId, body(broke.target.id), broke.deps)).rejects.toMatchObject({ status: 402, code: "no_credits" });
    let checked = 0;
    for (const x of [none, relayOnly, overlayOnly, broke]) {
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where org_id = ${x.auth.orgId}`;
      expect(n).toBe(0);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the ACTOR is a guard, not a fallback: a create with no signed-in user (seedOrg's null userId) is refused 403 before anything is written — never a session whose created_by is the org's id", async () => {
    const r = await rig({ credits: 1 });
    const anonymous = { ...r.auth, userId: null };
    await expect(createSession(anonymous, r.fixtureId, body(r.target.id), r.deps)).rejects.toMatchObject({ status: 403 });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where org_id = ${r.auth.orgId}`;
    expect(n).toBe(0);
    expect(r.runner.created).toEqual([]);
    // The positive pair on the same org: the signed-in organiser starts, and the row names HER.
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const [s] = await sql<{ created_by: string }[]>`select created_by from fixture_stream_sessions where id = ${sessionId}`;
    expect(s!.created_by).toBe(r.auth.userId);
  });

  it("C3 differential: raw headroom sufficient, but other sessions' RESERVATIONS push it under → 503 and no row; the same sessions completed → 201", async () => {
    const r = await rig({ credits: 1 });
    // Raw headroom (limit − used) is 900 + the measured foreign baseline — always ≥ MAX_DURATION_MINUTES; the three rows below
    // reserve 3 × MAX_DURATION_MINUTES = 900 of it, leaving 0.
    r.ingest.storage = await poolFor(r, 100, 3 * MAX_DURATION_MINUTES);
    const rigNow = r.deps.now();
    const others: string[] = [];
    for (let i = 0; i < 3; i++) {
      const o = await rig({ credits: 1 });
      // Db/Dc: sport_key, competition_id, division_id and entitlement_via_override are NOT NULL with no
      // default, so every raw insert derives them from the fixture's own division (the same sources
      // createSession reads). A `values (...)` form here fails 23502 and the test never reaches its assertions.
      const [s] = await sql<{ id: string }[]>`
        insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, started_at,
                                             sport_key, competition_id, division_id, entitlement_via_override)
        select ${o.fixtureId}, ${o.auth.orgId}, 'passthrough', 'live', ${o.target.id}, ${o.auth.userId}, ${rigNow},
               d.sport_key, d.competition_id, f.division_id, true
          from fixtures f join divisions d on d.id = f.division_id where f.id = ${o.fixtureId}
        returning id`;
      others.push(s!.id);
    }
    expect(others).toHaveLength(3);
    await expect(createSession(r.auth, r.fixtureId, body(r.target.id), r.deps)).rejects.toMatchObject({ status: 503, code: "storage_exhausted" });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where org_id = ${r.auth.orgId}`;
    expect(n).toBe(0);
    await sql`update fixture_stream_sessions set state = 'completed', ended_at = now() where id in ${sql(others)}`;
    const made = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    expect(made.sessionId).toBeDefined();
  });

  it("C3 + B: a reservation held by a session the expiry policy ALREADY expires (warming 11 min, unread by anyone) no longer counts; at 9 min it still does", async () => {
    const r = await rig({ credits: 1 });
    // Two warming rows reserve 2 × MAX_DURATION_MINUTES of a 2 × MAX_DURATION_MINUTES headroom (after the foreign baseline) → 0.
    r.ingest.storage = await poolFor(r, 400, 2 * MAX_DURATION_MINUTES);
    const rigNow = r.deps.now();
    const ago = (minutes: number) => new Date(rigNow.getTime() - minutes * 60_000);
    const stale = await rig({ credits: 1 });
    const fresh = await rig({ credits: 1 });
    const [a] = await sql<{ id: string }[]>`insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, created_at,
                                            sport_key, competition_id, division_id, entitlement_via_override)
      select ${stale.fixtureId}, ${stale.auth.orgId}, 'passthrough', 'warming', ${stale.target.id}, ${stale.auth.userId}, ${ago(WARMING_TIMEOUT_MINUTES - 1)},
             d.sport_key, d.competition_id, f.division_id, true
        from fixtures f join divisions d on d.id = f.division_id where f.id = ${stale.fixtureId}
      returning id`;
    await sql`insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, created_at,
                                                   sport_key, competition_id, division_id, entitlement_via_override)
      select ${fresh.fixtureId}, ${fresh.auth.orgId}, 'passthrough', 'warming', ${fresh.target.id}, ${fresh.auth.userId}, ${ago(1)},
             d.sport_key, d.competition_id, f.division_id, true
        from fixtures f join divisions d on d.id = f.division_id where f.id = ${fresh.fixtureId}`;
    await expect(createSession(r.auth, r.fixtureId, body(r.target.id), r.deps)).rejects.toMatchObject({ code: "storage_exhausted" });
    // Push the stale one past the warming timeout — nobody reads it, no sweep runs — and the reserve is released by the POLICY alone.
    await sql`update fixture_stream_sessions set created_at = ${ago(WARMING_TIMEOUT_MINUTES + 1)} where id = ${a!.id}`;
    const made = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    expect(made.sessionId).toBeDefined();
  });

  it("M3: provisioning writes EXACTLY ONE input row whose slot VALUE is 0; passthrough adds exactly one output, composed adds zero and creates one runner with the deadline env (C9, B)", async () => {
    const p = await rig({ credits: 1 });
    const { sessionId } = await createSession(p.auth, p.fixtureId, body(p.target.id), p.deps);
    const inputs = await sql<{ slot: number; ingest_input_id: string }[]>`
      select slot, ingest_input_id from fixture_stream_inputs where session_id = ${sessionId}`;
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.slot).toBe(0);
    expect(p.ingest.outputsFor(inputs[0]!.ingest_input_id)).toHaveLength(1);
    expect(p.runner.created).toHaveLength(0);
    expect((await currentSession(p.auth, p.fixtureId, p.deps))?.state).toBe("warming");

    const c = await rig({ credits: 1 });
    const made = await createSession(c.auth, c.fixtureId, body(c.target.id, "composed"), c.deps);
    const row = await c.row(made.sessionId);
    expect(row.state).toBe("warming");
    expect(row.machine_id).toMatch(/^fake-machine-/);
    expect(c.runner.created).toHaveLength(1);
    expect(c.runner.created[0]!.guest).toEqual(RUNNER_DEFAULT_GUEST);   // C16: the constant, never a copy of its value
    expect(c.runner.created[0]!.deadlineAt.getTime() - c.deps.now().getTime()).toBeGreaterThan((MAX_DURATION_MINUTES - 1) * 60_000);
    const [inp] = await sql<{ ingest_input_id: string }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${made.sessionId}`;
    expect(c.ingest.outputsFor(inp!.ingest_input_id)).toHaveLength(0);
  });

  // A2 (lane-b carry 1). M3 above cannot tell `deadlineOf` from `runnerDeadlineOf` — both are ~MAX_DURATION away. The
  // Machine's hard stop is the SESSION's wall clock PLUS MAX_ANCHOR_DRIFT_SECONDS (expiry.ts, whole-branch review I1),
  // so the expectation is built from the row's own created_at and the two config declarations — never by calling the
  // function the wiring is supposed to call.
  it("A2: the Machine's deadline env is the session's wall clock PLUS the anchor drift — exactly, from created_at and the config declarations (mutant: pass deadlineOf(s) → red by MAX_ANCHOR_DRIFT_SECONDS)", async () => {
    expect(MAX_ANCHOR_DRIFT_SECONDS, "a zero drift would make deadlineOf and runnerDeadlineOf the same instant").toBeGreaterThan(0);
    const c = await rig({ credits: 1 });
    const { sessionId } = await createSession(c.auth, c.fixtureId, body(c.target.id, "composed"), c.deps);
    const row = await c.row(sessionId);
    const wallClock = new Date(row.created_at).getTime() + MAX_DURATION_MINUTES * 60_000;   // startedAt is null at create
    expect(c.runner.created).toHaveLength(1);
    expect(c.runner.created[0]!.deadlineAt.getTime()).toBe(wallClock + MAX_ANCHOR_DRIFT_SECONDS * 1000);
    expect(c.runner.created[0]!.deadlineAt.getTime()).not.toBe(wallClock);
  });

  it("current while warming: qr carries BOTH credential sets, preferred, slot, sid, exp (R-A; r7/r8); a non-zero slot row projects ITS slot; a missing row projects null", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const cur = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(cur.qr).not.toBeNull();
    const qr = cur.qr!;
    expect(qr.v).toBe(1);
    expect(qr.sid).toBe(sessionId);
    expect(qr.slot).toBe(0);
    expect(qr.preferred).toBe(QR_PREFERRED_DEFAULT);
    expect(qr.cred.srt.latencyMs).toBe(SRT_LATENCY_MS);
    const row = await r.row(sessionId);
    // A6: relayTokenExpiry(session) = the wall clock + TOKEN_GRACE_MINUTES — from the row's created_at and the declarations.
    const expectedExp = Math.floor((new Date(row.created_at).getTime() + (MAX_DURATION_MINUTES + TOKEN_GRACE_MINUTES) * 60_000) / 1000);
    expect(qr.exp).toBe(expectedExp);
    const [inp] = await sql<{ ingest_srt_url: string; ingest_rtmps_url: string }[]>`
      select ingest_srt_url, ingest_rtmps_url from fixture_stream_inputs where session_id = ${sessionId}`;
    expect(qr.cred.srt.url).toBe(inp!.ingest_srt_url);
    expect(qr.cred.rtmps.url).toBe(inp!.ingest_rtmps_url);
    expect(qr.cred.srt.passphrase).toMatch(/^[0-9a-f]{24}$/);
    expect(qr.cred.rtmps.streamKey).toMatch(/^[0-9a-f]{24}$/);
    // A9: the at-rest read goes through the rig (this file may not name a *_enc column).
    const env = await inputEnvelopesHex(sessionId);
    expect(env.rtmps).not.toContain(Buffer.from(qr.cred.rtmps.streamKey).toString("hex"));
    expect(env.srt).not.toContain(Buffer.from(qr.cred.srt.passphrase).toString("hex"));
    await sql`update fixture_stream_inputs set slot = 3 where session_id = ${sessionId}`;
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.qr!.slot).toBe(3);
    await sql`delete from fixture_stream_inputs where session_id = ${sessionId}`;
    const gone = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(gone.qr).toBeNull();
    expect(gone.state).toBe("warming");
  });

  it("double start → 409 active_session carrying the existing id (r1: admit, and the partial index as the race backstop)", async () => {
    const r = await rig({ credits: 2 });
    const first = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    await expect(createSession(r.auth, r.fixtureId, body(r.target.id), r.deps)).rejects.toMatchObject({ status: 409, code: "active_session", extra: { sessionId: first.sessionId } });
    // The backstop: bypass admit by racing the index directly — a second active row is refused by Postgres.
    // The NOT NULL snapshot columns are supplied so the refusal under test is the PARTIAL UNIQUE INDEX
    // (23505) and not a null violation (23502). A short insert here still "rejects" and the test still
    // passes — for the wrong reason — which is why the SQLSTATE AND the index name are asserted, never just `.rejects`.
    await expect(sql`insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by,
                                                          sport_key, competition_id, division_id, entitlement_via_override)
      select ${r.fixtureId}, ${r.auth.orgId}, 'passthrough', 'requested', ${r.target.id}, ${r.auth.userId},
             d.sport_key, d.competition_id, f.division_id, true
        from fixtures f join divisions d on d.id = f.division_id where f.id = ${r.fixtureId}`)
      .rejects.toMatchObject({ code: "23505", constraint_name: "fixture_stream_sessions_one_active" });
  });

  // Note 4 (the brief's hazard, raised at Step 4): the FIXTURE index's 23505 used to be mapped INSIDE `sql.begin`, where
  // postgres.js rethrows the query error at the transaction boundary (Task 7's staffRow measured it). Both indexes are
  // now mapped on the boundary; this is the race that reaches it. Flaky-shaped by construction — WHICH guard refuses the
  // loser is not determined, and both answers must be the same 409.
  it("Note 4: two creates on ONE fixture at once — exactly one wins; the loser answers 409 active_session naming the winner, never a raw 23505 (a 500)", async () => {
    let rounds = 0;
    for (let i = 0; i < 3; i++) {
      const r = await rig({ credits: 2 });
      const settled = await Promise.allSettled([
        createSession(r.auth, r.fixtureId, body(r.target.id), r.deps),
        createSession(r.auth, r.fixtureId, body(r.target.id), r.deps),
      ]);
      const won = settled.filter((s) => s.status === "fulfilled") as PromiseFulfilledResult<{ sessionId: string }>[];
      const lost = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]!.reason).toMatchObject({ status: 409, code: "active_session", extra: { sessionId: won[0]!.value.sessionId } });
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${r.fixtureId}`;
      expect(n).toBe(1);
      rounds++;
    }
    expect(rounds).toBe(3);
  });

  it("passthrough goes live when the ingest reports connected, consuming exactly ONE credit in the same transaction (m1 wiring); with the balance gone by then → failed(no_credits) — and the positive pair", async () => {
    const r = await rig({ credits: 1 });
    await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state).toBe("warming");
    r.tick(3000);
    const live = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(live.state).toBe("live");
    expect(live.startedAt).not.toBeNull();
    expect(live.balance).toBe(0);
    expect(live.ingest).toEqual({ state: "connected", protocol: "srt" });
    expect(await creditBalance(sql, r.auth.orgId)).toBe(0);

    const broke = await rig({ credits: 1 });
    await createSession(broke.auth, broke.fixtureId, body(broke.target.id), broke.deps);
    await sql`insert into org_stream_credits (org_id, delta, reason, balance_after) values (${broke.auth.orgId}, -1, 'consume', 0)`;
    broke.tick(3000);
    const failed = (await currentSession(broke.auth, broke.fixtureId, broke.deps))!;
    expect(failed.state).toBe("failed");
    expect(failed.failReason).toBe("no_credits");
  });

  // The plan seeded ONE credit here — a false premise: Task 2A's committed `admit` refuses `balance < 1` at admission, before
  // the 24 h reuse rule (which lives in consumeForSession) is ever consulted, so the restart read 402 no_credits. Two
  // credits keep the claim — the restart consumes NOTHING — and make it a differential: a wiring that consumed twice
  // leaves 0. Whether a club at 0 may restart inside the window is an owner question, recorded in the task report.
  it("a restart on the same fixture within 24 h reaches live without consuming (m5 wiring)", async () => {
    const r = await rig({ credits: 2 });
    await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3000);
    const cur = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(cur.state).toBe("live");
    await stopSession(r.auth, r.fixtureId, cur.id, r.deps);
    const again = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3000);
    const live = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(live.id).toBe(again.sessionId);
    expect(live.state).toBe("live");
    expect(await creditBalance(sql, r.auth.orgId)).toBe(1);                // one consumed across the two sessions, not two
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${r.auth.orgId} and reason = 'consume'`;
    expect(n).toBe(1);
  });

  it("stop → ending → completed for passthrough; replay fill copies the YouTube watch URL only when stream_url is null", async () => {
    const r = await rig({ credits: 1, watchUrl: "https://www.youtube.com/watch?v=relay1" });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3000);
    await currentSession(r.auth, r.fixtureId, r.deps);
    const done = await stopSession(r.auth, r.fixtureId, sessionId, r.deps);
    expect(done.state).toBe("completed");
    expect(done.endedAt).not.toBeNull();
    expect(done.replayUrl).toBe("https://www.youtube.com/watch?v=relay1");
    const [fx] = await sql<{ stream_url: string | null }[]>`select stream_url from fixtures where id = ${r.fixtureId}`;
    expect(fx!.stream_url).toBe("https://www.youtube.com/watch?v=relay1");

    const own = await rig({ credits: 1, watchUrl: "https://www.youtube.com/watch?v=relay2" });
    await sql`update fixtures set stream_url = 'https://www.twitch.tv/club' where id = ${own.fixtureId}`;
    const s2 = await createSession(own.auth, own.fixtureId, body(own.target.id), own.deps);
    own.tick(3000);
    await currentSession(own.auth, own.fixtureId, own.deps);
    expect((await stopSession(own.auth, own.fixtureId, s2.sessionId, own.deps)).replayUrl).toBe("https://www.twitch.tv/club");

    const tw = await rig({ credits: 1, kind: "twitch", targetHost: "live.twitch.tv", watchUrl: "https://www.twitch.tv/club" });
    const s3 = await createSession(tw.auth, tw.fixtureId, body(tw.target.id), tw.deps);
    tw.tick(3000);
    await currentSession(tw.auth, tw.fixtureId, tw.deps);
    expect((await stopSession(tw.auth, tw.fixtureId, s3.sessionId, tw.deps)).replayUrl).toBeNull();
  });

  // The brief's `reject.example` is REFUSED by the A18 allowlist at createStreamTarget (422), so the rig could not even
  // save it. The fake rejects any output whose hostname contains "reject"; an allowlisted Restream host does.
  it("a rejected destination fails the session with target_rejected", async () => {
    const r = await rig({ credits: 1, targetHost: "reject.restream.io" });
    await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const cur = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(cur.state).toBe("failed");
    expect(cur.failReason).toBe("target_rejected");
  });

  // A20 (Task 9 re-review): the allowlist can SHRINK after a target was saved (LinkedIn was dropped 2026-09-28). The
  // stored url is re-checked at provision through the one validator; a refused one fails the create with the same typed
  // code as the save would have, BEFORE a row, an ingest call, a credit or a Machine.
  it("A20: a saved target whose url the allowlist NO LONGER admits is refused 422 DESTINATION_NOT_ALLOWED at create — no row, no ingest call, no Machine, no credit — and the same org's re-saved allowlisted url starts", async () => {
    const r = await rig({ credits: 1 });
    // LinkedIn's last sourced ingest (Azure Media Services) — once dialable, refused since 2026-09-28.
    await resealTargetDestination(r.target.id, { url: "rtmps://x1.channel.media.azure.net:2935/live/1", streamKey: "yt-key" });
    const ingestSpy = vi.spyOn(r.ingest, "createLiveInput");
    try {
      for (const mode of ["passthrough", "composed"] as const) {
        const err = await createSession(r.auth, r.fixtureId, body(r.target.id, mode), r.deps).catch((e: unknown) => e);
        expect(err, mode).toMatchObject({ status: 422, code: "DESTINATION_NOT_ALLOWED", extra: { rule: "host" } });
        expect((err as Error).message, mode).not.toContain("azure");                       // never the url (it can carry the key)
      }
      expect(ingestSpy).not.toHaveBeenCalled();
    } finally {
      ingestSpy.mockRestore();
    }
    expect(r.runner.created).toEqual([]);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where org_id = ${r.auth.orgId}`;
    expect(n).toBe(0);
    expect(await creditBalance(sql, r.auth.orgId)).toBe(1);
    // The positive pair on the SAME target row: the url put back on the list, the start admitted.
    await resealTargetDestination(r.target.id, { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: "yt-key" });
    const made = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    expect((await r.row(made.sessionId)).state).toBe("warming");
  });

  it("composed: the Machine lifecycle end to end — create persisted BEFORE the create call (invariant 4), booting → playing on the callback (consumes one), stop = SIGINT + grace (R0 :279), observed destroyed → completed(stopped); facts carry the decrypted target and a page token; wrong scope 401; terminal 410", async () => {
    const r = await rig({ credits: 1 });
    // Invariant 4 as it is TITLED — the intent is COMMITTED before the create call goes out. The row is read from the
    // create call itself, on another connection, so an intent still inside an open transaction (or not yet written)
    // reads `none`. The after-the-fact row assertions below cannot tell the two orders apart.
    const seenAtCreate: { runner_state: string; runner_name: string | null }[] = [];
    const witnessing = Object.assign(Object.create(r.runner) as FakeRunner, {
      async create(spec: RunnerSpec) {
        const [at] = await sql<{ runner_state: string; runner_name: string | null }[]>`
          select runner_state, runner_name from fixture_stream_sessions where id = ${spec.sessionId}`;
        seenAtCreate.push(at!);
        return r.runner.create(spec);
      },
    });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), { ...r.deps, drivers: { ...r.deps.drivers, runner: witnessing } });
    expect(seenAtCreate).toEqual([{ runner_state: "creating", runner_name: machineNameFor(sessionId, 1) }]);
    const row0 = await r.row(sessionId);
    expect(row0.machine_id).toMatch(/^fake-machine-/);
    const [rr] = await sql<{ runner_state: string; runner_name: string }[]>`select runner_state, runner_name from fixture_stream_sessions where id = ${sessionId}`;
    expect(rr).toEqual({ runner_state: "booting", runner_name: `relay-${sessionId}-r1` });
    expect(r.runner.created[0]!.attempt).toBe(1);
    const jobToken = r.runner.created[0]!.jobToken;
    const facts = await sessionFactsForJob(sessionId, jobToken, r.deps);
    expect(facts.target).toEqual({ url: "rtmps://a.rtmps.youtube.com/live2", streamKey: "yt-key" });
    expect(facts.mode).toBe("composed");
    expect(facts.pageToken.split(".")).toHaveLength(3);
    const pageToken = await mintRelayToken({ sid: sessionId, scope: "relay-page", expiresAt: new Date(Date.now() + 60_000) });
    await expect(heartbeat(sessionId, pageToken, { state: "playing" }, r.deps)).rejects.toMatchObject({ status: 401 });

    expect(await heartbeat(sessionId, jobToken, { state: "starting", fps: 0 }, r.deps)).toEqual({ desiredState: "live" });
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state).toBe("warming");
    expect(await heartbeat(sessionId, jobToken, { state: "playing", fps: 30, bitrateKbps: 2900 }, r.deps)).toEqual({ desiredState: "live" });
    const live = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(live.state).toBe("live");
    expect(live.health).toEqual({ fps: 30, bitrateKbps: 2900, lastBeatAt: r.deps.now().toISOString() });
    expect(await creditBalance(sql, r.auth.orgId)).toBe(0);

    // The stop sequence: session stop → runner stopping + SIGINT with the grace; the beat now reads ending.
    const ending = await stopSession(r.auth, r.fixtureId, sessionId, r.deps);
    expect(ending.state).toBe("ending");
    expect(r.runner.stops).toEqual([{ runnerId: row0.machine_id!, signal: "SIGINT", timeoutSeconds: RUNNER_STOP_GRACE_SECONDS }]);
    expect(r.runner.destroyed).toEqual([]);                                     // no force while the grace runs
    expect(await heartbeat(sessionId, jobToken, { state: "playing" }, r.deps)).toEqual({ desiredState: "ending" });
    expect(await heartbeat(sessionId, jobToken, { state: "stopped" }, r.deps)).toEqual({ desiredState: "ending" }); // runner exited; not yet destroyed
    expect((await r.row(sessionId)).state).toBe("ending");
    // The fake auto-destroys on the next observation (as both R0 soaks did): the organiser's poll observes destroyed → completed(stopped).
    const done = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(done.state).toBe("completed");
    expect(done.endReason).toBe("stopped");
    await expect(heartbeat(sessionId, jobToken, { state: "stopped" }, r.deps)).rejects.toMatchObject({ status: 410, code: "SESSION_ENDED" });
    await expect(sessionFactsForJob(sessionId, jobToken, r.deps)).rejects.toMatchObject({ status: 410 });
  });

  it("composed: the deadline stops the Machine the same way and ends with end_reason max_duration — not a failure", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    await heartbeat(sessionId, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
    await sql`update fixture_stream_sessions set started_at = now() - interval '301 minutes' where id = ${sessionId}`;
    const ending = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(ending).toMatchObject({ state: "ending", endReason: "max_duration" });
    expect(r.runner.stops[0]).toMatchObject({ signal: "SIGINT" });
    const done = (await currentSession(r.auth, r.fixtureId, r.deps))!; // observe stopped → exited; next observe destroyed
    const done2 = done.state === "completed" ? done : (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(done2).toMatchObject({ state: "completed", endReason: "max_duration", failReason: null });
  });

  it("composed: a Machine that never auto-destroys is FORCED after grace + slack (grace_expired), by the organiser's poll — no sweep", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    await heartbeat(sessionId, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
    const machine = (await r.row(sessionId)).machine_id!;
    await stopSession(r.auth, r.fixtureId, sessionId, r.deps);
    r.runner.setObserved(machine, "stopping");                                   // Fly says stopping… forever
    // C16: one second past grace + observation slack, DERIVED — moving either constant moves this test with it.
    await sql`update fixture_stream_sessions set runner_stop_requested_at = now() - make_interval(secs => ${RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS + 1}) where id = ${sessionId}`;
    // F-A (Task 2C-post): the read that FORCES the destroy also COMPLETES the session — stopping/exited × grace_expired signals
    // `completed`, keeping the stored `stopped` — and the destroy's confirmation then lands on the completed row (C27, no throw).
    // Before F-A this row stayed `ending` until ENDING_TIMEOUT_SECONDS.
    const done = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(r.runner.destroyed).toContain(machine);
    expect(done).toMatchObject({ state: "completed", endReason: "stopped" });
    expect((await r.row(sessionId)).runner_state).toBe("destroyed");
  });

  it("composed: a session left in `creating` (the app died mid-create) is reconciled by name on the next read — no second Machine (invariant 4)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    const machine = (await r.row(sessionId)).machine_id!;
    // Rewind the row to the state a crash between persist(creating) and create_ok would leave: intent persisted, id unknown.
    await sql`update fixture_stream_sessions set runner_state = 'creating', machine_id = null where id = ${sessionId}`;
    const cur = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(cur.state).toBe("warming");
    const row = await r.row(sessionId);
    expect(row.machine_id).toBe(machine);
    expect(r.runner.created).toHaveLength(1);
  });

  it("composed: a Machine that is observed gone WITHOUT our stop is lost → destroyed → the ONE retry (invariant 1: the replacement is created only after destroy_ok); exhausted → failed with the exit's reason", async () => {
    const oom = failReasonFromExit(OOM_EXIT);
    expect(oom, "the exit must carry a reason the default cannot").not.toBe(failReasonFromExit(null));
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    await heartbeat(sessionId, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
    const first = (await r.row(sessionId)).machine_id!;
    r.runner.setObserved(first, "failed", OOM_EXIT);
    const afterRetry = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(afterRetry.state).toBe("live");
    const row = await r.row(sessionId);
    expect(row.runner_retries).toBe(1);
    expect(row.machine_id).not.toBe(first);
    expect(r.runner.destroyed.indexOf(first)).toBeGreaterThanOrEqual(0);
    expect(r.runner.created).toHaveLength(2);
    expect(r.runner.created[1]).toMatchObject({ sessionId, attempt: 2 });
    // invariant 1 in the ORDER of effects: destroy of the first landed before the second create
    expect(r.runner.destroyed.length).toBe(1);
    const second = row.machine_id!;
    r.runner.setObserved(second, "failed", OOM_EXIT);
    const failed = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(failed).toMatchObject({ state: "failed", failReason: oom });
    expect(r.runner.destroyed).toContain(second);
  });

  // A5 (lane-b carry 4). The exit facts live in V410's three runner_exit_* columns and are read back by
  // failReasonFromExit. The plan kept them in last_heartbeat's JSON, which every beat REPLACES — so a beat landing
  // between the exit and the teardown turned an OOM into machine_crash. The destroy is made to FAIL once, which is the
  // window: the exit is persisted with the runner lost, a beat lands, and only the next read confirms the destroy.
  it("A5: an exit survives a heartbeat — the LAST attempt OOMs, its destroy fails once, a beat lands, and the next read still fails the session with the EXIT's reason, read from the exit columns (mutant: keep lastExit in last_heartbeat → machine_crash → red)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    const jobToken = r.runner.created[0]!.jobToken;
    await heartbeat(sessionId, jobToken, { state: "playing" }, r.deps);
    // Attempt 1 dies clean-less and is retried; attempt 2 is the last (RUNNER_MAX_ATTEMPTS, declared).
    r.runner.setObserved((await r.row(sessionId)).machine_id!, "failed", { exitCode: 1, oomKilled: false, requestedStop: false });
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state).toBe("live");
    expect(r.runner.created).toHaveLength(RUNNER_MAX_ATTEMPTS);
    const second = (await r.row(sessionId)).machine_id!;
    r.runner.setObserved(second, "failed", OOM_EXIT);
    const failing = Object.assign(Object.create(r.runner) as FakeRunner, {
      async destroy() { throw Object.assign(new Error("fake destroy failed"), { status: 503 }); },
    });
    await expect(currentSession(r.auth, r.fixtureId, { ...r.deps, drivers: { ...r.deps.drivers, runner: failing } })).rejects.toMatchObject({ status: 503 });
    expect(await r.row(sessionId)).toMatchObject({
      state: "live", runner_state: "lost", runner_exit_code: OOM_EXIT.exitCode, runner_oom_killed: OOM_EXIT.oomKilled, runner_requested_stop: OOM_EXIT.requestedStop,
    });
    // The lost runner's Machine is still up and still beating — recorded, answered, never fed to the table (T10-b).
    expect(await heartbeat(sessionId, jobToken, { state: "playing", fps: 30 }, r.deps)).toEqual({ desiredState: "live" });
    expect(await r.row(sessionId)).toMatchObject({ runner_exit_code: OOM_EXIT.exitCode, runner_oom_killed: OOM_EXIT.oomKilled });
    // `lost × observed(failed)` only stays (the table re-issues a lost runner's teardown on a STALE beat, never on a look),
    // so the teardown is re-issued the way production re-issues it: the beat window runs out. Age BOTH anchors (G1).
    await sql`update fixture_stream_sessions set heartbeat_at = now() - make_interval(secs => ${STALE_HEARTBEAT_SECONDS + 30}),
                  beat_window_at = now() - make_interval(secs => ${STALE_HEARTBEAT_SECONDS + 30}) where id = ${sessionId}`;
    // The organiser's next read: the re-issued destroy goes through, the last attempt is spent, the session fails on the EXIT.
    const failed = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(r.runner.destroyed).toContain(second);
    expect(failed).toMatchObject({ state: "failed", failReason: failReasonFromExit(OOM_EXIT) });
    expect(failed.failReason, "the differential: a lost exit reads as the default").not.toBe(failReasonFromExit(null));
  });

  // A3 (lane-b carry 2, OWNER-CONFIRMED 2026-09-28): the create catch feeds createFailedFrom(e), which reads the PROOF
  // off the error. The plan's one test ("NOT retryably → machine_create_failed, no Machine") is split by that proof.
  it("A3 (a) made NOTHING — refused outright: a create Fly REFUSES (FlyApiError 422) fails the session machine_create_failed, with no Machine, no destroy and no retry", async () => {
    const r = await rig({ credits: 1 });
    r.runner.failNextCreate({ status: 422, retryable: false });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    expect(await r.row(sessionId)).toMatchObject({ state: "failed", fail_reason: "machine_create_failed", machine_id: null, runner_state: "destroyed" });
    expect(r.runner.created).toHaveLength(1);                 // the one refused attempt, never a second
    expect(r.runner.destroyed).toEqual([]);
    expect(await r.runner.list()).toEqual([]);
    expect(await creditBalance(sql, r.auth.orgId)).toBe(1);   // never live, never consumed
  });

  it("A3 (absent) made NOTHING — a retryable failure with the absence CONFIRMED is the domain's licence for attempt 2: no destroy is owed, the ONE retry boots", async () => {
    const r = await rig({ credits: 1 });
    r.runner.failNextCreate({ status: 503, retryable: true });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    const row = await r.row(sessionId);
    expect(row).toMatchObject({ state: "warming", runner_state: "booting", runner_retries: 1 });
    expect(r.runner.created.map((c) => c.attempt)).toEqual([1, 2]);
    expect(r.runner.destroyed).toEqual([]);
    expect((await r.runner.list()).map((m) => m.name)).toEqual([machineNameFor(sessionId, 2)]);
  });

  it("A3 (b) outcome UNKNOWN — a create that failed without a provider's answer (a plain error) is torn down BY NAME first: lost → force_destroy → destroy_ok → the ONE retry; never machine_create_failed while Fly may hold a Machine", async () => {
    const r = await rig({ credits: 1 });
    r.runner.failNextCreate(false);
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    expect(await r.row(sessionId)).toMatchObject({ state: "warming", runner_state: "booting", runner_retries: 1 });
    expect(r.runner.created.map((c) => c.attempt)).toEqual([1, 2]);
    const rt = await sql<{ type: string; from_state: string; to_state: string }[]>`
      select type, from_state, to_state from fixture_stream_events where session_id = ${sessionId} and kind = 'runner_transition' order by seq`;
    expect(rt.map((x) => `${x.from_state}-${x.type}->${x.to_state}`)).toEqual([
      "none-create_started->creating", "creating-create_failed->lost", "lost-destroy_ok->destroyed", "destroyed-create_started->creating", "creating-create_ok->booting",
    ]);
  });

  it("A3 (b) on the LAST attempt: both creates' outcomes unknown → each torn down by name, and the session fails with the reason the DOMAIN declares for an attempt that left no exit", async () => {
    const r = await rig({ credits: 1 });
    const alwaysUnknown = Object.assign(Object.create(r.runner) as FakeRunner, {
      async create(spec: RunnerSpec) { r.runner.failNextCreate(false); return r.runner.create(spec); },
    });
    const deps: SessionDeps = { ...r.deps, drivers: { ...r.deps.drivers, runner: alwaysUnknown } };
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), deps);
    expect(r.runner.created.map((c) => c.attempt)).toEqual(Array.from({ length: RUNNER_MAX_ATTEMPTS }, (_, i) => i + 1));
    expect(await r.row(sessionId)).toMatchObject({ state: "failed", fail_reason: failReasonFromExit(null), runner_state: "destroyed" });
    expect(await r.runner.list()).toEqual([]);
  });

  it("T10-b: a beat reporting `playing` from a runner that is NOT booting/playing (here: lost) is recorded and answered — never fed to the table as callback_playing, which `lost` refuses (mutant: drop the `booting || playing` guard in heartbeat → InvalidRunnerTransition → red)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    const jobToken = r.runner.created[0]!.jobToken;
    await heartbeat(sessionId, jobToken, { state: "playing" }, r.deps);
    // C1 declared the runner lost; its Machine is still up and still beating (a slow network, not a dead encoder).
    await sql`update fixture_stream_sessions set runner_state = 'lost' where id = ${sessionId}`;
    expect(await heartbeat(sessionId, jobToken, { state: "playing", fps: 30 }, r.deps)).toEqual({ desiredState: "live" });
    expect(await r.row(sessionId)).toMatchObject({ state: "live", runner_state: "lost" });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_samples where session_id = ${sessionId} and source = 'heartbeat'`;
    expect(n).toBe(2);                                                   // the beat itself still landed as a sample
  });

  it("M1: a retry_runner effect whose row moved on after the retry DECISION committed is a no-op returning the row as it now stands — a late create_ok took it lost, or the session ended — never a second Machine, never a throw out of the organiser's poll (mutants: drop retryRunner's try/catch → red at (1); catch InvalidRunnerTransition only → red at (2))", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    await heartbeat(sessionId, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
    // The snapshot the retry decision committed: attempt 1 destroyed, the session still live. `expire none` is the
    // identity decision, so this reads the row back as a Session without moving it.
    await sql`update fixture_stream_sessions set runner_state = 'destroyed', machine_id = null where id = ${sessionId}`;
    const decided = (await apply(sessionId, { type: "expire", expiry: { kind: "none" } }, r.deps))!;
    expect(decided.runner).toMatchObject({ state: "destroyed", attempt: 1 });

    // (1) Before the effect ran, a late create_ok took the row destroyed → lost (fix round 4): `lost × create_started` is ✗.
    await sql`update fixture_stream_sessions set runner_state = 'lost', machine_id = 'fake-machine-late' where id = ${sessionId}`;
    const moved = await retryRunner(decided, r.deps);
    expect(moved.runner).toMatchObject({ state: "lost", attempt: 1, machineId: "fake-machine-late" });
    expect(r.runner.created).toHaveLength(1);
    expect(await r.row(sessionId)).toMatchObject({ state: "live", runner_state: "lost" });

    // (2) …or the session ended first: a terminal row refuses create_started with the SESSION's InvalidTransition (C27).
    await sql`update fixture_stream_sessions set state = 'failed', fail_reason = 'machine_crash', ended_at = now(), runner_state = 'destroyed', machine_id = null where id = ${sessionId}`;
    const ended = await retryRunner(decided, r.deps);
    expect(ended.state).toBe("failed");
    expect(r.runner.created).toHaveLength(1);
  });

  it("T5-a: a Machine made for an EARLIER attempt is never taken as the current attempt's — not when its create call returns after the row moved on (destroyed at once, the row untouched), and not when the crash-safe reconcile or the by-name force_destroy lists it (matched by NAME, never by session alone) (mutants: feed create_ok without the name check in create_machine → red at (1); find by sessionId alone in reconcileSession → red at (2); find by sessionId alone in force_destroy → red at (3))", async () => {
    // (1) Attempt 1's create call is slow; while it is out, C1 lost the runner, the destroy confirmed and the retry persisted
    // attempt 2's intent. The call then returns attempt 1's Machine.
    const r = await rig({ credits: 1 });
    let m1 = "";
    const slow = Object.assign(Object.create(r.runner) as FakeRunner, {
      async create(spec: RunnerSpec) {
        const handle = await r.runner.create(spec);
        m1 = handle.runnerId;
        await sql`update fixture_stream_sessions set runner_state = 'creating', runner_attempts = 2, runner_retries = 1,
                      runner_name = ${machineNameFor(spec.sessionId, 2)} where id = ${spec.sessionId}`;
        return handle;
      },
    });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), { ...r.deps, drivers: { ...r.deps.drivers, runner: slow } });
    expect(r.runner.destroyed).toEqual([m1]);                                                       // nobody's Machine: destroyed at once
    expect(await r.row(sessionId)).toMatchObject({ runner_state: "creating", machine_id: null });   // attempt 2's intent untouched

    // (2) The process died mid-create for attempt 2 while attempt 1's Machine is still listed under the SAME session.
    const c = await rig({ credits: 1 });
    const s2 = await createSession(c.auth, c.fixtureId, body(c.target.id, "composed"), c.deps);
    await sql`update fixture_stream_sessions set runner_state = 'creating', runner_attempts = 2, runner_retries = 1,
                  runner_name = ${machineNameFor(s2.sessionId, 2)}, machine_id = null where id = ${s2.sessionId}`;
    await reconcileSession(s2.sessionId, c.deps);
    expect(await c.row(s2.sessionId)).toMatchObject({ runner_state: "creating", machine_id: null });  // …-r1 is not …-r2
    const mine = (await c.runner.create({ ...c.runner.created[0]!, attempt: 2 })).runnerId;          // attempt 2's create DID land before the crash
    await reconcileSession(s2.sessionId, c.deps);
    expect(await c.row(s2.sessionId)).toMatchObject({ runner_state: "booting", machine_id: mine });   // the positive pair: adopted by its own name

    // (3) force_destroy BY NAME (F15) picks the stop-marked attempt's own Machine when an earlier attempt's is listed first.
    const g = await rig({ credits: 1 });
    const s3 = await createSession(g.auth, g.fixtureId, body(g.target.id, "composed"), g.deps);
    const own = (await g.runner.create({ ...g.runner.created[0]!, attempt: 2 })).runnerId;             // listed AFTER attempt 1's
    await sql`update fixture_stream_sessions set state = 'ending', desired_state = 'ending', end_reason = 'stopped', ending_at = now(),
                  runner_state = 'creating', runner_attempts = 2, runner_retries = 1, runner_name = ${machineNameFor(s3.sessionId, 2)}, machine_id = null,
                  runner_stop_requested_at = now() - make_interval(secs => ${RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS + 1}) where id = ${s3.sessionId}`;
    await reconcileSession(s3.sessionId, g.deps);                                                     // grace_expired → force_destroy by name
    expect(g.runner.destroyed).toEqual([own]);
    expect((await g.row(s3.sessionId)).state).toBe("completed");
  });

  it("F-B: a force_destroy whose confirmation lands after ANOTHER request's retry moved the runner on — to the next attempt's creating, or its booting — drops that confirmation: no throw out of the organiser's poll, the moved runner untouched, the provider call still recorded (mutant: feed destroy_ok without the name gate in force_destroy → creating|booting × destroy_ok → InvalidRunnerTransition → red)", async () => {
    let checked = 0;
    for (const moved of ["creating", "booting"] as const) {
      const r = await rig({ credits: 1 });
      const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
      await heartbeat(sessionId, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
      const first = (await r.row(sessionId)).machine_id!;
      // Attempt 2's own Machine for the booting case — listed under its own name, so this read's observation finds it running.
      const second = moved === "booting" ? (await r.runner.create({ ...r.runner.created[0]!, attempt: 2 })).runnerId : null;
      // While THIS read's DELETE for attempt 1 is out, another request observed attempt 1 destroyed and ran the ONE retry.
      const slow = Object.assign(Object.create(r.runner) as FakeRunner, {
        async destroy(id: string) {
          await r.runner.destroy(id);
          await sql`update fixture_stream_sessions set runner_state = ${moved}, runner_attempts = 2, runner_retries = 1,
                        runner_name = ${machineNameFor(sessionId, 2)}, machine_id = ${second} where id = ${sessionId}`;
        },
      });
      // Attempt 1 missed its beat: this read declares it lost and forces its destroy (no window anchor yet — G1).
      await sql`update fixture_stream_sessions set beat_window_at = null,
                    heartbeat_at = now() - make_interval(secs => ${STALE_HEARTBEAT_SECONDS + 30}) where id = ${sessionId}`;
      await currentSession(r.auth, r.fixtureId, { ...r.deps, drivers: { ...r.deps.drivers, runner: slow } });   // resolves: never a 500
      expect(r.runner.destroyed, moved).toEqual([first]);
      expect(await r.row(sessionId), moved).toMatchObject({ state: "live", runner_state: moved, runner_retries: 1, machine_id: second });
      const rows = await sql<{ kind: string; type: string; result: string | null }[]>`
        select kind, type, result from fixture_stream_events
         where session_id = ${sessionId} and ((kind = 'effect' and type = 'force_destroy') or (kind = 'runner_transition' and type = 'destroy_ok'))
         order by seq`;
      expect(rows, moved).toEqual([{ kind: "effect", type: "force_destroy", result: "ok" }]);   // the DELETE is a row; no destroy_ok was fed
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("2C-post m5: a new start on a fixture whose PREVIOUS session completed at grace + slack with its forced destroy UNCONFIRMED (the DELETE failed; the provider still lists the Machine) destroys that Machine first, and while the destroy keeps failing is refused 409 active_session naming the OLD session — never a second publisher on the same destination key (mutants: delete the tearDownPriorMachines call → 201 at (2); swallow its failure → 201 at (2); refuse whenever a Machine is listed, without destroying it → 409 at (3))", async () => {
    const r = await rig({ credits: 2 });
    const { sessionId: old } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    await heartbeat(old, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
    const machine = (await r.row(old)).machine_id!;
    // Our SIGINT went out and Fly never auto-destroyed; the stop's grace + slack has run out (C16: derived). SEEDED, not driven
    // through stopSession: its own read observes the fake's clean stop, and the fake then auto-destroys the Machine.
    await sql`update fixture_stream_sessions set state = 'ending', desired_state = 'ending', end_reason = 'stopped', ending_at = now(), runner_state = 'stopping',
                  runner_stop_requested_at = now() - make_interval(secs => ${RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS + 1}) where id = ${old}`;
    const failing = Object.assign(Object.create(r.runner) as FakeRunner, {
      async destroy() { throw Object.assign(new Error("fake destroy failed"), { status: 503 }); },
    });
    const flaky: SessionDeps = { ...r.deps, drivers: { ...r.deps.drivers, runner: failing } };

    // (1) The organiser's poll forces the destroy and F-A completes the session on that decision; the DELETE then fails.
    await expect(currentSession(r.auth, r.fixtureId, flaky)).rejects.toMatchObject({ status: 503 });
    expect(await r.row(old)).toMatchObject({ state: "completed", end_reason: "stopped", runner_state: "destroyed" });   // the one-active index has released
    expect((await r.runner.list()).map((m) => m.runnerId)).toContain(machine);                                        // …and the Machine is still listed

    // (2) While the destroy keeps failing, the start is refused, naming the session whose broadcast may still be running.
    await expect(createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), flaky))
      .rejects.toMatchObject({ status: 409, code: "active_session", extra: { sessionId: old } });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${r.fixtureId}`;
    expect(n).toBe(1);

    // (3) Once the DELETE succeeds, admission destroys the old Machine FIRST and the new session starts.
    const next = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    expect(next.sessionId).not.toBe(old);
    expect(r.runner.destroyed).toEqual([machine]);
    expect((await r.runner.list()).map((m) => m.sessionId)).not.toContain(old);
    const effects = await sql<{ result: string }[]>`
      select result from fixture_stream_events where session_id = ${old} and kind = 'effect' and type = 'force_destroy' order by seq`;
    expect(effects.map((e) => e.result)).toEqual(["failed", "failed", "ok"]);   // the poll's DELETE, admission's refused try, admission's teardown
  });

  // A7: every writer that takes both locks takes the ORG's money lock first, then the session row — stream-credits.ts's
  // own order (lockOrg "FIRST, before any read, by every writer", :60-66; staffRow :445; the linked refund's FOR KEY SHARE
  // on the session row comes after it). The plan's `apply` held the row FOR UPDATE and then asked consumeForSession for
  // the org lock: the opposite order, which deadlocks against a staff refund on the same session. The witness holds the
  // org lock from another transaction and proves `apply` waits for it WITHOUT holding the row.
  it("A7 lock order: while another transaction holds the org's money lock, an `apply` on that org's session waits for it BEFORE locking the session row — the row stays free for a FOR UPDATE NOWAIT (mutant: lock the row first → 55P03 → red)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    let release!: () => void;
    const mayCommit = new Promise<void>((res) => (release = res));
    let signalHeld!: () => void;
    const held = new Promise<void>((res) => (signalHeld = res));
    const holder = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${orgMoneyLockKey(r.auth.orgId)}))`;
      signalHeld();
      await mayCommit;
    });
    await held;
    r.tick(3000);                                                           // the apply below goes live and CONSUMES
    const pending = apply(sessionId, { type: "ingest_connected" }, r.deps);
    // Give `apply` time to reach its first lock. It is blocked on the org lock (pg_locks says so), not on the row.
    let waiting = 0;
    for (let i = 0; i < 50 && waiting === 0; i++) {
      await new Promise((res) => setTimeout(res, 20));
      [{ n: waiting }] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`;
    }
    expect(waiting, "apply never reached the org lock").toBeGreaterThan(0);
    const probe = await sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`select id from fixture_stream_sessions where id = ${sessionId} for update nowait`;
      return rows.length;
    }).catch((e: unknown) => (e as { code?: string }).code ?? String(e));
    expect(probe, "the session row must not be held while apply waits for the org lock").toBe(1);
    release();
    await holder;
    const s = (await pending)!;
    expect(s.state).toBe("live");
    expect(await creditBalance(sql, r.auth.orgId)).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("lazy expiry — every rule fires on a READ, with NO sweep call (recommendation B)", () => {
  it("the USECASE never imports the sweep (the rules below are proven without it)", () => {
    // C5: scan the usecase ONLY. An earlier draft also asserted this TEST file
    // lacks the string — while containing that very literal, so it was
    // permanently red. The needle is built from parts for the same reason: a
    // source scan that names its own needle verbatim cannot scan itself.
    const usecase = readFileSync(resolve(import.meta.dirname, "../stream-sessions.ts"), "utf8");
    const needle = ["relay", "sweep"].join("-");
    expect(usecase).not.toContain(needle);
    expect(usecase).toContain("applyExpiry("); // the positive twin: the lazy call exists
    // Mutant: add `import { sweepStreamSessions } from "./relay-sweep";` to the
    // usecase → this `it` goes red. Without that mutant the claim is decoration.
  });

  it("warming 11 min, unread → the organiser's next current() fails it with no_inbound_timeout (mutant: delete applyExpiry in currentSession → red)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    await sql`update fixture_stream_sessions set created_at = now() - interval '11 minutes' where id = ${sessionId}`;
    const cur = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(cur.state).toBe("failed");
    expect(cur.failReason).toBe("no_inbound_timeout");
  });

  it("warming 9 min → still warming (the boundary is the domain's; this proves the wiring does not fire early)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    await sql`update fixture_stream_sessions set created_at = now() - interval '9 minutes' where id = ${sessionId}`;
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state).toBe("warming");
  });

  it("live composed, beat 2 min stale → the organiser's poll retries INLINE (lost → force destroy → destroy_ok → new Machine, retries 1); a replacement that never beats → failed(machine_crash), destroyed (mutant: delete reconcileSession in currentSession → red)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    const jobToken = r.runner.created[0]!.jobToken;
    await heartbeat(sessionId, jobToken, { state: "playing" }, r.deps);
    const first = (await r.row(sessionId)).machine_id!;
    await sql`update fixture_stream_sessions set heartbeat_at = now() - interval '2 minutes' where id = ${sessionId}`;
    const afterRetry = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(afterRetry.state).toBe("live");
    const row = await r.row(sessionId);
    expect(row.runner_retries).toBe(1);
    expect(row.machine_id).not.toBe(first);
    expect(r.runner.destroyed).toContain(first);
    expect(r.runner.created).toHaveLength(2);
    expect(r.runner.created[1]).toMatchObject({ sessionId, attempt: 2 });
    expect(row.beat_window_at).not.toBeNull();   // the retry restarted the beat WINDOW (Task 2C I4) — and it was persisted
    // G1 (Task 2C re-review 1): age BOTH anchors. `evaluate` times the beat from the LATER of heartbeat_at and beat_window_at, so
    // backdating heartbeat_at alone reads `none` here — and a version of this test that goes green that way is green only
    // because beat_window_at never round-tripped (the inert-seam shape; "G1: beat_window_at round-trips" is the witness).
    await sql`update fixture_stream_sessions set heartbeat_at = now() - interval '2 minutes', beat_window_at = now() - interval '2 minutes' where id = ${sessionId}`;
    const crashed = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(crashed).toMatchObject({ state: "failed", failReason: failReasonFromExit(null) });
    expect(r.runner.destroyed).toContain(row.machine_id!);
  });

  it("G1: beat_window_at round-trips — a LOST runner's stale beat re-issues force_destroy and the confirmed destroy's retry restarts the beat WINDOW, so a second organiser read inside that STALE_HEARTBEAT_SECONDS window issues NO second destroy; neither read moves health.lastBeatAt (mutants: drop beat_window_at from persist, from COLS, or from toSession → red at the second read; write heartbeat_at from beatWindowAt → red at lastBeatAt)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    await heartbeat(sessionId, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
    const first = (await r.row(sessionId)).machine_id!;
    // A runner C1 already declared lost whose destroy never ran (the process died after that commit): its Machine is still
    // held, the last beat is past the window, and no window anchor was written. No beat arrives from a lost runner, so
    // beat_window_at is the ONLY thing that can bound the re-issue.
    await sql`update fixture_stream_sessions set runner_state = 'lost', beat_window_at = null,
                  heartbeat_at = now() - make_interval(secs => ${STALE_HEARTBEAT_SECONDS + 30}) where id = ${sessionId}`;
    const beatAt = new Date((await r.row(sessionId)).heartbeat_at!).toISOString();

    const read1 = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(r.runner.destroyed).toEqual([first]);                       // re-issued ONCE; the fake confirms it, so the ONE retry follows
    expect(r.runner.created).toHaveLength(2);
    const after1 = await r.row(sessionId);
    expect(after1).toMatchObject({ state: "live", runner_state: "booting", runner_retries: 1 });
    expect(after1.beat_window_at).not.toBeNull();
    expect(read1.health?.lastBeatAt).toBe(beatAt);                     // a stale-beat decision is not a beat

    r.tick(5_000);                                                     // the Phone tab's next poll (STREAM_POLL_MS), well inside the window
    const read2 = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(r.runner.destroyed).toEqual([first]);                       // no second force_destroy…
    expect(read2.state).toBe("live");                                  // …so attempt 2 is not burnt for a beat it was never owed
    expect(read2.health?.lastBeatAt).toBe(beatAt);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_stream_events where session_id = ${sessionId} and kind = 'runner_transition' and type = 'stale_beat'`;
    expect(n).toBe(1);
  });

  // A5 rewrote this test's witness: the exit facts live in V410's runner_exit_* columns, not last_heartbeat's JSON.
  it("T10-c: a replacement lost by a stale beat fails machine_crash — never the PREVIOUS attempt's machine_oom (an exit belongs to the attempt observed making it; mutant: drop the exit-column clear on entering creating → red)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    await heartbeat(sessionId, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
    const first = (await r.row(sessionId)).machine_id!;
    r.runner.setObserved(first, "failed", OOM_EXIT);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state).toBe("live");  // attempt 1 OOM → lost → destroyed → the ONE retry
    expect(await r.row(sessionId)).toMatchObject({ runner_exit_code: null, runner_oom_killed: null, runner_requested_stop: null });   // attempt 2 starts with no exit of its own
    const second = (await r.row(sessionId)).machine_id!;
    // Attempt 2 never beats and is never observed exiting: age BOTH beat anchors (G1) past the window.
    await sql`update fixture_stream_sessions set heartbeat_at = now() - interval '2 minutes', beat_window_at = now() - interval '2 minutes' where id = ${sessionId}`;
    const crashed = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(crashed).toMatchObject({ state: "failed", failReason: failReasonFromExit(null) });
    expect(crashed.failReason).not.toBe(failReasonFromExit(OOM_EXIT));
    expect(r.runner.destroyed).toEqual([first, second]);
  });

  it("live 301 min → the next HEARTBEAT ends it (desiredState ending, SIGINT sent) and the passthrough completes with its replay (mutant: delete applyExpiry in heartbeat → red)", async () => {
    const r = await rig({ credits: 1, watchUrl: "https://www.youtube.com/watch?v=wall" });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    const jobToken = r.runner.created[0]!.jobToken;
    await heartbeat(sessionId, jobToken, { state: "playing" }, r.deps);
    await sql`update fixture_stream_sessions set started_at = now() - interval '301 minutes' where id = ${sessionId}`;
    expect(await heartbeat(sessionId, jobToken, { state: "playing" }, r.deps)).toEqual({ desiredState: "ending" });
    expect(await r.row(sessionId)).toMatchObject({ state: "ending", desired_state: "ending" }); // composed waits for the Machine to exit and auto-destroy
    expect(r.runner.stops[0]).toMatchObject({ signal: "SIGINT", timeoutSeconds: RUNNER_STOP_GRACE_SECONDS });
    const p = await rig({ credits: 1, watchUrl: "https://www.youtube.com/watch?v=wall2" });
    const s2 = await createSession(p.auth, p.fixtureId, body(p.target.id), p.deps);
    p.tick(3000);
    await currentSession(p.auth, p.fixtureId, p.deps);
    await sql`update fixture_stream_sessions set started_at = now() - interval '301 minutes' where id = ${s2.sessionId}`;
    const done = (await currentSession(p.auth, p.fixtureId, p.deps))!;
    expect(done.state).toBe("completed");
    expect(done.replayUrl).toBe("https://www.youtube.com/watch?v=wall2");
  });

  it("the fixture's OWN stale warming session is expired at admission, so the organiser can start again (mutant: delete applyExpiry in createSession → 409 active_session → red)", async () => {
    const r = await rig({ credits: 2 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    await sql`update fixture_stream_sessions set created_at = now() - interval '11 minutes' where id = ${sessionId}`;
    const again = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    expect(again.sessionId).not.toBe(sessionId);
    expect(await r.row(sessionId)).toMatchObject({ state: "failed", fail_reason: "no_inbound_timeout" });
  });

  it("the Machine's own facts read is 410 once the wall clock has passed (mutant: delete applyExpiry in sessionFactsForJob → 200 → red)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    const jobToken = r.runner.created[0]!.jobToken;
    await heartbeat(sessionId, jobToken, { state: "playing" }, r.deps);
    await sql`update fixture_stream_sessions set started_at = now() - interval '301 minutes' where id = ${sessionId}`;
    // ending is not terminal — the facts call still answers while the Machine flushes…
    await expect(sessionFactsForJob(sessionId, jobToken, r.deps)).resolves.toMatchObject({ mode: "composed" });
    expect((await r.row(sessionId)).state).toBe("ending");
    // …and 410 once it has reported stopped and been observed destroyed (the facts read reconciles too).
    await heartbeat(sessionId, jobToken, { state: "stopped" }, r.deps);
    await expect(sessionFactsForJob(sessionId, jobToken, r.deps)).rejects.toMatchObject({ status: 410 });
  });
});

describe.skipIf(!HAS_DB)("data captured (ruling 13) — history beside the state, never instead of it", () => {
  it("ATOMICITY: a failing event insert rolls the state change back — the row is unchanged and no event row exists", async () => {
    const r = await rig({ credits: 1 });   // C4: admit refuses balance 0 with 402 — without a credit this never reaches its assertions
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const before = await r.row(sessionId);
    const spy = vi.spyOn(telemetry, "recordEvent").mockRejectedValueOnce(new Error("telemetry down"));
    await expect(stopSession(r.auth, r.fixtureId, sessionId, r.deps)).rejects.toThrow("telemetry down");
    spy.mockRestore();
    expect(await r.row(sessionId)).toEqual(before);                                   // state, desired_state untouched
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${sessionId} and type = 'stop'`;
    expect(n).toBe(0);
    await stopSession(r.auth, r.fixtureId, sessionId, r.deps);                        // the positive pair: it works once telemetry does
    expect((await r.row(sessionId)).state).toBe("completed");
  });

  it("the golden passthrough path leaves a complete, ordered ledger: seq 1..n with no gap; the five transitions once each in order; action rows carry the caller; effect rows say ok", async () => {
    const r = await rig({ credits: 1 });   // C4
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3001); await currentSession(r.auth, r.fixtureId, r.deps);                  // connected → live
    await stopSession(r.auth, r.fixtureId, sessionId, r.deps);
    const rows = await sql<{ seq: number; kind: string; type: string; from_state: string | null; to_state: string | null; result: string | null; actor_user_id: string | null; source: string }[]>`
      select seq, kind, type, from_state, to_state, result, actor_user_id, source from fixture_stream_events where session_id = ${sessionId} order by seq`;
    expect(rows.map((x) => x.seq)).toEqual(rows.map((_, i) => i + 1));
    expect(rows.filter((x) => x.kind === "transition").map((x) => `${x.from_state}>${x.to_state}`)).toEqual([
      "requested>provisioning", "provisioning>warming", "warming>live", "live>ending", "ending>completed",
    ]);
    expect(rows.filter((x) => x.kind === "action").map((x) => [x.type, x.actor_user_id, x.source])).toEqual([["create", r.auth.userId, "client"], ["stop", r.auth.userId, "client"]]);
    expect(rows.filter((x) => x.kind === "effect").map((x) => [x.type, x.result])).toEqual([["create_live_input", "ok"], ["add_output", "ok"], ["fill_replay", "ok"]]);
    expect(rows.filter((x) => x.kind === "observed").map((x) => [x.type, x.to_state])).toEqual([["ingest_status", "connected"]]);
    expect(rows.some((x) => x.kind === "runner_transition")).toBe(false);
  });

  it("the session FACTS are set once and never moved: provisioned_at, first_ingest_at, live_at, stop_requested_at, ingest_input_uid, ingest_protocol, destination_kind, credit_ledger_id = the consume row, storage_minutes_at_admission, reserved_minutes", async () => {
    const r = await rig({ credits: 1 });   // C4
    r.ingest.storage = { totalStorageMinutes: 120, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 3 };
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3001); await currentSession(r.auth, r.fixtureId, r.deps);
    const liveAt = r.deps.now();
    r.tick(60_000); await currentSession(r.auth, r.fixtureId, r.deps);                // a second poll must not move live_at / first_ingest_at
    await stopSession(r.auth, r.fixtureId, sessionId, r.deps);
    const [f] = await sql<Record<string, unknown>[]>`
      select provisioned_at, first_ingest_at, live_at, stop_requested_at, ingest_input_uid, ingest_protocol, destination_kind, credit_ledger_id,
             storage_minutes_at_admission, reserved_minutes from fixture_stream_sessions where id = ${sessionId}`;
    expect(f!.provisioned_at).toBeTruthy();
    expect(new Date(f!.live_at as string).getTime()).toBe(liveAt.getTime());
    expect(new Date(f!.first_ingest_at as string).getTime()).toBe(liveAt.getTime());
    expect(f!.stop_requested_at).toBeTruthy();
    expect(f!.ingest_input_uid).toMatch(/^fake-in-/);
    expect(f!.ingest_protocol).toBe("srt");                                             // the fake reports srt on connect (fakes.test.ts pins it)
    expect(f!.destination_kind).toBe("youtube");
    expect(f!.storage_minutes_at_admission).toBe(120);
    expect(f!.reserved_minutes).toBe(MAX_DURATION_MINUTES);
    const [ledger] = await sql<{ reason: string; session_id: string }[]>`select reason, session_id from org_stream_credits where id = ${f!.credit_ledger_id as string}`;
    expect(ledger).toEqual({ reason: "consume", session_id: sessionId });
  });

  it("SAMPLES and SNAPSHOTS: each heartbeat and each poll is a sample; an unchanged poll adds a sample but no observed event; admission writes a snapshot with the session, a refusal writes one without", async () => {
    const r = await rig({ credits: 1 });   // C4
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    await currentSession(r.auth, r.fixtureId, r.deps); await currentSession(r.auth, r.fixtureId, r.deps);   // two disconnected polls
    r.tick(3001); await currentSession(r.auth, r.fixtureId, r.deps);                                        // connected
    const token = await mintRelayToken({ sid: sessionId, scope: "relay-job", expiresAt: new Date(Date.now() + 60_000) });
    await heartbeat(sessionId, token, { state: "playing", fps: 30, bitrateKbps: 4500, egressBytes: 1 }, r.deps);
    const samples = await sql<{ source: string; ingest_state: string | null; fps: number | null }[]>`select source, ingest_state, fps from fixture_stream_samples where session_id = ${sessionId} order by id`;
    expect(samples).toEqual([{ source: "poll", ingest_state: "disconnected", fps: null }, { source: "poll", ingest_state: "disconnected", fps: null }, { source: "poll", ingest_state: "connected", fps: null }, { source: "heartbeat", ingest_state: "playing", fps: 30 }]);
    const observed = await sql<{ to_state: string }[]>`select to_state from fixture_stream_events where session_id = ${sessionId} and kind = 'observed' order by seq`;
    expect(observed.map((o) => o.to_state)).toEqual(["disconnected", "connected"]);     // the first poll and the change; the repeat wrote none
    // Scoped to THIS test's rows (the snapshot table is account-wide and other suites write it concurrently): the admitted
    // start by its session, the refused one by a pool size no other rig uses.
    const snaps = await sql<{ source: string; session_id: string | null }[]>`select source, session_id from stream_storage_snapshots where session_id = ${sessionId}`;
    expect(snaps).toEqual([{ source: "admission", session_id: sessionId }]);
    const broke = await rig({ credits: 0 });
    const marker = ROOMY_STORAGE_MINUTES + 1 + Math.floor(Math.random() * 1_000_000);
    broke.ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: marker, videoCount: 0 };
    await expect(createSession(broke.auth, broke.fixtureId, body(broke.target.id), broke.deps)).rejects.toMatchObject({ status: 402 });
    const refused = await sql<{ source: string; session_id: string | null }[]>`select source, session_id from stream_storage_snapshots where limit_minutes = ${marker}`;
    expect(refused).toEqual([{ source: "admission", session_id: null }]);
  });

  it("COMPOSED facts: runner_attempts, guest, region at create; machine_seconds = booting→destroyed on the fake clock; effect rows create_machine / stop_machine ok; every runner_transition row names its trigger", async () => {
    const r = await rig({ credits: 1 });   // C4
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    const token = await mintRelayToken({ sid: sessionId, scope: "relay-job", expiresAt: new Date(Date.now() + 60_000) });
    await heartbeat(sessionId, token, { state: "playing", egressBytes: 0 }, r.deps);      // booting → playing → live
    r.tick(120_000);
    await stopSession(r.auth, r.fixtureId, sessionId, r.deps);                            // SIGINT → observed stopped → destroyed → completed
    await currentSession(r.auth, r.fixtureId, r.deps);
    const [f] = await sql<{ runner_attempts: number; guest_cpus: number; guest_memory_mb: number; guest_cpu_class: string; machine_region: string; machine_seconds: number }[]>`
      select runner_attempts, guest_cpus, guest_memory_mb, guest_cpu_class, machine_region, machine_seconds from fixture_stream_sessions where id = ${sessionId}`;
    expect(f).toEqual({ runner_attempts: 1, guest_cpus: RUNNER_DEFAULT_GUEST.cpus, guest_memory_mb: RUNNER_DEFAULT_GUEST.memoryMb, guest_cpu_class: RUNNER_DEFAULT_GUEST.cpuClass, machine_region: RUNNER_DEFAULT_REGION, machine_seconds: 120 });
    const effects = await sql<{ type: string; result: string }[]>`select type, result from fixture_stream_events where session_id = ${sessionId} and kind = 'effect' order by seq`;
    expect(effects.map((e) => `${e.type}:${e.result}`)).toEqual(["create_live_input:ok", "create_machine:ok", "stop_machine:ok", "fill_replay:ok"]);
    const rt = await sql<{ type: string; from_state: string; to_state: string }[]>`select type, from_state, to_state from fixture_stream_events where session_id = ${sessionId} and kind = 'runner_transition' order by seq`;
    expect(rt.map((x) => `${x.from_state}-${x.type}->${x.to_state}`)).toEqual([
      "none-create_started->creating", "creating-create_ok->booting", "booting-callback_playing->playing", "playing-session_stop->stopping", "stopping-observed->exited", "exited-observed->destroyed",
    ]);
  });

  it("M2: machine_seconds counts each boot ONCE — a runner that RE-ENTERS destroyed through a late create_ok (destroyed → lost → destroyed, fix round 4) adds nothing (mutant: anchor on the last booting row alone → 480, not 120)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    await heartbeat(sessionId, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
    r.tick(120_000);
    await stopSession(r.auth, r.fixtureId, sessionId, r.deps);
    await currentSession(r.auth, r.fixtureId, r.deps);
    const seconds = async () => (await sql<{ machine_seconds: number }[]>`select machine_seconds from fixture_stream_sessions where id = ${sessionId}`)[0]!.machine_seconds;
    expect(await r.row(sessionId)).toMatchObject({ state: "completed", runner_state: "destroyed" });
    expect(await seconds()).toBe(120);
    r.tick(240_000);
    // The SAME attempt's create call reporting back late (C27 accepts create_ok on a terminal session): destroyed × create_ok →
    // lost [force_destroy the returned id] → destroy_ok → destroyed AGAIN, with no boot in between.
    await apply(sessionId, { type: "runner", trigger: { type: "create_ok", machineId: "fake-machine-late" } }, r.deps);
    expect(r.runner.destroyed).toContain("fake-machine-late");
    expect(await r.row(sessionId)).toMatchObject({ state: "completed", runner_state: "destroyed" });
    const rt = await sql<{ type: string; from_state: string; to_state: string }[]>`
      select type, from_state, to_state from fixture_stream_events where session_id = ${sessionId} and kind = 'runner_transition' order by seq`;
    expect(rt.slice(-2).map((x) => `${x.from_state}-${x.type}->${x.to_state}`)).toEqual(["destroyed-create_ok->lost", "lost-destroy_ok->destroyed"]);
    expect(await seconds()).toBe(120);                                   // the old anchor re-billed booting → now: 120 + 360
  });
});

describe.skipIf(!HAS_DB)("the admission snapshot, the cost estimate, and every timed exit", () => {
  it("F22: ending_at is written in the SAME statement as the transition into ending, and survives the reload as endingAt", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    await heartbeat(sessionId, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
    expect((await r.row(sessionId)).ending_at).toBeNull();                 // nothing sets it before ending
    const at = r.deps.now();
    await stopSession(r.auth, r.fixtureId, sessionId, r.deps);
    const row = await r.row(sessionId);
    expect(row.state).toBe("ending");
    expect(row.ending_at).not.toBeNull();
    expect(Math.abs(new Date(row.ending_at!).getTime() - at.getTime())).toBeLessThanOrEqual(2000);   // the transition instant, not a later touch
    // The round trip. Without the toSession mapping this reads null FOREVER and the
    // ending backstop silently falls back to the wall clock — green everywhere else.
    const reloaded = (await applyExpiry(sessionId, r.deps))!;
    expect(reloaded.endingAt).not.toBeNull();
    expect(reloaded.endingAt!.getTime()).toBe(new Date(row.ending_at!).getTime());
  });

  it("P1-F-b: a FAILED session carries fail_reason and NO end_reason, even when it was ending first (the DDL check would refuse the other order)", async () => {
    const r = await rig({ credits: 1, targetHost: "reject.restream.io" });
    await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const cur = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(cur.state).toBe("failed");
    const row = await r.row(cur.id);
    expect(row.fail_reason).toBe("target_rejected");
    expect(row.end_reason).toBeNull();                                     // fail() nulls it; the check constraint agrees
  });

  it("Db: the admission snapshot equals its SOURCES — sport_key, competition_id, division_id, fixture_scheduled_at, venue_id, venue_address, org_timezone", async () => {
    const r = await rig({ credits: 1 });
    const [v] = await sql<{ id: string }[]>`insert into venues (org_id, name, address) values (${r.auth.orgId}, 'Main Arena', '12 Court Road') returning id`;
    const [c] = await sql<{ id: string }[]>`insert into courts (venue_id, org_id, name) values (${v!.id}, ${r.auth.orgId}, 'Court 1') returning id`;
    await sql`update fixtures set court_id = ${c!.id}, scheduled_at = now() + interval '1 day' where id = ${r.fixtureId}`;
    await sql`update organizations set timezone = 'Europe/Madrid' where id = ${r.auth.orgId}`;
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const [snap] = await sql<{ sport_key: string; competition_id: string; division_id: string; fixture_scheduled_at: string | null; venue_id: string | null; venue_address: string | null; org_timezone: string | null }[]>`
      select sport_key, competition_id, division_id, fixture_scheduled_at, venue_id, venue_address, org_timezone
        from fixture_stream_sessions where id = ${sessionId}`;
    const [src] = await sql<{ sport_key: string; competition_id: string; division_id: string; scheduled_at: string | null }[]>`
      select d.sport_key, d.competition_id, f.division_id, f.scheduled_at
        from fixtures f join divisions d on d.id = f.division_id where f.id = ${r.fixtureId}`;
    // Every value is compared to the ROW it was copied from, never to a literal typed here:
    // a rig that changes sport or reschedules the fixture moves both sides together.
    expect(snap!.sport_key).toBe(src!.sport_key);
    expect(snap!.competition_id).toBe(src!.competition_id);
    expect(snap!.division_id).toBe(src!.division_id);
    expect(new Date(snap!.fixture_scheduled_at!).getTime()).toBe(new Date(src!.scheduled_at!).getTime());
    expect(snap!.venue_id).toBe(v!.id);
    expect(snap!.venue_address).toBe('12 Court Road');
    expect(snap!.org_timezone).toBe("Europe/Madrid");
  });

  it("Db: a fixture with NO court leaves venue_id and venue_address null — and still writes the other five (the left join must not drop the row)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const [snap] = await sql<{ sport_key: string | null; competition_id: string | null; venue_id: string | null; venue_address: string | null }[]>`
      select sport_key, competition_id, venue_id, venue_address from fixture_stream_sessions where id = ${sessionId}`;
    expect(snap!.venue_id).toBeNull();
    expect(snap!.venue_address).toBeNull();
    expect(snap!.sport_key).not.toBeNull();       // the positive pair: an inner join here would have lost the whole insert
    expect(snap!.competition_id).not.toBeNull();
  });

  it("Dc: entitlement_via_override is true for a live staff override and false for a plan-granted org", async () => {
    const r = await rig({ credits: 1 });                                   // the rig grants relay BY OVERRIDE
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    expect((await sql<{ v: boolean }[]>`select entitlement_via_override as v from fixture_stream_sessions where id = ${sessionId}`)[0]!.v).toBe(true);
    // The false arm at the level it is producible: the column is `overrideRow(...)?.bool_value === true`,
    // and an org with no live override row maps to false. Under V402 every R1 admission is an override,
    // so this is asserted on the MAPPING rather than through a plan-granted org that does not exist yet.
    await sql`delete from org_entitlement_overrides where org_id = ${r.auth.orgId} and feature_key = 'streaming.relay'`;
    expect((await overrideRow(r.auth.orgId, "streaming.relay"))?.bool_value === true).toBe(false);
  });

  it("Df: the estimate is DERIVED from the rate constants; passthrough (storage only) and composed (storage + compute) differ, and viewers change neither", async () => {
    const p = await rig({ credits: 1 });
    const { sessionId } = await createSession(p.auth, p.fixtureId, body(p.target.id), p.deps);
    p.tick(3000); await currentSession(p.auth, p.fixtureId, p.deps);
    await sql`update fixture_stream_sessions set recording_seconds = 600 where id = ${sessionId}`;   // as the sweep would have summed it
    await stopSession(p.auth, p.fixtureId, sessionId, p.deps);
    const [pf] = await sql<{ est_cost_minor: number | null; est_cost_currency: string | null; machine_seconds: number }[]>`
      select est_cost_minor, est_cost_currency, machine_seconds from fixture_stream_sessions where id = ${sessionId}`;
    // The expectation is computed HERE from the constants — not by calling the function under test,
    // which would be a tautology (a wrong formula would agree with itself).
    const storageOnly = Math.round(((600 / 60) * CLOUDFLARE_STORED_MICROS_PER_MINUTE) / 10_000);
    expect(pf!.machine_seconds).toBe(0);
    expect(pf!.est_cost_minor).toBe(storageOnly);
    expect(pf!.est_cost_currency).toBe(EST_COST_CURRENCY);

    const c = await rig({ credits: 1 });
    const made = await createSession(c.auth, c.fixtureId, body(c.target.id, "composed"), c.deps);
    await heartbeat(made.sessionId, c.runner.created[0]!.jobToken, { state: "playing" }, c.deps);
    c.tick(120_000);
    await sql`update fixture_stream_sessions set recording_seconds = 600 where id = ${made.sessionId}`;
    await stopSession(c.auth, c.fixtureId, made.sessionId, c.deps);
    await currentSession(c.auth, c.fixtureId, c.deps);                     // observe stopped → destroyed → completed
    const [cf] = await sql<{ est_cost_minor: number | null; machine_seconds: number }[]>`
      select est_cost_minor, machine_seconds from fixture_stream_sessions where id = ${made.sessionId}`;
    const secs = cf!.machine_seconds;
    const cpu = (RUNNER_DEFAULT_GUEST.cpus * FLY_PERFORMANCE_CPU_MICROS_PER_MONTH * secs) / FLY_BILLING_SECONDS_PER_MONTH;
    const ram = ((RUNNER_DEFAULT_GUEST.memoryMb / 1024) * FLY_RAM_MICROS_PER_GB_MONTH * secs) / FLY_BILLING_SECONDS_PER_MONTH;
    expect(cf!.est_cost_minor).toBe(Math.round(((600 / 60) * CLOUDFLARE_STORED_MICROS_PER_MINUTE + cpu + ram) / 10_000));
    expect(cf!.est_cost_minor).toBeGreaterThan(storageOnly);               // the differential: the two modes cannot both be right at one value
  });

  it("Df: DELIVERY is never estimated — a session with viewers costs exactly what the same session without them costs (a guessed multiplier would be a fabricated number in a money column)", () => {
    // Pure: R1 has no viewer source at all, so there is no field to vary. The claim under test is the
    // FORMULA's shape — storage + compute and nothing else. If a delivered term is ever added, this
    // `it` is the one that must be deliberately rewritten, which is the point of pinning it.
    const base = { recordingSeconds: 600, machineSeconds: 0, guestCpus: null, guestMemoryMb: null, guestCpuClass: null };
    expect(estimateCostMinor(base)).toBe(Math.round(((600 / 60) * CLOUDFLARE_STORED_MICROS_PER_MINUTE) / 10_000));
    // The plan's second line here was `estimateCostMinor({ ...base, machineSeconds: 0 })` — `base` again, a tautology that
    // cannot fail (repin Q7 item 6). The two witnesses that CAN: the input type admits no viewer field at all (tsc refuses the
    // literal below — delete the directive and tsc reds), and at runtime a viewer-shaped value carried in anyway moves nothing.
    const withViewers = { ...base, viewers: 10_000, deliveredMinutes: 50_000 };
    // @ts-expect-error — the estimate's input declares no viewer or delivery field; a delivered term has nowhere to enter.
    const _typed: Parameters<typeof estimateCostMinor>[0] = { ...base, viewers: 10_000 };
    void _typed;
    expect(estimateCostMinor(withViewers)).toBe(estimateCostMinor(base));
    expect(estimateCostMinor({ ...base, recordingSeconds: 1200 }), "the formula DOES read its declared inputs").not.toBe(estimateCostMinor(base));
  });

  it("Df: a guest class the rates do not cover gets null, never a borrowed rate", () => {
    expect(estimateCostMinor({ recordingSeconds: 60, machineSeconds: 100, guestCpus: 2, guestMemoryMb: 4096, guestCpuClass: "shared" })).toBeNull();
    expect(estimateCostMinor({ recordingSeconds: 60, machineSeconds: 100, guestCpus: null, guestMemoryMb: 4096, guestCpuClass: "dedicated" })).toBeNull();
  });

  it("Dg: output_uid is the uid addOutput RETURNED, and a repeat never moves it", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const [inp] = await sql<{ ingest_input_id: string }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${sessionId}`;
    const [row] = await sql<{ output_uid: string | null }[]>`select output_uid from fixture_stream_sessions where id = ${sessionId}`;
    expect(row!.output_uid).not.toBeNull();
    expect(r.ingest.outputsFor(inp!.ingest_input_id)).toHaveLength(1);
    // the uid the port handed back, not one the usecase invented
    expect(typeof row!.output_uid).toBe("string");
    await currentSession(r.auth, r.fixtureId, r.deps);
    expect((await sql<{ output_uid: string | null }[]>`select output_uid from fixture_stream_sessions where id = ${sessionId}`)[0]!.output_uid).toBe(row!.output_uid);
  });

  it("Dh: a POLL sample carries Cloudflare's status.current.reason verbatim; a HEARTBEAT sample's ingest_reason is null (it has no such source)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    await currentSession(r.auth, r.fixtureId, r.deps);                     // composed does not poll the ingest…
    const p = await rig({ credits: 1 });
    await createSession(p.auth, p.fixtureId, body(p.target.id), p.deps);   // …passthrough does
    await currentSession(p.auth, p.fixtureId, p.deps);
    const [poll] = await sql<{ ingest_reason: string | null }[]>`
      select ingest_reason from fixture_stream_samples where source = 'poll' and session_id in (select id from fixture_stream_sessions where fixture_id = ${p.fixtureId}) order by id desc limit 1`;
    expect(poll!.ingest_reason).not.toBeNull();                            // the fake reports a reason on both known branches
    await heartbeat(sessionId, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
    const [beat] = await sql<{ ingest_reason: string | null }[]>`
      select ingest_reason from fixture_stream_samples where source = 'heartbeat' and session_id = ${sessionId} order by id desc limit 1`;
    expect(beat!.ingest_reason).toBeNull();                                // stated, not forgotten — see the writer's comment
  });

  it("De: a REVEAL counts and a POLL does not — two reveals with polls between them → count 2, and neither first_at moves", async () => {
    // A LIVE session serves no QR, so no reveal can count on it. The plan's rig connects 3 s after creation, which took this
    // session live on its first 5 s poll and the second reveal never landed; here the input stays unconnected for the whole
    // test — the warming window the claim is about.
    const r = await rig({ credits: 1, connectAfterMs: 10 * 60_000 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const facts = () => sql<{ qr_issued_first_at: string; credentials_revealed_first_at: string | null; credentials_reveal_count: number }[]>`
      select qr_issued_first_at, credentials_revealed_first_at, credentials_reveal_count from fixture_stream_sessions where id = ${sessionId}`;
    const first = (await currentSession(r.auth, r.fixtureId, r.deps, { reveal: true }))!;
    expect(first.qr).not.toBeNull();
    const [a] = await facts();
    expect(a!.credentials_reveal_count).toBe(1);
    // Now the organiser's tab just sits there polling. Ten minutes of 5-second polls is
    // ~120 projections; three proves the shape. Before this split every one of them
    // counted as a reveal, and the De test pinned that — which is how the drift became
    // uncatchable. The QR is still SERVED on each (the tab renders it), so
    // `qr_issued_first_at` stays put rather than going null.
    for (let i = 0; i < 3; i++) { r.tick(5000); await currentSession(r.auth, r.fixtureId, r.deps); }
    const [mid] = await facts();
    expect(mid!.credentials_reveal_count, "a poll is not a reveal").toBe(1);
    expect(mid!.qr_issued_first_at).toEqual(a!.qr_issued_first_at);
    r.tick(5000);
    await currentSession(r.auth, r.fixtureId, r.deps, { reveal: true });   // the organiser taps Copy
    const [b] = await facts();
    expect(b!.credentials_reveal_count).toBe(2);
    expect(b!.qr_issued_first_at).toEqual(a!.qr_issued_first_at);
    expect(b!.credentials_revealed_first_at).toEqual(a!.credentials_revealed_first_at);
  });

  it("C1: the balance is readable with NO session — a credited org is not shown the buy card", async () => {
    const r = await rig({ credits: 2 });
    // No session has ever been started for this fixture, so the projection is null and
    // carries no `balance` at all. That is the production shape of a club that has just
    // bought credits, and `view?.balance ?? 0` made it read 0 forever: buy card again,
    // no balance chip, "Go live" unreachable. Task 14's body tests cannot see it — they
    // pass `balance: 2` into the pure component by hand, so the prop test is green in
    // exactly the state that is broken. This usecase IS the witness.
    expect(await currentSession(r.auth, r.fixtureId, r.deps)).toBeNull();
    expect(await relayBalance(r.auth, r.auth.orgId)).toBe(2);
    const other = await rig({ credits: 1 });
    await expect(relayBalance(other.auth, r.auth.orgId)).rejects.toMatchObject({ status: 404 });   // 404 ≡ missing, never 403
  });

  it("F18: a `requested` row nobody admitted is failed with admission_timeout on the next read (the net for a crash between the insert and provisioning)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    // Rewind to the state a crash between the admission INSERT and the move to provisioning leaves.
    await sql`update fixture_stream_sessions set state = 'requested', created_at = now() - make_interval(secs => ${REQUESTED_TIMEOUT_SECONDS + 1}) where id = ${sessionId}`;
    const cur = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(cur.state).toBe("failed");
    expect(cur.failReason).toBe("admission_timeout");
    expect((await r.row(sessionId)).end_reason).toBeNull();
  });

  it("F18: a `provisioning` row whose ingest call never returned is failed with provision_timeout", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    await sql`update fixture_stream_sessions set state = 'provisioning', created_at = now() - make_interval(secs => ${PROVISION_TIMEOUT_SECONDS + 1}) where id = ${sessionId}`;
    const cur = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(cur.state).toBe("failed");
    expect(cur.failReason).toBe("provision_timeout");
  });

  it("F19/F22: an `ending` row past ENDING_TIMEOUT_SECONDS from ending_at COMPLETES — it is not a failure, and the clock runs from ending_at not the wall clock", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    await heartbeat(sessionId, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
    await stopSession(r.auth, r.fixtureId, sessionId, r.deps);
    // Stopped EARLY in a 300-minute booking: the original deadline is hours away, so a wall-clock
    // backstop would strand this row. Age only ending_at.
    await sql`update fixture_stream_sessions set runner_state = 'exited', ending_at = now() - make_interval(secs => ${ENDING_TIMEOUT_SECONDS + 1}) where id = ${sessionId}`;
    const done = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(done.state).toBe("completed");
    expect(done.failReason).toBeNull();
  });

  it("F16: a beat that arrives BEFORE provisioned is 200 and records its sample; the next beat after provisioned goes live, consuming exactly one credit", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    const jobToken = r.runner.created[0]!.jobToken;
    await sql`update fixture_stream_sessions set state = 'provisioning' where id = ${sessionId}`;
    // The Machine's own route RETRIES on non-2xx, so a throw here 500-loops a Machine we are paying for.
    await expect(heartbeat(sessionId, jobToken, { state: "playing", fps: 30 }, r.deps)).resolves.toEqual({ desiredState: "live" });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_samples where session_id = ${sessionId} and source = 'heartbeat'`;
    expect(n).toBe(1);
    await sql`update fixture_stream_sessions set state = 'warming' where id = ${sessionId}`;
    await heartbeat(sessionId, jobToken, { state: "playing", fps: 30 }, r.deps);
    expect((await r.row(sessionId)).state).toBe("live");
    expect(await creditBalance(sql, r.auth.orgId)).toBe(0);                // exactly one, not one per beat
  });

  it("the late create: `provisioned` is SKIPPED when the row already moved — a stop, and the provision timeout, each while the ingest call was in flight", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    // Both arms drive the guard directly: applying `provisioned` to a row that is no longer
    // provisioning THROWS InvalidTransition, which would surface as a 500 on the organiser's create.
    await sql`update fixture_stream_sessions set state = 'completed', ended_at = now(), end_reason = 'stopped' where id = ${sessionId}`;
    await expect(reconcileSession(sessionId, r.deps)).resolves.not.toThrow();
    const r2 = await rig({ credits: 1 });
    const s2 = await createSession(r2.auth, r2.fixtureId, body(r2.target.id), r2.deps);
    await sql`update fixture_stream_sessions set state = 'failed', fail_reason = 'provision_timeout' where id = ${s2.sessionId}`;
    await expect(reconcileSession(s2.sessionId, r2.deps)).resolves.not.toThrow();
  });

  it("C27: a TERMINAL composed session's Machine is still cleaned up — observed by the next read, and force_destroy resolves it BY NAME when the id was never learned", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    const machine = (await r.row(sessionId)).machine_id!;
    // A failed session with a live runner: the old guard returned early on isTerminal and left this
    // Machine burning until the DAILY orphan pass.
    await sql`update fixture_stream_sessions set state = 'failed', fail_reason = 'machine_crash', runner_state = 'stopping',
                  runner_stop_requested_at = now() - make_interval(secs => ${RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS + 1}) where id = ${sessionId}`;
    r.runner.setObserved(machine, "stopping");
    await reconcileSession(sessionId, r.deps);
    expect(r.runner.destroyed).toContain(machine);
    expect((await r.row(sessionId)).state).toBe("failed");                 // the runner advanced; the SESSION state did not

    // F15: a stop marked while `creating`, id never learned → force_destroy by NAME.
    const c = await rig({ credits: 1 });
    const s2 = await createSession(c.auth, c.fixtureId, body(c.target.id, "composed"), c.deps);
    const m2 = (await c.row(s2.sessionId)).machine_id!;
    // The MARK is what makes this F15 (post-2C-post plan sync): without `runner_stop_requested_at` the row is an UNMARKED
    // creating runner, `evaluate` answers none, and the reconcile ADOPTS the listed Machine (`creating × create_ok` → booting) —
    // nothing is destroyed and this assertion would red for the wrong reason. Aged past grace + slack, the lazy read forces the
    // destroy by NAME (`creating × grace_expired`), which is the claim.
    await sql`update fixture_stream_sessions set state = 'completed', ended_at = now(), end_reason = 'stopped',
                  runner_state = 'creating', machine_id = null,
                  runner_stop_requested_at = now() - make_interval(secs => ${RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS + 1}) where id = ${s2.sessionId}`;
    await reconcileSession(s2.sessionId, c.deps);
    expect(c.runner.destroyed).toContain(m2);                              // a null machineId must NOT mean "nothing to destroy"
    expect((await c.row(s2.sessionId)).runner_state).toBe("destroyed");    // forced, never adopted
  });

  it("stop with no Machine completes AT ONCE, and a stop while `creating` goes to ending and is torn down when the create returns", async () => {
    // Route 1: passthrough — no Machine ever existed.
    const p = await rig({ credits: 1 });
    const s1 = await createSession(p.auth, p.fixtureId, body(p.target.id), p.deps);
    expect((await stopSession(p.auth, p.fixtureId, s1.sessionId, p.deps)).state).toBe("completed");
    expect(p.runner.stops).toEqual([]);

    // Route 2: composed, stopped while the create is still in flight.
    const c = await rig({ credits: 1 });
    const s2 = await createSession(c.auth, c.fixtureId, body(c.target.id, "composed"), c.deps);
    const machine = (await c.row(s2.sessionId)).machine_id!;
    await sql`update fixture_stream_sessions set runner_state = 'creating', machine_id = null where id = ${s2.sessionId}`;
    // "Still in flight" means the provider does not list the Machine yet. The plan rewound the row while the Machine WAS
    // listed, so the stop's own projection read reconciled it by name at once (creating × create_ok on a stop-marked
    // runner → destroy) and the stop answered `completed`, never `ending`. While the call is out, the list is empty.
    const inFlight = Object.assign(Object.create(c.runner) as FakeRunner, { async list() { return []; } });
    const ending = await stopSession(c.auth, c.fixtureId, s2.sessionId, { ...c.deps, drivers: { ...c.deps.drivers, runner: inFlight } });
    expect(ending.state).toBe("ending");
    expect((await c.row(s2.sessionId)).ending_at).not.toBeNull();          // a timed ending row owes its anchor
    await reconcileSession(s2.sessionId, c.deps);                          // the create's completion is observed
    expect(c.runner.destroyed).toContain(machine);
    expect((await c.row(s2.sessionId)).state).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// The DESTINATION guard: one live session per org_stream_targets row (gap 4).
// Every row here needs TWO fixtures on ONE target. With a single fixture
// `fixture_stream_sessions_one_active` refuses first and every assertion below
// would pass for the wrong reason — the thing this describe exists to prove
// would never be reached. `rig({ fixtures: 2 })` puts the two fixtures in
// DIFFERENT stages (_rig.ts's own loud invariant), which is exactly what the
// fixture index cannot separate.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("stream sessions — the destination guard (one live session per target)", () => {
  async function twoFixturesOneTarget() {
    const r = await rig({ credits: 2, fixtures: 2 });
    const [a, b] = r.fixtureIds;
    return { r, a: a!, b: b! };
  }

  it("G-T1 REFUSES: fixture B's start against a target fixture A is already streaming to answers 409 target_in_use BEFORE any provider call — no live input, no Machine, no row — and the message NAMES the court that is holding it", async () => {
    const { r, a, b } = await twoFixturesOneTarget();
    // A gets a court so the refusal can be asserted on a name an organiser can act on rather than a uuid
    // (the venue/court idiom the snapshot test above already uses).
    const [v] = await sql<{ id: string }[]>`insert into venues (org_id, name, address) values (${r.auth.orgId}, 'Main Arena', '12 Court Road') returning id`;
    const [c] = await sql<{ id: string }[]>`insert into courts (venue_id, org_id, name) values (${v!.id}, ${r.auth.orgId}, 'Court 3') returning id`;
    await sql`update fixtures set court_id = ${c!.id} where id = ${a}`;
    const held = await createSession(r.auth, a, body(r.target.id), r.deps);
    expect((await r.row(held.sessionId)).state).not.toBe("failed");   // the holder really is non-terminal

    // Spies go on AFTER the holder was created, so they count only B's refused attempt.
    const ingestSpy = vi.spyOn(r.ingest, "createLiveInput");
    const storageSpy = vi.spyOn(r.ingest, "storageUsage");
    try {
      const err = await createSession(r.auth, b, body(r.target.id), r.deps).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 409, code: "target_in_use" });
      expect((err as Error).message).toContain("Court 3");           // NAMES what is holding it
      expect((err as Error).message).toContain("Club");              // …and the destination's own label
      // The whole point of refusing EARLY: zero provider calls, so there is nothing to clean up. `storageUsage`
      // is the one the index alone could not have saved — it runs in createSession's Promise.all, before the
      // insert the index would refuse. This is the assertion that kills the (G-T pre-check) mutant.
      expect(storageSpy).not.toHaveBeenCalled();
      expect(ingestSpy).not.toHaveBeenCalled();
      expect(r.runner.created).toEqual([]);
    } finally {
      storageSpy.mockRestore();
      ingestSpy.mockRestore();
    }
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${b}`;
    expect(n).toBe(0);                                               // refused BEFORE the insert
  });

  it("G-T2 ADMITS after `completed`: a holder in the index's `completed` terminal state no longer holds the destination, so fixture B starts on the SAME target (failure class 13's other direction — a guard nothing releases bricks a paid destination)", async () => {
    const { r, a, b } = await twoFixturesOneTarget();
    const held = await createSession(r.auth, a, body(r.target.id), r.deps);
    await sql`update fixture_stream_sessions set state = 'completed', ended_at = now(), end_reason = 'stopped' where id = ${held.sessionId}`;
    const made = await createSession(r.auth, b, body(r.target.id), r.deps);
    expect(made.sessionId).toBeDefined();
    expect((await r.row(made.sessionId)).state).not.toBe("failed");
  });

  it("G-T3 ADMITS after `failed`: asserted SEPARATELY from `completed` — the index predicate leaves two terminal states out and one row cannot witness the other; a create that failed must not strand the destination", async () => {
    const { r, a, b } = await twoFixturesOneTarget();
    const held = await createSession(r.auth, a, body(r.target.id), r.deps);
    await sql`update fixture_stream_sessions set state = 'failed', ended_at = now() where id = ${held.sessionId}`;
    const made = await createSession(r.auth, b, body(r.target.id), r.deps);
    expect(made.sessionId).toBeDefined();
  });

  it("G-T4 the RELEASE path is production's, not a raw update's: the holder driven to a terminal state through the REAL `stopSession` frees the destination, proven by a second session then succeeding on it", async () => {
    // G-T2/G-T3 pin the index's predicate; this row pins the SEAM — a fixture on both ends would prove the
    // fixture (AGENTS.md class 1), so the release is driven by its real producer. Passthrough has no Machine,
    // so `stopSession` completes at once and the assertion is deterministic.
    const { r, a, b } = await twoFixturesOneTarget();
    const held = await createSession(r.auth, a, body(r.target.id), r.deps);
    expect((await stopSession(r.auth, a, held.sessionId, r.deps)).state).toBe("completed");
    const made = await createSession(r.auth, b, body(r.target.id), r.deps);
    expect(made.sessionId).toBeDefined();
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_stream_sessions where target_id = ${r.target.id} and state in ${sql([...ACTIVE_STATES])}`;
    expect(n).toBe(1);                                               // one live session per destination, still true
  });

  it("G-T5 the index is what survives a second writer: two non-terminal rows on ONE target_id (two fixtures, so the FIXTURE index cannot be what refuses) → 23505 NAMING fixture_stream_sessions_one_active_target; terminal rows never collide; and the name and predicate are pinned as text, derived from ACTIVE_STATES / TERMINAL_STATES", async () => {
    const { r, a, b } = await twoFixturesOneTarget();
    // Db/Dc: sport_key, competition_id, division_id and entitlement_via_override are NOT NULL with no default,
    // so a raw insert derives them from the fixture's own division — a `values (...)` form fails 23502 and the
    // test never reaches its assertions.
    const insertOn = (fixtureId: string, state: string) => sql`
      insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, started_at,
                                           sport_key, competition_id, division_id, entitlement_via_override)
      select ${fixtureId}, ${r.auth.orgId}, 'passthrough', ${state}, ${r.target.id}, ${r.auth.userId}, now(),
             d.sport_key, d.competition_id, f.division_id, true
        from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}`;
    await insertOn(a, "live");
    await expect(insertOn(b, "requested")).rejects.toMatchObject({
      code: "23505", constraint_name: "fixture_stream_sessions_one_active_target",
    });
    // PARTIAL: both terminal members land beside the live holder.
    await insertOn(b, "completed");
    await insertOn(b, "failed");
    // Neither the NAME nor the PREDICATE is reachable from behaviour — a plain unique index on target_id passes
    // every insert above except the two terminal ones — so both are pinned as text. This is the
    // org_stream_credits_idempotency_key precedent (migration-shape.test.ts:318-324), where exactly that
    // predicate mutant was MEASURED surviving the whole suite. The NAME is also what createSession matches a
    // 23505 on, so a rename silently turns the race backstop into a 500. The state list is DERIVED, so a state
    // added to the domain moves this assertion instead of leaving it asserting yesterday's set.
    const [idx] = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
       where schemaname = current_schema() and tablename = 'fixture_stream_sessions'
         and indexname = 'fixture_stream_sessions_one_active_target'`;
    expect(idx?.indexdef, "fixture_stream_sessions_one_active_target is missing or renamed").toMatch(
      /^CREATE UNIQUE INDEX fixture_stream_sessions_one_active_target ON \w+\.fixture_stream_sessions USING btree \(target_id\) WHERE /,
    );
    // Anti-vacuity (repin Q7 item 4): an EMPTY state list passes both loops, so each reports what it checked.
    let active = 0, terminal = 0;
    for (const s of ACTIVE_STATES) { expect(idx!.indexdef, s).toContain(`'${s}'`); active++; }
    for (const s of TERMINAL_STATES) { expect(idx!.indexdef, s).not.toContain(`'${s}'`); terminal++; }
    expect(active, "the ACTIVE_STATES loop checked nothing").toBeGreaterThan(0);
    expect(terminal, "the TERMINAL_STATES loop checked nothing").toBeGreaterThan(0);
  });

  it("G-T6 the RACE: two creates on one destination at once — exactly ONE wins and the loser answers 409 target_in_use, never a raw 23505 (a 500), whichever guard refused it", async () => {
    // Task 7's m22 shape. WHICH guard refuses the loser is NOT determined: the pre-check may see the winner's
    // row, or both may miss it and the index refuses the insert. The assertion is written so both answers are
    // the same 409 — that equivalence IS the contract, and it is the only row that can reach the transaction
    // boundary's `.catch` at all. Flaky-shaped by construction: re-run it three times before believing it
    // (AGENTS.md class 8).
    const { r, a, b } = await twoFixturesOneTarget();
    const settled = await Promise.allSettled([
      createSession(r.auth, a, body(r.target.id), r.deps),
      createSession(r.auth, b, body(r.target.id), r.deps),
    ]);
    const won = settled.filter((s) => s.status === "fulfilled");
    const lost = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ status: 409, code: "target_in_use" });
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_stream_sessions where target_id = ${r.target.id} and state in ${sql([...ACTIVE_STATES])}`;
    expect(n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The lifecycle as a SEQUENCE (TEST-STRATEGY rule 10; repin Q7 item 3, carry S1). Every `it` above drives one ordering
// it chose; the defects this layer has shipped lived in orderings nobody chose (a stop while a create is out, a beat after
// a loss, a restart after a refusal). fast-check draws the orderings and the invariants are checked after EVERY step.
// The invariants come from declarations, never from this file: the V410 checks and the two partial unique indexes, FS10
// (no negative balance), m1 (a credit is consumed by going live, once per session), m5 (a restart within 24 h on the same
// fixture consumes nothing — every step here happens inside one such window, the rig clock moves seconds), ruling 13 (a
// gapless event ledger), and invariant 1 (never two Machines for one session; a `destroyed` runner holds none). The one
// behavioural property: no ordering of organiser, Machine and clock actions makes any call fail with anything but a
// typed refusal — an InvalidTransition, a raw 23505 or a TypeError out of any of them is a 500 in production.
// Sport-agnostic (rule 6): as the file header — nothing drawn here reads the sport.
// ---------------------------------------------------------------------------
type Act =
  | { kind: "start"; fixture: 0 | 1; mode: "passthrough" | "composed" }
  | { kind: "poll"; fixture: 0 | 1; ms: number }
  | { kind: "beat"; fixture: 0 | 1; state: "starting" | "playing" | "stopped" }
  | { kind: "stop"; fixture: 0 | 1 }
  | { kind: "age"; fixture: 0 | 1; what: "wall_clock" | "warming" | "beat" | "ending" }
  | { kind: "machine"; fixture: 0 | 1; state: "failed" | "destroyed" }
  | { kind: "drain" };

const fixtureArb = fc.constantFrom<0 | 1>(0, 1);
const actArb: fc.Arbitrary<Act> = fc.oneof(
  fc.record({ kind: fc.constant("start" as const), fixture: fixtureArb, mode: fc.constantFrom("passthrough" as const, "composed" as const) }),
  fc.record({ kind: fc.constant("poll" as const), fixture: fixtureArb, ms: fc.constantFrom(0, 1_000, 5_000) }),
  fc.record({ kind: fc.constant("beat" as const), fixture: fixtureArb, state: fc.constantFrom("starting" as const, "playing" as const, "stopped" as const) }),
  fc.record({ kind: fc.constant("stop" as const), fixture: fixtureArb }),
  fc.record({ kind: fc.constant("age" as const), fixture: fixtureArb, what: fc.constantFrom("wall_clock" as const, "warming" as const, "beat" as const, "ending" as const) }),
  fc.record({ kind: fc.constant("machine" as const), fixture: fixtureArb, state: fc.constantFrom("failed" as const, "destroyed" as const) }),
  fc.record({ kind: fc.constant("drain" as const) }),
);

/** A refusal the API is DESIGNED to answer: a typed HttpError below 500. Anything else escaping a call is a defect. */
const REFUSAL_STATUSES = new Set([402, 404, 409, 410]);

describe.skipIf(!HAS_DB)("the lifecycle as a SEQUENCE — drawn orderings, invariants after every step (rule 10)", () => {
  it("no ordering of starts, polls, beats, stops, clock ageing, Machine loss and a drained balance yields a 500, two live sessions on one fixture or destination, a negative balance, a second consume inside the reuse window, a gapped ledger, an inconsistent terminal row, or a Machine a destroyed runner still holds", async () => {
    const tally = { runs: 0, steps: 0, invariantChecks: 0, refusals: 0, consumeRowsChecked: 0, sessionRowsChecked: 0, restartsLive: 0 };
    const seen = new Set<Act["kind"]>();
    const reached = new Set<string>();
    await fc.assert(
      fc.asyncProperty(fc.array(actArb, { minLength: 1, maxLength: 9 }), async (acts) => {
        tally.runs++;
        // Two fixtures, ONE destination, so both the fixture index and the destination index are reachable.
        const r = await rig({ credits: 3, fixtures: 2 });
        const fixtureIds = r.fixtureIds as string[];
        const latest = async (f: 0 | 1) => (await sql<{ id: string; mode: string; machine_id: string | null }[]>`
          select id, mode, machine_id from fixture_stream_sessions where fixture_id = ${fixtureIds[f]!} order by created_at desc limit 1`)[0] ?? null;
        const jobTokenFor = (sid: string) => r.runner.created.filter((c) => c.sessionId === sid).at(-1)?.jobToken ?? null;

        const step = async (a: Act): Promise<void> => {
          const f = a.kind === "drain" ? null : fixtureIds[a.fixture]!;
          switch (a.kind) {
            case "start": await createSession(r.auth, f!, { mode: a.mode, targetId: r.target.id }, r.deps); return;
            case "poll": r.tick(a.ms); await currentSession(r.auth, f!, r.deps); return;
            case "beat": {
              const s = await latest(a.fixture);
              const token = s ? jobTokenFor(s.id) : null;
              if (s && token) await heartbeat(s.id, token, { state: a.state }, r.deps);
              return;
            }
            case "stop": {
              const s = await latest(a.fixture);
              if (s) await stopSession(r.auth, f!, s.id, r.deps);
              return;
            }
            case "age": {
              const s = await latest(a.fixture);
              if (!s) return;
              if (a.what === "wall_clock") await sql`update fixture_stream_sessions set created_at = created_at - make_interval(mins => ${MAX_DURATION_MINUTES + 1}), started_at = started_at - make_interval(mins => ${MAX_DURATION_MINUTES + 1}) where id = ${s.id}`;
              if (a.what === "warming") await sql`update fixture_stream_sessions set created_at = created_at - make_interval(mins => ${WARMING_TIMEOUT_MINUTES + 1}) where id = ${s.id}`;
              if (a.what === "beat") await sql`update fixture_stream_sessions set heartbeat_at = now() - make_interval(secs => ${STALE_HEARTBEAT_SECONDS + 30}), beat_window_at = now() - make_interval(secs => ${STALE_HEARTBEAT_SECONDS + 30}) where id = ${s.id}`;
              if (a.what === "ending") await sql`update fixture_stream_sessions set ending_at = ending_at - make_interval(secs => ${ENDING_TIMEOUT_SECONDS + 1}), runner_stop_requested_at = runner_stop_requested_at - make_interval(secs => ${RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS + 1}) where id = ${s.id}`;
              return;
            }
            case "machine": {
              const s = await latest(a.fixture);
              if (s?.machine_id) r.runner.setObserved(s.machine_id, a.state, a.state === "failed" ? OOM_EXIT : null);
              return;
            }
            case "drain": {
              const balance = await creditBalance(sql, r.auth.orgId);
              if (balance > 0) await revokeCredits({ orgId: r.auth.orgId, delta: balance, createdBy: await rigUser(), note: "model: drained", idempotencyKey: randomUUID() });
              return;
            }
          }
        };

        const check = async (after: string) => {
          const [dup] = await sql<{ n: number }[]>`
            select count(*)::int as n from (
              select fixture_id from fixture_stream_sessions where org_id = ${r.auth.orgId} and state in ${sql([...ACTIVE_STATES])} group by fixture_id having count(*) > 1
              union all
              select target_id from fixture_stream_sessions where org_id = ${r.auth.orgId} and state in ${sql([...ACTIVE_STATES])} group by target_id having count(*) > 1) x`;
          expect(dup!.n, `${after}: two active sessions on one fixture or destination`).toBe(0);
          expect(await creditBalance(sql, r.auth.orgId), `${after}: FS10 — a negative balance`).toBeGreaterThanOrEqual(0);
          const consumes = await sql<{ session_id: string | null; fixture_id: string | null; live_at: Date | null }[]>`
            select c.session_id, s.fixture_id, s.live_at from org_stream_credits c left join fixture_stream_sessions s on s.id = c.session_id
             where c.org_id = ${r.auth.orgId} and c.reason = 'consume'`;
          tally.consumeRowsChecked += consumes.length;
          for (const c of consumes) expect(c.live_at, `${after}: m1 — a consume by a session that never went live`).not.toBeNull();
          const perFixture = new Map<string, number>();
          for (const c of consumes) perFixture.set(String(c.fixture_id), (perFixture.get(String(c.fixture_id)) ?? 0) + 1);
          for (const [fx, n] of perFixture) expect(n, `${after}: m5 — fixture ${fx} consumed twice inside the reuse window`).toBe(1);
          const rows = await sql<{ id: string; state: string; fail_reason: string | null; end_reason: string | null; ended_at: Date | null; runner_state: string; runner_name: string | null; fixture_id: string | null; live_at: Date | null }[]>`
            select id, state, fail_reason, end_reason, ended_at, runner_state, runner_name, fixture_id, live_at from fixture_stream_sessions where org_id = ${r.auth.orgId}`;
          // m5 is only witnessed by a fixture that went live TWICE; count those so the reuse check is not vacuous.
          const liveTimes = new Map<string, number>();
          for (const s of rows) if (s.live_at !== null) liveTimes.set(String(s.fixture_id), (liveTimes.get(String(s.fixture_id)) ?? 0) + 1);
          tally.restartsLive = Math.max(tally.restartsLive, [...liveTimes.values()].filter((n) => n >= 2).length);
          const listed = await r.runner.list();
          for (const s of rows) {
            reached.add(s.state);
            tally.sessionRowsChecked++;
            if (TERMINAL_STATES.includes(s.state as (typeof TERMINAL_STATES)[number])) expect(s.ended_at, `${after}: ${s.state} without ended_at`).not.toBeNull();
            if (s.state === "failed") expect([s.fail_reason !== null, s.end_reason], `${after}: a failed row`).toEqual([true, null]);
            if (s.state === "completed") expect(s.fail_reason, `${after}: a completed row with a fail reason`).toBeNull();
            const mine = listed.filter((m) => m.sessionId === s.id);
            expect(mine.length, `${after}: invariant 1 — two Machines for one session`).toBeLessThanOrEqual(1);
            if (s.runner_state === "destroyed") expect(mine.filter((m) => m.name === s.runner_name), `${after}: a destroyed runner's Machine is still listed`).toEqual([]);
            const seqs = await sql<{ seq: number }[]>`select seq from fixture_stream_events where session_id = ${s.id} order by seq`;
            expect(seqs.map((x) => x.seq), `${after}: ruling 13 — a gapped ledger`).toEqual(seqs.map((_, i) => i + 1));
          }
          tally.invariantChecks++;
        };

        for (const [i, a] of acts.entries()) {
          seen.add(a.kind);
          try {
            await step(a);
          } catch (err) {
            const status = (err as { status?: unknown }).status;
            if (!(err instanceof HttpError) || typeof status !== "number" || !REFUSAL_STATUSES.has(status)) {
              throw new Error(`step ${i} ${JSON.stringify(a)} escaped with a non-refusal: ${String(err)}`);
            }
            tally.refusals++;
          }
          tally.steps++;
          await check(`step ${i} ${JSON.stringify(a)}`);
        }
      }),
      {
        numRuns: MODEL_RUNS,
        // One ordering pinned on top of the drawn ones, so a live session, a consume and a terminal row are reached on
        // every run whatever the seed draws (anti-vacuity: m1, m5 and the terminal checks are otherwise satisfied by an
        // empty table).
        examples: [[[
          { kind: "start", fixture: 0, mode: "passthrough" },
          { kind: "poll", fixture: 0, ms: 5_000 },
          { kind: "stop", fixture: 0 },
          { kind: "age", fixture: 0, what: "ending" },
          { kind: "poll", fixture: 0, ms: 1_000 },
          { kind: "start", fixture: 0, mode: "passthrough" },   // the m5 restart: live again, inside the window
          { kind: "poll", fixture: 0, ms: 5_000 },
          { kind: "start", fixture: 1, mode: "composed" },     // the other fixture: 409 target_in_use, one destination
        ]]],
      },
    );
    console.info(`lifecycle model: ${JSON.stringify(tally)} states reached ${JSON.stringify([...reached].sort())}`);
    // Anti-vacuity: the property ran, every step was checked, and every KIND of action was drawn at least once.
    expect(tally.runs, "fast-check counts the pinned example INSIDE numRuns").toBe(MODEL_RUNS);
    expect(tally.steps).toBeGreaterThanOrEqual(MODEL_RUNS);
    expect(tally.invariantChecks).toBe(tally.steps);
    expect([...seen].sort()).toEqual(["age", "beat", "drain", "machine", "poll", "start", "stop"]);
    expect(tally.consumeRowsChecked, "no consume row was ever checked").toBeGreaterThan(0);
    expect(tally.restartsLive, "no fixture went live twice, so m5 was never witnessed").toBeGreaterThan(0);
    expect(tally.refusals, "no refusal was ever drawn, so the refusal guard was never reached").toBeGreaterThan(0);
    expect(tally.sessionRowsChecked, "no session row was ever checked").toBeGreaterThan(0);
    expect(reached.has("live"), "no drawn or pinned ordering reached live").toBe(true);
    expect([...reached].some((st) => TERMINAL_STATES.includes(st as (typeof TERMINAL_STATES)[number])), "no ordering reached a terminal state").toBe(true);
  }, 180_000);
});
