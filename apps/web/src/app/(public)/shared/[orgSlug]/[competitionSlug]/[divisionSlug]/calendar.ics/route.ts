// .ics calendar feed per division, optionally per entrant (?entrant=id) —
// doc 09 §2. Public-view reads only; 90-minute default event length.
import { notFound } from "next/navigation";
import { getPublicDivision } from "@/server/public-site/data";
import { buildIcs, type IcsEvent } from "@/lib/public-site";
import { toLocale } from "@/lib/i18n-constants";
import { getDictionary } from "@/lib/i18n";
import { msgFor } from "@/lib/messages-i18n";
import { publicRoundNamer } from "@/server/public-site/feeder-slot-label";

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
  // N1 fix round 1, M8: a side still waiting on a match names that match's
  // round as the public hub's rail does ("Winner of Semi-finals, match 1"),
  // through the same namer the hub and the match centre use; any other label
  // keeps the board's text (`resolveSlotLabel`, inside the namer).
  const stageKind = new Map(data.stages.map((s) => [s.id, s.kind]));
  const namer = publicRoundNamer({
    ui: lookup,
    dict: await getDictionary(orgLocale, "public"),
    fixtures: data.fixtures,
    stageKind: (stageId) => stageKind.get(stageId),
  });
  const nameOrLabel = (
    id: string | null,
    label: (typeof data.fixtures)[number]["home_slot_label"],
    fixtureId: string,
    seat: "home" | "away",
  ): string =>
    id
      ? (entrantNames[id] ?? lookup("calendar.unknownEntrant"))
      // `seat`, not `slot`: a sibling-fed seat of a `timing: "setup"` bracket
      // carries no stored label, and the subscribed calendar then said "TBD"
      // for a match whose feeder is known.
      : namer.seat(fixtureId, seat, label);

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
        f.away_entrant_id === entrantId ||
        // Owner ruling (2026-08-24): a personal feed carries the
        // subscriber's own resolved fixtures PLUS EVERY unresolved fixture
        // in their division — "your route through the draw" is the whole
        // product claim these placeholder events exist to deliver. This is
        // NOT "walk the progression graph to prove the subscriber can
        // actually reach this fixture" — that was considered and
        // explicitly deferred. Over-inclusion is accepted and intended: an
        // unresolved fixture always renders below as an all-day
        // STATUS:TENTATIVE placeholder (never mistaken for a real,
        // committed slot), and `data.fixtures` is already scoped to this
        // one division, so nothing here can leak a fixture from elsewhere.
        (f.home_entrant_id === null && f.away_entrant_id === null),
    )
    // No competition dates means no defensible anchor; emitting a guessed
    // DTSTART into somebody's calendar is worse than omitting the event.
    .filter((f) => f.scheduled_at !== null || anchorDate !== null)
    .map((f) => {
      const description = `${data.competition.name} · https://seazn.club/shared/${data.org.slug}/${data.competition.slug}/${data.division.slug}/fixtures/${f.id}`;
      const common = {
        uid: f.id,
        summary: `${nameOrLabel(f.home_entrant_id, f.home_slot_label, f.id, "home")} ${lookup("schedule.vs")} ${nameOrLabel(f.away_entrant_id, f.away_slot_label, f.id, "away")} — ${data.division.name}`,
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
