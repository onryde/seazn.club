export const dynamic = "force-dynamic";
// Match Day (spec docs/superpowers/specs/2026-10-31-match-day-design.md §6, task A3): the organiser's surface for running a
// competition's day court by court. Organisers with edit rights only (§10: "the same edit permission as the division desk");
// anyone else gets the 404 the console gives a page it does not show them. The view is read here for the first paint and
// polled by the shell after that.
import { notFound } from "next/navigation";
import { requireCompetitionPage } from "@/server/page-auth";
import { getMatchDay } from "@/server/usecases/match-day";
import { orgPlanKey } from "@/lib/entitlements";
import { viewerPlanFrom } from "@/lib/viewer-plan";
import { listDivisions } from "@/server/usecases/divisions";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary } from "@/lib/i18n";
import { pickDictPrefixes } from "@/lib/i18n-subset";
import { MatchDayShell } from "@/components/v2/match-day/match-day-shell";

export default async function MatchDayPage({ params }: { params: Promise<{ orgSlug: string; compSlug: string }> }) {
  const { orgSlug, compSlug } = await params;
  const page = await requireCompetitionPage(orgSlug, compSlug, { tail: "/match-day" });
  if (!page.canEdit) notFound();
  const id = page.competition.id;
  const locale = await resolveLocale();
  const [ui, pub, view, divisions, planKey] = await Promise.all([
    getDictionary(locale, "ui"),
    getDictionary(locale, "public"),
    getMatchDay(page.auth, id, new Date(), { locale }),
    listDivisions(page.auth, id),
    orgPlanKey(page.auth.orgId),
  ]);
  return (
    <main className="mx-auto max-w-6xl px-4 py-6 md:py-8">
      <MatchDayShell
        competitionId={id}
        competitionName={page.competition.name}
        orgSlug={orgSlug}
        compSlug={page.competition.slug}
        locale={locale}
        divisions={divisions.map((d) => ({ id: d.id, name: d.name }))}
        initial={view}
        // Only the keys the island renders cross to the client, never the whole dictionary: its own, the Needs-you list's title
        // (`NeedsYou`, reused; its rows arrive translated), the scorer QR's heading (the console's own "Remote scoring") and the
        // preview's "Live on YouTube" (the fixture page's words for the same stream).
        dict={pickDictPrefixes(ui, ["matchDay.", "desk.needsYou.title", "dlink.title", "stream.youtube.link.live"])}
        scoreDict={pickDictPrefixes(pub, ["matchCentre.", "forfeit."])}
        viewerPlan={viewerPlanFrom(planKey)}
      />
    </main>
  );
}
