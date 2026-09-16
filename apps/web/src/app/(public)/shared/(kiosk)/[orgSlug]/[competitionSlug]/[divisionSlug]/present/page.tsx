export const revalidate = 30;
// Public presentation mode — division (v13/PROMPT-64): a no-login, shareable
// kiosk URL an organiser points a venue screen at. Reuses the noticeboard
// <Slideshow> with slides built from the PUBLIC read models (consent and
// visibility enforced by the public_* views); a private competition 404s.
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { getPublicDivision } from "@/server/public-site/data";
import { sharedRenameTarget } from "@/server/slug-resolve";
import { buildPublicDivisionSlides } from "@/server/slideshow-data";
import { slideshowLabels } from "@/server/slideshow-labels";
import { Slideshow } from "@/components/v2/slideshow";
import { kioskHubHref } from "@/components/public-site/kiosk-phone-card-logic";
import { publicThemeStyle } from "@/lib/public-theme";
import { toLocale } from "@/lib/i18n-constants";
import { getDictionary, t } from "@/lib/i18n";

// Kiosk duplicate of the public division page — never indexed.
// Every field a page's metadata leaves out is INHERITED from the root layout,
// whose title and description are English (`app/layout.tsx`), so this page
// sets both in the org's language (Task 16 review, I2).
export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; competitionSlug: string; divisionSlug: string }>;
}): Promise<Metadata> {
  const robots = { index: false };
  const { orgSlug, competitionSlug, divisionSlug } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
  if (!data) return { robots };
  const dict = await getDictionary(toLocale(data.org.default_locale), "public");
  return {
    title: t(dict, "kiosk.metaTitle", { name: `${data.competition.name} · ${data.division.name}` }),
    description: t(dict, "division.metaDescription", {
      division: data.division.name,
      competition: data.competition.name,
    }),
    robots,
  };
}

export default async function PresentDivisionPage({
  params,
}: {
  params: Promise<{ orgSlug: string; competitionSlug: string; divisionSlug: string }>;
}) {
  const { orgSlug, competitionSlug, divisionSlug } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
  if (!data) {
    // K fix round, F2 + F3 — same rule as the competition board beside this
    // one, one level deeper: the full path goes in, so a renamed org keeps
    // `/{comp}/{div}` and a renamed competition keeps `/{div}`, and the
    // board's own `/present` goes back onto the chrome path that comes out.
    // Null means nothing in the rename history and a 404 is honest.
    const renamed = await sharedRenameTarget(orgSlug, competitionSlug, divisionSlug);
    if (renamed) permanentRedirect(`${renamed}/present`);
    notFound();
  }
  // P6 fix round 1, finding #2 (CRITICAL) — org.default_locale, not English
  // by construction: the builder has no request scope, and since N1c c3 it
  // loads the org-locale dictionaries itself (async, no database).
  const slides = await buildPublicDivisionSlides({ ...data, orgLocale: data.org.default_locale });
  return (
    <Slideshow
      title={`${data.competition.name} · ${data.division.name}`}
      slides={slides}
      backHref={`/shared/${orgSlug}/${competitionSlug}/${divisionSlug}`}
      // C1 (OWNER RULING 2026-09-15): a phone gets a "made for a TV" card whose
      // Open the live page goes to the hub, filtered to this division.
      liveHref={kioskHubHref(orgSlug, competitionSlug, divisionSlug)}
      themeStyle={publicThemeStyle(data.competition.branding)}
      // R10e u1: the board's own strings (the card's too) in the same locale
      // as its slides.
      labels={slideshowLabels(data.org.default_locale)}
    />
  );
}
