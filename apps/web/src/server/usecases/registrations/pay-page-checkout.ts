import "server-only";
// Pay from the player payment page (plan 2026-11-11-player-payment-page, Task 3; see ./index.ts): reuse-or-expire on the
// entry's own session pointer (`registrations.pay_session_id`, V505), mint for this entry alone, return to the page.
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { getStripe } from "@/lib/stripe";
import { registrationPayPath } from "@/lib/registration-pay";
import { log } from "@/server/logger";
import { divisionCtx } from "./lookups";
import { checkoutRegistrationIds, mintEntryPayPageCheckout } from "./checkout";
import { payPageDocByToken } from "./pay-page";

/** A stored session is handed out again only while more than this is left of it (the sponsor rule's value, sponsors.ts). */
export const PAY_SESSION_REUSE_MARGIN_MS = 10 * 60_000;

const stripeUnavailable = () =>
  new HttpError(502, "Stripe was unable to start this checkout — please try again shortly.");

/**
 * The Pay button: a Checkout URL for this entry alone. Outside any transaction (the Stripe calls are network round-trips), the
 * same shape as `ensureDealCheckout`:
 * 1. the page's document at press time (`null` → 404) - so an organiser's switch to offline, a mark-paid or a waiver after the
 *    page loaded, or a passed deadline the hourly sweep has not caught yet, refuses here: anything but `pay` → 409;
 * 2. Connect live, else 503 - before any reuse, so a disabled account is handed nothing;
 * 3. the stored session, if any: `complete` → 409 (paid in Stripe, the webhook has not landed); `open`, covering exactly this
 *    entry and with more than the margin left → handed out again (no mint); any other `open` one → expired first;
 * 4. one mint for `[entry]` returning to the page, claiming the pointer on the value read in 3.
 * A Stripe failure reading or expiring the stored session refuses (502) rather than mint beside a session that may still pay.
 */
export async function payFromPayPage(token: string, origin: string, now: Date = new Date()): Promise<string> {
  const doc = await payPageDocByToken(token, now);
  if (doc === null) throw new HttpError(404, "Not found");
  if (doc.state !== "pay") {
    throw new HttpError(409, "This entry has nothing to pay online right now", "REGISTRATION_NOT_PAYABLE");
  }

  // Connect live BEFORE any session is handed out (Review Focus 5, controller ruling): with charges off, Pay answers 503 and
  // neither reuses a stored session nor mints.
  const [row] = await sql<{ division_id: string }[]>`select division_id from registrations where id = ${doc.registrationId}`;
  if (!row) throw new HttpError(404, "Not found"); // deleted between the document read and here
  const ctx = await divisionCtx(sql, row.division_id);
  if (!ctx.charges_enabled) {
    throw new HttpError(503, "Payments are not set up for this organiser yet");
  }

  const read = doc.paySessionId;
  if (read) {
    let stored: Stripe.Checkout.Session;
    try {
      stored = await getStripe().checkout.sessions.retrieve(read);
    } catch (err) {
      log.error({ err, registrationId: doc.registrationId }, "registration pay page: could not read the stored session");
      throw stripeUnavailable();
    }
    if (stored.status === "complete") {
      throw new HttpError(409, "This entry has already been paid", "REGISTRATION_PAID_ONLINE");
    }
    if (stored.status === "open") {
      const ids = checkoutRegistrationIds(stored);
      const onlyThisEntry = ids.length === 1 && ids[0] === doc.registrationId;
      if (onlyThisEntry && stored.url && stored.expires_at * 1000 > now.getTime() + PAY_SESSION_REUSE_MARGIN_MS) {
        return stored.url;
      }
      try {
        await getStripe().checkout.sessions.expire(read);
      } catch (err) {
        log.error({ err, registrationId: doc.registrationId }, "registration pay page: could not expire the stored session");
        throw stripeUnavailable();
      }
    }
  }

  const returnBase = `${origin}${registrationPayPath(token)}?src=pay`;
  return mintEntryPayPageCheckout(doc.groupId, doc.registrationId, ctx, origin, returnBase, read);
}
