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
//   k15 ensure's fast path deleted (always the full grant path)   → "a second ensure … costs ONE statement"
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql, statementCount } from "@/lib/db";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { streamRig } from "@/server/relay/__tests__/_session-rig";
import {
  NoCreditsError, consumeForSession, creditBalance, creditBreakdown, ensureMonthlyStreamGrant, ensureMonthlyStreamGrantsForAllOrgs,
  grantMonthlyStreamCredits, lockOrg, recordPurchase, recordStreamPackRefund, refundCredits, revokeCredits, streamMonthlyGrantKey,
  streamMonthlyPeriod, streamMonthlyRate,
} from "../stream-credits";

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
async function consume(r: Awaited<ReturnType<typeof rig>>): Promise<{ sessionId: string; bucket: string }> {
  const sessionId = await r.session(r.fixtureIds[0]!, "warming");
  const c = await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: null, sessionId }));
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
  it("every plan's grant equals ITS V426 row, read from the DB (a sweep over the plans table)", async () => {
    // A pass key is swept too: V426 declares a row for it, and this proves the grant READS that row. Production never
    // resolves an org's plan to a pass key (passes live in competition_passes, per competition) — recorded in the report.
    const plans = await sql<{ key: string }[]>`select key from plans order by key`;
    const rates = await ratesByPlan();
    let checked = 0;
    for (const { key: plan } of plans) {
      const r = await rig(plan, 1);
      const want = rates.get(plan);
      expect(want, `${plan} has a V426 row`).toBeGreaterThanOrEqual(1);
      expect(await streamMonthlyRate(r.orgId), plan).toBe(want);
      expect(await ensureMonthlyStreamGrant(r.orgId, JAN), plan).toBe(want);
      expect(await creditBreakdown(sql, r.orgId), plan).toEqual({ monthly: want, pack: 0, total: want });
      const [row] = await rows(r.orgId);
      expect(row, plan).toMatchObject({ reason: "grant", bucket: "monthly", delta: want, balance_after: want,
        idempotency_key: streamMonthlyGrantKey(r.orgId, "2031-01"), session_id: null });
      checked++;
    }
    expect(checked, "no plan was checked").toBeGreaterThan(0);
    expect(checked).toBe(plans.length);
  });

  it("an org with NO subscription row (a fresh signup) is community, and grants community's row", async () => {
    const r = await rig(null, 1);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from organizations where id = ${r.orgId} and subscription_id is not null`;
    expect(n, "premise: seedOrg writes no subscription").toBe(0);
    expect(await ensureMonthlyStreamGrant(r.orgId, JAN)).toBe(await rateOf("community"));
  });

  it("a second ensure in the same period writes 0 rows — on another day of the month too — and costs ONE statement", async () => {
    const r = await rig("pro", 1);
    const want = await rateOf("pro");
    expect(await ensureMonthlyStreamGrant(r.orgId, JAN)).toBe(want);
    const before = await rowCount(r.orgId);
    let checked = 0;
    for (const now of [JAN, JAN_LAST]) {
      const q = statementCount();
      expect(await ensureMonthlyStreamGrant(r.orgId, now)).toBe(0);
      expect(statementCount() - q, "cheap once this period's row exists: the key lookup and nothing else").toBe(1);
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

  it("the cron sweep grants every scoped org its plan's rate, once: a second run considers none of them", async () => {
    const a = await rig(null, 1);
    const b = await rig("pro", 1);
    const want = new Map([[a.orgId, await rateOf("community")], [b.orgId, await rateOf("pro")]]);
    const first = await ensureMonthlyStreamGrantsForAllOrgs({ orgIds: [a.orgId, b.orgId] });
    expect(first).toEqual({ orgs: 2, granted: want.get(a.orgId)! + want.get(b.orgId)!, failed: 0 });
    let checked = 0;
    for (const [orgId, n] of want) {
      expect((await creditBreakdown(sql, orgId)).monthly, orgId).toBe(n);
      checked++;
    }
    expect(checked).toBe(2);
    expect(await ensureMonthlyStreamGrantsForAllOrgs({ orgIds: [a.orgId, b.orgId] }), "the anti-join leaves nothing to do").toEqual({ orgs: 0, granted: 0, failed: 0 });
  });

  it("the sweep: an explicitly EMPTY scope grants nothing (never the every-org branch), and a soft-deleted org is skipped", async () => {
    expect(await ensureMonthlyStreamGrantsForAllOrgs({ orgIds: [] })).toEqual({ orgs: 0, granted: 0, failed: 0 });
    const gone = await rig(null, 1);
    const live = await rig(null, 1);
    await sql`update organizations set deleted_at = now() where id = ${gone.orgId}`;
    const res = await ensureMonthlyStreamGrantsForAllOrgs({ orgIds: [gone.orgId, live.orgId] });
    expect(res).toEqual({ orgs: 1, granted: await rateOf("community"), failed: 0 });
    expect(await rowCount(gone.orgId), "a deleted org is never granted").toBe(0);
    expect((await creditBreakdown(sql, live.orgId)).monthly, "the positive pair").toBe(await rateOf("community"));
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
});
