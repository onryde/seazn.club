// "Card payments aren't available right now" - ONE derivation for every surface that says it (walk-fix F5). With Connect unable to charge, a
// card division cannot take an entry (settings.ts closes it as `payments_unavailable`, spec #9 / P2-10), and the walkthrough found
// three surfaces silent about why: the register page ("not open"), the public competition page, and the organiser's hub
// ("Open now"). Dependency-free, so the server read model, the server pages and the client components all ask the same functions.

/** The public panel's `closed_reason` for a division closed by this, and the one value every reader compares against. */
export const CARD_PAYMENTS_UNAVAILABLE = "payments_unavailable";

/** A card division with a fee cannot take an entry while Connect cannot charge, or while the plan's paid-registration
 *  entitlement is gone. A free or offline division always can. */
export function cardPaymentsBroken(
  division: { payment_method: string | null; fee_cents: number },
  org: { charges_enabled: boolean; paid_entitled: boolean },
): boolean {
  return division.payment_method === "stripe" && division.fee_cents > 0 && (!org.charges_enabled || !org.paid_entitled);
}

/** The public pages: nothing is open, and at least one division is closed only for card payments - so "registration opens once
 *  the organiser turns them on" is the reason a visitor is owed instead of a bare "not open". An open division anywhere
 *  (an offline or free one still registers; a full one still takes the waitlist) means registration is not waiting on this. */
export function registrationWaitsOnCardPayments(
  divisions: readonly { open: boolean; closed_reason: string | null }[],
): boolean {
  return divisions.every((d) => !d.open) && divisions.some((d) => d.closed_reason === CARD_PAYMENTS_UNAVAILABLE);
}

/** The organiser's hub: an enabled card division with a fee, while Connect cannot charge - the organiser's remedy is payment
 *  setup (the plan-entitlement leg of `cardPaymentsBroken` has a different remedy and its own refusals). */
export function cardDivisionsWaitOnConnect(
  rows: readonly { enabled: boolean; payment_method: string | null; fee_cents: number }[],
  chargesEnabled: boolean,
): boolean {
  return !chargesEnabled && rows.some((r) => r.enabled && cardPaymentsBroken(r, { charges_enabled: false, paid_entitled: true }));
}
