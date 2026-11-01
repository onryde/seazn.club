// The public sponsor report, /r/sponsor/[token] (R4 sponsors on stream S14; spec 2026-10-27 §5.2, §7): the page a club's
// sponsor opens from the link the club shares (S13). No login. The token is the only credential, so:
//   - it is looked up by its hash and never logged, decoded or shape-checked (`sponsorReport`): an unknown, a revoked and a
//     malformed token are the same opaque 404 (./not-found.tsx), at the cost of the same one lookup;
//   - the page is per request and never cached (`force-dynamic`: Next sends `private, no-cache, no-store`), so a revoke closes
//     the link on the next load, and proxy.ts's CDN-cacheable set (`/shared`, `/embed`) does not include it;
//   - noindex, nofollow, and no referrer: the URL never leaves in a Referer, to the logo's host or the frame store;
//   - the scrubbers drop the token from analytics, Sentry and replay (`/r/sponsor/` in lib/scrub-score-url.ts).
// Rate-limited per client IP by `publicRateLimit` (the public API's own 60 a minute), BEFORE the lookup: a throttled visit
// gets its own screen, never the report and never the 404, and touches no row (no oracle). Next renders a page's own HTTP
// fallbacks as 404/403/401 only, so the throttled screen is this page's answer to the limit, not a 429 status
// (task-S14-report.md D1).
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { HttpError } from "@/lib/errors";
import { getDictionary, t } from "@/lib/i18n";
import { resolveLocale } from "@/lib/resolve-locale";
import { DictProvider } from "@/components/i18n/dict-provider";
import { SponsorReportNotice, SponsorReportView } from "@/components/sponsors/report-view";
import { sponsorReport } from "@/server/sponsors/report";
import { publicRateLimit } from "@/server/usecases/public";

export async function generateMetadata(): Promise<Metadata> {
  const ui = await getDictionary(await resolveLocale(), "ui");
  return { title: t(ui, "sponsorReport.meta.title"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/** True when this client is over the public read budget. Any other limiter failure is a real error. */
async function throttled(): Promise<boolean> {
  try {
    // `publicRateLimit` keys on the request's forwarded address; a page has the incoming headers, not a Request.
    await publicRateLimit(new Request("http://sponsor-report.invalid/", { headers: await headers() }));
    return false;
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) return true;
    throw err;
  }
}

export default async function SponsorReportPage({ params }: { params: Promise<{ token: string }> }) {
  const [{ token }, locale] = await Promise.all([params, resolveLocale()]);
  const ui = await getDictionary(locale, "ui");
  if (await throttled()) {
    return (
      <SponsorReportNotice
        testId="sponsor-report-throttled"
        title={t(ui, "sponsorReport.throttled.title")}
        body={t(ui, "sponsorReport.throttled.body")}
      />
    );
  }
  const report = await sponsorReport(token, new Date());
  if (report === null) notFound();
  return (
    <DictProvider dict={ui} locale={locale}>
      <SponsorReportView report={report} ui={ui} locale={locale} />
    </DictProvider>
  );
}
