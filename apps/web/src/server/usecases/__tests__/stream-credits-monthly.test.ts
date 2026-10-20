// Monthly free match credits and the two ledger buckets (Streaming R1 Task 14b, owner-approved 2026-09-29; rulings R2,
// R3). Real Postgres; skipped without DATABASE_URL.
//
// Every expected grant is READ from plan_entitlements (V426's `streaming.credits.monthly` rows) — never a table typed
// here — so a change to the owner's numbers moves these tests with it. Every sweep counts what it checked, and zero is a
// failure. Periods are synthetic UTC dates in 2031 (passed as `now`), so no case depends on today's month.
//
// State transitions tested as SEQUENCES, not features: grant → second call → rollover; consume order across buckets;
// refund back into the consume's bucket, including one that lands AFTER a rollover; revoke (staff and Stripe) on the
// pack only.
//
// Killers for the mutant table (task-14b-report.md):
//   k1 ensure's under-lock key re-check deleted                 → "two concurrent ensures produce ONE grant"
//   k2 grantMonthlyStreamCredits' lockOrg deleted                 → the same test (0 waiters, not 2)
//   k3 rollover skips the expire row                              → "rollover expires exactly the leftover monthly"
//   k4 expire reads the TOTAL, not the monthly bucket             → the same test (pack would be swept)
//   k5 consume always draws 'pack'                                → "a consume draws monthly first, then pack"
//   k6 consume draws 'monthly' while monthly is 0 (`>= 0`)        → the same test
//   k7 linked refund always 'pack'                                → "a linked refund returns to its consume's bucket"
//   k8 staff revoke floored on the TOTAL, not the pack            → "a staff revoke is a PACK debit"
//   k9 claw-back attribution counts EVERY consume, not pack's     → "a claw-back is a pack debit … monthly spending"
//   k10 claw-back capped by the total, not the pack               → "a claw-back is capped by the PACK"
//   k11 the negative-monthly guard deleted                        → "a negative monthly bucket is REFUSED"
//   k11b the negative-pack limb of that guard deleted             → "a NEGATIVE pack bucket is refused too"
//   k12 the rate guard deleted                                    → "grantMonthlyStreamCredits refuses a rate"
//   k13 the refund_bucket_ambiguous guard deleted                 → "a linked refund returns to its consume's bucket …"
//   k14 the claw-back's negative-pack guard deleted               → "a pack that sums below zero is refused by the claw-back"
//   k15 ensure's fast path deleted (always the full grant path)   → "a second ensure … costs the rate read plus ONE statement"
//   k16 the top-up is rate − monthly BALANCE, not − granted        → "I3: a mid-month UPGRADE tops the month up"
//   k17 no top-up: an existing base grant always returns 0        → the same test (0, not P − C)
//   k18 the locked body's "owed nothing" test is `===`, not `>=`  → the same test (grantMonthlyStreamCredits at a lower rate)
//   k18c the fast path's "owed nothing" test is `===`, not `>=`   → the same test (the downgrade's statement count)
//   k19 the under-lock re-read uses the pre-lock state            → "I3: two concurrent ensures after an upgrade"
//   k20 consumeForSession ignores `monthly` (no rollover)         → "M6: a consume after the UTC month turns"
//   k21 the rollover runs AFTER the breakdown the consume reads   → the same test (it draws pack)
//   k22 a failed rollover fails the consume (no savepoint catch)  → "M6: a rollover that fails inside the consume"
//   k23 … is swallowed without a report                            → the same test
//   p9 streamMonthlyRate reads a pass key as a monthly rate      → "addendum P: a PASS key on the subscription is never read"
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sql, statementCount } from "@/lib/db";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { streamRig } from "@/server/relay/__tests__/_session-rig";
import { PASS_KEYS } from "@/lib/currency";
import { CREDIT_REUSE_HOURS } from "@/server/relay/config";
import {
  NoCreditsError, consumeForSession, creditBalance, creditBreakdown, ensureMonthlyStreamGrant,
  grantMonthlyStreamCredits, lockOrg, neverLiveRefundStanding, recordPurchase, recordStreamPackRefund, refundConsumeForSession, refundCredits, revokeCredits, streamMonthlyDeltaKey,
  streamMonthlyGrantKey, streamMonthlyPeriod, streamMonthlyRate,
} from "../stream-credits";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

const HAS_DB = !!process.env.DATABASE_URL;
const MONTHLY = "streaming.credits.monthly";

const JAN = new Date("2031-01-15T12:00:00Z");
const JAN_LAST = new Date("2031-01-31T23:59:59Z");
const FEB = new Date("2031-02-01T00:00:00Z");
const MAR = new Date("2031-03-10T08:00:00Z");

/** V426's rows, read from the database — the ONLY source of an expected grant in this file. */
async function ratesByPlan(): Promise<Map<string, number>> {
  const rows = await sql<{ plan_key: string; int_value: number | null }[]>`
    select plan_key, int_value from plan_entitlements where feature_key = ${MONTHLY}`;
  return new Map(rows.map((r) => [r.plan_key, r.int_value ?? 0]));
}
async function rateOf(plan: string): Promise<number> {
  const n = (await ratesByPlan()).get(plan);
  if (n === undefined) throw new Error(`no ${MONTHLY} row for ${plan}`);
  return n;
}

async function rig(plan: string | null = null, fixtures: 1 | 2 = 2) {
  const r = await streamRig({ fixtures });
  if (plan) await setOrgPlan(r.orgId, plan as Parameters<typeof setOrgPlan>[1]);
  return r;
}

interface Row { reason: string; bucket: string; delta: number; balance_after: number; idempotency_key: string | null; session_id: string | null }
const rows = (orgId: string) =>
  sql<Row[]>`select reason, bucket, delta, balance_after, idempotency_key, session_id
               from org_stream_credits where org_id = ${orgId} order by created_at, balance_after desc`;
const rowCount = async (orgId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${orgId}`)[0]!.n;

/** One consume for a fresh session. `fixtureId: null` so the 24 h reuse window (per fixture) never waives it. */
async function consume(r: Awaited<ReturnType<typeof rig>>, monthly?: { rate: number; now: Date }): Promise<{ sessionId: string; bucket: string }> {
  const sessionId = await r.session(r.fixtureIds[0]!, "warming");
  const c = await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: null, sessionId, ...(monthly ? { monthly } : {}) }));
  if (!c.consumed) throw new Error("premise: the consume was waived");
  const [row] = await sql<{ bucket: string }[]>`select bucket from org_stream_credits where id = ${c.ledgerId}`;
  // The session holds its target until it ends; end it so the next session can be seated.
  await sql`update fixture_stream_sessions set state = 'completed', ended_at = now() where id = ${sessionId}`;
  return { sessionId, bucket: row!.bucket };
}

const buy = (orgId: string, n: number) => {
  const cs = `cs_monthly_${orgId}_${randomUUID().slice(0, 8)}`;
  return recordPurchase({
    orgId, delta: n, stripeEventId: cs,
    link: { checkoutSessionId: cs, paymentIntentId: `pi_${cs}`, pack: `seazn_stream_pack_${n}`, amountMinor: 600, currency: "gbp" },
  }).then(() => ({ intent: `pi_${cs}` }));
};

const staff = (r: Awaited<ReturnType<typeof rig>>) => ({ orgId: r.orgId, createdBy: r.createdBy, note: "unit", idempotencyKey: `idem-${randomUUID()}` });

async function advisoryWaitersBehind(holderPid: number, want: number, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  for (;;) {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_locks
       where locktype = 'advisory' and not granted and ${holderPid} = any(pg_blocking_pids(pid))`;
    seen = row!.n;
    if (seen >= want || Date.now() >= deadline) return seen;
    await new Promise((res) => setTimeout(res, 25));
  }
}

describe("the monthly period and its key (pure)", () => {
  it("the period is the UTC calendar month; the grant key is stream-monthly:{org}:{YYYY-MM}, org lower-cased", () => {
    expect(streamMonthlyPeriod(JAN)).toBe("2031-01");
    expect(streamMonthlyPeriod(JAN_LAST)).toBe("2031-01");
    expect(streamMonthlyPeriod(FEB)).toBe("2031-02");
    // 23:30 on the 31st in UTC-5 is already the 1st in UTC: the period follows UTC, never a local zone.
    expect(streamMonthlyPeriod(new Date("2031-01-31T23:30:00-05:00"))).toBe("2031-02");
    const org = "0F0E0D0C-0000-4000-8000-00000000000A";
    expect(streamMonthlyGrantKey(org, "2031-01")).toBe(`stream-monthly:${org.toLowerCase()}:2031-01`);
  });
});

describe.skipIf(!HAS_DB)("monthly stream credits — the grant", () => {
  it("every SUBSCRIPTION plan's grant equals ITS V426 row, read from the DB (a sweep over the plans table)", async () => {
    // Every plan has a V426 row (the catalogue half of the sweep). The two pass keys' rows are ONE-OFF amounts granted
    // when a pass is bought (addendum P, lib/__tests__/billing-pass-stream-credits.test.ts), so they are swept for the
    // row and then skipped here — the monthly path refusing to read them is "addendum P: a PASS key … (p9)" below.
    const plans = await sql<{ key: string }[]>`select key from plans order by key`;
    const rates = await ratesByPlan();
    let checked = 0;
    let passKeys = 0;
    for (const { key: plan } of plans) {
      const want = rates.get(plan);
      expect(want, `${plan} has a V426 row`).toBeGreaterThanOrEqual(1);
      if ((PASS_KEYS as readonly string[]).includes(plan)) { passKeys++; continue; }
      const r = await rig(plan, 1);
      expect(await streamMonthlyRate(r.orgId), plan).toBe(want);
      expect(await ensureMonthlyStreamGrant(r.orgId, JAN), plan).toBe(want);
      expect(await creditBreakdown(sql, r.orgId), plan).toEqual({ monthly: want, pack: 0, total: want });
      const [row] = await rows(r.orgId);
      expect(row, plan).toMatchObject({ reason: "grant", bucket: "monthly", delta: want, balance_after: want,
        idempotency_key: streamMonthlyGrantKey(r.orgId, "2031-01"), session_id: null });
      checked++;
    }
    expect(checked, "no plan was checked").toBeGreaterThan(0);
    expect(passKeys, "the pass keys are in the plans table").toBe(PASS_KEYS.length);
    expect(checked).toBe(plans.length - PASS_KEYS.length);
  });

  it("an org with NO subscription row (a fresh signup) is community, and grants community's row", async () => {
    const r = await rig(null, 1);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from organizations where id = ${r.orgId} and subscription_id is not null`;
    expect(n, "premise: seedOrg writes no subscription").toBe(0);
    expect(await ensureMonthlyStreamGrant(r.orgId, JAN)).toBe(await rateOf("community"));
  });

  it("a second ensure in the same period writes 0 rows — on another day of the month too — and costs the rate read plus ONE statement", async () => {
    const r = await rig("pro", 1);
    const want = await rateOf("pro");
    expect(await ensureMonthlyStreamGrant(r.orgId, JAN)).toBe(want);
    const before = await rowCount(r.orgId);
    // I3: the fast path must know the CURRENT rate (a mid-month upgrade is owed a top-up), so it pays the plan resolve.
    // That cost is streamMonthlyRate's own, measured here rather than typed; the ensure may add ONE read to it.
    const q0 = statementCount();
    await streamMonthlyRate(r.orgId);
    const rateCost = statementCount() - q0;
    expect(rateCost, "premise: the rate read is measured").toBeGreaterThan(0);
    let checked = 0;
    for (const now of [JAN, JAN_LAST]) {
      const q = statementCount();
      expect(await ensureMonthlyStreamGrant(r.orgId, now)).toBe(0);
      expect(statementCount() - q, "cheap once this period is granted: the rate, one ledger read, and nothing else").toBe(rateCost + 1);
      checked++;
    }
    expect(checked).toBe(2);
    expect(await rowCount(r.orgId)).toBe(before);
    expect((await creditBreakdown(sql, r.orgId)).monthly).toBe(want);
  });

  it("rollover expires exactly the LEFTOVER monthly — before the new grant — and never touches the pack", async () => {
    const r = await rig("pro");
    const R = await rateOf("pro");
    expect(R, "premise: the differential needs a rate above 2").toBeGreaterThan(2);
    await ensureMonthlyStreamGrant(r.orgId, JAN);
    await buy(r.orgId, 2);
    await consume(r);
    await consume(r);
    // leftover (R-2), pack (2) and the total (R) are three different numbers for R > 4, so expiring the total, the pack
    // or the whole grant each writes a delta of its own.
    const leftover = R - 2;
    expect(new Set([leftover, 2, R]).size, "premise: the three candidate deltas differ").toBe(3);
    expect(await creditBreakdown(sql, r.orgId)).toEqual({ monthly: leftover, pack: 2, total: leftover + 2 });

    expect(await ensureMonthlyStreamGrant(r.orgId, FEB)).toBe(R);
    const all = await rows(r.orgId);
    // Both rows share one created_at (one transaction), so ORDER is read from the snapshots, not the clock: the expire's
    // balance_after excludes the leftover and not yet the grant; the grant's is that plus R.
    expect(all.filter((x) => x.reason === "expire").map((x) => [x.bucket, x.delta, x.balance_after])).toEqual([["monthly", -leftover, 2]]);
    expect(all.filter((x) => x.idempotency_key === streamMonthlyGrantKey(r.orgId, "2031-02")).map((x) => [x.reason, x.bucket, x.delta, x.balance_after]))
      .toEqual([["grant", "monthly", R, 2 + R]]);
    expect(await creditBreakdown(sql, r.orgId)).toEqual({ monthly: R, pack: 2, total: R + 2 });
    // Neither ensure wrote a pack row: the only one is the purchase.
    expect(all.filter((x) => x.bucket === "pack").map((x) => x.reason)).toEqual(["purchase"]);
  });

  it("a rollover with NOTHING left writes no expire row (V410: delta <> 0) — the empty case", async () => {
    const r = await rig(null);
    const R = await rateOf("community");
    await ensureMonthlyStreamGrant(r.orgId, JAN);
    for (let i = 0; i < R; i++) await consume(r);
    expect((await creditBreakdown(sql, r.orgId)).monthly).toBe(0);
    expect(await ensureMonthlyStreamGrant(r.orgId, FEB)).toBe(R);
    expect((await rows(r.orgId)).filter((x) => x.reason === "expire")).toHaveLength(0);
  });

  it("two concurrent ensures produce ONE grant: both queue on the org's money lock, the second re-checks the key under it (k1, k2)", async () => {
    const r = await rig("pro", 1);
    const R = await rateOf("pro");
    let release!: () => void;
    const released = new Promise<void>((res) => (release = res));
    let signalHeld!: (pid: number) => void;
    const held = new Promise<number>((res) => (signalHeld = res));
    const holder = sql.begin(async (tx) => {
      await lockOrg(tx, r.orgId);
      const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      signalHeld(pid);
      await released;
    });
    const holderPid = await held;
    // Both pass the unlocked fast path (no key yet) and reach the transaction.
    const racers = [ensureMonthlyStreamGrant(r.orgId, JAN), ensureMonthlyStreamGrant(r.orgId, JAN)];
    const blocked = await advisoryWaitersBehind(holderPid, 2);
    release();
    await holder;
    const settled = await Promise.allSettled(racers);
    expect(blocked, "both ensures queue on the money lock (k2: none do)").toBe(2);
    expect(settled.map((s) => s.status), JSON.stringify(settled.map((s) => (s.status === "rejected" ? String(s.reason) : "")))).toEqual(["fulfilled", "fulfilled"]);
    expect(settled.map((s) => (s as PromiseFulfilledResult<number>).value).sort((a, b) => a - b)).toEqual([0, R]);
    expect((await rows(r.orgId)).filter((x) => x.reason === "grant")).toHaveLength(1);
    expect((await creditBreakdown(sql, r.orgId)).monthly).toBe(R);
  });

  it("I3: a mid-month UPGRADE tops the month up to the new rate — by the plan difference, never the missing balance; a second ensure and a downgrade grant 0 and claw nothing back (k16, k17, k18)", async () => {
    const r = await rig(null, 2);
    const C = await rateOf("community");
    const P = await rateOf("pro");
    expect(P - C, "premise: pro grants more than community").toBeGreaterThan(0);
    const FIRST = new Date("2031-01-01T08:00:00Z");
    const TENTH = new Date("2031-01-10T12:00:00Z");
    expect(await ensureMonthlyStreamGrant(r.orgId, FIRST)).toBe(C);
    // Spend one free credit first: the owed top-up is P − C (what the NEW plan grants beyond what this month already
    // granted), not P − balance — the two differ by exactly the credit spent, so k16 has a witness.
    await consume(r);
    expect((await creditBreakdown(sql, r.orgId)).monthly).toBe(C - 1);
    await setOrgPlan(r.orgId, "pro");
    expect(await ensureMonthlyStreamGrant(r.orgId, TENTH), "the top-up is the plan difference").toBe(P - C);
    expect(await creditBreakdown(sql, r.orgId)).toEqual({ monthly: P - 1, pack: 0, total: P - 1 });
    const top = (await rows(r.orgId)).filter((x) => x.idempotency_key === streamMonthlyDeltaKey(r.orgId, "2031-01", P));
    expect(top.map((x) => [x.reason, x.bucket, x.delta, x.balance_after])).toEqual([["grant", "monthly", P - C, P - 1]]);

    const n = await rowCount(r.orgId);
    let checked = 0;
    for (const [plan, when] of [["pro", TENTH], ["pro", JAN_LAST], ["community", JAN_LAST], ["pro", JAN_LAST]] as const) {
      await setOrgPlan(r.orgId, plan);
      const q0 = statementCount();
      await streamMonthlyRate(r.orgId);
      const rateCost = statementCount() - q0;
      const q = statementCount();
      expect(await ensureMonthlyStreamGrant(r.orgId, when), `${plan} after the top-up`).toBe(0);
      // The fast path answers a downgrade too (k18c): no transaction for an org that is owed nothing.
      expect(statementCount() - q, `${plan}: the fast path`).toBe(rateCost + 1);
      checked++;
    }
    expect(checked).toBe(4);
    // The under-lock body on its own (k18: the fast path above would shield it): a LOWER rate than this month granted.
    expect(await grantMonthlyStreamCredits(r.orgId, C, JAN_LAST), "the locked body refuses a claw-back too").toBe(0);
    expect(await rowCount(r.orgId), "no second top-up, and a downgrade claws nothing back").toBe(n);
    expect((await creditBreakdown(sql, r.orgId)).monthly).toBe(P - 1);

    // The next rollover expires the top-up with the rest of the leftover — it is a monthly credit like the base.
    expect(await ensureMonthlyStreamGrant(r.orgId, FEB)).toBe(P);
    expect((await rows(r.orgId)).filter((x) => x.reason === "expire").map((x) => [x.bucket, x.delta])).toEqual([["monthly", -(P - 1)]]);
    expect((await creditBreakdown(sql, r.orgId)).monthly).toBe(P);
  });

  it("I3: two concurrent ensures after an upgrade produce ONE top-up — the under-lock re-read sees the first (k19)", async () => {
    const r = await rig(null, 1);
    const C = await rateOf("community");
    const P = await rateOf("pro");
    await ensureMonthlyStreamGrant(r.orgId, JAN);
    await setOrgPlan(r.orgId, "pro");
    let release!: () => void;
    const released = new Promise<void>((res) => (release = res));
    let signalHeld!: (pid: number) => void;
    const held = new Promise<number>((res) => (signalHeld = res));
    const holder = sql.begin(async (tx) => {
      await lockOrg(tx, r.orgId);
      const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      signalHeld(pid);
      await released;
    });
    const holderPid = await held;
    const racers = [ensureMonthlyStreamGrant(r.orgId, JAN), ensureMonthlyStreamGrant(r.orgId, JAN)];
    const blocked = await advisoryWaitersBehind(holderPid, 2);
    release();
    await holder;
    const settled = await Promise.allSettled(racers);
    expect(blocked, "both top-ups queue on the money lock").toBe(2);
    expect(settled.map((s) => s.status), JSON.stringify(settled.map((s) => (s.status === "rejected" ? String(s.reason) : "")))).toEqual(["fulfilled", "fulfilled"]);
    expect(settled.map((s) => (s as PromiseFulfilledResult<number>).value).sort((a, b) => a - b)).toEqual([0, P - C]);
    expect((await creditBreakdown(sql, r.orgId)).monthly).toBe(P);
  });

  it("grantMonthlyStreamCredits refuses a rate that is not a non-negative integer; a rate of 0 still expires the leftover and grants nothing, and a repeat writes nothing (k12)", async () => {
    const r = await rig(null, 1);
    await ensureMonthlyStreamGrant(r.orgId, JAN);
    const R = await rateOf("community");
    let refused = 0;
    for (const bad of [-1, 1.5, Number.NaN]) {
      await expect(grantMonthlyStreamCredits(r.orgId, bad, FEB), String(bad)).rejects.toMatchObject({ status: 500, code: "monthly_rate_invalid" });
      refused++;
    }
    expect(refused).toBe(3);
    expect(await grantMonthlyStreamCredits(r.orgId, 0, FEB)).toBe(0);
    const expired = (await rows(r.orgId)).filter((x) => x.reason === "expire");
    expect(expired.map((x) => [x.bucket, x.delta])).toEqual([["monthly", -R]]);
    const n = await rowCount(r.orgId);
    expect(await grantMonthlyStreamCredits(r.orgId, 0, FEB)).toBe(0);
    expect(await rowCount(r.orgId), "nothing left to expire, nothing to grant").toBe(n);
  });

  it("a NEGATIVE monthly bucket is REFUSED at rollover, not carried into next month's grant (k11)", async () => {
    // "Cannot happen" is a guard (TEST-STRATEGY rule 4): no writer draws monthly below zero, so a negative monthly
    // bucket is a corrupt ledger. Granting on top of it would silently hand the org R-1.
    const r = await rig(null, 1);
    await buy(r.orgId, 2);
    await sql`insert into org_stream_credits (org_id, delta, reason, bucket, balance_after) values (${r.orgId}, -1, 'consume', 'monthly', 1)`;
    const before = await rowCount(r.orgId);
    await expect(ensureMonthlyStreamGrant(r.orgId, JAN)).rejects.toMatchObject({ status: 500, code: "ledger_negative" });
    expect(await rowCount(r.orgId)).toBe(before);
  });

  it("a NEGATIVE pack bucket is refused too: expiring the monthly leftover on top of it would write a negative snapshot (k11b)", async () => {
    const r = await rig(null, 1);
    await ensureMonthlyStreamGrant(r.orgId, JAN);   // monthly R
    await sql`insert into org_stream_credits (org_id, delta, reason, bucket, balance_after) values (${r.orgId}, -1, 'consume', 'pack', 0)`;
    const before = await rowCount(r.orgId);
    await expect(ensureMonthlyStreamGrant(r.orgId, FEB)).rejects.toMatchObject({ status: 500, code: "ledger_negative" });
    expect(await rowCount(r.orgId)).toBe(before);
  });

  it("addendum P: a PASS key on the subscription is never read as a monthly rate — nothing granted, and it is REPORTED (p9)", async () => {
    // "Cannot happen" as a guard: no writer puts a pass key on subscriptions.plan_key, and V426's pass rows are one-off
    // amounts (grantPassStreamCredits). Read as a monthly rate they would be granted again every month.
    let checked = 0;
    for (const passKey of PASS_KEYS) {
      const passRate = await rateOf(passKey);
      expect(passRate, `${passKey}: premise — a rate that would be granted if read`).toBeGreaterThan(0);
      const r = await rig(passKey);
      sentry.captureError.mockClear();
      expect(await streamMonthlyRate(r.orgId), passKey).toBe(0);
      expect(await ensureMonthlyStreamGrant(r.orgId, JAN), passKey).toBe(0);
      expect(await rowCount(r.orgId), passKey).toBe(0);
      const reports = sentry.captureError.mock.calls.filter(([, ctx]) => ctx?.route === "relay.credits.monthly_rate_pass_plan");
      expect(reports.length, passKey).toBeGreaterThanOrEqual(2);
      expect(reports.every(([, ctx]) => ctx?.orgId === r.orgId), passKey).toBe(true);
      checked++;
    }
    expect(checked).toBe(PASS_KEYS.length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("monthly stream credits — which bucket each writer moves", () => {
  it("a consume draws MONTHLY first, then PACK, then refuses — recording its bucket (k5, k6)", async () => {
    const r = await rig(null);
    const R = await rateOf("community");
    await ensureMonthlyStreamGrant(r.orgId, JAN);
    await buy(r.orgId, 2);
    const seen: string[] = [];
    for (let i = 0; i < R + 2; i++) seen.push((await consume(r)).bucket);
    expect(seen).toEqual([...Array(R).fill("monthly"), "pack", "pack"]);
    expect(await creditBreakdown(sql, r.orgId)).toEqual({ monthly: 0, pack: 0, total: 0 });
    const s = await r.session(r.fixtureIds[1]!, "warming");
    await expect(sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: null, sessionId: s }))).rejects.toBeInstanceOf(NoCreditsError);
  });

  it("a linked refund returns to its consume's bucket; a goodwill refund is pack; a session whose consumes span two buckets is refused by name (k7)", async () => {
    const r = await rig(null);
    const R = await rateOf("community");
    await ensureMonthlyStreamGrant(r.orgId, JAN);
    await buy(r.orgId, 1);
    const fromMonthly: string[] = [];
    for (let i = 0; i < R; i++) fromMonthly.push((await consume(r)).sessionId);
    const fromPack = await consume(r);
    expect(fromPack.bucket).toBe("pack");
    expect(await creditBreakdown(sql, r.orgId)).toEqual({ monthly: 0, pack: 0, total: 0 });

    await refundCredits({ ...staff(r), delta: 1, sessionId: fromMonthly[0]! });
    await refundCredits({ ...staff(r), delta: 1, sessionId: fromPack.sessionId });
    await refundCredits({ ...staff(r), delta: 1, sessionId: null });
    const refunds = (await rows(r.orgId)).filter((x) => x.reason === "refund");
    expect(refunds).toHaveLength(3);
    expect(refunds.map((x) => [x.session_id, x.bucket])).toEqual(expect.arrayContaining([
      [fromMonthly[0]!, "monthly"], [fromPack.sessionId, "pack"], [null, "pack"],
    ]));
    expect(await creditBreakdown(sql, r.orgId)).toEqual({ monthly: 1, pack: 2, total: 3 });

    // The ambiguity guard: one session, two consume rows in two buckets (hand-written — no writer does this).
    const s = await r.session(r.fixtureIds[1]!, "completed");
    await sql`insert into org_stream_credits (org_id, delta, reason, bucket, session_id, balance_after) values (${r.orgId}, -1, 'consume', 'monthly', ${s}, 2)`;
    await sql`insert into org_stream_credits (org_id, delta, reason, bucket, session_id, balance_after) values (${r.orgId}, -1, 'consume', 'pack', ${s}, 1)`;
    const n = await rowCount(r.orgId);
    await expect(refundCredits({ ...staff(r), delta: 1, sessionId: s })).rejects.toMatchObject({ status: 500, code: "refund_bucket_ambiguous" });
    expect(await rowCount(r.orgId)).toBe(n);
  });

  it("a staff revoke is a PACK debit, floored on the pack: with monthly credits still held, revoking past the pack is 422 (k8)", async () => {
    const r = await rig("pro", 1);
    const R = await rateOf("pro");
    await ensureMonthlyStreamGrant(r.orgId, JAN);
    await buy(r.orgId, 1);
    await revokeCredits({ ...staff(r), delta: 1 });
    expect((await rows(r.orgId)).filter((x) => x.reason === "revoke").map((x) => x.bucket)).toEqual(["pack"]);
    expect(await creditBreakdown(sql, r.orgId)).toEqual({ monthly: R, pack: 0, total: R });
    // The total is R ≥ 1, so a TOTAL floor would admit this and drive the pack to -1 — and the next rollover's expire
    // would then write a negative balance_after (V410's CHECK) and fail every createSession for this org.
    await expect(revokeCredits({ ...staff(r), delta: 1 })).rejects.toMatchObject({ status: 422, code: "insufficient_credits" });
    expect(await creditBreakdown(sql, r.orgId)).toEqual({ monthly: R, pack: 0, total: R });
  });

  it("a claw-back is a pack debit, attributed to PACK consumes only: monthly spending never shields a refunded pack (k9)", async () => {
    const r = await rig("pro");
    const R = await rateOf("pro");
    expect(R).toBeGreaterThan(3);
    await ensureMonthlyStreamGrant(r.orgId, JAN);
    const { intent } = await buy(r.orgId, 3);
    // Three matches, all paid from the free monthly credits — the pack was never touched.
    for (let i = 0; i < 3; i++) expect((await consume(r)).bucket).toBe("monthly");
    const res = await recordStreamPackRefund({ paymentIntentId: intent, via: "refund", reference: "ch_unit" });
    // Counting every consume since the purchase (the pre-bucket arithmetic) would claw back 0 and leave the refunded
    // customer holding 3 bought credits.
    expect(res).toMatchObject({ matched: true, applied: true, clawedBack: 3, purchased: 3 });
    const revoke = (await rows(r.orgId)).filter((x) => x.reason === "revoke");
    expect(revoke.map((x) => [x.bucket, x.delta])).toEqual([["pack", -3]]);
    expect(await creditBreakdown(sql, r.orgId)).toEqual({ monthly: R - 3, pack: 0, total: R - 3 });
  });

  it("a claw-back is capped by the PACK balance, not the total: a staff revoke already took part of the pack (k10)", async () => {
    // Attribution sees consumes only, so a non-consume reduction of the pack is what the cap exists for. Here the
    // purchase still has 3 outstanding by attribution, the pack holds 1, and the total holds R + 1 ≥ 3 — a TOTAL cap
    // would claw 3 and drive the pack to -2 behind a non-negative balance_after.
    const r = await rig("pro", 1);
    const R = await rateOf("pro");
    await ensureMonthlyStreamGrant(r.orgId, JAN);
    const { intent } = await buy(r.orgId, 3);
    await revokeCredits({ ...staff(r), delta: 2 });
    expect(await creditBreakdown(sql, r.orgId)).toEqual({ monthly: R, pack: 1, total: R + 1 });
    expect(R + 1, "premise: the total would admit the whole purchase").toBeGreaterThanOrEqual(3);
    const res = await recordStreamPackRefund({ paymentIntentId: intent, via: "refund", reference: "ch_unit_2" });
    expect(res).toMatchObject({ clawedBack: 1, applied: true, purchased: 3 });
    expect(await creditBreakdown(sql, r.orgId)).toEqual({ monthly: R, pack: 0, total: R });
  });

  it("a pack that sums below zero is refused by the claw-back, not silently written (the pack floor's own guard)", async () => {
    const r = await rig("pro", 1);
    await ensureMonthlyStreamGrant(r.orgId, JAN);
    const { intent } = await buy(r.orgId, 1);
    await sql`insert into org_stream_credits (org_id, delta, reason, bucket, balance_after) values (${r.orgId}, -2, 'consume', 'pack', 1)`;
    const before = await rowCount(r.orgId);
    await expect(recordStreamPackRefund({ paymentIntentId: intent, via: "refund", reference: "ch_neg" })).rejects.toMatchObject({ code: "ledger_negative" });
    expect(await rowCount(r.orgId)).toBe(before);
  });
});

describe.skipIf(!HAS_DB)("monthly stream credits — sequences", () => {
  it("grant → consume → refund → rollover → consume: every step's buckets, and the total is creditBalance's", async () => {
    const r = await rig(null);
    const R = await rateOf("community");
    const step = async (want: { monthly: number; pack: number }) => {
      const b = await creditBreakdown(sql, r.orgId);
      expect(b).toEqual({ ...want, total: want.monthly + want.pack });
      expect(b.total, "one authority for the total").toBe(await creditBalance(sql, r.orgId));
    };
    await step({ monthly: 0, pack: 0 });                           // the empty ledger, explicitly
    await ensureMonthlyStreamGrant(r.orgId, JAN);
    await step({ monthly: R, pack: 0 });
    const s1 = await consume(r);
    expect(s1.bucket).toBe("monthly");
    await step({ monthly: R - 1, pack: 0 });
    await refundCredits({ ...staff(r), delta: 1, sessionId: s1.sessionId });
    await step({ monthly: R, pack: 0 });
    await ensureMonthlyStreamGrant(r.orgId, FEB);                  // expires R (the refund included), grants R
    await step({ monthly: R, pack: 0 });
    expect((await rows(r.orgId)).filter((x) => x.reason === "expire").map((x) => x.delta)).toEqual([-R]);
    const s2 = await consume(r);
    expect(s2.bucket).toBe("monthly");
    await step({ monthly: R - 1, pack: 0 });
  });

  it("a refund that lands AFTER a rollover goes back to monthly, and the NEXT rollover sweeps it", async () => {
    const r = await rig(null);
    const R = await rateOf("community");
    await ensureMonthlyStreamGrant(r.orgId, JAN);
    const s1 = await consume(r);
    await ensureMonthlyStreamGrant(r.orgId, FEB);
    await refundCredits({ ...staff(r), delta: 1, sessionId: s1.sessionId });   // January's consume, refunded in February
    expect((await creditBreakdown(sql, r.orgId)).monthly).toBe(R + 1);
    await ensureMonthlyStreamGrant(r.orgId, MAR);
    const expires = (await rows(r.orgId)).filter((x) => x.reason === "expire").map((x) => x.delta);
    expect(expires, "January left nothing; March sweeps February's R plus the late refund").toEqual([-(R + 1)]);
    expect(await creditBreakdown(sql, r.orgId)).toEqual({ monthly: R, pack: 0, total: R });
  });

  it("M6: a consume after the UTC month turns draws THIS month's grant — the rollover runs under the consume's own lock (k20, k21)", async () => {
    const r = await rig(null);
    const C = await rateOf("community");
    await ensureMonthlyStreamGrant(r.orgId, JAN);
    for (let i = 0; i < C; i++) await consume(r);     // January's free credits spent
    await buy(r.orgId, 2);
    expect(await creditBreakdown(sql, r.orgId)).toEqual({ monthly: 0, pack: 2, total: 2 });
    // The session was created in January and goes live in February. Without the rollover the consume draws a BOUGHT
    // credit while February's free one is still ungranted.
    const c = await consume(r, { rate: C, now: FEB });
    expect(c.bucket, "February's free credit, not the pack").toBe("monthly");
    expect(await creditBreakdown(sql, r.orgId)).toEqual({ monthly: C - 1, pack: 2, total: C - 1 + 2 });
    expect((await rows(r.orgId)).filter((x) => x.idempotency_key === streamMonthlyGrantKey(r.orgId, "2031-02")).map((x) => x.delta)).toEqual([C]);
    // The next reader's ensure in February finds the month rolled: nothing more.
    expect(await ensureMonthlyStreamGrant(r.orgId, FEB)).toBe(0);
    // The negative pair on the SAME ledger: a consume with no rollover (a direct ledger caller) still draws monthly
    // while any is left, then the pack — i.e. `monthly` is what moved the first one.
    for (let i = 0; i < C - 1; i++) expect((await consume(r)).bucket).toBe("monthly");
    expect((await consume(r)).bucket).toBe("pack");
  });

  it("M6: a rollover that fails inside the consume is REPORTED and never blocks going live — the savepoint keeps the consume's transaction (k22, k23)", async () => {
    const r = await rig(null);
    await buy(r.orgId, 2);
    // A corrupt monthly bucket makes the rollover refuse (ledger_negative) — see "a NEGATIVE monthly bucket is REFUSED".
    await sql`insert into org_stream_credits (org_id, delta, reason, bucket, balance_after) values (${r.orgId}, -1, 'consume', 'monthly', 1)`;
    sentry.captureError.mockClear();
    const c = await consume(r, { rate: await rateOf("community"), now: FEB });
    expect(c.bucket, "the consume still happens, from the pack").toBe("pack");
    expect(await creditBreakdown(sql, r.orgId)).toEqual({ monthly: -1, pack: 1, total: 0 });
    expect((await rows(r.orgId)).filter((x) => x.reason === "grant"), "nothing granted on the corrupt bucket").toHaveLength(0);
    const reported = sentry.captureError.mock.calls.filter(([e, ctx]) => (e as { code?: string }).code === "ledger_negative" && (ctx as { orgId?: string }).orgId === r.orgId);
    expect(reported).toHaveLength(1);
  });
});

// R2008 (owner ruling 2026-10-19): the SYSTEM's refund of a session's go-live consume — what a composed stream that went live
// and never had a camera is returned. The SAME ledger, bucket and cap as the staff refund; written by no staff member.
describe.skipIf(!HAS_DB)("refundConsumeForSession — R2008: the platform returns a consume it should not have taken", () => {
  const system = (r: Awaited<ReturnType<typeof rig>>, sessionId: string, now: Date = new Date()) =>
    sql.begin(async (tx) => {
      const [s] = await tx<{ fixture_id: string | null }[]>`select fixture_id from fixture_stream_sessions where id = ${sessionId}`;
      return refundConsumeForSession(tx, { orgId: r.orgId, sessionId, fixtureId: s!.fixture_id, note: "R2008 unit" }, now);
    });
  const full = (orgId: string, sessionId: string) =>
    sql<(Row & { created_by: string | null; note: string | null })[]>`
      select reason, bucket, delta, balance_after, idempotency_key, session_id, created_by, note
        from org_stream_credits where org_id = ${orgId} and session_id = ${sessionId} order by created_at, balance_after desc`;

  it("a consume is returned to the bucket it was drawn from — a MONTHLY credit to monthly, a bought one to pack — as ONE row with no staff member and no key; balance_after is the org total plus one", async () => {
    const r = await rig(null);
    const R = await rateOf("community");
    await ensureMonthlyStreamGrant(r.orgId, JAN);
    await buy(r.orgId, 1);
    const sessions: { sessionId: string; bucket: string }[] = [];
    for (let i = 0; i < R + 1; i++) sessions.push(await consume(r));   // R from the free month, then the bought one
    expect([sessions[0]!.bucket, sessions.at(-1)!.bucket], "PREMISE: the two buckets the differential needs").toEqual(["monthly", "pack"]);
    expect(await creditBreakdown(sql, r.orgId)).toEqual({ monthly: 0, pack: 0, total: 0 });
    let checked = 0;
    for (const [i, c] of [sessions[0]!, sessions.at(-1)!].entries()) {
      const before = await creditBreakdown(sql, r.orgId);
      const out = await system(r, c.sessionId);
      expect(out, `${c.bucket}: written`).toMatchObject({ refunded: true, delta: 1, balance: before.total + 1 });
      expect(await full(r.orgId, c.sessionId), `${c.bucket}: the session's rows`).toEqual([
        expect.objectContaining({ reason: "consume", delta: -1, bucket: c.bucket }),
        { reason: "refund", delta: 1, bucket: c.bucket, balance_after: before.total + 1, idempotency_key: null, session_id: c.sessionId, created_by: null, note: "R2008 unit" },
      ]);
      const after = await creditBreakdown(sql, r.orgId);
      expect(after[c.bucket as "monthly" | "pack"], `${c.bucket}: that bucket gained exactly one`).toBe(before[c.bucket as "monthly" | "pack"] + 1);
      expect(after.total, "…and the total is creditBalance's").toBe(await creditBalance(sql, r.orgId));
      checked += i + 1;
    }
    expect(checked, "anti-vacuity: both buckets were returned").toBe(3);
  });

  it("EXACTLY ONCE: a second call writes nothing, whoever called first; a session with NO consume (a free restart) is owed nothing; and a staff refund after the system's is the ordinary cap's 422", async () => {
    const r = await rig(null);
    await ensureMonthlyStreamGrant(r.orgId, JAN);
    const c = await consume(r);
    const n0 = await rowCount(r.orgId);
    expect(await system(r, c.sessionId)).toMatchObject({ refunded: true });
    expect(await rowCount(r.orgId), "one row").toBe(n0 + 1);
    expect(await system(r, c.sessionId), "SECOND CALL").toMatchObject({ refunded: false, delta: 0, ledgerId: null });
    expect(await rowCount(r.orgId), "the second call wrote nothing").toBe(n0 + 1);
    await expect(refundCredits({ ...staff(r), delta: 1, sessionId: c.sessionId }), "the staff cap sees the system's refund").rejects.toMatchObject({ status: 422, code: "refund_exceeds_consumed" });
    // A staff refund FIRST: the system writes none.
    const d = await consume(r);
    await refundCredits({ ...staff(r), delta: 1, sessionId: d.sessionId });
    const n1 = await rowCount(r.orgId);
    expect(await system(r, d.sessionId), "after a staff refund").toMatchObject({ refunded: false });
    expect(await rowCount(r.orgId)).toBe(n1);
    // A session that never consumed (a free restart writes no row): nothing owed.
    const free = await r.session(r.fixtureIds[1]!, "completed");
    expect(await system(r, free), "no consume").toMatchObject({ refunded: false, delta: 0 });
    expect(await rowCount(r.orgId)).toBe(n1);
    // The balance: two refunds in all (the system's for c, the staff's for d), never a third.
    expect((await rows(r.orgId)).filter((x) => x.reason === "refund")).toHaveLength(2);
  });

  it("a session whose consumes span two buckets is refused by name (the staff writer's guard, shared), and nothing is written (k7)", async () => {
    const r = await rig(null);
    const s = await r.session(r.fixtureIds[0]!, "completed");
    await sql`insert into org_stream_credits (org_id, delta, reason, bucket, session_id, balance_after) values (${r.orgId}, 2, 'purchase', 'pack', null, 2)`;
    await sql`insert into org_stream_credits (org_id, delta, reason, bucket, session_id, balance_after) values (${r.orgId}, -1, 'consume', 'monthly', ${s}, 1)`;
    await sql`insert into org_stream_credits (org_id, delta, reason, bucket, session_id, balance_after) values (${r.orgId}, -1, 'consume', 'pack', ${s}, 0)`;
    const n = await rowCount(r.orgId);
    await expect(system(r, s)).rejects.toMatchObject({ status: 500, code: "refund_bucket_ambiguous" });
    expect(await rowCount(r.orgId)).toBe(n);
  });

  it("the amount is what is STILL owed — consumed minus refunded — not a constant one: two consumes return two; a staff refund of one of them leaves one", async () => {
    const r = await rig(null);
    const write = (sessionId: string, delta: number, reason: "consume" | "refund", bucket: "monthly" | "pack", after: number) =>
      sql`insert into org_stream_credits (org_id, delta, reason, bucket, session_id, balance_after) values (${r.orgId}, ${delta}, ${reason}, ${bucket}, ${sessionId}, ${after})`;
    await sql`insert into org_stream_credits (org_id, delta, reason, bucket, session_id, balance_after) values (${r.orgId}, 4, 'purchase', 'pack', null, 4)`;
    // Hand-written (no writer consumes twice for one session): the arithmetic is the writer's own, so it is pinned on the ledger.
    const two = await r.session(r.fixtureIds[0]!, "completed");
    await write(two, -1, "consume", "pack", 3);
    await write(two, -1, "consume", "pack", 2);
    expect(await system(r, two), "two consumes, none returned").toMatchObject({ refunded: true, delta: 2, balance: 4 });
    expect(await system(r, two), "and now nothing is owed").toMatchObject({ refunded: false, delta: 0 });
    const half = await r.session(r.fixtureIds[1]!, "completed");
    await write(half, -1, "consume", "pack", 3);
    await write(half, -1, "consume", "pack", 2);
    await write(half, 1, "refund", "pack", 3);   // a staff refund of one of the two
    expect(await system(r, half), "one of two already returned").toMatchObject({ refunded: true, delta: 1 });
    expect((await full(r.orgId, half)).filter((x) => x.reason === "refund").map((x) => x.delta), "two refund rows of one credit each").toEqual([1, 1]);
    expect(await creditBalance(sql, r.orgId)).toBe(await creditBreakdown(sql, r.orgId).then((b) => b.total));
  });

  it("A7: it takes the org's money lock FIRST — a refund issued while another writer holds the lock waits for it, and lands after", async () => {
    const r = await rig(null);
    await ensureMonthlyStreamGrant(r.orgId, JAN);
    const c = await consume(r);
    let release!: () => void;
    const mayCommit = new Promise<void>((res) => (release = res));
    let signalHeld!: (pid: number) => void;
    const held = new Promise<number>((res) => (signalHeld = res));
    const holder = sql.begin(async (tx) => {
      const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await lockOrg(tx, r.orgId);
      signalHeld(pid);
      await mayCommit;
    });
    const holderPid = await held;
    const refund = system(r, c.sessionId);
    expect(await advisoryWaitersBehind(holderPid, 1), "the refund queued on the org's money lock").toBe(1);
    release();
    await holder;
    expect(await refund).toMatchObject({ refunded: true });
  });

  // R2008 free-gaps (owner ruling 2026-10-20): at most NEVER_LIVE_REFUNDS_PER_WINDOW platform refunds of a never-live session per
  // FIXTURE per CREDIT_REUSE_HOURS. The session-level sequences are in stream-composed-free-gaps.test.ts; this is the LEDGER, case by
  // case, on the writer and on the standing the countdown also reads — each guard in the "earlier refund" query defeated by a case.
  describe("the cap — one never-live refund per fixture per reuse window", () => {
    const NOW = new Date("2031-05-10T12:00:00Z");
    const WINDOW_MIN = CREDIT_REUSE_HOURS * 60;
    /** An earlier session of `fixture` that failed `reason`, consumed a credit and had it returned `ageMin` minutes before NOW,
     *  by the platform (its own writer, the first on a clean ledger so never capped) or by a staff member. */
    async function earlier(r: Awaited<ReturnType<typeof rig>>, fixture: string, o: { reason: string; by: "platform" | "staff"; ageMin: number }): Promise<string> {
      const sid = await r.session(fixture, "failed");
      await sql`update fixture_stream_sessions set fail_reason = ${o.reason} where id = ${sid}`;
      await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: null, sessionId: sid }));
      if (o.by === "platform") expect(await system(r, sid, NOW), "PREMISE: the first refund on a clean ledger is written").toMatchObject({ refunded: true });
      else await refundCredits({ ...staff(r), delta: 1, sessionId: sid });
      await sql`update org_stream_credits set created_at = ${NOW}::timestamptz - make_interval(mins => ${o.ageMin}) where session_id = ${sid} and reason = 'refund'`;
      return sid;
    }
    /** The session being judged: it consumed a credit (or, `consumed: false`, was a free restart that took nothing). */
    async function judged(r: Awaited<ReturnType<typeof rig>>, fixture: string, consumed = true): Promise<string> {
      const sid = await r.session(fixture, "failed");
      await sql`update fixture_stream_sessions set fail_reason = 'camera_never_live' where id = ${sid}`;
      if (consumed) await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: null, sessionId: sid }));
      return sid;
    }
    const standing = (r: Awaited<ReturnType<typeof rig>>, sessionId: string, fixtureId: string | null) =>
      neverLiveRefundStanding(sql, { orgId: r.orgId, sessionId, fixtureId }, NOW);
    const ledgerRows = async (orgId: string) => (await rowCount(orgId));

    it("the window holds a platform never-live refund of THIS fixture a minute inside → withheld: nothing written, the standing says the charge stands; a minute past → refunded", async () => {
      let checked = 0;
      for (const [label, ageMin, capped] of [["a minute inside", WINDOW_MIN - 1, true], ["a minute past", WINDOW_MIN + 1, false]] as const) {
        const r = await rig(null);
        await buy(r.orgId, 4);
        const fa = r.fixtureIds[0]!;
        await earlier(r, fa, { reason: "camera_never_live", by: "platform", ageMin });
        const sid = await judged(r, fa);
        expect(await standing(r, sid, fa), `${label}: the standing`).toMatchObject({ owed: 1, capped, willRefund: !capped, chargeStands: capped });
        const n = await ledgerRows(r.orgId);
        const out = await system(r, sid, NOW);
        expect(out, `${label}: the writer`).toMatchObject(capped ? { refunded: false, delta: 0, ledgerId: null, withheld: true } : { refunded: true, delta: 1, withheld: false });
        expect(await ledgerRows(r.orgId), `${label}: rows written`).toBe(n + (capped ? 0 : 1));
        checked++;
      }
      expect(checked).toBe(2);
    });

    it("what is NOT an earlier never-live refund: another fixture's, a staff member's, one on a session that failed for another reason, and — for a session with no fixture — any at all", async () => {
      let checked = 0;
      // ANOTHER FIXTURE: A's refund does not cap B.
      const other = await rig(null);
      await buy(other.orgId, 4);
      await earlier(other, other.fixtureIds[0]!, { reason: "camera_never_live", by: "platform", ageMin: 1 });
      const onB = await judged(other, other.fixtureIds[1]!);
      expect(await standing(other, onB, other.fixtureIds[1]!), "another fixture").toMatchObject({ capped: false, willRefund: true });
      expect(await system(other, onB, NOW), "…and the writer").toMatchObject({ refunded: true });
      checked++;
      // A STAFF refund (created_by set) is the staff's goodwill: it never spends the platform's allowance.
      const staffR = await rig(null);
      await buy(staffR.orgId, 4);
      await earlier(staffR, staffR.fixtureIds[0]!, { reason: "camera_never_live", by: "staff", ageMin: 1 });
      const afterStaff = await judged(staffR, staffR.fixtureIds[0]!);
      expect(await standing(staffR, afterStaff, staffR.fixtureIds[0]!), "a staff refund").toMatchObject({ capped: false, willRefund: true });
      checked++;
      // A platform refund of a session that did NOT fail never-live is not a never-live refund.
      const reason = await rig(null);
      await buy(reason.orgId, 4);
      await earlier(reason, reason.fixtureIds[0]!, { reason: "output_failed", by: "platform", ageMin: 1 });
      const afterOther = await judged(reason, reason.fixtureIds[0]!);
      expect(await standing(reason, afterOther, reason.fixtureIds[0]!), "another failure's refund").toMatchObject({ capped: false, willRefund: true });
      checked++;
      // A session with NO fixture has no window to be capped in — however full this fixture's is (a fixture-less one is not asked).
      const none = await rig(null);
      await buy(none.orgId, 4);
      await earlier(none, none.fixtureIds[0]!, { reason: "camera_never_live", by: "platform", ageMin: 1 });
      const fixtureless = await judged(none, none.fixtureIds[0]!);
      expect(await standing(none, fixtureless, none.fixtureIds[0]!), "PREMISE: with its fixture the window is full").toMatchObject({ capped: true });
      expect(await standing(none, fixtureless, null), "without one it is not").toMatchObject({ capped: false, willRefund: true });
      checked++;
      expect(checked).toBe(4);
    });

    it("the three answers, and only three: nothing owed (a free restart, a refund already made) is neither refunded nor charged — even in a full window; owed in a room is refunded; owed in a full window is charged", async () => {
      const r = await rig(null);
      await buy(r.orgId, 6);
      const fa = r.fixtureIds[0]!;
      const free = await judged(r, fa, false);                                          // took nothing
      expect(await standing(r, free, fa), "a free restart, window EMPTY").toMatchObject({ owed: 0, capped: false, willRefund: false, chargeStands: false });
      const owedInRoom = await judged(r, fa);
      expect(await standing(r, owedInRoom, fa), "owed, window empty").toMatchObject({ owed: 1, willRefund: true, chargeStands: false });
      await earlier(r, fa, { reason: "camera_never_live", by: "platform", ageMin: 1 });  // the window is full from here on
      expect(await standing(r, owedInRoom, fa), "owed, window FULL").toMatchObject({ owed: 1, capped: true, willRefund: false, chargeStands: true });
      expect(await standing(r, free, fa), "a free restart, window FULL: still nothing owed, so still 'not charged'").toMatchObject({ owed: 0, capped: true, willRefund: false, chargeStands: false });
      await refundCredits({ ...staff(r), delta: 1, sessionId: owedInRoom });
      expect(await standing(r, owedInRoom, fa), "a staff refund made it nothing owed, window FULL").toMatchObject({ owed: 0, willRefund: false, chargeStands: false });
    });
  });
});
