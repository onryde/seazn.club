// Player payment page (plan 2026-11-11-player-payment-page): the client-safe half - the page's url, its one notice flag and
// the headers its routes answer with. No I/O, no server import: the mail producers, the page and the Pay route all read these.

/** The player's payment page: `/r/pay/<token>`, root-relative. The token is a bearer credential (32 random bytes, base64url);
 *  the scrubbers drop it. The static `pay` segment outranks `/r/[ref]`, and a ref code is 6 characters, so `pay` is never a ref. */
export function registrationPayPath(token: string): string {
  return `/r/pay/${token}`;
}

/** The page's one notice flag (`?notice=recording`): the Pay route sends the player back with it when Stripe says the card
 *  payment is complete and the payment webhook has not landed yet. A display hint only: the page reads nothing else from it. */
export const PAY_NOTICE_PARAM = "notice";
export const PAY_RECORDING_NOTICE = "recording";

/** The payment page with the "payment being recorded" notice. */
export function registrationPayRecordingPath(token: string): string {
  return `${registrationPayPath(token)}?${PAY_NOTICE_PARAM}=${PAY_RECORDING_NOTICE}`;
}

/** What every answer from the page's routes carries: per request, never indexed, never a Referer - a redirect's own
 *  Referrer-Policy is what the browser follows to Stripe with, so the token stays out of Stripe's logs. Same three headers as
 *  the sponsor invoice routes. */
export const REG_PAY_PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;
