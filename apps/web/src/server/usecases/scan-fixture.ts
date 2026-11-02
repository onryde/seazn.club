import "server-only";
// The fixture row a device link's scan resolves: the one read `app/score/[token]/page.tsx` renders from and
// `GET /api/v1/device-link` (device-link-bootstrap.ts) answers from, so the two cannot name a match differently.
import { withTenant } from "@/lib/db";

export type ScanFixtureRow = {
  id: string;
  round_no: number;
  /** P9 cutover: DERIVED from `venues`/`courts` via `fixtures.venue_id`/
   *  `court_id` — the frozen `fixtures.venue`/`court_label` text columns
   *  are no longer written, so reading them blanks any fixture touched
   *  post-cutover. Same pattern as usecases/me.ts. */
  venue_name: string | null;
  court_name: string | null;
  scheduled_at: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  /** `fixtures.status` — the same column `getFixtureState` reports, read
   *  here so the screen is picked before any of the pad's own loads. */
  status: string;
  /** Each seated side's `entrants.display_name` (the snapshot), `kind`
   *  and roster in roster order: what the waiting screens resolve a
   *  seated side's name from, through `entrantDisplayName` — the way its
   *  printed card and the pad name it (final review I1). Plus each
   *  side's saved `pair_order` for THIS fixture, so a pair reads in its
   *  lineup order as Confirm and the card do (fix batch 2, item 3). */
  home_name: string | null;
  away_name: string | null;
  home_kind: string | null;
  away_kind: string | null;
  home_members: { person_id: string; full_name: string }[];
  away_members: { person_id: string; full_name: string }[];
  home_lineup: { person_id: string; pair_order: number }[];
  away_lineup: { person_id: string; pair_order: number }[];
  division_id: string;
  sport_key: string;
  module_version: string;
  config: unknown;
  competition_id: string;
  competition_name: string;
  division_name: string;
  /** Read in THIS render, so the refresh after the organiser's start
   *  sees it (`scanScreen`'s "not started" row). */
  division_status: string;
  competition_branding: unknown;
  /** `organizations.timezone`: the clock the printed sheet uses. */
  org_tz: string | null;
  };

/** The scan's fixture row, RLS-bounded to `orgId`; null when the fixture is gone. */
export async function readScanFixture(orgId: string, fixtureId: string): Promise<ScanFixtureRow | null> {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx<ScanFixtureRow[]>`
      select f.id, f.round_no, ven.name as venue_name, crt.name as court_name,
             f.scheduled_at, f.home_entrant_id, f.away_entrant_id, f.status,
             he.display_name as home_name, ae.display_name as away_name,
             he.kind as home_kind, ae.kind as away_kind,
             hm.members as home_members, am.members as away_members,
             hl.slots as home_lineup, al.slots as away_lineup, d.id as division_id,
             d.sport_key, d.module_version, d.config, d.status as division_status,
             c.id as competition_id, c.name as competition_name, d.name as division_name,
             c.branding as competition_branding, o.timezone as org_tz
      from fixtures f
      left join courts crt on crt.id = f.court_id
      left join venues ven on ven.id = f.venue_id
      left join entrants he on he.id = f.home_entrant_id
      left join entrants ae on ae.id = f.away_entrant_id
      -- Roster order as the sheet reads it (usecases/scorer-sheets.ts readEntrants).
      left join lateral (
        select coalesce(json_agg(json_build_object('person_id', p.id, 'full_name', p.full_name)
                                 order by em.squad_number nulls last, p.full_name), '[]'::json) as members
        from entrant_members em join persons p on p.id = em.person_id
        where em.entrant_id = he.id) hm on true
      left join lateral (
        select coalesce(json_agg(json_build_object('person_id', p.id, 'full_name', p.full_name)
                                 order by em.squad_number nulls last, p.full_name), '[]'::json) as members
        from entrant_members em join persons p on p.id = em.person_id
        where em.entrant_id = ae.id) am on true
      -- This fixture's saved pair order per side (usecases/scorer-sheets.ts readPairOrders).
      left join lateral (
        select coalesce(json_agg(json_build_object('person_id', l.person_id, 'pair_order', l.pair_order)), '[]'::json) as slots
        from lineups l
        where l.fixture_id = f.id and l.entrant_id = he.id and l.pair_order is not null) hl on true
      left join lateral (
        select coalesce(json_agg(json_build_object('person_id', l.person_id, 'pair_order', l.pair_order)), '[]'::json) as slots
        from lineups l
        where l.fixture_id = f.id and l.entrant_id = ae.id and l.pair_order is not null) al on true
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      left join organizations o on o.id = c.org_id
      where f.id = ${fixtureId}`;
    return row ?? null;
  });
}
