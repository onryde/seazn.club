// Player payment page (plan 2026-11-11-player-payment-page): the client-safe half - the page's url, its one notice flag and
// the headers its routes answer with. No I/O, no server import: the mail producers, the page and the Pay route all read these.

/** The player's payment page: `/r/pay/<token>`, root-relative. The token is a bearer credential (32 random bytes, base64url);
 *  the scrubbers drop it. The static `pay` segment outranks `/r/[ref]`, and a ref code is 6 characters, so `pay` is never a ref. */
export function registrationPayPath(token: string): string {
  return `/r/pay/${token}`;
}

/** The page's notice flag (`?notice=...`), a display hint only: the page reads nothing else from it. The Pay route sends the
 *  player back with `recording` when Stripe says the payment is complete (or still processing) and the payment webhook has not
 *  landed yet, and with `retry` when the press lost a race to another press setting up the same payment. */
export const PAY_NOTICE_PARAM = "notice";
export const PAY_RECORDING_NOTICE = "recording";
export const PAY_RETRY_NOTICE = "retry";

/** The payment page with the "payment being recorded" notice. */
export function registrationPayRecordingPath(token: string): string {
  return `${registrationPayPath(token)}?${PAY_NOTICE_PARAM}=${PAY_RECORDING_NOTICE}`;
}

/** The payment page with the "already being set up - tap Pay again" notice. */
export function registrationPayRetryPath(token: string): string {
  return `${registrationPayPath(token)}?${PAY_NOTICE_PARAM}=${PAY_RETRY_NOTICE}`;
}

/** What every answer from the page's routes carries: per request, never indexed, never a Referer - a redirect's own
 *  Referrer-Policy is what the browser follows to Stripe with, so the token stays out of Stripe's logs. Same three headers as
 *  the sponsor invoice routes. */
export const REG_PAY_PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

/** The page's query, as far as the page reads it: Stripe's return (`checkout=success&session_id=...`, set by `payFromPayPage`'s
 *  returnBase) and the Pay route's notice. Every other param is ignored. */
export interface PayPageQuery {
  checkout?: string;
  session_id?: string;
  notice?: string;
}

/**
 * Whether the page shows "payment received - confirming" instead of Pay: only while the entry still reads `pay`, and only on a
 * return that is PROVABLY this entry's - the notice the Pay route sends when Stripe says the payment is complete, or Stripe's own
 * success return carrying the entry's CURRENT pay session. A `session_id` that is not that session (an old tab, a forged query)
 * is nothing: no spinner, the page's normal state. An entry with no pay session never matches, not even an empty `session_id`.
 */
export function isPayConfirming(doc: { state: string; paySessionId: string | null }, q: PayPageQuery): boolean {
  if (doc.state !== "pay") return false;
  if (q.notice === PAY_RECORDING_NOTICE) return true;
  return q.checkout === "success" && !!doc.paySessionId && q.session_id === doc.paySessionId;
}

/** An amount as the page prints it: the currency's own minor unit always shown (`€25.00`). */
export function payPageMoney(locale: string, cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
