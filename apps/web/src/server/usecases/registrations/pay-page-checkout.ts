import "server-only";
import type Stripe from "stripe";
// Pay from the player payment page (plan 2026-11-11-player-payment-page, Task 3; see ./index.ts): reuse-or-expire on the
// entry's own session pointer (`registrations.pay_session_id`, V510), mint for this entry alone, return to the page.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { registrationPayPath } from "@/lib/registration-pay";
import { divisionCtx } from "./lookups";
import {
  checkoutRegistrationIds,
  completedSessionStillPays,
  expireStoredSession,
  mintEntryPayPageCheckout,
  readStoredSession,
  refuseWhileSessionPays,
  reusableSessionUrl,
} from "./checkout";
import { payPageDocByToken } from "./pay-page";

// The margin and the reuse rule live beside the cart status page's Pay (`./checkout`), which applies the same rule (polish wave W5).
export { PAY_SESSION_REUSE_MARGIN_MS } from "./checkout";

/** Whether a stored session sends the player back to a payment page (`/r/pay/<token>`), i.e. was minted by this page. The status
 *  page's per-entry session returns to the cart status page carrying the cart's access token, so it is never handed out here.
 *  An unreadable return URL is not this page's (fail closed: expire and mint). */
export function returnsToPayPage(stored: Pick<Stripe.Checkout.Session, "success_url">): boolean {
  if (!stored.success_url) return false;
  try {
    return new URL(stored.success_url).pathname.startsWith(registrationPayPath(""));
  } catch {
    return false;
  }
}

/**
 * The Pay button: a Checkout URL for this entry alone. Outside any transaction (the Stripe calls are network round-trips), the
 * same shape as `ensureDealCheckout`:
 * 1. the page's document at press time (`null` → 404) - so an organiser's switch to offline, a mark-paid or a waiver after the
 *    page loaded, or a passed deadline the hourly sweep has not caught yet, refuses here: anything but `pay` → 409;
 * 2. Connect live, else 503 - before any reuse, so a disabled account is handed nothing;
 * 3. the stored session, if any: `open`, covering exactly this entry and with more than the margin left → handed out again (no
 *    mint); any other `open` one → expired first (`expireStored`: if it stopped being open meanwhile, what it became is judged
 *    below instead); `complete` and still able to land money (`completedSessionStillPays`: paid, or a delayed-method payment
 *    still in flight) → 409 (the webhook has not landed); `complete` with a payment that FAILED - the session stays
 *    `complete` + `unpaid` forever - or `expired` is dead and minted past;
 * 4. the cart's session, when it is open and covers this entry alone, expired (walk-fix F12; never handed out, see below);
 * 5. one mint for `[entry]` returning to the page, claiming the pointer on the value read in 3.
 * A Stripe failure reading or expiring the stored session (or its PaymentIntent) refuses (502) rather than mint beside a session
 * that may still pay.
 */
export async function payFromPayPage(token: string, origin: string, now: Date = new Date()): Promise<string> {
  const doc = await payPageDocByToken(token, now);
  if (doc === null) throw new HttpError(404, "Not found");
  if (doc.state !== "pay") {
    throw new HttpError(409, "This entry has nothing to pay online right now", "REGISTRATION_NOT_PAYABLE");
  }

  // Connect live BEFORE any session is handed out (Review Focus 5, controller ruling): with charges off, Pay answers 503 and
  // neither reuses a stored session nor mints.
  const [row] = await sql<{ division_id: string; cart_session_id: string | null }[]>`
    select r.division_id, g.checkout_session_id as cart_session_id
    from registrations r join registration_groups g on g.id = r.group_id
    where r.id = ${doc.registrationId}`;
  if (!row) throw new HttpError(404, "Not found"); // deleted between the document read and here
  const ctx = await divisionCtx(sql, row.division_id);
  if (!ctx.charges_enabled) {
    throw new HttpError(503, "Payments are not set up for this organiser yet");
  }

  const read = doc.paySessionId;
  // Fix round 1 (F2): the cart status page's session, when it is not this page's own - a SEPA debit still processing there must
  // stop this page minting (or handing out) a second payment. The same rule the status page applies (`refuseWhileSessionPays`).
  // It never hands the cart's session OUT, even an open one for this entry alone (polish wave W5 ruling): that session returns to
  // the cart status page with the cart's access token in its URL - cancel and withdraw rights this pay link does not carry. The
  // page's first press mints instead, and the cart's session is expired BEFORE that mint when it covers only this entry (F12).
  const cart = row.cart_session_id && row.cart_session_id !== read ? await refuseWhileSessionPays(row.cart_session_id, doc.registrationId) : null;
  if (read) {
    let stored = await readStoredSession(read, doc.registrationId);
    if (stored.status === "open") {
      // Polish wave P5 (carry a): the entry's pointer can hold the STATUS page's session too; that one is never handed out here
      // (same reason as the cart's above) - it is expired below and this page mints its own.
      const reuse = returnsToPayPage(stored) ? reusableSessionUrl(stored, doc.registrationId, now) : null;
      if (reuse) return reuse;
      stored = await expireStoredSession(read, doc.registrationId);
    }
    if (stored.status === "complete" && (await completedSessionStillPays(stored, doc.registrationId))) {
      throw new HttpError(409, "This entry has already been paid", "REGISTRATION_PAID_ONLINE");
    }
  }

  // Walk-fix F12: the cart's session, still open and covering this entry alone (the sign-up session, or the status page's), is
  // retired BEFORE the mint, fail-closed - the status page's rule for the same session (`resumeRegistrationCheckout`, m8). The
  // mint's own supersede step runs after the create and is best-effort, so a Stripe hiccup there left two payable sessions for the
  // entry. One that also covers a sibling is not this entry's to expire (the supersede's subsumption rule leaves it too). Nor is a
  // session that returns to THIS page: on the cart pointer but not on the entry pointer this press read, it is a concurrent press's
  // own, already handed out - that press won, and this one's mint loses its pointer claim (409 CONFLICT) instead.
  if (cart?.status === "open" && !returnsToPayPage(cart)) {
    const ids = checkoutRegistrationIds(cart);
    if (ids.length > 0 && ids.every((id) => id === doc.registrationId)) {
      const settled = await expireStoredSession(cart.id, doc.registrationId);
      if (settled.status === "complete" && (await completedSessionStillPays(settled, doc.registrationId))) {
        throw new HttpError(409, "A payment for this entry is already on its way", "REGISTRATION_PAID_ONLINE");
      }
    }
  }

  const returnBase = `${origin}${registrationPayPath(token)}?src=pay`;
  return mintEntryPayPageCheckout(doc.groupId, doc.registrationId, ctx, origin, returnBase, read);
}
