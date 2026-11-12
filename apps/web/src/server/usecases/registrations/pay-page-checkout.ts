import "server-only";
// Pay from the player payment page (plan 2026-11-11-player-payment-page, Task 3; see ./index.ts): reuse-or-expire on the
// entry's own session pointer (`registrations.pay_session_id`, V505), mint for this entry alone, return to the page.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { registrationPayPath } from "@/lib/registration-pay";
import { divisionCtx } from "./lookups";
import {
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
 * 4. one mint for `[entry]` returning to the page, claiming the pointer on the value read in 3.
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
  // page's first press mints instead, and the mint expires the cart's session when it covers only this entry (subsumption).
  if (row.cart_session_id && row.cart_session_id !== read) {
    await refuseWhileSessionPays(row.cart_session_id, doc.registrationId);
  }
  if (read) {
    let stored = await readStoredSession(read, doc.registrationId);
    if (stored.status === "open") {
      const reuse = reusableSessionUrl(stored, doc.registrationId, now);
      if (reuse) return reuse;
      stored = await expireStoredSession(read, doc.registrationId);
    }
    if (stored.status === "complete" && (await completedSessionStillPays(stored, doc.registrationId))) {
      throw new HttpError(409, "This entry has already been paid", "REGISTRATION_PAID_ONLINE");
    }
  }

  const returnBase = `${origin}${registrationPayPath(token)}?src=pay`;
  return mintEntryPayPageCheckout(doc.groupId, doc.registrationId, ctx, origin, returnBase, read);
}
