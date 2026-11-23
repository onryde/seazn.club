// Online Chess package rows on the Seazn credits ledger (spec 2026-11-23-online-chess-credits-design.md §7.1, §7.4, P4, P6,
// P21). The pure halves (planDebit, planReturn) run without a database; everything else runs against a REAL migrated one
// and is skipped without DATABASE_URL.
//
// Where the expected numbers come from — never from the module under test:
//   * the debit order is P4 (included credits first) and the return order P21 (bought, then this month's included, then an
//     earlier month's included, which is forfeited);
//   * the rollover a debit runs first is the stream ledger's own rule (stream-credits.ts rollMonthlyLocked's contract: a
//     new UTC month expires the monthly leftover, then grants the plan's rate under that month's key);
//   * every package price is the plan's Global Constraints table, typed here (64 → 4, 128 → 8, 32 → 2 without cameras);
//   * every balance is the scenario's own arithmetic, written out beside the step that moves it.
//
// ONE clock, the database's: every ledger row is dated by its transaction's now(), and the writers read "this month" from
// that same now(). So "last month" here is the real ledger written now and then moved back one calendar month in UTC —
// the dates AND the monthly grant's key, which names its month (`backdateOrgLedger`) — and "this month" is the database's.
// No test hands a writer a clock; the two that try (`@ts-expect-error`) prove a handed-in clock changes nothing.
//
// single-sport: the ledger is sport-agnostic money, and online play is boardgame only (online-play.ts supportsOnlinePlay).
//
// Mutant table (each run once by hand; results in the commit messages):
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
//   L11 debitForPackage takes no money lock               -> "each writer queues behind the org's money lock", the race
//   L12 refundForPackage takes no money lock              -> "each writer queues behind the org's money lock"
//   L13 rollMonthlyUnderLock is a no-op                   -> "rollMonthlyUnderLock rolls the month", "debitForPackage rolls the month itself"
//   L14 returnableFor counts every monthly row as this month -> "returnableFor"
//   L15 livePackage drops `for update`                    -> "livePackage forUpdate"
//   L16 livePackage's ladder assertion removed            -> "livePackage refuses a size off the ladder"
//   Fix round 1:
//   F1 debitForPackage does not roll the month            -> "debitForPackage rolls the month itself"
//   F2 debitForPackage rolls at a JS clock, not now()     -> same test (the grant's key names the wrong month)
//   F3 refundForPackage honours a caller's clock          -> "ONE clock"
//   F4 returnableFor honours a caller's clock             -> same test
//   F5 the refunded-row check removed                     -> "a debit on a refunded package", "a refund on a refunded package"
//   F6 the frozen-row check removed                       -> "a refund on a frozen package"
//   F7 the frozen-row check refuses a debit too           -> same test (an upgrade after the freeze still pays)
//   F8 refundForPackage's monthly count check removed     -> "refundForPackage checks both counts before anything"
//   F9 refundForPackage's pack count check removed        -> same test
//   F10 the count checks run after the lock and the package read -> same test (a foreign package answers the count)
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/** The DATABASE's clock at the start of the file, and the UTC months either side of it (set in beforeAll). */
let DB_NOW: Date;
let THIS_PERIOD: string;
let LAST_PERIOD: string;
/** Mid-month of the calendar month before DB_NOW's (UTC): a JS clock inside the month the backdated rows land in. */
let LAST_MONTH: Date;

/** The organiser on a paid row (paid_by has no foreign key: spec §7.1). */
const PAYER = "00000000-0000-4000-8000-00000000c0de";

const split = (monthly: number, pack: number): StreamCreditBreakdown => ({ monthly, pack, total: monthly + pack });
const inTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => sql.begin(fn) as unknown as Promise<T>;
const suffix = (): string => randomUUID().replaceAll("-", "").slice(0, 12);
const txNow = async (tx: Tx): Promise<Date> => (await tx<{ now: Date }[]>`select now() as now`)[0]!.now;

beforeAll(async () => {
  if (!HAS_DB) return;
  DB_NOW = (await sql<{ now: Date }[]>`select now() as now`)[0]!.now;
  THIS_PERIOD = streamMonthlyPeriod(DB_NOW);
  LAST_MONTH = new Date(Date.UTC(DB_NOW.getUTCFullYear(), DB_NOW.getUTCMonth() - 1, 15, 12));
  LAST_PERIOD = streamMonthlyPeriod(LAST_MONTH);
  expect(LAST_PERIOD, "premise: two different months").not.toBe(THIS_PERIOD);
});

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

interface LedgerRow {
  id: string; reason: string; bucket: string; delta: number; balance_after: number;
  online_package_id: string | null; session_id: string | null; created_by: string | null; idempotency_key: string | null;
}
const orgRows = (orgId: string) => sql<LedgerRow[]>`
  select id, reason, bucket, delta, balance_after, online_package_id, session_id, created_by, idempotency_key
    from org_stream_credits where org_id = ${orgId}`;
const rowIds = async (orgId: string) => new Set((await orgRows(orgId)).map((r) => r.id));
/** The rows a step wrote, as [reason, bucket, delta, balance_after], in bucket order (monthly before pack), then reason. */
const rowsSince = async (orgId: string, before: Set<string>) =>
  (await orgRows(orgId))
    .filter((r) => !before.has(r.id))
    .sort((a, b) => a.bucket.localeCompare(b.bucket) || a.reason.localeCompare(b.reason))
    .map((r) => [r.reason, r.bucket, r.delta, r.balance_after]);

/** Move every ledger row the org has so far back one calendar month: "this was written last month". Both halves of a
 *  row's month move: its date, subtracted on the UTC wall clock (the local database runs in Europe/London, where
 *  `created_at - interval '1 month'` takes a row written in the last BST hour of a UTC month to the 1st of that SAME UTC
 *  month), and the monthly grant's idempotency key, which NAMES its month (`stream-monthly:{org}:{YYYY-MM}`, read by the
 *  rollover to decide whether this month is granted). */
async function backdateOrgLedger(orgId: string): Promise<void> {
  const thisKey = streamMonthlyGrantKey(orgId, THIS_PERIOD);
  const lastKey = streamMonthlyGrantKey(orgId, LAST_PERIOD);
  await sql`
    update org_stream_credits
       set created_at = (created_at at time zone 'UTC' - interval '1 month') at time zone 'UTC',
           idempotency_key = case when starts_with(idempotency_key, ${thisKey}::text)
                                  then ${lastKey}::text || substr(idempotency_key, ${thisKey.length + 1}::int)
                                  else idempotency_key end
     where org_id = ${orgId}`;
  const [left] = await sql<{ n: number }[]>`
    select count(*)::int as n from org_stream_credits
     where org_id = ${orgId}
       and (to_char(created_at at time zone 'UTC', 'YYYY-MM') = ${THIS_PERIOD} or starts_with(idempotency_key, ${thisKey}::text))`;
  expect(left!.n, "premise: nothing of the org's ledger is left in this month").toBe(0);
}

type Rig = { orgId: string; divisionId: string; packageId: string; rate: number };

/** An org holding `monthly` included credits (a month's grant through the real rollover, at `monthly` as the plan's
 *  rate) and `pack` bought ones (a real purchase), with one division and its unpaid package. `lastMonth`: all of it was
 *  written last month, and nothing has touched the org this month. */
async function rig(o: { monthly: number; pack: number; lastMonth?: boolean; size?: number }): Promise<Rig> {
  const orgId = await seedOrg();
  if (o.monthly > 0) await grantMonthlyStreamCredits(orgId, o.monthly, DB_NOW);
  if (o.pack > 0) await buy(orgId, o.pack);
  if (o.lastMonth) await backdateOrgLedger(orgId);
  expect(await creditBreakdown(sql, orgId), "premise: the org holds what the case says").toEqual(split(o.monthly, o.pack));
  const division = await seedDivision(orgId);
  const packageId = await seedPackage(orgId, division, o.size);
  return { orgId, divisionId: division.id, packageId, rate: o.monthly };
}

/** The writers as Tasks 5 and 6 will call them, each in its own transaction. */
const pay = (r: Rig, credits: number, o: { packageId?: string; rate?: number; orgId?: string } = {}) =>
  inTx((tx) => debitForPackage(tx, { orgId: o.orgId ?? r.orgId, packageId: o.packageId ?? r.packageId, credits, rate: o.rate ?? r.rate }));
const giveBack = (r: Rig, parts: { pack: number; monthly: number }, packageId = r.packageId) =>
  inTx((tx) => refundForPackage(tx, { orgId: r.orgId, packageId, ...parts }));
const returnable = (r: Rig, packageId = r.packageId) => inTx((tx) => returnableFor(tx, { orgId: r.orgId, packageId }));

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

/** Hold the org's money lock in another transaction until `release()`; `pid` is its backend. */
async function holdMoneyLock(orgId: string): Promise<{ pid: number; release: () => Promise<void> }> {
  let release!: () => void;
  const released = new Promise<void>((res) => (release = res));
  let signalHeld!: (pid: number) => void;
  const held = new Promise<number>((res) => (signalHeld = res));
  const holder = inTx(async (tx) => {
    await lockOrg(tx, orgId);
    const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
    signalHeld(pid);
    await released;
  });
  const pid = await held;
  return { pid, release: async () => { release(); await holder; } };
}

describe.skipIf(!HAS_DB)("debitForPackage: package consumes on the ledger", () => {
  it("debitForPackage spanning both buckets writes two rows whose balance_after end at total − credits", async () => {
    const r = await rig({ monthly: 3, pack: 5 });
    // One bucket: 2 of the 3 included credits, ONE row (no zero-delta pack row). This month is granted already, so the
    // rollover the debit runs first writes nothing.
    let before = await rowIds(r.orgId);
    expect(await pay(r, 2)).toEqual({ monthly: 2, pack: 0 });
    expect(await rowsSince(r.orgId, before)).toEqual([["consume", "monthly", -2, 6]]);
    // Both buckets: the last included credit, then 5 bought; the snapshots run 6 → 5 → 0, and 0 = 8 − 2 − 6.
    before = await rowIds(r.orgId);
    expect(await pay(r, 6)).toEqual({ monthly: 1, pack: 5 });
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

  it("debitForPackage rolls the month itself: paying first thing in a new month expires last month's leftover and spends this month's grant", async () => {
    // Last month: 3 included (unspent) + 5 bought. Nothing has touched the org this month, and its plan now grants 1.
    const r = await rig({ monthly: 3, pack: 5, lastMonth: true });
    let before = await rowIds(r.orgId);
    // The rollover's rule: expire the 3 left over (8 → 5), grant this month's 1 (5 → 6); then P4 on what is held: the 1
    // included, then 3 bought (6 → 5 → 2). Spending last month's leftover instead would answer {3, 1} and leave 4.
    expect(await pay(r, 4, { rate: 1 })).toEqual({ monthly: 1, pack: 3 });
    expect(await rowsSince(r.orgId, before)).toEqual([
      ["consume", "monthly", -1, 5], ["expire", "monthly", -3, 5], ["grant", "monthly", 1, 6], ["consume", "pack", -3, 2],
    ]);
    await expectBalance(r.orgId, 2, "paid in a new month");
    // The grant is THIS month's, by the database's clock: its key names the month the rows are dated in.
    const grants = (await orgRows(r.orgId)).filter((x) => !before.has(x.id) && x.reason === "grant");
    expect(grants.map((g) => g.idempotency_key)).toEqual([streamMonthlyGrantKey(r.orgId, THIS_PERIOD)]);
    // Last month's leftover was never this package's: nothing included of an earlier month is on it.
    expect(await returnable(r)).toEqual({ pack: 3, monthlyThisMonth: 1, monthlyExpired: 0 });
    // A second debit in the same month rolls nothing again: consumes only.
    before = await rowIds(r.orgId);
    expect(await pay(r, 1, { rate: 1 })).toEqual({ monthly: 0, pack: 1 });
    expect(await rowsSince(r.orgId, before)).toEqual([["consume", "pack", -1, 1]]);
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
      await expect(pay(r, credits)).rejects.toMatchObject({ status: 402, code: "ONLINE_CHESS_NO_CREDITS", extra: { owed: credits, balance } });
      expect(await rowsSince(r.orgId, before), "nothing written").toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it("a package of another org — or no package at all — is refused by debit and refund alike, and nothing is written", async () => {
    const a = await rig({ monthly: 2, pack: 2 });
    const b = await rig({ monthly: 0, pack: 0 });
    // A credit of A's on its own package, so a refund naming B's package would have something to return if it were let through.
    await pay(a, 1);
    const foreign = [b.packageId, randomUUID()];
    let checked = 0;
    for (const packageId of foreign) {
      const before = await rowIds(a.orgId);
      await expect(pay(a, 1, { packageId }), `debit ${packageId}`).rejects.toMatchObject({ status: 500, code: "online_package_not_of_org" });
      await expect(giveBack(a, { pack: 0, monthly: 1 }, packageId), `refund ${packageId}`)
        .rejects.toMatchObject({ status: 500, code: "online_package_not_of_org" });
      expect(await rowsSince(a.orgId, before), "nothing written").toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(foreign.length);
    // The org id is compared however it is spelled: an upper-case id of the owning org is not "another org".
    expect(await pay(a, 1, { orgId: a.orgId.toUpperCase() })).toEqual({ monthly: 1, pack: 0 });
  });
});

describe.skipIf(!HAS_DB)("a package's state: refunded and frozen", () => {
  /** A package paid 2 bought credits and then marked refunded WITHOUT its refund rows — the "cannot happen" state the
   *  writers refuse — so its own ledger would still let both a debit and a return through. */
  async function refundedRig(): Promise<Rig> {
    const r = await rig({ monthly: 0, pack: 5 });
    await pay(r, PRICE_32);
    await settlePackage(r.packageId, { size: 32, paid: PRICE_32, refunded: PRICE_32, forfeited: 0, refundedAt: new Date() });
    expect(await returnable(r), "premise: the package's rows alone would return 2").toEqual({ pack: 2, monthlyThisMonth: 0, monthlyExpired: 0 });
    return r;
  }

  it("a debit on a refunded package is refused by name (online_package_refunded) and writes nothing", async () => {
    const r = await refundedRig();
    const before = await rowIds(r.orgId);
    await expect(pay(r, 1)).rejects.toMatchObject({ status: 500, code: "online_package_refunded" });
    expect(await rowsSince(r.orgId, before)).toEqual([]);
  });

  it("a refund on a refunded package is refused by name (online_package_refunded) and writes nothing", async () => {
    const r = await refundedRig();
    const before = await rowIds(r.orgId);
    await expect(giveBack(r, { pack: 1, monthly: 0 })).rejects.toMatchObject({ status: 500, code: "online_package_refunded" });
    expect(await rowsSince(r.orgId, before)).toEqual([]);
  });

  it("a refund on a frozen package is refused by name (online_package_frozen) and writes nothing — and an upgrade after the freeze still pays", async () => {
    const r = await rig({ monthly: 0, pack: 5 });
    await pay(r, PRICE_32);
    await settlePackage(r.packageId, { size: 32, paid: PRICE_32, refunded: 0, forfeited: 0 });
    await sql`update division_online_packages set frozen_at = now() where id = ${r.packageId}`;
    expect(await returnable(r), "premise: the package's rows alone would return 2").toEqual({ pack: 2, monthlyThisMonth: 0, monthlyExpired: 0 });
    const before = await rowIds(r.orgId);
    await expect(giveBack(r, { pack: 1, monthly: 0 })).rejects.toMatchObject({ status: 500, code: "online_package_frozen" });
    expect(await rowsSince(r.orgId, before)).toEqual([]);
    // The positive pair: a frozen package's credits are committed, not closed — moving UP (64 costs 4 − 2 = 2) pays.
    expect(await pay(r, PRICE_64 - PRICE_32)).toEqual({ monthly: 0, pack: 2 });
    await expectBalance(r.orgId, 5 - PRICE_64, "upgraded after the freeze");
  });
});

describe.skipIf(!HAS_DB)("returnableFor and refundForPackage", () => {
  it("returnableFor: pack consumes minus pack refunds; monthly split by UTC month of the consume", async () => {
    const r = await rig({ monthly: 3, pack: 5 });
    // The empty case first: a package with no rows can give back nothing.
    expect(await returnable(r)).toEqual({ pack: 0, monthlyThisMonth: 0, monthlyExpired: 0 });
    await pay(r, 5); // {3, 2}
    // A second package of the same org: its rows are its own.
    const other = await seedPackage(r.orgId, await seedDivision(r.orgId), 16);
    await pay(r, 1, { packageId: other }); // {0, 1}
    expect(await returnable(r), "this month").toEqual({ pack: 2, monthlyThisMonth: 3, monthlyExpired: 0 });
    // Refunds net: 1 bought and 2 included back.
    await giveBack(r, { pack: 1, monthly: 2 });
    expect(await returnable(r), "after a refund").toEqual({ pack: 1, monthlyThisMonth: 1, monthlyExpired: 0 });
    expect(await returnable(r, other), "the other package").toEqual({ pack: 1, monthlyThisMonth: 0, monthlyExpired: 0 });
    // The same rows once their month has ended: the included credit still debited (3 − 2) is an earlier month's.
    await backdateOrgLedger(r.orgId);
    expect(await returnable(r), "a month later").toEqual({ pack: 1, monthlyThisMonth: 0, monthlyExpired: 1 });
  });

  it("ONE clock, the transaction's: a consume backdated to last month is not refunded to monthly, and a clock handed in is ignored", async () => {
    const r = await rig({ monthly: 3, pack: 2 });
    expect(await pay(r, 4)).toEqual({ monthly: 3, pack: 1 });
    // The positive pair: in its own month, the included credits would come back.
    expect(await returnable(r)).toEqual({ pack: 1, monthlyThisMonth: 3, monthlyExpired: 0 });
    await backdateOrgLedger(r.orgId);
    // The consume is last month's now. A caller that hands in a clock inside that month changes nothing: the month is the
    // transaction's own now(). Neither function takes one (the type says so), and at run time an extra one is ignored.
    // @ts-expect-error — returnableFor takes no clock
    expect(await inTx((tx) => returnableFor(tx, { orgId: r.orgId, packageId: r.packageId }, LAST_MONTH))).toEqual({ pack: 1, monthlyThisMonth: 0, monthlyExpired: 3 });
    const before = await rowIds(r.orgId);
    // @ts-expect-error — refundForPackage takes no clock
    await expect(inTx((tx) => refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, pack: 0, monthly: 1 }, LAST_MONTH)))
      .rejects.toMatchObject({ status: 500, code: "online_package_return_exceeds_debit" });
    expect(await rowsSince(r.orgId, before), "nothing returned to monthly").toEqual([]);
    // The bought credit still returns (P21: a bought credit never expires).
    await giveBack(r, { pack: 1, monthly: 0 });
    expect(await rowsSince(r.orgId, before)).toEqual([["refund", "pack", 1, 2]]);
  });

  it("refundForPackage returns each credit to its own bucket", async () => {
    const r = await rig({ monthly: 2, pack: 3 });
    await pay(r, 4); // {2, 2} → total 1
    expect(await creditBreakdown(sql, r.orgId)).toEqual(split(0, 1));
    const before = await rowIds(r.orgId);
    await giveBack(r, { pack: 2, monthly: 1 });
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
    await giveBack(r, { pack: 0, monthly: 0 });
    expect(await rowsSince(r.orgId, quiet)).toEqual([]);
  });

  it("refundForPackage refuses more than a bucket can give back, each bucket on its own", async () => {
    const r = await rig({ monthly: 2, pack: 3 });
    await pay(r, 4); // {2, 2}
    const over: [string, { pack: number; monthly: number }][] = [
      ["pack limb", { pack: 3, monthly: 0 }],
      ["monthly limb", { pack: 0, monthly: 3 }],
      ["both at once", { pack: 3, monthly: 3 }],
    ];
    let checked = 0;
    for (const [name, parts] of over) {
      const before = await rowIds(r.orgId);
      await expect(giveBack(r, parts), name).rejects.toMatchObject({ status: 500, code: "online_package_return_exceeds_debit" });
      expect(await rowsSince(r.orgId, before), `${name}: nothing written`).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(over.length);
    // The exact amounts still go through.
    await giveBack(r, { pack: 2, monthly: 2 });
    expect(await creditBreakdown(sql, r.orgId)).toEqual(split(2, 3));
  });

  it("refundForPackage checks both counts before anything: a bad part refuses by name, before the lock and the package read, and a caller that swallows the refusal commits nothing", async () => {
    const r = await rig({ monthly: 2, pack: 3 });
    await pay(r, 4); // {2, 2}: 2 bought and 2 included are returnable
    const bad: [{ pack: number; monthly: number }, RegExp][] = [
      [{ pack: 2, monthly: -1 }, /the included credits to return/], // the brief's case: a good pack part before a bad monthly one
      [{ pack: -1, monthly: 2 }, /the bought credits to return/],
      [{ pack: 0, monthly: 1.5 }, /the included credits to return/],
      [{ pack: Number.NaN, monthly: 0 }, /the bought credits to return/],
    ];
    let checked = 0;
    for (const [parts, names] of bad) {
      const before = await rowIds(r.orgId);
      // The caller catches the refusal INSIDE its transaction and commits: a half-written return would survive this.
      let caught: unknown;
      await inTx(async (tx) => {
        try {
          await refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, ...parts });
        } catch (e) {
          caught = e;
        }
      });
      expect(caught, JSON.stringify(parts)).toBeInstanceOf(RangeError);
      expect((caught as Error).message, JSON.stringify(parts)).toMatch(names);
      expect(await rowsSince(r.orgId, before), `${JSON.stringify(parts)}: nothing written`).toEqual([]);
      // Before any read: a package that is not even the org's answers the count, not the ownership check.
      await expect(giveBack(r, parts, randomUUID()), `${JSON.stringify(parts)} on a stranger's package`).rejects.toBeInstanceOf(RangeError);
      checked += 1;
    }
    expect(checked).toBe(bad.length);
    expect(await creditBreakdown(sql, r.orgId), "the org holds what it held").toEqual(split(0, 1));
  });
});

describe.skipIf(!HAS_DB)("sequences", () => {
  it("creditBalance equals the breakdown total after every step of debit → debit → refund → debit", async () => {
    const r = await rig({ monthly: 2, pack: 6 }); // 8
    const steps: [string, () => Promise<unknown>, (string | number)[][], number][] = [
      ["first debit (3)", () => pay(r, 3), [["consume", "monthly", -2, 6], ["consume", "pack", -1, 5]], 5],
      ["second debit (2): the included credits are gone, so the pack pays", () => pay(r, 2), [["consume", "pack", -2, 3]], 3],
      ["refund 4 in P21's order: 3 bought, then 1 included", async () => {
        const ret = await returnable(r);
        expect(ret).toEqual({ pack: 3, monthlyThisMonth: 2, monthlyExpired: 0 });
        const plan = planReturn(ret, 4);
        expect(plan).toEqual({ pack: 3, monthly: 1, forfeited: 0 });
        await giveBack(r, { pack: plan.pack, monthly: plan.monthly });
      }, [["refund", "monthly", 1, 7], ["refund", "pack", 3, 6]], 7],
      ["a debit after the refund (2): the returned included credit is spent first again", () => pay(r, 2),
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
    // "Last month": 3 included + 5 bought; pay for 64 (4 credits) → 3 included + 1 bought. Then the whole ledger is moved
    // back a month.
    const r = await rig({ monthly: 3, pack: 5 }); // 8
    let checked = 0;
    let before = await rowIds(r.orgId);
    expect(await pay(r, PRICE_64)).toEqual({ monthly: 3, pack: 1 });
    expect(await rowsSince(r.orgId, before)).toEqual([["consume", "monthly", -3, 5], ["consume", "pack", -1, 4]]);
    await settlePackage(r.packageId, { size: 64, paid: PRICE_64, refunded: 0, forfeited: 0 });
    await expectBalance(r.orgId, 4, "paid 64 last month");
    await expectPackageInvariant(r.packageId, 4, "paid 64 last month");
    checked += 1;
    await backdateOrgLedger(r.orgId);

    // This month: the debit rolls the month first (nothing included is left to expire; this month's 3 are granted), then
    // the upgrade to 128 costs the difference, 8 − 4 = 4 → 3 included + 1 bought.
    before = await rowIds(r.orgId);
    expect(await pay(r, PRICE_128 - PRICE_64)).toEqual({ monthly: 3, pack: 1 });
    expect(await rowsSince(r.orgId, before)).toEqual([["consume", "monthly", -3, 4], ["grant", "monthly", 3, 7], ["consume", "pack", -1, 3]]);
    await settlePackage(r.packageId, { size: 128, paid: PRICE_128, refunded: 0, forfeited: 0 });
    await expectBalance(r.orgId, 3, "upgraded to 128 this month");
    await expectPackageInvariant(r.packageId, 8, "upgraded to 128 this month");
    checked += 1;

    // Move down to 32: the value falls 8 → 2, so 6 go back in P21's order: 2 bought, 3 of this month's included, and 1 of
    // last month's included is forfeited (counted, nothing written).
    const ret = await returnable(r);
    expect(ret).toEqual({ pack: 2, monthlyThisMonth: 3, monthlyExpired: 3 });
    const down = planReturn(ret, PRICE_128 - PRICE_32);
    expect(down).toEqual({ pack: 2, monthly: 3, forfeited: 1 });
    before = await rowIds(r.orgId);
    await giveBack(r, { pack: down.pack, monthly: down.monthly });
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
    const left = await returnable(r);
    expect(left).toEqual({ pack: 0, monthlyThisMonth: 0, monthlyExpired: 3 });
    before = await rowIds(r.orgId);
    await expect(giveBack(r, { pack: 0, monthly: 1 })).rejects.toMatchObject({ status: 500, code: "online_package_return_exceeds_debit" });
    expect(await rowsSince(r.orgId, before)).toEqual([]);

    // The full refund (the division deleted before round 1): the value left is 2, and the caller nets the 1 already
    // forfeited off last month's 3, so both are forfeited and nothing is written. refunded_at, credits_refunded and
    // credits_forfeited are set in ONE statement (V549: refunded ⇒ refunded + forfeited = paid) AFTER the return, which
    // refuses a refunded row.
    const full = planReturn({ ...left, monthlyExpired: left.monthlyExpired - 1 /* the row's credits_forfeited */ }, PRICE_32);
    expect(full).toEqual({ pack: 0, monthly: 0, forfeited: 2 });
    before = await rowIds(r.orgId);
    await giveBack(r, { pack: full.pack, monthly: full.monthly });
    expect(await rowsSince(r.orgId, before)).toEqual([]);
    await settlePackage(r.packageId, { size: 32, paid: PRICE_128, refunded: 5, forfeited: 1 + 2, refundedAt: new Date() });
    await expectBalance(r.orgId, 8, "refunded in full");
    await expectPackageInvariant(r.packageId, 3, "refunded in full");
    checked += 1;
    expect(checked, "steps checked").toBe(4);
  });
});

describe.skipIf(!HAS_DB)("locks and the rollover", () => {
  it("each writer queues behind the org's money lock held by another transaction: debit and refund take it themselves", async () => {
    const writers: [string, (tx: Tx, r: Rig) => Promise<unknown>][] = [
      ["debitForPackage", (tx, r) => debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits: 1, rate: r.rate })],
      ["refundForPackage", (tx, r) => refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, pack: 1, monthly: 0 })],
    ];
    let checked = 0;
    for (const [name, write] of writers) {
      const r = await rig({ monthly: 0, pack: 3 });
      if (name === "refundForPackage") await pay(r, 1);
      const hold = await holdMoneyLock(r.orgId);
      // The racer does NOT take the lock first: the writer must take it on its own.
      const racer = inTx((tx) => write(tx, r));
      const blocked = await advisoryWaitersBehind(hold.pid, 1);
      await hold.release();
      await racer;
      expect(blocked, `${name} queued on the money lock`).toBe(1);
      checked += 1;
    }
    expect(checked, "writers checked").toBe(writers.length);
  });

  it("two debits racing for one org's last credits: exactly one is paid, the other answers 402, and the balance never goes below zero", async () => {
    const r = await rig({ monthly: 2, pack: 3 }); // 5, and two packages owing 3 each: 6 > 5
    const second = await seedPackage(r.orgId, await seedDivision(r.orgId), 64);
    const before = await rowIds(r.orgId);
    // Both debits start while another transaction holds the money lock, so both are in flight at once when it opens.
    const hold = await holdMoneyLock(r.orgId);
    const racers = [r.packageId, second].map((packageId) => pay(r, 3, { packageId }));
    const inFlight = await advisoryWaitersBehind(hold.pid, 2);
    await hold.release();
    const settled = await Promise.allSettled(racers);
    expect(inFlight, "anti-vacuity: both debits were waiting on the org at the same moment").toBe(2);
    const paid = settled.flatMap((s, i) => (s.status === "fulfilled" ? [{ i, split: s.value }] : []));
    const refused = settled.flatMap((s) => (s.status === "rejected" ? [s.reason as unknown] : []));
    expect(paid.length, "exactly one debit is paid").toBe(1);
    expect(refused.length, "exactly one debit is refused").toBe(1);
    // The winner draws 2 included then 1 bought (P4); the loser sees what is left, 5 − 3 = 2, and owes 3.
    expect(paid[0]!.split).toEqual({ monthly: 2, pack: 1 });
    expect(refused[0]).toMatchObject({ status: 402, code: "ONLINE_CHESS_NO_CREDITS", extra: { owed: 3, balance: 2 } });
    const written = (await orgRows(r.orgId)).filter((x) => !before.has(x.id));
    expect(written.length, "the winner's two rows, and nothing of the loser's").toBe(2);
    const winner = [r.packageId, second][paid[0]!.i];
    for (const x of written) expect(x.online_package_id).toBe(winner);
    expect(Math.min(...written.map((x) => x.balance_after)), "no snapshot below zero").toBeGreaterThanOrEqual(0);
    await expectBalance(r.orgId, 5 - 3, "after the race");
  });

  it("rollMonthlyUnderLock rolls the month in the caller's transaction at the database's clock: last month's leftover expires, this month is granted once, and a rolled-back caller leaves nothing", async () => {
    const r = await rig({ monthly: 2, pack: 0, lastMonth: true });
    let before = await rowIds(r.orgId);
    await inTx(async (tx) => {
      await lockOrg(tx, r.orgId);
      await rollMonthlyUnderLock(tx, r.orgId, 3, await txNow(tx));
    });
    expect(await rowsSince(r.orgId, before)).toEqual([["expire", "monthly", -2, 0], ["grant", "monthly", 3, 3]]);
    const [grant] = (await orgRows(r.orgId)).filter((x) => !before.has(x.id) && x.reason === "grant");
    expect(grant!.idempotency_key, "this month's grant key").toBe(streamMonthlyGrantKey(r.orgId, THIS_PERIOD));
    // A second call in the same month writes nothing.
    before = await rowIds(r.orgId);
    await inTx(async (tx) => {
      await lockOrg(tx, r.orgId);
      await rollMonthlyUnderLock(tx, r.orgId, 3, await txNow(tx));
    });
    expect(await rowsSince(r.orgId, before)).toEqual([]);
    // A caller that rolls back takes the rollover with it.
    const s = await rig({ monthly: 2, pack: 0, lastMonth: true });
    const sBefore = await rowIds(s.orgId);
    const ROLLBACK = new Error("rollback");
    await expect(inTx(async (tx) => {
      await lockOrg(tx, s.orgId);
      await rollMonthlyUnderLock(tx, s.orgId, 3, await txNow(tx));
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
