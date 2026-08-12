import "server-only";
// S8/#417 — the entrant→person membership loader, for the engine's
// entrant-fallback stat attribution (`PlayerStatsFoldCtx`, `@seazn/engine/stats`).
// The engine can fold an EntrantId-only payload (`wonBy`/`by` — a v1-era
// stream) into per-person credit, but it cannot know which persons make up
// an entrant; that lives only in THIS app's `entrant_members` table. This
// file is the one place that answers it, mirroring lineups.ts's shape.
import type postgres from "postgres";
import type {
  PlayerStatsEntrant,
  PlayerStatsEntrantKind,
  PlayerStatsFoldCtx,
} from "@seazn/engine/stats";

type Tx = postgres.TransactionSql;

export interface EntrantMembership {
  kind: PlayerStatsEntrantKind;
  personIds: readonly string[];
}

interface EntrantMemberRow {
  entrant_id: string;
  kind: PlayerStatsEntrantKind;
  person_id: string | null;
}

/**
 * Every entrant in a division plus its roster's person ids, in ONE query —
 * the S8/#417 counterpart to lineups.ts's `loadLineupPairsForDivision`,
 * batched the same way (one query per division, not one per fixture).
 *
 * LEFT JOIN on `entrant_members`, so an entrant with no roster yet still
 * appears (kind, empty `personIds`) rather than being silently absent — an
 * absent entrant would misreport as `unknownEntrants` in the caller's
 * diagnostics even though it genuinely exists, just with nobody on it.
 *
 * `entrants.kind` (`db/migration/v2-engine/tables/V212__entrants.sql`) is a
 * `check (kind in ('team','individual','pair'))` — the SAME three values as
 * `PlayerStatsEntrantKind`, so the DB column is cast straight through with no
 * mapping table.
 */
export async function loadEntrantMembersForDivision(
  tx: Tx,
  divisionId: string,
): Promise<Map<string, EntrantMembership>> {
  const rows = await tx<EntrantMemberRow[]>`
    select e.id as entrant_id, e.kind, em.person_id
    from entrants e
    left join entrant_members em on em.entrant_id = e.id
    where e.division_id = ${divisionId}
  `;
  const out = new Map<string, EntrantMembership>();
  for (const r of rows) {
    const existing = out.get(r.entrant_id);
    const personIds: string[] = existing ? [...existing.personIds] : [];
    if (r.person_id !== null) personIds.push(r.person_id);
    out.set(r.entrant_id, { kind: r.kind, personIds });
  }
  return out;
}

/**
 * The engine's `PlayerStatsFoldCtx` for ONE fixture (S8/#417).
 *
 * `ctx.entrants` MUST be exactly this fixture's own [home, away] pair, never
 * the whole division's roster, even though `members` (from the loader above)
 * is division-wide — this is the load-bearing detail the type's own
 * docstring states ("which entrants exist THIS fixture") and that the
 * engine's `folded` match/set-outcome fold depends on structurally: every
 * cfg-replaying preset on the setbased/nested kernels (and boardgame/carrom/
 * generic) keys its synthetic two-sided replay off `ctx.entrants[0]`/`[1]`
 * and bails to `[]` the moment `ctx.entrants.length !== 2`
 * (`setBasedMatchOutcomesFold`, packages/engine/src/sports/setbased/kernel.ts).
 * Handing it the division's full entrant list would silently zero out
 * `sets_won`/`matches` for every fixture in the division.
 *
 * A null side (bye/TBD) is dropped, not padded — producing fewer than 2
 * entrants is the CORRECT degraded ctx for an unscoreable fixture, and the
 * engine's own guard handles it safely (never throws, per the house rule
 * against a data-derived throw in a fold path).
 *
 * `personsOf` reads the whole division-wide `members` map rather than being
 * narrowed to the two entrants above — harmless, since the engine only ever
 * calls it for an id already found in `ctx.entrants` (`resolveMetricPersons`
 * looks the id up there first), and simpler than building a second, narrower
 * closure per fixture.
 *
 * An entrant id absent from `members` (should not happen under the schema's
 * FK, but this function never assumes it) defaults to kind `"team"` — the
 * SAFE default, since the engine's mandatory kind guard then credits nobody
 * rather than fabricating an attribution for missing roster data.
 */
export function entrantFoldCtx(
  homeEntrantId: string | null,
  awayEntrantId: string | null,
  members: ReadonlyMap<string, EntrantMembership>,
  cfg: unknown,
): PlayerStatsFoldCtx {
  const entrants: PlayerStatsEntrant[] = [homeEntrantId, awayEntrantId]
    .filter((id): id is string => id !== null)
    .map((id) => ({ id, kind: members.get(id)?.kind ?? "team" }));
  return {
    entrants,
    personsOf: (entrantId) => members.get(entrantId)?.personIds ?? [],
    cfg,
  };
}
