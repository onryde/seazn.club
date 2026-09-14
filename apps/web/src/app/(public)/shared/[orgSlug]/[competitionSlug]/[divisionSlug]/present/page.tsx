export const revalidate = 30;
// Public presentation mode — division (v13/PROMPT-64): a no-login, shareable
// kiosk URL an organiser points a venue screen at. Reuses the noticeboard
// <Slideshow> with slides built from the PUBLIC read models (consent and
// visibility enforced by the public_* views); a private competition 404s.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicDivision } from "@/server/public-site/data";
import { buildPublicDivisionSlides } from "@/server/slideshow-data";
import { kioskTvHintLabels, slideshowLabels } from "@/server/slideshow-labels";
import { Slideshow } from "@/components/v2/slideshow";
import { KioskTvHint } from "@/components/public-site/kiosk-tv-hint";
import { kioskHubHref } from "@/components/public-site/kiosk-tv-hint-logic";
import { publicThemeStyle } from "@/lib/public-theme";

// Kiosk duplicate of the public division page — never indexed.
export const metadata: Metadata = { robots: { index: false } };

export default async function PresentDivisionPage({
  params,
}: {
  params: Promise<{ orgSlug: string; competitionSlug: string; divisionSlug: string }>;
}) {
  const { orgSlug, competitionSlug, divisionSlug } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
  if (!data) notFound();
  // P6 fix round 1, finding #2 (CRITICAL) — org.default_locale, not English
  // by construction: the builder has no request scope, and since N1c c3 it
  // loads the org-locale dictionaries itself (async, no database).
  const slides = await buildPublicDivisionSlides({ ...data, orgLocale: data.org.default_locale });
  return (
    <Slideshow
      title={`${data.competition.name} · ${data.division.name}`}
      slides={slides}
      backHref={`/shared/${orgSlug}/${competitionSlug}/${divisionSlug}`}
      themeStyle={publicThemeStyle(data.competition.branding)}
      // R10e u1: the board's own strings in the same locale as its slides.
      labels={slideshowLabels(data.org.default_locale)}
      // N1d d6: a phone that opens the kiosk gets a banner pointing at the
      // hub, filtered to this division, in the same locale as the board.
      notice={
        <KioskTvHint
          hubHref={kioskHubHref(orgSlug, competitionSlug, divisionSlug)}
          labels={kioskTvHintLabels(data.org.default_locale)}
        />
      }
    />
  );
}
