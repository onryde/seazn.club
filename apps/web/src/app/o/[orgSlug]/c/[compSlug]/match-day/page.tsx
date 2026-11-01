export const dynamic = "force-dynamic";
// Match Day (spec docs/superpowers/specs/2026-10-31-match-day-design.md §6, task A3): the organiser's surface for running a
// competition's day court by court. The view is read here for the first paint and polled by the shell after that.
//
// Who (owner ruling Q1b, task B4 — supersedes §10's "edit permission only"): any member of the organisation who may view the
// competition opens it. An organiser with edit rights runs the day; anyone else (a viewer) gets the same page READ-ONLY — no
// Call, no Undo, no scorer QR (showing it mints a link), no Needs-you list (the competition page does not show them one either).
// The write doors refuse a viewer on their own (`requireResourceAuth(…, "write")`; read-only-staff.test.ts); hiding them here
// is the page being honest, never the guard. A non-member gets the 404 `requireOrgPage` gives every console page.
//
// `?court=<id>` opens that court (B4: Needs you's "Find a court" names the free court whose candidates it means).
import { requireCompetitionPage } from "@/server/page-auth";
import { getMatchDay } from "@/server/usecases/match-day";
import { orgPlanKey } from "@/lib/entitlements";
import { viewerPlanFrom } from "@/lib/viewer-plan";
import { listDivisions } from "@/server/usecases/divisions";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary } from "@/lib/i18n";
import { pickDictPrefixes } from "@/lib/i18n-subset";
import { MatchDayShell } from "@/components/v2/match-day/match-day-shell";

export default async function MatchDayPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; compSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug, compSlug } = await params;
  const court = (await searchParams).court;
  const page = await requireCompetitionPage(orgSlug, compSlug, { tail: "/match-day" });
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
        readOnly={!page.canEdit}
        focusCourtId={typeof court === "string" ? court : null}
      />
    </main>
  );
}
