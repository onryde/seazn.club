export const revalidate = 30;
// Public presentation mode — competition (v13/PROMPT-64): rotates every
// division's slides (standings / fixtures / live-pinned / bracket) on one
// no-login kiosk URL. Public read models only; private competitions 404.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicCompetition, getPublicDivision } from "@/server/public-site/data";
import { buildPublicDivisionSlides, type Slide } from "@/server/slideshow-data";
import { slideshowLabels } from "@/server/slideshow-labels";
import { Slideshow } from "@/components/v2/slideshow";
import { publicThemeStyle } from "@/lib/public-theme";

export const metadata: Metadata = { robots: { index: false } };

export default async function PresentCompetitionPage({
  params,
}: {
  params: Promise<{ orgSlug: string; competitionSlug: string }>;
}) {
  const { orgSlug, competitionSlug } = await params;
  const shell = await getPublicCompetition(orgSlug, competitionSlug);
  if (!shell) notFound();
  const decks = await Promise.all(
    shell.divisions.map(async (d) => {
      const data = await getPublicDivision(orgSlug, competitionSlug, d.slug);
      // P6 fix round 1, finding #2 (CRITICAL) — org.default_locale, not
      // English by construction (this builder is pure/no request scope).
      return data === null ? [] : await buildPublicDivisionSlides({ ...data, orgLocale: data.org.default_locale });
    }),
  );
  const slides: Slide[] = decks.flat();
  return (
    <Slideshow
      title={shell.competition.name}
      slides={slides}
      backHref={`/shared/${orgSlug}/${competitionSlug}`}
      themeStyle={publicThemeStyle(shell.competition.branding)}
      // R10e u1: the board's own strings in the org's locale, the same one
      // every division deck above is built in.
      labels={slideshowLabels(shell.org.default_locale)}
    />
  );
}
