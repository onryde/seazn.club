import "server-only";
// Scorer sheets §4.4 — the fixtures a printed sheet could show, with
// everything a row PRINTS resolved here, once:
//  - the match ref and each empty seat's "Winner of …" exactly as the schedule
//    board names them (owner ruling 2026-09-24): `boardMatchNamer`, the scan
//    screens' own namer, over the whole competition's rows — the board reads
//    the whole competition, and a feeder may sit on another day or be over;
//  - the court as the board names it (`courtDisplayName` over
//    `courtNamesById`, venue-qualified where two venues share a name);
//  - each side through `entrantDisplayName`, with its roster;
//  - the day and the times on the ORG clock (`resolveVenueTz(null, orgTz)`),
//    the clock the competition board's day grid uses (#397/#448; controller
//    ruling 2026-09-24) — never a division's own tz override, or a legacy
//    division holding one would print a fixture on a different day than the
//    board shows it.
// Which rows print on a day, in what order and on which page is the pure
// half's (lib/scorer-sheets.ts). Page auth (editor, same-origin) is the
// ROUTE's job; this is RLS-bounded by withTenant.
import { withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { entrantDisplayName } from "@/lib/entrant-name";
import type { SlotLabel, SlotLabelLookup } from "@/lib/slot-label";
import { resolveVenueTz } from "@/lib/tz";
import { courtDisplayName } from "@/components/v2/board/types";
import {
  BYE_SLOT_KEY,
  PRINTABLE_STATUSES,
  isPrintable,
  selectSheetFixtures,
  type SheetCandidate,
  type SheetSide,
} from "@/lib/scorer-sheets";
import { boardMatchNamer, MATCH_NAME_COLS, type MatchNameRow } from "./scan-match-names";
import { courtNamesById } from "./schedule";

/** The competition's clock: its organisation's zone, else UTC. 404 when the
 *  competition is not this tenant's. */
async function competitionClock(tx: Tx, competitionId: string): Promise<string> {
  const [comp] = await tx<{ org_tz: string | null }[]>`
    select o.timezone as org_tz
    from competitions c left join organizations o on o.id = c.org_id
    where c.id = ${competitionId}`;
  if (!comp) throw new HttpError(404, "competition not found");
  return resolveVenueTz(null, comp.org_tz);
}

/** One fixture of the competition: the board's naming columns plus what a
 *  sheet row prints. */
type FixtureRow = MatchNameRow & {
  division_name: string;
  status: string;
  /** postgres hands a timestamptz back as a Date. */
  scheduled_at: Date | string | null;
  court_id: string | null;
  court_label: string | null;
  court_entity_name: string | null;
  court_sort: number | null;
  venue_name: string | null;
  venue_sort: number | null;
};

async function readFixtures(tx: Tx, competitionId: string): Promise<FixtureRow[]> {
  return tx<FixtureRow[]>`
    select ${tx(MATCH_NAME_COLS.map((c) => `f.${c}`))},
           d.name as division_name, f.status, f.scheduled_at,
           f.court_id, f.court_label, c.name as court_entity_name, c.sort as court_sort,
           v.name as venue_name, v.sort as venue_sort
    from fixtures f
    join divisions d on d.id = f.division_id
    left join courts c on c.id = f.court_id
    left join venues v on v.id = c.venue_id
    where d.competition_id = ${competitionId}`;
}

const isoOf = (at: Date | string | null): string | null => (at === null ? null : new Date(at).toISOString());

interface EntrantRow {
  id: string;
  name: string;
  kind: SheetSide["kind"];
  members: SheetSide["members"];
}

/** Every entrant of the competition, with its roster in roster order
 *  (usecases/entrants.ts `withMembers`: squad number, then name). */
async function readSides(tx: Tx, competitionId: string): Promise<Map<string, SheetSide>> {
  const rows = await tx<EntrantRow[]>`
    select e.id, e.display_name as name, e.kind,
           coalesce((
             select json_agg(json_build_object('person_id', p.id, 'full_name', p.full_name)
                             order by em.squad_number nulls last, p.full_name)
             from entrant_members em join persons p on p.id = em.person_id
             where em.entrant_id = e.id), '[]'::json) as members
    from entrants e
    join divisions d on d.id = e.division_id
    where d.competition_id = ${competitionId}`;
  return new Map(rows.map((e) => [e.id, { name: entrantDisplayName(e), kind: e.kind, members: e.members }]));
}

/**
 * The competition's printable fixtures (`isPrintable`), every row named and on
 * the org clock. With `day`: exactly that day's sheet rows, in print order
 * (`selectSheetFixtures`). `lookup` is the sheet's language — required, so no
 * caller prints English by default.
 */
export async function loadSheetCandidates(
  auth: AuthCtx,
  competitionId: string,
  lookup: SlotLabelLookup,
  day?: string,
): Promise<SheetCandidate[]> {
  const read = await withTenant(auth.orgId, async (tx) => {
    const tz = await competitionClock(tx, competitionId);
    const rows = await readFixtures(tx, competitionId);
    const stages = await tx<{ id: string; kind: string }[]>`
      select s.id, s.kind from stages s join divisions d on d.id = s.division_id
      where d.competition_id = ${competitionId}`;
    const sides = await readSides(tx, competitionId);
    const courtNames = Object.fromEntries(await courtNamesById(tx));
    return { tz, rows, stages, sides, courtNames };
  });
  const { tz } = read;
  const name = boardMatchNamer(read.rows, read.stages, lookup);
  const side = (id: string | null) => (id === null ? null : (read.sides.get(id) ?? null));
  const candidates: SheetCandidate[] = [];
  for (const r of read.rows) {
    const scheduled_at = isoOf(r.scheduled_at);
    const home = side(r.home_entrant_id);
    const away = side(r.away_entrant_id);
    const home_slot_label = r.home_slot_label as SlotLabel | null;
    const away_slot_label = r.away_slot_label as SlotLabel | null;
    if (!isPrintable({ status: r.status, scheduled_at, tz, home, away, home_slot_label, away_slot_label })) continue;
    // Every row is one the namer was built from.
    const names = name(r.id)!;
    candidates.push({
      id: r.id,
      status: r.status,
      scheduled_at,
      tz,
      division_name: r.division_name,
      round_no: r.round_no,
      seq_in_round: r.seq_in_round,
      match_ref: names.ref,
      venue_name: r.venue_name,
      venue_sort: r.venue_sort,
      court_name: courtDisplayName(
        { court_id: r.court_id, court_name: r.court_entity_name, court_label: r.court_label },
        read.courtNames,
      ),
      court_sort: r.court_sort,
      home,
      away,
      home_tbd: names.home,
      away_tbd: names.away,
      home_slot_label,
      away_slot_label,
    });
  }
  return day === undefined ? candidates : selectSheetFixtures(candidates, day);
}

/**
 * The org-clock days that have something to print, ascending. Read on every
 * schedule-page render, so it is ONE query that returns only the days: the
 * same exclusions as `isPrintable`, spelled in SQL — a printable status, a
 * time, and no seat that is EMPTY and stamped a bye. `coalesce` keeps an
 * unlabelled empty seat (a null key — a Swiss shell, say) from turning the
 * whole `not (...)` null and dropping a row that prints.
 */
export async function listSheetDays(auth: AuthCtx, competitionId: string): Promise<string[]> {
  return withTenant(auth.orgId, async (tx) => {
    const tz = await competitionClock(tx, competitionId);
    const rows = await tx<{ day: string }[]>`
      select distinct to_char(f.scheduled_at at time zone ${tz}, 'YYYY-MM-DD') as day
      from fixtures f
      join divisions d on d.id = f.division_id
      where d.competition_id = ${competitionId}
        and f.status in ${tx([...PRINTABLE_STATUSES])}
        and f.scheduled_at is not null
        and not (f.home_entrant_id is null and coalesce(f.home_slot_label->>'key', '') = ${BYE_SLOT_KEY})
        and not (f.away_entrant_id is null and coalesce(f.away_slot_label->>'key', '') = ${BYE_SLOT_KEY})
      order by day`;
    return rows.map((r) => r.day);
  });
}
