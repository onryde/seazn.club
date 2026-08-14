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
    params: Promise<{ orgSlug: string; competitionSlug: string; divisionSlug: string }>;
  },
) {
  const { orgSlug, competitionSlug, divisionSlug } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
  if (!data) notFound();

  const entrantId = new URL(req.url).searchParams.get("entrant");
  const entrantNames = Object.fromEntries(data.entrants.map((e) => [e.id, e.display_name]));
  // Spectator-facing locale (v5 i18n §4) — the org's own default, resolved
  // the same way every other public surface does (data.ts:502-503).
  // Deliberately NOT resolveLocale(): a subscribed calendar has no single
  // request/viewer to read a cookie from, and org.default_locale is exactly
  // what P6's owner ruling called for here — "a subscribed calendar showing
  // 'TBD vs TBD' for the final is the exact product value TBD fixtures
  // exist to deliver."
  const orgLocale = toLocale(data.org.default_locale);
  const lookup = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) =>
    msgFor(orgLocale, k, v);
  const nameOrLabel = (
    id: string | null,
    label: (typeof data.fixtures)[number]["home_slot_label"],
  ): string => (id ? (entrantNames[id] ?? "TBD") : resolveSlotLabel(label, lookup, "schedule.tbd"));

  const events: IcsEvent[] = data.fixtures
    .filter((f) => f.scheduled_at !== null)
    .filter(
      (f) =>
        !entrantId || f.home_entrant_id === entrantId || f.away_entrant_id === entrantId,
    )
    .map((f) => ({
      uid: f.id,
      start: new Date(f.scheduled_at as string),
      durationMinutes: 90,
      summary: `${nameOrLabel(f.home_entrant_id, f.home_slot_label)} vs ${nameOrLabel(f.away_entrant_id, f.away_slot_label)} — ${data.division.name}`,
      ...(f.venue
        ? { location: f.court_label ? `${f.venue} (${f.court_label})` : f.venue }
        : {}),
      description: `${data.competition.name} · https://seazn.club/shared/${data.org.slug}/${data.competition.slug}/${data.division.slug}/fixtures/${f.id}`,
    }));

  const name = entrantId
    ? `${entrantNames[entrantId] ?? "Entrant"} — ${data.division.name}`
    : `${data.division.name} — ${data.competition.name}`;

  return new Response(buildIcs(name, events), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${divisionSlug}.ics"`,
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
