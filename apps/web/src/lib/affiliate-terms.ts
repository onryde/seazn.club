// One authority for what the affiliate program promises on the public site.
// The marketing dictionaries take these as {percent}/{years} parameters rather
// than spelling the numbers, so the page copy cannot drift from this file.
//
// NOTE: this file only DISPLAYS the terms. The commission itself is configured
// in the Revshare program dashboard, which must say the same (40% recurring,
// 24 months; payout delay 30 days, £50 minimum, PayPal) — nothing in this repo
// enforces any of it.
export const AFFILIATE_TERMS = {
  percent: 40,
  years: 2,
  // Payout terms, as configured in the Revshare dashboard (Payout Settings).
  payoutDelayDays: 30,
  payoutMinimum: "£50",
  payoutMethod: "PayPal",
} as const;

/** Where affiliates join, get their link and watch earnings (Revshare-hosted). */
export const AFFILIATE_PORTAL_URL = "https://seazn.revshare.so";
