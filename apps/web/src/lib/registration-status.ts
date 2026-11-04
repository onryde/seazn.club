// Registration status vocabulary — dependency-free (RS004 W3b review finding
// 1). `SPOT_HOLDERS` used to be hand-duplicated: registrations.ts declared
// the canonical array (re-exported for registration-approval.ts and
// registration-submit.ts), and the registration hub's page.tsx declared a
// second, byte-identical copy locally — specifically to avoid dragging
// registrations.ts's Stripe/email clients into a read-only page. That reason
// was sound; the duplicate was not. This is now the ONE place the list is
// declared: registrations.ts re-exports it (so its existing importers need
// no change), and page.tsx imports it directly from here.

/** Statuses that hold a capacity spot. */
export const SPOT_HOLDERS = ["pending", "paid", "confirmed"] as const;

/** FU1 fix round 1 (I1): statuses of a LIVE registration that has no entrant yet - one a later door may still seat
 *  (pending, paid) or promote (waitlisted). A `confirmed` row with no entrant (a solo sign-up waiting for a team) is
 *  live too; callers add that case beside this list (`status = 'confirmed' and entrant_id is null`). A confirmed row
 *  WITH an entrant is the entrant's business (ENTRANT_KIND_IN_USE), and the terminal statuses below hold nothing. */
export const LIVE_UNSEATED_STATUSES = ["pending", "paid", "waitlisted"] as const;

/** Statuses no writer moves a registration OUT of.
 *
 *  `rejected` is terminal by RS002's RULING A (terminal from EVERY writer, no
 *  exceptions); `withdrawn` and `expired` are terminal the same way in
 *  practice — `joinTeamEntry` refuses all three with "This entry is no longer
 *  accepting players", and nothing transitions them onward.
 *
 *  Declared HERE, beside SPOT_HOLDERS, for the same reason that array is: this
 *  module is dependency-free, so the server usecases and the read-only UI can
 *  share one list instead of the client re-deriving a second copy that drifts
 *  the first time a fourth terminal status appears.
 */
export const TERMINAL_STATUSES = ["withdrawn", "rejected", "expired"] as const;

/** True when the entry is in a state nothing moves it out of. */
export function isTerminalRegistrationStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
