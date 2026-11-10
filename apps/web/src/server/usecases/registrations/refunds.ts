import "server-only";
// Refund money and policy: stripeRefund, receipts, the failure alert, the resolved policy (see ./index.ts).
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { getStripe } from "@/lib/stripe";
import { refundIssuedEmail, registrationRefundFailedAlertEmail } from "@/lib/email";
import { enqueueEmailOnce, expiryWithin, recipientLocale } from "@/server/email-outbox";
import { isoFromZonedParts } from "@/lib/zoned-datetime";
import { log } from "@/server/logger";
import { queueStaffAlert } from "../staff-alert";
import type { Tx, RegistrationWithGroupRow, DivisionCtx } from "./types";

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
): Promise<Stripe.Refund> {
  return getStripe().refunds.create({
    payment_intent: paymentIntentId,
    ...(amountCents !== undefined ? { amount: amountCents } : {}),
    reverse_transfer: true,
    refund_application_fee: true,
  });
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
