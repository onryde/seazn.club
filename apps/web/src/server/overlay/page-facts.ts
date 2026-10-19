// The facts the overlay PAGE renders from, through either of its two doors (R2005 change 1).
//
//  - PUBLIC (`publicOverlayPageFacts`): exactly the reads the page always made — `publicFixtureSlugs` +
//    `getPublicFixture`, the same visibility-filtered, cached reads the public match page makes — and the same mapping
//    of their result into the stage's inputs, moved here verbatim so the page has one shape to render from.
//  - RELAY (`relayOverlayPageFacts`): the same facts read from the BASE tables, for a caller that has already passed
//    `relayPageAccess` (a composed session's compositor). Not visibility-filtered, because that is the point — a
//    composed session can stream a private competition's fixture. UNCACHED, so it can never share an entry with a
//    public read (the security half of change 1): nothing this read returns is written anywhere a public read looks.
//    Names are masked by the division's own policy (`maskPublicEntrantNames`, the public read's own masking), shorts
//    are disambiguated together (`disambiguatedShorts`, the match centre's rule) and the kit colour is
//    `team_display_v.colors.home_primary` (ruling 15), so a side reads on the compositor's page as it does on OBS's.
import "server-only";
import { sql } from "@/lib/db";
import { disambiguatedShorts, isoDateTime } from "@/lib/public-site";
import type { OverlaySideInput } from "@/lib/overlay-model";
import { getPublicFixture, maskPublicEntrantNames, publicFixtureSlugs } from "@/server/public-site/data";
import { venueTzForDivision } from "@/server/venue-tz";

export interface OverlayPageFacts {
  org: { id: string; default_locale: string };
  competition: { id: string; name: string };
  sportKey: string;
  fixture: { id: string; home_entrant_id: string | null; away_entrant_id: string | null; scheduled_at: string | null };
  sides: [OverlaySideInput, OverlaySideInput];
  realtime: boolean;
  venueTz: string;
  stageName: string | null;
}

/** The public door: today's two reads and today's mapping. Null = 404. */
export async function publicOverlayPageFacts(fixtureId: string): Promise<OverlayPageFacts | null> {
  const slugs = await publicFixtureSlugs(fixtureId);
  if (!slugs) return null;
  const data = await getPublicFixture(slugs.orgSlug, slugs.compSlug, slugs.divSlug, fixtureId);
  if (!data) return null;
  const { org, competition, division, fixture, entrantNames, realtime, venueTz, matchCentre, stageName } = data;
  const mcSides = matchCentre.header.sides;
  return {
    org,
    competition,
    sportKey: division.sport_key,
    fixture,
    sides: [
      {
        id: fixture.home_entrant_id ?? "home",
        name: fixture.home_entrant_id ? (entrantNames[fixture.home_entrant_id] ?? mcSides[0].name) : "—",
        short: mcSides[0].short,
        colour: mcSides[0].colour,
      },
      {
        id: fixture.away_entrant_id ?? "away",
        name: fixture.away_entrant_id ? (entrantNames[fixture.away_entrant_id] ?? mcSides[1].name) : "—",
        short: mcSides[1].short,
        colour: mcSides[1].colour,
      },
    ],
    realtime,
    venueTz,
    stageName,
  };
}

interface RelayRow {
  id: string;
  division_id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  scheduled_at: unknown;
  sport_key: string;
  youth: boolean | null;
  player_name_display: string | null;
  competition_id: string;
  competition_name: string;
  org_id: string;
  default_locale: string;
  stage_name: string | null;
  realtime: boolean | null;
}

interface RelaySideRow {
  id: string;
  kind: string;
  display_name: string;
  colors: unknown;
}

/** The relay door's facts, off the base tables. Call ONLY after `relayPageAccess` admitted the request. Null = 404. */
export async function relayOverlayPageFacts(fixtureId: string): Promise<OverlayPageFacts | null> {
  const [row] = await sql<RelayRow[]>`
    select f.id, f.division_id, f.home_entrant_id, f.away_entrant_id,
           -- the public view's own rule (public_fixtures_v): a division still in setup publishes no schedule
           case when d.status = 'setup' then null else f.scheduled_at end as scheduled_at,
           d.sport_key, d.youth, d.player_name_display,
           c.id as competition_id, c.name as competition_name,
           o.id as org_id, o.default_locale,
           s.name as stage_name,
           org_has_feature(o.id, 'realtime', c.id) as realtime
    from fixtures f
    join divisions d on d.id = f.division_id
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    left join stages s on s.id = f.stage_id
    where f.id = ${fixtureId}`;
  if (!row) return null;
  const ids = [row.home_entrant_id, row.away_entrant_id].filter((id): id is string => id !== null);
  const sideRows =
    ids.length === 0
      ? []
      : await sql<RelaySideRow[]>`
          select e.id, e.kind, e.display_name, td.colors
          from entrants e left join team_display_v td on td.team_id = e.team_id
          where e.id in ${sql(ids)}`;
  const masked = await maskPublicEntrantNames(sideRows, {
    youth: row.youth ?? false,
    player_name_display: row.player_name_display,
  });
  const byId = new Map(masked.map((r) => [r.id, r]));
  const pre = (entrantId: string | null, seat: "home" | "away") => {
    const r = entrantId === null ? undefined : byId.get(entrantId);
    // A seat with no entrant (bye / TBD) reads "—", as on the public door; an entrant the read cannot find is "?",
    // the match centre's own defensive fallback ("never a blank row").
    const name = entrantId === null ? "—" : (r?.display_name ?? "?");
    const colors = r?.colors as { home_primary?: string } | null | undefined;
    // `seated`: only a seat holding an entrant the read found — "—" and "?" are placeholders, which
    // `disambiguatedShorts` never widens (#987 review I1: two empty seats read "?" / "?", never "?1" / "?2").
    return {
      id: entrantId ?? seat,
      name,
      isPerson: r !== undefined && r.kind !== "team",
      seated: r !== undefined,
      colour: colors?.home_primary ?? null,
    };
  };
  const home = pre(row.home_entrant_id, "home");
  const away = pre(row.away_entrant_id, "away");
  const [homeShort, awayShort] = disambiguatedShorts(home, away);
  return {
    org: { id: row.org_id, default_locale: row.default_locale },
    competition: { id: row.competition_id, name: row.competition_name },
    sportKey: row.sport_key,
    fixture: {
      id: row.id,
      home_entrant_id: row.home_entrant_id,
      away_entrant_id: row.away_entrant_id,
      scheduled_at: isoDateTime(row.scheduled_at),
    },
    sides: [
      { id: home.id, name: home.name, short: homeShort, colour: home.colour },
      { id: away.id, name: away.name, short: awayShort, colour: away.colour },
    ],
    realtime: row.realtime === true,
    venueTz: await venueTzForDivision(row.division_id),
    stageName: row.stage_name,
  };
}
