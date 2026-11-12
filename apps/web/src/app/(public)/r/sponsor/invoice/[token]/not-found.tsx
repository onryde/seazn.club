// The ONE answer for a sponsor invoice token that opens nothing - unknown, rotated, malformed, an unnumbered deal, a deleted club
// (sponsor deals, Task 22). It takes no props and reads no token, so the body cannot differ between those cases. Its own head:
// on notFound() Next reads this module's metadata, not the page's (../../[token]/not-found.tsx says why).
import type { Metadata } from "next";
import { getDictionary, t } from "@/lib/i18n";
import { resolveLocale } from "@/lib/resolve-locale";
import { SponsorReportNotice } from "@/components/sponsors/report-view";

export async function generateMetadata(): Promise<Metadata> {
  const ui = await getDictionary(await resolveLocale(), "ui");
  return {
    title: t(ui, "sponsors.invoice.notFound.title"),
    description: t(ui, "sponsors.invoice.notFound.body"),
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function SponsorInvoiceNotFound() {
  const ui = await getDictionary(await resolveLocale(), "ui");
  return (
    <SponsorReportNotice
      testId="sponsor-invoice-not-found"
      title={t(ui, "sponsors.invoice.notFound.title")}
      body={t(ui, "sponsors.invoice.notFound.body")}
    />
  );
}
