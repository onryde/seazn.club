// Online Chess package rows on the Seazn credits ledger (spec 2026-11-23-online-chess-credits-design.md §7.1, §7.4, P4, P6,
// P21). The pure halves (planDebit, planReturn) run without a database; everything else runs against a REAL migrated one
// and is skipped without DATABASE_URL.
//
// Where the expected numbers come from — never from the module under test:
//   * the debit order is P4 (included credits first) and the return order P21 (bought, then this month's included, then an
//     earlier month's included, which is forfeited);
//   * every package price is the plan's Global Constraints table, typed here (64 → 4, 128 → 8, 32 → 2 without cameras);
//   * every balance is the scenario's own arithmetic, written out beside the step that moves it.
//
// The month boundary: rows are dated by the database clock, so "paid last month" is the real ledger written now and then
// moved back one calendar month (the existing stream tests backdate ledger rows the same way), and "now" is the real now.
//
// single-sport: the ledger is sport-agnostic money, and online play is boardgame only (online-play.ts supportsOnlinePlay).
//
// Mutant table (each run once by hand; results in the commit message):
//   L1 planDebit draws pack first                         -> "planDebit differs from pack-first"
//   L2 planDebit's short check removed                    -> "planDebit refuses a debit the two buckets cannot cover"
//   L3 negative-monthly limb of ledger_negative removed   -> "planDebit refuses a negative bucket"
//   L4 negative-pack limb of ledger_negative removed      -> same test
//   L5 planReturn returns this month's included first     -> "planReturn (P21)"
//   L6 planReturn's exceeds check removed                 -> "planReturn refuses to return more than the package holds"
//   L7 planReturn's whole-count check on its inputs removed -> "planReturn refuses counts that are not counts"
//   L7b planReturn's positive-return check removed        -> same test
//   L8 the package-of-this-org check removed              -> "a package of another org is refused"
//   L9 refundForPackage's pack limb removed               -> "refundForPackage refuses more than a bucket can give back"
//   L10 refundForPackage's monthly limb reads ALL months  -> same test, and the month-boundary sequence
//   L11 debitForPackage takes no money lock               -> "each writer queues behind the org's money lock"
//   L12 refundForPackage takes no money lock              -> same test
//   L13 rollMonthlyUnderLock is a no-op                   -> "rollMonthlyUnderLock rolls the month in the caller's transaction"
//   L14 returnableFor counts every monthly row as this month -> "returnableFor"
//   L15 livePackage drops `for update`                    -> "livePackage forUpdate"
//   L16 livePackage's ladder assertion removed            -> "livePackage refuses a size off the ladder"
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { sql, withTenant, type Tx } from "@/lib/db";
import {
  creditBalance, creditBreakdown, grantMonthlyStreamCredits, lockOrg, recordPurchase, rollMonthlyUnderLock,
  streamMonthlyGrantKey, streamMonthlyPeriod, type StreamCreditBreakdown,
} from "@/server/usecases/stream-credits";
import {
  OnlineChessNoCreditsError, debitForPackage, livePackage, planDebit, planReturn, refundForPackage, returnableFor,
  type BucketSplit, type Returnable,
} from "@/server/usecases/online-package";

const HAS_DB = !!process.env.DATABASE_URL;

/** Global Constraints: "16→1/2, 32→2/4, 64→4/8, 128→8/16, 256→16/32 credits (without / with cameras)". */
const PRICE_32 = 2;
const PRICE_64 = 4;
const PRICE_128 = 8;

const NOW = new Date();
const THIS_PERIOD = streamMonthlyPeriod(NOW);
/** Mid-month, the calendar month before NOW's (UTC). */
const LAST_MONTH = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 15, 12));
/** The first instant of the calendar month after NOW's (UTC). */
const NEXT_MONTH = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 1, 0, 0, 1));

/** The organiser on a paid row (paid_by has no foreign key: spec §7.1). */
const PAYER = "00000000-0000-4000-8000-00000000c0de";

const split = (monthly: number, pack: number): StreamCreditBreakdown => ({ monthly, pack, total: monthly + pack });
const inTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => sql.begin(fn) as unknown as Promise<T>;
const suffix = (): string => randomUUID().replaceAll("-", "").slice(0, 12);

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

// ─── The pure halves ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("planDebit: included credits first (P4)", () => {
  it("planDebit: monthly 3 pack 5, debit 8 → {3,5}; debit 2 → {2,0}; monthly 0 → {0,n}", () => {
    const cases: [StreamCreditBreakdown, number, BucketSplit][] = [
      [split(3, 5), 8, { monthly: 3, pack: 5 }],
      [split(3, 5), 2, { monthly: 2, pack: 0 }],
      [split(3, 5), 3, { monthly: 3, pack: 0 }],
      [split(3, 5), 4, { monthly: 3, pack: 1 }],
      [split(0, 7), 4, { monthly: 0, pack: 4 }],
      [split(0, 7), 7, { monthly: 0, pack: 7 }],
      [split(6, 0), 6, { monthly: 6, pack: 0 }],
    ];
    let checked = 0;
    for (const [s, credits, want] of cases) {
      expect(planDebit(s, credits), `${JSON.stringify(s)} debit ${credits}`).toEqual(want);
      checked += 1;
    }
    expect(checked, "cases judged").toBe(cases.length);
  });

  it("planDebit differs from pack-first: monthly 1 pack 4, debit 2 → {1,1}", () => {
    const got = planDebit(split(1, 4), 2);
    expect(got).toEqual({ monthly: 1, pack: 1 });
    // The witness: a pack-first debit would answer {0, 2} here, and keep the expiring credit that P4 spends first.
    expect(got).not.toEqual({ monthly: 0, pack: 2 });
  });

  it("planDebit refuses a debit the two buckets cannot cover: 402 ONLINE_CHESS_NO_CREDITS with owed and balance — the empty ledger too", () => {
    const short: [StreamCreditBreakdown, number][] = [
      [split(1, 1), 3],
      [split(0, 0), 1], // the empty case: an org that never had a credit
      [split(4, 0), 5],
      [split(0, 4), 5],
    ];
    let checked = 0;
    for (const [s, credits] of short) {
      let caught: unknown;
      try {
        planDebit(s, credits);
      } catch (e) {
        caught = e;
      }
      expect(caught, `${JSON.stringify(s)} debit ${credits}`).toBeInstanceOf(OnlineChessNoCreditsError);
      expect(caught).toMatchObject({ status: 402, code: "ONLINE_CHESS_NO_CREDITS", extra: { owed: credits, balance: s.monthly + s.pack } });
      checked += 1;
    }
    expect(checked, "short debits judged").toBe(short.length);
    // and exactly enough is not short
    expect(planDebit(split(1, 1), 2)).toEqual({ monthly: 1, pack: 1 });
  });

  it("planDebit refuses a debit that is not a positive whole number of credits (never a 402: that is a bug upstream)", () => {
    const bad = [0, -1, 1.5, Number.NaN];
    let checked = 0;
    for (const credits of bad) {
      let caught: unknown;
      try {
        planDebit(split(3, 5), credits);
      } catch (e) {
        caught = e;
      }
      // The ledger's own refusal (relay/domain/credits.ts positiveInt), named — not any error at all.
      expect(caught, String(credits)).toMatchObject({ message: expect.stringMatching(/debit amount must be a positive integer/) });
      expect(caught, String(credits)).not.toBeInstanceOf(OnlineChessNoCreditsError);
      checked += 1;
    }
    expect(checked).toBe(bad.length);
  });

  it("planDebit refuses a negative bucket by name (ledger_negative), each limb on its own", () => {
    // A negative monthly bucket read as a number would be skipped and the whole debit drawn from the pack; a negative pack
    // would let the monthly bucket cover what the org total cannot. Both "cannot happen": no writer takes a bucket below 0.
    expect(() => planDebit(split(-1, 5), 1)).toThrow(expect.objectContaining({ status: 500, code: "ledger_negative" }));
    expect(() => planDebit(split(5, -1), 1)).toThrow(expect.objectContaining({ status: 500, code: "ledger_negative" }));
  });

  it("property: every debit the buckets cover is split exactly, never above a bucket, and the pack pays only once monthly is spent", () => {
    let runs = 0;
    fc.assert(
      fc.property(fc.nat(40), fc.nat(40), fc.integer({ min: 1, max: 80 }), (monthly, pack, credits) => {
        fc.pre(credits <= monthly + pack);
        runs += 1;
        const got = planDebit(split(monthly, pack), credits);
        expect(got.monthly + got.pack).toBe(credits);
        expect(got.monthly).toBeGreaterThanOrEqual(0);
        expect(got.pack).toBeGreaterThanOrEqual(0);
        expect(got.monthly).toBeLessThanOrEqual(monthly);
        expect(got.pack).toBeLessThanOrEqual(pack);
        // P4: a bought credit is drawn only when no included credit is left.
        if (got.pack > 0) expect(got.monthly).toBe(monthly);
      }),
      { numRuns: 300, seed: 20261123 },
    );
    expect(runs, "property runs that met the precondition").toBeGreaterThan(100);
  });
});

describe("planReturn: P21's order", () => {
  it("planReturn (P21): {pack 3, thisMonth 1, expired 2}, return 5 → {pack 3, monthly 1, forfeited 1}", () => {
    const r = (pack: number, monthlyThisMonth: number, monthlyExpired: number): Returnable => ({ pack, monthlyThisMonth, monthlyExpired });
    const cases: [Returnable, number, { pack: number; monthly: number; forfeited: number }][] = [
      [r(3, 1, 2), 5, { pack: 3, monthly: 1, forfeited: 1 }],
      [r(3, 1, 2), 2, { pack: 2, monthly: 0, forfeited: 0 }],
      [r(3, 1, 2), 4, { pack: 3, monthly: 1, forfeited: 0 }],
      [r(3, 1, 2), 6, { pack: 3, monthly: 1, forfeited: 2 }],
      [r(0, 2, 0), 1, { pack: 0, monthly: 1, forfeited: 0 }],
      [r(0, 0, 3), 3, { pack: 0, monthly: 0, forfeited: 3 }], // paid wholly from last month's included credits: nothing comes back
      [r(2, 0, 4), 3, { pack: 2, monthly: 0, forfeited: 1 }],
    ];
    let checked = 0;
    for (const [ret, credits, want] of cases) {
      expect(planReturn(ret, credits), `${JSON.stringify(ret)} return ${credits}`).toEqual(want);
      checked += 1;
    }
    expect(checked, "cases judged").toBe(cases.length);
  });

  it("planReturn refuses to return more than the package holds — the empty package too", () => {
    const over: [Returnable, number][] = [
      [{ pack: 3, monthlyThisMonth: 1, monthlyExpired: 2 }, 7],
      [{ pack: 0, monthlyThisMonth: 0, monthlyExpired: 0 }, 1], // the empty case
    ];
    let checked = 0;
    for (const [ret, credits] of over) {
      expect(() => planReturn(ret, credits), JSON.stringify(ret)).toThrow(expect.objectContaining({ status: 500, code: "online_package_return_exceeds_debit" }));
      checked += 1;
    }
    expect(checked).toBe(over.length);
  });

  it("planReturn refuses counts that are not counts: a return that is not a positive whole number, a part that is negative or fractional", () => {
    const ok: Returnable = { pack: 3, monthlyThisMonth: 1, monthlyExpired: 2 };
    const bad: [Returnable, number][] = [
      [ok, 0],
      [ok, -1],
      [ok, 1.5],
      [ok, Number.NaN],
      [{ ...ok, pack: -1 }, 1],
      [{ ...ok, monthlyThisMonth: -1 }, 1],
      [{ ...ok, monthlyExpired: -1 }, 1],
      [{ ...ok, pack: 0.5 }, 1],
    ];
    let checked = 0;
    for (const [ret, credits] of bad) {
      expect(() => planReturn(ret, credits), `${JSON.stringify(ret)} return ${credits}`).toThrow(RangeError);
      checked += 1;
    }
    expect(checked).toBe(bad.length);
  });

  it("property: every return the package holds is split exactly, bought first, then this month's included, and only then forfeited", () => {
    let runs = 0;
    fc.assert(
      fc.property(fc.nat(30), fc.nat(30), fc.nat(30), fc.integer({ min: 1, max: 90 }), (pack, thisMonth, expired, credits) => {
        fc.pre(credits <= pack + thisMonth + expired);
        runs += 1;
        const got = planReturn({ pack, monthlyThisMonth: thisMonth, monthlyExpired: expired }, credits);
        expect(got.pack + got.monthly + got.forfeited).toBe(credits);
        expect(got.pack).toBeLessThanOrEqual(pack);
        expect(got.monthly).toBeLessThanOrEqual(thisMonth);
        expect(got.forfeited).toBeLessThanOrEqual(expired);
        expect(Math.min(got.pack, got.monthly, got.forfeited)).toBeGreaterThanOrEqual(0);
        // P21: an included credit comes back only once every bought one has; one is forfeited only once this month's are back.
        if (got.monthly > 0) expect(got.pack).toBe(pack);
        if (got.forfeited > 0) expect(got.monthly).toBe(thisMonth);
      }),
      { numRuns: 300, seed: 20261123 },
    );
    expect(runs, "property runs that met the precondition").toBeGreaterThan(100);
  });
});

// ─── The database halves ──────────────────────────────────────────────────────────────────────────────────────────────

async function seedOrg(): Promise<string> {
  const s = suffix();
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${"OC Ledger " + s}, ${"oc-ledger-" + s}) returning id`;
  return o!.id;
}

async function seedDivision(orgId: string): Promise<{ id: string; name: string }> {
  const s = suffix();
  const [c] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility) values (${orgId}, ${"OC Cup " + s}, ${"oc-cup-" + s}, 'private') returning id`;
  const name = `Open ${s}`;
  const [d] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${c!.id}, ${name}, ${"oc-div-" + s}, 'boardgame', 'classical', ${sql.json({ onlinePlay: "lichess" } as never)}, '1.0.0')
    returning id`;
  return { id: d!.id, name };
}

/** An UNPAID package row at `size`, as chooseOnlineSize (Task 4) will write it. */
async function seedPackage(orgId: string, division: { id: string; name: string }, size = 64): Promise<string> {
  const [p] = await sql<{ id: string }[]>`
    insert into division_online_packages (org_id, division_id, division_name, size)
    values (${orgId}, ${division.id}, ${division.name}, ${size}) returning id`;
  return p!.id;
}

const buy = (orgId: string, n: number) => {
  const cs = `cs_oc_${suffix()}`;
  return recordPurchase({
    orgId, delta: n, stripeEventId: cs,
    link: { checkoutSessionId: cs, paymentIntentId: `pi_${cs}`, pack: `seazn_stream_pack_${n}`, amountMinor: 600, currency: "gbp" },
  });
};

type Rig = { orgId: string; divisionId: string; packageId: string };

/** An org holding `monthly` included credits (this month's grant, through the real rollover) and `pack` bought ones
 *  (a real purchase), with one division and its unpaid package. */
async function rig(o: { monthly: number; pack: number; at?: Date; size?: number }): Promise<Rig> {
  const orgId = await seedOrg();
  if (o.monthly > 0) await grantMonthlyStreamCredits(orgId, o.monthly, o.at ?? NOW);
  if (o.pack > 0) await buy(orgId, o.pack);
  expect(await creditBreakdown(sql, orgId), "premise: the org holds what the case says").toEqual(split(o.monthly, o.pack));
  const division = await seedDivision(orgId);
  const packageId = await seedPackage(orgId, division, o.size);
  return { orgId, divisionId: division.id, packageId };
}

interface LedgerRow {
  id: string; reason: string; bucket: string; delta: number; balance_after: number;
  online_package_id: string | null; session_id: string | null; created_by: string | null; idempotency_key: string | null;
}
const orgRows = (orgId: string) => sql<LedgerRow[]>`
  select id, reason, bucket, delta, balance_after, online_package_id, session_id, created_by, idempotency_key
    from org_stream_credits where org_id = ${orgId}`;
const rowIds = async (orgId: string) => new Set((await orgRows(orgId)).map((r) => r.id));
/** The rows a step wrote, as [reason, bucket, delta, balance_after], in bucket order (monthly before pack). */
const rowsSince = async (orgId: string, before: Set<string>) =>
  (await orgRows(orgId))
    .filter((r) => !before.has(r.id))
    .sort((a, b) => a.bucket.localeCompare(b.bucket) || a.reason.localeCompare(b.reason))
    .map((r) => [r.reason, r.bucket, r.delta, r.balance_after]);

/** The money read the spec owns (§7.1): the total is one figure however it is read, and the newest snapshot agrees. */
async function expectBalance(orgId: string, want: number, step: string): Promise<void> {
  const total = await creditBalance(sql, orgId);
  const parts = await creditBreakdown(sql, orgId);
  expect(total, `${step}: creditBalance`).toBe(want);
  expect(parts.total, `${step}: the breakdown's total is creditBalance`).toBe(total);
  expect(parts.monthly + parts.pack, `${step}: the buckets sum to the total`).toBe(total);
}

/** What Tasks 5 and 6 write on the package row after a step, in ONE statement (the V549 CHECKs hold per statement). */
const settlePackage = (id: string, s: { size: number; paid: number; refunded: number; forfeited: number; refundedAt?: Date | null }) => sql`
  update division_online_packages
     set size = ${s.size}, cameras_paid = false, credits_paid = ${s.paid}, credits_refunded = ${s.refunded},
         credits_forfeited = ${s.forfeited}, paid_at = coalesce(paid_at, now()), paid_by = coalesce(paid_by, ${PAYER}::uuid),
         refunded_at = ${s.refundedAt ?? null}
   where id = ${id}`;

/** Spec §7.1's first invariant: credits_paid − credits_refunded equals the negated sum of the package's ledger rows. */
async function expectPackageInvariant(packageId: string, wantNet: number, step: string): Promise<void> {
  const [row] = await sql<{ paid: number; refunded: number; ledger: number }[]>`
    select p.credits_paid as paid, p.credits_refunded as refunded,
           (select coalesce(-sum(delta), 0)::int from org_stream_credits where online_package_id = p.id) as ledger
      from division_online_packages p where p.id = ${packageId}`;
  expect(row!.ledger, `${step}: the package's ledger rows net to what it holds`).toBe(wantNet);
  expect(row!.paid - row!.refunded, `${step}: credits_paid − credits_refunded = −sum(package rows)`).toBe(row!.ledger);
}

/** Move every ledger row the org has so far back one calendar month: "this was written last month". The month is
 *  subtracted on the UTC wall clock: the local database runs in Europe/London, where `created_at - interval '1 month'`
 *  takes a row written in the last BST hour of a UTC month to the 1st of that SAME UTC month. */
const backdateOrgLedger = (orgId: string) =>
  sql`update org_stream_credits set created_at = (created_at at time zone 'UTC' - interval '1 month') at time zone 'UTC'
       where org_id = ${orgId}`;

async function advisoryWaitersBehind(holderPid: number, want: number, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_locks
       where locktype = 'advisory' and not granted and ${holderPid} = any(pg_blocking_pids(pid))`;
    if (row!.n >= want || Date.now() >= deadline) return row!.n;
    await new Promise((res) => setTimeout(res, 25));
  }
}

describe.skipIf(!HAS_DB)("debitForPackage: package consumes on the ledger", () => {
  it("debitForPackage spanning both buckets writes two rows whose balance_after end at total − credits", async () => {
    const r = await rig({ monthly: 3, pack: 5 });
    // One bucket: 2 of the 3 included credits, ONE row (no zero-delta pack row).
    let before = await rowIds(r.orgId);
    expect(await inTx((tx) => debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits: 2 }))).toEqual({ monthly: 2, pack: 0 });
    expect(await rowsSince(r.orgId, before)).toEqual([["consume", "monthly", -2, 6]]);
    // Both buckets: the last included credit, then 5 bought; the snapshots run 6 → 5 → 0, and 0 = 8 − 2 − 6.
    before = await rowIds(r.orgId);
    expect(await inTx((tx) => debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits: 6 }))).toEqual({ monthly: 1, pack: 5 });
    expect(await rowsSince(r.orgId, before)).toEqual([["consume", "monthly", -1, 5], ["consume", "pack", -5, 0]]);
    await expectBalance(r.orgId, 8 - 2 - 6, "after both debits");
    expect(await creditBreakdown(sql, r.orgId)).toEqual(split(0, 0));
    // Every row names the package and nothing else: no session, no staff author, no key (spec §7.1).
    const mine = (await orgRows(r.orgId)).filter((x) => x.reason === "consume");
    expect(mine.length, "anti-vacuity: the package's rows were read").toBe(3);
    for (const x of mine) {
      expect(x).toMatchObject({ online_package_id: r.packageId, session_id: null, created_by: null, idempotency_key: null });
    }
  });

  it("a short balance answers 402 ONLINE_CHESS_NO_CREDITS and writes nothing — on a short org and on an org with an empty ledger", async () => {
    const short = await rig({ monthly: 1, pack: 1 });
    const empty = await rig({ monthly: 0, pack: 0 });
    const cases: [Rig, number, number][] = [
      [short, 3, 2],
      [empty, 1, 0],
    ];
    let checked = 0;
    for (const [r, credits, balance] of cases) {
      const before = await rowIds(r.orgId);
      await expect(inTx((tx) => debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits })))
        .rejects.toMatchObject({ status: 402, code: "ONLINE_CHESS_NO_CREDITS", extra: { owed: credits, balance } });
      expect(await rowsSince(r.orgId, before), "nothing written").toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it("a package of another org — or no package at all — is refused by debit and refund alike, and nothing is written", async () => {
    const a = await rig({ monthly: 2, pack: 2 });
    const b = await rig({ monthly: 0, pack: 0 });
    // A credit of A's on its own package, so a refund naming B's package would have something to return if it were let through.
    await inTx((tx) => debitForPackage(tx, { orgId: a.orgId, packageId: a.packageId, credits: 1 }));
    const foreign = [b.packageId, randomUUID()];
    let checked = 0;
    for (const packageId of foreign) {
      const before = await rowIds(a.orgId);
      await expect(inTx((tx) => debitForPackage(tx, { orgId: a.orgId, packageId, credits: 1 })), `debit ${packageId}`)
        .rejects.toMatchObject({ status: 500, code: "online_package_not_of_org" });
      await expect(inTx((tx) => refundForPackage(tx, { orgId: a.orgId, packageId, pack: 0, monthly: 1 })), `refund ${packageId}`)
        .rejects.toMatchObject({ status: 500, code: "online_package_not_of_org" });
      expect(await rowsSince(a.orgId, before), "nothing written").toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(foreign.length);
    // The org id is compared however it is spelled: an upper-case id of the owning org is not "another org".
    expect(await inTx((tx) => debitForPackage(tx, { orgId: a.orgId.toUpperCase(), packageId: a.packageId, credits: 1 }))).toEqual({ monthly: 1, pack: 0 });
  });
});

describe.skipIf(!HAS_DB)("returnableFor and refundForPackage", () => {
  it("returnableFor: pack consumes minus pack refunds; monthly split by UTC month of the consume", async () => {
    const r = await rig({ monthly: 3, pack: 5 });
    // The empty case first: a package with no rows can give back nothing.
    expect(await inTx((tx) => returnableFor(tx, r, NOW))).toEqual({ pack: 0, monthlyThisMonth: 0, monthlyExpired: 0 });
    await inTx((tx) => debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits: 5 })); // {3, 2}
    // A second package of the same org: its rows are its own.
    const other = await seedPackage(r.orgId, await seedDivision(r.orgId), 16);
    await inTx((tx) => debitForPackage(tx, { orgId: r.orgId, packageId: other, credits: 1 })); // {0, 1}
    expect(await inTx((tx) => returnableFor(tx, r, NOW)), "this month").toEqual({ pack: 2, monthlyThisMonth: 3, monthlyExpired: 0 });
    // The same rows asked about from next month: the included credits' month has ended.
    expect(await inTx((tx) => returnableFor(tx, r, NEXT_MONTH)), "from next month").toEqual({ pack: 2, monthlyThisMonth: 0, monthlyExpired: 3 });
    // Refunds net: 1 bought and 2 included back.
    await inTx((tx) => refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, pack: 1, monthly: 2 }));
    expect(await inTx((tx) => returnableFor(tx, r, NOW)), "after a refund").toEqual({ pack: 1, monthlyThisMonth: 1, monthlyExpired: 0 });
    expect(await inTx((tx) => returnableFor(tx, { orgId: r.orgId, packageId: other }, NOW)), "the other package").toEqual({ pack: 1, monthlyThisMonth: 0, monthlyExpired: 0 });
  });

  it("refundForPackage returns each credit to its own bucket", async () => {
    const r = await rig({ monthly: 2, pack: 3 });
    await inTx((tx) => debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits: 4 })); // {2, 2} → total 1
    expect(await creditBreakdown(sql, r.orgId)).toEqual(split(0, 1));
    const before = await rowIds(r.orgId);
    await inTx((tx) => refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, pack: 2, monthly: 1 }));
    // Bought first (P21), each to its own bucket; snapshots 1 → 3 → 4.
    expect(await rowsSince(r.orgId, before)).toEqual([["refund", "monthly", 1, 4], ["refund", "pack", 2, 3]]);
    expect(await creditBreakdown(sql, r.orgId)).toEqual(split(1, 3));
    const refunds = (await orgRows(r.orgId)).filter((x) => x.reason === "refund");
    expect(refunds.length, "anti-vacuity").toBe(2);
    for (const x of refunds) {
      // created_by null is how the stream code tells a platform refund from staff (stream-credits.ts, spec §7.1).
      expect(x).toMatchObject({ online_package_id: r.packageId, session_id: null, created_by: null, idempotency_key: null });
    }
    // Nothing to return (everything forfeited) writes nothing: V410 refuses a zero delta, so no row is the only answer.
    const quiet = await rowIds(r.orgId);
    await inTx((tx) => refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, pack: 0, monthly: 0 }));
    expect(await rowsSince(r.orgId, quiet)).toEqual([]);
  });

  it("refundForPackage refuses more than a bucket can give back, each bucket on its own, and a count that is not a count", async () => {
    const r = await rig({ monthly: 2, pack: 3 });
    await inTx((tx) => debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits: 4 })); // {2, 2}
    const over: [string, { pack: number; monthly: number }, string][] = [
      ["pack limb", { pack: 3, monthly: 0 }, "online_package_return_exceeds_debit"],
      ["monthly limb", { pack: 0, monthly: 3 }, "online_package_return_exceeds_debit"],
      ["both at once", { pack: 3, monthly: 3 }, "online_package_return_exceeds_debit"],
    ];
    let checked = 0;
    for (const [name, parts, code] of over) {
      const before = await rowIds(r.orgId);
      await expect(inTx((tx) => refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, ...parts })), name)
        .rejects.toMatchObject({ status: 500, code });
      expect(await rowsSince(r.orgId, before), `${name}: nothing written`).toEqual([]);
      checked += 1;
    }
    for (const parts of [{ pack: -1, monthly: 0 }, { pack: 0, monthly: 1.5 }, { pack: Number.NaN, monthly: 0 }]) {
      const before = await rowIds(r.orgId);
      await expect(inTx((tx) => refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, ...parts })), JSON.stringify(parts)).rejects.toThrow();
      expect(await rowsSince(r.orgId, before)).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(6);
    // The exact amounts still go through.
    await inTx((tx) => refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, pack: 2, monthly: 2 }));
    expect(await creditBreakdown(sql, r.orgId)).toEqual(split(2, 3));
  });
});

describe.skipIf(!HAS_DB)("sequences", () => {
  it("creditBalance equals the breakdown total after every step of debit → debit → refund → debit", async () => {
    const r = await rig({ monthly: 2, pack: 6 }); // 8
    const steps: [string, () => Promise<unknown>, (string | number)[][], number][] = [
      ["first debit (3)", () => inTx((tx) => debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits: 3 })),
        [["consume", "monthly", -2, 6], ["consume", "pack", -1, 5]], 5],
      ["second debit (2): the included credits are gone, so the pack pays", () => inTx((tx) => debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits: 2 })),
        [["consume", "pack", -2, 3]], 3],
      ["refund 4 in P21's order: 3 bought, then 1 included", async () => {
        const ret = await inTx((tx) => returnableFor(tx, r, NOW));
        expect(ret).toEqual({ pack: 3, monthlyThisMonth: 2, monthlyExpired: 0 });
        const plan = planReturn(ret, 4);
        expect(plan).toEqual({ pack: 3, monthly: 1, forfeited: 0 });
        await inTx((tx) => refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, pack: plan.pack, monthly: plan.monthly }));
      }, [["refund", "monthly", 1, 7], ["refund", "pack", 3, 6]], 7],
      ["a debit after the refund (2): the returned included credit is spent first again", () => inTx((tx) => debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits: 2 })),
        [["consume", "monthly", -1, 6], ["consume", "pack", -1, 5]], 5],
    ];
    let checked = 0;
    for (const [name, run, wantRows, wantTotal] of steps) {
      const before = await rowIds(r.orgId);
      await run();
      expect(await rowsSince(r.orgId, before), name).toEqual(wantRows);
      await expectBalance(r.orgId, wantTotal, name);
      checked += 1;
    }
    expect(checked, "steps checked").toBe(steps.length);
  });

  it("across the UTC month boundary: bought and this month's included credits return, last month's are forfeited, and the writer refuses to return one", async () => {
    // Last month: 3 included + 5 bought; pay for 64 (4 credits) → 3 included + 1 bought.
    const r = await rig({ monthly: 3, pack: 5, at: LAST_MONTH }); // 8
    let checked = 0;
    let before = await rowIds(r.orgId);
    expect(await inTx((tx) => debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits: PRICE_64 }))).toEqual({ monthly: 3, pack: 1 });
    expect(await rowsSince(r.orgId, before)).toEqual([["consume", "monthly", -3, 5], ["consume", "pack", -1, 4]]);
    await settlePackage(r.packageId, { size: 64, paid: PRICE_64, refunded: 0, forfeited: 0 });
    await expectBalance(r.orgId, 4, "paid 64 last month");
    await expectPackageInvariant(r.packageId, 4, "paid 64 last month");
    checked += 1;
    await backdateOrgLedger(r.orgId);

    // This month: the rollover first (nothing included is left to expire; this month's 3 are granted), then the upgrade to
    // 128 costs the difference, 8 − 4 = 4 → 3 included + 1 bought.
    before = await rowIds(r.orgId);
    const upgrade = await inTx(async (tx) => {
      await lockOrg(tx, r.orgId);
      await rollMonthlyUnderLock(tx, r.orgId, 3, NOW);
      return debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits: PRICE_128 - PRICE_64 });
    });
    expect(upgrade).toEqual({ monthly: 3, pack: 1 });
    expect(await rowsSince(r.orgId, before)).toEqual([["consume", "monthly", -3, 4], ["grant", "monthly", 3, 7], ["consume", "pack", -1, 3]]);
    await settlePackage(r.packageId, { size: 128, paid: PRICE_128, refunded: 0, forfeited: 0 });
    await expectBalance(r.orgId, 3, "upgraded to 128 this month");
    await expectPackageInvariant(r.packageId, 8, "upgraded to 128 this month");
    checked += 1;

    // Move down to 32: the value falls 8 → 2, so 6 go back in P21's order: 2 bought, 3 of this month's included, and 1 of
    // last month's included is forfeited (counted, nothing written).
    const ret = await inTx((tx) => returnableFor(tx, r, NOW));
    expect(ret).toEqual({ pack: 2, monthlyThisMonth: 3, monthlyExpired: 3 });
    const down = planReturn(ret, PRICE_128 - PRICE_32);
    expect(down).toEqual({ pack: 2, monthly: 3, forfeited: 1 });
    before = await rowIds(r.orgId);
    await inTx((tx) => refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, pack: down.pack, monthly: down.monthly }));
    expect(await rowsSince(r.orgId, before)).toEqual([["refund", "monthly", 3, 8], ["refund", "pack", 2, 5]]);
    await settlePackage(r.packageId, { size: 32, paid: PRICE_128, refunded: 5, forfeited: 1 });
    await expectBalance(r.orgId, 8, "moved down to 32");
    await expectPackageInvariant(r.packageId, 3, "moved down to 32");
    // The row's value is the new size's price (spec §7.1's second invariant).
    const [v] = await sql<{ value: number }[]>`
      select credits_paid - credits_refunded - credits_forfeited as value from division_online_packages where id = ${r.packageId}`;
    expect(v!.value, "credits_paid − credits_refunded − credits_forfeited = price(32)").toBe(PRICE_32);
    checked += 1;

    // An included credit from last month cannot be refunded: the writer itself refuses it.
    const left = await inTx((tx) => returnableFor(tx, r, NOW));
    expect(left).toEqual({ pack: 0, monthlyThisMonth: 0, monthlyExpired: 3 });
    before = await rowIds(r.orgId);
    await expect(inTx((tx) => refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, pack: 0, monthly: 1 })))
      .rejects.toMatchObject({ status: 500, code: "online_package_return_exceeds_debit" });
    expect(await rowsSince(r.orgId, before)).toEqual([]);

    // The full refund (the division deleted before round 1): the value left is 2, and the caller nets the 1 already
    // forfeited off last month's 3, so both are forfeited and nothing is written. refunded_at, credits_refunded and
    // credits_forfeited are set in ONE statement (V549: refunded ⇒ refunded + forfeited = paid).
    const full = planReturn({ ...left, monthlyExpired: left.monthlyExpired - 1 /* the row's credits_forfeited */ }, PRICE_32);
    expect(full).toEqual({ pack: 0, monthly: 0, forfeited: 2 });
    before = await rowIds(r.orgId);
    await inTx((tx) => refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, pack: full.pack, monthly: full.monthly }));
    expect(await rowsSince(r.orgId, before)).toEqual([]);
    await settlePackage(r.packageId, { size: 32, paid: PRICE_128, refunded: 5, forfeited: 1 + 2, refundedAt: new Date() });
    await expectBalance(r.orgId, 8, "refunded in full");
    await expectPackageInvariant(r.packageId, 3, "refunded in full");
    checked += 1;
    expect(checked, "steps checked").toBe(4);
  });
});

describe.skipIf(!HAS_DB)("locks and the rollover", () => {
  it("each writer queues behind the org's money lock held by another transaction: debit, refund and the rollover take it themselves", async () => {
    const writers: [string, (tx: Tx, r: Rig) => Promise<unknown>][] = [
      ["debitForPackage", (tx, r) => debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits: 1 })],
      ["refundForPackage", (tx, r) => refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, pack: 1, monthly: 0 })],
      ["rollMonthlyUnderLock", (tx, r) => rollMonthlyUnderLock(tx, r.orgId, 1, NOW)],
    ];
    let checked = 0;
    for (const [name, write] of writers) {
      const r = await rig({ monthly: 0, pack: 3 });
      if (name === "refundForPackage") await inTx((tx) => debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits: 1 }));
      let release!: () => void;
      const released = new Promise<void>((res) => (release = res));
      let signalHeld!: (pid: number) => void;
      const held = new Promise<number>((res) => (signalHeld = res));
      const holder = inTx(async (tx) => {
        await lockOrg(tx, r.orgId);
        const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        signalHeld(pid);
        await released;
      });
      const holderPid = await held;
      // The racer does NOT take the lock first: the writer must take it on its own.
      const racer = inTx((tx) => write(tx, r));
      const blocked = await advisoryWaitersBehind(holderPid, 1);
      release();
      await holder;
      await racer;
      expect(blocked, `${name} queued on the money lock`).toBe(1);
      checked += 1;
    }
    expect(checked, "writers checked").toBe(writers.length);
  });

  it("rollMonthlyUnderLock rolls the month in the caller's transaction: last month's leftover expires, this month is granted once, and a rolled-back caller leaves nothing", async () => {
    const r = await rig({ monthly: 2, pack: 0, at: LAST_MONTH });
    let before = await rowIds(r.orgId);
    await inTx(async (tx) => {
      await lockOrg(tx, r.orgId);
      await rollMonthlyUnderLock(tx, r.orgId, 3, NOW);
    });
    expect(await rowsSince(r.orgId, before)).toEqual([["expire", "monthly", -2, 0], ["grant", "monthly", 3, 3]]);
    const [grant] = (await orgRows(r.orgId)).filter((x) => !before.has(x.id) && x.reason === "grant");
    expect(grant!.idempotency_key, "this month's grant key").toBe(streamMonthlyGrantKey(r.orgId, THIS_PERIOD));
    // A second call in the same month writes nothing.
    before = await rowIds(r.orgId);
    await inTx((tx) => rollMonthlyUnderLock(tx, r.orgId, 3, NOW));
    expect(await rowsSince(r.orgId, before)).toEqual([]);
    // A caller that rolls back takes the rollover with it.
    const s = await rig({ monthly: 2, pack: 0, at: LAST_MONTH });
    const sBefore = await rowIds(s.orgId);
    const ROLLBACK = new Error("rollback");
    await expect(inTx(async (tx) => {
      await rollMonthlyUnderLock(tx, s.orgId, 3, NOW);
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
    expect(await rowsSince(s.orgId, sBefore)).toEqual([]);
    expect(await creditBreakdown(sql, s.orgId)).toEqual(split(2, 0));
  });
});

describe.skipIf(!HAS_DB)("livePackage", () => {
  it("reads the division's one live row — unpaid or refunded-then-replaced — and null when there is none; the tenant role reads its own org's only", async () => {
    const orgId = await seedOrg();
    const division = await seedDivision(orgId);
    // The empty case first: no package at all.
    expect(await livePackage(sql, division.id)).toBeNull();
    // A refunded row alone is history, not live.
    const [old] = await sql<{ id: string }[]>`
      insert into division_online_packages (org_id, division_id, division_name, size, cameras_paid, credits_paid, credits_refunded, paid_at, paid_by, refunded_at)
      values (${orgId}, ${division.id}, ${division.name}, 32, false, 2, 2, now(), ${PAYER}, now()) returning id`;
    expect(await livePackage(sql, division.id), "only a refunded row").toBeNull();
    // A live unpaid row beside it is the one read, every field mapped.
    const live = await seedPackage(orgId, division, 128);
    const got = await livePackage(sql, division.id);
    expect(got).toMatchObject({
      id: live, orgId, divisionId: division.id, divisionName: division.name, size: 128, camerasPaid: null,
      creditsPaid: 0, creditsRefunded: 0, creditsForfeited: 0, paidAt: null, paidBy: null, frozenAt: null, refundedAt: null,
    });
    expect(got!.id).not.toBe(old!.id);
    expect(got!.createdAt).toBeInstanceOf(Date);
    // The tenant role (the cap doors and the strip run as app_user): its own org's row, and nothing of another org's.
    const stranger = await seedOrg();
    expect((await withTenant(orgId, (tx) => livePackage(tx, division.id)))?.id).toBe(live);
    expect(await withTenant(stranger, (tx) => livePackage(tx, division.id))).toBeNull();
  });

  it("livePackage forUpdate locks the row for the caller's transaction; a plain read does not", async () => {
    const r = await rig({ monthly: 0, pack: 0 });
    const probe = () => sql`select id from division_online_packages where id = ${r.packageId} for update nowait`;
    const cases: [string, boolean][] = [["forUpdate", true], ["plain read", false]];
    let checked = 0;
    for (const [name, forUpdate] of cases) {
      let release!: () => void;
      const released = new Promise<void>((res) => (release = res));
      let signalRead!: () => void;
      const read = new Promise<void>((res) => (signalRead = res));
      const holder = inTx(async (tx) => {
        expect((await livePackage(tx, r.divisionId, { forUpdate }))?.id).toBe(r.packageId);
        signalRead();
        await released;
      });
      await read;
      const outcome = await probe().then(() => "free", (e: { code?: string }) => e.code);
      release();
      await holder;
      expect(outcome, name).toBe(forUpdate ? "55P03" : "free"); // 55P03 lock_not_available
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it("livePackage refuses a size off the ladder by name before anything can price it (the CHECK dropped inside a rolled-back transaction)", async () => {
    const orgId = await seedOrg();
    const division = await seedDivision(orgId);
    const ROLLBACK = new Error("rollback");
    let caught: unknown;
    await expect(inTx(async (tx) => {
      await tx`alter table division_online_packages drop constraint division_online_packages_size_check`;
      await tx`insert into division_online_packages (org_id, division_id, division_name, size)
               values (${orgId}, ${division.id}, ${division.name}, 48)`;
      try {
        await livePackage(tx, division.id);
      } catch (e) {
        caught = e;
      }
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
    expect(caught).toMatchObject({ status: 500, code: "online_package_size_invalid" });
    // The rollback restored the CHECK: an off-ladder size is refused by the schema again.
    await expect(sql`insert into division_online_packages (org_id, division_id, division_name, size) values (${orgId}, ${division.id}, ${division.name}, 48)`)
      .rejects.toMatchObject({ code: "23514" });
  });
});
