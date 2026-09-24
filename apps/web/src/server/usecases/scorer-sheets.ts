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
//  - the venue zone through `venueTzForDivision`, the one authority for that
//    join (division override → org → UTC).
// Which rows print on a day, in what order and on which page is the pure
// half's (lib/scorer-sheets.ts). Page auth (editor, same-origin) is the
// ROUTE's job; this is RLS-bounded by withTenant.
import { withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { entrantDisplayName } from "@/lib/entrant-name";
import type { SlotLabel, SlotLabelLookup } from "@/lib/slot-label";
import { courtDisplayName } from "@/components/v2/board/types";
import { venueTzForDivision } from "@/server/venue-tz";
import {
  isPrintable,
  selectSheetFixtures,
  sheetDays,
  type SheetCandidate,
  type SheetSide,
} from "@/lib/scorer-sheets";
import { boardMatchNamer, MATCH_NAME_COLS, type MatchNameRow } from "./scan-match-names";
import { courtNamesById } from "./schedule";

/** One fixture of the competition: the board's naming columns plus what a
 *  sheet row prints. */
type FixtureRow = MatchNameRow & {
  division_id: string;
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
  const [comp] = await tx<{ id: string }[]>`select id from competitions where id = ${competitionId}`;
  if (!comp) throw new HttpError(404, "competition not found");
  return tx<FixtureRow[]>`
    select ${tx(MATCH_NAME_COLS.map((c) => `f.${c}`))},
           f.division_id, d.name as division_name, f.status, f.scheduled_at,
           f.court_id, f.court_label, c.name as court_entity_name, c.sort as court_sort,
           v.name as venue_name, v.sort as venue_sort
    from fixtures f
    join divisions d on d.id = f.division_id
    left join courts c on c.id = f.court_id
    left join venues v on v.id = c.venue_id
    where d.competition_id = ${competitionId}`;
}

const isoOf = (at: Date | string | null): string | null => (at === null ? null : new Date(at).toISOString());

/** division id → its venue zone. Outside the tenant transaction: the venue
 *  lane reads the pooled `sql`, and `withTenant` holds a connection. */
async function divisionZones(rows: readonly FixtureRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.division_id))];
  return new Map(await Promise.all(ids.map(async (id) => [id, await venueTzForDivision(id)] as const)));
}

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
 * The competition's printable fixtures (`isPrintable`), every row named and
 * zoned. With `day`: exactly that day's sheet rows, in print order
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
    const rows = await readFixtures(tx, competitionId);
    const stages = await tx<{ id: string; kind: string }[]>`
      select s.id, s.kind from stages s join divisions d on d.id = s.division_id
      where d.competition_id = ${competitionId}`;
    const sides = await readSides(tx, competitionId);
    const courtNames = Object.fromEntries(await courtNamesById(tx));
    return { rows, stages, sides, courtNames };
  });
  const zones = await divisionZones(read.rows);
  const name = boardMatchNamer(read.rows, read.stages, lookup);
  const side = (id: string | null) => (id === null ? null : (read.sides.get(id) ?? null));
  const candidates: SheetCandidate[] = [];
  for (const r of read.rows) {
    const scheduled_at = isoOf(r.scheduled_at);
    const tz = zones.get(r.division_id)!;
    const home_slot_label = r.home_slot_label as SlotLabel | null;
    const away_slot_label = r.away_slot_label as SlotLabel | null;
    if (!isPrintable({ status: r.status, scheduled_at, tz, home_slot_label, away_slot_label })) continue;
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
      home: side(r.home_entrant_id),
      away: side(r.away_entrant_id),
      home_tbd: names.home,
      away_tbd: names.away,
      home_slot_label,
      away_slot_label,
    });
  }
  return day === undefined ? candidates : selectSheetFixtures(candidates, day);
}

/** The local days that have something to print. Read on every schedule-page
 *  render, so it skips names, rosters and courts. */
export async function listSheetDays(auth: AuthCtx, competitionId: string): Promise<string[]> {
  const rows = await withTenant(auth.orgId, (tx) => readFixtures(tx, competitionId));
  const zones = await divisionZones(rows);
  return sheetDays(
    rows.map((r) => ({
      status: r.status,
      scheduled_at: isoOf(r.scheduled_at),
      tz: zones.get(r.division_id)!,
      home_slot_label: r.home_slot_label as SlotLabel | null,
      away_slot_label: r.away_slot_label as SlotLabel | null,
    })),
  );
}
