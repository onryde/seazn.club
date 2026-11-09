import "server-only";
// Stripe event processing: the staff alerts queued on the email outbox (see ./index.ts).
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import {
  staffDisputeAlertEmail,
  stuckEventsAlertEmail,
  creditPackGrantFailedAlertEmail,
  type CreditPackGrantFailedAlertEmail,
  streamCreditClawbackAlertEmail,
  sizePackGrantFailedAlertEmail,
  type SizePackGrantFailedAlertEmail,
  extraOrgRepriceFailedAlertEmail,
  type ExtraOrgRepriceFailedAlertEmail,
  connectBankAlertEmail,
} from "@/lib/email";
import type { StaffDisputeAlertArgs } from "@/lib/email-templates";
import { queueStaffAlert } from "@/server/usecases/staff-alert";

/**
 * Staff alert: a buyer paid for an AI credit pack and holds nothing (phase 3 wave 5, kind `staff_credit_pack_grant_failed`). Queued on
 * the email outbox through `queueStaffAlert`, once per Stripe object (P-W5-10): the Checkout Session that paid and could not be granted
 * (ref type `checkout_session`, from `handleCheckoutCompleted`), or the refunded charge that found no pack_purchase row to claw back
 * (ref type `charge`, from `handlePackChargeRefunded`). Both ids are Stripe's, so the two cannot collide. Never throws (the writer's
 * Q1 catch): both callers ACK the webhook either way, and nothing here is retryable into a better outcome.
 */
export async function alertCreditPackGrantFailed(
  refType: "checkout_session" | "charge",
  opts: CreditPackGrantFailedAlertEmail,
): Promise<string | null> {
  return queueStaffAlert({
    kind: "staff_credit_pack_grant_failed",
    refType,
    id: opts.sessionId,
    render: () => creditPackGrantFailedAlertEmail(opts),
  });
}

/**
 * Staff alert: a buyer paid for a size pack and no cap was lifted (phase 3 wave 5, kind `staff_size_pack_grant_failed`). Queued on the
 * email outbox through `queueStaffAlert`, once per Checkout Session (`checkout_session` / `session.id`), from `grantSizePackAddon`.
 * Never throws (the writer's Q1 catch): the webhook ACKs either way, and a human must grant this manually.
 */
export async function alertSizePackGrantFailed(opts: SizePackGrantFailedAlertEmail): Promise<string | null> {
  return queueStaffAlert({
    kind: "staff_size_pack_grant_failed",
    refType: "checkout_session",
    id: opts.sessionId,
    render: () => sizePackGrantFailedAlertEmail(opts),
  });
}

/**
 * Best-effort staff alert (v17 gap #293, Task 4b): a billing group's
 * extra-organisation rider is stuck on a price that is NOT its plan's rate.
 * Queued on the email outbox (kind `staff_extra_org_reprice_failed`) to
 * STAFF_ALERT_EMAIL through `queueStaffAlert`.
 *
 * NEVER THROWS, and gated on STAFF_ALERT_EMAIL before anything else — both are
 * the writer's (Q1). It sits on the webhook's failure path, so an alert that
 * threw would turn "the rate is stale" into "the whole webhook fails and
 * retries for ever", i.e. the telemetry would become a strictly worse outcome
 * than the fault it reports. Awaited rather than fire-and-forget: this path is
 * rare, a webhook has no user waiting on it, and a floating promise cannot be
 * tested honestly.
 *
 * Once per rider per UTC DAY (Q2, P-W5-4): ref type `subscription`, keyed
 * `<group>:<item, or "plan" when none could be named>:<yyyy-mm-dd>`. The daily
 * sweep nags on purpose (a money fault should nag until someone acts), so the
 * webhook and the sweep together page a stuck rider once a day: a same-day cron
 * retry or webhook replay pages nothing more, and tomorrow's pass pages again.
 * Two stuck riders of one group are two pages, neither replacing the other
 * (P-W5-1). Null when nothing was queued.
 *
 * Exported so the never-throws contract can be tested DIRECTLY rather than
 * through the caller's own catch, which would hide a missing wrapper.
 */
export async function maybeAlertOrgRepriceFailed(opts: ExtraOrgRepriceFailedAlertEmail): Promise<string | null> {
  return queueStaffAlert({
    kind: "staff_extra_org_reprice_failed",
    refType: "subscription",
    id: opts.subscriptionId,
    suffix: `${opts.itemId ?? "plan"}:${new Date().toISOString().slice(0, 10)}`,
    render: () => extraOrgRepriceFailedAlertEmail(opts),
  });
}

/** The three reasons `streamCreditClawbackAlertEmail` is rendered with. Named
 *  constants rather than inline strings so the alert's reason is one authority
 *  and a test can assert the one it expects without retyping the sentence. */
export const STREAM_CLAWBACK_REASON = {
  short: "full refund clawed back fewer credits than the pack granted — the rest were already spent on live streams",
  partial: "partial refund — no automatic claw-back",
  ungranted: "refunded match-credit charge has no purchase ledger row to claw back",
} as const;

/** What `alertStreamClawback` is told: the incident's shape, with the ref type and fields that shape is keyed by. */
export type StreamClawbackAlert = {
  refId: string;
  orgId: string;
  purchased?: number;
  clawedBack?: number;
  reason: string;
} & (
  | { shape: "partial"; refType: "charge"; amountRefunded: number }
  | { shape: "short" | "ungranted"; refType: "charge" }
  | { shape: "lost"; refType: "dispute" }
);

/** The staff alert for a match-credit claw-back that needs a human: queued on
 *  the email outbox (kind `staff_stream_credit_clawback`) to STAFF_ALERT_EMAIL
 *  through `queueStaffAlert`, which never throws, so an alerting hiccup can
 *  never undo a claw-back or block the ACK. ONE function for all four call
 *  sites — the three in `handleStreamPackChargeRefunded` above (partial, short
 *  refund, ungranted) and the short lost-dispute one in `handlePlatformDispute`
 *  below.
 *
 *  Once per incident (P-W5-9): `<charge>:partial:<amount refunded>`,
 *  `<charge>:short` and `<charge>:ungranted` under ref type `charge`, and
 *  `<dispute>:lost` under `dispute`. A redelivery pages nothing more, while a
 *  partial refund and then the full refund of one charge are two incidents and
 *  two pages, neither replacing the other (P-W5-1). Null when nothing was
 *  queued.
 *
 *  The argument is a union on `shape`, so tsc holds each shape to the ref type
 *  its sites pass (a lost dispute is keyed by the dispute, every refund shape
 *  by the charge) and a partial refund cannot be queued without the amount its
 *  key carries (`partial:undefined` is unrepresentable, not merely unreached). */
export async function alertStreamClawback(a: StreamClawbackAlert): Promise<string | null> {
  return queueStaffAlert({
    kind: "staff_stream_credit_clawback",
    refType: a.refType,
    id: a.refId,
    suffix: a.shape === "partial" ? `partial:${a.amountRefunded}` : a.shape,
    render: () =>
      streamCreditClawbackAlertEmail({
        chargeId: a.refId,
        orgId: a.orgId,
        purchased: a.purchased,
        clawedBack: a.clawedBack,
        reason: a.reason,
      }),
  });
}

/** Staff notification for a PLATFORM-charge dispute: a best-effort
 *  staff_audit_log breadcrumb plus an alert queued on the email outbox (kind
 *  `staff_dispute_alert`, to STAFF_ALERT_EMAIL, nothing when unset), once per
 *  dispute PHASE (`<dispute>:created`, `<dispute>:closed`): a redelivered
 *  event pages nothing more, and a dispute's close is a second alert that does
 *  not replace its open. Rendered in the platform locale (en), whatever the
 *  org's own language. staff_audit_log.actor_id is NOT NULL (FK users) and a
 *  webhook dispute has no staff actor, so the row is attributed to the
 *  accountable superadmin and skipped when none exists (e.g. tests) — the same
 *  actorless limitation sponsors.ts documents. Never throws: the flag /
 *  downgrade / revoke is the source of truth and must not be undone by an
 *  alerting hiccup (the queue logs and reports its own failure). */
export async function notifyStaffDispute(
  kind: StaffDisputeAlertArgs["kind"],
  orgId: string,
  dispute: Stripe.Dispute,
  phase: "created" | "closed",
): Promise<void> {
  const [org] = await sql<{ name: string }[]>`
    select name from organizations where id = ${orgId}`;
  const orgName = org?.name ?? "the organisation";

  try {
    const [actor] = await sql<{ id: string }[]>`
      select id from users where is_staff = true and staff_role = 'superadmin'
      order by created_at limit 1`;
    if (actor) {
      await sql`
        insert into staff_audit_log (actor_id, action, target_type, target_id, detail)
        values (${actor.id}, 'platform_dispute', 'org', ${orgId},
                ${sql.json({
                  kind,
                  phase,
                  dispute_id: dispute.id,
                  status: dispute.status,
                  amount_cents: dispute.amount,
                } as never)})`;
    }
  } catch {
    /* breadcrumb is best-effort — never block the ACK */
  }

  await queueStaffAlert({
    kind: "staff_dispute_alert",
    refType: "dispute",
    id: dispute.id,
    suffix: phase,
    render: () =>
      staffDisputeAlertEmail(
        {
          kind,
          orgName,
          phase,
          status: dispute.status,
          amountCents: dispute.amount,
          currency: dispute.currency,
          disputeId: dispute.id,
        },
        "en",
      ),
  });
}

/** The staff alert for a connected org's DELETED bank account, queued on the
 *  email outbox (kind `staff_connect_bank_changed`, to STAFF_ALERT_EMAIL,
 *  nothing when unset) once per Stripe EVENT: a redelivered event pages nothing
 *  more, and the club removing a second bank account is a second event and a
 *  second alert. Never throws (the queue logs and reports its own failure).
 *  Resolves to the row's id, or null when nothing was queued. */
export async function alertConnectBankRemoved(a: {
  eventId: string;
  orgId: string;
  orgName: string;
  accountId: string;
  detail: string;
}): Promise<string | null> {
  return queueStaffAlert({
    kind: "staff_connect_bank_changed",
    refType: "stripe_event",
    id: a.eventId,
    render: () =>
      connectBankAlertEmail({ orgId: a.orgId, orgName: a.orgName, accountId: a.accountId, detail: a.detail }),
  });
}

/** The staff alert for a webhook event the sweep has just PARKED: queued on the
 *  email outbox (kind `staff_stuck_events`, to STAFF_ALERT_EMAIL, nothing when
 *  unset) once per event (`<event>:parked`), so a pass that re-reaches the alert
 *  for the same event pages nothing more. Never throws (the queue logs and
 *  reports its own failure). Resolves to the row's id, or null when nothing was
 *  queued. */
export async function alertStuckEventParked(a: {
  eventId: string;
  eventType: string;
  attempts: number;
}): Promise<string | null> {
  return queueStaffAlert({
    kind: "staff_stuck_events",
    refType: "stripe_event",
    id: a.eventId,
    suffix: "parked",
    render: () => stuckEventsAlertEmail({ eventId: a.eventId, eventType: a.eventType, attempts: a.attempts }),
  });
}
