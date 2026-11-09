import "server-only";
// Stripe event processing: Connect payout health and external-account changes (see ./index.ts).
import type Stripe from "stripe";
import { log } from "@/server/logger";
import {
  recordConnectPayout,
  recordExternalAccountChange,
} from "@/server/usecases/stripe-connect";
import { alertConnectBankRemoved } from "./staff-alerts";

// ---------------------------------------------------------------------------
// Payout health + trial warning (V411)
// ---------------------------------------------------------------------------

/**
 * `payout.paid` / `payout.failed` on a CONNECTED account.
 *
 * The connected account id is on `event.account`, NOT on the payout — a
 * `Stripe.Payout` has no account field at all, so the `account.updated` trick
 * of reading `object.id` does not transfer and a handler written that way
 * would silently mirror onto nothing. An event without it is not ours to act
 * on (it would be the PLATFORM's own payout, which this endpoint is not
 * subscribed to) and is ACKed unchanged.
 */
export async function handleConnectPayout(event: Stripe.Event): Promise<void> {
  const accountId = event.account;
  const payout = event.data.object as Stripe.Payout;
  if (!accountId) {
    log.warn({ event_id: event.id, payout_id: payout.id }, "connect: payout event without account");
    return;
  }
  const alert = await recordConnectPayout(accountId, payout);
  if (alert === undefined) {
    log.warn({ event_id: event.id, account_id: accountId }, "connect: payout for unknown account");
  }
}

/**
 * `account.external_account.updated` / `.deleted` on a CONNECTED account: the
 * club's destination bank account changed, or is gone.
 *
 * Two outputs, deliberately. The org-facing half is the stored alert (the
 * billing banner); the staff-facing half is an English ops email, because a
 * removed bank account on an org with live entry fees is money piling up that
 * a human may have to chase. The email follows the existing ops-alert
 * convention in this file — `STAFF_ALERT_EMAIL`, English-only, never throws
 * (`alertConnectBankRemoved`) — so it owes no dictionary work, and a failure to
 * alert must not fail the webhook and strand the DB write behind a retry loop.
 */
export async function handleExternalAccountChanged(event: Stripe.Event): Promise<void> {
  const accountId = event.account;
  const external = event.data.object as { id?: string; last4?: string; object?: string };
  if (!accountId) {
    log.warn({ event_id: event.id }, "connect: external_account event without account");
    return;
  }
  const deleted = event.type === "account.external_account.deleted";
  const detail = `${external.object ?? "external_account"} ${external.id ?? "?"}${
    external.last4 ? ` ••••${external.last4}` : ""
  }`;
  const org = await recordExternalAccountChange(
    accountId,
    deleted ? "bank_removed" : "bank_changed",
    detail,
  );
  if (!org) {
    log.warn(
      { event_id: event.id, account_id: accountId },
      "connect: external_account change for unknown account",
    );
    return;
  }
  // Only the DESTRUCTIVE half pages staff. `.updated` fires for benign edits
  // (a default_for_currency flip, a metadata change), and an ops inbox that
  // receives those stops being read — which would cost us the `.deleted`
  // alert that actually matters. The org still gets its banner either way.
  if (!deleted) return;
  await alertConnectBankRemoved({ eventId: event.id, orgId: org.id, orgName: org.name, accountId, detail });
}
