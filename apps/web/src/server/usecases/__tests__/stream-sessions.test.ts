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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCaptureQr } from "@/lib/capture-qr";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ApiV1Error, apiV1 } from "@/lib/client-v1";
import { RELAY_PLAN_GATES } from "@/lib/stream-plan-gates";
import { OUTPUT_WARNING_AFTER_MS, createErrorCode, d3Warning, destinationWarning, phoneNoSignal } from "@/lib/stream-session-view";
import { v1 } from "@/server/api-v1/http";
import { log } from "@/server/logger";
import { invalidateOrgEntitlements, overrideRow } from "@/lib/entitlements";
import { FAKE_CONNECTING_KEY_PREFIX, FAKE_REJECT_KEY_PREFIX, FakeIngest, FakeRecorder, FakeRunner } from "@/server/relay/fakes";
import { STREAM_PLATFORM_PRESETS, TARGET_UNREADABLE } from "@/lib/stream-destinations";
import { routes } from "@/lib/routes";
import { holdStateOf, type SessionState } from "@/server/relay/domain/session";
import { inputEnvelopesHex, resealTargetDestination, rigTarget, rigUser, spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import { KEY_HINT_CHARS, KEY_HINT_MIN_LENGTH, archiveStreamTarget, lockStreamTarget, readTargetSecret } from "@/server/relay/secret-columns";
import { mintRelayToken } from "@/server/relay/tokens";
import {
  CLOUDFLARE_STORED_MICROS_PER_MINUTE, CREDIT_REUSE_HOURS, ENDING_TIMEOUT_SECONDS, EST_COST_CURRENCY, FLY_BILLING_SECONDS_PER_MONTH, FLY_RELAY_APP_RETIRED_DEFAULT,
  FLY_PERFORMANCE_CPU_MICROS_PER_MONTH, FLY_PERFORMANCE_INCLUDED_GB_PER_CPU, FLY_RAM_MICROS_PER_GB_MONTH, MAX_ANCHOR_DRIFT_SECONDS, MAX_DURATION_MINUTES,
  PROVISION_TIMEOUT_SECONDS, QR_PREFERRED_DEFAULT, REQUESTED_TIMEOUT_SECONDS, RUNNER_DEFAULT_GUEST, RUNNER_DEFAULT_REGION,
  RUNNER_MAX_ATTEMPTS, RUNNER_OBSERVE_SLACK_SECONDS, RUNNER_STOP_GRACE_SECONDS, SRT_LATENCY_MS, STALE_HEARTBEAT_SECONDS,
  TOKEN_GRACE_MINUTES, WARMING_TIMEOUT_MINUTES,
} from "@/server/relay/config";
import { failReasonFromExit, machineNameFor, stepRunner, type ExitInfo } from "@/server/relay/domain/runner";
import { disabledRelayDrivers, relayDrivers, setRelayDriversForTest } from "@/server/relay/drivers";
import type { OutputState, ProviderCallRecorder, RunnerSpec } from "@/server/relay/ports";
import * as telemetry from "@/server/relay/telemetry";
import { seedOrg, startedDivisionWithFixture } from "./_rig";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import {
  creditBalance, grantCredits, orgMoneyLockKey, refundCredits, revokeCredits, streamMonthlyGrantKey, streamMonthlyPeriod,
} from "../stream-credits";
import { createStreamTarget, listStreamTargets, patchStreamTarget, removeStreamTarget } from "../stream-targets";
import { getFixtureState } from "../fixtures";
import { scoreEvent } from "../scoring";
import {
  ACTIVE_STATES, TERMINAL_STATES,
  type SessionDeps, apply, applyExpiry, createSession, currentSession, estimateCostMinor, expireTargetHolders, heartbeat,
  holdStatesOf, openStreamStates, reconcileSession, relayCredits, retryRunner, sessionFactsForJob, stopSession, storageHeadroomMinutes, destroyListedMachine,
} from "../stream-sessions";

// The house Sentry helper, spied (relay-internal-routes.test.ts precedent): every FAILED forced destroy is an alarm, at
// each of its four sites (r2-m3).
const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

// N4 (Task 14b re-review): apply's POOLED rate read, switchable so one test can make it throw. A pass-through otherwise —
// every other test reads the real V426 row.
const rateRead = vi.hoisted(() => ({ fail: null as Error | null, calls: 0 }));
vi.mock("../stream-credits", async (importOriginal) => {
  const real = await importOriginal<typeof import("../stream-credits")>();
  return {
    ...real,
    streamMonthlyRate: async (orgId: string) => {
      rateRead.calls++;
      if (rateRead.fail) throw rateRead.fail;
      return real.streamMonthlyRate(orgId);
    },
  };
});

const HAS_DB = !!process.env.DATABASE_URL;

// A KEK of this file's own (secret-columns.test.ts precedent): CI supplies no RELAY_KEK, and every sealed destination
// and input would otherwise throw "RELAY_KEK is not set". The developer's is put back afterwards, or removed when there
// was none — never assigned `undefined`, which Node stores as the string "undefined". It is never printed.
const savedKek = process.env.RELAY_KEK;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
afterAll(() => {
  if (savedKek === undefined) delete process.env.RELAY_KEK;
  else process.env.RELAY_KEK = savedKek;
});


/** The exit an OOM-killed Machine reports (Fly's event shape, C1). Its expected fail reason is DERIVED from the
 *  domain's table (`failReasonFromExit`), never typed — and the differential below proves it is not the default. */
const OOM_EXIT: ExitInfo = { exitCode: 137, oomKilled: true, requestedStop: false };

/** A storage pool no plausible number of foreign reservations can exhaust (int4-safe in the snapshot columns). */
const ROOMY_STORAGE_MINUTES = 100_000_000;

/** Drawn sequences per run of the lifecycle model (the last describe). Each draws a fresh org, two fixtures and one destination. */
const MODEL_RUNS = 15;

/** How far a C3 test's rig clock jumps: past every row another suite writes at the real now, which is by then past its wall
 *  clock / warming / requested / provision timeout and so excluded by the policy. */
const C3_CLOCK_JUMP_MS = 400 * 86_400_000;
/** One full booking past the rig clock. Every row a C3 test seeds is anchored AT or BEFORE the rig clock and books at most
 *  MAX_DURATION_MINUTES (V410's CHECK caps `max_duration_minutes` there), so the policy has ended every one of them by this
 *  offset — the wall clock is its first rule. */
const OWN_ROWS_EXPIRED_MS = (MAX_DURATION_MINUTES + 1) * 60_000;
/** Admissions tried before a C3 pool that never settles is a red (see `admitAgainstPool`). */
const POOL_ATTEMPTS = 5;

/** The DB-wide reservation baseline at a clock where this test's own rows cannot count (OWN_ROWS_EXPIRED_MS), read through
 *  the admission's own read — observed, never typed. */
async function foreignBaseline(r: { deps: SessionDeps }): Promise<number> {
  const past = new Date(r.deps.now().getTime() + OWN_ROWS_EXPIRED_MS);
  const foreign = ROOMY_STORAGE_MINUTES - (await storageHeadroomMinutes(sql, { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 }, past));
  expect(foreign, "the foreign baseline cannot be negative").toBeGreaterThanOrEqual(0);
  return foreign;
}

/** Rows the C3 tests seat at the rig's far-future clock, retired. A run killed before its `finally` leaves them active, and
 *  at the next run's clock (minutes later) a warming one still COUNTS while the baseline — measured a booking later — does
 *  not, so every attempt would disagree with its own snapshot. Nothing else in the tree anchors a session this far ahead
 *  (the only far-future ticks are this file's C3 tests), so the predicate cannot touch another suite's rows. */
async function retireC3Rows(ids?: string[]): Promise<void> {
  if (ids) {
    if (ids.length) await sql`update fixture_stream_sessions set state = 'completed', ended_at = now() where id in ${sql(ids)} and state in ${sql([...ACTIVE_STATES])}`;
    return;
  }
  await sql`update fixture_stream_sessions set state = 'completed', ended_at = now()
             where state in ${sql([...ACTIVE_STATES])} and coalesce(started_at, created_at) > now() + interval '30 days'`;
}

/** A C3 admission, made HERMETIC (lane-close sweep; Task 11 report "C3 + B", review G8). The pool is ONE account-wide figure
 *  by the PRODUCTION rule — `storageHeadroomMinutes` reserves against every active session in the database, whichever
 *  org, because recording storage is one Cloudflare account — so it is NOT scoped to this test's org. A row another suite
 *  wrote between the old one-off measurement and the admission's read flipped these tests either way (G8: 1 in 4 scoped
 *  runs). Three moves make every ASSERTED admission exact:
 *   1. the rig clock is FROZEN far past every other file's rows (C3_CLOCK_JUMP_MS), so only a concurrent WRITE can move
 *      the reservation set — never the passage of time;
 *   2. the foreign baseline is measured INSIDE the admission call — the fake's `storageUsage`, a few statements before the
 *      admission's own read — at a clock where this test's rows cannot count (`foreignBaseline`), so whether THEY count
 *      is never assumed by the measurement;
 *   3. the admission RECORDS what it read: its storage snapshot is written in the transaction that decides. An attempt
 *      counts only when that snapshot reserved exactly baseline + `ownReserved` — the minutes the test's claim says its
 *      own rows hold. Otherwise a concurrent write moved the pool inside the window: the attempt proves nothing either
 *      way, any session it made is retired, and the admission is measured again, at most POOL_ATTEMPTS times.
 *  A pool that never settles is a RED with every attempt's numbers, never a pass — and a false claim (the policy stops
 *  counting a row it should) can never settle, so it reds the same way; `after` (the baseline re-read once the attempt
 *  returned) tells the two apart in the message: a baseline stable across every attempt is not drift. */
async function admitAgainstPool(
  r: Awaited<ReturnType<typeof rig>>, pool: { used: number; headroomBeforeOwn: number; ownReserved: number },
): Promise<{ made: { sessionId: string } | null; refusal: unknown; snapshot: { reserved: number; headroom: number }; attempts: number; retired: string[] }> {
  const at = r.deps.now();
  const tried: { foreign: number; reserved: number; after: number }[] = [];
  const retired: string[] = [];
  const storageUsage = r.ingest.storageUsage;
  try {
    for (let i = 0; i < POOL_ATTEMPTS; i++) {
      let limit = -1;
      let foreign = -1;
      r.ingest.storageUsage = async () => {
        foreign = await foreignBaseline(r);
        limit = pool.used + foreign + pool.headroomBeforeOwn;
        return { totalStorageMinutes: pool.used, totalStorageMinutesLimit: limit, videoCount: 3 };
      };
      const [{ mark }] = await sql<{ mark: string }[]>`select coalesce(max(id), 0)::text as mark from stream_storage_snapshots`;
      const outcome = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps).then(
        (made) => ({ made, refusal: null as unknown }), (refusal: unknown) => ({ made: null, refusal }));
      const snaps = await sql<{ reserved: number; headroom: number }[]>`
        select reserved_minutes as reserved, headroom_minutes as headroom from stream_storage_snapshots
         where id > ${mark}::bigint and source = 'admission' and taken_at = ${at} and used_minutes = ${pool.used} and limit_minutes = ${limit}`;
      // No snapshot: the call ended before the admission's read (a refusal that is not about the pool) — not ours to judge.
      if (snaps.length === 0) throw outcome.refusal ?? new Error("an admission that wrote no storage snapshot");
      expect(snaps, "one admission, one snapshot").toHaveLength(1);
      const snapshot = snaps[0]!;
      tried.push({ foreign, reserved: snapshot.reserved, after: await foreignBaseline(r) });
      if (snapshot.reserved === foreign + pool.ownReserved) return { ...outcome, snapshot, attempts: tried.length, retired };
      if (outcome.made) {
        retired.push(outcome.made.sessionId);
        await retireC3Rows([outcome.made.sessionId]);
      }
    }
  } finally {
    r.ingest.storageUsage = storageUsage;
  }
  throw new Error(`C3: no admission in ${POOL_ATTEMPTS} reserved baseline + ${pool.ownReserved} own minutes — ${JSON.stringify(tried)}`);
}

async function override(orgId: string, key: string, value: boolean) {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
            values (${orgId}, ${key}, ${value}, 'r1 unit')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}

/** `monthly: true` leaves this period's free match credits for createSession to grant (V426); by default the rig grants
 *  and spends them (`spendMonthlyStreamGrant`), so `credits` is the whole balance, as every pre-V426 test assumes. */
async function rig(opts: { connectAfterMs?: number; overlay?: boolean; relay?: boolean; credits?: number; monthly?: boolean; fixtures?: 1 | 2; streamKey?: string; watchUrl?: string; kind?: "youtube" | "twitch"; recorder?: ProviderCallRecorder } = {}) {
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
  if (!opts.monthly) await spendMonthlyStreamGrant(auth.orgId);
  const target = await createStreamTarget(auth, auth.orgId, {
    // D6: the url is the platform's preset (the server fills it); a rig steers the fake platform through the KEY
    // (FAKE_REJECT_KEY_PREFIX makes it refuse the output).
    kind: opts.kind ?? "youtube", label: "Club", streamKey: opts.streamKey ?? "yt-key",
    ...(opts.watchUrl ? { watchUrl: opts.watchUrl } : {}),
  });
  // The clock is LIVE (rows carry the DB's now()) and tickable: the fake
  // ingest connects `connectAfterMs` after creation on this same clock.
  let now = Date.now();
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs: opts.connectAfterMs ?? 3000, ...(opts.recorder ? { recorder: opts.recorder } : {}) });
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
    // The feature key the Phone tab's view model reads (C-c): the RELAY's, so "no credits" is never mistaken for a plan.
    await expect(createSession(broke.auth, broke.fixtureId, body(broke.target.id), broke.deps)).rejects.toMatchObject({ status: 402, code: "no_credits", extra: { featureKey: "streaming.relay" } });
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

  // The two C3 tests pin the pool through `admitAgainstPool` (hermetic against other suites' rows — see its comment). Each
  // leg names the minutes its CLAIM says the test's own rows reserve (the rows' own `max_duration_minutes`, V410's default,
  // read back — never typed), and asserts the admission's decision over a pool whose every term is known.
  const reservedBy = async (ids: string[]) =>
    (await sql<{ m: number }[]>`select coalesce(sum(max_duration_minutes), 0)::int as m from fixture_stream_sessions where id in ${sql(ids)}`)[0]!.m;

  it("C3 differential: raw headroom sufficient, but other sessions' RESERVATIONS push it under → 503 and no row; the same sessions completed → 201", async () => {
    await retireC3Rows();
    const r = await rig({ credits: 1 });
    r.tick(C3_CLOCK_JUMP_MS);
    const rigNow = r.deps.now();
    const others: string[] = [];
    try {
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
      const ownReserved = await reservedBy(others);
      expect(ownReserved, "three live rows reserve three bookings").toBe(3 * MAX_DURATION_MINUTES);
      // Raw headroom (limit − used) is ownReserved + the measured foreign baseline — always ≥ MAX_DURATION_MINUTES; the three
      // rows reserve all of the headroom that is left after the foreign baseline, leaving 0.
      const pool = { used: 100, headroomBeforeOwn: ownReserved };
      const refused = await admitAgainstPool(r, { ...pool, ownReserved });
      expect(refused.snapshot.headroom, "the admission's own figure: the three reservations took it all").toBe(pool.headroomBeforeOwn - ownReserved);
      expect(refused.made).toBeNull();
      expect(refused.refusal).toMatchObject({ status: 503, code: "storage_exhausted" });
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from fixture_stream_sessions where org_id = ${r.auth.orgId} and not (id = any(${refused.retired}::uuid[]))`;
      expect(n, "a refused start writes no row").toBe(0);
      await retireC3Rows(others);
      const admitted = await admitAgainstPool(r, { ...pool, ownReserved: 0 });   // completed rows reserve nothing
      expect(admitted.snapshot.headroom).toBe(pool.headroomBeforeOwn);
      expect(admitted.refusal).toBeNull();
      expect(admitted.made?.sessionId).toBeDefined();
    } finally {
      await retireC3Rows(others);
    }
  });

  it("C3 + B: a reservation held by a session the expiry policy ALREADY expires (warming 11 min, unread by anyone) no longer counts; at 9 min it still does", async () => {
    await retireC3Rows();
    const r = await rig({ credits: 1 });
    r.tick(C3_CLOCK_JUMP_MS);
    const rigNow = r.deps.now();
    const ago = (minutes: number) => new Date(rigNow.getTime() - minutes * 60_000);
    const stale = await rig({ credits: 1 });
    const fresh = await rig({ credits: 1 });
    const own: string[] = [];
    try {
      const [a] = await sql<{ id: string }[]>`insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, created_at,
                                              sport_key, competition_id, division_id, entitlement_via_override)
        select ${stale.fixtureId}, ${stale.auth.orgId}, 'passthrough', 'warming', ${stale.target.id}, ${stale.auth.userId}, ${ago(WARMING_TIMEOUT_MINUTES - 1)},
               d.sport_key, d.competition_id, f.division_id, true
          from fixtures f join divisions d on d.id = f.division_id where f.id = ${stale.fixtureId}
        returning id`;
      own.push(a!.id);
      const [b] = await sql<{ id: string }[]>`insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, created_at,
                                              sport_key, competition_id, division_id, entitlement_via_override)
        select ${fresh.fixtureId}, ${fresh.auth.orgId}, 'passthrough', 'warming', ${fresh.target.id}, ${fresh.auth.userId}, ${ago(1)},
               d.sport_key, d.competition_id, f.division_id, true
          from fixtures f join divisions d on d.id = f.division_id where f.id = ${fresh.fixtureId}
        returning id`;
      own.push(b!.id);
      // Both warming rows hold their reservation at 9 min and 1 min: the two together take the whole headroom → 0.
      const both = await reservedBy(own);
      const pool = { used: 400, headroomBeforeOwn: both };
      const refused = await admitAgainstPool(r, { ...pool, ownReserved: both });
      expect(refused.snapshot.headroom).toBe(0);
      expect(refused.refusal).toMatchObject({ code: "storage_exhausted" });
      // Push the stale one past the warming timeout — nobody reads it, no sweep runs — and the reserve is released by the POLICY alone.
      await sql`update fixture_stream_sessions set created_at = ${ago(WARMING_TIMEOUT_MINUTES + 1)} where id = ${a!.id}`;
      const admitted = await admitAgainstPool(r, { ...pool, ownReserved: await reservedBy([b!.id]) });
      expect(admitted.snapshot.headroom, "only the fresh row still reserves").toBe(both - (await reservedBy([b!.id])));
      expect(admitted.refusal).toBeNull();
      expect(admitted.made?.sessionId).toBeDefined();
    } finally {
      await retireC3Rows(own);
    }
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

  // Lane D amendment D5 (class 1 — a fixture on both ends proves the fixture). capture-qr.v1.test.ts pins the contract
  // against fixtures authored from §7.6; THIS is the seam: the payload the REAL builder (currentSession's qr) hands the
  // Phone tab, through the phone's parser and the checksummed JSON contract's required-key sets. It crosses the wire as
  // JSON, so the parse is of the serialised text, exactly what the QR encodes.
  it("D5: the REAL builder's qr satisfies the checksummed v1 contract — parseCaptureQr accepts its JSON verbatim, and its keys equal the contract's required set at every level", async () => {
    const contract = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../../../docs/contracts/capture-qr.v1.json"), "utf8")) as {
      required: string[]; properties: { cred: { required: string[]; properties: { srt: { required: string[] }; rtmps: { required: string[] } } } };
    };
    const r = await rig({ credits: 1 });
    await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const qr = (await currentSession(r.auth, r.fixtureId, r.deps))!.qr;
    expect(qr, "the warming projection carries a qr").not.toBeNull();
    const wire = JSON.parse(JSON.stringify(qr)) as unknown;
    expect(parseCaptureQr(wire, r.deps.now())).toEqual({ ok: true, payload: qr });
    const levels: [string, string[], string[]][] = [
      ["top", Object.keys(qr!), contract.required],
      ["cred", Object.keys(qr!.cred), contract.properties.cred.required],
      ["cred.srt", Object.keys(qr!.cred.srt), contract.properties.cred.properties.srt.required],
      ["cred.rtmps", Object.keys(qr!.cred.rtmps), contract.properties.cred.properties.rtmps.required],
    ];
    let checked = 0;
    for (const [name, built, required] of levels) {
      expect(required.length, `${name}: the contract declares no keys`).toBeGreaterThan(0);
      expect([...built].sort(), `${name}: the builder's keys vs the contract's`).toEqual([...required].sort());
      checked++;
    }
    expect(checked).toBe(4);
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

  it("F-A5 (owner 2026-09-29), through the real createSession: with the storage pool FULL, a second start on the SAME fixture answers 409 active_session carrying the running id — not 503 storage_exhausted; a SIBLING fixture on its own destination is refused 503 storage_exhausted, so the pool really is full (mutant: the old admit order → the same-fixture start reads storage_exhausted)", async () => {
    const r = await rig({ credits: 2, fixtures: 2 });
    const [f1, f2] = r.fixtureIds as [string, string];
    const first = await createSession(r.auth, f1, body(r.target.id), r.deps);
    // Full: one minute of headroom before any reservation — below one more booking whatever else the DB holds.
    r.ingest.storage = { ...r.ingest.storage, totalStorageMinutesLimit: r.ingest.storage.totalStorageMinutes + 1 };
    await expect(createSession(r.auth, f1, body(r.target.id), r.deps)).rejects.toMatchObject({
      status: 409, code: "active_session", extra: { sessionId: first.sessionId },
    });
    // The positive pair: the same full pool refuses a start that has no running stream to name. Its own destination, so
    // the destination guard (decided before admission) is not what answers.
    const own = await createStreamTarget(r.auth, r.auth.orgId, {
      kind: "youtube", label: "Court 2", streamKey: "yt-key-court-2",
    });
    await expect(createSession(r.auth, f2, body(own.id), r.deps)).rejects.toMatchObject({ status: 503, code: "storage_exhausted" });
    const rows = await sql<{ id: string; fixture_id: string }[]>`
      select id, fixture_id from fixture_stream_sessions where org_id = ${r.auth.orgId}`;
    expect(rows, "ONE session — the running one; neither refusal wrote a row").toEqual([{ id: first.sessionId, fixture_id: f1 }]);
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
    expect(failed.creditUsed, "D3: a session refused its credit at live used none").toBe(false);
    expect(live.creditUsed, "D3: the positive pair — the session that went live paid").toBe(true);
  });

  // Lane D amendment D3 (R3.15): the ended state's "1 credit used" chip reads `creditUsed`, so it must be TRUE only for
  // a session whose OWN consume still stands — net of refunds linked to it. The rule is the amendment's: the sum of this
  // session's consume + refund rows is below zero. Walked as a SEQUENCE: before the consume, after it, after a goodwill
  // refund that names no session, after a refund linked to this session, and the NEXT session on the same fixture.
  it("D3: creditUsed — false before the consume, true once it stands, unmoved by an unlinked refund, false after a refund linked to THIS session; the next session pays again and says so", async () => {
    const r = await rig({ credits: 2 });
    const a = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const warming = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(warming.state).toBe("warming");
    expect(warming.creditUsed, "no consume row yet — the empty case").toBe(false);
    r.tick(3000);
    const live = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(live.state).toBe("live");
    expect(live.creditUsed).toBe(true);
    const staff = await rigUser();
    await refundCredits({ orgId: r.auth.orgId, delta: 1, createdBy: staff, note: "goodwill", idempotencyKey: randomUUID(), sessionId: null });
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.creditUsed, "a refund naming no session returns nothing of this one").toBe(true);
    await refundCredits({ orgId: r.auth.orgId, delta: 1, createdBy: staff, note: "stream failed", idempotencyKey: randomUUID(), sessionId: a.sessionId });
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.creditUsed, "the linked refund nets the consume out").toBe(false);
    const stopped = await stopSession(r.auth, r.fixtureId, a.sessionId, r.deps);
    expect(stopped.creditUsed, "the stop route's projection is the same fact").toBe(false);
    // The refunded consume no longer stands, so it opens no reuse window (lane C D2): the next session pays, and says so.
    const b = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3000);
    const again = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(again).toMatchObject({ id: b.sessionId, state: "live", creditUsed: true });
  });

  it("D3: a restart inside the reuse window consumed nothing, so its creditUsed is false — while the session that paid read true", async () => {
    const r = await rig({ credits: 1 });
    const a = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3000);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!).toMatchObject({ id: a.sessionId, state: "live", creditUsed: true });
    expect((await stopSession(r.auth, r.fixtureId, a.sessionId, r.deps)).creditUsed).toBe(true);
    const b = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3000);
    const restarted = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(restarted).toMatchObject({ id: b.sessionId, state: "live" });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where session_id = ${b.sessionId}`;
    expect(n, "the restart wrote no ledger row").toBe(0);
    expect(restarted.creditUsed).toBe(false);
  });

  // The brief's ONE-credit seed, restored (fix round 1, I2). A club that bought exactly one credit, went live (1 → 0) and
  // lost the stream restarts the SAME match: design §5.2 "a restart after a failure is the same match" (orchestrator
  // ruling 2026-09-28, binding). The first build re-seeded 2 because `admit` refused `balance < 1` before the reuse rule
  // was ever asked — the re-seed hid exactly the boundary this test exists for.
  it("a restart on the same fixture within 24 h reaches live without consuming (m5 wiring) — from the brief's ONE credit, so the restart runs at balance 0", async () => {
    const r = await rig({ credits: 1 });
    await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3000);
    const cur = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(cur.state).toBe("live");
    await stopSession(r.auth, r.fixtureId, cur.id, r.deps);
    expect(await creditBalance(sql, r.auth.orgId)).toBe(0);                // the restart below really is AT zero
    const again = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3000);
    const live = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(live.id).toBe(again.sessionId);
    expect(live.state).toBe("live");
    expect(await creditBalance(sql, r.auth.orgId)).toBe(0);                // still 0: never negative, nothing consumed
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${r.auth.orgId} and reason = 'consume'`;
    expect(n).toBe(1);                                                      // one consume across the two sessions
  });

  // I2's boundary, from the DECLARED window (config.ts CREDIT_REUSE_HOURS — never a typed 24). The consume row is re-dated
  // relative to the rig's clock, which is the `now` both admission and consumeForSession read, so "a minute inside" and
  // "a minute past" differ from the rule's answer by exactly one minute each way. A different fixture has no window at all.
  it("I2: at balance 0 a restart is admitted ONLY for the same fixture inside the reuse window — a minute inside → admitted, live, no new consume, balance 0; a minute past → 402 no_credits; a DIFFERENT fixture → 402 no_credits; nothing is written for a refusal", async () => {
    const r = await rig({ credits: 1, fixtures: 2 });
    const [a, b] = r.fixtureIds as [string, string];
    const first = await createSession(r.auth, a, body(r.target.id), r.deps);
    r.tick(3000);
    expect((await currentSession(r.auth, a, r.deps))!.state).toBe("live");
    await stopSession(r.auth, a, first.sessionId, r.deps);
    expect(await creditBalance(sql, r.auth.orgId)).toBe(0);
    const consumes = async () => (await sql<{ n: number }[]>`
      select count(*)::int as n from org_stream_credits where org_id = ${r.auth.orgId} and reason = 'consume'`)[0]!.n;
    const rowsOn = async (f: string) => (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${f}`)[0]!.n;
    const redate = (minutesAgo: number) => sql`
      update org_stream_credits set created_at = ${r.deps.now()}::timestamptz - make_interval(mins => ${minutesAgo})
       where org_id = ${r.auth.orgId} and reason = 'consume'`;

    // A DIFFERENT fixture at 0: the window is per fixture, so B has none.
    await expect(createSession(r.auth, b, body(r.target.id), r.deps)).rejects.toMatchObject({ status: 402, code: "no_credits" });
    expect(await rowsOn(b)).toBe(0);

    // The SAME fixture, a minute inside the window → admitted, and it goes live without consuming.
    await redate(CREDIT_REUSE_HOURS * 60 - 1);
    const inside = await createSession(r.auth, a, body(r.target.id), r.deps);
    r.tick(3000);
    const live = (await currentSession(r.auth, a, r.deps))!;
    expect(live).toMatchObject({ id: inside.sessionId, state: "live" });
    expect(await consumes()).toBe(1);
    expect(await creditBalance(sql, r.auth.orgId)).toBe(0);
    await stopSession(r.auth, a, inside.sessionId, r.deps);

    // The SAME fixture, a minute past the window → the balance gate applies again.
    await redate(CREDIT_REUSE_HOURS * 60 + 1);
    const before = await rowsOn(a);
    await expect(createSession(r.auth, a, body(r.target.id), r.deps)).rejects.toMatchObject({ status: 402, code: "no_credits" });
    expect(await rowsOn(a)).toBe(before);
    expect(await consumes()).toBe(1);
  });

  // I-1 (lane-close review): the Phone tab read only the balance, so at 0 it sold a pack for a restart the server admits
  // free (§5.2, `admit`'s waived balance gate). The projection now carries `restartFree` — the SAME authority admission
  // asks (`reuseWindowOpen`, on the same clock) — and each of its answers below is checked against what `createSession`
  // then actually does, so the fact the panel shows and the gate the server applies cannot disagree. The window is the
  // DECLARED one (config.ts CREDIT_REUSE_HOURS), a minute inside and a minute past. The scenario is the review's: the paid
  // session went live, then the free restart's phone never connected and it failed `no_inbound_timeout` — at balance 0.
  it("I-1: restartFree — false before any consume, true once this fixture's consume stands; after a failed (no_inbound_timeout) restart at balance 0 it is true a minute inside the window and false a minute past it — and createSession agrees both ways", async () => {
    const r = await rig({ credits: 1 });
    const first = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const warming = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(warming).toMatchObject({ id: first.sessionId, state: "warming" });
    expect(warming.restartFree, "the empty case: nothing consumed on this fixture yet").toBe(false);
    r.tick(3000);
    const live = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(live).toMatchObject({ state: "live", creditUsed: true, restartFree: true });
    await stopSession(r.auth, r.fixtureId, first.sessionId, r.deps);
    expect(await creditBalance(sql, r.auth.orgId), "premise: the restart below runs AT zero").toBe(0);

    // The free restart's phone never connects: warming past its timeout, read by the organiser's poll.
    // Both rows are re-dated, the paid one further back: the projection reads the fixture's LATEST session by created_at.
    const second = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    await sql`update fixture_stream_sessions set created_at = now() - make_interval(mins => ${WARMING_TIMEOUT_MINUTES + 2}) where id = ${first.sessionId}`;
    await sql`update fixture_stream_sessions set created_at = now() - make_interval(mins => ${WARMING_TIMEOUT_MINUTES + 1}) where id = ${second.sessionId}`;
    const redate = (minutesAgo: number) => sql`
      update org_stream_credits set created_at = ${r.deps.now()}::timestamptz - make_interval(mins => ${minutesAgo})
       where org_id = ${r.auth.orgId} and reason = 'consume'`;
    await redate(CREDIT_REUSE_HOURS * 60 - 1);
    const failed = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(failed).toMatchObject({ id: second.sessionId, state: "failed", failReason: "no_inbound_timeout", balance: 0 });
    // The differential against D3's fact: THIS session used no credit, yet its restart is free — the paid one's window.
    expect(failed.creditUsed).toBe(false);
    expect(failed.restartFree, "a minute inside the window").toBe(true);

    await redate(CREDIT_REUSE_HOURS * 60 + 1);
    const past = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(past.restartFree, "a minute past the window").toBe(false);
    await expect(createSession(r.auth, r.fixtureId, body(r.target.id), r.deps), "…and admission agrees: at 0 it is refused").rejects.toMatchObject({ status: 402, code: "no_credits" });

    await redate(CREDIT_REUSE_HOURS * 60 - 1);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.restartFree).toBe(true);
    const third = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    expect(third.sessionId, "…and admission agrees: inside the window at 0 it is admitted").toBeTruthy();
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${r.auth.orgId} and reason = 'consume'`;
    expect(n, "one consume across all three sessions").toBe(1);
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

    const tw = await rig({ credits: 1, kind: "twitch", watchUrl: "https://www.twitch.tv/club" });
    const s3 = await createSession(tw.auth, tw.fixtureId, body(tw.target.id), tw.deps);
    tw.tick(3000);
    await currentSession(tw.auth, tw.fixtureId, tw.deps);
    expect((await stopSession(tw.auth, tw.fixtureId, s3.sessionId, tw.deps)).replayUrl).toBeNull();
  });

  // D6: the ingest url is the platform's preset, so no rig can name a "reject" host any more. The fake platform
  // refuses an output whose stream KEY starts with FAKE_REJECT_KEY_PREFIX instead.
  it("a rejected destination fails the session with target_rejected", async () => {
    const r = await rig({ credits: 1, streamKey: `${FAKE_REJECT_KEY_PREFIX}${randomUUID()}` });
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

  // Task 13 review m5: the two plan gates `refuse` throws are read back by the Phone tab's view model off
  // `extra.feature_key`, and both sides take the keys from ONE authority (lib/stream-plan-gates.ts). This drives each gate
  // through the REAL producer (createSession → refuse) and the REAL consumer (the v1 envelope → apiV1 → createErrorCode):
  // a server key that drifts from the authority reads as "unknown" here — a retry sentence where an upgrade was owed.
  it("m5: both plan gates createSession refuses carry an authority key on the wire, and the Phone tab reads each as plan_lacks_relay", async () => {
    const GATES = [
      { opts: { overlay: false, relay: false }, key: RELAY_PLAN_GATES.overlay },
      { opts: { overlay: true, relay: false }, key: RELAY_PLAN_GATES.relay },
    ] as const;
    let checked = 0;
    for (const { opts, key } of GATES) {
      const r = await rig({ credits: 1, ...opts });
      const err = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps).catch((e: unknown) => e);
      expect(err, key).toBeInstanceOf(HttpError);
      const res = await v1(async () => { throw err; });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(res);
      const wired = await apiV1(`/api/v1/fixtures/${r.fixtureId}/stream-sessions`, { method: "POST", json: body(r.target.id) })
        .catch((e: unknown) => e)
        .finally(() => fetchSpy.mockRestore());
      expect(wired, key).toBeInstanceOf(ApiV1Error);
      expect((wired as ApiV1Error).extra.feature_key, key).toBe(key);
      expect(createErrorCode(wired), key).toBe("plan_lacks_relay");
      checked++;
    }
    expect(checked).toBe(GATES.length);
  });

  // Task 13 review m4: `ingest_unavailable` is one of CREATE_ERROR_KEYS' refusals, and until now nothing drove the path
  // that produces it. A provider that refuses the live-input create is a 503 with that code — and the E5 shape: the row
  // it inserted is deleted (no dead row), and a passthrough create consumes nothing, so the balance stands.
  it("m4: an ingest whose create_live_input REJECTS refuses 503 ingest_unavailable — no session row, balance unchanged — and the next create starts", async () => {
    const r = await rig({ credits: 1 });
    const ingestSpy = vi.spyOn(r.ingest, "createLiveInput").mockRejectedValueOnce(new Error("provider 500"));
    try {
      const err = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 503, code: "ingest_unavailable" });
      expect(ingestSpy, "the refusal came from the ingest call, not before it").toHaveBeenCalledTimes(1);
    } finally {
      ingestSpy.mockRestore();
    }
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where org_id = ${r.auth.orgId}`;
    expect(n, "a refused start leaves no row").toBe(0);
    expect(await creditBalance(sql, r.auth.orgId)).toBe(1);
    // The positive pair: the same org, fixture and target, with the ingest answering again.
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
    expect(facts.target).toEqual({ url: STREAM_PLATFORM_PRESETS.youtube, streamKey: "yt-key" });
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
    // Task 11 review m5: the failed teardown is recorded on the ledger and re-issued by the table (below: a stale beat) —
    // it is not the organiser's error. The read answers the session as it now stands.
    expect(await currentSession(r.auth, r.fixtureId, { ...r.deps, drivers: { ...r.deps.drivers, runner: failing } })).toMatchObject({ id: sessionId, state: "live" });
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

  // Task 12 n1 (lane-close sweep). A create refused by the deployment's own configuration — before any provider call —
  // PROVABLY made nothing. Read as outcome-unknown (a plain Error), it ran lost → force_destroy → the one retry → the same
  // refusal → the last attempt's `machine_crash`, alarming on every attempt of every composed start. It now surfaces as the
  // port's made-nothing failure (A23), so the session fails at once with the reason the DOMAIN declares for a create that
  // made nothing — derived from the table, never typed — which differs from the unknown path's reason (the differential).
  const madeNothingReason = () => {
    const creating = { state: "creating" as const, attempt: 1, name: "n1", machineId: null, stopRequestedAt: null, lastExit: null };
    const out = stepRunner(creating, { type: "create_failed", retryable: false, outcomeUnknown: false }, new Date(0));
    expect(out.signal?.type).toBe("failed");
    return (out.signal as { reason: string }).reason;
  };
  const runnerHistory = async (sid: string) => (await sql<{ type: string; from_state: string; to_state: string }[]>`
    select type, from_state, to_state from fixture_stream_events where session_id = ${sid} and kind = 'runner_transition' order by seq`)
    .map((x) => `${x.from_state}-${x.type}->${x.to_state}`);
  const effectRows = async (sid: string, type: string) => (await sql<{ result: string }[]>`
    select result from fixture_stream_events where session_id = ${sid} and kind = 'effect' and type = ${type} order by seq`).map((x) => x.result);

  it("n1 (a): a LIVE deployment that cannot name its environment (no ENV_NAME) refuses the create before the port is called — made nothing: the session fails with the domain's made-nothing reason at once; no create call, no force_destroy, no retry", async () => {
    const r = await rig({ credits: 1 });
    const keep = { RELAY_DRIVERS: process.env.RELAY_DRIVERS, ENV_NAME: process.env.ENV_NAME };
    try {
      process.env.RELAY_DRIVERS = "live";          // only relayEnvironment() reads it here: the rig injects its own drivers
      delete process.env.ENV_NAME;
      const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
      expect(await r.row(sessionId)).toMatchObject({ state: "failed", fail_reason: madeNothingReason(), runner_state: "destroyed", runner_retries: 0, machine_id: null });
      expect(madeNothingReason(), "the differential: the unknown path's last-attempt reason").not.toBe(failReasonFromExit(null));
      expect(r.runner.created).toEqual([]);                      // refused BEFORE the port: nothing was ever asked for
      expect(r.runner.destroyed).toEqual([]);
      expect(await runnerHistory(sessionId)).toEqual(["none-create_started->creating", "creating-create_failed->destroyed"]);
      expect(await effectRows(sessionId, "create_machine")).toEqual(["failed"]);   // the attempt is still on the ledger
      expect(await effectRows(sessionId, "force_destroy")).toEqual([]);
      expect(await creditBalance(sql, r.auth.orgId)).toBe(1);
    } finally {
      for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it("n1 (b): the REAL lazy runner on the retired shared Fly app refuses on first use — through drivers.ts, the port, and the usecase: made nothing, not one request to Fly, the session fails with the domain's made-nothing reason", async () => {
    const r = await rig({ credits: 1 });
    const keys = ["RELAY_DRIVERS", "FLY_API_TOKEN", "RELAY_IMAGE", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_STREAM_TOKEN", "FLY_RELAY_APP", "ENV_NAME"];
    const keep = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const fetchSpy = vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    try {
      Object.assign(process.env, { RELAY_DRIVERS: "live", FLY_API_TOKEN: "fly-tok", RELAY_IMAGE: "registry.fly.io/seazn-relay:abc", CLOUDFLARE_ACCOUNT_ID: "acct",
        CLOUDFLARE_STREAM_TOKEN: "tok", FLY_RELAY_APP: FLY_RELAY_APP_RETIRED_DEFAULT, ENV_NAME: "stg" });
      vi.stubGlobal("fetch", fetchSpy);
      setRelayDriversForTest(null);
      const deps: SessionDeps = { ...r.deps, drivers: { ingest: r.ingest, runner: relayDrivers().runner } };   // the production runner binding
      const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), deps);
      expect(await r.row(sessionId)).toMatchObject({ state: "failed", fail_reason: madeNothingReason(), runner_state: "destroyed", runner_retries: 0, machine_id: null });
      expect(fetchSpy, "a refused configuration reached Fly").not.toHaveBeenCalled();
      expect(await runnerHistory(sessionId)).toEqual(["none-create_started->creating", "creating-create_failed->destroyed"]);
      expect(await effectRows(sessionId, "force_destroy")).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      setRelayDriversForTest(null);
      for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
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

  it("the stale create's force_destroy row carries WHICH attempt's Machine it destroyed — `staleAttempt` reaches the ledger through the sanitiser's allowlist (Task 11 review: the key was dropped since Task 10)", async () => {
    const r = await rig({ credits: 1 });
    let m1 = "";
    let issuedFor = 0;
    const slow = Object.assign(Object.create(r.runner) as FakeRunner, {
      async create(spec: RunnerSpec) {
        const handle = await r.runner.create(spec);
        m1 = handle.runnerId;
        issuedFor = spec.attempt;   // the attempt this create was ISSUED for — the producer's own fact
        await sql`update fixture_stream_sessions set runner_state = 'creating', runner_attempts = ${spec.attempt + 1}, runner_retries = 1,
                      runner_name = ${machineNameFor(spec.sessionId, spec.attempt + 1)} where id = ${spec.sessionId}`;
        return handle;
      },
    });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), { ...r.deps, drivers: { ...r.deps.drivers, runner: slow } });
    expect(issuedFor, "the create was issued").toBeGreaterThan(0);
    expect(r.runner.destroyed).toEqual([m1]);
    const rows = await sql<{ result: string; attempt: number | null; payload: Record<string, unknown> }[]>`
      select result, attempt, payload from fixture_stream_events where session_id = ${sessionId} and kind = 'effect' and type = 'force_destroy' order by seq`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "ok", attempt: issuedFor, payload: { machineId: m1, staleAttempt: issuedFor } });
    // The row the stale Machine was NOT made for: the session now names the next attempt.
    const [now] = await sql<{ runner_attempts: number }[]>`select runner_attempts from fixture_stream_sessions where id = ${sessionId}`;
    expect(now!.runner_attempts).toBe(issuedFor + 1);
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
    // Task 11 review m5: the failed DELETE is on the ledger (the effect rows below) and admission retries it — the
    // organiser's poll answers the session as it now stands, completed as stopped, never the provider's error.
    expect(await currentSession(r.auth, r.fixtureId, flaky)).toMatchObject({ id: old, state: "completed", endReason: "stopped" });
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

  // r2-m2 / r2-m3 (Task 11 re-review): a FAILED forced destroy may leave a Machine running, billing and pushing to a public
  // destination, so EVERY site alarms through the house Sentry helper — admission's teardown only logged a warning — and
  // each site's log line names the retry owner that really exists there. The shared "the table retries it" was false for a
  // stale create: no row names that Machine, and the daily sweep's orphan pass (Task 12, A22(b)) is what retries it. The
  // expected owners are typed here from each site's retry path (Task 11 m5, Task 12 A22(b)), never read from the module.
  it("r2-m2/r2-m3: a failed forced destroy is ALARMED at every site — the poll's, admission's, the sweep's and a stale create's — and each log line names that site's real retry owner", async () => {
    const failure = () => Object.assign(new Error("fake destroy failed"), { status: 503 });
    const logged: { site: string; msg: string }[] = [];
    const spy = vi.spyOn(log, "error").mockImplementation(((obj: { site?: string } | undefined, msg?: string) => {
      if (typeof msg === "string" && msg.startsWith("stream session: forced Machine destroy failed")) logged.push({ site: String(obj?.site), msg });
    }) as never);
    const alarms = () => sentry.captureError.mock.calls
      .filter(([, ctx]) => (ctx as { route?: string }).route === "relay.force_destroy")
      .map(([, ctx]) => (ctx as { extra: { site: string } }).extra.site);
    sentry.captureError.mockClear();
    try {
      // (1) force_destroy: the poll's forced destroy at grace + slack fails (seeded as 2C-post m5 seeds it).
      const r = await rig({ credits: 2 });
      const { sessionId: old } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
      await heartbeat(old, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
      const machine = (await r.row(old)).machine_id!;
      await sql`update fixture_stream_sessions set state = 'ending', desired_state = 'ending', end_reason = 'stopped', ending_at = now(), runner_state = 'stopping',
                    runner_stop_requested_at = now() - make_interval(secs => ${RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS + 1}) where id = ${old}`;
      const failing = Object.assign(Object.create(r.runner) as FakeRunner, { async destroy() { throw failure(); } });
      const flaky: SessionDeps = { ...r.deps, drivers: { ...r.deps.drivers, runner: failing } };
      expect(await currentSession(r.auth, r.fixtureId, flaky)).toMatchObject({ id: old, state: "completed" });
      // (2) admission: the next start's teardown of that still-listed Machine fails — refused 409, and now alarmed.
      await expect(createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), flaky)).rejects.toMatchObject({ status: 409 });
      // (3) sweep: the daily orphan pass destroys a listed Machine through the shared helper.
      expect(await destroyListedMachine(old, { runnerId: machine, name: machineNameFor(old, 1) }, flaky)).toBe(false);
      // (4) stale_create: a create that returns after its attempt moved on, and whose DELETE fails.
      const s = await rig({ credits: 1 });
      const slow = Object.assign(Object.create(s.runner) as FakeRunner, {
        async create(spec: RunnerSpec) {
          const handle = await s.runner.create(spec);
          await sql`update fixture_stream_sessions set runner_state = 'creating', runner_attempts = ${spec.attempt + 1}, runner_retries = 1,
                        runner_name = ${machineNameFor(spec.sessionId, spec.attempt + 1)} where id = ${spec.sessionId}`;
          return handle;
        },
        async destroy() { throw failure(); },
      });
      await createSession(s.auth, s.fixtureId, body(s.target.id, "composed"), { ...s.deps, drivers: { ...s.deps.drivers, runner: slow } });
    } finally {
      spy.mockRestore();
    }
    expect(alarms()).toEqual(["force_destroy", "admission", "sweep", "stale_create"]);
    const owner: Record<string, RegExp> = {
      force_destroy: /the runner table re-issues it/,
      sweep: /the next daily sweep retries it/,
      stale_create: /no row names this Machine.*the daily sweep's orphan pass retries it/,
    };
    expect(logged.map((l) => l.site)).toEqual(["force_destroy", "sweep", "stale_create"]);
    let checked = 0;
    for (const { site, msg } of logged) {
      expect(msg, site).toMatch(owner[site]!);
      expect(msg, site).not.toContain("the table retries it");
      checked++;
    }
    expect(checked).toBe(3);
    expect(new Set(logged.map((l) => l.msg)).size, "each site names its own owner").toBe(3);
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

  // m1 (lane C final review): four sites decided on an UNLOCKED read and then applied a plain command — the organiser's
  // poll (ingest_connected / target_rejected), Stop, and the Machine's beat (callback_playing / callback_stopped). A row
  // another request moved in between reached `decide` in a state that refuses the command, and InvalidTransition was a 500.
  // Each now applies the T5-a function form: the command is re-decided on the LOCKED row, and one that no longer applies
  // writes nothing and answers the projection. Each race below is driven deterministically: the provider read the poll
  // makes between its read and its apply ends the session through the real Stop (a real second writer), or the test holds
  // the org's money lock — which every apply takes first (A7) — while it ends the row, so the waiting apply meets it ended.
  const endUnderHeldLock = async (r: { auth: { orgId: string } }, sessionId: string, run: () => Promise<unknown>, end: string) => {
    let release!: () => void;
    const mayCommit = new Promise<void>((res) => (release = res));
    let signalHeld!: () => void;
    const held = new Promise<void>((res) => (signalHeld = res));
    const holder = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${orgMoneyLockKey(r.auth.orgId)}))`;
      signalHeld();
      await mayCommit;
      await tx.unsafe(end, [sessionId]);
    });
    await held;
    const pending = run().then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
    let waiting = 0;
    for (let i = 0; i < 100 && waiting === 0; i++) {
      await new Promise((res) => setTimeout(res, 20));
      [{ n: waiting }] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`;
    }
    expect(waiting, "the call never reached the org lock — the race was not staged").toBeGreaterThan(0);
    release();
    await holder;
    return pending;
  };

  it("M6 (through apply): a session created in one UTC month that goes live in the next draws the NEW month's free credit — the go-live consume rolls the month over under its own lock", async () => {
    const r = await rig({ credits: 2 });   // this month's grant made and spent: the ledger is 2 bought credits
    // V426's own row, never typed here.
    const [{ rate }] = await sql<{ rate: number }[]>`select int_value as rate from plan_entitlements where plan_key = 'community' and feature_key = 'streaming.credits.monthly'`;
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    // The month's period is the WALL clock (createSession's ensure and apply's rollover both read it, never deps.now()),
    // so the month is turned by faking Date alone — the rig's own clock and every timer stay real.
    const wall = new Date();
    const next = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 1, 0, 0, 30));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(next);
    try {
      r.tick(3000);
      expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state).toBe("live");
    } finally {
      vi.useRealTimers();
    }
    const consumes = await sql<{ bucket: string }[]>`select bucket from org_stream_credits where session_id = ${sessionId} and reason = 'consume'`;
    expect(consumes.map((c) => c.bucket), "the new month's free credit, not a bought one").toEqual(["monthly"]);
    const grants = await sql<{ delta: number }[]>`
      select delta from org_stream_credits where idempotency_key = ${streamMonthlyGrantKey(r.auth.orgId, streamMonthlyPeriod(next))}`;
    expect(grants.map((g) => g.delta)).toEqual([rate]);
    expect(await creditBalance(sql, r.auth.orgId)).toBe(2 + rate - 1);
  });

  it("M6 guard: a session the rate peek saw LIVE but the lock finds WARMING (a backwards move no writer makes) is refused by name — never consumed without the rollover — and the next apply goes live", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3000);
    await sql`update fixture_stream_sessions set state = 'live' where id = ${sessionId}`;   // what the peek reads
    const out = await endUnderHeldLock(r, sessionId, () => apply(sessionId, { type: "ingest_connected" }, r.deps),
      "update fixture_stream_sessions set state = 'warming' where id = $1");              // what the lock finds
    expect(out.ok).toBe(false);
    expect((out as { e: unknown }).e).toMatchObject({ status: 500, code: "monthly_rate_unresolved" });
    const consumed = async () => (await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where session_id = ${sessionId} and reason = 'consume'`)[0]!.n;
    expect(await consumed(), "nothing charged").toBe(0);
    expect((await r.row(sessionId)).state, "nothing written").toBe("warming");
    // The positive pair: the next apply peeks `warming`, reads the rate, and goes live with its consume.
    expect((await apply(sessionId, { type: "ingest_connected" }, r.deps))!.state).toBe("live");
    expect(await consumed()).toBe(1);
  });

  it("N4: a THROWING rate read (apply's pooled plan lookup) lets the organiser's Stop and the warming expiry complete — only a go-live consume is refused, by name, and every failed read is reported (mutant: drop the catch → Stop and expire throw the read's error)", async () => {
    const down = new Error("plan read down");
    const reportsFor = (orgId: string) => sentry.captureError.mock.calls.filter(([err, ctx]) =>
      err === down && (ctx as { orgId?: string; route?: string }).orgId === orgId && (ctx as { route?: string }).route === "relay.credits.apply_rate_read").length;
    const consumes = async (sid: string) => (await sql<{ n: number }[]>`
      select count(*)::int as n from org_stream_credits where session_id = ${sid} and reason = 'consume'`)[0]!.n;
    let checked = 0;
    try {
      // Stop, on a session that can still consume (the only states whose apply reads the rate).
      const stop = await rig({ credits: 1 });
      const s1 = await createSession(stop.auth, stop.fixtureId, body(stop.target.id), stop.deps);
      expect(["requested", "provisioning", "warming"], "premise: the apply below reads the rate").toContain((await stop.row(s1.sessionId)).state);
      rateRead.fail = down;
      rateRead.calls = 0;
      expect((await stopSession(stop.auth, stop.fixtureId, s1.sessionId, stop.deps)).state).toBe("completed");
      expect(rateRead.calls, "premise: the throwing read was reached").toBeGreaterThan(0);
      expect(await consumes(s1.sessionId)).toBe(0);
      expect(reportsFor(stop.auth.orgId)).toBeGreaterThan(0);
      checked++;

      // The warming timeout: a phone that never connects is failed on time, read or no read.
      rateRead.fail = null;
      const idle = await rig({ credits: 1, connectAfterMs: 24 * 3_600_000 });
      const s2 = await createSession(idle.auth, idle.fixtureId, body(idle.target.id), idle.deps);
      rateRead.fail = down;
      idle.tick((WARMING_TIMEOUT_MINUTES * 60 + 60) * 1000);
      await applyExpiry(s2.sessionId, idle.deps);
      expect(await idle.row(s2.sessionId)).toMatchObject({ state: "failed", fail_reason: "no_inbound_timeout" });
      expect(reportsFor(idle.auth.orgId)).toBeGreaterThan(0);
      checked++;

      // The one decision that needs the rate — the go-live consume — is refused by the existing guard, nothing charged or
      // written; the positive pair: once the read answers, the next apply goes live with its consume.
      rateRead.fail = null;
      const live = await rig({ credits: 1 });
      const s3 = await createSession(live.auth, live.fixtureId, body(live.target.id), live.deps);
      live.tick(3000);
      rateRead.fail = down;
      await expect(apply(s3.sessionId, { type: "ingest_connected" }, live.deps)).rejects.toMatchObject({ status: 500, code: "monthly_rate_unresolved" });
      expect(await consumes(s3.sessionId)).toBe(0);
      expect((await live.row(s3.sessionId)).state).toBe("warming");
      expect(reportsFor(live.auth.orgId)).toBeGreaterThan(0);
      rateRead.fail = null;
      expect((await apply(s3.sessionId, { type: "ingest_connected" }, live.deps))!.state).toBe("live");
      expect(await consumes(s3.sessionId)).toBe(1);
      checked++;
    } finally {
      rateRead.fail = null;
    }
    expect(checked).toBe(3);
  });

  it("m1 RACE (the poll): a Stop that lands between the poll's ingest read and its apply — the poll saw `warming` and a connected ingest — answers the ENDED projection, never a 500; nothing goes live and nothing is charged (mutant: plain ingest_connected apply → InvalidTransition)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3000);                                                    // the fake ingest is connected from here on
    let stopped = 0;
    const racing = Object.assign(Object.create(r.ingest) as FakeIngest, {
      inputStatus: async (id: string) => {
        await stopSession(r.auth, r.fixtureId, sessionId, r.deps);   // the second writer, through the real Stop
        stopped++;
        return r.ingest.inputStatus(id);
      },
    });
    const cur = (await currentSession(r.auth, r.fixtureId, { ...r.deps, drivers: { ...r.deps.drivers, ingest: racing } }))!;
    expect(stopped, "the race was staged once").toBe(1);
    expect(cur.state).toBe("completed");
    expect(await creditBalance(sql, r.auth.orgId)).toBe(1);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where session_id = ${sessionId} and reason = 'consume'`;
    expect(n).toBe(0);
  });

  it("m1 RACE (the poll, rejected): a Stop that lands between the poll's output read and its apply — the poll saw `rejected` — answers the ENDED projection (completed, not failed target_rejected), never a 500 (mutant: plain target_rejected apply → InvalidTransition)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    let stopped = 0;
    const racing = Object.assign(Object.create(r.ingest) as FakeIngest, {
      outputState: async () => {
        await stopSession(r.auth, r.fixtureId, sessionId, r.deps);
        stopped++;
        return "rejected" as const;
      },
    });
    const cur = (await currentSession(r.auth, r.fixtureId, { ...r.deps, drivers: { ...r.deps.drivers, ingest: racing } }))!;
    expect(stopped).toBe(1);
    expect(cur).toMatchObject({ state: "completed", failReason: null });
  });

  it("m1 RACE (Stop): a session another writer ENDS while the organiser's Stop waits for the lock answers the ended projection, 200, and records no tap — a finished session's tap asks for nothing (mutant: plain stop apply → InvalidTransition)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const out = await endUnderHeldLock(r, sessionId, () => stopSession(r.auth, r.fixtureId, sessionId, r.deps),
      "update fixture_stream_sessions set state = 'failed', fail_reason = 'no_inbound_timeout', ended_at = now() where id = $1");
    expect(out.ok ? "resolved" : String((out as { e: unknown }).e)).toBe("resolved");
    expect((out as { v: { state: string } }).v.state).toBe("failed");
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_stream_events where session_id = ${sessionId} and kind = 'action' and type = 'stop'`;
    expect(n).toBe(0);
  });

  it("m1 RACE (the beat): a composed session that another writer ENDS while its Machine's `playing` beat waits for the lock answers the beat, never a 500, and writes no runner transition (mutant: plain callback_playing apply → InvalidTransition on the terminal row)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    const jobToken = r.runner.created[0]!.jobToken;
    const [{ rs }] = await sql<{ rs: string }[]>`select runner_state as rs from fixture_stream_sessions where id = ${sessionId}`;
    expect(["booting", "playing"], "the premise: the beat's pre-check passes").toContain(rs);
    const [{ n: before }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${sessionId} and kind = 'runner_transition'`;
    const out = await endUnderHeldLock(r, sessionId, () => heartbeat(sessionId, jobToken, { state: "playing" }, r.deps),
      "update fixture_stream_sessions set state = 'failed', fail_reason = 'machine_crash', ended_at = now() where id = $1");
    expect(out.ok ? "resolved" : String((out as { e: unknown }).e)).toBe("resolved");
    const [{ n: after }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${sessionId} and kind = 'runner_transition'`;
    expect(after).toBe(before);
    expect((await r.row(sessionId)).runner_state).toBe(rs);
  });

  it("m1 RACE (the beat, between its two applies): a `stopped` beat whose runner another writer takes to `destroyed` AFTER the beat's expiry and BEFORE its callback answers the beat, never a 500 (mutant: plain callback_stopped apply → destroyed × callback_stopped is refused)", async () => {
    // The window is the gap between the beat's two applies. Postgres queues advisory-lock waiters in arrival order, so:
    // the test holds the org lock; the beat queues on it (its expiry); a second writer queues BEHIND the beat; release —
    // the beat's expiry runs and commits, its callback apply then queues behind the writer, and the writer's update lands
    // first. The callback meets a runner the pre-check never saw.
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    const jobToken = r.runner.created[0]!.jobToken;
    const [{ rs }] = await sql<{ rs: string }[]>`select runner_state as rs from fixture_stream_sessions where id = ${sessionId}`;
    expect(["stopping", "playing", "booting"], "the premise: the beat's pre-check passes").toContain(rs);
    const lockKey = orgMoneyLockKey(r.auth.orgId);
    const waiters = async (want: number) => {
      let n = 0;
      for (let i = 0; i < 100 && n < want; i++) {
        await new Promise((res) => setTimeout(res, 20));
        [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`;
      }
      return n;
    };
    let release!: () => void;
    const mayCommit = new Promise<void>((res) => (release = res));
    let signalHeld!: () => void;
    const held = new Promise<void>((res) => (signalHeld = res));
    const holder = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${lockKey}))`;
      signalHeld();
      await mayCommit;
    });
    await held;
    const beat = heartbeat(sessionId, jobToken, { state: "stopped" }, r.deps).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
    expect(await waiters(1), "the beat never queued on the org lock").toBeGreaterThanOrEqual(1);
    const writer = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${lockKey}))`;
      await tx`update fixture_stream_sessions set runner_state = 'destroyed' where id = ${sessionId}`;
    });
    expect(await waiters(2), "the second writer never queued behind the beat").toBeGreaterThanOrEqual(2);
    release();
    await holder;
    await writer;
    const out = await beat;
    expect(out.ok ? "resolved" : String((out as { e: unknown }).e)).toBe("resolved");
    expect((await r.row(sessionId)).runner_state).toBe("destroyed");   // the writer's state stands; the beat wrote no step
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

  // I1 (lane C final review): a passthrough session stays `warming` until something OBSERVES its ingest connected. The
  // organiser's poll did that only AFTER the expiry had run, and another court's create never did — so a phone that
  // connected at +1 min and was read by nobody was failed `no_inbound_timeout` at +10 min WHILE it streamed: no consume
  // row, a false reason, and the destination handed to the next court. The expiry now observes a passthrough warming
  // session's ingest before it expires it — only when an expiry is DUE, so a read with nothing due still asks no provider
  // anything. The rig's fake ingest connects `connectAfterMs` after its create on the rig's own clock, which `tick` moves,
  // so "connected at +1 min, no poll in between, read at +11 min" is exactly one tick and one read.
  const I1_CONNECT_MS = 60_000;
  const I1_PAST_TIMEOUT_MS = (WARMING_TIMEOUT_MINUTES + 1) * 60_000;
  const consumesOf = async (sid: string) => (await sql<{ n: number }[]>`
    select count(*)::int as n from org_stream_credits where session_id = ${sid} and reason = 'consume'`)[0]!.n;
  const falseTimeoutRows = async (sid: string) => (await sql<{ n: number }[]>`
    select count(*)::int as n from fixture_stream_events where session_id = ${sid} and payload::text like '%no_inbound_timeout%'`)[0]!.n;

  it("I1: a passthrough phone that CONNECTED at +1 min and was read by nobody is LIVE at the organiser's +11 min read — exactly one consume row, never no_inbound_timeout (mutant: expiry before the observation → failed no_inbound_timeout, 0 consumes)", async () => {
    expect(I1_CONNECT_MS).toBeLessThan(WARMING_TIMEOUT_MINUTES * 60_000);   // the premise: it connected INSIDE the window
    const r = await rig({ credits: 1, connectAfterMs: I1_CONNECT_MS });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    expect((await r.row(sessionId)).state).toBe("warming");          // nothing has observed it yet
    r.tick(I1_PAST_TIMEOUT_MS);                                      // past the warming timeout, no read in between
    const cur = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(cur.state).toBe("live");
    expect(cur.failReason).toBeNull();
    expect((await r.row(sessionId)).fail_reason).toBeNull();
    expect(await consumesOf(sessionId)).toBe(1);                     // it streamed, so it paid — once
    expect(await falseTimeoutRows(sessionId)).toBe(0);
    // The sequence: a second read changes nothing and charges nothing.
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state).toBe("live");
    expect(await consumesOf(sessionId)).toBe(1);
  });

  it("I1 via ANOTHER court's create: fixture A's phone connected at +1 min and was never polled; before the warming timeout B's start on the same destination is refused asking NO provider anything, and after it B's start OBSERVES A first — A goes LIVE (one consume) and B is still refused 409 target_in_use (mutant: expiry before the observation → A failed no_inbound_timeout and B admitted)", async () => {
    const r = await rig({ credits: 2, fixtures: 2, connectAfterMs: I1_CONNECT_MS });
    const [a, b] = r.fixtureIds;
    const held = await createSession(r.auth, a!, body(r.target.id), r.deps);
    const reads = vi.spyOn(r.ingest, "inputStatus");
    try {
      r.tick(I1_CONNECT_MS);                                         // connected, but nothing is DUE
      await expect(createSession(r.auth, b!, body(r.target.id), r.deps)).rejects.toMatchObject({ status: 409, code: "target_in_use" });
      expect(reads).toHaveBeenCalledTimes(0);                        // nothing due → no provider read (G-T1's promise kept)
      expect((await r.row(held.sessionId)).state).toBe("warming");
      r.tick(I1_PAST_TIMEOUT_MS - I1_CONNECT_MS);                    // now past the timeout, still unpolled
      await expect(createSession(r.auth, b!, body(r.target.id), r.deps)).rejects.toMatchObject({ status: 409, code: "target_in_use" });
      expect(reads).toHaveBeenCalledTimes(1);                        // ONE observation, of the holder
    } finally {
      reads.mockRestore();
    }
    expect(await r.row(held.sessionId)).toMatchObject({ state: "live", fail_reason: null });
    expect(await consumesOf(held.sessionId)).toBe(1);
    expect(await falseTimeoutRows(held.sessionId)).toBe(0);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${b!}`;
    expect(n).toBe(0);
  });

  // N1 (lane C re-review; orchestrator ruling): an ingest read that THROWS — a 5xx, the network, a revoked token's 401 —
  // is an unknown, and an unknown blocks exactly ONE expiry: `warming_timeout`, because a phone that may be connected must
  // not be failed `no_inbound_timeout` on it. Every other expiry — `wall_clock` above all — still applies: before N1 the
  // throw escaped before the expiry, so during an outage a warming session past its deadline was never ended, held its
  // destination (V421), and 500'd every organiser poll and another court's start. The failure is REPORTED, never thrown.
  const ingestDown = (r: { ingest: FakeIngest; deps: SessionDeps }, err: Error) => {
    const down = Object.assign(Object.create(r.ingest) as FakeIngest, { inputStatus: async () => { throw err; } });
    return { ...r.deps, drivers: { ...r.deps.drivers, ingest: down } } satisfies SessionDeps;
  };
  const readAlarms = () => sentry.captureError.mock.calls
    .filter(([, ctx]) => (ctx as { route?: string }).route === "relay.ingest_status")
    .map(([e, ctx]) => ({ err: String(e), site: (ctx as { extra?: { site?: string } }).extra?.site }));
  const PAST_WALL_CLOCK_MS = (MAX_DURATION_MINUTES + 1) * 60_000;

  it("N1: an ingest read that THROWS holds back only warming_timeout — at +11 min the organiser's poll answers (no 500), the session stays warming with no false reason, each failed read is reported once; the next read, provider back, finds it live and charges once (mutant: the unknown holds nothing → failed no_inbound_timeout)", async () => {
    const r = await rig({ credits: 1, connectAfterMs: I1_CONNECT_MS });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    expect(I1_PAST_TIMEOUT_MS, "the premise: only the warming timeout is due").toBeLessThan(MAX_DURATION_MINUTES * 60_000);
    r.tick(I1_PAST_TIMEOUT_MS);
    sentry.captureError.mockClear();
    const cur = (await currentSession(r.auth, r.fixtureId, ingestDown(r, new Error("cloudflare input status: HTTP 503"))))!;
    expect(cur).toMatchObject({ state: "warming", failReason: null, ingest: null });
    expect(await r.row(sessionId)).toMatchObject({ state: "warming", fail_reason: null });
    // Two reads failed in this request — the expiry's observation and the poll's own — and each is reported ONCE.
    expect(readAlarms()).toEqual([
      { err: "Error: cloudflare input status: HTTP 503", site: "expiry" },
      { err: "Error: cloudflare input status: HTTP 503", site: "poll" },
    ]);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state).toBe("live");
    expect(await consumesOf(sessionId)).toBe(1);
    expect(await falseTimeoutRows(sessionId)).toBe(0);
  });

  it("N1: an ingest read that THROWS does not hold back wall_clock — a warming passthrough past its deadline during an outage is ENDED by the organiser's poll (max_duration, 200), freeing its destination; the failed read is reported once and nothing is thrown (mutant: the unknown holds every expiry → still warming)", async () => {
    const r = await rig({ credits: 1, connectAfterMs: 24 * 3_600_000 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(PAST_WALL_CLOCK_MS);
    sentry.captureError.mockClear();
    const revoked = Object.assign(new Error("cloudflare input status: HTTP 401"), { status: 401 });
    const cur = (await currentSession(r.auth, r.fixtureId, ingestDown(r, revoked)))!;
    expect(cur).toMatchObject({ state: "completed", endReason: "max_duration", failReason: null });
    expect(readAlarms()).toEqual([{ err: "Error: cloudflare input status: HTTP 401", site: "expiry" }]);   // the poll is skipped: it ended
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_stream_sessions where target_id = ${r.target.id} and state in ${sql([...ACTIVE_STATES])}`;
    expect(n, "the destination is free").toBe(0);
    expect(await falseTimeoutRows(sessionId)).toBe(0);
  });

  it("N1 via ANOTHER court's create: with the holder's ingest read throwing, only warming_timeout due → B is refused 409 target_in_use (never a 500) and the holder stays warming; past the holder's wall clock → the holder is ended max_duration and B STARTS on the destination (mutants: holds nothing → B admitted over a maybe-live phone; holds everything → B refused forever)", async () => {
    const r = await rig({ credits: 2, fixtures: 2, connectAfterMs: 24 * 3_600_000 });
    const [a, b] = r.fixtureIds;
    const held = await createSession(r.auth, a!, body(r.target.id), r.deps);
    const down = ingestDown(r, new Error("fetch failed"));
    r.tick(I1_PAST_TIMEOUT_MS);
    sentry.captureError.mockClear();
    await expect(createSession(r.auth, b!, body(r.target.id), down)).rejects.toMatchObject({ status: 409, code: "target_in_use" });
    expect(await r.row(held.sessionId)).toMatchObject({ state: "warming", fail_reason: null });
    expect(readAlarms()).toEqual([{ err: "Error: fetch failed", site: "expiry" }]);
    r.tick(PAST_WALL_CLOCK_MS - I1_PAST_TIMEOUT_MS);
    const made = await createSession(r.auth, b!, body(r.target.id), down);
    expect(made.sessionId).toBeDefined();
    expect(await r.row(held.sessionId)).toMatchObject({ state: "completed", end_reason: "max_duration", fail_reason: null });
    expect(await falseTimeoutRows(held.sessionId)).toBe(0);
  });

  it("I1 negative pair: a phone that NEVER connected is still failed no_inbound_timeout at +11 min after one observation — and a session with no input row to observe falls through to the same expiry without asking the provider", async () => {
    const r = await rig({ credits: 1, connectAfterMs: 24 * 3_600_000 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const reads = vi.spyOn(r.ingest, "inputStatus");
    try {
      r.tick(I1_PAST_TIMEOUT_MS);
      await applyExpiry(sessionId, r.deps);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(await r.row(sessionId)).toMatchObject({ state: "failed", fail_reason: "no_inbound_timeout" });
      expect(await consumesOf(sessionId)).toBe(0);

      const r2 = await rig({ credits: 1, connectAfterMs: I1_CONNECT_MS });
      const s2 = await createSession(r2.auth, r2.fixtureId, body(r2.target.id), r2.deps);
      await sql`delete from fixture_stream_inputs where session_id = ${s2.sessionId}`;
      const reads2 = vi.spyOn(r2.ingest, "inputStatus");
      r2.tick(I1_PAST_TIMEOUT_MS);
      await applyExpiry(s2.sessionId, r2.deps);
      expect(reads2).toHaveBeenCalledTimes(0);
      expect(await r2.row(s2.sessionId)).toMatchObject({ state: "failed", fail_reason: "no_inbound_timeout" });
      reads2.mockRestore();
    } finally {
      reads.mockRestore();
    }
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
    expect(rows.filter((x) => x.kind === "effect").map((x) => [x.type, x.result])).toEqual([["create_live_input", "ok"], ["add_output", "ok"], ["release_output", "ok"], ["fill_replay", "ok"]]);   // C1: the output is removed at the completion, before the replay fill
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

// B3 N-3 (re-review): DB-FREE — hoisted out of the DB-gated describe it sat in, so the I-1 kill tests run in EVERY
// run, the sharded unit job's included, not only where DATABASE_URL is set.
// Spec 2026-09-30 §2 (T6): `openStreamStates` feeds the run sheet's chip (the division's path to Stop) and the fixture
// page's Stop-only mount. ONE guard decides "active" — the SQL `state in ACTIVE_STATES` filter. The fold after it
// (`holdStatesOf`) REPORTS a row that got past it and skips it — B3 fix round 1, I-1 (controller ruling): the guard
// must never block the organiser's page or its Stop, so it reports to Sentry instead of throwing.
describe("holdStatesOf — the fold after the SQL filter (I-1: report and skip, never throw)", () => {
  const row = (id: string, fixtureId: string, state: string) => ({ id, fixture_id: fixtureId, state: state as SessionState });
  const reports = () =>
    sentry.captureError.mock.calls.filter(([, ctx]) => (ctx as { route?: string } | undefined)?.route === "relay.open_stream_states");

  it("every ACTIVE row maps to the hold state the domain declares; none is reported", () => {
    sentry.captureError.mockClear();
    let checked = 0;
    for (const state of ACTIVE_STATES) {
      expect(holdStatesOf([row(`s-${state}`, "fx", state)]), state).toEqual({ fx: holdStateOf(state) });
      checked++;
    }
    expect(checked).toBe(ACTIVE_STATES.length);
    expect(checked, "anti-vacuity: the declared ACTIVE set is not empty").toBeGreaterThan(0);
    expect(reports(), "an active row is never an alarm").toEqual([]);
    expect(holdStatesOf([]), "the empty case").toEqual({});
  });

  it("a TERMINAL or UNKNOWN row is skipped AND reported — session id and state only — and the page still gets every other row", () => {
    const strays = [...TERMINAL_STATES, "archived_by_a_future_migration"];
    let checked = 0;
    for (const state of strays) {
      sentry.captureError.mockClear();
      const out = holdStatesOf([row("s-ok", "fx-ok", "live"), row(`s-${state}`, "fx-stray", state)]);
      expect(out, `${state}: skipped, and the good row still maps`).toEqual({ "fx-ok": "live" });
      expect(Object.prototype.hasOwnProperty.call(out, "fx-stray"), `${state}: no key at all (not a null value)`).toBe(false);
      const sent = reports();
      expect(sent, `${state}: reported once`).toHaveLength(1);
      const [err, ctx] = sent[0]! as [Error, { orgId?: string; route: string; extra: Record<string, unknown> }];
      expect(err).toBeInstanceOf(Error);
      expect(ctx.extra, `${state}: the session id and state, nothing else`).toEqual({ sessionId: `s-${state}`, state });
      expect(Object.keys(ctx).sort(), `${state}: no other context`).toEqual(["extra", "route"]);
      checked++;
    }
    expect(checked).toBe(strays.length);
    expect(TERMINAL_STATES.length, "anti-vacuity: the declared TERMINAL set is not empty").toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("the admission snapshot, the cost estimate, and every timed exit", () => {
  it("G7 (A22(d)): Cloudflare's FRACTIONAL storage minutes are admitted — used rounds UP and the limit DOWN into the integer columns — instead of 22P02-ing every start", async () => {
    const r = await rig({ credits: 1 });
    // R0 measured `totalStorageMinutes` 396.84 and 33.31. 396.34 and +0.84 are chosen so Math.round would give the OTHER
    // answer on both sides — a rounding mutant, or a truncation of `used`, cannot pass.
    r.ingest.storage = { totalStorageMinutes: 396.34, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES + 0.84, videoCount: 2 };
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const [row] = await sql<{ storage_minutes_at_admission: number }[]>`select storage_minutes_at_admission from fixture_stream_sessions where id = ${sessionId}`;
    expect(row!.storage_minutes_at_admission).toBe(397);
    const [snap] = await sql<{ used_minutes: number; limit_minutes: number; headroom_minutes: number; reserved_minutes: number }[]>`
      select used_minutes, limit_minutes, headroom_minutes, reserved_minutes from stream_storage_snapshots where source = 'admission' and session_id = ${sessionId}`;
    expect(snap).toMatchObject({ used_minutes: 397, limit_minutes: ROOMY_STORAGE_MINUTES });
    expect(snap!.headroom_minutes).toBe(ROOMY_STORAGE_MINUTES - 397 - snap!.reserved_minutes);   // the V410 CHECK's own arithmetic, in integers
  });

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
    const r = await rig({ credits: 1, streamKey: `${FAKE_REJECT_KEY_PREFIX}${randomUUID()}` });
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

  it("Dc: entitlement_via_override is true for a live staff override and false for a plan-granted org (driven through createSession since V426)", async () => {
    const r = await rig({ credits: 1 });                                   // the rig grants relay BY OVERRIDE
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    expect((await sql<{ v: boolean }[]>`select entitlement_via_override as v from fixture_stream_sessions where id = ${sessionId}`)[0]!.v).toBe(true);
    // The false arm through the REAL producer (Task 14b): V426 grants both keys on every plan, so an org with NO
    // override row is admitted by its plan — the plan-granted org that did not exist under V402 — and its session must
    // record false. A second rig, because the first one's session holds its fixture.
    const p = await rig({ credits: 1 });
    await sql`delete from org_entitlement_overrides where org_id = ${p.auth.orgId} and feature_key in ('streaming.overlay', 'streaming.relay')`;
    await invalidateOrgEntitlements(p.auth.orgId);
    expect(await overrideRow(p.auth.orgId, "streaming.relay"), "premise: no override row").toBeNull();
    const { sessionId: planSession } = await createSession(p.auth, p.fixtureId, body(p.target.id), p.deps);
    expect((await sql<{ v: boolean }[]>`select entitlement_via_override as v from fixture_stream_sessions where id = ${planSession}`)[0]!.v,
      "admitted by the plan, not by an override").toBe(false);
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
    // Only RAM above the preset's allowance is billed (the "declared PRESET" test below pins the rule on the page's numbers).
    const extraGb = Math.max(0, RUNNER_DEFAULT_GUEST.memoryMb / 1024 - RUNNER_DEFAULT_GUEST.cpus * FLY_PERFORMANCE_INCLUDED_GB_PER_CPU);
    const ram = (extraGb * FLY_RAM_MICROS_PER_GB_MONTH * secs) / FLY_BILLING_SECONDS_PER_MONTH;
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

  // The DECLARED pricing (config.ts, read from Fly's pricing page 2026-09-16): "performance-1x (1 performance CPU, 2GB)
  // $31.00/month … performance-4x (4, 8GB) $124.00/month … The preset price INCLUDES 2 GB per performance CPU", plus "about
  // $5 per 30 days per GB of additional RAM … ADDITIONAL RAM only — above the preset's 2 GB per CPU". The dollar figures
  // below are the page's, in cents (EST_COST_CURRENCY usd), over one 30-day billing month — never the function's output.
  // Before the lane-close sweep the formula charged EVERY guest GB: performance-4x/8GB read $164.00, not $124.00.
  it("compute is priced as the declared PRESET: a performance CPU's price includes 2 GB, and only RAM ABOVE that allowance is charged — the page's own examples", () => {
    const month = { recordingSeconds: 0, machineSeconds: FLY_BILLING_SECONDS_PER_MONTH, guestCpuClass: "dedicated" };
    const cases: [string, number, number, number][] = [
      ["performance-4x at its 8 GB preset: $124.00", 4, 8192, 12_400],
      ["performance-1x at its 2 GB preset: $31.00", 1, 2048, 3_100],
      ["performance-1x at 4 GB: $31.00 + 2 GB × $5 = $41.00 (the page shows $41.01; its $5 is 'about')", 1, 4096, 4_100],
      ["performance-4x at 16 GB: $124.00 + 8 GB × $5 = $164.00", 4, 16_384, 16_400],
      ["performance-1x BELOW its preset (1 GB) is no discount: $31.00", 1, 1024, 3_100],
    ];
    let checked = 0;
    for (const [name, guestCpus, guestMemoryMb, cents] of cases) {
      expect(estimateCostMinor({ ...month, guestCpus, guestMemoryMb }), name).toBe(cents);
      checked++;
    }
    expect(checked).toBe(cases.length);
    // The guest the relay actually boots sits exactly at its preset — no additional RAM at all.
    expect(RUNNER_DEFAULT_GUEST.memoryMb / 1024, "RUNNER_DEFAULT_GUEST's RAM is its 2 GB per CPU").toBe(RUNNER_DEFAULT_GUEST.cpus * 2);
  });

  it("Df: a guest class the rates do not cover gets null, never a borrowed rate", () => {
    expect(estimateCostMinor({ recordingSeconds: 60, machineSeconds: 100, guestCpus: 2, guestMemoryMb: 4096, guestCpuClass: "shared" })).toBeNull();
    expect(estimateCostMinor({ recordingSeconds: 60, machineSeconds: 100, guestCpus: null, guestMemoryMb: 4096, guestCpuClass: "dedicated" })).toBeNull();
  });

  // m4 (lane C final review): the title claimed "the uid addOutput RETURNED" while the body asserted only a non-null
  // string, and "a repeat" while the body drove a later READ. The spy now pins the returned value itself, and the title
  // names the read it actually drives.
  it("Dg: output_uid is EXACTLY the uid addOutput returned (one call, spied), and a later read — the organiser's poll — never moves it", async () => {
    const r = await rig({ credits: 1 });
    const added = vi.spyOn(r.ingest, "addOutput");
    let sessionId!: string;
    let returned!: string;
    try {
      ({ sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps));
      expect(added).toHaveBeenCalledTimes(1);
      returned = await (added.mock.results[0]!.value as Promise<string>);
    } finally {
      added.mockRestore();
    }
    const [inp] = await sql<{ ingest_input_id: string }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${sessionId}`;
    const [row] = await sql<{ output_uid: string | null }[]>`select output_uid from fixture_stream_sessions where id = ${sessionId}`;
    expect(r.ingest.outputsFor(inp!.ingest_input_id)).toHaveLength(1);
    // the uid the port handed back, not one the usecase invented
    expect(row!.output_uid).toBe(returned);
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
    // M9: relayBalance is retired; relayCredits (the page's ONE reader) carries C1 now.
    expect(await currentSession(r.auth, r.fixtureId, r.deps)).toBeNull();
    expect(await relayCredits(r.auth, r.auth.orgId)).toMatchObject({ total: 2, pack: 2 });
    const other = await rig({ credits: 1 });
    await expect(relayCredits(other.auth, r.auth.orgId)).rejects.toMatchObject({ status: 404 });   // 404 ≡ missing, never 403
  });

  // V426 (Task 14b, R3): the plan's free match credits, read from V426's own rows — never typed here.
  const monthlyRate = async (plan: string) =>
    (await sql<{ n: number }[]>`select int_value as n from plan_entitlements where plan_key = ${plan} and feature_key = 'streaming.credits.monthly'`)[0]!.n;

  it("V426 (R3a): an org that never bought a credit is ADMITTED on its plan's free monthly credits — createSession grants them before the balance gate, and the go-live consume draws the MONTHLY bucket", async () => {
    const r = await rig({ monthly: true });   // credits 0, and this period's grant left for createSession to make
    const rate = await monthlyRate("community");
    expect(rate, "premise: community's V426 row grants at least one").toBeGreaterThanOrEqual(1);
    expect(await creditBalance(sql, r.auth.orgId), "premise: nothing bought, nothing granted yet").toBe(0);
    await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const grants = await sql<{ bucket: string; delta: number }[]>`
      select bucket, delta from org_stream_credits where org_id = ${r.auth.orgId} and reason = 'grant'`;
    expect(grants.map((g) => ({ ...g }))).toEqual([{ bucket: "monthly", delta: rate }]);
    r.tick(3000);
    const live = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(live.state).toBe("live");
    expect(live.balance).toBe(rate - 1);
    const consumes = await sql<{ bucket: string }[]>`
      select bucket from org_stream_credits where org_id = ${r.auth.orgId} and reason = 'consume'`;
    expect(consumes.map((c) => c.bucket)).toEqual(["monthly"]);
    // The negative pair, on the rig's default (the grant made AND spent): no free credit left, so the same start is 402.
    const spent = await rig();
    await expect(createSession(spent.auth, spent.fixtureId, body(spent.target.id), spent.deps)).rejects.toMatchObject({ status: 402, code: "no_credits" });
  });

  it("R5: a deployment with its relay DISABLED refuses every start with the ingest's 503 — before any row, provider call or monthly grant; the same org starts on real drivers", async () => {
    const r = await rig({ credits: 1, monthly: true });
    const count = async (table: "fixture_stream_sessions" | "org_stream_credits") =>
      (await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} where org_id = ${r.auth.orgId}`)[0]!.n;
    const before = { sessions: await count("fixture_stream_sessions"), credits: await count("org_stream_credits") };
    const disabled: SessionDeps = { ...r.deps, drivers: disabledRelayDrivers() };
    await expect(createSession(r.auth, r.fixtureId, body(r.target.id), disabled)).rejects.toMatchObject({ status: 503, code: "ingest_unavailable" });
    expect(await count("fixture_stream_sessions"), "no session row").toBe(before.sessions);
    expect(await count("org_stream_credits"), "no ledger row — not even this month's free grant").toBe(before.credits);
    // Every port of the disabled pair rejects with RelayDriversDisabled, so a 503 carrying the ingest's own code (not
    // that error) is itself the proof that no provider was asked.
    // The positive pair: the same org, the same fixture, on the rig's drivers.
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    expect(sessionId).toBeTruthy();
  });

  // M10 (Task 14b review): a session left up from before a deployment lost its relay (the old fake default in production,
  // or a live one switched off) can no longer be observed: every port of the disabled pair refuses, a composed session's
  // poll threw on every tick, and the relay sweep skips a disabled deployment — so nothing ever ended it.
  const offDeps = (r: { deps: SessionDeps }): SessionDeps => ({ ...r.deps, drivers: disabledRelayDrivers() });
  const failedTransitions = async (sessionId: string) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${sessionId} and kind = 'transition' and to_state = 'failed'`)[0]!.n;
  const ledgerFor = async (sessionId: string) =>
    (await sql<{ reason: string }[]>`select reason from org_stream_credits where session_id = ${sessionId} order by created_at`).map((x) => x.reason);

  it("M10: a leftover WARMING session under disabled drivers is ended failed(relay_disabled) by the organiser's poll — once, and every later poll answers without a throw; it was never charged", async () => {
    const r = await rig({ credits: 2 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);   // up, on the fake drivers
    expect((await r.row(sessionId)).state, "premise: the leftover is still up").toBe("warming");
    let checked = 0;
    for (let i = 0; i < 3; i++) {   // polls two and three are the no-throw-loop witness
      expect(await currentSession(r.auth, r.fixtureId, offDeps(r)), `poll ${i + 1}`).toMatchObject({ state: "failed", failReason: "relay_disabled" });
      checked++;
    }
    expect(checked).toBe(3);
    // The Machine's own reads (jobSession, the sweep) reconcile a row whatever its state: an ENDED one is left alone.
    expect(await reconcileSession(sessionId, offDeps(r))).toMatchObject({ state: "failed", failReason: "relay_disabled" });
    expect(await failedTransitions(sessionId), "ended once, not once per poll").toBe(1);
    expect(await ledgerFor(sessionId), "a before-live session consumed nothing, so nothing is owed back").toEqual([]);
    expect(await creditBalance(sql, r.auth.orgId)).toBe(2);
  });

  it("M10: a leftover LIVE session keeps its consume, like every failure after go-live; its output release is refused by the port, reported once — and the poll still answers", async () => {
    const r = await rig({ credits: 2 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3000);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state, "premise: live, charged").toBe("live");
    expect((await r.row(sessionId)).state).toBe("live");
    sentry.captureError.mockClear();
    expect(await currentSession(r.auth, r.fixtureId, offDeps(r))).toMatchObject({ state: "failed", failReason: "relay_disabled" });
    expect(await ledgerFor(sessionId)).toEqual(["consume"]);
    expect(await creditBalance(sql, r.auth.orgId)).toBe(1);
    const releases = sentry.captureError.mock.calls.filter(([, ctx]) => (ctx as { route?: string }).route === "relay.release_output");
    expect(releases, "the output the fake drivers added cannot be removed without a relay: recorded and reported").toHaveLength(1);
  });

  it("M10: a leftover COMPOSED session with a Machine up is ended WITHOUT asking the runner — its runner is left as it stands for a provider to clean up later", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    const before = await r.row(sessionId);
    expect(before.machine_id, "premise: a Machine is up").toMatch(/^fake-machine-/);
    expect(await currentSession(r.auth, r.fixtureId, offDeps(r))).toMatchObject({ state: "failed", failReason: "relay_disabled" });
    const after = await r.row(sessionId);
    expect(after.runner_state, "no observation was made up").toBe(before.runner_state);
    expect(after.machine_id).toBe(before.machine_id);
  });

  it("M10: Stop under disabled drivers answers the ended projection — never a 500 — and a second Stop is the same answer", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, "composed"), r.deps);
    let checked = 0;
    for (let i = 0; i < 2; i++) {
      expect(await stopSession(r.auth, r.fixtureId, sessionId, offDeps(r)), `stop ${i + 1}`).toMatchObject({ state: "failed", failReason: "relay_disabled" });
      checked++;
    }
    expect(checked).toBe(2);
    expect(await failedTransitions(sessionId)).toBe(1);
  });

  it("N5: a Stop under disabled drivers records the organiser's TAP — one action row naming her, on the decision it made (relay_disabled) — while a poll that ends the same kind of session records none, and a second Stop on the ended session adds none (mutant: drop the actor → no row)", async () => {
    const actions = async (sid: string) => sql<{ type: string; actor_user_id: string | null; source: string; payload: { state?: string } }[]>`
      select type, actor_user_id, source, payload from fixture_stream_events where session_id = ${sid} and kind = 'action' and type <> 'create' order by seq`;
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    expect((await r.row(sessionId)).state, "premise: still up").toBe("warming");
    expect(await actions(sessionId), "premise: no tap yet").toEqual([]);
    for (let i = 0; i < 2; i++) {
      expect(await stopSession(r.auth, r.fixtureId, sessionId, offDeps(r)), `stop ${i + 1}`).toMatchObject({ state: "failed", failReason: "relay_disabled" });
    }
    expect(await actions(sessionId)).toEqual([{ type: "relay_disabled", actor_user_id: r.auth.userId, source: "client", payload: { state: "warming" } }]);
    // The differential: the same leftover ended by the organiser's POLL has no actor — nobody pressed anything.
    const polled = await rig({ credits: 1 });
    const p = await createSession(polled.auth, polled.fixtureId, body(polled.target.id), polled.deps);
    expect(await currentSession(polled.auth, polled.fixtureId, offDeps(polled))).toMatchObject({ state: "failed", failReason: "relay_disabled" });
    expect(await actions(p.sessionId)).toEqual([]);
  });

  it("V426 (R3b): relayCredits grants this month's free credits on the page's read, splits the balance by bucket beside the plan's allowance, a second read writes nothing, and another org's is 404", async () => {
    const r = await rig({ credits: 2, monthly: true });
    const rate = await monthlyRate("community");
    const count = async () => (await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${r.auth.orgId}`)[0]!.n;
    const first = await relayCredits(r.auth, r.auth.orgId);
    expect(first).toEqual({ monthly: rate, pack: 2, total: rate + 2, monthlyAllowance: rate });
    expect(first.total, "the chip's number is creditBalance's").toBe(await creditBalance(sql, r.auth.orgId));
    const n = await count();
    expect(await relayCredits(r.auth, r.auth.orgId)).toEqual(first);
    expect(await count(), "idempotent within the month").toBe(n);
    const other = await rig({ monthly: true });
    await expect(relayCredits(other.auth, r.auth.orgId)).rejects.toMatchObject({ status: 404 });
    expect(await count(), "a refused read grants nothing").toBe(n);
    // The allowance follows the RESOLVED plan: a pro org's is pro's row, and differs from community's.
    const pro = await rig({ monthly: true });
    await setOrgPlan(pro.auth.orgId, "pro");
    const proRate = await monthlyRate("pro");
    expect(proRate, "premise: the two rows differ").not.toBe(rate);
    expect(await relayCredits(pro.auth, pro.auth.orgId)).toEqual({ monthly: proRate, pack: 0, total: proRate, monthlyAllowance: proRate });
  });

  it("I1: a grant that FAILS never fails the page's read — relayCredits logs and reports it, then answers the ungranted balance; the healthy org beside it still grants", async () => {
    // A corrupt ledger: a NEGATIVE monthly bucket (no writer makes one — the rollover's ledger_negative guard refuses
    // it by name). This period's grant is left unmade, so the page's read takes the full path and the guard throws on
    // every render. Before I1 that throw was the division page's: one bad row took down the whole fixtures tab.
    const r = await rig({ credits: 2, monthly: true });
    await sql`insert into org_stream_credits (org_id, delta, reason, bucket, balance_after) values (${r.auth.orgId}, -1, 'consume', 'monthly', 1)`;
    const rate = await monthlyRate("community");
    const before = (await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${r.auth.orgId}`)[0]!.n;
    sentry.captureError.mockClear();
    const errors: string[] = [];
    const spy = vi.spyOn(log, "error").mockImplementation(((_o: unknown, msg?: string) => { errors.push(String(msg)); }) as never);
    try {
      let checked = 0;
      for (let i = 0; i < 2; i++) {   // every render, not just the first: a failed grant writes no key
        expect(await relayCredits(r.auth, r.auth.orgId)).toEqual({ monthly: -1, pack: 2, total: 1, monthlyAllowance: rate });
        checked++;
      }
      expect(checked).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect((await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${r.auth.orgId}`)[0]!.n, "nothing granted on top of the corrupt bucket").toBe(before);
    const reported = sentry.captureError.mock.calls.filter(([e, ctx]) => (e as { code?: string }).code === "ledger_negative" && (ctx as { orgId?: string }).orgId === r.auth.orgId);
    expect(reported, "each failed grant is REPORTED, not swallowed").toHaveLength(2);
    expect(errors.filter((m) => m.includes("monthly grant failed")), "and logged").toHaveLength(2);
    // Tenancy is not a grant failure: another org's read is still 404, never a soft fallback.
    const other = await rig({ monthly: true });
    await expect(relayCredits(other.auth, r.auth.orgId)).rejects.toMatchObject({ status: 404 });
    // The positive pair: a healthy org's read still grants.
    expect(await relayCredits(other.auth, other.auth.orgId)).toMatchObject({ monthly: rate, monthlyAllowance: rate });
  });

  it("m4: a grant that FAILS never blocks a start the org can pay for — createSession logs and reports it, then admits a PACK-funded org on the ungranted balance and it goes live; an org with nothing else is refused no_credits, never a 500", async () => {
    // The same corrupt ledger as I1 (a NEGATIVE monthly bucket the rollover's ledger_negative guard refuses by name), so
    // the ensure throws for real, from its own guard. Two pack credits beside it: the balance the gate reads is 1.
    const corrupt = async (credits: number) => {
      const r = await rig({ credits, monthly: true });
      await sql`insert into org_stream_credits (org_id, delta, reason, bucket, balance_after) values (${r.auth.orgId}, -1, 'consume', 'monthly', ${credits - 1})`;
      return r;
    };
    const r = await corrupt(2);
    expect(await creditBalance(sql, r.auth.orgId), "premise: pack 2, monthly -1").toBe(1);
    sentry.captureError.mockClear();
    const errors: string[] = [];
    const spy = vi.spyOn(log, "error").mockImplementation(((_o: unknown, msg?: string) => { errors.push(String(msg)); }) as never);
    let sessionId: string;
    try {
      ({ sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps));
    } finally {
      spy.mockRestore();
    }
    const reported = sentry.captureError.mock.calls.filter(([e, ctx]) => (e as { code?: string }).code === "ledger_negative" && (ctx as { orgId?: string }).orgId === r.auth.orgId);
    expect(reported, "the failed grant is REPORTED, not swallowed").toHaveLength(1);
    expect(reported[0]![1]).toMatchObject({ route: "relay.session.monthly_grant" });
    expect(errors.filter((m) => m.includes("monthly grant failed")), "and logged").toHaveLength(1);
    expect(await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${r.auth.orgId} and reason = 'grant' and bucket = 'monthly'`, "nothing granted on top of the corrupt bucket")
      .toEqual([{ n: 0 }]);
    // It goes live, and the go-live consume draws the PACK — the bucket that funded it.
    r.tick(3000);
    const live = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(live.id).toBe(sessionId);
    expect(live.state).toBe("live");
    const consumes = await sql<{ bucket: string }[]>`select bucket from org_stream_credits where session_id = ${sessionId} and reason = 'consume'`;
    expect(consumes.map((c) => c.bucket)).toEqual(["pack"]);
    // The negative pair: the same failed grant with nothing left to pay (pack 1 against the -1: a balance of 0 — the
    // ledger's own check refuses a negative balance_after, so 0 is the floor) is the balance gate's own 402, no row.
    const broke = await corrupt(1);
    expect(await creditBalance(sql, broke.auth.orgId), "premise: pack 1, monthly -1").toBe(0);
    const spy2 = vi.spyOn(log, "error").mockImplementation((() => {}) as never);
    try {
      await expect(createSession(broke.auth, broke.fixtureId, body(broke.target.id), broke.deps)).rejects.toMatchObject({ status: 402, code: "no_credits" });
    } finally {
      spy2.mockRestore();
    }
    expect(await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where org_id = ${broke.auth.orgId}`).toEqual([{ n: 0 }]);
  });

  it("I3: after a mid-month upgrade the card agrees with itself — relayCredits' monthly bucket is topped up to the allowance it prints", async () => {
    const r = await rig({ credits: 2, monthly: true });
    const community = await monthlyRate("community");
    const pro = await monthlyRate("pro");
    expect(pro, "premise: the upgrade raises the allowance").toBeGreaterThan(community);
    expect(await relayCredits(r.auth, r.auth.orgId)).toEqual({ monthly: community, pack: 2, total: community + 2, monthlyAllowance: community });
    await setOrgPlan(r.auth.orgId, "pro");
    const after = await relayCredits(r.auth, r.auth.orgId);
    expect(after.monthly, "\"Your plan includes N free\" above \"N free this month\" — the same N").toBe(after.monthlyAllowance);
    expect(after).toEqual({ monthly: pro, pack: 2, total: pro + 2, monthlyAllowance: pro });
  });

  /** SETUP: a session row in `state` on `fixtureId`, created `ageSec` seconds ago (so a case controls which is newest). Two
   *  ACTIVE rows at once need two destinations (V421: one active session per target). */
  const seedSessionRow = async (r: Awaited<ReturnType<typeof rig>>, fixtureId: string, state: SessionState, ageSec: number, targetId = r.target.id): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`
      insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, started_at, created_at,
                                           sport_key, competition_id, division_id, entitlement_via_override)
      select ${fixtureId}, ${r.auth.orgId}, 'passthrough', ${state}, ${targetId}, ${r.auth.userId}, now(),
             now() - make_interval(secs => ${ageSec}), d.sport_key, d.competition_id, f.division_id, true
        from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}
      returning id`;
    return row!.id;
  };

  it("openStreamStates: every ACTIVE state maps to the hold state the domain declares; every terminal state, an unlisted fixture and another org's read are absent", async () => {
    const r = await rig({ fixtures: 2 });
    const [a, b] = r.fixtureIds as [string, string];
    expect(await openStreamStates(r.auth, []), "the empty case asks nothing").toEqual({});
    expect(await openStreamStates(r.auth, [a, b]), "no session at all").toEqual({});
    const id = await seedSessionRow(r, a, "completed", 0);
    const other = await seedOrg();
    let checked = 0;
    for (const state of [...ACTIVE_STATES, ...TERMINAL_STATES]) {
      await sql`update fixture_stream_sessions set state = ${state} where id = ${id}`;
      // The expectation is the DOMAIN's declaration (relay/domain/session.ts), never this function's own table.
      const hold = holdStateOf(state);
      expect(hold !== null, `${state}: the domain calls it held exactly when it is ACTIVE`).toBe(ACTIVE_STATES.includes(state));
      expect(await openStreamStates(r.auth, [a, b]), state).toEqual(hold ? { [a]: hold } : {});
      // Tenancy: another org naming the same fixture ids reads nothing.
      expect(await openStreamStates(other.auth, [a, b]), `${state}, another org`).toEqual({});
      // An id outside the list is never reported, even while it is up.
      expect(await openStreamStates(r.auth, [b]), `${state}, unlisted`).toEqual({});
      checked++;
    }
    expect(checked).toBe(ACTIVE_STATES.length + TERMINAL_STATES.length);
    // Both hold states were witnessed, so neither answer can be a constant.
    expect(new Set(ACTIVE_STATES.map((s) => holdStateOf(s)))).toEqual(new Set(["live", "waiting"]));
    await sql`update fixture_stream_sessions set state = 'completed' where id = ${id}`;
  });

  it("openStreamStates: a fixture whose NEWEST rows are terminal still reports its active session — terminal rows never reach the loop (the SQL filter is the one guard)", async () => {
    const r = await rig({ fixtures: 2 });
    const [a, b] = r.fixtureIds as [string, string];
    const second = await createStreamTarget(r.auth, r.auth.orgId, { kind: "twitch", label: "Second", streamKey: "tw-key" });
    const live = await seedSessionRow(r, a, "live", 60);
    const provisioning = await seedSessionRow(r, b, "provisioning", 60, second.id);
    let terminal = 0;
    for (const s of TERMINAL_STATES) {
      await seedSessionRow(r, b, s, 0, second.id); // NEWER than b's active row: `distinct on … created_at desc` would pick it
      terminal++;
    }
    expect(terminal).toBe(TERMINAL_STATES.length);
    expect(await openStreamStates(r.auth, [a, b])).toEqual({ [a]: holdStateOf("live"), [b]: holdStateOf("provisioning") });
    await sql`update fixture_stream_sessions set state = 'completed' where id in (${live}, ${provisioning})`;
  });

  it("openStreamStates: ONLY terminal sessions on a fixture — absent (each terminal state alone)", async () => {
    let checked = 0;
    for (const s of TERMINAL_STATES) {
      const r = await rig();
      await seedSessionRow(r, r.fixtureId, s, 0);
      expect(await openStreamStates(r.auth, [r.fixtureId]), s).toEqual({});
      checked++;
    }
    expect(checked).toBe(TERMINAL_STATES.length);
  });

  it("§9.1 sequence — the run-sheet chip's state through a real session: waiting while the camera warms, live, then the organiser's Stop, then absent", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    const before = (await currentSession(r.auth, r.fixtureId, r.deps))!.state;
    expect(holdStateOf(before), `premise: ${before} is a waiting state`).toBe("waiting");
    expect(await openStreamStates(r.auth, [r.fixtureId]), "the camera is warming").toEqual({ [r.fixtureId]: "waiting" });
    r.tick(3000);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state).toBe("live");
    expect(await openStreamStates(r.auth, [r.fixtureId]), "on air").toEqual({ [r.fixtureId]: "live" });
    await stopSession(r.auth, r.fixtureId, sessionId, r.deps);
    const [{ state }] = await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${sessionId}`;
    expect(state, "the organiser's Stop ends the session (PATHS: completed)").toBe("completed");
    expect(await openStreamStates(r.auth, [r.fixtureId]), "after Stop the chip is gone").toEqual({});
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

  // m4 (fix round 1): the organiser's stop can land while `createSession`'s ingest call is out — nothing holds a lock across
  // that call. The composed `create_started` was applied unguarded after it, and `decide` refuses a runner create on an
  // ended session (InvalidTransition → a 500 on the organiser's own create). Driven through the REAL stopSession from
  // inside the ingest call, so the race is the production one, not a rewritten row. Both modes: passthrough's
  // `provisioned` guard was already there, and is the positive pair.
  it.each(["composed", "passthrough"] as const)("m4 (%s): a STOP landing while the create's ingest call is out is the domain's answer — the create resolves (never a 500), the session ends `stopped`, no Machine is asked for and no credit moves", async (mode) => {
    const r = await rig({ credits: 1 });
    const real = r.ingest.createLiveInput.bind(r.ingest);
    const seen: string[] = [];
    const spy = vi.spyOn(r.ingest, "createLiveInput").mockImplementationOnce(async (args) => {
      seen.push((await stopSession(r.auth, r.fixtureId, args.sessionId, r.deps)).state);
      return real(args);
    });
    try {
      const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id, mode), r.deps);
      expect(seen, "the stop really landed mid-create").toHaveLength(1);
      expect(await r.row(sessionId)).toMatchObject({ state: "completed", end_reason: "stopped", runner_state: "none", machine_id: null });
      expect(r.runner.created).toEqual([]);
      expect(await creditBalance(sql, r.auth.orgId)).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  // m7 (fix round 1): a repeated stop — a double tap, or a retry after a lost response — gets the same 200 projection the
  // first stop gave, and DECIDES nothing: no decision, no provider call. The projection is a poll, and a poll records what
  // it observes (samples; a draining Machine's observation) — so for a live Machine the claim is "exactly what a poll
  // writes, plus the tap", and for a completed session, which a poll does not reconcile, "nothing". Task 10 n5: the TAP on
  // an `ending` session is an `action:stop` row — the audit keeps every Stop the organiser pressed. A stop naming a session
  // the fixture has since SUPERSEDED is still 409 not_active — the projection would describe a different session.
  it("m7: a SECOND stop is idempotent — the same answer, no decision, no provider call — in both modes; on an ENDING session the tap alone is recorded (n5), on a completed one nothing; a stop naming a SUPERSEDED session is 409 not_active", async () => {
    // The whole history ledger, in order — so a moved row shows up in the diff by kind and type, not as a count.
    const eventsOf = async (sid: string) => (await sql<{ seq: number; kind: string; type: string }[]>`
      select seq, kind, type from fixture_stream_events where session_id = ${sid} order by seq`).map((e) => `${e.seq}:${e.kind}:${e.type}`);

    // Passthrough: the first stop completes at once.
    const p = await rig({ credits: 1 });
    const s1 = await createSession(p.auth, p.fixtureId, body(p.target.id), p.deps);
    const first = await stopSession(p.auth, p.fixtureId, s1.sessionId, p.deps);
    expect(first.state).toBe("completed");
    const before = await eventsOf(s1.sessionId);
    const second = await stopSession(p.auth, p.fixtureId, s1.sessionId, p.deps);
    expect(second).toMatchObject({ id: s1.sessionId, state: first.state, endReason: first.endReason });
    expect(await eventsOf(s1.sessionId)).toEqual(before);
    // Superseded: a newer session on the fixture — the old id is not the fixture's session any more.
    const s2 = await createSession(p.auth, p.fixtureId, body(p.target.id), p.deps);
    const s2Before = { events: await eventsOf(s2.sessionId), state: (await p.row(s2.sessionId)).state };
    await expect(stopSession(p.auth, p.fixtureId, s1.sessionId, p.deps)).rejects.toMatchObject({ status: 409, code: "not_active" });
    expect({ events: await eventsOf(s2.sessionId), state: (await p.row(s2.sessionId)).state }).toEqual(s2Before);

    // Composed: the first stop sends SIGINT and the session is `ending` while the Machine drains.
    const c = await rig({ credits: 1 });
    const s3 = await createSession(c.auth, c.fixtureId, body(c.target.id, "composed"), c.deps);
    await heartbeat(s3.sessionId, c.runner.created[0]!.jobToken, { state: "playing" }, c.deps);
    // A Machine still DRAINING after the SIGINT: Fly reports it `stopping`, so no projection read moves the session. (The
    // plain fake goes `stopped` and auto-destroys on the next look — the second stop's own projection would then complete
    // the session, which is that poll's work and not the stop's.)
    const draining = Object.assign(Object.create(c.runner) as FakeRunner, {
      async stop(id: string, opts: { signal: "SIGINT"; timeoutSeconds: number }) { await c.runner.stop(id, opts); c.runner.setObserved(id, "stopping"); },
    });
    const dd: SessionDeps = { ...c.deps, drivers: { ...c.deps.drivers, runner: draining } };
    const firstC = await stopSession(c.auth, c.fixtureId, s3.sessionId, dd);
    expect(firstC.state).toBe("ending");
    // The answer IS the projection, and the projection of a non-terminal session is a poll — its reconcile records what it
    // observed (a `runner_transition:observed` row per look at a draining Machine), exactly as the first stop's answer did.
    // So the claim is a DIFFERENTIAL: a repeated stop writes exactly what a plain poll writes plus its own TAP (n5) — the
    // action row, first — and decides nothing (no transition, no effect).
    const delta = async (fn: () => Promise<unknown>) => {
      const b = await eventsOf(s3.sessionId);
      await fn();
      return (await eventsOf(s3.sessionId)).slice(b.length).map((e) => e.replace(/^\d+:/, ""));
    };
    const pollDelta = await delta(() => currentSession(c.auth, c.fixtureId, dd));
    let secondC: Awaited<ReturnType<typeof stopSession>> | null = null;
    const stopDelta = await delta(async () => { secondC = await stopSession(c.auth, c.fixtureId, s3.sessionId, dd); });
    expect(secondC).toMatchObject({ id: s3.sessionId, state: "ending" });
    expect(stopDelta, "a repeated stop writes its tap, then exactly what a poll writes").toEqual(["action:stop", ...pollDelta]);
    expect(stopDelta.filter((k) => /^(transition|effect):/.test(k)), "the stop decides nothing").toEqual([]);
    const taps = await sql<{ actor_user_id: string | null; payload: Record<string, unknown> }[]>`
      select actor_user_id, payload from fixture_stream_events where session_id = ${s3.sessionId} and kind = 'action' and type = 'stop' order by seq`;
    expect(taps, "both taps, each with its organiser and the state it met").toEqual([
      { actor_user_id: c.auth.userId, payload: { state: "live" } },
      { actor_user_id: c.auth.userId, payload: { state: "ending" } },
    ]);
    expect(c.runner.stops).toHaveLength(1);                                   // ONE SIGINT
    expect(c.runner.destroyed).toEqual([]);
  });

  it("n5: a Stop tapped on a session ENDING for another reason — the deadline — is the organiser's recorded action (who, and the state it met), and decides nothing: no transition, no effect, no second SIGINT", async () => {
    const c = await rig({ credits: 1 });
    const draining = Object.assign(Object.create(c.runner) as FakeRunner, {
      async stop(id: string, opts: { signal: "SIGINT"; timeoutSeconds: number }) { await c.runner.stop(id, opts); c.runner.setObserved(id, "stopping"); },
    });
    const dd: SessionDeps = { ...c.deps, drivers: { ...c.deps.drivers, runner: draining } };
    const { sessionId } = await createSession(c.auth, c.fixtureId, body(c.target.id, "composed"), dd);
    await heartbeat(sessionId, c.runner.created[0]!.jobToken, { state: "playing" }, dd);
    c.tick((MAX_DURATION_MINUTES + 1) * 60_000);   // past the booking: the wall clock ends it on the next read
    expect(await currentSession(c.auth, c.fixtureId, dd)).toMatchObject({ id: sessionId, state: "ending", endReason: "max_duration" });
    const stopsBefore = c.runner.stops.length;
    expect(stopsBefore, "the deadline sent its SIGINT").toBe(1);
    const ledger = async () => (await sql<{ kind: string; type: string }[]>`
      select kind, type from fixture_stream_events where session_id = ${sessionId} order by seq`).map((e) => `${e.kind}:${e.type}`);
    const before = await ledger();
    expect(before.filter((k) => k === "action:stop"), "the deadline is not the organiser's stop").toEqual([]);
    const answered = await stopSession(c.auth, c.fixtureId, sessionId, dd);
    expect(answered).toMatchObject({ id: sessionId, state: "ending", endReason: "max_duration" });
    const added = (await ledger()).slice(before.length);
    expect(added.filter((k) => k.startsWith("action:")), "the tap is on the ledger").toEqual(["action:stop"]);
    expect(added.filter((k) => /^(transition|effect):/.test(k)), "and decides nothing").toEqual([]);
    const [tap] = await sql<{ actor_user_id: string | null; payload: Record<string, unknown> }[]>`
      select actor_user_id, payload from fixture_stream_events where session_id = ${sessionId} and kind = 'action' and type = 'stop'`;
    expect(tap).toEqual({ actor_user_id: c.auth.userId, payload: { state: "ending" } });
    expect(c.runner.stops).toHaveLength(stopsBefore);
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
/** A fixture's number and its organiser page, read from its own rows (stream-target-holders.test.ts's read). */
async function fixturePage(fixtureId: string): Promise<{ matchNo: number; href: string }> {
  const [fx] = await sql<{ fixture_no: number; org: string; comp: string; div: string }[]>`
    select f.fixture_no, o.slug as org, c.slug as comp, d.slug as div from fixtures f
      join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id
      join organizations o on o.id = c.org_id where f.id = ${fixtureId}`;
  return { matchNo: fx!.fixture_no, href: routes.fixture(fx!.org, fx!.comp, fx!.div, fx!.fixture_no) };
}

/** Puts `fixtureId` on a court named `name` at a venue of `orgId` (the G-T1 idiom). */
async function onCourt(orgId: string, fixtureId: string, name: string): Promise<void> {
  const [v] = await sql<{ id: string }[]>`insert into venues (org_id, name, address) values (${orgId}, 'Main Arena', '12 Court Road') returning id`;
  const [c] = await sql<{ id: string }[]>`insert into courts (venue_id, org_id, name) values (${v!.id}, ${orgId}, ${name}) returning id`;
  await sql`update fixtures set court_id = ${c!.id} where id = ${fixtureId}`;
}

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

  // T3 (spec §3.3, §5.5): the refusal NAMES the match holding the destination — its number, its court, its organiser
  // page and whether a phone is live or still awaited. Every expected field is read from the holder fixture's OWN rows
  // (routes.fixture over its slugs, stream-target-holders.test.ts's read) and the hold state from the domain's
  // holdStateOf, never from the usecase's output. `toEqual` on the holder: the wire carries exactly these six keys.
  it("T3 target_in_use NAMES the match: a LIVE holder and a WARMING holder each answer {fixtureId, matchNo, href, courtName, label, state} — live, then waiting", async () => {
    const seen = new Set<string>();
    for (const connect of [true, false]) {
      const r = await rig({ credits: 2, fixtures: 2, connectAfterMs: connect ? 3000 : 24 * 3_600_000 });
      const [a, b] = r.fixtureIds as [string, string];
      const court = `Court ${randomUUID().slice(0, 4)}`;
      await onCourt(r.auth.orgId, a, court);
      await createSession(r.auth, a, body(r.target.id), r.deps);
      if (connect) r.tick(3000);
      const held = (await currentSession(r.auth, a, r.deps))!;
      expect(held.state, "the holder reached the state this leg is about").toBe(connect ? "live" : "warming");
      const page = await fixturePage(a);
      const err = await createSession(r.auth, b, body(r.target.id), r.deps).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 409, code: "target_in_use" });
      expect((err as HttpError).extra).toEqual({
        holder: { fixtureId: a, matchNo: page.matchNo, href: page.href, courtName: court, label: r.target.label, state: holdStateOf(held.state as SessionState) },
      });
      seen.add(((err as HttpError).extra!.holder as { state: string }).state);
    }
    expect([...seen].sort(), "both hold states were witnessed").toEqual(["live", "waiting"]);
  });

  // F-A5 (owner, 2026-09-29: "a match already streaming answers a second start before credits, destination or storage
  // are weighed"), applied to the holder guard by the owner's answer B to the B2 re-review's point 6 (2026-09-30): a
  // stale second tab's Go live on a fixture that is ALREADY streaming is answered "already running", even when the
  // destination it picked is held by another match. The expected answer is the unheld twin's — the same fixture's own
  // second Go live on its own destination — so the held case is held to exactly what "already running" already means.
  it("F-A5 over the holder guard: a fixture ALREADY streaming answers a second Go live 409 active_session even when the destination it picks is HELD by another match — exactly the unheld twin's answer, nothing spent, nothing started; once it has stopped, the same Go live is target_in_use naming the holder's match", async () => {
    const rec = new FakeRecorder();
    const r = await rig({ credits: 2, fixtures: 2, recorder: rec });
    const deps: SessionDeps = { ...r.deps, drivers: { ...r.deps.drivers, runner: new FakeRunner({ recorder: rec }) } };
    const [a, b] = r.fixtureIds as [string, string];
    const two = await createStreamTarget(r.auth, r.auth.orgId, { kind: "youtube", label: "Court two", streamKey: `k-${randomUUID()}` });
    const running = await createSession(r.auth, a, body(r.target.id), deps);
    r.tick(3000);
    expect((await currentSession(r.auth, a, deps))!.state, "A is really streaming").toBe("live");
    await createSession(r.auth, b, body(two.id), deps);
    const holder = (await currentSession(r.auth, b, deps))!;
    expect(["warming", "live"], "B really holds the second destination").toContain(holder.state);
    const money = async () => ({
      balance: await creditBalance(sql, r.auth.orgId),
      ledger: (await sql<{ n: number; net: number }[]>`
        select count(*)::int as n, coalesce(sum(delta), 0)::int as net from org_stream_credits where org_id = ${r.auth.orgId}`)[0],
    });
    const aRows = async () => (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${a}`)[0]!.n;
    const attempt = async (targetId: string) => {
      const before = { money: await money(), rows: await aRows() };
      await new Promise((res) => setImmediate(res));
      rec.calls.length = 0;
      const err = await createSession(r.auth, a, body(targetId), deps).then(() => null, (e: unknown) => e);
      await new Promise((res) => setImmediate(res));
      expect(await money(), "a refusal spends nothing").toEqual(before.money);
      expect(await aRows(), "a refusal writes no session row").toBe(before.rows);
      expect(r.runner.created, "no Machine").toEqual([]);
      expect(err).toBeInstanceOf(HttpError);
      const e = err as HttpError;
      return { status: e.status, code: e.code, extra: e.extra ?? null, calls: rec.calls.map((c) => `${c.operation}:${c.sessionId ?? "-"}`) };
    };
    const unheld = await attempt(r.target.id);
    expect(unheld, "the twin: already running, on its own destination").toMatchObject({ status: 409, code: "active_session" });
    const held = await attempt(two.id);
    expect(held, "held by another match: still 'already running' — F-A5 — never target_in_use").toEqual(unheld);
    // …and B's hold is untouched by the refused attempt.
    expect((await currentSession(r.auth, b, deps))!.id).toBe(holder.id);
    // The other side of the ruling: A stopped, the same Go live is the holder's refusal, naming B's match, and asks no provider.
    await stopSession(r.auth, a, running.sessionId, deps);
    expect(await currentSession(r.auth, a, deps).then((s) => s?.state ?? null), "A has stopped").not.toBe("live");
    const page = await fixturePage(b);
    const afterStop = await attempt(two.id);
    expect(afterStop).toMatchObject({ status: 409, code: "target_in_use", calls: [] });
    expect((afterStop.extra as { holder: { fixtureId: string; matchNo: number } }).holder).toMatchObject({ fixtureId: b, matchNo: page.matchNo });
  });

  it("F-A5 carry: a start that skipped the destination doors because its fixture was streaming is refused active_session even if that session ENDS before the admission transaction — it never goes on to take a destination another match holds", async () => {
    const r = await rig({ credits: 2, fixtures: 2 });
    const [a, b] = r.fixtureIds as [string, string];
    const two = await createStreamTarget(r.auth, r.auth.orgId, { kind: "youtube", label: "Court two", streamKey: `k-${randomUUID()}` });
    const running = await createSession(r.auth, a, body(r.target.id), r.deps);
    await createSession(r.auth, b, body(two.id), r.deps);
    // The storage read sits between the door decision and the admission transaction: A's session ends inside it.
    const real = r.ingest.storageUsage.bind(r.ingest);
    let ended = 0;
    const spy = vi.spyOn(r.ingest, "storageUsage").mockImplementation(async () => {
      await sql`update fixture_stream_sessions set state = 'completed', ended_at = now(), end_reason = 'stopped' where id = ${running.sessionId}`;
      ended++;
      return real();
    });
    let err: unknown;
    try {
      err = await createSession(r.auth, a, body(two.id), r.deps).then(() => null, (e: unknown) => e);
    } finally {
      spy.mockRestore();
    }
    expect(ended, "the race really ran").toBe(1);
    expect(err).toMatchObject({ status: 409, code: "active_session" });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${a}`;
    expect(n, "no second session for A").toBe(1);
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

  // I1 (fix round 1 + addendum): the index and `targetHolderFor` see ACTIVE sessions only, and the prior-Machine teardown
  // saw only THIS fixture. A composed session on ANOTHER fixture that completed at grace + slack with its forced destroy
  // UNCONFIRMED (the 2C-post m5 state) keeps a Machine pushing to the destination's key — invisible to both. That Machine
  // is an orphan (its session is terminal), so the next fixture's admission DESTROYS it, recorded on the ended session's
  // own ledger; only while that destroy keeps failing is the start refused `target_in_use`, naming the court. A LIVE
  // session's Machine is never destroyed from an admission. Both modes of the NEW session, because a passthrough output
  // lands on the same key as a Machine does.
  async function zombieOnTarget() {
    const { r, a, b } = await twoFixturesOneTarget();
    const [v] = await sql<{ id: string }[]>`insert into venues (org_id, name, address) values (${r.auth.orgId}, 'Main Arena', '12 Court Road') returning id`;
    const [c] = await sql<{ id: string }[]>`insert into courts (venue_id, org_id, name) values (${v!.id}, ${r.auth.orgId}, 'Court 7') returning id`;
    await sql`update fixtures set court_id = ${c!.id} where id = ${a}`;
    const { sessionId: old } = await createSession(r.auth, a, body(r.target.id, "composed"), r.deps);
    await heartbeat(old, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
    const machine = (await r.row(old)).machine_id!;
    // Seeded exactly as the 2C-post m5 test seeds it (its comment says why a real stop cannot reach this state on the fake).
    await sql`update fixture_stream_sessions set state = 'ending', desired_state = 'ending', end_reason = 'stopped', ending_at = now(), runner_state = 'stopping',
                  runner_stop_requested_at = now() - make_interval(secs => ${RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS + 1}) where id = ${old}`;
    const destroyCalls: string[] = [];
    const failing = Object.assign(Object.create(r.runner) as FakeRunner, {
      async destroy(id: string) { destroyCalls.push(id); throw Object.assign(new Error("fake destroy failed"), { status: 503 }); },
    });
    const flaky: SessionDeps = { ...r.deps, drivers: { ...r.deps.drivers, runner: failing } };
    expect(await currentSession(r.auth, a, flaky)).toMatchObject({ id: old, state: "completed" });   // Task 11 review m5: the poll answers; the failure is A's ledger's
    expect(await r.row(old)).toMatchObject({ state: "completed", runner_state: "destroyed" });   // terminal: no index, no holder…
    expect((await r.runner.list()).map((m) => m.runnerId)).toContain(machine);                  // …and the Machine still pushing
    return { r, a, b, old, machine, flaky, destroyCalls };
  }

  /** The ended session's force_destroy history: result and the payload facts that say who forced it and why. */
  const forceDestroysOf = async (sid: string) => (await sql<{ result: string; payload: Record<string, unknown> }[]>`
    select result, payload from fixture_stream_events where session_id = ${sid} and kind = 'effect' and type = 'force_destroy' order by seq`)
    .map((e) => ({ result: e.result, reason: e.payload.reason ?? null, fixtureId: e.payload.fixtureId ?? null, machineId: e.payload.machineId ?? null }));

  it.each(["composed", "passthrough"] as const)("I1 (%s B), the destroy keeps FAILING: another fixture's ended session whose Machine is still listed holds the destination — B's admission TRIES the destroy (recorded on A's ledger: reason admission, B's fixture), it fails, and B is refused 409 target_in_use naming that court with nothing created (mutant: the prior-Machine query scoped to this fixture only → 201)", async (mode) => {
    const { r, a, b, old, machine, flaky, destroyCalls } = await zombieOnTarget();
    const callsBefore = destroyCalls.length;
    const ingestSpy = vi.spyOn(r.ingest, "createLiveInput");
    const page = await fixturePage(a);
    try {
      const err = await createSession(r.auth, b, body(r.target.id, mode), flaky).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 409, code: "target_in_use" });
      expect((err as Error).message).toContain("Court 7");
      // T3: an ENDED session whose Machine may still push reads `live` — to a person the destination is still receiving
      // from that match — and names it like an active holder does (its number and page from A's own rows).
      expect((err as HttpError).extra).toEqual({
        holder: { fixtureId: a, matchNo: page.matchNo, href: page.href, courtName: "Court 7", label: r.target.label, state: "live" },
      });
      expect(ingestSpy).not.toHaveBeenCalled();
    } finally {
      ingestSpy.mockRestore();
    }
    expect(destroyCalls.slice(callsBefore), "B's admission tried A's orphan exactly once").toEqual([machine]);
    expect(r.runner.created).toHaveLength(1);                                                   // A's, and nothing for B
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${b}`;
    expect(n).toBe(0);
    expect((await forceDestroysOf(old)).at(-1)).toEqual({ result: "failed", reason: "admission", fixtureId: b, machineId: machine });
  });

  it.each(["composed", "passthrough"] as const)("I1 (%s B), the destroy SUCCEEDS: B's admission destroys A's orphan Machine BEFORE any provider call for B, records it on A's ledger (reason admission, B's fixture), leaves A's row as it was, and B is admitted (mutant: restore the refuse-without-trying early return → 409)", async (mode) => {
    const { r, b, old, machine } = await zombieOnTarget();
    const aBefore = await r.row(old);
    // ONE call log across both providers, so "before" is an order and not two separate facts.
    const order: string[] = [];
    const logging = Object.assign(Object.create(r.runner) as FakeRunner, {
      async destroy(id: string) { order.push(`destroy:${id}`); return r.runner.destroy(id); },
      async create(spec: RunnerSpec) { order.push(`create:${spec.sessionId}`); return r.runner.create(spec); },
    });
    const real = r.ingest.createLiveInput.bind(r.ingest);
    const ingestSpy = vi.spyOn(r.ingest, "createLiveInput").mockImplementation(async (args) => { order.push(`input:${args.sessionId}`); return real(args); });
    let made: { sessionId: string };
    try {
      made = await createSession(r.auth, b, body(r.target.id, mode), { ...r.deps, drivers: { ...r.deps.drivers, runner: logging } });
    } finally {
      ingestSpy.mockRestore();
    }
    const expected = mode === "composed"
      ? [`destroy:${machine}`, `input:${made.sessionId}`, `create:${made.sessionId}`]
      : [`destroy:${machine}`, `input:${made.sessionId}`];
    expect(order).toEqual(expected);
    expect((await r.row(made.sessionId)).state).not.toBe("failed");
    expect((await r.runner.list()).map((m) => m.runnerId)).not.toContain(machine);
    expect((await forceDestroysOf(old)).at(-1)).toEqual({ result: "ok", reason: "admission", fixtureId: b, machineId: machine });
    const aAfter = await r.row(old);
    expect({ state: aAfter.state, end_reason: aAfter.end_reason, runner_state: aAfter.runner_state })
      .toEqual({ state: aBefore.state, end_reason: aBefore.end_reason, runner_state: aBefore.runner_state });   // fed nothing to decide (T12-a)
  });

  it("I1 guard: a LIVE session's Machine is never destroyed from an admission — another fixture starting on its destination is refused 409 target_in_use, and a second start on its OWN fixture 409 active_session; the Machine stays listed and the session stays live (mutant: the prior-Machine query admits ACTIVE sessions → the live Machine destroyed)", async () => {
    const { r, a, b } = await twoFixturesOneTarget();
    const { sessionId: live } = await createSession(r.auth, a, body(r.target.id, "composed"), r.deps);
    await heartbeat(live, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
    const machine = (await r.row(live)).machine_id!;
    expect((await r.row(live)).state).toBe("live");

    await expect(createSession(r.auth, b, body(r.target.id, "composed"), r.deps)).rejects.toMatchObject({ status: 409, code: "target_in_use" });
    await expect(createSession(r.auth, a, body(r.target.id, "composed"), r.deps)).rejects.toMatchObject({ status: 409, code: "active_session" });
    expect(r.runner.destroyed).toEqual([]);
    expect((await r.runner.list()).map((m) => m.runnerId)).toContain(machine);
    expect((await r.row(live)).state).toBe("live");
    expect(await forceDestroysOf(live)).toEqual([]);
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
    // Task 11 review m1: whichever guard refused, the extra names the holder — an object from the pre-check, `null` from
    // the index (routes.test.ts pins the null deterministically, on the wire).
    expect(lost[0]!.reason).toHaveProperty("extra.holder");
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_stream_sessions where target_id = ${r.target.id} and state in ${sql([...ACTIVE_STATES])}`;
    expect(n).toBe(1);
  });
  // T2b (spec §5.2, D2): an ARCHIVED destination is absent to Go live — the existing not-found shape, nothing made.
  // A credit on the rig: `admit` answers no_credits BEFORE target_not_found (domain/session.ts), so a creditless rig
  // would be refused 402 and never reach the target — the brief's `rig()` was that premise.
  it("an ARCHIVED target is refused at createSession with the existing not-found shape: 404, no live input, no machine, no session row", async () => {
    const r = await rig({ credits: 1 });
    await removeStreamTarget(r.auth, r.auth.orgId, r.target.id);
    const ingestSpy = vi.spyOn(r.ingest, "createLiveInput");
    try {
      await expect(createSession(r.auth, r.fixtureId, body(r.target.id), r.deps))
        .rejects.toMatchObject({ status: 404, message: "stream target not found" });
      expect(ingestSpy).not.toHaveBeenCalled();
    } finally {
      ingestSpy.mockRestore();
    }
    expect(r.runner.created).toEqual([]);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${r.fixtureId}`;
    expect(n).toBe(0);
  });

  it("the ROW LOCK: createSession WAITS on a transaction that holds the target FOR UPDATE, and an archive committed there makes it 404", async () => {
    const r = await rig({ credits: 1 });   // a credit: see the archived case above (no_credits outranks target_not_found)
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((res) => { locked = res; });
    const holder = sql.begin(async (tx) => {
      expect(await lockStreamTarget(tx, r.auth.orgId, r.target.id)).toBe(true);
      locked();
      await held;
      await archiveStreamTarget(tx, r.auth.orgId, r.target.id);
    });
    try {
      await lockTaken;
      let settled = false;
      const start = createSession(r.auth, r.fixtureId, body(r.target.id), r.deps)
        .finally(() => { settled = true; });
      start.catch(() => {});                                 // observed below; no unhandled rejection meanwhile
      await new Promise((res) => setTimeout(res, 300));
      expect(settled, "createSession did not wait on the target row lock").toBe(false);
      release();
      await holder;
      await expect(start).rejects.toMatchObject({ status: 404, message: "stream target not found" });
    } finally {
      release();                                             // a red above must not leave the holder tx open
      await holder.catch(() => {});
    }
  });

  // §9.1: the seam between the WRITER (replaceTargetKey reseals the stored destination and refingerprints) and the READER
  // (createSession's readTargetSecret and addOutput) — nothing else drives both.
  it("§9.1 sequence — replace a key, THEN go live: the output dials the NEW key, and the old key is dialled nowhere", async () => {
    const r = await rig({ credits: 1 });
    const before = await sql.begin((tx) => readTargetSecret(tx, r.auth.orgId, r.target.id));
    const newKey = `k-${randomUUID()}`;
    expect(newKey).not.toBe(before.streamKey);                        // or the test cannot tell the two apart
    await patchStreamTarget(r.auth, r.auth.orgId, r.target.id, { streamKey: newKey });
    const added = vi.spyOn(r.ingest, "addOutput");
    try {
      await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
      expect(added).toHaveBeenCalledTimes(1);
      expect(added.mock.calls[0]![1]).toMatchObject({ url: before.url, streamKey: newKey });
    } finally {
      added.mockRestore();
    }
    expect(r.ingest.liveOutputsTo({ url: before.url, streamKey: newKey })).toBe(1);
    expect(r.ingest.liveOutputsTo(before)).toBe(0);
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
    const tally = { runs: 0, steps: 0, invariantChecks: 0, refusals: 0, consumeRowsChecked: 0, sessionRowsChecked: 0, restartsLive: 0, zeroBalanceRestarts: 0, zeroBalanceRefusals: 0 };
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
            case "start": {
              // I2 (design §5.2): at balance 0 a start is admitted EXACTLY when this fixture already consumed inside the reuse
              // window. Every consume here is inside it (the rig clock moves seconds and no action re-dates a ledger row), so
              // "has a consume" IS "the window is open" — read from the ledger, never from the code under test.
              const atZero = (await creditBalance(sql, r.auth.orgId)) === 0;
              const windowOpen = atZero && (await sql`
                select 1 from org_stream_credits c join fixture_stream_sessions s on s.id = c.session_id
                 where c.org_id = ${r.auth.orgId} and c.reason = 'consume' and s.fixture_id = ${f!} limit 1`).length > 0;
              try {
                await createSession(r.auth, f!, { mode: a.mode, targetId: r.target.id }, r.deps);
              } catch (err) {
                if (atZero && (err as HttpError).code === "no_credits") {
                  expect(windowOpen, "I2 — a restart INSIDE the reuse window was refused 402 at balance 0").toBe(false);
                  tally.zeroBalanceRefusals++;
                }
                throw err;
              }
              if (atZero) {
                expect(windowOpen, "I2 — a start at balance 0 was admitted with NO reuse window").toBe(true);
                tally.zeroBalanceRestarts++;
              }
              return;
            }
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
        // Two orderings pinned on top of the drawn ones (fast-check counts them INSIDE numRuns), so every run reaches, whatever
        // the seed draws, a live session, a consume, a terminal row, an m5 restart, a refusal, and I2 in BOTH directions at
        // balance 0 (anti-vacuity: each of those checks is otherwise satisfied by an empty table).
        examples: [
          // I2: drain to 0, then ANOTHER fixture (refused 402 — it has no window) and the SAME fixture (admitted, free).
          [[
            { kind: "start", fixture: 0, mode: "passthrough" },
            { kind: "poll", fixture: 0, ms: 5_000 },
            { kind: "stop", fixture: 0 },
            { kind: "drain" },
            { kind: "start", fixture: 1, mode: "passthrough" },
            { kind: "start", fixture: 0, mode: "passthrough" },
            { kind: "poll", fixture: 0, ms: 5_000 },
          ]],
          [[
            { kind: "start", fixture: 0, mode: "passthrough" },
            { kind: "poll", fixture: 0, ms: 5_000 },
            { kind: "stop", fixture: 0 },
            { kind: "age", fixture: 0, what: "ending" },
            { kind: "poll", fixture: 0, ms: 1_000 },
            { kind: "start", fixture: 0, mode: "passthrough" },   // the m5 restart: live again, inside the window
            { kind: "poll", fixture: 0, ms: 5_000 },
            { kind: "start", fixture: 1, mode: "composed" },     // the other fixture: 409 target_in_use, one destination
          ]],
        ],
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
    expect(tally.zeroBalanceRestarts, "no start was ever admitted at balance 0, so I2 was never witnessed").toBeGreaterThan(0);
    expect(tally.zeroBalanceRefusals, "no start was ever refused at balance 0, so I2's other direction was never witnessed").toBeGreaterThan(0);
    expect(tally.refusals, "no refusal was ever drawn, so the refusal guard was never reached").toBeGreaterThan(0);
    expect(tally.sessionRowsChecked, "no session row was ever checked").toBeGreaterThan(0);
    expect(reached.has("live"), "no drawn or pinned ordering reached live").toBe(true);
    expect([...reached].some((st) => TERMINAL_STATES.includes(st as (typeof TERMINAL_STATES)[number])), "no ordering reached a terminal state").toBe(true);
  }, 180_000);
});

// C1 (lane C final review, Critical): a passthrough broadcast is Cloudflare simulcasting the phone's input to the
// destination through the ONE output the session added — and nothing removed it. Stop, the wall clock, a credit refusal
// and every failure marked the ROW terminal while the stream kept going. The destination the fake counts is the rig's
// own saved target (url + key), never read back from the code under test.
describe.skipIf(!HAS_DB)("C1: a passthrough session's Cloudflare OUTPUT is removed on every way it ends", () => {
  type Rig = Awaited<ReturnType<typeof rig>>;
  // D6: every rig destination is the YouTube preset url; what differs between rigs is the key.
  const destOf = (streamKey = "yt-key") => ({ url: STREAM_PLATFORM_PRESETS.youtube, streamKey });
  const facts = async (sid: string) => (await sql<{ state: string; fail_reason: string | null; end_reason: string | null; output_uid: string | null; output_released_at: Date | null }[]>`
    select state, fail_reason, end_reason, output_uid, output_released_at from fixture_stream_sessions where id = ${sid}`)[0]!;
  const releaseRows = (sid: string) => sql<{ result: string; source: string; reason: string | null; output: string | null }[]>`
    select result, source, payload->>'reason' as reason, payload->>'outputUid' as output from fixture_stream_events
     where session_id = ${sid} and kind = 'effect' and type = 'release_output' order by seq`;
  const releaseAlarms = () => sentry.captureError.mock.calls.filter(([, ctx]) => (ctx as { route?: string }).route === "relay.release_output");
  /** A Cloudflare that refuses the removal while `down.on` — every other call is the rig's own fake. */
  const flakyRemoval = (r: Rig) => {
    const down = { on: true, err: Object.assign(new Error("cloudflare remove output: HTTP 503 code 10000"), { status: 503 }) };
    const ingest = Object.assign(Object.create(r.ingest) as FakeIngest, {
      async removeOutput(inputId: string, outputId: string, meta?: { sessionId?: string | null }) {
        if (down.on) throw down.err;
        return FakeIngest.prototype.removeOutput.call(r.ingest, inputId, outputId, meta);
      },
    });
    return { down, deps: { ...r.deps, drivers: { ...r.deps.drivers, ingest } } as SessionDeps };
  };
  const goLive = async (r: Rig, fixtureId = r.fixtureId) => {
    r.tick(3000);
    expect((await currentSession(r.auth, fixtureId, r.deps))!.state).toBe("live");
  };

  // Every terminal path the brief names, each driven through the REAL readers (the organiser's Stop and poll).
  const PATHS: { name: string; streamKey?: string; connectAfterMs?: number; drive: (r: Rig, sid: string) => Promise<unknown>; ends: Record<string, string | null> }[] = [
    { name: "the organiser's Stop", drive: async (r, sid) => { await goLive(r); return stopSession(r.auth, r.fixtureId, sid, r.deps); },
      ends: { state: "completed", end_reason: "stopped", fail_reason: null } },
    { name: "a credit refused at go-live", drive: async (r) => {
      await sql`insert into org_stream_credits (org_id, delta, reason, balance_after) values (${r.auth.orgId}, -1, 'consume', 0)`;
      r.tick(3000);
      return currentSession(r.auth, r.fixtureId, r.deps);
    }, ends: { state: "failed", fail_reason: "no_credits", end_reason: null } },
    { name: "the wall clock (max duration)", drive: async (r) => {
      await goLive(r);
      r.tick((MAX_DURATION_MINUTES * 60 + 60) * 1000);
      return currentSession(r.auth, r.fixtureId, r.deps);
    }, ends: { state: "completed", end_reason: "max_duration", fail_reason: null } },
    { name: "the warming timeout (no inbound video)", connectAfterMs: 24 * 3_600_000, drive: async (r) => {
      r.tick((WARMING_TIMEOUT_MINUTES * 60 + 60) * 1000);
      return currentSession(r.auth, r.fixtureId, r.deps);
    }, ends: { state: "failed", fail_reason: "no_inbound_timeout", end_reason: null } },
    { name: "a destination that rejects the output", streamKey: `${FAKE_REJECT_KEY_PREFIX}${randomUUID()}`, drive: (r) => currentSession(r.auth, r.fixtureId, r.deps),
      ends: { state: "failed", fail_reason: "target_rejected", end_reason: null } },
  ];

  it("every terminal path — Stop, credit refused, wall clock, warming timeout, target rejected — leaves ZERO live outputs on the destination, the output released on the row, and one ok release_output effect row (mutants: drop the domain predicate; drop the runEffects case → red at every path)", async () => {
    let paths = 0;
    for (const p of PATHS) {
      const r = await rig({ credits: 1, ...(p.streamKey ? { streamKey: p.streamKey } : {}), ...(p.connectAfterMs ? { connectAfterMs: p.connectAfterMs } : {}) });
      const dest = destOf(p.streamKey);
      const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
      expect(r.ingest.liveOutputsTo(dest), `${p.name}: the positive pair — the broadcast's output exists before it ends`).toBe(1);
      await p.drive(r, sessionId);
      const f = await facts(sessionId);
      expect(f, p.name).toMatchObject(p.ends);
      expect(r.ingest.liveOutputsTo(dest), `${p.name}: still simulcasting after the session ended`).toBe(0);
      expect(f.output_released_at, p.name).toBeInstanceOf(Date);
      expect(r.ingest.removedOutputs, p.name).toEqual([f.output_uid]);
      expect(await releaseRows(sessionId), p.name).toEqual([{ result: "ok", source: "output", reason: "decision", output: f.output_uid }]);
      paths++;
    }
    expect(paths).toBe(PATHS.length);
    expect(paths).toBeGreaterThanOrEqual(5);
  });

  it("the SAME destination restarted after a Stop — on the same fixture, then on another — carries exactly ONE live output each time, never a second publisher on the key", async () => {
    const r = await rig({ credits: 2, fixtures: 2 });
    const dest = destOf();
    const [f1, f2] = r.fixtureIds as [string, string];
    const a = await createSession(r.auth, f1, body(r.target.id), r.deps);
    await goLive(r, f1);
    await stopSession(r.auth, f1, a.sessionId, r.deps);
    expect(r.ingest.liveOutputsTo(dest)).toBe(0);
    const b = await createSession(r.auth, f1, body(r.target.id), r.deps);   // the same match restarted (reuse window)
    expect(r.ingest.liveOutputsTo(dest)).toBe(1);
    await goLive(r, f1);
    await stopSession(r.auth, f1, b.sessionId, r.deps);
    await createSession(r.auth, f2, body(r.target.id), r.deps);             // the next match on that court's destination
    expect(r.ingest.liveOutputsTo(dest)).toBe(1);
  });

  it("a FAILED removal at the Stop never 500s and never undoes the Stop: completed stands, the output stays recorded and unreleased, the failure is on the ledger and ALARMED in Sentry naming the session and output (and nothing that could hold the key)", async () => {
    const r = await rig({ credits: 1 });
    const dest = destOf();
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    await goLive(r);
    const cf = flakyRemoval(r);
    sentry.captureError.mockClear();
    const done = await stopSession(r.auth, r.fixtureId, sessionId, cf.deps);    // resolves: the organiser gets an answer
    expect(done).toMatchObject({ id: sessionId, state: "completed", endReason: "stopped" });
    const f = await facts(sessionId);
    expect(f).toMatchObject({ state: "completed", end_reason: "stopped", output_released_at: null });
    expect(f.output_uid).not.toBeNull();
    expect(r.ingest.liveOutputsTo(dest)).toBe(1);                                 // the truth: it may still be broadcasting
    expect(await releaseRows(sessionId)).toEqual([{ result: "failed", source: "output", reason: "decision", output: f.output_uid }]);
    const alarms = releaseAlarms();
    expect(alarms).toHaveLength(1);
    expect(alarms[0]![0]).toBe(cf.down.err);
    expect(alarms[0]![1]).toMatchObject({ orgId: r.auth.orgId, extra: { sessionId, outputUid: f.output_uid, site: "decision" } });
    expect(JSON.stringify(alarms[0]![1])).not.toContain("yt-key");
  });

  it("ADMISSION backstop: a start on the destination of an ended session whose release FAILED retries the release first — while it keeps failing, another fixture is refused 409 target_in_use and this fixture 409 active_session, nothing created; once it succeeds the old output is released (reason admission) and the new start carries the ONE live output (mutant: drop the releasePriorOutputs call → 201 with TWO live outputs)", async () => {
    const r = await rig({ credits: 2, fixtures: 2 });
    const dest = destOf();
    const [f1, f2] = r.fixtureIds as [string, string];
    const { sessionId: old } = await createSession(r.auth, f1, body(r.target.id), r.deps);
    await goLive(r, f1);
    const cf = flakyRemoval(r);
    await stopSession(r.auth, f1, old, cf.deps);
    expect((await facts(old)).output_released_at).toBeNull();

    // T3: the ended session whose output may still simulcast is named like an active holder, and reads `live`.
    const page = await fixturePage(f1);
    const refused = await createSession(r.auth, f2, body(r.target.id), cf.deps).catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 409, code: "target_in_use" });
    expect((refused as HttpError).extra).toEqual({
      holder: { fixtureId: f1, matchNo: page.matchNo, href: page.href, courtName: null, label: r.target.label, state: "live" },
    });
    await expect(createSession(r.auth, f1, body(r.target.id), cf.deps)).rejects.toMatchObject({ status: 409, code: "active_session", extra: { sessionId: old } });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where target_id = ${r.target.id}`;
    expect(n).toBe(1);                                                            // no second session, no second input
    expect(r.ingest.liveOutputsTo(dest)).toBe(1);

    cf.down.on = false;
    await createSession(r.auth, f2, body(r.target.id), cf.deps);
    expect((await facts(old)).output_released_at).toBeInstanceOf(Date);
    expect(r.ingest.liveOutputsTo(dest)).toBe(1);                                 // the NEW session's, alone
    expect((await releaseRows(old)).map((x) => `${x.result}:${x.reason}`)).toEqual(["failed:decision", "failed:admission", "failed:admission", "ok:admission"]);
  });

  it("a Stop that lands WHILE the output is still being added: the terminal decision read no output, so the output the add then returns is released at once — never left simulcasting for a session that is over (mutant: drop the late-add release → red)", async () => {
    const r = await rig({ credits: 1 });
    const dest = destOf();
    const racing = Object.assign(Object.create(r.ingest) as FakeIngest, {
      async addOutput(inputId: string, target: { url: string; streamKey: string }) {
        const [held] = await sql<{ id: string }[]>`select id from fixture_stream_sessions where fixture_id = ${r.fixtureId} and state = 'warming'`;
        await stopSession(r.auth, r.fixtureId, held!.id, r.deps);                // the organiser's tap, mid-add
        return FakeIngest.prototype.addOutput.call(r.ingest, inputId, target);
      },
    });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), { ...r.deps, drivers: { ...r.deps.drivers, ingest: racing } });
    const f = await facts(sessionId);
    expect(f).toMatchObject({ state: "completed", end_reason: "stopped" });
    expect(f.output_uid).not.toBeNull();                                          // the add DID land
    expect(r.ingest.liveOutputsTo(dest)).toBe(0);
    expect(f.output_released_at).toBeInstanceOf(Date);
    expect(await releaseRows(sessionId)).toEqual([{ result: "ok", source: "output", reason: "late_add", output: f.output_uid }]);
  });
});

// T4 (spec §5.6 D3, §5.7). The destination's side of a passthrough broadcast reaches the projection as {state, since},
// and every provider call a session makes carries that session's id on its stream_provider_calls row.
describe.skipIf(!HAS_DB)("T4: output {state, since} on the projection, and the session id on every per-session provider call", () => {
  type Rig = Awaited<ReturnType<typeof rig>>;
  const goLive = async (r: Rig) => {
    r.tick(3000);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state).toBe("live");
  };
  const flush = () => new Promise((res) => setImmediate(res));
  const iso = (d: Date) => d.toISOString();

  it("output.since is when the destination's CURRENT receiving / not-receiving period began — the first ingest_status event after the last one on the other side of ok, not the latest poll and not the latest event — and elapsedMs is measured to the server's now", async () => {
    const r = await rig({ credits: 1, streamKey: `${FAKE_CONNECTING_KEY_PREFIX}${randomUUID()}` });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    await goLive(r);
    const tLive = r.deps.now();
    const first = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(first.output).toEqual({ state: "connecting", since: iso(tLive), elapsedMs: 0 });   // the real fake: a destination that never accepts
    r.tick(10_000);
    const second = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(second.output!.since, "unchanged state: since does not move with the poll").toBe(first.output!.since);
    expect(second.output!.elapsedMs, "…and the elapsed does, on the server's clock").toBe(10_000);
    // The state MOVES while live, so the trailing run starts after live_at and the clamp cannot answer for it.
    let out: OutputState = "ok";
    const spy = vi.spyOn(r.ingest, "outputState").mockImplementation(async () => out);
    try {
      r.tick(5_000);
      const tOk = r.deps.now();
      expect((await currentSession(r.auth, r.fixtureId, r.deps))!.output).toEqual({ state: "ok", since: iso(tOk), elapsedMs: 0 });
      out = "connecting";
      r.tick(5_000);
      const tBack = r.deps.now();
      expect((await currentSession(r.auth, r.fixtureId, r.deps))!.output, "a second run of connecting starts at ITS first event").toEqual({ state: "connecting", since: iso(tBack), elapsedMs: 0 });
      // An ingest_status event whose INGEST word changes but whose output word does not is inside the same run.
      const [inp] = await sql<{ ingest_input_id: string }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${sessionId}`;
      r.ingest.setState(inp!.ingest_input_id, "disconnected");
      r.tick(5_000);
      expect((await currentSession(r.auth, r.fixtureId, r.deps))!.output, "not the latest event").toEqual({ state: "connecting", since: iso(tBack), elapsedMs: 5_000 });
      r.tick(5_000);
      expect((await currentSession(r.auth, r.fixtureId, r.deps))!.output, "not the latest poll").toEqual({ state: "connecting", since: iso(tBack), elapsedMs: 10_000 });
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${sessionId} and type = 'ingest_status'`;
      expect(n, "connected+connecting, ok, connecting, disconnected — four events, so the run really had a boundary and an inside").toBe(4);
    } finally {
      spy.mockRestore();
    }
  });

  it("D3's clock starts at LIVE, never during warming: warm 45 s with the output non-ok, go live — no warning at live+0 s or live+29.999 s, a warning at live+30 s", async () => {
    const WARM_MS = 45_000;
    const POLL_MS = 5_000;
    let checked = 0;
    for (const nonOk of ["unknown", "connecting"] as const) {
      // The output reads the SAME non-ok state before and after go-live — Cloudflare's shape when the destination has
      // not been tried yet — so the trailing run of that state starts in warming. Only the live clamp stops the clock.
      const r = await rig({ credits: 1, connectAfterMs: WARM_MS });
      const outSpy = vi.spyOn(r.ingest, "outputState").mockResolvedValue(nonOk);
      try {
        await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
        let polls = 0;
        for (let t = 0; t < WARM_MS; t += POLL_MS) {                // the organiser's poll through warming
          expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state, `${nonOk} t=${t}`).not.toBe("live");
          polls++;
          r.tick(POLL_MS);
        }
        expect(polls).toBe(WARM_MS / POLL_MS);
        const live = await currentSession(r.auth, r.fixtureId, r.deps);
        expect(live!.state, nonOk).toBe("live");
        expect(live!.output, nonOk).toEqual({ state: nonOk, since: iso(r.deps.now()), elapsedMs: 0 });   // clamped to live_at
        expect(destinationWarning(live!), `${nonOk} live+0`).toBe(false);
        r.tick(OUTPUT_WARNING_AFTER_MS - 1);
        const early = await currentSession(r.auth, r.fixtureId, r.deps);
        expect(destinationWarning(early!), `${nonOk} live+29.999`).toBe(false);
        r.tick(1);
        const due = await currentSession(r.auth, r.fixtureId, r.deps);
        expect(destinationWarning(due!), `${nonOk} live+30`).toBe(true);
        expect(due!.state, "D3 warns; it never ends the stream").toBe("live");
      } finally {
        outSpy.mockRestore();
      }
      checked++;
    }
    expect(checked).toBe(2);
  });

  // I1 (B2 review): D3 is "the destination has not RECEIVED for 30 s" (spec §0 D3; §3.2 "output not ok ≥ 30 s") — a
  // judgment of ok versus not-ok, never of the word. Every expected instant below is live + a spec offset, derived from
  // OUTPUT_WARNING_AFTER_MS; the word-run boundary this replaced put the first warning at live+50 s here, and never
  // raised it at all for a destination flapping between two non-ok words.
  /** Poll at `ms` after `tLive` with the destination reading `word` — the organiser's poll IS the observation. */
  const pollAt = async (r: Rig, tLive: number, ms: number, word: OutputState, set: (w: OutputState) => void) => {
    r.tick(tLive + ms - r.deps.now().getTime());
    set(word);
    return (await currentSession(r.auth, r.fixtureId, r.deps))!;
  };

  it("I1 SEQUENCE: live reading connecting, unknown at +5 s, connecting at +20 s — a flip between two NON-ok words is still not receiving, so the warning is due at live+30 s (not 30 s after the flip), and a destination flapping between them stays warned", async () => {
    const r = await rig({ credits: 1 });
    let out: OutputState = "connecting";
    const spy = vi.spyOn(r.ingest, "outputState").mockImplementation(async () => out);
    const set = (w: OutputState) => { out = w; };
    try {
      const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
      await goLive(r);
      const tLive = r.deps.now().getTime();
      expect(destinationWarning(await pollAt(r, tLive, 5_000, "unknown", set)), "live+5 s").toBe(false);
      expect(destinationWarning(await pollAt(r, tLive, 20_000, "connecting", set)), "live+20 s").toBe(false);
      expect(destinationWarning(await pollAt(r, tLive, OUTPUT_WARNING_AFTER_MS - 1, "connecting", set)), "live+29.999 s").toBe(false);
      const due = await pollAt(r, tLive, OUTPUT_WARNING_AFTER_MS, "connecting", set);
      expect(due.output, "since the destination last received — it never has, so since live").toEqual({ state: "connecting", since: iso(new Date(tLive)), elapsedMs: OUTPUT_WARNING_AFTER_MS });
      expect(destinationWarning(due), "live+30 s").toBe(true);
      // Flapping every poll between the two non-ok words: every poll past 30 s warns.
      let flaps = 0;
      for (let ms = OUTPUT_WARNING_AFTER_MS + 5_000; ms <= 2 * OUTPUT_WARNING_AFTER_MS; ms += 5_000) {
        const v = await pollAt(r, tLive, ms, flaps % 2 === 0 ? "unknown" : "connecting", set);
        expect(destinationWarning(v), `flapping, live+${ms / 1000} s`).toBe(true);
        flaps++;
      }
      expect(flaps, "the flapping leg ran").toBe(OUTPUT_WARNING_AFTER_MS / 5_000);
      // The flips were really recorded (Ruling 13), so the boundary had words to mis-read: live, +5, +20, then every flap.
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${sessionId} and type = 'ingest_status'`;
      expect(n).toBe(3 + flaps);
    } finally {
      spy.mockRestore();
    }
  });

  it("I1 pair: an ok DOES reset the clock — live connecting, ok at +10 s, unknown at +15 s, connecting at +20 s: no warning at live+30 s; due 30 s after the destination stopped receiving (+15 s)", async () => {
    const r = await rig({ credits: 1 });
    let out: OutputState = "connecting";
    const spy = vi.spyOn(r.ingest, "outputState").mockImplementation(async () => out);
    const set = (w: OutputState) => { out = w; };
    try {
      await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
      await goLive(r);
      const tLive = r.deps.now().getTime();
      const STOPPED = 15_000;
      expect(destinationWarning(await pollAt(r, tLive, 10_000, "ok", set)), "receiving").toBe(false);
      expect(destinationWarning(await pollAt(r, tLive, STOPPED, "unknown", set)), "live+15 s").toBe(false);
      expect(destinationWarning(await pollAt(r, tLive, 20_000, "connecting", set)), "live+20 s").toBe(false);
      const at30 = await pollAt(r, tLive, OUTPUT_WARNING_AFTER_MS, "connecting", set);
      expect(destinationWarning(at30), "live+30 s: it received at +10 s, so not yet").toBe(false);
      expect(destinationWarning(await pollAt(r, tLive, STOPPED + OUTPUT_WARNING_AFTER_MS - 1, "connecting", set)), "stopped+29.999 s").toBe(false);
      const due = await pollAt(r, tLive, STOPPED + OUTPUT_WARNING_AFTER_MS, "connecting", set);
      expect(due.output).toEqual({ state: "connecting", since: iso(new Date(tLive + STOPPED)), elapsedMs: OUTPUT_WARNING_AFTER_MS });
      expect(destinationWarning(due), "stopped+30 s").toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  // I-2a (controller ruling 2026-10-01, B5 re-review 2 §3): the destination is not fed while the phone is silent, so when
  // the phone RETURNS Cloudflare has to re-dial it. The hold's clock therefore restarts at the phone's latest reconnect,
  // exactly as it starts at live_at (review #9): `since` = the latest of (the not-receiving period's start, live_at, the
  // last ingest reconnect). The PHONE box's timing is unchanged — during a drop the last connect predates it — and the
  // KEY box needs 30 s of the phone sending with the destination still not receiving. Every instant below is live + an
  // offset of the scenario's own and OUTPUT_WARNING_AFTER_MS; `d3Warning` reads the server's answer, the real consumer.
  /** The fake's one scripted seam for the phone: `setState` on the session's live input (in-process only). */
  const phoneOf = async (r: Rig, sessionId: string) => {
    const [inp] = await sql<{ ingest_input_id: string }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${sessionId}`;
    return (s: "connected" | "disconnected") => r.ingest.setState(inp!.ingest_input_id, s);
  };

  it("I-2a SEQUENCE on the server's clock: dialling from live, the phone drops at +5 s → the PHONE box at live+30 s; it returns at +50 s → no box at once nor at return+29.999 s, the KEY box at return+30 s; a second drop keeps the return's clock; a second return restarts it", async () => {
    const r = await rig({ credits: 1 });
    let out: OutputState = "connecting";
    const spy = vi.spyOn(r.ingest, "outputState").mockImplementation(async () => out);
    const set = (w: OutputState) => { out = w; };
    const W = OUTPUT_WARNING_AFTER_MS;
    try {
      const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
      await goLive(r);
      const tLive = r.deps.now().getTime();
      const phone = await phoneOf(r, sessionId);
      const DROP = 5_000;
      const BACK = 50_000;
      phone("disconnected");
      expect(d3Warning(await pollAt(r, tLive, DROP, "connecting", set)), "the drop, inside the hold").toBeNull();
      expect(d3Warning(await pollAt(r, tLive, W - 1, "connecting", set)), "live+29.999 s").toBeNull();
      const silent = await pollAt(r, tLive, W, "connecting", set);
      expect(silent.ingest?.state, "PREMISE: the phone really is silent on the server's read").toBe("disconnected");
      expect(silent.output, "the drop did not move the clock: since live").toEqual({ state: "connecting", since: iso(new Date(tLive)), elapsedMs: W });
      expect(d3Warning(silent), "live+30 s, phone silent").toBe("phone");
      // THE PHONE RETURNS while the destination still dials.
      phone("connected");
      const back = await pollAt(r, tLive, BACK, "connecting", set);
      expect(back.ingest?.state, "PREMISE: the phone is back on the server's read").toBe("connected");
      expect(back.output, "the hold restarts at the return").toEqual({ state: "connecting", since: iso(new Date(tLive + BACK)), elapsedMs: 0 });
      expect(d3Warning(back), "no key box at once").toBeNull();
      expect(d3Warning(await pollAt(r, tLive, BACK + W - 1, "connecting", set)), "return+29.999 s").toBeNull();
      const due = await pollAt(r, tLive, BACK + W, "connecting", set);
      expect(due.output).toEqual({ state: "connecting", since: iso(new Date(tLive + BACK)), elapsedMs: W });
      expect(d3Warning(due), "return+30 s, the phone sending: the key box").toBe("destination");
      // A SECOND drop keeps the return's clock (the last connect predates it): the box flips to the phone at once.
      phone("disconnected");
      const again = await pollAt(r, tLive, BACK + W + 5_000, "connecting", set);
      expect(again.output!.since, "a drop never moves the clock").toBe(iso(new Date(tLive + BACK)));
      expect(d3Warning(again), "second drop, past the hold since the return").toBe("phone");
      // …and a SECOND return restarts it again.
      phone("connected");
      const RETURN2 = BACK + W + 10_000;
      const back2 = await pollAt(r, tLive, RETURN2, "connecting", set);
      expect(back2.output).toEqual({ state: "connecting", since: iso(new Date(tLive + RETURN2)), elapsedMs: 0 });
      expect(d3Warning(back2), "second return: no box at once").toBeNull();
      expect(d3Warning(await pollAt(r, tLive, RETURN2 + W, "connecting", set)), "second return+30 s").toBe("destination");
      // The scenario really had its boundaries on record (Ruling 13): live, drop, return, drop, return.
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${sessionId} and type = 'ingest_status'`;
      expect(n).toBe(5);
    } finally {
      spy.mockRestore();
    }
  });

  it("I-2a pair: a SHORT drop whose re-dial crosses 30 s from the stop — receiving, the phone drops at +10 s, the destination stops at +15 s, the phone returns at +25 s: no key box at +45 s (mid-re-dial), the key box at return+30 s; and an ok destination's since ignores the return", async () => {
    const r = await rig({ credits: 1 });
    let out: OutputState = "ok";
    const spy = vi.spyOn(r.ingest, "outputState").mockImplementation(async () => out);
    const set = (w: OutputState) => { out = w; };
    const W = OUTPUT_WARNING_AFTER_MS;
    try {
      const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
      await goLive(r);
      const tLive = r.deps.now().getTime();
      const phone = await phoneOf(r, sessionId);
      // ok's own since, across a drop and a return that never stopped it receiving: the clamp is the HOLD's only.
      expect((await pollAt(r, tLive, 2_000, "ok", set)).output).toEqual({ state: "ok", since: iso(new Date(tLive)), elapsedMs: 2_000 });
      phone("disconnected");
      expect((await pollAt(r, tLive, 4_000, "ok", set)).output!.since, "ok across a drop").toBe(iso(new Date(tLive)));
      phone("connected");
      expect((await pollAt(r, tLive, 6_000, "ok", set)).output!.since, "ok across a return: not clamped to it").toBe(iso(new Date(tLive)));
      const STOP = 15_000;
      const BACK = 25_000;
      phone("disconnected");
      expect(d3Warning(await pollAt(r, tLive, 10_000, "ok", set)), "dropped, still receiving").toBeNull();
      expect(d3Warning(await pollAt(r, tLive, STOP, "connecting", set)), "the destination stops").toBeNull();
      phone("connected");
      expect((await pollAt(r, tLive, BACK, "connecting", set)).output, "the return restarts the hold").toEqual({ state: "connecting", since: iso(new Date(tLive + BACK)), elapsedMs: 0 });
      const midRedial = await pollAt(r, tLive, STOP + W, "connecting", set);
      expect(midRedial.output!.elapsedMs, "30 s from the stop is 20 s from the return").toBe(STOP + W - BACK);
      expect(d3Warning(midRedial), "stop+30 s, mid-re-dial: no key box").toBeNull();
      expect(d3Warning(await pollAt(r, tLive, BACK + W, "connecting", set)), "return+30 s").toBe("destination");
    } finally {
      spy.mockRestore();
    }
  });

  // m-a (B5 re-review 3; MC4 survived): the clamp's reconnect is an event INTO `connected` — not any event that is not
  // FROM connected. While the phone is silent, a destination flipping between two non-ok words records events from
  // `disconnected` to `disconnected` (Cloudflare's output reads `unknown` without inbound video, so a drop produces
  // exactly that flip). Read as a reconnect, each flip would push the PHONE box back by up to 30 s.
  it("m-a: the phone silent from +5 s while the destination flips connecting → unknown → connecting: the flips are not reconnects — since stays at live, and the PHONE box shows at live+30 s", async () => {
    const r = await rig({ credits: 1 });
    let out: OutputState = "connecting";
    const spy = vi.spyOn(r.ingest, "outputState").mockImplementation(async () => out);
    const set = (w: OutputState) => { out = w; };
    const W = OUTPUT_WARNING_AFTER_MS;
    try {
      const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
      await goLive(r);
      const tLive = r.deps.now().getTime();
      const phone = await phoneOf(r, sessionId);
      phone("disconnected");
      expect(d3Warning(await pollAt(r, tLive, 5_000, "connecting", set)), "the drop").toBeNull();
      expect(d3Warning(await pollAt(r, tLive, 15_000, "unknown", set)), "a flip while silent").toBeNull();
      expect(d3Warning(await pollAt(r, tLive, 20_000, "connecting", set)), "and back").toBeNull();
      const [{ flips }] = await sql<{ flips: number }[]>`
        select count(*)::int as flips from fixture_stream_events
         where session_id = ${sessionId} and type = 'ingest_status' and from_state = 'disconnected' and to_state = 'disconnected'`;
      expect(flips, "PREMISE: the flips were recorded as silent-to-silent events").toBe(2);
      const due = await pollAt(r, tLive, W, "connecting", set);
      expect(due.output, "no reconnect happened: since is still live").toEqual({ state: "connecting", since: iso(new Date(tLive)), elapsedMs: W });
      expect(d3Warning(due), "live+30 s: the phone box, on time").toBe("phone");
    } finally {
      spy.mockRestore();
    }
  });

  // m-b (B5 re-review 3; MWL survived): why a failed outputs read is `null` rather than a throw. Both reads share one try
  // (N1), so a throw would null the PHONE's read too, and warming → live is decided on the phone's read — a token without
  // the outputs scope would never go live. The null path keeps the phone's read deciding go-live on its own.
  it("m-b: warming → live with EVERY outputs read failing (null): the phone's read alone takes the session live, the projection answers no output, and no poll sample or event is written", async () => {
    const r = await rig({ credits: 1 });
    // The port's NOT READ (`null`); the fake's own signature is the narrower OutputState, hence the cast (as in m-2).
    const spy = vi.spyOn(r.ingest, "outputState").mockResolvedValue(null as unknown as OutputState);
    try {
      const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
      const early = (await currentSession(r.auth, r.fixtureId, r.deps))!;
      expect(early.state, "PREMISE: not live before the phone connects").not.toBe("live");
      r.tick(3000);
      const live = (await currentSession(r.auth, r.fixtureId, r.deps))!;
      expect(spy, "PREMISE: the failed read really ran").toHaveBeenCalled();
      expect(live.state, "the phone connected: live, without any output read").toBe("live");
      expect(live.ingest?.state).toBe("connected");
      expect(live.output, "nothing read, nothing answered").toBeNull();
      const [{ samples }] = await sql<{ samples: number }[]>`select count(*)::int as samples from fixture_stream_samples where session_id = ${sessionId} and source = 'poll'`;
      const [{ events }] = await sql<{ events: number }[]>`select count(*)::int as events from fixture_stream_events where session_id = ${sessionId} and type = 'ingest_status'`;
      expect({ samples, events }).toEqual({ samples: 0, events: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  // m-2 (B5 re-review 2 §4a): a FAILED outputs read — Cloudflare's failed envelope, or no result — is not evidence. The
  // port answers it with `null` (ports.ts), and the poll SKIPS it: no sample, no event, no output on the projection. It
  // used to be read as `unknown`, a non-ok word, so six failed polls on a healthy stream put the key box on screen.
  it("m-2: failed outputs reads on a receiving stream record nothing and move nothing — no `unknown` sample, no event, no output on the projection, the phone still read — and the hold starts at the destination's real stop, not the first failure", async () => {
    const r = await rig({ credits: 1 });
    let out: OutputState | null = "ok";
    const spy = vi.spyOn(r.ingest, "outputState").mockImplementation(async () => out as OutputState);
    const W = OUTPUT_WARNING_AFTER_MS;
    try {
      const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
      await goLive(r);
      const tLive = r.deps.now().getTime();
      const at = async (ms: number, w: OutputState | null) => {
        r.tick(tLive + ms - r.deps.now().getTime());
        out = w;
        return (await currentSession(r.auth, r.fixtureId, r.deps))!;
      };
      const counts = async () => {
        const [s] = await sql<{ n: number; unknown: number }[]>`
          select count(*)::int as n, count(*) filter (where output_state = 'unknown')::int as unknown
            from fixture_stream_samples where session_id = ${sessionId} and source = 'poll'`;
        const [e] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${sessionId} and type = 'ingest_status'`;
        return { samples: s!.n, unknown: s!.unknown, events: e!.n };
      };
      expect((await at(5_000, "ok")).output!.state).toBe("ok");
      const before = await counts();
      expect(before.samples, "PREMISE: the receiving polls were sampled").toBeGreaterThan(0);
      let failed = 0;
      for (let ms = 10_000; ms <= 40_000; ms += 5_000) {
        const v = await at(ms, null);
        expect(v.output, `+${ms / 1000} s: no output read, no output answered`).toBeNull();
        expect(v.ingest?.state, `+${ms / 1000} s: the phone's read still stands`).toBe("connected");
        expect(d3Warning(v), `+${ms / 1000} s`).toBeNull();
        failed++;
      }
      expect(failed, "the failing leg ran past the hold").toBe(7);
      expect(await counts(), "nothing recorded for a read that failed").toEqual(before);
      // Reads resume: the destination really is still receiving, and its since never moved.
      expect((await at(45_000, "ok")).output).toEqual({ state: "ok", since: iso(new Date(tLive)), elapsedMs: 45_000 });
      // …and when it really stops, the hold counts from THAT, not from the first failure (+10 s).
      const STOP = 50_000;
      await at(STOP - 2_000, null);
      expect((await at(STOP, "connecting")).output).toEqual({ state: "connecting", since: iso(new Date(tLive + STOP)), elapsedMs: 0 });
      expect(d3Warning(await at(STOP + W - 1, "connecting")), "stop+29.999 s").toBeNull();
      expect(d3Warning(await at(STOP + W, "connecting")), "stop+30 s").toBe("destination");
      expect((await counts()).unknown, "never an `unknown` sample").toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  // N4 (B2 re-review): `live_at` and the ingest_status events are written on one instance's clock and read under another's,
  // so the boundary can sit a few seconds AHEAD of the server now answering. D3's elapsed is how long the destination
  // has NOT received — a boundary in the future means it has not been not-receiving at all yet: 0, never negative (and
  // the published contract is `nonnegative()`). Both sources of `since` are driven: the live clamp (`live_at` written
  // ahead), and the event (written on a clock that then answers from behind it — events are append-only).
  it("N4: a boundary AHEAD of this server's clock (another instance's skew) answers elapsedMs 0 — never negative — with since unchanged and no warning; the positive pair: once this clock passes it, elapsed counts up from it", async () => {
    const SKEW_MS = 5_000;
    let checked = 0;
    for (const source of ["live_at", "event"] as const) {
      const r = await rig({ credits: 1 });
      let out: OutputState = "connecting";
      const spy = vi.spyOn(r.ingest, "outputState").mockImplementation(async () => out);
      try {
        const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
        await goLive(r);
        let boundary: number;
        if (source === "live_at") {
          boundary = r.deps.now().getTime() + SKEW_MS;
          await sql`update fixture_stream_sessions set live_at = live_at + ${`${SKEW_MS} milliseconds`}::interval where id = ${sessionId}`;
        } else {
          r.tick(10_000);
          out = "ok";
          boundary = r.deps.now().getTime();
          expect((await currentSession(r.auth, r.fixtureId, r.deps))!.output, "the ok event is written here").toEqual({ state: "ok", since: iso(new Date(boundary)), elapsedMs: 0 });
          r.tick(-SKEW_MS);
        }
        const word = source === "live_at" ? "connecting" : "ok";
        const ahead = (await currentSession(r.auth, r.fixtureId, r.deps))!;
        expect(ahead.output, source).toEqual({ state: word, since: iso(new Date(boundary)), elapsedMs: 0 });
        expect(destinationWarning(ahead), source).toBe(false);
        r.tick(SKEW_MS + 1_000);
        expect((await currentSession(r.auth, r.fixtureId, r.deps))!.output, `${source}: past it`).toEqual({ state: word, since: iso(new Date(boundary)), elapsedMs: 1_000 });
      } finally {
        spy.mockRestore();
      }
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("output is null for a composed session (warming and live), and for a passthrough session once it has ended", async () => {
    const composed = await rig({ credits: 1 });
    const c = await createSession(composed.auth, composed.fixtureId, body(composed.target.id, "composed"), composed.deps);
    const cWarming = (await currentSession(composed.auth, composed.fixtureId, composed.deps))!;
    expect(cWarming.state).toBe("warming");
    expect(cWarming.output).toBeNull();
    await heartbeat(c.sessionId, composed.runner.created[0]!.jobToken, { state: "playing" }, composed.deps);
    const cLive = (await currentSession(composed.auth, composed.fixtureId, composed.deps))!;
    expect(cLive.state).toBe("live");
    expect(cLive.output).toBeNull();
    const ended = await rig({ credits: 1 });
    const e = await createSession(ended.auth, ended.fixtureId, body(ended.target.id), ended.deps);
    await goLive(ended);
    expect((await currentSession(ended.auth, ended.fixtureId, ended.deps))!.output, "the positive twin").toEqual({ state: "ok", since: expect.any(String), elapsedMs: 0 });
    const stopped = await stopSession(ended.auth, ended.fixtureId, e.sessionId, ended.deps);
    expect(stopped.state).toBe("completed");
    expect(stopped.output, "the Stop route's projection").toBeNull();
    const view = (await currentSession(ended.auth, ended.fixtureId, ended.deps))!;
    expect(view.state).toBe("completed");
    expect(view.output).toBeNull();
  });

  it("spec §5.7: every per-session provider call records its session id — add_output, the poll's inputStatus + outputState, the expiry's pre-read, and releaseOutput's removeOutput", async () => {
    const PER_SESSION = ["inputStatus", "addOutput", "outputState", "removeOutput"] as const;
    // Leg 1, the golden path: create (addOutput), a warming poll, live, Stop (removeOutput).
    const rec = new FakeRecorder();
    const r = await rig({ credits: 1, recorder: rec });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    await currentSession(r.auth, r.fixtureId, r.deps);
    await goLive(r);
    await stopSession(r.auth, r.fixtureId, sessionId, r.deps);
    await flush();
    const rows = rec.calls.filter((c) => (PER_SESSION as readonly string[]).includes(c.operation));
    expect(new Set(rows.map((c) => c.operation)), "every one of the four was reached").toEqual(new Set(PER_SESSION));
    let checked = 0;
    for (const c of rows) {
      expect(c.sessionId, `${c.operation} #${checked}`).toBe(sessionId);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(PER_SESSION.length);
    expect(rows.filter((c) => c.operation === "removeOutput")).toHaveLength(1);
    // Leg 2, the expiry's pre-read (observeIngestBeforeExpiry): a warming session nobody polled, past its timeout. Its
    // ONLY inputStatus is that pre-read — the poll never runs, because the reconcile ends the session first.
    const rec2 = new FakeRecorder();
    const x = await rig({ credits: 1, recorder: rec2, connectAfterMs: 24 * 3600_000 });
    const made = await createSession(x.auth, x.fixtureId, body(x.target.id), x.deps);
    await sql`update fixture_stream_sessions set created_at = now() - make_interval(mins => ${WARMING_TIMEOUT_MINUTES + 1}) where id = ${made.sessionId}`;
    expect((await currentSession(x.auth, x.fixtureId, x.deps))!).toMatchObject({ state: "failed", failReason: "no_inbound_timeout" });
    await flush();
    const pre = rec2.calls.filter((c) => c.operation === "inputStatus");
    expect(pre, "the expiry's pre-read, alone").toHaveLength(1);
    expect(pre[0]!.sessionId).toBe(made.sessionId);
    const released = rec2.calls.filter((c) => c.operation === "removeOutput");
    expect(released, "the failure releases the output too").toHaveLength(1);
    expect(released[0]!.sessionId).toBe(made.sessionId);
  });
});

// B2 carried (B1 review): Go live on a destination whose saved key will not open (a KEK change, a damaged byte) was an
// unmapped 500 out of the admission transaction. It is a clean refusal the organiser can act on — and, being inside that
// transaction, it spends nothing and leaves no row.
describe.skipIf(!HAS_DB)("Go live on an UNREADABLE destination key", () => {
  it("is 422 TARGET_UNREADABLE telling the organiser to replace the key — no session row, ZERO provider calls of any kind (M1), and the money unmoved even after the clock runs past go-live (M2); Replace key then recovers it and Go live starts (sequence)", async () => {
    const rec = new FakeRecorder();
    const r = await rig({ credits: 1, recorder: rec });
    const targetId = await rigTarget(r.auth.orgId, "Unreadable", "youtube");   // the boundary's own rig: an envelope that will not open
    const money = async () => ({
      balance: await creditBalance(sql, r.auth.orgId),
      ledger: (await sql<{ n: number; net: number }[]>`
        select count(*)::int as n, coalesce(sum(delta), 0)::int as net from org_stream_credits where org_id = ${r.auth.orgId}`)[0],
    });
    const before = await money();
    expect(before.balance, "the rig's credit is there to be spent — or 'unmoved' could not fail").toBe(1);
    // Both drivers report into ONE recorder for the refused attempt, so "zero provider calls" covers Cloudflare AND Fly.
    const refusedDeps: SessionDeps = { ...r.deps, drivers: { ...r.deps.drivers, runner: new FakeRunner({ recorder: rec }) } };
    const warns: unknown[][] = [];
    const spy = vi.spyOn(log, "warn").mockImplementation(((...args: unknown[]) => { warns.push(args); }) as never);
    let err: unknown;
    try {
      err = await createSession(r.auth, r.fixtureId, body(targetId), refusedDeps).then(() => null, (e: unknown) => e);
    } finally {
      spy.mockRestore();
    }
    // M2: run the clock past the fake's connect (3 s) and poll, THEN read the money. A refusal placed anywhere that let the
    // start through would have gone live and consumed by now — this is the assertion that can fail.
    r.tick(3000);
    const projected = await currentSession(r.auth, r.fixtureId, refusedDeps);
    expect(await money(), "no credit spent and no ledger row, past the moment a start would have gone live").toEqual(before);
    expect(projected, "nothing to project").toBeNull();
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 422, code: TARGET_UNREADABLE });
    expect((err as Error).message).toMatch(/replace the key/i);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where org_id = ${r.auth.orgId}`;
    expect(n, "no session row, in any state").toBe(0);
    await new Promise((res) => setImmediate(res));
    expect(rec.calls.map((c) => c.operation), "M1: no provider call of any kind — not even the read-only storage read").toEqual([]);
    expect(r.runner.created).toEqual([]);
    // The operator's side: one warn naming the fixture and target, never a key.
    expect(warns.filter(([o]) => (o as { targetId?: string }).targetId === targetId).map(([o]) => o)).toEqual([{ fixtureId: r.fixtureId, targetId, kind: "youtube" }]);
    // The organiser's remedy works: Replace key re-seals the platform row, and the same Go live now starts.
    await patchStreamTarget(r.auth, r.auth.orgId, targetId, { streamKey: `k-${randomUUID()}` });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(targetId), r.deps);
    expect((await r.row(sessionId)).state).toBe("warming");
    // The positive pair of M1's zero: a start that IS admitted reads the storage pool (so the zero above was not a
    // recorder that sees nothing).
    await new Promise((res) => setImmediate(res));
    expect(rec.calls.map((c) => c.operation)).toContain("storageUsage");
  });

  it("M1 guard: the early probe answers only for this org's ACTIVE row — an archived unreadable destination is still 404 target_not_found, another org's is 404 too, and neither is read", async () => {
    const r = await rig({ credits: 1 });
    const archived = await rigTarget(r.auth.orgId, "Gone", "youtube");
    await sql.begin((tx) => archiveStreamTarget(tx, r.auth.orgId, archived));
    const other = await rig({ credits: 1 });
    const foreign = await rigTarget(other.auth.orgId, "Theirs", "youtube");
    let checked = 0;
    for (const targetId of [archived, foreign]) {
      const err = await createSession(r.auth, r.fixtureId, body(targetId), r.deps).then(() => null, (e: unknown) => e);
      expect(err, targetId === archived ? "archived" : "another org's").toMatchObject({ status: 404 });
      expect((err as HttpError).code, "never the unreadable refusal: that would confirm the row exists").not.toBe(TARGET_UNREADABLE);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("N2 (B2 re-review): the probe steps aside for EVERY admit refusal it can weigh, not only active_session — a 0-credit org Go live on an unreadable key is 402 no_credits (F-A5: the credit before any destination question), measured like every refused admission (one storage read, ruling 13); a credit then makes the same Go live the 422", async () => {
    const rec = new FakeRecorder();
    const r = await rig({ credits: 0, recorder: rec });
    expect(await creditBalance(sql, r.auth.orgId), "the rig really is broke — or 402 could not be the answer").toBe(0);
    const targetId = await rigTarget(r.auth.orgId, "Unreadable", "youtube");
    const refusedDeps: SessionDeps = { ...r.deps, drivers: { ...r.deps.drivers, runner: new FakeRunner({ recorder: rec }) } };
    const err = await createSession(r.auth, r.fixtureId, body(targetId), refusedDeps).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err, "the credit is answered first, never 'replace the key'").toMatchObject({ status: 402, code: "no_credits" });
    await new Promise((res) => setImmediate(res));
    expect(rec.calls.map((c) => c.operation), "the admission answered it: exactly its one read-only storage read, nothing started").toEqual(["storageUsage"]);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where org_id = ${r.auth.orgId}`;
    expect(n).toBe(0);
    // The positive pair: with a credit, the SAME Go live reaches the probe and is the unreadable refusal, before any read.
    await grantCredits({ orgId: r.auth.orgId, delta: 1, createdBy: await rigUser(), note: "unit", idempotencyKey: randomUUID() });
    rec.calls.length = 0;
    const paid = await createSession(r.auth, r.fixtureId, body(targetId), refusedDeps).then(() => null, (e: unknown) => e);
    expect(paid).toMatchObject({ status: 422, code: TARGET_UNREADABLE });
    await new Promise((res) => setImmediate(res));
    expect(rec.calls.map((c) => c.operation)).toEqual([]);
  });

  it("M3: a MISSING or MALFORMED RELAY_KEK is the deployment's fault, never the organiser's — Go live is a 500 (not an HttpError), never 422 TARGET_UNREADABLE, and writes nothing", async () => {
    const r = await rig({ credits: 1 });
    const saved = process.env.RELAY_KEK;
    let checked = 0;
    try {
      for (const kek of [undefined, "not-hex"] as const) {
        if (kek === undefined) delete process.env.RELAY_KEK;
        else process.env.RELAY_KEK = kek;
        const err = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps).then(() => null, (e: unknown) => e);
        expect(err, `KEK ${kek ?? "unset"}`).toBeInstanceOf(Error);
        expect(err, `KEK ${kek ?? "unset"}: an HttpError would be answered as the organiser's fault`).not.toBeInstanceOf(HttpError);
        expect((err as Error).message).toMatch(/RELAY_KEK/);
        checked++;
      }
    } finally {
      process.env.RELAY_KEK = saved;
    }
    expect(checked).toBe(2);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where org_id = ${r.auth.orgId}`;
    expect(n).toBe(0);
    // The positive pair: with the KEK back, the same readable target starts.
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    expect((await r.row(sessionId)).state).toBe("warming");
  });

  it("a LEGACY-kind row (no platform preset to re-seal on) says REMOVE it — never 'add it again', which create no longer allows for its kind (M4) — the same code", async () => {
    const r = await rig({ credits: 1 });
    const targetId = await rigTarget(r.auth.orgId, "Old", "custom_rtmp");
    const err = await createSession(r.auth, r.fixtureId, body(targetId), r.deps).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: TARGET_UNREADABLE });
    expect((err as Error).message).toMatch(/remove it/i);
    expect((err as Error).message, "M4: a legacy kind cannot be added again").not.toMatch(/add it again|re-?add/i);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where org_id = ${r.auth.orgId}`;
    expect(n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The DESTINATION lifecycle as a SEQUENCE (TEST-STRATEGY rules 1, 2, 10; owner-raised on B2 fix round 1). B1 and B2 drove
// add / Replace key / Remove / Go live / Stop one ordering at a time. Here fast-check draws the orderings — across TWO orgs
// (each with two fixtures), both platforms, a target whose saved key will not open, a waiting session left past its
// deadline, and a voided holder fixture — and a plain MODEL predicts every outcome. Expected values come from the model
// and the spec (§5.2 create order / Replace key / Remove / "held means", §5.3 list shape, D2, D6 via the platform
// presets), never from the code under test: the system is only ever asked to AGREE. Invariants after EVERY step:
//   - at most one ACTIVE session holds a target, and every session holds a target of its own org;
//   - each org's list is exactly its model's un-archived targets (label, key hint, and the holding match), so an
//     archived target never appears and the other org never sees one;
//   - archived flags and owners in the table match the model;
//   - every refusal spends no credit and makes no provider call (beyond the lazy expiry of a session the door ended).
// Remove and Replace key are refused IFF a live or waiting match holds the target, naming its matchNo; re-adding a
// removed key restores the SAME id; Go live can never take an archived or foreign target.
// Sport-agnostic (rule 6): nothing here reads the sport. Rule 6's analogue is the PLATFORM — both are drawn.
// ---------------------------------------------------------------------------
type DestOrg = 0 | 1;
type DestPlatform = "youtube" | "twitch";
type DestCmd =
  | { kind: "add"; org: DestOrg; platform: DestPlatform; key: number; label: number }
  | { kind: "replace"; org: DestOrg; slot: number; key: number }
  | { kind: "remove"; org: DestOrg; slot: number }
  | { kind: "goLive"; org: DestOrg; fixture: 0 | 1; slot: number }
  | { kind: "connect"; org: DestOrg; fixture: 0 | 1 }
  | { kind: "age"; org: DestOrg; fixture: 0 | 1 }
  | { kind: "stop"; org: DestOrg; fixture: 0 | 1 }
  | { kind: "void"; org: DestOrg; fixture: 0 | 1 };

/** The key pool. "yt-key" is the rig's own saved key (both orgs'), and it is shorter than a hint needs; the other two are
 *  long enough to show one. The same key on the OTHER platform is a different destination (D6: the url is per platform). */
const DEST_KEYS = ["yt-key", "stream-key-aaaa-1", "stream-key-bbbb-2"] as const;
const DEST_LABELS = ["Court 1", "Court 2"] as const;
/** Drawn sequences per run (the pinned examples count inside it). Each run seeds two orgs, four fixtures, three targets. */
const DEST_MODEL_RUNS = 100;
/** A fixed seed: the scoped run is reproducible, and a red names a sequence anyone can replay. */
const DEST_MODEL_SEED = 20260930;

const destOrgArb = fc.oneof({ weight: 3, arbitrary: fc.constant<DestOrg>(0) }, { weight: 1, arbitrary: fc.constant<DestOrg>(1) });
const destFixtureArb = fc.constantFrom<0 | 1>(0, 1);
const destSlotArb = fc.nat({ max: 7 });
const destKeyArb = fc.nat({ max: DEST_KEYS.length - 1 });
const destCmdArb: fc.Arbitrary<DestCmd> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("add" as const), org: destOrgArb, platform: fc.constantFrom<DestPlatform>("youtube", "twitch"), key: destKeyArb, label: fc.nat({ max: DEST_LABELS.length - 1 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("replace" as const), org: destOrgArb, slot: destSlotArb, key: destKeyArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("remove" as const), org: destOrgArb, slot: destSlotArb }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("goLive" as const), org: destOrgArb, fixture: destFixtureArb, slot: destSlotArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("connect" as const), org: destOrgArb, fixture: destFixtureArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("age" as const), org: destOrgArb, fixture: destFixtureArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("stop" as const), org: destOrgArb, fixture: destFixtureArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("void" as const), org: destOrgArb, fixture: destFixtureArb }) },
);

/** Two orderings every run reaches whatever the seed draws (anti-vacuity: each invariant below is otherwise satisfiable by
 *  a sequence that never holds, restores, voids or crosses an org). Slots: 0 = org 0's rig target ("Club", youtube,
 *  yt-key), 1 = org 0's UNREADABLE youtube target, 2 = org 1's rig target (the same key, another org); later adds append. */
const DEST_PINNED: DestCmd[][] = [
  [
    { kind: "goLive", org: 0, fixture: 0, slot: 0 },
    { kind: "remove", org: 0, slot: 0 },                  // held WAITING → 409 naming match 0's number
    { kind: "connect", org: 0, fixture: 0 },
    { kind: "replace", org: 0, slot: 0, key: 1 },         // held LIVE → 409
    { kind: "void", org: 0, fixture: 0 },
    { kind: "remove", org: 0, slot: 0 },                  // a void does not release the destination: still 409
    { kind: "stop", org: 0, fixture: 0 },
    { kind: "remove", org: 0, slot: 0 },                  // released → archived
    { kind: "goLive", org: 0, fixture: 1, slot: 0 },      // an archived target cannot be taken → 404
    { kind: "add", org: 0, platform: "youtube", key: 0, label: 1 },   // the same key again → the SAME id, restored
    { kind: "goLive", org: 1, fixture: 0, slot: 0 },      // the other org → 404
    { kind: "remove", org: 1, slot: 0 },                  // the other org → 404
  ],
  [
    { kind: "goLive", org: 0, fixture: 0, slot: 1 },      // unreadable → 422 TARGET_UNREADABLE
    { kind: "replace", org: 0, slot: 1, key: 1 },         // Replace key recovers it in place
    { kind: "add", org: 0, platform: "twitch", key: 1, label: 0 },    // the same key on the other platform → a NEW target
    { kind: "add", org: 0, platform: "youtube", key: 1, label: 0 },   // → the recovered row, unchanged
    { kind: "replace", org: 0, slot: 0, key: 1 },         // another active row holds it → 409 DESTINATION_DUPLICATE
    { kind: "goLive", org: 0, fixture: 0, slot: 1 },
    { kind: "age", org: 0, fixture: 0 },                  // waiting, past its deadline
    { kind: "goLive", org: 0, fixture: 1, slot: 1 },      // the start IS the tick: the stale holder expires, this one starts
    { kind: "replace", org: 1, slot: 1, key: 2 },         // the other org → 404
    { kind: "add", org: 1, platform: "youtube", key: 1, label: 0 },   // the other org's own row, never ours
    { kind: "goLive", org: 0, fixture: 0, slot: 1 },      // held by fixture 1, WAITING → 409 target_in_use naming it
  ],
];

/** Named regression cases (rule 10): each is the SHRUNK counterexample a seeded run found, committed before its fix. */
/** Seed 20260930, path "0:1:0:0:0": the other org's Go live on this org's destination is 404 — and took the admission's
 *  storage read. NOT a system defect: `createSession` records a storage snapshot for each admission check (ruling 13,
 *  streaming-r1 plan "Data captured"), a refusal included, pinned by the SAMPLES and SNAPSHOTS test. The invariant was
 *  worded too wide ("no provider call" → "none but the admission's own measurement"); this sequence keeps it honest. */
const DEST_REGRESSION_ADMISSION_READ: DestCmd[] = [{ kind: "goLive", org: 1, fixture: 0, slot: 0 }, { kind: "remove", org: 1, slot: 0 }];
/** Seed 20260930, path "73:1:0:2:6:5:5" (DEST_MODEL_RUNS = 100): a match already streaming, then Go live on an UNREADABLE
 *  destination, answered 422 TARGET_UNREADABLE — B2 fix round 1's M1 probe ran before `admit`. F-A5 (owner, 2026-09-29):
 *  "a match already streaming answers a second start before credits, destination or storage are weighed" — 409
 *  active_session. A SYSTEM defect, introduced by M1. */
const DEST_REGRESSION_FA5_UNREADABLE: DestCmd[] = [
  { kind: "goLive", org: 0, fixture: 1, slot: 0 },
  { kind: "goLive", org: 0, fixture: 1, slot: 1 },
  { kind: "add", org: 1, platform: "youtube", key: 0, label: 0 },
];
/** NOT a seeded find — the owner's answer B to the B2 re-review's point 6 (2026-09-30): F-A5 over the destination-HOLDER
 *  guard. A stale second tab's Go live on a fixture already LIVE, picking a destination another match holds, is 409
 *  active_session — the holder guard answered target_in_use naming the other match. Once stopped, the same Go live IS
 *  target_in_use naming it. Slot 3 is the org-0 target the `add` appends (the rig seeds slots 0-2). */
const DEST_REGRESSION_FA5_HELD: DestCmd[] = [
  { kind: "goLive", org: 0, fixture: 0, slot: 0 },
  { kind: "connect", org: 0, fixture: 0 },                // fixture 0 is LIVE on slot 0
  { kind: "add", org: 0, platform: "youtube", key: 1, label: 1 },
  { kind: "goLive", org: 0, fixture: 1, slot: 3 },      // fixture 1 holds the new target, waiting
  { kind: "goLive", org: 0, fixture: 0, slot: 3 },      // the stale second Go live → 409 active_session, not target_in_use
  { kind: "stop", org: 0, fixture: 0 },
  { kind: "goLive", org: 0, fixture: 0, slot: 3 },      // now → 409 target_in_use naming fixture 1's match
];

describe.skipIf(!HAS_DB)("the DESTINATION lifecycle as a SEQUENCE — two orgs, both platforms, an unreadable key; a model predicts every step (rule 10)", () => {
  it("no drawn ordering of add, Replace key, Remove, Go live, connect, ageing, Stop and a void breaks: one holder per target, lists = the model, same-id restore, refused iff held (naming the match), no archived or foreign take, and refusals that spend nothing and call no provider", async () => {
    const tally = {
      runs: 0, steps: 0, skipped: 0, checks: 0, refusals: 0,
      targetHoldChecks: 0, listRowsChecked: 0, archivedAbsent: 0, sessionRowsChecked: 0, tableRowsChecked: 0, refusalMoneyChecks: 0, refusalCallChecks: 0,
      heldRemoveRefusals: 0, heldReplaceRefusals: 0, sameIdRestores: 0, existingKept: 0, crossOrgRefusals: 0, archivedTakeRefusals: 0, unreadableRefusals: 0,
      duplicateRefusals: 0, staleExpired: 0, heldAfterVoid: 0, otherPlatformNew: 0, runningOverHeld: 0,
    };
    const seen = new Set<DestCmd["kind"]>();
    await fc.assert(
      fc.asyncProperty(fc.array(destCmdArb, { minLength: 1, maxLength: 12 }), async (cmds) => {
        tally.runs++;
        const rec = new FakeRecorder();
        // No clock connect: a phone connects only when a `connect` step says so (the fake's scripted state).
        const NEVER_MS = 10 * 86_400_000;
        const rigs = [await rig({ credits: 5, fixtures: 2, recorder: rec, connectAfterMs: NEVER_MS }), await rig({ credits: 5, fixtures: 2, recorder: rec, connectAfterMs: NEVER_MS })] as const;
        const deps = rigs.map((r) => ({ ...r.deps, drivers: { ...r.deps.drivers, runner: new FakeRunner({ recorder: rec }) } }) as SessionDeps);
        const orgIds = rigs.map((r) => r.auth.orgId);

        // ---- the model ----------------------------------------------------------------------------------------------
        type MTarget = { id: string; org: DestOrg; platform: DestPlatform; key: string | null; label: string; archived: boolean; archivedAt: number };
        type MSession = { id: string; target: string; status: "waiting" | "live" | "stale" };
        type MFixture = { id: string; no: number; voided: boolean; session: MSession | null };
        const fixtures: MFixture[][] = [];
        for (const r of rigs) {
          const rows = await sql<{ id: string; fixture_no: number }[]>`select id, fixture_no from fixtures where id in ${sql(r.fixtureIds as string[])}`;
          fixtures.push((r.fixtureIds as string[]).map((id) => ({ id, no: rows.find((x) => x.id === id)!.fixture_no, voided: false, session: null })));
        }
        const targets: MTarget[] = [
          { id: rigs[0].target.id, org: 0, platform: "youtube", key: "yt-key", label: "Club", archived: false, archivedAt: 0 },
          { id: await rigTarget(orgIds[0]!, "Unreadable", "youtube"), org: 0, platform: "youtube", key: null, label: "Unreadable", archived: false, archivedAt: 0 },
          { id: rigs[1].target.id, org: 1, platform: "youtube", key: "yt-key", label: "Club", archived: false, archivedAt: 0 },
        ];
        let archiveClock = 0;
        const holderOf = (t: MTarget): MFixture | null => fixtures.flat().find((f) => f.session?.target === t.id) ?? null;
        const holdWord = (s: MSession) => (s.status === "live" ? "live" : "waiting");
        const hintOf = (key: string | null) => (key === null || key.length < KEY_HINT_MIN_LENGTH ? null : key.slice(-KEY_HINT_CHARS));

        // ---- one step: model prediction, the system's answer, agreement ---------------------------------------------
        type Refusal = { status: number; code: string | null; holderNo?: number | null; holderState?: string; otherId?: string };
        const refusalOf = (err: unknown, label: string): Refusal => {
          if (!(err instanceof HttpError) || err.status >= 500) throw new Error(`${label}: escaped with a non-refusal: ${String(err)}`);
          const extra = err.extra as { holder?: { matchNo: number | null; state: string } | null; other?: { id: string } } | undefined;
          return {
            status: err.status, code: err.code ?? null,
            ...(extra?.holder ? { holderNo: extra.holder.matchNo, holderState: extra.holder.state } : {}),
            ...(extra?.other ? { otherId: extra.other.id } : {}),
          };
        };
        const money = async () => Promise.all(orgIds.map(async (o) => (await sql<{ n: number; net: number }[]>`
          select count(*)::int as n, coalesce(sum(delta), 0)::int as net from org_stream_credits where org_id = ${o}`)[0]));
        const flush = () => new Promise((res) => setImmediate(res));

        const step = async (c: DestCmd, label: string): Promise<void> => {
          const o = c.org;
          const auth = rigs[o].auth;
          const orgId = orgIds[o]!;
          const expired = new Set<string>();          // sessions a door ends lazily this step (their provider calls are theirs)
          const expire = (f: MFixture) => { expired.add(f.session!.id); f.session = null; tally.staleExpired++; };
          const t = "slot" in c ? targets[c.slot % targets.length]! : null;
          const fx = "fixture" in c ? fixtures[o]![c.fixture]! : null;
          let expected: Refusal | "ok" = "ok";
          let run: () => Promise<unknown>;
          let onOk: (value: unknown) => void = () => undefined;

          switch (c.kind) {
            case "add": {
              const key = DEST_KEYS[c.key]!;
              const lbl = DEST_LABELS[c.label]!;
              const same = (x: MTarget) => x.org === o && x.platform === c.platform && x.key === key;
              const active = targets.find((x) => same(x) && !x.archived);
              const archived = targets.filter((x) => same(x) && x.archived).sort((a, b) => b.archivedAt - a.archivedAt)[0];
              run = () => createStreamTarget(auth, orgId, { kind: c.platform, label: lbl, streamKey: key });
              onOk = (v) => {
                const { id: got, label: gotLabel, outcome } = v as { id: string; label: string; outcome: string };
                if (active) {
                  expect(got, `${label}: §5.2 create order 1 — the ACTIVE row with this destination`).toBe(active.id);
                  // A19, owner decision (a): nothing is renamed — the model's label stands, and the wire says `existing`.
                  expect(outcome, `${label}: A19 — the already-saved destination is reported as existing`).toBe("existing");
                  expect(gotLabel, `${label}: A19 — the typed name is not applied`).toBe(active.label);
                  tally.existingKept++;
                } else if (archived) {
                  expect(got, `${label}: D2 — re-adding a removed key restores the SAME id`).toBe(archived.id);
                  archived.archived = false;
                  archived.label = lbl;
                  expect(outcome, `${label}: D2 — reported as restored`).toBe("restored");
                  expect(gotLabel, `${label}: D2 — the restore takes the NEWLY typed name`).toBe(archived.label);
                  tally.sameIdRestores++;
                } else {
                  expect(outcome, `${label}: §5.2 create order 3 — reported as inserted`).toBe("inserted");
                  expect(targets.map((x) => x.id), `${label}: §5.2 create order 3 — a NEW row`).not.toContain(got);
                  if (targets.some((x) => x.org === o && x.key === key && x.platform !== c.platform && !x.archived)) tally.otherPlatformNew++;
                  targets.push({ id: got, org: o, platform: c.platform, key, label: lbl, archived: false, archivedAt: 0 });
                }
              };
              break;
            }
            case "replace":
            case "remove": {
              const target = t!;
              // The route's door (stream-targets/[targetId]/route.ts): this org's holders of the target get their lazy expiry first.
              const holder0 = target.org === o ? holderOf(target) : null;
              if (holder0?.session?.status === "stale") expire(holder0);
              const holder = target.org === o ? holderOf(target) : null;
              const newKey = c.kind === "replace" ? DEST_KEYS[c.key]! : null;
              if (target.org !== o || target.archived) expected = { status: 404, code: null };
              else if (holder) expected = { status: 409, code: "TARGET_IN_USE", holderNo: holder.no, holderState: holdWord(holder.session!) };
              else if (c.kind === "replace" && !(target.key !== null && target.key === newKey)) {
                const other = targets.find((x) => x !== target && x.org === o && !x.archived && x.platform === target.platform && x.key === newKey);
                if (other) expected = { status: 409, code: "DESTINATION_DUPLICATE", otherId: other.id };
              }
              run = async () => {
                await expireTargetHolders(orgId, target.id, deps[o]!);
                return c.kind === "remove"
                  ? removeStreamTarget(auth, orgId, target.id)
                  : patchStreamTarget(auth, orgId, target.id, { streamKey: newKey! });
              };
              onOk = () => {
                if (c.kind === "remove") { target.archived = true; target.archivedAt = ++archiveClock; }
                else target.key = newKey;
              };
              if (expected !== "ok" && expected.code === "TARGET_IN_USE") {
                if (c.kind === "remove") tally.heldRemoveRefusals++;
                else tally.heldReplaceRefusals++;
                if (holder!.voided) tally.heldAfterVoid++;
              }
              if (expected !== "ok" && expected.status === 404 && target.org !== o) tally.crossOrgRefusals++;
              if (expected !== "ok" && expected.code === "DESTINATION_DUPLICATE") tally.duplicateRefusals++;
              break;
            }
            case "goLive": {
              if (fx!.voided) { tally.skipped++; return; }   // the spec says nothing of starting a voided match; not drawn
              const target = t!;
              if (fx!.session?.status === "stale") expire(fx!);            // the fixture's own lazy expiry comes first
              // Precedence, from the declarations. F-A5 (owner, 2026-09-29: "a match already streaming answers a second start
              // before credits, destination or storage are weighed"), over the destination-HOLDER guard too (the owner's
              // answer B, 2026-09-30): a fixture still streaming after its own lazy expiry is active_session, and no
              // destination door runs for it — so no other fixture's stale holder is expired either. Otherwise the holder
              // guard (createSession's gap-4 placement, before admission), then `admit`'s order (session.ts, §6.3): the
              // target's existence; and only then the saved key's readability. The rigs never lack the plan or the credit.
              if (!fx!.session && target.org === o) {
                for (const g of fixtures[o]!) if (g !== fx && g.session?.target === target.id && g.session.status === "stale") expire(g);
              }
              const other = target.org === o ? fixtures[o]!.find((g) => g !== fx && g.session?.target === target.id) : undefined;
              if (fx!.session) {
                expected = { status: 409, code: "active_session" };
                if (other) tally.runningOverHeld++;
              } else if (other) expected = { status: 409, code: "target_in_use", holderNo: other.no, holderState: holdWord(other.session!) };
              else if (target.org !== o || target.archived) expected = { status: 404, code: null };
              else if (target.key === null) expected = { status: 422, code: TARGET_UNREADABLE };
              run = () => createSession(auth, fx!.id, body(target.id), deps[o]!);
              onOk = (v) => { fx!.session = { id: (v as { sessionId: string }).sessionId, target: target.id, status: "waiting" }; };
              if (expected !== "ok") {
                if (expected.status === 404 && target.org !== o) tally.crossOrgRefusals++;
                if (expected.status === 404 && target.org === o) tally.archivedTakeRefusals++;
                if (expected.code === TARGET_UNREADABLE) tally.unreadableRefusals++;
              }
              break;
            }
            case "connect": {
              const sess = fx!.session;
              run = async () => {
                if (sess && sess.status !== "live") {
                  const [inp] = await sql<{ ingest_input_id: string }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${sess.id}`;
                  rigs[o].ingest.setState(inp!.ingest_input_id, "connected");
                }
                return currentSession(auth, fx!.id, deps[o]!);
              };
              // A stale waiting session whose phone connects goes LIVE: the expiry's pre-read sees the ingest first (N1).
              onOk = () => { if (sess) sess.status = "live"; };
              break;
            }
            case "age": {
              const sess = fx!.session;
              if (sess?.status !== "waiting") { tally.skipped++; return; }
              run = () => sql`update fixture_stream_sessions set created_at = created_at - make_interval(mins => ${WARMING_TIMEOUT_MINUTES + 5}) where id = ${sess.id}`;
              onOk = () => { sess.status = "stale"; };
              break;
            }
            case "stop": {
              const sess = fx!.session;
              if (!sess) { tally.skipped++; return; }
              run = () => stopSession(auth, fx!.id, sess.id, deps[o]!);
              onOk = () => { fx!.session = null; };
              break;
            }
            case "void": {
              if (fx!.voided) { tally.skipped++; return; }
              run = async () => {
                for (const [type, payload] of [["core.start", {}], ["core.abandon", { reason: "model: void" }]] as const) {
                  await scoreEvent(auth, fx!.id, { expected_seq: (await getFixtureState(auth, fx!.id)).last_seq, type, payload });
                }
              };
              onOk = () => { fx!.voided = true; };
              break;
            }
          }

          const moneyBefore = await money();
          const callsBefore = rec.calls.length;
          let value: unknown = null;
          let err: unknown = null;
          try {
            value = await run!();
          } catch (e) {
            err = e;
          }
          await flush();
          if (expected === "ok") {
            if (err !== null) throw new Error(`${label}: the model expected success; the system refused: ${JSON.stringify(refusalOf(err, label))}`);
            onOk(value);
            return;
          }
          if (err === null) throw new Error(`${label}: the model expected ${JSON.stringify(expected)}; the system succeeded`);
          expect(refusalOf(err, label), `${label}: the refusal`).toEqual(expected);
          tally.refusals++;
          // Every refusal spends nothing (both orgs' ledgers unmoved) and calls no provider — except for a session the
          // door itself ended lazily this step, whose calls carry that session's id or its input's.
          expect(await money(), `${label}: a refusal moved money`).toEqual(moneyBefore);
          tally.refusalMoneyChecks++;
          const inputs = expired.size === 0 ? [] : (await sql<{ ingest_input_id: string }[]>`
            select ingest_input_id from fixture_stream_inputs where session_id in ${sql([...expired])}`).map((x) => x.ingest_input_id);
          const stray = rec.calls.slice(callsBefore).filter((call) => !(call.sessionId != null && expired.has(call.sessionId)) && !(call.subjectId != null && inputs.includes(call.subjectId)));
          // DEST_REGRESSION_ADMISSION_READ below: a refusal FROM `admit` still takes the admission's storage measurement —
          // one read-only storageUsage, no session — and records it (a snapshot per admission check: ruling 13, streaming-r1
          // plan "Data captured"); the SAMPLES and SNAPSHOTS test above and routes.test.ts A21 pin that snapshot. Every other refusal — the holder guard, an unreadable key, and
          // every Directory refusal — asks the provider nothing.
          const fromAdmit = c.kind === "goLive" && (expected.code === "active_session" || expected.status === 404);
          expect(stray.map((call) => `${call.operation}:${call.sessionId ?? "-"}`), `${label}: a refusal called a provider`).toEqual(fromAdmit ? ["storageUsage:-"] : []);
          tally.refusalCallChecks++;
        };

        // ---- invariants after every step ----------------------------------------------------------------------------
        const check = async (after: string) => {
          const active = await sql<{ id: string; org_id: string; fixture_id: string; target_id: string; state: string; target_org: string }[]>`
            select s.id, s.org_id, s.fixture_id, s.target_id, s.state, t.org_id as target_org
              from fixture_stream_sessions s join org_stream_targets t on t.id = s.target_id
             where s.org_id in ${sql(orgIds)} and s.state in ${sql([...ACTIVE_STATES])}`;
          const perTarget = new Map<string, number>();
          for (const x of active) perTarget.set(x.target_id, (perTarget.get(x.target_id) ?? 0) + 1);
          for (const tg of targets) {
            expect(perTarget.get(tg.id) ?? 0, `${after}: more than one ACTIVE session holds ${tg.id}`).toBeLessThanOrEqual(1);
            tally.targetHoldChecks++;
          }
          // §5.3: waiting = requested / provisioning / warming; live = live / ending — the spec's words, not holdStateOf.
          const WAITING_STATES = ["requested", "provisioning", "warming"];
          const want = fixtures.flatMap((fs, oi) => fs.filter((f) => f.session).map((f) => ({ id: f.session!.id, org: orgIds[oi], fixture: f.id, target: f.session!.target, hold: holdWord(f.session!) })));
          const got = active.map((x) => ({ id: x.id, org: x.org_id, fixture: x.fixture_id, target: x.target_id, hold: WAITING_STATES.includes(x.state) ? "waiting" : "live" }));
          const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
          expect(got.sort(byId), `${after}: the ACTIVE sessions are the model's`).toEqual(want.sort(byId));
          for (const x of active) {
            expect(x.target_org, `${after}: session ${x.id} holds another org's destination`).toBe(x.org_id);
            tally.sessionRowsChecked++;
          }
          for (const oi of [0, 1] as const) {
            const list = await listStreamTargets(rigs[oi].auth, orgIds[oi]!);
            const expectRows = targets.filter((tg) => tg.org === oi && !tg.archived).map((tg) => {
              const h = holderOf(tg);
              return { id: tg.id, label: tg.label, keyHint: hintOf(tg.key), inUse: h ? { sessionId: h.session!.id, matchNo: h.no, state: holdWord(h.session!) } : null };
            });
            const gotRows = list.map((row) => ({ id: row.id, label: row.label, keyHint: row.keyHint, inUse: row.inUse ? { sessionId: row.inUse.sessionId, matchNo: row.inUse.matchNo, state: row.inUse.state } : null }));
            expect(gotRows.sort(byId), `${after}: org ${oi}'s list is its model's un-archived targets`).toEqual(expectRows.sort(byId));
            tally.listRowsChecked += gotRows.length;
            const listed = new Set(list.map((row) => row.id));
            for (const tg of targets) {
              if (tg.org === oi && !tg.archived) continue;
              expect(listed.has(tg.id), `${after}: org ${oi}'s list shows ${tg.archived ? "an archived" : "the other org's"} target ${tg.id}`).toBe(false);
              tally.archivedAbsent++;
            }
          }
          const table = await sql<{ id: string; org_id: string; archived: boolean }[]>`
            select id, org_id, archived_at is not null as archived from org_stream_targets where org_id in ${sql(orgIds)}`;
          expect(table.map((x) => ({ id: x.id, org: x.org_id, archived: x.archived })).sort(byId), `${after}: the table's owners and archived flags`)
            .toEqual(targets.map((tg) => ({ id: tg.id, org: orgIds[tg.org], archived: tg.archived })).sort(byId));
          tally.tableRowsChecked += table.length;
          tally.checks++;
        };

        await check("rig");
        for (const [i, c] of cmds.entries()) {
          seen.add(c.kind);
          const label = `step ${i} ${JSON.stringify(c)}`;
          await step(c, label);
          tally.steps++;
          await check(label);
        }
      }),
      { numRuns: DEST_MODEL_RUNS, seed: DEST_MODEL_SEED, examples: [DEST_REGRESSION_FA5_HELD, DEST_REGRESSION_FA5_UNREADABLE, DEST_REGRESSION_ADMISSION_READ, ...DEST_PINNED].map((seq) => [seq]) },
    );
    console.info(`destination model: ${JSON.stringify(tally)}`);
    // Anti-vacuity (rule 2): the property ran every run, checked after every step, and reached every behaviour it claims.
    expect(tally.runs, "fast-check counts the pinned examples INSIDE numRuns").toBe(DEST_MODEL_RUNS);
    expect(tally.checks, "one invariant pass per step plus one per rig").toBe(tally.steps + tally.runs);
    expect([...seen].sort()).toEqual(["add", "age", "connect", "goLive", "remove", "replace", "stop", "void"]);
    for (const k of ["targetHoldChecks", "listRowsChecked", "archivedAbsent", "sessionRowsChecked", "tableRowsChecked", "refusalMoneyChecks", "refusalCallChecks",
      "heldRemoveRefusals", "heldReplaceRefusals", "sameIdRestores", "existingKept", "crossOrgRefusals", "archivedTakeRefusals", "unreadableRefusals", "duplicateRefusals",
      "staleExpired", "heldAfterVoid", "otherPlatformNew", "runningOverHeld"] as const) {
      expect(tally[k], `${k}: zero checked is a failure`).toBeGreaterThan(0);
    }
  }, 240_000);
});

// G-a (B5 re-review 4 gap hunt; controller ruling 2026-10-01): Cloudflare's input word `new_configuration_accepted` (an
// output was added or changed) is NOT evidence about the phone. It used to map to `unknown`: the chain read No signal
// over a phone that may be sending, and warming → live waited on it. The adapter now answers it with `state: null`
// (ports.ts IngestStatus) and the session layer CARRIES the previous poll's word forward. Every expected word below is
// the word an earlier REAL read produced on the same session, so a carry that invents a constant cannot pass both the
// connected and the dropped case. Single-sport: the carry has no sport branch (stream sessions are sport-blind).
describe.skipIf(!HAS_DB)("G-a: a no-evidence input read carries the phone's previous reading — never unknown, never a hold on go-live", () => {
  type Rig = Awaited<ReturnType<typeof rig>>;
  /** The provider answering `new_configuration_accepted` on every input read: the real fake's reading, `state: null`. */
  const noEvidence = (r: Rig): SessionDeps => {
    const ingest = Object.assign(Object.create(r.ingest) as FakeIngest, {
      inputStatus: async (id: string, meta?: { sessionId?: string | null }) => ({ ...(await r.ingest.inputStatus(id, meta)), state: null }),
    });
    return { ...r.deps, drivers: { ...r.deps.drivers, ingest } };
  };
  const counts = async (sid: string) => {
    const [{ samples }] = await sql<{ samples: number }[]>`select count(*)::int as samples from fixture_stream_samples where session_id = ${sid} and source = 'poll'`;
    const [{ events }] = await sql<{ events: number }[]>`select count(*)::int as events from fixture_stream_events where session_id = ${sid} and type = 'ingest_status'`;
    return { samples, events };
  };
  const lastPollWord = async (sid: string) => (await sql<{ ingest_state: string | null }[]>`
    select ingest_state from fixture_stream_samples where session_id = ${sid} and source = 'poll' order by id desc limit 1`)[0]?.ingest_state;
  const phoneOf = async (r: Rig, sid: string) => {
    const [inp] = await sql<{ ingest_input_id: string }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${sid}`;
    return (s: "connected" | "disconnected") => r.ingest.setState(inp!.ingest_input_id, s);
  };
  const consumesOf = async (sid: string) => (await sql<{ n: number }[]>`
    select count(*)::int as n from org_stream_credits where session_id = ${sid} and reason = 'consume'`)[0]!.n;
  const PAST_WARMING_MS = (WARMING_TIMEOUT_MINUTES + 1) * 60_000;
  const NEVER_MS = 24 * 60 * 60_000;

  it("LIVE: connected stays connected (no No signal) across two no-evidence reads; a dropped phone stays DROPPED (the carry is the previous word, not a constant); each carried poll records the carried word and no event; a real word moves it again", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3000);
    const live = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(live.state, "PREMISE: a real connected read took it live").toBe("live");
    expect(live.ingest?.state).toBe("connected");
    const phone = await phoneOf(r, sessionId);
    let carried = 0;
    for (let i = 0; i < 2; i++) {   // a second call carries the same word
      r.tick(5_000);
      const before = await counts(sessionId);
      const cur = (await currentSession(r.auth, r.fixtureId, noEvidence(r)))!;
      expect(cur.ingest?.state, `no-evidence read ${i + 1}: carried, not unknown`).toBe("connected");
      expect(phoneNoSignal(cur), "no No signal over a phone that was sending").toBe(false);
      expect(cur.state).toBe("live");
      expect(await counts(sessionId), "a sample of the carried word, no event").toEqual({ samples: before.samples + 1, events: before.events });
      expect(await lastPollWord(sessionId)).toBe("connected");
      carried++;
    }
    // The phone drops on a REAL read, then the provider says nothing about video: the drop is carried.
    phone("disconnected");
    r.tick(5_000);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.ingest?.state, "PREMISE: a real read saw the drop").toBe("disconnected");
    r.tick(5_000);
    const before = await counts(sessionId);
    const dropped = (await currentSession(r.auth, r.fixtureId, noEvidence(r)))!;
    expect(dropped.ingest?.state, "the previous word, not connected and not unknown").toBe("disconnected");
    expect(phoneNoSignal(dropped), "a carried drop is still a drop").toBe(true);
    expect(await counts(sessionId)).toEqual({ samples: before.samples + 1, events: before.events });
    carried++;
    // A real word afterwards is read as itself.
    phone("connected");
    r.tick(5_000);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.ingest?.state).toBe("connected");
    expect(carried, "three carried polls ran").toBe(3);
    const [{ unknowns }] = await sql<{ unknowns: number }[]>`
      select count(*)::int as unknowns from fixture_stream_samples where session_id = ${sessionId} and ingest_state = 'unknown'`;
    expect(unknowns, "no sample ever recorded the word as unknown").toBe(0);
  });

  it("WARMING with nothing to carry: the phone is unseen — ingest null, still warming, nothing recorded, nothing reported — and the next real `connected` takes it live with one consume (go-live is never held by the word)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3000);   // the fake's phone is now connected: a real read would go live
    sentry.captureError.mockClear();
    const unseen = (await currentSession(r.auth, r.fixtureId, noEvidence(r)))!;
    expect(unseen).toMatchObject({ state: "warming", ingest: null, failReason: null });
    expect(phoneNoSignal(unseen)).toBe(false);
    expect(await counts(sessionId), "no evidence and no carry: nothing recorded").toEqual({ samples: 0, events: 0 });
    expect(sentry.captureError, "not a failed read: nothing reported").not.toHaveBeenCalled();
    expect(await consumesOf(sessionId)).toBe(0);
    const live = (await currentSession(r.auth, r.fixtureId, r.deps))!;
    expect(live.state, "the next real read goes live").toBe("live");
    expect(await consumesOf(sessionId)).toBe(1);
  });

  it("EXPIRY, the differential pair: past the warming timeout a no-evidence read with nothing to carry HOLDS the timeout (still warming, no no_inbound_timeout); with a previous poll that read `disconnected` the carried word lets it expire", async () => {
    // Nothing to carry: held, exactly as an unreadable ingest is (N1).
    const held = await rig({ credits: 1, connectAfterMs: NEVER_MS });
    const a = await createSession(held.auth, held.fixtureId, body(held.target.id), held.deps);
    held.tick(PAST_WARMING_MS);
    const cur = (await currentSession(held.auth, held.fixtureId, noEvidence(held)))!;
    expect(cur).toMatchObject({ state: "warming", failReason: null, ingest: null });
    expect(await held.row(a.sessionId)).toMatchObject({ state: "warming", fail_reason: null });
    // The sequence: the next REAL read says disconnected, and the timeout fires on that evidence.
    expect((await currentSession(held.auth, held.fixtureId, held.deps))!).toMatchObject({ state: "failed", failReason: "no_inbound_timeout" });

    // A previous poll that read `disconnected`: carried, so the expiry has its evidence.
    const prior = await rig({ credits: 1, connectAfterMs: NEVER_MS });
    const b = await createSession(prior.auth, prior.fixtureId, body(prior.target.id), prior.deps);
    prior.tick(5_000);
    expect((await currentSession(prior.auth, prior.fixtureId, prior.deps))!.ingest?.state, "PREMISE: a real poll read the phone silent").toBe("disconnected");
    expect(await lastPollWord(b.sessionId)).toBe("disconnected");
    prior.tick(PAST_WARMING_MS);
    expect((await currentSession(prior.auth, prior.fixtureId, noEvidence(prior)))!).toMatchObject({ state: "failed", failReason: "no_inbound_timeout" });
  });

  it("NO evidence on EITHER read (the input word says nothing about video AND the outputs read failed): the phone still shows its carried word, and the poll records nothing (m-2)", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3000);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.ingest?.state, "PREMISE: a real read saw the phone").toBe("connected");
    const base = noEvidence(r);
    const ingest = Object.assign(Object.create(base.drivers.ingest) as FakeIngest, { outputState: async () => null });
    const blind: SessionDeps = { ...base, drivers: { ...base.drivers, ingest } };
    r.tick(5_000);
    const before = await counts(sessionId);
    const cur = (await currentSession(r.auth, r.fixtureId, blind))!;
    expect(cur.ingest?.state, "carried even though no outputs word came back").toBe("connected");
    expect(phoneNoSignal(cur)).toBe(false);
    expect(cur.state).toBe("live");
    expect(await counts(sessionId), "an outputs read that failed records neither sample nor event").toEqual(before);
  });

  it("the carry's guard: a latest poll sample whose word is not one of the port's three is not carried — the phone is unseen (ingest null), never that word", async () => {
    const r = await rig({ credits: 1 });
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3000);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state, "PREMISE: live").toBe("live");
    await sql`insert into fixture_stream_samples (session_id, sampled_at, source, ingest_state, output_state, raw)
              values (${sessionId}, now(), 'poll', 'playing', 'ok', '{}'::jsonb)`;
    expect(await lastPollWord(sessionId), "PREMISE: the foreign word is the latest poll sample").toBe("playing");
    r.tick(5_000);
    const cur = (await currentSession(r.auth, r.fixtureId, noEvidence(r)))!;
    expect(cur.ingest, "not carried").toBeNull();
    expect(cur.state).toBe("live");
  });
});
