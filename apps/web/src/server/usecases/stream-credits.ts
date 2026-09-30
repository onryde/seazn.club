import "server-only";
// server/usecases/stream-credits.ts — the match-credits ledger (design §5.2).
// One currency, one table, rows only (never UPDATE/DELETE — it is money).
//  * Balance = sum(delta) through creditBalance(); balance_after is a per-row
//    snapshot and the schema's oversell floor, never read as the balance.
//  * THE MONEY LOCK: every writer here (purchase, consume, grant, refund, revoke) takes
//    lockOrg — pg_advisory_xact_lock on a relay-namespaced org key, adminAdjust's idiom
//    (lib/credits.ts) — before it reads anything. An advisory lock, not `select … for
//    update` over the org's rows: row locks lock NOTHING on an empty ledger, so two
//    first-ever writes to an org would read the same balance and write the same snapshot
//    (and a same-key pair IN THAT ORG would both miss the key and 23505). The lock is per
//    ORG and the key index is TABLE-wide, so the lock cannot stop one key racing on two
//    DIFFERENT orgs: both miss the lookup and the second insert still raises 23505 on
//    org_stream_credits_idempotency_key. staffRow answers that 23505 as the 409 it is.
//  * consumeForSession runs INSIDE the transaction that makes the stream live
//    (stream-sessions.ts): the lock, then the 24 h same-fixture reuse rule (skipped
//    when the session has no fixture), then balance < 1 → NoCreditsError.
//  * recordPurchase is replay-safe by the stripe_event_id unique constraint:
//    `on conflict do nothing` and the existing row is returned.
//  * grant/refund/revoke are the /admin panel's rows (Task 7A). Each is ONE row with
//    created_by = the staff user, an idempotency key checked under the lock BEFORE any
//    guard, and ONE staff_audit_log row in the same transaction (lib/credits.ts adminAdjust's
//    shape, which cannot be called here: it is bound to ai_credit_ledger). An EXACT replay
//    writes neither row; the same key with a different org, reason, delta or session is a
//    409 (a deliberate departure from adminAdjust, which answers applied:false to any replay).
//    Refusals are 422, as the donor route's are. admin-addons.ts has no refund neighbour (P9).
//  * TWO BUCKETS (V426, Task 14b, owner-approved 2026-09-29). Every row names the pool it moves:
//    'monthly' — the plan's free match credits for one UTC calendar month, granted by
//    ensureMonthlyStreamGrant and expired (the leftover only) before the next month's grant — and
//    'pack' — bought packs and staff grants, which never expire. A consume draws monthly while
//    monthly > 0, else pack; a linked refund returns to its consume's bucket; a goodwill refund,
//    a staff grant and every revoke (staff or Stripe claw-back) are pack, and a revoke is floored
//    on the PACK, so no writer can drive either bucket below zero. balance_after is still the ORG
//    total, and creditBalance is still the one authority for it; creditBreakdown splits it.
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { utcMonthStart } from "@/lib/credits";
import { orgPlanKey } from "@/lib/entitlements";
import { isPassKey, type PassKey } from "@/lib/currency";
import { InsufficientCredits, credit, debit, withinReuseWindow } from "@/server/relay/domain/credits";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
// TYPE-ONLY, as lib/credits.ts does: admin-adjustments-log.ts VALUE-imports
// STREAM_CREDIT_AUDIT_ACTIONS from here, so a value import back would be a runtime cycle.
import type { AdjustmentAction } from "@/server/usecases/admin-adjustments-log";

type Executor = Tx | typeof sql;

export class NoCreditsError extends HttpError {
  constructor(orgId: string) {
    super(402, "This organisation has no match credits", "no_credits", { featureKey: "streaming.relay", orgId });
  }
}

export async function creditBalance(exec: Executor, orgId: string): Promise<number> {
  const [row] = await exec<{ bal: string | null }[]>`
    select coalesce(sum(delta), 0)::text as bal from org_stream_credits where org_id = ${orgId}`;
  return Number(row?.bal ?? 0);
}

/** V426's two pools. See the header's TWO BUCKETS note for which writer moves which. */
export type StreamCreditBucket = "monthly" | "pack";

export interface StreamCreditBreakdown {
  /** This month's free match credits still held (expire at the end of the UTC month). */
  monthly: number;
  /** Bought packs and staff grants still held (never expire). */
  pack: number;
  /** monthly + pack — the same number creditBalance returns. */
  total: number;
}

/** The balance split by bucket, in ONE statement. `total` is summed from the two parts rather than
 *  read a second time, so the three can never disagree; the "one authority for the total" test pins
 *  it equal to creditBalance at every step of a sequence. An empty ledger is {0, 0, 0}. */
export async function creditBreakdown(exec: Executor, orgId: string): Promise<StreamCreditBreakdown> {
  const [row] = await exec<{ monthly: string | null; pack: string | null }[]>`
    select coalesce(sum(delta) filter (where bucket = 'monthly'), 0)::text as monthly,
           coalesce(sum(delta) filter (where bucket = 'pack'), 0)::text as pack
      from org_stream_credits where org_id = ${orgId}`;
  const monthly = Number(row?.monthly ?? 0);
  const pack = Number(row?.pack ?? 0);
  return { monthly, pack, total: monthly + pack };
}

/** The org's money-lock key — ONE authority for its spelling. Lower-cased (N1): Postgres
 *  returns uuids lower-case, so Task 10's consume and Task 8's purchase pass a lower-case id,
 *  while z.uuid() accepts an upper-case one in a hand-built /admin URL; without this, the two
 *  spellings of one org would take two DIFFERENT locks and a revoke could race a consume.
 *  Namespaced (`stream-credits-org:`) apart from lib/credits.ts's `ai-credit-wallet:` strings.
 *  hashtext is 32-bit, so two different keys CAN hash equal; a collision only serialises two
 *  unrelated writers (a spurious wait), never lets two writers of one org run together. */
export function orgMoneyLockKey(orgId: string): string {
  return `stream-credits-org:${orgId.toLowerCase()}`;
}

/** Serialise every money write to one org, until the transaction ends. Taken FIRST, before
 *  any read, by every writer in this file. Exported for the concurrency tests, which hold it
 *  from a transaction of their own to make writers queue. */
export async function lockOrg(tx: Tx, orgId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${orgMoneyLockKey(orgId)}))`;
}

/** §5.2 — "a restart after a failure is the same match": does this FIXTURE have a consume inside the
 *  reuse window? ONE authority for the rule's ledger read (Task 10 I2, orchestrator ruling 2026-09-28):
 *  `consumeForSession` asks it before debiting, and admission (stream-sessions.ts `createSession`) asks
 *  it so a restart at balance 0 is admitted — the two cannot drift.
 *
 *  The rule is per FIXTURE. A session whose fixture is gone (fixture_id is `on delete set null`) has
 *  none to match, so it has no window; comparing `= null` would say the same thing by accident, and
 *  `is not distinct from` would wrongly make every fixture-less session one fixture.
 *
 *  A17: ledger ids are random uuids, so the LATEST consume is found by `created_at` alone. A tie between
 *  two consumes of one fixture is harmless here — both carry the same instant, so either answers the
 *  same window. Unlocked when admission reads it (advisory there: consumeForSession re-asks under
 *  `lockOrg` at go-live, and a window that closed in between refuses the credit then).
 *
 *  D2 (lane C final review): only a consume that still STANDS opens a window. A staff refund linked to
 *  the consuming session returned that credit, so counting its consume handed the org the credit back
 *  AND a free 24 h restart. A consume stands while its session's linked refunds sum to less than what
 *  the session consumed — the refund cap's own arithmetic (`refundCredits`: refunded + delta ≤
 *  consumed), compared per session so no "one consume per session" assumption is needed. An unlinked
 *  (goodwill) refund names no session and returns nothing of any fixture's; a refund linked to an
 *  EARLIER session leaves a later, unrefunded consume standing. */
export async function reuseWindowOpen(
  exec: Executor,
  args: { orgId: string; fixtureId: string | null },
  now: Date,
): Promise<boolean> {
  if (args.fixtureId === null) return false;
  const [last] = await exec<{ created_at: string }[]>`
    select c.created_at from org_stream_credits c
      join fixture_stream_sessions s on s.id = c.session_id
     where c.org_id = ${args.orgId} and c.reason = 'consume' and s.fixture_id = ${args.fixtureId}
       and (select coalesce(sum(r.delta), 0) from org_stream_credits r
             where r.org_id = c.org_id and r.session_id = c.session_id and r.reason = 'refund')
         < (select coalesce(-sum(k.delta), 0) from org_stream_credits k
             where k.org_id = c.org_id and k.session_id = c.session_id and k.reason = 'consume')
     order by c.created_at desc limit 1`;
  return withinReuseWindow(last ? new Date(last.created_at) : null, now);   // the pure 24 h rule (domain/credits.ts)
}

export async function consumeForSession(
  tx: Tx,
  args: {
    orgId: string; fixtureId: string | null; sessionId: string;
    /** M6 (Task 14b review): roll the org's free month over under THIS lock before the balance is read, at `rate` (the
     *  org's resolved plan rate — a POOLED read the caller makes before its transaction, never inside it: lib/db.ts's
     *  nesting guard) for the UTC month of `now` (the WALL clock, as createSession's ensure). Without it a session
     *  created before the month turns and live after it draws last month's leftover — or a BOUGHT credit while this
     *  month's free one is still ungranted. Omitted by direct ledger callers (tests, staff tooling). */
    monthly?: { rate: number; now: Date };
  },
  now: Date = new Date(),
): Promise<{ consumed: boolean; balance: number; ledgerId: string | null }> {
  await lockOrg(tx, args.orgId);
  if (args.monthly) {
    const { rate, now: wall } = args.monthly;
    try {
      // A SAVEPOINT, so a refused or failed rollover (a corrupt ledger's ledger_negative, a bad catalogue rate) rolls back
      // alone: going live must never hinge on the month's bookkeeping. The consume below then runs on the ledger as it
      // stands, which is exactly the pre-M6 behaviour — and the failure is reported, never swallowed.
      await tx.savepoint((sp) => rollMonthlyLocked(sp, args.orgId, rate, wall));
    } catch (err) {
      log.error({ err, orgId: args.orgId, sid: args.sessionId }, "stream credits: monthly rollover at go-live failed; consuming on the ledger as it stands");
      captureError(err, { orgId: args.orgId, route: "relay.credits.consume_rollover", extra: { sessionId: args.sessionId } });
    }
  }
  const reuse = await reuseWindowOpen(tx, args, now);
  const split = await creditBreakdown(tx, args.orgId);
  const balance = split.total;
  if (reuse) {
    log.info({ orgId: args.orgId, fixtureId: args.fixtureId, sid: args.sessionId, reason: "reuse_24h" }, "stream credits: restart within the reuse window, no consume");
    return { consumed: false, balance, ledgerId: null };   // no row written, so no id
  }
  let balanceAfter: number;
  try {
    ({ balanceAfter } = debit(balance));                                   // FS10 in memory, before the row
  } catch (e) {
    if (e instanceof InsufficientCredits) throw new NoCreditsError(args.orgId);
    throw e;
  }
  // V426: the free monthly credit is spent first — it expires at month end, a bought one never
  // does. `> 0`, not `>= 0`: at monthly 0 the credit comes from the pack (debit above has already
  // proved the total covers it, and no writer leaves a bucket negative).
  const bucket: StreamCreditBucket = split.monthly > 0 ? "monthly" : "pack";
  // `returning id` — Task 10 writes it to fixture_stream_sessions.credit_ledger_id,
  // so the session row points at the exact row that paid for it.
  const [row] = await tx<{ id: string }[]>`
    insert into org_stream_credits (org_id, delta, reason, bucket, session_id, balance_after)
    values (${args.orgId}, -1, 'consume', ${bucket}, ${args.sessionId}, ${balanceAfter})
    returning id`;
  return { consumed: true, balance: balanceAfter, ledgerId: row!.id };
}

/** Ruling 13 item 6: the purchase row carries its Stripe link — which checkout,
 *  which payment, which pack, how much, in what currency. Ids and amounts only;
 *  never card data (Stripe holds that). */
export interface PurchaseLink {
  checkoutSessionId: string | null; paymentIntentId: string | null;
  /** The pack's Stripe lookup key. The field is named `pack` and NOT given the
   *  `…Key` suffix: the sanitiser's allowlist guard refuses any key matching
   *  /key|secret|pass|token|…/, and an allowlist entry needing a hand-written
   *  exemption is one nobody rereads. The COLUMN is still `pack_key` (C10). */
  pack: string | null;
  amountMinor: number | null; currency: string | null;
}

export async function recordPurchase(args: {
  orgId: string; delta: number; stripeEventId: string; note?: string; link?: PurchaseLink;
}): Promise<{ id: string; applied: boolean; balance: number }> {
  // `delta_invalid` (re-review N6): `handler` forwards a code and drops `extra`, so a refusal with
  // no code reaches the webhook's caller as a bare 422 — indistinguishable from the ledger's own
  // refusals, which every other throw in this file names.
  if (!Number.isInteger(args.delta) || args.delta <= 0) throw new HttpError(422, "purchase delta must be a positive integer", "delta_invalid");
  const link = args.link ?? { checkoutSessionId: null, paymentIntentId: null, pack: null, amountMinor: null, currency: null };
  return sql.begin(async (tx) => {
    await lockOrg(tx, args.orgId);
    const balance = await creditBalance(tx, args.orgId);
    const { balanceAfter } = credit(balance, args.delta);
    const [inserted] = await tx<{ id: string }[]>`
      insert into org_stream_credits (org_id, delta, reason, stripe_event_id, balance_after, note,
                                      stripe_checkout_session_id, stripe_payment_intent_id, pack_key, amount_minor, currency)
      values (${args.orgId}, ${args.delta}, 'purchase', ${args.stripeEventId}, ${balanceAfter}, ${args.note ?? null},
              ${link.checkoutSessionId}, ${link.paymentIntentId}, ${link.pack}, ${link.amountMinor}, ${link.currency?.toLowerCase() ?? null})
      on conflict (stripe_event_id) do nothing
      returning id`;
    if (inserted) return { id: inserted.id, applied: true, balance: balanceAfter };
    // The read-back is org-SCOPED, exactly as staffRow's key check is (review C1). stripe_event_id
    // is unique TABLE-wide, so `on conflict do nothing` above swallows the same event id arriving
    // for a SECOND org — and an unscoped read-back would then hand this caller the FIRST org's row:
    // `applied: false` to an org that paid and got nothing, plus an id that would cross-link two
    // orgs through fixture_stream_sessions.credit_ledger_id. The ledger is append-only, so that
    // state can only be compensated, never corrected. A conflict on another org's event is a
    // reused id, not an idempotent replay, and it is refused with nothing written.
    const [existing] = await tx<{ id: string; org_id: string }[]>`
      select id, org_id from org_stream_credits where stripe_event_id = ${args.stripeEventId}`;
    if (existing!.org_id !== args.orgId.toLowerCase()) {
      throw new HttpError(409, "That Stripe event was already recorded against a different organisation; nothing was written", "stripe_event_org_mismatch");
    }
    return { id: existing!.id, applied: false, balance };
  }) as Promise<{ id: string; applied: boolean; balance: number }>;
}

// ---------------------------------------------------------------------------
// Stripe claw-back (streaming R1 lane-B tail, OWNER RULING 2026-09-28)
// ---------------------------------------------------------------------------

/** What one refunded/disputed pack charge bought, and which org holds it. */
export interface StreamPurchaseMatch {
  orgId: string;
  /** The credits that purchase row granted. */
  purchased: number;
  /** When the ledger recorded it — the ATTRIBUTION BOUNDARY: consumption from
   *  this instant onward is what this purchase has spent. */
  purchasedAt: Date;
}

/** THE PAYMENT-INTENT GATE — one authority for it, because the refund arm, the
 *  partial-refund arm and the dispute arm must all answer "is this charge one of
 *  ours?" the same way or they disagree about what a match is.
 *
 *  The gate is `stripe_payment_intent_id`, never `charge.metadata`: Stripe does
 *  NOT copy `payment_intent_data.metadata` onto the Charge, so a
 *  Checkout-created pack charge arrives with `metadata: {}`, and reading it as
 *  the gate returns early on every real refund (it bit the AI pack path once —
 *  `handlePackChargeRefunded`'s own doc comment records it). `recordPurchase`
 *  already stores the intent, so this is a real COLUMN to match on and the
 *  matched path needs no Stripe round trip at all.
 *
 *  Indexed by V420 — `org_stream_credits_payment_intent`, partial on
 *  `stripe_payment_intent_id is not null`. It has to be its own index: there is
 *  no org in the predicate (finding out whose org it is IS the point), so
 *  V410's `(org_id, created_at)` cannot serve this, and without V420 the lookup
 *  is a seq scan of every row of every org — on a path that refunds and
 *  disputes belonging to other products reach too. The partial predicate is the
 *  null test ALONE and deliberately not `reason = 'purchase'`: a claw-back row
 *  carries the same intent so a human can walk the ledger back to the Stripe
 *  object, and an index narrowed to purchases could not serve that walk.
 *  Do NOT amend V410, which is merged.
 *
 *  `reason = 'purchase'` scopes it to the BOUGHT row. A claw-back row carries
 *  the same intent (so a human can walk the ledger back to the Stripe object),
 *  and without this predicate a second refund event would match its own earlier
 *  revoke and read `purchased` as a negative number.
 *
 *  One checkout session mints one payment intent and writes one purchase row
 *  (`stripe_event_id` is the session id and is unique table-wide), so at most
 *  one row can match; `order by created_at limit 1` makes that assumption
 *  explicit rather than depending on an unordered scan. */
export async function findStreamPurchase(
  exec: Executor,
  paymentIntentId: string,
): Promise<StreamPurchaseMatch | null> {
  const [row] = await exec<{ org_id: string; delta: number; created_at: Date }[]>`
    select org_id, delta, created_at from org_stream_credits
     where reason = 'purchase' and stripe_payment_intent_id = ${paymentIntentId}
     order by created_at limit 1`;
  return row ? { orgId: row.org_id, purchased: row.delta, purchasedAt: new Date(row.created_at) } : null;
}

/** The Stripe object that caused a claw-back. Note copy only — deliberately NOT
 *  part of the idempotency key, which is keyed on the payment intent alone so a
 *  lost dispute and a refund of the SAME charge collapse onto one row. */
const CLAWBACK_CAUSE = { refund: "refunded charge", dispute: "lost dispute" } as const;

export interface StreamPackRefundResult {
  /** A `purchase` row exists for this payment intent — i.e. this charge sold match credits. */
  matched: boolean;
  /** Credits revoked against this intent IN TOTAL, by this call or an earlier one. */
  clawedBack: number;
  /** Credits the matched purchase granted. 0 when nothing matched. */
  purchased: number;
  /** The org that holds them. Null when nothing matched. */
  orgId: string | null;
  /** Did THIS call write the revoke row? False on a replay, and false when there
   *  was nothing left to claw back. */
  applied: boolean;
}

/**
 * Claw back a refunded (or lost-disputed) match-credit pack — OWNER RULING
 * 2026-09-28, the ruling block in the streaming R1 `_STATE.md`.
 *
 * **Bounded by what THIS PURCHASE still has outstanding, and then by the
 * balance** — `min(purchased − consumedSince, balance)`. A SPENT match credit
 * means the stream already broadcast and Cloudflare already billed us for those
 * minutes; we cannot un-deliver it. The caller compares `clawedBack` with
 * `purchased` and alerts a human on the difference; this writer never judges.
 * Since V426 both limbs are read in the PACK bucket — pack consumes, pack
 * balance — and the row is a pack row: the free monthly credits were never
 * bought, so they are neither what a refund returns nor what shields one.
 *
 * The owner ruling's own words are `min(creditsPurchased, currentBalance)`, and
 * THAT formula caps by the org's TOTAL balance, which is not the same thing once
 * an org holds two packs (review C-1/G-1; orchestrator ruling 2026-09-28,
 * carrying the owner's reasoning, owner informed and able to veto). Worked
 * example of what the ruled formula does on a FIRST delivery: buy pack A (5),
 * stream all 5, buy pack B (5) — balance 5 — then refund A. `min(5, 5) = 5`
 * revokes pack B's credits, the org is refunded for A and silently loses the B
 * it paid for separately, and because `clawedBack === purchased` it reads as a
 * clean reversal and nobody is told. The attribution bound is a TIGHTENING: it
 * can only ever claw LESS than the ruled formula, never more.
 *
 * The balance limb is kept as a floor, because attribution alone does not see a
 * non-consume reduction: an expiry or a staff revoke lowers the balance without
 * spending the purchase, and an uncapped revoke would then write a negative
 * `balance_after` and trip V410's CHECK inside the webhook.
 *
 * This is ALSO what closes the zero-claw replay hole. A fully-spent pack writes
 * no row (V410's `delta <> 0`), so it mints no idempotency key, and a lost
 * dispute arriving weeks later carries a DIFFERENT Stripe event id that the
 * `billing_events` claim does not stop. `consumedSince` only ever grows, so
 * `outstanding` only ever shrinks: that dispute can never claw more than the
 * refund already did, with no sentinel row and no schema change. The two guards
 * cover DIFFERENT hazards and neither stands in for the other — the key is what
 * stops a double-claw after a claw-back that DID write a row (attribution alone
 * would still see the same outstanding), so both are mutated separately.
 *
 * **Reason `revoke`, never `refund`:** in `org_stream_credits` a `refund` ADDS
 * credits back — it is the /admin remedy for a stream that failed. A card
 * claw-back moves the other way, and V410's `reason in (…)` CHECK is merged and
 * unamendable, so `revoke` is both the correct direction and the only value
 * available.
 *
 * **Idempotent on `stream_pack_refund:${paymentIntentId}`**, the donor's
 * `pass_refund:${intent}` pattern (lib/credits.ts:931, used by BOTH the refund
 * and the dispute arm there). The key names the intent and nothing else, so a
 * lost dispute that follows a refund of the same charge collapses onto the row
 * the refund already wrote. The check sits under the money lock and BEFORE the
 * cap, exactly as `staffRow`'s does: the balance cap CANNOT stand in for it —
 * an org that has since bought a NEW pack has a non-zero balance again, and a
 * replay reaching the cap would revoke the new pack's credits.
 *
 * **Zero claw-back writes NO row.** V410 constrains `delta <> 0`, so there is no
 * row to write when everything was already spent; `matched: true, applied:
 * false, clawedBack: 0` is how the caller tells that apart from "not our
 * charge". It also means a fully-spent claw-back mints no idempotency key —
 * which is safe only because the attribution bound above is independent of the
 * key, and is what the "lost dispute after a refund that clawed NOTHING" test
 * pins.
 *
 * **No `staff_audit_log` row.** `staff_audit_log.actor_id` is NOT NULL against
 * `users` and a webhook has no actor; the donor writes none for a webhook
 * claw-back either. The ledger row IS the trail, and the staff alert is the
 * notification.
 */
export async function recordStreamPackRefund(args: {
  paymentIntentId: string;
  /** Which arm called — note copy only. */
  via: "refund" | "dispute";
  /** The charge id (refund) or dispute id (dispute), for the note. */
  reference: string;
}): Promise<StreamPackRefundResult> {
  const intent = args.paymentIntentId;
  const key = `stream_pack_refund:${intent}`;
  return sql.begin(async (tx) => {
    // Read FIRST, unlocked, to learn WHICH org to lock — the donor's ordering
    // (lib/credits.ts:978-984). A non-stream charge (the common case: this arm
    // runs on every refunded charge in the system) leaves with no lock taken and
    // nothing written.
    const match = await findStreamPurchase(tx, intent);
    if (!match) return { matched: false, clawedBack: 0, purchased: 0, orgId: null, applied: false };

    await lockOrg(tx, match.orgId);

    // THE KEY CHECK — under the lock, ahead of the cap (staffRow's order). It
    // reports the EARLIER claw-back's size rather than zero, so the caller's
    // `clawedBack < purchased` alert decision is a function of ledger STATE and
    // not of call history: a redelivery must reach the same verdict as the
    // first delivery. (A deliberate departure from the donor, whose caller does
    // not read the number at all.)
    const [prior] = await tx<{ delta: number }[]>`
      select delta from org_stream_credits where idempotency_key = ${key}`;
    if (prior) {
      return { matched: true, clawedBack: -prior.delta, purchased: match.purchased, orgId: match.orgId, applied: false };
    }

    // V426: a claw-back takes back BOUGHT credits, so it is a PACK debit — read, attributed, capped
    // and written against the pack bucket. The org's free monthly credits are not what was refunded.
    const split = await creditBreakdown(tx, match.orgId);
    const pack = split.pack;
    // A NAMED REFUSAL, not a silent `Math.max(0, pack)` clamp (house rule:
    // assumptions are guards, not comments). V410's `balance_after >= 0` CHECK
    // constrains each row's SNAPSHOT of the TOTAL, not either bucket's sum, so a
    // corrupt row can still put the pack below zero. A clamp would quietly claw
    // back nothing and look like an ordinary fully-spent pack; this throws, the
    // webhook does not ACK, Stripe retries, and a human is made to look.
    if (pack < 0) {
      throw new HttpError(500, `This organisation's bought match-credit balance is ${pack}; refusing to claw back against a negative ledger`, "ledger_negative");
    }

    // ATTRIBUTION. Consumption from this purchase's own instant onward, which is
    // what it has spent. FIFO by ledger order: credits are fungible, so the
    // oldest outstanding purchase owns the oldest consume.
    //
    // The bound is `>=`, and the tie case is REAL rather than theoretical:
    // `org_stream_credits.id` is `gen_random_uuid()` (V410:251) — random, not
    // time-sortable — and the table has no sequence column, so two rows sharing
    // a `created_at` CANNOT be ordered. `>=` counts a tied consume as spent from
    // THIS purchase, i.e. more counted spent, less clawed back — the
    // conservative direction on a money path, and the one that cannot take a
    // credit the customer still holds. The purchase row cannot count itself:
    // `reason = 'consume'` excludes it.
    //
    // V426: PACK consumes only. A match paid from the free monthly credits did
    // not spend this purchase, and counting it would shield a refunded pack
    // from its own claw-back (buy 3, stream 3 on the monthly allowance, refund:
    // every-consume attribution claws back 0 and the customer keeps both).
    const [spent] = await tx<{ consumed: number }[]>`
      select coalesce(-sum(delta), 0)::int as consumed from org_stream_credits
       where org_id = ${match.orgId} and reason = 'consume' and bucket = 'pack'
         and created_at >= ${match.purchasedAt}`;
    // May go NEGATIVE when later packs' credits were also spent (consumedSince
    // counts every pack consume after this purchase, not just this pack's). The
    // `clawback <= 0` guard below is the single place that answers that, so
    // there is no second clamp here to cover for it.
    const outstanding = match.purchased - spent!.consumed;
    // Capped by the PACK, not the total: a staff revoke (also pack) lowers the
    // pack without a consume, and a total cap would then reach into the monthly
    // credits and drive the pack negative behind a non-negative balance_after.
    const clawback = Math.min(outstanding, pack);
    if (clawback <= 0) {
      return { matched: true, clawedBack: 0, purchased: match.purchased, orgId: match.orgId, applied: false };
    }
    // FS10 in memory before the row, as every other writer here does — against
    // the PACK, which is the floor that matters; the balance_after CHECK is the
    // backstop, not the guard. `clawback <= pack` by construction above, so this
    // cannot raise. The snapshot is still the org TOTAL (V426).
    debit(pack, clawback);
    const balanceAfter = split.total - clawback;

    await tx`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note,
                                      stripe_payment_intent_id, idempotency_key)
      values (${match.orgId}, ${-clawback}, 'revoke', 'pack', ${balanceAfter},
              ${`Stripe claw-back — ${CLAWBACK_CAUSE[args.via]} ${args.reference}, payment intent ${intent}`},
              ${intent}, ${key})`;
    return { matched: true, clawedBack: clawback, purchased: match.purchased, orgId: match.orgId, applied: true };
  }) as Promise<StreamPackRefundResult>;
}

/** The staff_audit_log actions of the three staff writers. Spread into admin-adjustments-log.ts's
 *  ADJUSTMENT_ACTIONS the way `...SUSPENSION_ACTIONS` (:64) and `...DISCOVERY_AUDIT_ACTIONS` (:67)
 *  are — NOT the way PASS_CREDIT_RESOLVE_ACTION (:71) is, which is a bare value, not a spread
 *  (re-pin 2026-09-27, FP-3). An org-targeted action outside that allowlist is audited and
 *  unreadable. Underscored, never dotted — admin-audit-actor-truth.test.ts reads a dotted literal
 *  beside a direct insert as a CUSTOMER self-service action. */
export const STREAM_CREDIT_AUDIT_ACTIONS = ["stream_credit_grant", "stream_credit_refund", "stream_credit_revoke"] as const;

type StaffKind = "grant" | "refund" | "revoke";
const AUDIT_ACTION: Record<StaffKind, AdjustmentAction> = {
  grant: "stream_credit_grant",
  refund: "stream_credit_refund",
  revoke: "stream_credit_revoke",
};

/** The ruled ceiling on ONE staff adjustment (plan §Task 7A Revision 1 item 4: 1-50 per action for
 *  every staff role, with NO exemption). Enforced HERE, at the single writer, and imported by 7A's
 *  route zod so the two cannot drift — the donor's `SUPPORT_CREDIT_CAP` (credits/route.ts) is a
 *  different thing, an RBAC gate a superadmin passes, and an absolute domain bound does not belong
 *  in an RBAC check. A route is not the only possible caller: Tasks 10/11/12 call grantCredits
 *  directly, and a bound only the route holds is a bound the second caller does not have. Same
 *  argument that put V410's `max_duration_minutes <= 300` in the DDL rather than only in a usecase. */
export const STAFF_CREDIT_MAX = 50;

/** The longest note a staff adjustment may carry, enforced on the TRIMMED value. Here for the same
 *  reason the ceiling above is: a route is not the only caller, and `note: string` accepts `""` —
 *  which `admin-adjustments-log.ts`'s `text()` turns into `null`, so the Adjustments log renders a
 *  money movement with no reason at all (re-review I5). 500 is the donor's own note bound
 *  (api/admin/orgs/[id]/credits/route.ts's `z.string().max(500)`), so staff meet one length on one
 *  page. It is not cosmetic: the note lands in `staff_audit_log.detail`, which V111 canonicalises
 *  into a hash chain, so an unbounded note is a column hazard. 7A's zod IMPORTS this rather than
 *  retyping 500, so the two cannot drift. */
export const STAFF_NOTE_MAX = 500;

export interface StaffCreditArgs {
  orgId: string;
  /** A positive integer for all three kinds; a revoke writes its negation. */
  delta: number;
  /** The staff user — org_stream_credits.created_by AND staff_audit_log.actor_id. */
  createdBy: string;
  note: string;
  /** One per panel submission, kept across retries (Task 7A). */
  idempotencyKey: string;
}

export interface StaffCreditResult { id: string; balance: number; applied: boolean }

async function staffRow(kind: StaffKind, args: StaffCreditArgs & { sessionId?: string | null }): Promise<StaffCreditResult> {
  // The ruled 1..STAFF_CREDIT_MAX bound, at the single writer (review I4). Written as two
  // comparisons so each end can be mutated on its own rather than covering for the other.
  if (!Number.isInteger(args.delta) || args.delta < 1 || args.delta > STAFF_CREDIT_MAX) {
    throw new HttpError(422, `A ${kind} must move between 1 and ${STAFF_CREDIT_MAX} match credits; got ${args.delta}`, "delta_out_of_range");
  }
  // The REASON, validated here and not only in 7A's zod (re-review I5) — same argument as the cap
  // above: `note: string` accepts `""` and `"   "`, and an empty reason is a money movement the
  // Adjustments log shows with no reason at all (its `text()` maps '' to null). The TRIMMED value
  // is what is checked AND what is stored, in the ledger row and in the audit detail, so the
  // value that was judged is the value an operator later reads. Two comparisons, so each end can
  // be mutated on its own rather than covering for the other.
  const note = args.note.trim();
  if (note.length < 1 || note.length > STAFF_NOTE_MAX) {
    throw new HttpError(422, `A ${kind} needs a reason of 1 to ${STAFF_NOTE_MAX} characters; got ${note.length}`, "note_invalid");
  }
  // Lower-cased: Postgres returns uuids lower-case, and z.uuid() accepts upper-case, so an exact
  // replay of a pasted upper-case id must still compare equal below. `orgId` is the NORMALISED
  // spelling, and it is what the audit row's target_id must carry: that column is TEXT (V103), so
  // an upper-case id there writes a row `adjustmentsForOrg` compares as a string and never finds —
  // money moved, no visible trail. org_stream_credits.org_id is `uuid` and normalises itself.
  const orgId = args.orgId.toLowerCase();
  const sessionId = args.sessionId ? args.sessionId.toLowerCase() : null;
  const delta = kind === "revoke" ? -args.delta : args.delta;   // the SIGNED delta the row stores
  return sql.begin(async (tx) => {
    await lockOrg(tx, args.orgId);   // FIRST: the money lock (an empty ledger included)
    const split = await creditBreakdown(tx, args.orgId);
    const balance = split.total;
    // V426: which pool this row moves. A staff grant, a goodwill refund and a revoke are PACK; a
    // linked refund is re-pointed below at the bucket of the consume it reverses.
    let bucket: StreamCreditBucket = "pack";

    // THE KEY CHECK — under the lock and BEFORE every guard (adminAdjust's order). Looked up
    // TABLE-wide (the V410 index is table-wide, the donor's V320 scope) so the stored row's org
    // is part of the comparison. An EXACT replay returns the original row and writes nothing, not
    // a second ledger row, not a second audit row. The SAME key with a different org, reason,
    // signed delta or session is a staff mistake (an amount retyped after a lost response), so
    // it is refused rather than silently answered `applied: false` (adminAdjust does the latter;
    // this is the recorded departure), and the refusal names nothing about the stored row. The
    // check must precede the refund cap and the revoke floor, because the ORIGINAL call has
    // already used them up — a replay that reached them would read as a 422.
    const [prior] = await tx<{ id: string; org_id: string; reason: string; delta: number; session_id: string | null }[]>`
      select id, org_id, reason, delta, session_id from org_stream_credits where idempotency_key = ${args.idempotencyKey}`;
    if (prior) {
      const same =
        prior.org_id === orgId && prior.reason === kind && prior.delta === delta && prior.session_id === sessionId;
      if (!same) {
        throw new HttpError(409, "That idempotency key was already used for a different adjustment; nothing was written", "idempotency_key_reused");
      }
      return { id: prior.id, balance, applied: false };
    }

    let balanceAfter: number;
    if (kind === "revoke") {
      // FS10 in memory, floored on the PACK (V426): a revoke is a pack debit, so revoking past the pack
      // while monthly credits are held would drive the pack negative behind a non-negative total — and
      // the next rollover's expire would then write a negative balance_after and fail every
      // createSession for this org. The balance_after CHECK is the backstop, not the guard.
      try {
        debit(split.pack, args.delta);
      } catch (e) {
        if (e instanceof InsufficientCredits) {
          throw new HttpError(422, `Revoking ${args.delta} would take this organisation's bought match credits (${split.pack}) below zero`, "insufficient_credits");
        }
        throw e;
      }
      balanceAfter = balance - args.delta;
    } else {
      if (kind === "refund" && sessionId) {
        // A linked refund returns what THAT session consumed, at most, across every refund linked to it.
        // LOCK ORDER (N2): the insert below takes FOR KEY SHARE on this fixture_stream_sessions row
        // (the session_id FK) AFTER the org lock, while Task 10's live transition holds that row FOR
        // UPDATE BEFORE consumeForSession takes the org lock — the opposite order. It cannot deadlock
        // only because a credit is consumed ONCE, at warming → live, so a session inside that
        // transaction has no committed consume row, and THIS cap refuses its refund BEFORE the insert.
        // Keep the cap ahead of the insert, and keep consume a one-shot, or this becomes a 40P01.
        const [s] = await tx<{ consumed: number; refunded: number; buckets: StreamCreditBucket[] | null }[]>`
          select coalesce(-sum(delta) filter (where reason = 'consume'), 0)::int as consumed,
                 coalesce(sum(delta) filter (where reason = 'refund'), 0)::int as refunded,
                 array_agg(distinct bucket) filter (where reason = 'consume') as buckets
            from org_stream_credits where org_id = ${args.orgId} and session_id = ${sessionId}`;
        if (s!.refunded + args.delta > s!.consumed) {
          throw new HttpError(422, `That session consumed ${s!.consumed} and has ${s!.refunded} refunded already; refund it unlinked if more is owed`, "refund_exceeds_consumed");
        }
        // V426: the credit goes back to the bucket it was drawn from, so a refunded free credit is
        // still a free one (and the next rollover sweeps it) and a refunded bought one never expires.
        // Past the cap above, the session consumed ≥ 1, so `buckets` has at least one entry. More than
        // one cannot happen — consume is a one-shot per session (the lock-order note above) — and a
        // guard, not a guess, answers it: picking either would move money between the pools.
        const drawn = s!.buckets ?? [];
        if (drawn.length !== 1) {
          throw new HttpError(500, `That session's consumes were drawn from ${drawn.length} buckets (${drawn.join(", ")}); refusing to guess which one the refund returns to`, "refund_bucket_ambiguous");
        }
        bucket = drawn[0]!;
      }
      ({ balanceAfter } = credit(balance, args.delta));
    }

    const [row] = await tx<{ id: string }[]>`
      insert into org_stream_credits (org_id, delta, reason, bucket, session_id, balance_after, note, created_by, idempotency_key)
      values (${args.orgId}, ${delta}, ${kind}, ${bucket}, ${sessionId}, ${balanceAfter}, ${note}, ${args.createdBy}, ${args.idempotencyKey})
      returning id`;
    // The unified staff audit, IN this transaction — adminAdjust's auditApplied statement
    // (lib/credits.ts): target 'org', balance_after in the detail, and `reason` = the note
    // (the key adjustmentsForOrg renders as the log's subject). Applied writes only.
    await tx`
      insert into staff_audit_log (actor_id, action, target_type, target_id, detail)
      values (${args.createdBy}, ${AUDIT_ACTION[kind]}, 'org', ${orgId},
              ${tx.json({ delta, reason: note, session_id: sessionId, ledger_id: row!.id, balance_after: balanceAfter } as never)})`;
    return { id: row!.id, balance: balanceAfter, applied: true };
  }).catch((err: unknown) => {
    // N3: one key on two DIFFERENT orgs at once holds two different money locks, so both writers
    // miss the lookup and the second insert raises 23505 on the TABLE-wide key index. That is a
    // reused key, not a server error. Caught OUTSIDE sql.begin: postgres.js rethrows a query
    // error even when the transaction callback catches it. The constraint-name check is
    // registration-submit.ts's idiom; any other 23505 stays an error.
    const pg = err as { code?: string; constraint_name?: string };
    if (pg.code === "23505" && pg.constraint_name === "org_stream_credits_idempotency_key") {
      throw new HttpError(409, "That idempotency key was already used for a different adjustment; nothing was written", "idempotency_key_reused");
    }
    throw err;
  }) as Promise<StaffCreditResult>;
}

export async function grantCredits(args: StaffCreditArgs): Promise<StaffCreditResult> {
  return staffRow("grant", args);
}

export async function refundCredits(args: StaffCreditArgs & { sessionId: string | null }): Promise<StaffCreditResult> {
  return staffRow("refund", args);
}

export async function revokeCredits(args: StaffCreditArgs): Promise<StaffCreditResult> {
  return staffRow("revoke", args);
}

// ---------------------------------------------------------------------------
// Monthly free match credits (Task 14b, V426, owner-approved 2026-09-29)
// ---------------------------------------------------------------------------

/** V426's numeric plan entitlement: free match credits per UTC calendar month. */
export const STREAM_MONTHLY_FEATURE = "streaming.credits.monthly";

/** The UTC calendar month a grant belongs to, `YYYY-MM`. Truncated in JS through lib/credits.ts's
 *  `utcMonthStart` — the AI grant's own anchor (#292) — never `date_trunc` in SQL, which truncates
 *  in the SESSION time zone (Europe/London in prod). */
export function streamMonthlyPeriod(now: Date): string {
  return utcMonthStart(now).toISOString().slice(0, 7);
}

/** The monthly grant's idempotency key — ONE authority for its spelling, shared by the grant and its
 *  fast path. Lower-cased for the reason orgMoneyLockKey is: an
 *  upper-case id pasted into a hand-built URL must name the same period's row. */
export function streamMonthlyGrantKey(orgId: string, period: string): string {
  return `stream-monthly:${orgId.toLowerCase()}:${period}`;
}

/** V426's `streaming.credits.monthly` rows for a set of plan keys, in ONE read — the ONLY place the
 *  rate is read (V426's header names this function). lib/credits.ts `monthlyPerSeatByPlan`'s shape,
 *  WITHOUT its per-seat multiplier: stream credits are per ORG (org_stream_credits.org_id), not per
 *  billing-group wallet. A plan with no row is absent from the map and grants nothing through the
 *  callers' `?? 0`.
 *
 *  DELIBERATE, not an oversight (Task 14b review M4): a row whose `int_value` is NULL also reads as 0.
 *  lib/credits.ts's AI grant reads NULL as "unlimited"; a stream grant has no unlimited — every credit
 *  is a paid relay minute — so the safe reading of an unset number is "grants nothing". A catalogue
 *  edit that nulls the row therefore stops the grant silently rather than handing out infinity; the
 *  catalogue test (V426's every-plan ≥ 1 sweep) is what notices it. */
export async function streamMonthlyRateByPlan(planKeys: readonly string[]): Promise<Map<string, number>> {
  const distinct = [...new Set(planKeys)];
  if (distinct.length === 0) return new Map();
  const rows = await sql<{ plan_key: string; int_value: number | null }[]>`
    select plan_key, int_value from plan_entitlements
     where feature_key = ${STREAM_MONTHLY_FEATURE} and plan_key in ${sql(distinct)}`;
  return new Map(rows.map((r) => [r.plan_key, r.int_value ?? 0]));
}

/** One org's monthly rate on its RESOLVED plan — `orgPlanKey`, the seven-arm read-time resolver every
 *  other entitlement read uses (lapsed comp, dunning grace, trial backstop, suspension …), so a churned
 *  org is granted community's rate, not its stale row's. Plans are group-scoped; the org's own id is
 *  what the resolver takes.
 *
 *  NEVER a pass key (addendum P): V426's rows for event_pass / event_pass_l are ONE-OFF amounts granted when a pass is
 *  bought (`grantPassStreamCredits`), and reading one here would grant it again every month. The resolver reads the
 *  org's SUBSCRIPTION, and no writer puts a pass key there — a pass is a competition_passes row, and a staff comp writes
 *  'pro' — so a pass key here is a corrupt subscription row. It grants nothing monthly and is REPORTED, rather than
 *  refused: this read sits on the go-live path (stream-sessions.ts `apply`), and going live must never hinge on the
 *  month's bookkeeping (M6). */
export async function streamMonthlyRate(orgId: string): Promise<number> {
  const plan = await orgPlanKey(orgId);
  if (isPassKey(plan)) {
    log.error({ orgId, plan }, "stream credits: the org's subscription resolves to an Event Pass key; no monthly grant");
    captureError(new Error(`subscription plan_key is the pass key ${plan}`), { orgId, route: "relay.credits.monthly_rate_pass_plan" });
    return 0;
  }
  return (await streamMonthlyRateByPlan([plan])).get(plan) ?? 0;
}

/** A mid-month top-up's idempotency key (Task 14b review I3): the period's base key plus the rate it tops the month up
 *  TO. Unique per period and target without a counter: after a top-up to R this period has granted R, so a later top-up
 *  targets a strictly higher rate, and a return to R (down, then up again) is owed nothing. The same authority for the
 *  spelling as the base key, so the ledger read below can find both by prefix. */
export function streamMonthlyDeltaKey(orgId: string, period: string, toRate: number): string {
  return `${streamMonthlyGrantKey(orgId, period)}:to-${toRate}`;
}

/** What this period has granted so far: whether its BASE grant exists (the rollover ran), and the sum of the base and
 *  every top-up. Grant rows only, by their keys — never the balance, which consumes and refunds move. */
async function monthlyGrantedThisPeriod(exec: Executor, orgId: string, period: string): Promise<{ hasBase: boolean; granted: number }> {
  const base = streamMonthlyGrantKey(orgId, period);
  const [r] = await exec<{ has_base: boolean; granted: number }[]>`
    select coalesce(bool_or(idempotency_key = ${base}), false) as has_base, coalesce(sum(delta), 0)::int as granted
      from org_stream_credits
     where org_id = ${orgId} and reason = 'grant' and bucket = 'monthly'
       and (idempotency_key = ${base} or starts_with(idempotency_key, ${`${base}:to-`}))`;
  return { hasBase: r!.has_base, granted: r!.granted };
}

/**
 * This month's free match credits for one org — the lazy path (R3, as amended by the Task 14b review M4: the ONLY
 * path — no cron sweeps it). The readers that act on the balance call it before they read: the division page
 * (`relayCredits`) and createSession's balance check; the go-live consume runs the same body under its own lock
 * (`consumeForSession`'s `monthly`, review M6), so a session that goes live after the month turns draws the new month's
 * grant. Two display readers do NOT (lane-close m7): the session projection's `balance` (stream-sessions.ts
 * `currentSession`) and the /admin credits panel (admin-stream-credits.ts) read the ledger as it stands, so across a
 * month turn they show last month's unexpired free credits until an acting reader rolls it. There is deliberately no
 * eager call on org creation and no cron: an org that never streams never needs a row.
 *
 * Owed, per UTC month: the base grant at the first call of the period (after expiring last month's leftover), and —
 * review I3 — a TOP-UP when the org's CURRENT plan grants more than this period has granted so far (a mid-month
 * upgrade), of exactly the difference. A downgrade is owed nothing and claws nothing back.
 *
 * The fast path is an unlocked PRE-FILTER: the rate (it must know the current plan to know whether a top-up is owed)
 * and ONE ledger read. grantMonthlyStreamCredits re-reads under the money lock, which is what makes two concurrent
 * callers produce one grant. A plan that grants 0 writes no key and so pays the full path on every call — no plan
 * does today (V426: every plan ≥ 1).
 *
 * Returns the credits granted by THIS call and the rate it resolved — relayCredits prints that rate as the allowance,
 * so the plan is resolved once per page read, not twice.
 */
export async function ensureMonthlyStreamGrantWithRate(orgId: string, now: Date = new Date()): Promise<{ granted: number; rate: number }> {
  const rate = await streamMonthlyRate(orgId);
  const so = await monthlyGrantedThisPeriod(sql, orgId, streamMonthlyPeriod(now));
  if (so.hasBase && so.granted >= rate) return { granted: 0, rate };
  return { granted: await grantMonthlyStreamCredits(orgId, rate, now), rate };
}

/** `ensureMonthlyStreamGrantWithRate`, for callers that only need what was granted. */
export async function ensureMonthlyStreamGrant(orgId: string, now: Date = new Date()): Promise<number> {
  return (await ensureMonthlyStreamGrantWithRate(orgId, now)).granted;
}

/** The rollover transaction for an ALREADY-RESOLVED rate (split out, as lib/credits.ts splits `grantMonthlyDelta`, so
 *  a caller that already holds the rate does not read it twice). The body is `rollMonthlyLocked`. */
export async function grantMonthlyStreamCredits(orgId: string, rate: number, now: Date = new Date()): Promise<number> {
  assertMonthlyRate(rate);
  return sql.begin(async (tx) => {
    await lockOrg(tx, orgId);
    return rollMonthlyLocked(tx, orgId, rate, now);
  }) as Promise<number>;
}

/** A rate that is not a non-negative integer is a broken catalogue row, not a grant: refuse it by name before any row
 *  is written rather than let credit()'s generic error surface from inside. */
function assertMonthlyRate(rate: number): void {
  if (!Number.isInteger(rate) || rate < 0) {
    throw new HttpError(500, `The monthly match-credit rate must be a non-negative integer; got ${rate}`, "monthly_rate_invalid");
  }
}

/**
 * The rollover body. The CALLER holds the org's money lock (grantMonthlyStreamCredits takes it; consumeForSession
 * already holds it). Under it:
 *   1. re-read what this period has granted — base present and nothing owed → 0, nothing written;
 *   2. refuse a negative bucket by name (`ledger_negative`);
 *   3a. no base yet (a new period): expire EXACTLY the monthly leftover (reason 'expire', bucket 'monthly'), never the
 *       pack — no row when nothing is left (V410: delta <> 0) — then grant `rate` (reason 'grant', bucket 'monthly',
 *       the period's key); no grant row for a rate of 0;
 *   3b. base present but the rate is higher (I3, a mid-month upgrade): grant `rate − granted` under the top-up key.
 *       No expire: the leftover is this month's own.
 * One transaction, so an org is never seen between its expiry and its grant. The expire row carries NO idempotency
 * key: step 1's re-read makes the whole body idempotent per period, and a key on it would collide with a legitimate
 * second expiry (a rate-0 month followed by a refund). A refund that lands after the rollover returns to 'monthly'
 * (its consume's bucket), and the NEXT rollover sweeps it with the rest — monthly credits (top-ups included) never
 * outlive the month they are spent in by more than one rollover.
 */
async function rollMonthlyLocked(tx: Tx, orgId: string, rate: number, now: Date): Promise<number> {
  assertMonthlyRate(rate);
  const period = streamMonthlyPeriod(now);
  const so = await monthlyGrantedThisPeriod(tx, orgId, period);
  if (so.hasBase && so.granted >= rate) return 0;

  const split = await creditBreakdown(tx, orgId);
  // "Cannot happen" as a guard: no writer takes either bucket below zero (consume draws monthly only while > 0; every
  // revoke is floored on the pack). A negative monthly bucket granted on top of would silently hand the org rate − n;
  // a negative pack would make the expire below write a negative snapshot and fail V410's CHECK on every
  // createSession. Two comparisons, so each limb can be mutated on its own.
  if (split.monthly < 0 || split.pack < 0) {
    throw new HttpError(500, `This organisation's match-credit buckets are monthly ${split.monthly}, pack ${split.pack}; refusing to roll over a negative ledger`, "ledger_negative");
  }
  if (so.hasBase) {
    const topUp = rate - so.granted;
    const { balanceAfter } = credit(split.total, topUp);
    await tx`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note, idempotency_key)
      values (${orgId}, ${topUp}, 'grant', 'monthly', ${balanceAfter},
              ${`Free match credits for ${period}: topped up to the plan's ${rate}`}, ${streamMonthlyDeltaKey(orgId, period, rate)})`;
    return topUp;
  }
  let balance = split.total;
  if (split.monthly > 0) {
    const { balanceAfter } = debit(balance, split.monthly);
    await tx`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note)
      values (${orgId}, ${-split.monthly}, 'expire', 'monthly', ${balanceAfter},
              ${`Unused free match credits expired before the ${period} grant`})`;
    balance = balanceAfter;
  }
  if (rate === 0) return 0;
  const { balanceAfter } = credit(balance, rate);
  await tx`
    insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note, idempotency_key)
    values (${orgId}, ${rate}, 'grant', 'monthly', ${balanceAfter},
            ${`Free match credits for ${period}`}, ${streamMonthlyGrantKey(orgId, period)})`;
  return rate;
}

// ---------------------------------------------------------------------------
// Event Pass match credits (Task 14b fix round 1, addendum P — owner decision 2026-09-29)
// ---------------------------------------------------------------------------

/** The pass grant's idempotency key — ONE authority for its spelling. The
 *  ANCHOR is lib/credits.ts `recordPassGrant`'s: the pass's payment intent, else its competition id. competition_passes
 *  (V271) has no id of its own — the competition is its primary key — and keying on the competition alone would
 *  suppress the grant on a genuine re-purchase after a refund (a NEW intent), the donor's review MINOR-2. A promotion-code
 *  pass settles with no intent at all, and falls back to the competition, which V271 makes unique per pass. */
export function streamPassGrantKey(anchor: string): string {
  return `stream-pass:${anchor}`;
}

/** An Event Pass rung's match credits. V426's `streaming.credits.monthly` row for the PASS key — for a pass key that
 *  value is a ONE-OFF amount granted when the pass is bought, never a monthly rate (owner, 2026-09-29: "event passes
 *  grant their stream credits ONCE, when bought"). Read through `streamMonthlyRateByPlan`, so V426's rows keep one
 *  reader and its NULL→0 reading. */
export async function streamPassCredits(passKey: PassKey): Promise<number> {
  return (await streamMonthlyRateByPlan([passKey])).get(passKey) ?? 0;
}

/**
 * Grant a bought Event Pass its match credits: ONE row to the pass's ORG — reason 'grant', bucket 'pack' (they never
 * expire, and the monthly rollover never sweeps them), idempotency key `stream-pass:{anchor}`. Called by
 * lib/billing.ts `recordPassPurchase`, the only production insert of a pass, beside the AI credit grant: on the winning
 * insert and on a same-intent replay (which heals a first attempt that died between the two), never for a duplicate
 * second charge.
 *
 * Replay-safe: the key is looked up under the org's money lock, so a webhook and the buyer's return render racing on
 * one payment write one row. The same key already held by a DIFFERENT org cannot happen — a payment intent belongs to
 * one checkout of one org, and a competition to one org — so it is a GUARD, not a comment: nothing is written for the
 * second org and it is REPORTED (log + Sentry), then answered 0. Reported rather than thrown, unlike recordPurchase's
 * `stripe_event_org_mismatch`: there the credits ARE the purchase, here they ride on a pass that is already recorded,
 * and a throw would fail the pass webhook's ACK (and its entitlement-cache bust) on every Stripe retry for days.
 *
 * The amount is read BEFORE the transaction: it is a pooled read, and lib/db.ts refuses one nested inside a
 * transaction. A rung that grants 0 writes nothing (V410: delta <> 0). Returns the credits granted by THIS call.
 */
export async function grantPassStreamCredits(args: { orgId: string; passKey: PassKey; anchor: string }): Promise<number> {
  const amount = await streamPassCredits(args.passKey);
  // 0 (a rung with no row, or a NULL one) grants nothing. A negative catalogue value is NOT folded into that: it reaches
  // credit(), whose positiveInt refuses it by name inside the transaction, before any row is written.
  if (amount === 0) return 0;
  const key = streamPassGrantKey(args.anchor);
  return sql.begin(async (tx) => {
    await lockOrg(tx, args.orgId);
    const [prior] = await tx<{ org_id: string }[]>`
      select org_id from org_stream_credits where idempotency_key = ${key}`;
    if (prior) {
      if (prior.org_id !== args.orgId.toLowerCase()) {
        log.error({ orgId: args.orgId, holder: prior.org_id, key }, "stream credits: an Event Pass grant key is held by another org; nothing granted");
        captureError(new Error(`stream pass grant key ${key} is held by another org`), {
          orgId: args.orgId, route: "relay.credits.pass_grant_org_mismatch", extra: { holder: prior.org_id, key },
        });
      }
      return 0;
    }
    const { total } = await creditBreakdown(tx, args.orgId);
    const { balanceAfter } = credit(total, amount);
    await tx`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note, idempotency_key)
      values (${args.orgId}, ${amount}, 'grant', 'pack', ${balanceAfter},
              ${`Event Pass (${args.passKey}): ${amount} match credits, granted once, never expire`}, ${key})`;
    return amount;
  }) as Promise<number>;
}
