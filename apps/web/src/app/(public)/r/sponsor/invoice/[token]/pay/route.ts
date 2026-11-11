// Pay a sponsor invoice by card, POST /r/sponsor/invoice/[token]/pay (sponsor deals, Task 22; spec §7): the invoice page's
// "Pay by card" form. POST only - a link preview, a crawler or a prefetch never opens a Stripe session. `payInvoice` gets the
// session from `ensureDealCheckout`, the one reuse-or-retire-and-mint rule (F32), and answers 303 to Stripe Checkout. An
// invoice that cannot be paid by card now (paid, refunded, cancelled, offline, still a draft) is refused with 409 before
// anything is minted. The page's contract otherwise (../page.tsx): `publicRateLimit` first, one opaque 404, never cached, no
// referrer (the redirect's own Referrer-Policy keeps the token out of the Referer Stripe sees). Refusals are short plain text
// in the reader's language.
export const dynamic = "force-dynamic";

import { HttpError } from "@/lib/errors";
import { getDictionary, t } from "@/lib/i18n";
import { baseUrl } from "@/lib/oauth";
import { resolveLocale } from "@/lib/resolve-locale";
import { INVOICE_PRIVATE_HEADERS } from "@/lib/sponsor-invoice";
import { publicRateLimit } from "@/server/usecases/public";
import { payInvoice } from "@/server/usecases/sponsor-deals";

type Ctx = { params: Promise<{ token: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const { token } = await params;
  try {
    await publicRateLimit(req);
    const url = await payInvoice(token, baseUrl(req));
    return new Response(null, { status: 303, headers: { ...INVOICE_PRIVATE_HEADERS, Location: url } });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    // 404: the token opens nothing. 429: over the public budget. 502: Stripe did not answer (nothing changed). Anything else
    // (409 not payable, 402 the club's plan no longer sells online) is the same refusal to the sponsor: not payable by card now.
    const key =
      err.status === 404
        ? "sponsors.invoice.notFound.body"
        : err.status === 429
          ? "sponsors.invoice.throttled.body"
          : err.status >= 500
            ? "sponsors.invoice.payFailed"
            : "sponsors.invoice.payRefused";
    const ui = await getDictionary(await resolveLocale(), "ui");
    return new Response(t(ui, key), { status: err.status, headers: { ...INVOICE_PRIVATE_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
  }
}
