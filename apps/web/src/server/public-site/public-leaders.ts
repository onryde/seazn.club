// Spectator surface W2, Task 3 — the public, consent-gated leader-row reader.
//
// Public surface: takes a bare `Sql` client (no AuthCtx, no tenant scoping),
// same contract as `readPublicLineups` beside it. `sql` from `@/lib/db` is the
// RLS-BYPASSING connection — `withTenant` is what activates `app_user` and the
// tenant policies — so `player_stat_snapshots`, whose only policy is
// `org_id = current_org_id()`, is readable here exactly as `data.ts`'s own
// per-division player stats already read it. The visibility gate is therefore
// carried by the JOIN, not by RLS: every row must survive
// `public_divisions_v` (competition visibility public/unlisted, division not
// archived), so a private competition's snapshots cannot reach a spectator
// even if a caller passes their division ids.
//
// ---------------------------------------------------------------------------
// This reader does NOT call `recomputePlayerStats`.
//
// That function re-folds EVERY `score_event` in a division on every call — its
// `throughSeq` is a running count of events folded, not a resume point — so
// calling it per division on a public page render makes a spectator's page
// load O(all events ever scored in the competition). Keeping
// `player_stat_snapshots` fresh is the scoring WRITE's job; this surface reads
// what the write left behind. A hub whose boards lag a live fixture by a few
// seconds is the correct trade; re-folding a season's ledger to close that gap
// is not.
// ---------------------------------------------------------------------------
import postgres from "postgres";
import { maskPublicEntrantNames } from "./data";
import { toLeaderInputRows, type LeaderDivisionConsent, type LeaderInputRow, type LeaderSnapshotRow } from "./leaders";

export type Sql = ReturnType<typeof postgres>;

/** The raw shape the query below returns, before the consent fold. Carries the
 *  entrant's `kind` because `maskPublicEntrantNames` needs it: a TEAM's own
 *  declared name takes no personal-consent axis and passes through untouched,
 *  while an individual's or a pair's display name is a person's name and must
 *  be masked like one. */
type SnapshotQueryRow = LeaderSnapshotRow & { entrant_kind: string | null };

/**
 * Read every person's stat snapshot across the given divisions, with names
 * already resolved through the shared consent resolver.
 *
 * Takes no org id: the read is division-scoped and the visibility gate is the
 * `public_divisions_v` join, so an org id would be an unused parameter a
 * caller could reasonably expect to be enforcing something.
 */
export async function readLeaderRows(
  sql: Sql,
  divisions: readonly LeaderDivisionConsent[],
): Promise<LeaderInputRow[]> {
  if (divisions.length === 0) return [];

  const rows = await sql<SnapshotQueryRow[]>`
    select ps.division_id, ps.person_id, ps.stats,
           p.full_name, p.consent,
           e.id            as entrant_id,
           e.kind          as entrant_kind,
           e.display_name  as entrant_name,
           e.badge_url,
           e.team_display->>'logo_path' as team_logo_path,
           exists (select 1 from public_players_v v where v.id = ps.person_id) as public_profile
    from player_stat_snapshots ps
    join public_divisions_v d on d.id = ps.division_id
    join persons p on p.id = ps.person_id and p.merged_into is null
    left join lateral (
      select en.id, en.kind, en.display_name, en.badge_url, en.team_display
      from entrant_members em
      join public_entrants_v en on en.id = em.entrant_id
      where em.person_id = ps.person_id and en.division_id = ps.division_id
      order by en.id
      limit 1) e on true
    where ps.division_id in ${sql(divisions.map((d) => d.id))}`;

  // Entrant display names go through the SAME masking pass the division page
  // uses — never a second, parallel decision. It is per-division (it takes
  // that division's youth / player_name_display policy), so the distinct
  // entrants are grouped by division and masked one division at a time.
  const entrantsByDivision = new Map<string, Map<string, { id: string; kind: string; display_name: string }>>();
  for (const row of rows) {
    if (row.entrant_id === null || row.entrant_kind === null || row.entrant_name === null) continue;
    const forDivision = entrantsByDivision.get(row.division_id) ?? new Map();
    forDivision.set(row.entrant_id, {
      id: row.entrant_id,
      kind: row.entrant_kind,
      display_name: row.entrant_name,
    });
    entrantsByDivision.set(row.division_id, forDivision);
  }

  const maskedEntrantNames = new Map<string, string>();
  for (const division of divisions) {
    const forDivision = entrantsByDivision.get(division.id);
    if (forDivision === undefined) continue;
    const masked = await maskPublicEntrantNames([...forDivision.values()], division);
    for (const entrant of masked) maskedEntrantNames.set(entrant.id, entrant.display_name);
  }

  return toLeaderInputRows(rows, divisions, maskedEntrantNames);
}
