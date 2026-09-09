// The VENUE lane's ONE database read (V305, "one zone per fixture").
//
// Review 2026-09-09 finding I3: three copies of this join existed — one in
// `public-site/data.ts` (Task 9, feeding `loadMatchCentre`), one in
// `server/overlay/load.ts` (stream overlay Task 0), and one inside
// `usecases/public.ts`'s `loadFixtureMatchCentreCtx`. Copies of a SQL shape
// drift silently: a mutation that blanked `org_tz` in one of them was invisible
// to every mocked unit test in the tree. This module is the single authority
// for "which two columns the venue lane reads"; `resolveVenueTz` (lib/tz.ts:44)
// remains the single authority for how they are combined.
//
// NEVER `pickTimezone` and never the `seazn_tz` cookie: a London-based
// organiser can run an event in Malaga, and the overlay is watched by an
// audience in neither.
import "server-only";
import { sql } from "@/lib/db";
import { resolveVenueTz } from "@/lib/tz";

/** The raw pair, for callers that need the columns THEMSELVES and not just the
 *  resolved zone — `loadMatchCentre` takes `orgTz` and `division.tz`
 *  separately, so `getPublicFixture` reads this once and uses it for both. */
export interface VenueTzRow {
  division_tz: string | null;
  org_tz: string | null;
}

/**
 * The division's own `schedule_settings.tz` override and its organisation's
 * zone, in one round trip.
 *
 * `schedule_settings.tz` is `text not null default 'UTC'`
 * (`V114__scheduling.sql:48`), so a division row that merely EXISTS shadows the
 * org's zone. "Org fallback" therefore means no `schedule_settings` row at all,
 * which is why this is a LEFT JOIN and why the column stays nullable here.
 */
export async function venueTzRow(divisionId: string): Promise<VenueTzRow | undefined> {
  const [row] = await sql<VenueTzRow[]>`
    select ss.tz as division_tz, o.timezone as org_tz
    from divisions d
    left join schedule_settings ss on ss.division_id = d.id
    left join organizations o on o.id = d.org_id
    where d.id = ${divisionId}`;
  return row;
}

/** The resolved IANA zone for a division's venue: its own override, else the
 *  organisation's, else UTC. A raw zone, never a pre-formatted label — the
 *  label is formatted by whichever surface holds the locale. */
export async function venueTzForDivision(divisionId: string): Promise<string> {
  const row = await venueTzRow(divisionId);
  return resolveVenueTz(row?.division_tz, row?.org_tz);
}
