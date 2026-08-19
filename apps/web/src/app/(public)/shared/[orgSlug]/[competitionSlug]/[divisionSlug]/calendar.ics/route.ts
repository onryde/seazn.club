// .ics calendar feed per division, optionally per entrant (?entrant=id) —
// doc 09 §2. Public-view reads only; 90-minute default event length.
import { notFound } from "next/navigation";
import { getPublicDivision } from "@/server/public-site/data";
import { buildIcs, type IcsEvent } from "@/lib/public-site";
import { toLocale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { resolveSlotLabel } from "@/lib/slot-label";

export async function GET(
  req: Request,
  {
    params,
  }: {
    params: Promise<{
      orgSlug: string;
      competitionSlug: string;
      divisionSlug: string;
    }>;
  },
) {
  const { orgSlug, competitionSlug, divisionSlug } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
  if (!data) notFound();

  const entrantId = new URL(req.url).searchParams.get("entrant");
  const entrantNames = Object.fromEntries(
    data.entrants.map((e) => [e.id, e.display_name]),
  );
  // Spectator-facing locale (v5 i18n §4) — the org's own default, resolved
  // the same way every other public surface does (data.ts:502-503).
  // Deliberately NOT resolveLocale(): a subscribed calendar has no single
  // request/viewer to read a cookie from, and org.default_locale is exactly
  // what P6's owner ruling called for here — "a subscribed calendar showing
  // 'TBD vs TBD' for the final is the exact product value TBD fixtures
  // exist to deliver."
  const orgLocale = toLocale(data.org.default_locale);
  const lookup = (
    k: Parameters<typeof msgFor>[1],
    v?: Record<string, string | number>,
  ) => msgFor(orgLocale, k, v);
  const nameOrLabel = (
    id: string | null,
    label: (typeof data.fixtures)[number]["home_slot_label"],
  ): string =>
    id
      ? (entrantNames[id] ?? lookup("calendar.unknownEntrant"))
      : resolveSlotLabel(label, lookup, "schedule.tbd");

  // A fixture that exists but has no time is the whole point of day-one
  // fixtures: it is anchored to the competition's last day as an all-day
  // TENTATIVE event, and becomes a timed CONFIRMED one under the same UID
  // when it is scheduled. Note that `public_fixtures_v` NULLs scheduled_at
  // for EVERY fixture while divisions.status = 'setup' (V362:25), so
  // pre-publish the whole feed is tentative by construction — that masking
  // is a deliberate privacy rule and is not worked around here.
  const anchorDate = data.competition.ends_on ?? data.competition.starts_on;

  const events: IcsEvent[] = data.fixtures
    .filter(
      (f) =>
        !entrantId ||
        f.home_entrant_id === entrantId ||
        f.away_entrant_id === entrantId,
    )
    // No competition dates means no defensible anchor; emitting a guessed
    // DTSTART into somebody's calendar is worse than omitting the event.
    .filter((f) => f.scheduled_at !== null || anchorDate !== null)
    .map((f) => {
      const description = `${data.competition.name} · https://seazn.club/shared/${data.org.slug}/${data.competition.slug}/${data.division.slug}/fixtures/${f.id}`;
      const common = {
        uid: f.id,
        summary: `${nameOrLabel(f.home_entrant_id, f.home_slot_label)} vs ${nameOrLabel(f.away_entrant_id, f.away_slot_label)} — ${data.division.name}`,
        // P9 cutover: venue_name/court_name are DERIVED (fixtures.venue_id/
        // court_id via data.ts's withCourtVenueNames) -- venue/court_label
        // are frozen, no writer touches them any more.
        ...(f.venue_name
          ? {
              location: f.court_name
                ? `${f.venue_name} (${f.court_name})`
                : f.venue_name,
            }
          : {}),
      };
      return f.scheduled_at !== null
        ? {
            ...common,
            start: new Date(f.scheduled_at),
            durationMinutes: 90,
            description,
          }
        : {
            ...common,
            allDayOn: anchorDate as string,
            // STATUS:TENTATIVE is invisible in several major calendar
            // clients, so a bare all-day event would otherwise read as "on
            // that whole day" rather than "date not fixed yet" — say it in
            // copy too, resolved through the same org-locale lookup as
            // every other string on this feed (F4 wave B, owner ruling).
            description: `${lookup("calendar.time_tbc")}\n${description}`,
          };
    });

  const name = entrantId
    ? `${entrantNames[entrantId] ?? lookup("calendar.unknownEntrant")} — ${data.division.name}`
    : `${data.division.name} — ${data.competition.name}`;

  return new Response(buildIcs(name, events), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${divisionSlug}.ics"`,
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
