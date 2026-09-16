export const revalidate = 30;
// Public presentation mode — competition (v13/PROMPT-64): rotates every
// division's slides (standings / fixtures / live-pinned / bracket) on one
// no-login kiosk URL. Public read models only; private competitions 404.
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { getPublicCompetition, getPublicDivision } from "@/server/public-site/data";
import { sharedRenameTarget } from "@/server/slug-resolve";
import { buildPublicDivisionSlides, type Slide } from "@/server/slideshow-data";
import { slideshowLabels } from "@/server/slideshow-labels";
import { Slideshow } from "@/components/v2/slideshow";
import { kioskHubHref } from "@/components/public-site/kiosk-phone-card-logic";
import { publicThemeStyle } from "@/lib/public-theme";

export const metadata: Metadata = { robots: { index: false } };

export default async function PresentCompetitionPage({
  params,
}: {
  params: Promise<{ orgSlug: string; competitionSlug: string }>;
}) {
  const { orgSlug, competitionSlug } = await params;
  const shell = await getPublicCompetition(orgSlug, competitionSlug);
  if (!shell) {
    // K fix round, F2 + F3: a kiosk URL gets printed on a poster and stuck to a
    // wall, so it has to survive a rename that the hub link already survives.
    // The whole path is passed, not just the org slug — `sharedRenameTarget`
    // walks org then competition and answers at the same depth, so a renamed
    // org keeps `/{comp}` instead of collapsing to the org hub (that collapse
    // IS F2, and it happened because the layout above had no other param to
    // give). Its answer is the CHROME path, so the board's own `/present` goes
    // back on. Null means nothing in the rename history and a 404 is honest.
    const renamed = await sharedRenameTarget(orgSlug, competitionSlug);
    if (renamed) permanentRedirect(`${renamed}/present`);
    notFound();
  }
  const decks = await Promise.all(
    shell.divisions.map(async (d) => {
      const data = await getPublicDivision(orgSlug, competitionSlug, d.slug);
      // P6 fix round 1, finding #2 (CRITICAL) — org.default_locale, not
      // English by construction: the builder has no request scope, and since
      // N1c c3 it loads the org-locale dictionaries itself (async, no database).
      return data === null ? [] : await buildPublicDivisionSlides({ ...data, orgLocale: data.org.default_locale });
    }),
  );
  const slides: Slide[] = decks.flat();
  return (
    <Slideshow
      title={shell.competition.name}
      slides={slides}
      backHref={`/shared/${orgSlug}/${competitionSlug}`}
      // C1 (OWNER RULING 2026-09-15): a phone gets a "made for a TV" card whose
      // Open the live page goes to the competition's hub.
      liveHref={kioskHubHref(orgSlug, competitionSlug)}
      themeStyle={publicThemeStyle(shell.competition.branding)}
      // R10e u1: the board's own strings (the card's too) in the org's locale,
      // the same one every division deck above is built in.
      labels={slideshowLabels(shell.org.default_locale)}
    />
  );
}
