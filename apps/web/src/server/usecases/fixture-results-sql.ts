// When a fixture holds a RESULT, as SQL: the one predicate every destructive
// or moving fixture path consults. Server-only (it is SQL); the client says
// the refusal off `PLAYED_REFUSAL_CODE` (`@/lib/played-fixture-statuses`).
import type postgres from "postgres";

type Tx = postgres.TransactionSql;

/**
 * The result-evidence tables EVERY destructive fixture path must consult,
 * as one SQL fragment. `on` names the `fixtures` row in the enclosing query
 * (an alias, or the table itself in an unaliased UPDATE/DELETE); the caller
 * supplies its own status clause and its own row scope.
 *
 * Shared deliberately (2026-09-20 review, C1): `unpairSwissRound` shipped
 * with a subset of this list — `score_events` only — and a bye predicate that
 * excluded real results from even that. A subset guard on a destructive path
 * is exactly how the defect happened, so the list is written once and every
 * caller reads it.
 *
 * Why `config_snapshot` is in here and not only the event tables: V347 freezes
 * the resolved cfg onto the fixture when the FIRST event lands
 * (`append-event.ts`), and `fixture-cfg.ts`'s own header states that
 * `config_snapshot is null` is precisely "not scored yet". It is monotonic,
 * which `fixtures.status` is NOT — `fixtureStatusFromFold` walks a fixture
 * back to `scheduled` when a `core.start` is voided, so a status test alone
 * can silently stop refusing.
 */
export function fixtureEvidenceSql(tx: Tx, on = "f") {
  const f = tx(on);
  return tx`
    ${f}.config_snapshot is not null
    or exists (select 1 from score_events se where se.fixture_id = ${f}.id)
    or exists (select 1 from match_states ms where ms.fixture_id = ${f}.id)
    or exists (select 1 from match_reports mr where mr.fixture_id = ${f}.id)
    or exists (select 1 from official_marks om where om.fixture_id = ${f}.id)
    or exists (select 1 from suspensions s where s.fixture_id = ${f}.id)`;
}

/**
 * A fixture that holds a result: `rebuildStageFixtures`' refusal set, which
 * reads it. In play, decided or finalized; a walkover with both seats filled
 * (a one-sided forfeit is the generator's bye); an abandonment that carries
 * an outcome (a no-result); or anything recorded at all (`fixtureEvidenceSql`
 * — a start taken back leaves `scheduled` behind, and its events).
 *
 * ONE predicate (review 2 of #857, I3, owner ruling: history's played set IS
 * the rebuild predicate). History's results-guard (`playedFixtureIds`), its
 * row filter on every write, the schedule clear, the pool clear and the
 * rain-delay shift all read it, so none of them moves or deletes what another
 * refuses to undo. A status list alone let history delete an abandoned match
 * with its events, and a shift move a walkover's slot that its own Undo then
 * refused to put back.
 */
export function fixtureHasResultSql(tx: Tx, on = "f") {
  const f = tx(on);
  return tx`(
    ${f}.status in ('in_play', 'decided', 'finalized')
    or (${f}.status = 'abandoned' and ${f}.outcome is not null)
    or (${f}.status = 'forfeited' and ${f}.home_entrant_id is not null and ${f}.away_entrant_id is not null)
    or (${fixtureEvidenceSql(tx, on)})
  )`;
}

/** The division's fixtures that hold a result (`fixtureHasResultSql`). */
export async function playedFixtureIds(tx: Tx, divisionId: string): Promise<Set<string>> {
  const rows = await tx<{ id: string }[]>`
    select f.id from fixtures f where f.division_id = ${divisionId} and ${fixtureHasResultSql(tx)}`;
  return new Set(rows.map((r) => r.id));
}
