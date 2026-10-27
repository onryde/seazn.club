// The one writer for staff alerts (phase 3 wave 5, spec §10; plan P-W5-1, P-W5-2, P-W5-3 / Q1). Every staff alert site renders its
// mail and queues it here, on the outbox; the worker sends it after the first-attempt window (no `dispatchNow`: webhooks and crons
// have no one waiting).
//
//  - The address is `STAFF_ALERT_EMAIL`. Unset or blank (the normal case outside production) is silent: `null` before the render and
//    before any statement, so a site's expensive work behind the alert is never paid for nothing (the "cheap guards first" pattern).
//  - On the pool, with no org (R2, R3): an alert reports a failure, so it is never written on the transaction whose failure it reports.
//  - Once per incident: the row's ref IS its once-key (P-W5-1). Every staff row has the same recipient and no org, so with a shared
//    ref the replace trigger would let a second incident about one id (a partial refund, then the full refund of the same charge)
//    supersede the first while it waits for the worker.
//  - Never throws (Q1, the D1 exception; owner 2026-10-26). An alert that cannot be queued is logged and sent to Sentry as an
//    issue, by kind and ref type, with no address, no key and no body, and dropped: a page that failed must not turn "a refund
//    failed" into "the webhook fails and retries forever". The Sentry issue is the page for the page that was lost: a `log.error`
//    alone reaches Sentry Logs only (`Sentry.pinoIntegration()` captures no level as an issue by default), so nobody would be told.
import "server-only";
import { sql } from "@/lib/db";
import type { EmailContent } from "@/lib/email";
import { captureError } from "@/lib/sentry";
import { enqueueEmailOnce, expiryWithin, onceKey, type OutboxKind } from "@/server/email-outbox";
import { log } from "@/server/logger";

/** The sixteen staff alert kinds: every kind named `staff_…`, which the spec's facts address to `STAFF_ALERT_EMAIL`. */
export type StaffKind = Extract<OutboxKind, `staff_${string}`>;

/** The message of the one log line a dropped staff alert writes. Exported so a site's test can assert its alert was never dropped:
 *  `queueStaffAlert` answers `null` for unset, for a replay and for a drop alike, and only this line tells the last one apart. */
export const STAFF_ALERT_QUEUE_FAILED = "staff alert could not be queued";

/** `STAFF_ALERT_EMAIL`, trimmed; null when it is unset or blank. The one read of the variable. */
function staffAlertAddress(): string | null {
  return process.env.STAFF_ALERT_EMAIL?.trim() || null;
}

/** Whether a staff alert would be queued at all (the address is set). For a site whose DECISION to alert costs a query (a trailing
 *  median, a plan's cap): it asks first, so the normal unset case pays for nothing. `queueStaffAlert` asks the same question. */
export function staffAlertsOn(): boolean {
  return staffAlertAddress() !== null;
}

/**
 * Queue one staff alert about `id` (a row UUID or a Stripe id) and return its row id; `null` when `STAFF_ALERT_EMAIL` is unset, when
 * this incident is already queued (`<id>` or `<id>:<suffix>` is taken for the kind), or when it could not be queued (logged). `render`
 * runs only once the address and the key exist.
 */
export async function queueStaffAlert(a: {
  kind: StaffKind;
  refType: string;
  id: string | null | undefined;
  suffix?: string;
  render: () => EmailContent | Promise<EmailContent>;
}): Promise<string | null> {
  const to = staffAlertAddress();
  if (!to) return null;
  try {
    const key = onceKey(a.kind, a.refType, a.id, a.suffix);
    const content = await a.render();
    // `return await`, not `return`: a rejected enqueue must land in this catch, not escape it as a rejected promise.
    return await enqueueEmailOnce(sql, {
      kind: a.kind,
      refType: a.refType,
      refId: key,
      dedupeKey: key,
      orgId: null,
      to,
      transactional: true,
      expiresAt: expiryWithin(null),
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
  } catch (err) {
    log.error({ err, kind: a.kind, refType: a.refType }, STAFF_ALERT_QUEUE_FAILED);
    captureError(err, { route: "staff-alert", extra: { kind: a.kind, refType: a.refType } });
    return null;
  }
}
