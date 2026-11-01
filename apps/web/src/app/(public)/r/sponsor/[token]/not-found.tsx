// The ONE answer for a sponsor report token that opens nothing - unknown, revoked, malformed, or its sponsor deleted
// (R4 S14). It takes no props and reads no token, so the body cannot differ between those cases.
import { getDictionary, t } from "@/lib/i18n";
import { resolveLocale } from "@/lib/resolve-locale";
import { SponsorReportNotice } from "@/components/sponsors/report-view";

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
