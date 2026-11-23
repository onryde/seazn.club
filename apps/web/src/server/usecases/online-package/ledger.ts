import "server-only";
// server/usecases/online-package/ledger.ts — an Online Chess package's rows on the Seazn credits ledger (spec
// 2026-11-23-online-chess-credits-design.md §7.1, §7.4, §7.5; P4, P6, P21). The ONE module of the package code that writes
// `org_stream_credits`: a package debit, a package return, and the settle step's claw-back of a reversed pack
// (`revokeForReversal`, §7.5). The payment, move-down, refund and settle usecases (Tasks 5, 6) call it and own the package
// row and the attribution.
//
//  * Rows: a debit is a `consume`, a return a `refund`. Each names the package (`online_package_id`) and no stream session,
//    has no staff author (`created_by` null: how the stream code tells a platform refund from staff) and no key; the ledger's
//    reason CHECK is unchanged (V550 pins this shape: org_stream_credits_package_row_check). One row per bucket the credits
//    move in, never a zero row (V410: delta <> 0). `balance_after` is the running ORG total, row by row. Readers net a
//    package's rows by `online_package_id`, never `session_id` (it is null on every one of them).
//  * Two buckets (V426): a debit draws `monthly` (this month's included credits, which expire) first, then `pack` (P4); a
//    return gives back bought credits first, then included credits debited in the current UTC month, and forfeits included
//    credits from an earlier month (P6, P21). Each returned credit goes to the bucket it came from.
//  * ONE CLOCK, the database's. Every ledger row is dated by its transaction's `now()`, so "this month" is that same
//    `now()`, read inside the transaction — for the rollover a debit runs, and for the split of what a package can give
//    back. No function here takes a clock from its caller: a caller-supplied month could make last month's included
//    credits read as this month's and return them.
//  * The money lock: the caller holds it (lock order §7.3: the `division:` lock, then `lockOrg`, then the package row
//    `for update`). Both writers take `lockOrg` themselves too — the debit as its first statement, the return right after
//    checking its counts: an advisory lock is re-entrant within a transaction, so that never waits on the caller's own
//    hold, and a caller that forgot it still cannot race another writer of the org. The debit's take is the ONE that
//    covers its rollover (stream-credits.ts `rollMonthlyUnderLock` takes none). The reads here (`returnableFor`) are only
//    true under it.
//  * Exactly once is the CALLER's (by state under the locks, spec §7.4): these writers move what they are told to, after
//    refusing anything the package's own ledger or its state cannot account for.
import type { Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ONLINE_PACKAGE_CODES } from "@/lib/online-chess-package";
import { InsufficientCredits, credit, debit } from "@/server/relay/domain/credits";
import {
  creditBreakdown, lockOrg, rollMonthlyUnderLock, streamMonthlyPeriod, type StreamCreditBreakdown,
} from "@/server/usecases/stream-credits";
import type { BucketSplit, ReturnPlan, Returnable } from "./types";

/** 402 `ONLINE_CHESS_NO_CREDITS` (plan Global Constraints): the org's balance cannot cover what the package owes. Carries
 *  `owed` and `balance`. Never the stream ledger's `no_credits`, which carries `featureKey: "streaming.relay"` and which the
 *  stream UI keys on (stream-credits.ts NoCreditsError). */
export class OnlineChessNoCreditsError extends HttpError {
  constructor(readonly owed: number, readonly balance: number) {
    super(402, `This organisation holds ${balance} Seazn credits and ${owed} are needed`, ONLINE_PACKAGE_CODES.noCredits, { owed, balance });
  }
}

/** A return that is more than the package can give back: one code for the plan and for the writer, both "cannot happen"
 *  (the package's value never exceeds what its own ledger rows hold), so a 500 that names it, never a write. */
const RETURN_EXCEEDS_DEBIT = "online_package_return_exceeds_debit";

/** The transaction's own clock: `now()` is fixed at the transaction's start, and it is what every row written in it is
 *  dated by. Exported for the quote (quote.ts), which dates "this month" and the month's expiry by the same clock. */
export async function transactionNow(tx: Tx): Promise<Date> {
  const [r] = await tx<{ now: Date }[]>`select now() as now`;
  return r!.now;
}

/** The split of a package debit of `credits` over the org's two buckets: `monthly` first, then `pack` (P4: the included
 *  credits expire at the end of the UTC month, a bought one never does). Throws 402 `OnlineChessNoCreditsError` when the
 *  two buckets together cannot cover it, and the ledger's own error (`debit amount must be a positive integer`) for a
 *  debit that is not a positive whole number: that is a bug upstream, never a price. */
export function planDebit(split: StreamCreditBreakdown, credits: number): BucketSplit {
  // "Cannot happen" as a guard (planMonthlyRoll's): no writer takes a bucket below zero. Read as a number, a negative
  // monthly bucket would be passed over and the whole debit drawn from the pack, and a negative pack would let the monthly
  // bucket cover a debit the org total cannot. Two comparisons, so each limb can be mutated on its own.
  if (split.monthly < 0 || split.pack < 0) {
    throw new HttpError(500, `This organisation's Seazn credit buckets are monthly ${split.monthly}, pack ${split.pack}; refusing to debit a negative ledger`, "ledger_negative");
  }
  const held = split.monthly + split.pack;
  try {
    debit(held, credits); // the stream consume's own check, in memory: a positive whole debit the balance covers
  } catch (e) {
    if (e instanceof InsufficientCredits) throw new OnlineChessNoCreditsError(credits, held);
    throw e;
  }
  const monthly = Math.min(split.monthly, credits);
  return { monthly, pack: credits - monthly };
}

/** "Cannot happen" as guards, each a named 500: the caller resolved the package from the org's own division, under the
 *  package row's lock, and checked its state. A package of another org (or none: a stale id) would put one org's credits
 *  on another's package — money moved across tenants, which an append-only ledger can only compensate, never correct. A
 *  REFUNDED package is history (spec §7.1): nothing is debited for it and nothing more comes back from it. A FROZEN one
 *  has opened a round (P7, P8; §7.1 "Nothing changes", §7.4 item 3 "Refused: frozen", the mid-event rule: the size "can
 *  no longer be raised"): nothing is debited for it and nothing comes back. Paying and moving down happen only BEFORE
 *  the freeze. Postgres returns uuids lower-case; a caller's id may not be. */
async function assertPackageWritable(tx: Tx, a: { orgId: string; packageId: string }, op: "debit" | "refund"): Promise<void> {
  const [p] = await tx<{ org_id: string; frozen_at: Date | null; refunded_at: Date | null }[]>`
    select org_id, frozen_at, refunded_at from division_online_packages where id = ${a.packageId}`;
  if (!p || p.org_id !== a.orgId.toLowerCase()) {
    throw new HttpError(500, `Online Chess package ${a.packageId} does not belong to organisation ${a.orgId}; nothing was written`, "online_package_not_of_org");
  }
  if (p.refunded_at !== null) {
    throw new HttpError(500, `Online Chess package ${a.packageId} was refunded; refusing a ${op} on it`, "online_package_refunded");
  }
  if (p.frozen_at !== null) {
    throw new HttpError(500, `Online Chess package ${a.packageId} is frozen (a round has opened); refusing a ${op} on it`, "online_package_frozen");
  }
}

/** Debit `credits` for a package: first the org's monthly rollover at the transaction's own `now()` (`rate` is the org's
 *  resolved plan rate, `streamMonthlyRate`, read before the transaction), so last month's leftover included credits are
 *  expired and this month's granted before anything is drawn; then `planDebit`'s split, written as one `consume` row per
 *  bucket that moves (monthly, then pack), each `balance_after` the running org total. Answers the split. 402 when the
 *  balance is short, before any consume row (the rollover's rows roll back with the caller's transaction). REFUSED,
 *  before the rollover and any row, on a refunded or frozen package. */
export async function debitForPackage(
  tx: Tx, a: { orgId: string; packageId: string; credits: number; rate: number },
): Promise<BucketSplit> {
  await lockOrg(tx, a.orgId);
  await assertPackageWritable(tx, a, "debit");
  await rollMonthlyUnderLock(tx, a.orgId, a.rate, await transactionNow(tx));
  const split = await creditBreakdown(tx, a.orgId);
  const plan = planDebit(split, a.credits);
  let balance = split.total;
  for (const [bucket, n] of [["monthly", plan.monthly], ["pack", plan.pack]] as const) {
    if (n === 0) continue;
    ({ balanceAfter: balance } = debit(balance, n));
    await tx`
      insert into org_stream_credits (org_id, delta, reason, bucket, online_package_id, balance_after)
      values (${a.orgId}, ${-n}, 'consume', ${bucket}, ${a.packageId}, ${balance})`;
  }
  return plan;
}

/** `returnableFor` at a clock the module read itself (never one a caller handed in). */
async function returnableAt(tx: Tx, a: { orgId: string; packageId: string }, now: Date): Promise<Returnable> {
  const period = streamMonthlyPeriod(now);
  const [r] = await tx<{ pack: number; this_month: number; expired: number }[]>`
    select coalesce(-sum(delta) filter (where bucket = 'pack'), 0)::int as pack,
           coalesce(-sum(delta) filter (where bucket = 'monthly'
                                          and to_char(created_at at time zone 'UTC', 'YYYY-MM') = ${period}), 0)::int as this_month,
           coalesce(-sum(delta) filter (where bucket = 'monthly'
                                          and to_char(created_at at time zone 'UTC', 'YYYY-MM') <> ${period}), 0)::int as expired
      from org_stream_credits
     where org_id = ${a.orgId} and online_package_id = ${a.packageId} and reason in ('consume', 'refund')`;
  return { pack: r!.pack, monthlyThisMonth: r!.this_month, monthlyExpired: r!.expired };
}

/** What the package can still give back, from its OWN ledger rows (spec §7.4), in the UTC month of the transaction's own
 *  `now()`. `monthlyThisMonth` is the included credits debited in that month minus those returned in it; `monthlyExpired`
 *  is every other included credit still debited. A monthly return is only ever written in the month of the consume it
 *  returns (P6, enforced by `refundForPackage`), so each month nets on its own. The row's `credits_forfeited` is NOT
 *  netted here: the caller subtracts it from `monthlyExpired`. The month is `streamMonthlyPeriod`'s, compared on the
 *  row's UTC date, never `date_trunc` in the session time zone (#292). Under the caller's money lock. */
export async function returnableFor(tx: Tx, a: { orgId: string; packageId: string }): Promise<Returnable> {
  return returnableAt(tx, a, await transactionNow(tx));
}

function assertCount(n: number, what: string, min: 0 | 1): void {
  if (!Number.isInteger(n) || n < min) throw new RangeError(`${what} must be a whole number of credits of at least ${min}, got ${String(n)}`);
}

/** A return of `credits` in P21's order: bought credits first (they always return), then included credits debited this
 *  month (they return, P6), and only then included credits from an earlier month, which are forfeited: counted on the
 *  package row, never written. 500 when `credits` is more than the package holds; a RangeError for a count that is not
 *  one. */
export function planReturn(r: Returnable, credits: number): ReturnPlan {
  assertCount(credits, "a package return", 1);
  assertCount(r.pack, "the returnable bought credits", 0);
  assertCount(r.monthlyThisMonth, "the returnable included credits of this month", 0);
  assertCount(r.monthlyExpired, "the included credits of an earlier month", 0);
  const held = r.pack + r.monthlyThisMonth + r.monthlyExpired;
  if (credits > held) {
    throw new HttpError(500, `An Online Chess package holding ${held} credits cannot return ${credits}`, RETURN_EXCEEDS_DEBIT);
  }
  const pack = Math.min(r.pack, credits);
  const monthly = Math.min(r.monthlyThisMonth, credits - pack);
  return { pack, monthly, forfeited: credits - pack - monthly };
}

/** Return `pack` bought and `monthly` included credits to the org, each to its own bucket, as one `refund` row per bucket
 *  that moves (pack first, P21), each `balance_after` the running org total. Nothing to return (everything forfeited)
 *  writes nothing. Both parts must be whole non-negative counts, checked before anything is read or written, so a caller
 *  that catches the refusal inside its transaction never commits half a return. REFUSED, before any row, on a refunded
 *  or frozen package, and when either part is more than the package can give back from that bucket: bought credits net
 *  of what returned already, and included credits debited in the UTC month of the transaction's own `now()` net of what
 *  returned in it — so an included credit from an earlier month cannot come back through here (P6), and no caller can
 *  move the month. */
export async function refundForPackage(tx: Tx, a: { orgId: string; packageId: string; pack: number; monthly: number }): Promise<void> {
  assertCount(a.pack, "the bought credits to return", 0);
  assertCount(a.monthly, "the included credits to return", 0);
  await lockOrg(tx, a.orgId);
  await assertPackageWritable(tx, a, "refund");
  if (a.pack === 0 && a.monthly === 0) return;
  const can = await returnableAt(tx, a, await transactionNow(tx));
  // Two comparisons, so each bucket's limb can be mutated on its own.
  if (a.pack > can.pack || a.monthly > can.monthlyThisMonth) {
    throw new HttpError(
      500,
      `Online Chess package ${a.packageId} can give back ${can.pack} bought and ${can.monthlyThisMonth} included credits this month; refusing to return ${a.pack} and ${a.monthly}`,
      RETURN_EXCEEDS_DEBIT,
    );
  }
  const { total } = await creditBreakdown(tx, a.orgId);
  let balance = total;
  for (const [bucket, n] of [["pack", a.pack], ["monthly", a.monthly]] as const) {
    if (n === 0) continue;
    ({ balanceAfter: balance } = credit(balance, n));
    await tx`
      insert into org_stream_credits (org_id, delta, reason, bucket, online_package_id, balance_after)
      values (${a.orgId}, ${n}, 'refund', ${bucket}, ${a.packageId}, ${balance})`;
  }
}

/** The settle step's claw-back (§7.5 item 2): take `credits` bought credits back against the reversed pack `intent`, as ONE
 *  `revoke` row in the `pack` bucket carrying the intent (so a human walks it back to the Stripe object, and the attribution counts
 *  it as already revoked) and NO key: settle rows are bounded by the attribution, not by a key (the claw-back's own
 *  `stream_pack_refund:{intent}` row stays the replay guard). No session, no package, no staff author: the shape of the
 *  claw-back's own row. Floored on the PACK, as every revoke is (V426): asking for more than the pack holds is a named 500, never
 *  a write that drives the bucket below zero. Answers the org total after the row. Takes the money lock (re-entrant). */
export async function revokeForReversal(tx: Tx, a: { orgId: string; intent: string; credits: number }): Promise<number> {
  assertCount(a.credits, "the credits to take back", 1);
  await lockOrg(tx, a.orgId);
  const split = await creditBreakdown(tx, a.orgId);
  if (a.credits > split.pack) {
    throw new HttpError(
      500,
      `Organisation ${a.orgId} holds ${split.pack} bought credits; refusing to take back ${a.credits} for payment intent ${a.intent}`,
      "reversal_exceeds_pack",
    );
  }
  debit(split.pack, a.credits); // the floor, in memory, against the pack (the claw-back's own check)
  const balanceAfter = split.total - a.credits;
  await tx`
    insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note, stripe_payment_intent_id)
    values (${a.orgId}, ${-a.credits}, 'revoke', 'pack', ${balanceAfter},
            ${`Stripe claw-back settled after an Online Chess package returned credits — payment intent ${a.intent}`}, ${a.intent})`;
  return balanceAfter;
}
