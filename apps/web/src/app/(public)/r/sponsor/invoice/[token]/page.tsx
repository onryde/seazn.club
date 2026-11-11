// The sponsor's invoice, /r/sponsor/invoice/[token] (sponsor deals, Task 22; spec §7): the page a club's sponsor opens from the
// link the club sends (Task 23 mails it). No login. It follows the sponsor report's contract (../../[token]/page.tsx) exactly:
//   - the token is looked up by its hash and never logged, decoded or shape-checked (`invoiceDocByToken`): an unknown, a
//     rotated and a malformed token are the same opaque 404 (./not-found.tsx), at the cost of the same one lookup;
//   - the page is per request and never cached (`force-dynamic`), so a rotation closes the old link on the next load;
//   - noindex, nofollow, and no referrer: the URL never leaves in a Referer, to the logo's host or to Stripe;
//   - the scrubbers drop the token from analytics, Sentry and replay (`/r/sponsor/invoice/` in lib/scrub-score-url.ts), and the
//     two elements that paint it (the PDF link, the pay form) are `ph-no-capture`.
// Rate-limited per client IP by `publicRateLimit` BEFORE the lookup: a throttled visit gets its own screen and touches no row.
//
// The invoice is in the ORG's language (the club issues it); the head, the 404 and the throttled screen are in the reader's,
// since they are answered before - or without - knowing which club.
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { HttpError } from "@/lib/errors";
import { getDictionary, t } from "@/lib/i18n";
import { resolveLocale } from "@/lib/resolve-locale";
import { INVOICE_NOTICE_PARAM, PAYMENT_RECORDING_NOTICE, invoicePath } from "@/lib/sponsor-invoice";
import { SponsorInvoiceView } from "@/components/sponsors/invoice-view";
import { SponsorReportNotice } from "@/components/sponsors/report-view";
import { invoiceDocByToken } from "@/server/sponsors/invoice-doc";
import { publicRateLimit } from "@/server/usecases/public";

export async function generateMetadata(): Promise<Metadata> {
  const ui = await getDictionary(await resolveLocale(), "ui");
  return {
    title: t(ui, "sponsors.invoice.meta.title"),
    description: t(ui, "sponsors.invoice.meta.description"),
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

/** True when this client is over the public read budget. Any other limiter failure is a real error. */
async function throttled(): Promise<boolean> {
  try {
    await publicRateLimit(new Request("http://sponsor-invoice.invalid/", { headers: await headers() }));
    return false;
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) return true;
    throw err;
  }
}

export default async function SponsorInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  /** Every query param, untyped on purpose: only `notice` is read (the pay route's "being recorded" flag). */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  if (await throttled()) {
    const ui = await getDictionary(await resolveLocale(), "ui");
    return (
      <SponsorReportNotice
        testId="sponsor-invoice-throttled"
        title={t(ui, "sponsors.invoice.throttled.title")}
        body={t(ui, "sponsors.invoice.throttled.body")}
      />
    );
  }
  const doc = await invoiceDocByToken(token);
  if (doc === null) notFound();
  const ui = await getDictionary(doc.locale, "ui");
  const base = invoicePath(token);
  const recording = (await searchParams)[INVOICE_NOTICE_PARAM] === PAYMENT_RECORDING_NOTICE;
  return <SponsorInvoiceView doc={doc} ui={ui} pdfHref={`${base}/pdf`} payAction={`${base}/pay`} paymentRecording={recording} />;
}
