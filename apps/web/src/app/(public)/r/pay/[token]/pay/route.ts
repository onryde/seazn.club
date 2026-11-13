// Pay for a registration, POST /r/pay/[token]/pay (plan 2026-11-11-player-payment-page, Task 4): the payment page's Pay form. POST
// only - a link preview, a crawler or a prefetch never opens a Stripe session. `payFromPayPage` hands out the entry's own open
// session or mints one for this entry alone, and this answers 303 to Stripe Checkout. The page's contract otherwise (../page.tsx):
// `publicRateLimit` first, one opaque 404, never cached, no referrer (the redirect's own Referrer-Policy keeps the token out of the
// Referer Stripe sees).
//   - Stripe says the card payment is complete and the webhook has not landed (409 `REGISTRATION_PAID_ONLINE`): 303 BACK to the
//     page with its notice, so the player reads "confirming" rather than a Pay button that refuses again;
//   - a press that lost the race to another press setting up the same payment (409 `REGISTRATION_CHECKOUT_CONFLICT`): 303 BACK
//     to the page with `?notice=retry`, so the player reads "already being set up - tap Pay again" on the page, not bare text;
//   - any other refusal is a short plain-text answer with its own status: 409 (not payable now / changed meanwhile), 503 (the organiser's card payments are off), 502 (Stripe did not answer), 404, 429. Never a 500 for an HttpError.
// The text is in the ENTRY's language when it can be resolved (the document's), else the reader's. A throttled press and an unknown
// token read nothing further.
export const dynamic = "force-dynamic";

import { HttpError } from "@/lib/errors";
import { getDictionary, t } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n-constants";
import { baseUrl } from "@/lib/oauth";
import { REG_PAY_PRIVATE_HEADERS, registrationPayRecordingPath, registrationPayRetryPath } from "@/lib/registration-pay";
import { resolveLocale } from "@/lib/resolve-locale";
import { payFromPayPage, payPageDocByToken } from "@/server/usecases/registrations";
import { publicRateLimit } from "@/server/usecases/public";

type Ctx = { params: Promise<{ token: string }> };

/** The entry's language, or null when the token resolves to nothing (or the read fails: the answer must not become a 500). */
async function entryLocale(token: string): Promise<Locale | null> {
  try {
    return (await payPageDocByToken(token, new Date()))?.locale ?? null;
  } catch {
    return null;
  }
}

function messageKey(err: HttpError): string {
  if (err.status === 404) return "regPay.notFound.body";
  if (err.status === 429) return "regPay.throttled.body";
  if (err.status === 503) return "regPay.refused.unavailable";
  if (err.status === 409 && err.code !== "REGISTRATION_CHECKOUT_CONFLICT") return "regPay.refused.notPayable";
  return "regPay.refused.failed"; // 502 Stripe, 422 amount, anything else
}

export async function POST(req: Request, { params }: Ctx) {
  const { token } = await params;
  try {
    await publicRateLimit(req);
    const url = await payFromPayPage(token, baseUrl(req));
    return new Response(null, { status: 303, headers: { ...REG_PAY_PRIVATE_HEADERS, Location: url } });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    if (err.status === 409 && err.code === "REGISTRATION_PAID_ONLINE") {
      return new Response(null, { status: 303, headers: { ...REG_PAY_PRIVATE_HEADERS, Location: registrationPayRecordingPath(token) } });
    }
    if (err.status === 409 && err.code === "REGISTRATION_CHECKOUT_CONFLICT") {
      return new Response(null, { status: 303, headers: { ...REG_PAY_PRIVATE_HEADERS, Location: registrationPayRetryPath(token) } });
    }
    // 404 and 429 are answered before (or without) knowing an entry: the reader's language, no further read.
    const locale = err.status === 404 || err.status === 429 ? null : await entryLocale(token);
    const ui = await getDictionary(locale ?? (await resolveLocale()), "ui");
    return new Response(t(ui, messageKey(err) as never), {
      status: err.status,
      headers: { ...REG_PAY_PRIVATE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
