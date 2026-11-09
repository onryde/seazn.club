// The ONE answer for a sponsor report token that opens nothing - unknown, revoked, malformed, or its sponsor deleted
// (R4 S14). It takes no props and reads no token, so the body cannot differ between those cases.
import type { Metadata } from "next";
import { getDictionary, t } from "@/lib/i18n";
import { resolveLocale } from "@/lib/resolve-locale";
import { SponsorReportNotice } from "@/components/sponsors/report-view";

/** The 404's own head. On notFound() Next skips the page's generateMetadata and reads this module's instead (next 16.3.6
 *  resolve-metadata.js, the error convention), so without it the 404 served the root layout's English title and
 *  description in every locale, and lost the page's no-referrer. The same for every token, like the body. */
export async function generateMetadata(): Promise<Metadata> {
  const ui = await getDictionary(await resolveLocale(), "ui");
  return {
    title: t(ui, "sponsorReport.notFound.title"),
    description: t(ui, "sponsorReport.notFound.body"),
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function SponsorReportNotFound() {
  const ui = await getDictionary(await resolveLocale(), "ui");
  return (
    <SponsorReportNotice
      testId="sponsor-report-not-found"
      title={t(ui, "sponsorReport.notFound.title")}
      body={t(ui, "sponsorReport.notFound.body")}
    />
  );
}
