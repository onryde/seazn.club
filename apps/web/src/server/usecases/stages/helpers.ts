import "server-only";
// Small DB helpers two or more stages modules call: has the division started,
// the best-effort public revalidate, the departed-entrant set, and the standings
// refold after a fixture change.

import { withTenant } from "@/lib/db";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { recomputeStandings } from "@/server/engine-db";
import { log } from "@/server/logger";
import { REAL_TABLE_KINDS, type Tx } from "./types";

/**
 * `divisions.status` values that mean the tournament is UNDER WAY. The column's
 * check constraint is `('setup','scheduled','active','completed')`, and
 * `scheduled` is "timetable published, not yet started" — `publishSchedule`
 * moves setup → scheduled and only `startDivision` moves it to active. So the
 * pre-Start side is `setup` AND `scheduled`; a predicate written
 * `status !== 'setup'` would be wrong.
 *
 * Same polarity as `enrollEntrants`' roster lock (entrants.ts): "this
 * tournament has started" is exactly `active` or `completed` there too.
 */
const DIVISION_STARTED_STATUSES: ReadonlySet<string> = new Set(["active", "completed"]);

/**
 * Read INSIDE the caller's write transaction, never in a separate pre-flight:
 * `generateStageFixturesTx` (Generate's and Rebuild's shared body) already holds
 * `pg_advisory_xact_lock('division:' + division_id)` by the time `swissGen`
 * runs, so this is read under the lock and cannot go stale between the check
 * and the writes it gates (the file's stated convention; design-doc Task 2.4).
 *
 * A missing row reads as STARTED — the narrower, lazier write — rather than
 * unlocking the wider one on an absence.
 */
export async function divisionHasStarted(tx: Tx, divisionId: string): Promise<boolean> {
  const [division] = await tx<{ status: string }[]>`
    select status from divisions where id = ${divisionId}`;
  return division === undefined || DIVISION_STARTED_STATUSES.has(division.status);
}

/**
 * Generate a stage's fixtures (doc 08 §3). Idempotent: the generator's stable
 * ids are persisted as fixtures.ext_key, so a re-run inserts only what's
 * missing and reports the diff. Feed wiring (winner_to/loser_to) and bye
 * awards are applied after insert, under the division advisory lock.
 */
// Fixture-shape changes (generation, stage completion) must refresh the public
// dashboard's ISR pages just like scoring writes do (doc 09 §3).
//
// AWAIT it, at every call site (stage-revalidate-settles.test.ts reads the file
// for a bare one). It looks the stage up and only THEN calls
// `fireDivisionRevalidate`, so a `void`ed call is a tag revalidation made after
// the request has flushed its revalidations: Next 16 drops it silently and the
// public pages stay stale for the cache entry's whole life. It also outlives the
// write that asked for it, which landed it in a later test's window as the CI
// flake of run 40233887793.
//
// Best-effort: the write it follows has already committed, so a failed lookup is
// logged and swallowed, never turned into the caller's failure - and never left
// as an unhandled rejection, which is what a `void`ed one became.
export async function fireStageRevalidate(orgId: string, stageId: string): Promise<void> {
  try {
    const row = await withTenant(orgId, async (tx) => {
      const [r] = await tx<{ division_id: string; competition_id: string }[]>`
        select s.division_id, d.competition_id
        from stages s join divisions d on d.id = s.division_id
        where s.id = ${stageId}`;
      return r ?? null;
    });
    if (row) fireDivisionRevalidate(row.division_id, row.competition_id);
  } catch (err) {
    log.warn({ event: "stage_revalidate_failed", stageId, err: String(err) }, "stage write committed, but its public-page revalidation could not be fired");
  }
}

/**
 * W2d concern 2 (spec §5.7, anti-goal 3) — refold a table stage's stored table after a write that seats or unseats its
 * entrants with no result: the generate and a seed-proposal confirm (`"skip"`), a roster delete (`"drop"`). One gate for
 * all three: `REAL_TABLE_KINDS`, the kinds scoring refolds on a result (usecases/scoring.ts `TABLE_KINDS`, pinned equal
 * by generate-level-table.test.ts) — a bracket has no table. `emptyFold` is engine-db `recomputeStandings`'s: `"skip"`
 * stores no fold that places nobody (a Swiss mint, a pooled stage before results, placeholders); `"drop"` also deletes
 * the stored tables the fold no longer produces, so a deleted entrant's row never outlives them.
 *
 * Best-effort, after the write has committed (review m4): a refold that throws (a rank-time refusal, anti-goal 2) is
 * logged, never turned into a failed write the caller would retry into a no-op. The stage's table is then whatever was
 * stored before the write until the next result's refold — or, when nothing is stored, the organiser's Standings read
 * (`getStandings` recomputes only on a miss). So a failed refold after Pair next, a regenerate or a roster delete leaves
 * the previous table (a deleted entrant's row included) until that result (review n3).
 */
export async function refoldStageTable(
  orgId: string,
  stage: { id: string; kind: string },
  emptyFold: "skip" | "drop",
): Promise<void> {
  if (!REAL_TABLE_KINDS.has(stage.kind)) return;
  try {
    await recomputeStandings(orgId, stage.id, undefined, { emptyFold });
  } catch (err) {
    log.error({ err, event: "stage_table_refold_failed", stageId: stage.id, emptyFold }, "stage_table_refold_failed");
  }
}

/** The entrants of `divisionId` who have LEFT the field — the complement of
 *  the house "field" predicate `status in ('registered','confirmed')` that
 *  generateStageFixturesWrite's `active` read and issueChallenge's
 *  ladder_order initialisation both use. Same spelling as the two sites that
 *  already ask this question directly (usecases/officials.ts's `withdrawn`
 *  read, usecases/schedule-ai.ts's `entrantRows`), not a third one.
 *
 *  Why this question needs asking at all: a withdrawal is a STATUS FLIP, not
 *  a delete. The row survives, and the standings SNAPSHOT deliberately keeps
 *  her — engine-db/competition.ts derives its entrant set from fixture
 *  home/away ids with no status filter, so the row she earned stays on the
 *  public board. Every membership taken from the STANDINGS therefore
 *  inherits withdrawn entrants and must intersect back against the field;
 *  membership taken from the field query already has. */
export async function departedEntrantIds(tx: Tx, divisionId: string): Promise<Set<string>> {
  const rows = await tx<{ id: string }[]>`
    select id from entrants
    where division_id = ${divisionId} and status in ('withdrawn','disqualified')`;
  return new Set(rows.map((r) => r.id));
}