import "server-only";
// Refund money and policy: stripeRefund, receipts, the failure alert, the resolved policy (see ./index.ts).
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { getStripe } from "@/lib/stripe";
import { refundIssuedEmail, registrationRefundFailedAlertEmail } from "@/lib/email";
import { enqueueEmailOnce, expiryWithin, recipientLocale } from "@/server/email-outbox";
import { isoFromZonedParts } from "@/lib/zoned-datetime";
import { log } from "@/server/logger";
import { ownPaymentRefundedCents } from "@/lib/registration-status";
import { queueStaffAlert } from "../staff-alert";
import { audit } from "../audit";
import type { Tx, RegistrationWithGroupRow, DivisionCtx } from "./types";
import { regGroupCols } from "./lookups";

/** Mirror refunds made outside the app (Stripe dashboard) so the console
 *  never shows money we no longer hold. Monotonic — never regresses. */
export async function syncRegistrationRefund(charge: Stripe.Charge): Promise<void> {
  const intent =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;
  if (!intent) return;
  // The whole payment envelope (payment_intent_id, refunded_cents,
  // refunded_at) lives on registration_groups now (V364).
  await sql`
    update registration_groups
    set refunded_cents = greatest(refunded_cents, ${charge.amount_refunded}),
        refunded_at = coalesce(refunded_at, now()), updated_at = now()
    where payment_intent_id = ${intent}`;
  // Polish wave final fix m5: the ENTRY's own total too, when the payment is one entry's alone (its own `payment_intent_id`, V387).
  // The per-entry readers - the delete guards, the knockout desk, the panel's Refund - read it, and a dashboard refund never reached
  // it: a fully refunded entry was still offered Refund (Stripe then refused) and never cleared a delete guard. What was sent back of
  // THIS payment is `amount_refunded`, capped at the entry's price; a refunded LATE payment already in its history
  // (`late_refunded_cents`, V510) is another payment's and stays on top. Monotonic like the cart's. A payment shared by several entries
  // of a cart is not split by guessing: the cart mirror above is all it gets. An in-app refund holds the entry row across its Stripe
  // call (`refundEntryUnderLock`, `refundRegistration`), so this waits for its booking and then finds nothing left to raise.
  await sql`
    update registrations
    set refunded_cents = greatest(refunded_cents, late_refunded_cents + least(${charge.amount_refunded}::int, amount_cents)),
        updated_at = now()
    where payment_intent_id = ${intent}
      and (select count(*) from registrations same where same.payment_intent_id = ${intent}) = 1`;
}

// ---------------------------------------------------------------------------
// Withdraw core + refunds (shared by public + organiser paths)
// ---------------------------------------------------------------------------

/** Refund a payment taken as a destination charge: money comes back off the
 *  connected account, the platform returns its application fee. Exported for
 *  `registration-approval.ts` (RS002 W5 whole-branch review) —
 *  `rejectRegistration` reuses this verbatim to refund a paid-awaiting-
 *  approval entry it declines, same as withdrawCore/refundRegistration. */
export async function stripeRefund(
  paymentIntentId: string,
  amountCents: number | undefined,
  opts: { idempotencyKey?: string } = {},
): Promise<Stripe.Refund> {
  const params: Stripe.RefundCreateParams = {
    payment_intent: paymentIntentId,
    ...(amountCents !== undefined ? { amount: amountCents } : {}),
    reverse_transfer: true,
    refund_application_fee: true,
  };
  // Polish wave P5 (carry c), final review m6: a refund of an entry's own payment (the organiser's Refund, withdrawal, reject, the
  // pool-deadline sweep) passes `registrationRefundKey`, so a retry of the same refund is the same refund at Stripe. The webhook's
  // late and duplicate refunds keep the one-argument call (each is keyed by its own payment and replay-guarded by the webhook).
  return opts.idempotencyKey ? getStripe().refunds.create(params, { idempotencyKey: opts.idempotencyKey }) : getStripe().refunds.create(params);
}

/**
 * Queue the registrant's refund receipt on the email outbox, on the transaction that records the refund (`tx`): the receipt and the
 * `refunded_cents` it reports commit together or not at all, so a refund the books lost is never mailed and a refund the books kept is
 * never silently unmailed. Returns the outbox id, or `null` when there is nothing to send: the same Stripe refund already has its receipt
 * (a webhook delivered twice, a retry), or the receipt could not be queued.
 *
 * The ref is the REFUND (`refund/<Stripe refund id>`), and so is the once-key: two partial refunds of one entry are two receipts, each
 * naming its own amount, and neither supersedes the other (the replace rule keys on kind + ref + recipient). The key is a Stripe id, so it
 * is globally unique.
 *
 * The receipt is a courtesy about money that has ALREADY moved at Stripe, so a failure here must never undo or fail the refund. It is
 * contained at its own savepoint: a statement that errors inside a Postgres transaction aborts the whole transaction, which would roll
 * back `refunded_cents` and push the refund into the caller's `refund_failed` path although the money had left. The render is inside the
 * same try, so a template error is contained as well. The language is the registrant's (D4: the cart's pick, then the linked account,
 * then the organiser's default).
 *
 * `ctx` is read by the caller BEFORE its transaction opens (a pooled read inside a tenant transaction waits on the connection the
 * transaction holds, #996). Exported for `registration-approval.ts` and the refund tests.
 */
export async function queueRefundReceipt(
  tx: Tx,
  a: { reg: RegistrationWithGroupRow; ctx: DivisionCtx; amountCents: number; refundId: string },
): Promise<string | null> {
  const { reg, ctx, amountCents, refundId } = a;
  try {
    return await tx.savepoint(async (sp) => {
      const locale = await recipientLocale(sp, { pick: reg.locale, userId: reg.user_id, orgDefault: ctx.default_locale });
      const content = await refundIssuedEmail(
        {
          orgName: ctx.org_name,
          competitionName: ctx.comp_name,
          displayName: reg.display_name,
          contactName: reg.contact_name,
          amountCents,
          currency: reg.currency,
          refCode: reg.ref_code,
        },
        locale,
      );
      return enqueueEmailOnce(sp, {
        kind: "refund_issued",
        refType: "refund",
        refId: refundId,
        orgId: reg.org_id,
        to: reg.contact_email,
        ...content,
        transactional: false,
        expiresAt: expiryWithin(null),
        dedupeKey: refundId,
      });
    });
  } catch (err) {
    log.error({ err, registrationId: reg.id, refundId }, "registration: refund receipt could not be queued");
    return null;
  }
}

/** Whether Stripe ANSWERED a refund call with an error (it carries the HTTP status Stripe returned), as opposed to the call never
 *  getting an answer (a connection error, a timeout). Stripe keeps the first answer to an idempotency key, errors included, for 24
 *  hours: after an answered error the same key only replays it, so the next attempt needs a new one (final review m1). After an
 *  unanswered call the key must stay: the refund may have gone through, and the same key is what turns the retry into a replay. */
export function stripeAnsweredError(err: unknown): boolean {
  return typeof (err as { statusCode?: unknown } | null)?.statusCode === "number";
}

/**
 * The Stripe idempotency key of a refund of ONE entry's own payment - the one format every refund path uses (the organiser's Refund,
 * the withdrawal refund, the reject refund, the pool-deadline sweep; final review m6). Read UNDER the entry's lock, so its parts only
 * move when a refund is booked or a failure recorded:
 *  - `refunded_cents` as the books hold it: a second legitimate refund of the same amount reads a different total, so it is a
 *    different refund; a retry of a refund whose booking was lost (Stripe moved the money, the transaction rolled back) reads the
 *    same total and replays at Stripe instead of sending the money twice;
 *  - the amount;
 *  - the failures Stripe answered for this entry so far (`registration.refund_failed` rows with `stripe_answered`): Stripe replays
 *    an answered error for 24 hours, so a retry after the organiser fixed the cause (a topped-up connected account) must carry a new
 *    key or it is refused again (m1). No suffix while there are none, so the key of an untroubled refund is unchanged.
 */
export async function registrationRefundKey(tx: Tx, reg: Pick<RegistrationWithGroupRow, "id" | "refunded_cents">, amountCents: number): Promise<string> {
  const [{ n }] = await tx<{ n: number }[]>`
    select count(*)::int as n from competition_events
     where type = 'registration.refund_failed'
       and payload->>'registration_id' = ${reg.id}
       and payload->>'stripe_answered' = 'true'`;
  return `registration-refund:${reg.id}:${reg.refunded_cents}:${amountCents}${n > 0 ? `:f${n}` : ""}`;
}

/** The record of a refund that did not go through: `registration.refund_failed` (the organiser console reads the shortfall, and
 *  `registrationRefundKey` counts the answered ones). Written on the pool, after the refund's own transaction rolled back. */
export async function recordRefundFailure(
  a: { regId: string; competitionId: string; orgId: string; mode: string; err: unknown; actorId: string | null },
): Promise<void> {
  await audit(sql, a.competitionId, a.orgId, "registration.refund_failed", {
    registration_id: a.regId,
    mode: a.mode,
    stripe_answered: stripeAnsweredError(a.err),
  }, a.actorId);
}

/**
 * Refund THIS entry's own payment, the shape every automatic refund shares with the organiser's Refund (final review m6): the entry
 * row (and its cart row) is locked, the cap is read under the lock (`amount_cents - ownPaymentRefundedCents`), Stripe is called
 * with `registrationRefundKey`, and the refund is booked on both tables with its receipt and its audit entry - all inside the one
 * transaction. A withdrawal or a rejection used to read the cap in its status-changing transaction and call Stripe after the commit,
 * outside any lock and with no key: an organiser pressing Refund during that call read the same cap and both refunds moved money
 * (on a shared-intent cart, a sibling's). Now the second caller waits for the first to book and reads what it left.
 *
 * `capCents` is the most this caller means to send back (the policy's amount, the amount the reject mail announced); the lock's
 * own reading can only lower it. Returns what was refunded, or `null` when nothing was (no payment of this entry's own, nothing left
 * under the lock, or Stripe refused - recorded and alerted, never thrown: the status change that asked for the refund has
 * committed and must stand).
 */
export async function refundEntryUnderLock(a: {
  regId: string;
  ctx: DivisionCtx;
  capCents: number;
  mode: "auto" | "auto_pool_deadline" | "reject";
  actorId: string | null;
  /** For the failure alert when the failure came before the lock's own read (the caller's earlier read of the same entry). */
  currency: string;
}): Promise<{ amountCents: number; refundId: string; receiptId: string | null } | null> {
  let attempted: { amount: number; intent: string; reg: RegistrationWithGroupRow } | null = null;
  try {
    return await sql.begin(async (tx) => {
      const [locked] = await tx<RegistrationWithGroupRow[]>`
        select ${regGroupCols(tx)}
        from registrations r join registration_groups g on g.id = r.group_id
        where r.id = ${a.regId} for update`;
      const intent = locked?.entry_payment_intent_id;
      if (!locked || !intent) return null;
      const amount = Math.min(a.capCents, locked.amount_cents - ownPaymentRefundedCents(locked));
      if (amount <= 0) return null;
      attempted = { amount, intent, reg: locked };
      const refund = await stripeRefund(intent, amount, { idempotencyKey: await registrationRefundKey(tx, locked, amount) });
      await tx`
        update registrations set refunded_cents = refunded_cents + ${amount}, updated_at = now()
        where id = ${locked.id}`;
      await tx`
        update registration_groups
        set refunded_cents = refunded_cents + ${amount}, refunded_at = now(), updated_at = now()
        where id = ${locked.group_id}`;
      const receiptId = await queueRefundReceipt(tx, { reg: locked, ctx: a.ctx, amountCents: amount, refundId: refund.id });
      await audit(tx, a.ctx.competition_id, a.ctx.org_id, "registration.refunded", {
        registration_id: locked.id,
        amount_cents: amount,
        mode: a.mode,
        stripe_refund_id: refund.id,
      }, a.actorId);
      return { amountCents: amount, refundId: refund.id, receiptId };
    }) as { amountCents: number; refundId: string; receiptId: string | null } | null;
  } catch (err) {
    // The refund failed (Stripe, or the booking after it): the transaction rolled back, and the status change that asked for it stands.
    await recordRefundFailure({ regId: a.regId, competitionId: a.ctx.competition_id, orgId: a.ctx.org_id, mode: a.mode, err, actorId: a.actorId });
    const tried = attempted as { amount: number; intent: string; reg: RegistrationWithGroupRow } | null;
    await maybeAlertRegistrationRefundFailed({
      registrationId: a.regId,
      orgId: a.ctx.org_id,
      competitionId: a.ctx.competition_id,
      amountCents: tried?.amount ?? a.capCents,
      currency: tried?.reg.currency ?? a.currency,
      paymentIntentId: tried?.intent ?? null,
      reason: errText(err),
      mode: a.mode,
    });
    return null;
  }
}

/** Plain string for a caught refund error — never rendered to a customer,
 *  only into the staff alert body/log below. */
export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Best-effort staff alert (this task's gap): a registration refund FAILED,
 * so the organiser now owes a registrant money that never moved.
 * `registration.refund_failed` (the audit call every caller keeps making
 * right alongside this) is written and never read outside tests — without
 * this, the failure is invisible until the registrant complains.
 *
 * Queued on the email outbox through `queueStaffAlert` (phase 3 wave 5, kind
 * `staff_registration_refund_failed`), on the pool and never on the refund's
 * own record transaction (R2: every caller is in its catch, after that
 * transaction is gone). The writer owns the STAFF_ALERT_EMAIL gate and the
 * never-throws discipline (Q1): every call site sits on a refund's OWN
 * failure path, so an alert that threw would turn "a refund failed" into "the
 * webhook/request fails and retries forever" — telemetry strictly worse than
 * the fault it reports. Awaited rather than fire-and-forget: this path is
 * rare, nothing here is user-facing latency a registrant/organiser is waiting
 * on, and a floating promise cannot be tested honestly.
 *
 * Once per registration, `mode` and amount (plan P-W5-7): `mode` is the one
 * the caller's audit row already writes (`late`/`duplicate` from the
 * webhook, `auto` from a withdrawal, `auto_pool_deadline` from the sweep,
 * `reject` from a rejection). A webhook replay or a sweep re-run that fails
 * the same unmoved refund again pages once; a different amount (the state
 * moved) pages again.
 *
 * Goes to the PLATFORM OPERATOR only (owner ruling) — never the organiser or
 * the registrant. The usual causes (a restricted connected account, a
 * reversed transfer with no headroom, a disconnected destination) are
 * Connect/platform-level and not something an organiser can act on;
 * alerting them would produce alarm with no remedy. An organiser-facing
 * console surface is out of scope here.
 *
 * Returns the queued row's id, or null (unset address, a replay, or a drop
 * the writer logged). Exported so the contract is tested DIRECTLY.
 */
export async function maybeAlertRegistrationRefundFailed(opts: {
  registrationId: string;
  orgId: string;
  competitionId: string;
  amountCents: number;
  currency: string;
  paymentIntentId: string | null;
  reason: string;
  mode: "late" | "duplicate" | "auto" | "auto_pool_deadline" | "reject";
}): Promise<string | null> {
  const { mode, ...alert } = opts;
  return queueStaffAlert({
    kind: "staff_registration_refund_failed",
    refType: "registration",
    id: opts.registrationId,
    suffix: `${mode}:${opts.amountCents}`,
    render: () => registrationRefundFailedAlertEmail(alert),
  });
}

export interface ResolvedRefundPolicy {
  refundable: boolean;
  /** ISO instant, or null only when NEITHER an explicit lock NOR the
   *  competition's own `starts_on` exists to fall back to — see `reason`. */
  deadline: string | null;
  /** This entry's own remaining unrefunded balance — what would come back if
   *  it were withdrawn right now, regardless of `refundable` (a registrant
   *  past the deadline can still be shown what is at stake). */
  amount_cents: number;
  /** Set only when `refundable` is false because NO deadline could be
   *  derived at all — no explicit `refund_lock_at` AND no competition
   *  `starts_on` (owner ruling, RS007 follow-up to V379): an org that never
   *  configured either is fail-CLOSED, not auto-refundable forever. Lets a
   *  surface distinguish "we cannot know when this event begins, ask the
   *  organiser" from an ordinary past-deadline decline. Null in every other
   *  case, refundable or not (including a KNOWN deadline that has simply
   *  passed). */
  reason: "no_deadline" | null;
}

/**
 * V379/RS007 — the refund policy an entry sits under RIGHT NOW. Shared by
 * `withdrawCore`'s auto-refund decision and the read path
 * (`buildGroupStatusView`) so a registrant can never be shown a policy on
 * the status page that the write path would not actually honour.
 *
 * NULL `refundLockAt` no longer means "refundable forever" (owner ruling).
 * The lock-DATE policy stays — the org still controls refunds by setting one
 * date, not by actioning each refund individually — but an org that never
 * configured a lock now falls back to the competition's own `starts_on`,
 * rather than staying auto-refundable right up until (and past) kickoff,
 * after the money is already committed to a venue. An EXPLICIT
 * `refund_lock_at` always wins over this fallback — never averaged,
 * never the earlier/later of the two, just a plain `??`.
 *
 * RS007 follow-up (this wave, closing a gap the V379 comment above did not):
 * a NULL `refundLockAt` with a NULL `startsOn` used to leave the derived
 * deadline null too, which the boolean below read as "no deadline, so still
 * open" — refundable forever, the exact behaviour V379 claims it removed.
 * Owner ruling: no derivable deadline at all is fail-CLOSED (`refundable:
 * false`, `reason: "no_deadline"`), never fail-open — an organiser bleeding
 * refunds through a window that never closes is a worse failure than a
 * registrant having to ask a human.
 *
 * `startsOn` is a DATE column (`competitions.starts_on`, no time-of-day) and
 * carries no zone of its own — `tz` resolves the fallback in the
 * COMPETITION's governing clock (`resolveVenueTz(null, organizations.timezone)`,
 * the same "orgTz, never a division's own schedule_settings.tz" rule
 * `loadSettings`/`zoned-datetime.ts` document for every other value derived
 * from a competition- rather than division-scoped field): `starts_on`
 * belongs to the competition, not any one division, so every division of one
 * competition must derive the identical instant from it — a per-division
 * override here would silently disagree with a sibling entry in the same
 * cart the exact way #397 already fixed for fixture scheduling. Real spread
 * is UTC-12…UTC+14: parsing as bare UTC midnight (the old behaviour) could
 * leave an Asia/Kolkata org auto-refunding until 05:30 local on the morning
 * of play.
 */
export function resolveRefundPolicy(
  refundLockAt: Date | null,
  startsOn: string | null,
  tz: string,
  paymentIntentId: string | null,
  amountCents: number,
  refundedCents: number,
): ResolvedRefundPolicy {
  const startsOnDeadline = startsOn ? isoFromZonedParts(startsOn, "00:00", tz) : null;
  const lockAt = refundLockAt ?? (startsOnDeadline ? new Date(startsOnDeadline) : null);
  const remaining = amountCents - refundedCents;
  return {
    refundable: !!paymentIntentId && remaining > 0 && !!lockAt && new Date() < lockAt,
    deadline: lockAt ? lockAt.toISOString() : null,
    amount_cents: remaining,
    reason: lockAt ? null : "no_deadline",
  };
}
