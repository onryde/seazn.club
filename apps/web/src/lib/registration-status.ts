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
