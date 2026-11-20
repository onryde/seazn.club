import "server-only";
// server/youtube/description-facts.ts — the match facts a broadcast's description opens with (Seazn-hosted video plan, Phase 0
// T5): "<sport> · <round>", the competition, the venue when there is one, and the date and time. The facts are gathered here
// and formatted here; the words around them live in title.ts's pure `broadcastDescription`.
//
// Words come from the labels the product already translates: the sport from `sport.<key>`, the round from the schedule board's
// own `boardRoundCodes` through Match Day's `matchDayRounds` (one authority for "Semi-finals" / "Round 2"). Nothing is invented.
import type { RoundCodeFixture } from "@/components/v2/board/round-codes";
import { sql } from "@/lib/db";
import type { Locale } from "@/lib/i18n-constants";
import { venueTzOrNull } from "@/lib/tz";
import { matchDayRounds } from "@/lib/match-day/rounds";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";

/** What the fixture row says about the match. */
export interface FactsInput {
  sportKey: string;
  competition: string;
  venue: string | null;
  startsAt: Date | null;
  /** The division's schedule timezone, else the org's: null when neither is set (the date and time are then left out). */
  timeZone: string | null;
  /** The match's round, already named; null when it could not be. */
  round: string | null;
}

/** The date and time as the viewer's locale writes them, in the venue's zone — null with no start or no usable zone (never a
 *  guess at UTC: a wrong time on a live stream is worse than none). */
export function formatStart(startsAt: Date | null, timeZone: string | null, locale: Locale): string | null {
  if (startsAt === null || timeZone === null) return null;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "full", timeStyle: "short", timeZone,
    }).format(startsAt);
  } catch {
    return null;   // an unknown zone name: RangeError
  }
}

/** The ordered fact lines: sport and round; competition; venue when present; date and time. Lines with nothing to say are absent. */
export function describeFacts(f: FactsInput, locale: Locale): string[] {
  const sportKey = `sport.${f.sportKey}` as MessageKey;
  const sport = msgFor(locale, sportKey);
  // msgFor answers the key itself for a missing one: no label is better than "sport.x".
  const sportLabel = sport === sportKey ? null : sport;
  return [
    [sportLabel, f.round].filter((p): p is string => p !== null && p !== "").join(" · "),
    f.competition,
    f.venue ?? "",
    formatStart(f.startsAt, f.timeZone, locale) ?? "",
  ].filter((l) => l.trim() !== "");
}

interface Row {
  sport_key: string; stage_id: string; stage_kind: string; round_no: number; scheduled_at: Date | null;
  venue: string | null; division_tz: string | null; org_tz: string | null; division_status: string;
}

/** The facts of one fixture, in `locale`. The caller has already proven the fixture is the org's (textsFor's own select). */
export async function readDescriptionFacts(
  a: { fixtureId: string; orgId: string; competition: string; linkable: boolean }, locale: Locale,
): Promise<string[]> {
  const [r] = await sql<Row[]>`
    select d.sport_key, f.stage_id, s.kind as stage_kind, f.round_no, f.scheduled_at,
           coalesce(nullif(btrim(f.venue), ''), nullif(btrim(vn.name), '')) as venue,
           ss.tz as division_tz, o.timezone as org_tz, d.status as division_status
      from fixtures f
      join divisions d on d.id = f.division_id
      join stages s on s.id = f.stage_id
      join organizations o on o.id = d.org_id
      left join schedule_settings ss on ss.division_id = d.id
      left join courts ct on ct.id = f.court_id
      left join venues vn on vn.id = ct.venue_id
     where f.id = ${a.fixtureId} and d.org_id = ${a.orgId}`;
  if (!r) return [];
  const stageRows = await sql<RoundCodeFixture[]>`
    select id, stage_id, round_no, seq_in_round, ext_key, lane, is_final, third_place, conditional
      from fixtures where stage_id = ${r.stage_id}`;
  const rounds = matchDayRounds(
    [{ id: a.fixtureId, stage_id: r.stage_id, round_no: r.round_no }],
    stageRows, [{ id: r.stage_id, kind: r.stage_kind }],
    (key, vars) => msgFor(locale, key, vars),
  );
  return describeFacts({
    sportKey: r.sport_key, competition: a.competition, // The public page's own redaction (public-site/data.ts, V369): no venue for a division still in setup, and none for a
    // competition whose public page does not open. The date and time stay.
    venue: r.division_status === "setup" || !a.linkable ? null : r.venue,
    startsAt: r.scheduled_at, timeZone: venueTzOrNull(r.division_tz, r.org_tz),
    round: rounds.get(a.fixtureId)?.label ?? null,
  }, locale);
}
