import "server-only";
import { withTenant } from "@/lib/db";
import { departedRankedLast } from "@/lib/table-withdrawal";
import { TABLE_WITHDRAWAL_ROW, TABLE_WITHDRAWAL_VOIDED_ROW, activeTableWithdrawals } from "@/lib/table-withdrawal-note";
import { EngineError } from "@seazn/engine/core";
import {
  adjustmentUnitOf,
  completeTableStage,
  crossGroupRulesOf,
  isTableStageComplete,
  type CompletedTableStage,
  type CrossGroupRules,
  type FixtureResult,
  type PointsRule,
  type StandingsRow,
} from "@seazn/engine/competition";
import { loadLotsDraws, persistLotsDraws } from "../table-rules";
import type { Tx, SnapshotCause, StageInputs } from "./types";
import { loadStageInputs, toTableStage } from "./stage-inputs";
import { TABLE_KINDS } from "./kinds";

/** W5 app PR B Task 7 (C5, C7, C8): what an "Adjust points" write needs of a stage, read in the caller's transaction (under the
 *  division lock) from the same load every fold of the stage reads (`loadStageInputs`):
 *  - `members`: the entrants an adjustment can be made for - the same predicate the fold passes them by (`foldedAdjustments`):
 *    seated in a pool when the stage is seated, else declared (holds a seat on one of its lines, the engine's `entrants`);
 *  - `poolOf`: each member's pool id on a seated stage (the desk's picker groups by it), null on an unseated one;
 *  - `unit`: what an adjustment moves on this stage's table (`adjustmentUnitOf` over its rules' cascade, RB5-T15) and
 *    `pointsUnit` its points rule's stored unit - the footnote's display facts, recorded on the row. */
export async function adjustmentTarget(
  tx: Tx,
  stageId: string,
): Promise<{
  members: ReadonlySet<string>;
  poolOf: ReadonlyMap<string, string> | null;
  unit: "points" | "wins";
  pointsUnit: "whole" | "half";
}> {
  const inputs = await loadStageInputs(tx, stageId);
  const seated = inputs.seating.kind === "seated" ? inputs.seating.pools : undefined;
  const declared = new Set(inputs.entrants);
  return {
    members: seated === undefined ? declared : new Set(seated.keys()),
    poolOf: seated ?? null,
    unit: adjustmentUnitOf(inputs.rules.tiebreakers),
    pointsUnit: inputs.rules.points.unit,
  };
}

/**
 * What best-Nth reads of a source stage, from ONE load of it — the one reader both seeding builders hand `resolveProgression`
 * (`bestNthSourceOf`, usecases/pool-results.ts):
 * - W2d T12 (spec §5.9, ST-G4, X-TB-7): how the stage compares entrants from DIFFERENT groups, for `SourceTables.crossGroup`
 *   — its effective `crossGroup` order (the pin once active: a B1-migrated pin's is the pre-W2d list, so its seats do not
 *   move), its seeds, rngSeed and `winsCount`, and the cross-group draws stored under its "" pool (`crossGroupRulesOf`). The
 *   draws best-Nth makes come back as its `newLotsDraws`, stored with `persistLotsDraws(tx, stageId, null, …)` under the
 *   division lock.
 * - W5 app PR B T0 (G4; RB5-U1, X-UP-1): each pool's counted results as the stage's own fold makes them
 *   (`completeTableStage`'s `PoolTable.results`: the paid results of the pool's decided and walked-over fixtures), keyed by
 *   the fold's pool key — the pool's uuid. Since engine 10 (ruling 286) best-Nth compares a larger pool's candidate without
 *   its results against the pool's bottom k = size − min, and refuses a pool with k > 0 that hands none (STAGE_NOT_READY
 *   `pool_results_missing`). A stage whose fixtures name ONE table (a league, a Swiss, a one-pool group) has k = 0 by
 *   definition and is not folded: its map is empty (Task 0 review m2).
 *
 * - W5 app PR B T4 (RB5-U5, RB5-U7; X-UP-5): the entrants this stage's own withdrawal cascade EXPUNGED - its ACTIVE
 *   `table_withdrawal` rows (a Reinstate's `table_withdrawal_voided` takes a row out, `activeTableWithdrawals`) whose policy is
 *   `expunge` (the ledger mirrors the engine event's `mode: "expunge"`). Their results are already gone, so best-Nth counts them in
 *   no pool's effective size and never drops anything more for them (`PoolTable.expunged`, mapped to each pool by
 *   `withPoolResults`). Read for every stage: a one-table stage's leaver is no candidate either.
 *
 * One load, because the rules' `gamePoints` reader is identity-keyed on the very result objects that load paid
 * (`gamePointsReader`): a reduced row's Sonneborn-Berger, recomputed over results from a second load, would ask for results
 * this reader never paid. Like `stageTablePoints`, it stores no lots draw: results do not depend on how a tie is broken.
 */
export async function loadBestNthSource(
  tx: Tx,
  stageId: string,
): Promise<{ crossGroup: CrossGroupRules; poolResults: ReadonlyMap<string, readonly FixtureResult[]>; expunged: ReadonlySet<string> }> {
  const inputs = await loadStageInputs(tx, stageId);
  const stage = toTableStage(inputs, await loadLotsDraws(tx, stageId));
  const crossGroup = crossGroupRulesOf(stage);
  const expunged = await stageTableWithdrawals(tx, inputs, "expunge");
  if (new Set(inputs.tableFixtures.map((f) => f.poolId ?? "")).size <= 1) return { crossGroup, poolResults: new Map(), expunged };
  const { tables } = completeTableStage(stage, inputs.tableFixtures);
  return { crossGroup, poolResults: new Map(tables.pools.map((p) => [p.pool, p.results ?? []])), expunged };
}
export async function writeSnapshot(
  tx: Tx,
  stageId: string,
  poolId: string | null,
  rows: readonly StandingsRow[],
  through: number,
  cause: SnapshotCause,
): Promise<void> {
  await tx`
    insert into standings_snapshots (stage_id, pool_id, rows, computed_through_seq)
    values (${stageId}, ${poolId}, ${tx.json(rows as never)}, ${through})
    on conflict on constraint standings_snapshots_pkey do update set
      previous_rows = case
        when standings_snapshots.rows is not distinct from excluded.rows then standings_snapshots.previous_rows
        when ${cause}::text = 'result' then standings_snapshots.rows
        else excluded.rows
      end,
      rows = excluded.rows, computed_through_seq = excluded.computed_through_seq, updated_at = now()
  `;
}

/**
 * Recompute + cache the standings snapshots for a stage, under a division
 * advisory lock. Folds every decided fixture's delta and ranks via the
 * tiebreaker cascade (spec 03 §4.3).
 *
 * Writes EVERY pool the fold produced, each under its OWN key — `pool_id`
 * null only for the "" pool, i.e. the single non-pool table. This is
 * pool-safety held HERE rather than at each call site, because none of the
 * callers (usecases/stages/completion.ts `getStandings`, `overrideStandings`,
 * `unpairSwissRound` and `refoldStageTable` — the generate, a seed confirm,
 * a roster delete —, usecases/scoring.ts `onDecided`, usecases/stage-rules.ts,
 * usecases/admin-fixture-config.ts) knows whether the stage it is recomputing
 * has pools: most pass no pool at all, and scoring and the fixture-config
 * edit forward a FIXTURE's own `pool_id`.
 *
 * It used to write only the asked-for pool, and pick it with
 * `find(...) ?? tables.pools[0]` — then persist that fallback under the
 * ARGUMENT's key, never the table's. On a pooled stage a caller passing no
 * pool therefore minted a phantom `pool_id IS NULL` snapshot holding a byte
 * copy of the FIRST pool's table, and a caller naming a pool with no fixtures
 * of its own (an empty pool of a snake distribution) wrote Pool A's rows under
 * that pool's id. Nothing downstream can tell either apart from a real table —
 * the public division page renders every snapshot it is handed, and
 * usecases/stage-seeding.ts's `sourceStandingsTables` reads a null row as the
 * "" pool alongside "A"/"B". Same write set as `completeStageIfReady`'s, which
 * has always keyed on `pool.pool || null`; the two can no longer disagree
 * about the same stage.
 *
 * The return value is the asked-for pool's rows, and `[]` when no pool answers
 * to that key — including "no poolId given" on a pooled stage, which has no
 * overall table to return. `getStandings` (the only caller that reads it)
 * surfaces that as an empty table rather than a wrong one.
 *
 * `emptyFold` (W2d concern 2) — what a pool whose fold has no row does. A fold with no row is no table (the engine's
 * `isLevelTable`: "No rows is no table"):
 * - `"write"` (default): stored like any other, as every caller before W2d did.
 * - `"skip"`: not written. The generate's and a seed confirm's refold (usecases/stages/helpers.ts `refoldStageTable`): fixtures
 *   may seat nobody yet (a Swiss mint's shells, a fed group's TBD lines). Written, it would replace the public page's "No
 *   standings yet" with a table of no rows. A drawn group's pools are NOT skipped since PR B Task 1 (X-PO-1): the seating makes
 *   every member a row from the first fold, zero played, so each pool's level table is written like a league's.
 * - `"drop"`: not written, AND every stored table of the stage the fold did not just write is deleted — so the stored
 *   tables are exactly the fold's non-empty pools. A write that UNSEATS entrants without a result passes it (a roster
 *   delete, Unpair): the fold no longer places the departed, and a table it no longer produces must not keep their rows
 *   (a deleted entrant's row named by its raw id, review concern-2 I1).
 */
export async function recomputeStandings(
  orgId: string,
  stageId: string,
  poolId?: string,
  // m4: `cause` is "roster" unless the caller is a decided result's refold (see `writeSnapshot`): a refold that does not say it
  // is a result never makes a climber.
  opts: { emptyFold?: "write" | "skip" | "drop"; cause?: SnapshotCause } = {},
): Promise<readonly StandingsRow[]> {
  return withTenant(orgId, async (tx) => {
    // W5 follow-ups B7: the lock is taken BEFORE the inputs are read. Read first, a refold that loaded before a second result
    // committed could lock after that result's own refold had written, and overwrite the newer table with its stale one (no
    // staleness guard on the upsert): the stored table then missed a result until the stage's next write. Under the lock, each
    // refold reads every result committed before it, and the last writer is the last reader
    // (`engine-db/__tests__/standings-refold-race.test.ts`).
    const [owner] = await tx<{ division_id: string }[]>`select division_id from stages where id = ${stageId}`;
    if (owner) await tx`select pg_advisory_xact_lock(hashtext(${"division:" + owner.division_id}))`;
    const inputs = await loadStageInputs(tx, stageId);

    // completeTableStage folds + ranks each pool; cache them all, then hand
    // back the one we were asked for. Any lots it draws are stored first and the
    // table re-ranked from the stored rows (§5.8), so the snapshot is the stored order.
    const { tables } = await rankWithStoredLots(tx, inputs);
    const emptyFold = opts.emptyFold ?? "write";
    const written: string[] = [];
    for (const pool of tables.pools) {
      if (emptyFold !== "write" && pool.rows.length === 0) continue;
      await writeSnapshot(tx, stageId, pool.pool || null, pool.rows, inputs.division.seq, opts.cause ?? "roster");
      written.push(pool.pool || "");
    }
    if (emptyFold === "drop") {
      await tx`
        delete from standings_snapshots
         where stage_id = ${stageId} and coalesce(pool_id::text, '') <> all(${written}::text[])`;
    }
    const target = tables.pools.find((p) => (p.pool || null) === (poolId ?? null));
    return target ? target.rows : [];
  });
}

/**
 * The stage's ranked standings rows, computed in the CALLER's transaction —
 * the same fold + tiebreaker cascade `recomputeStandings` runs, with neither
 * a second tenant transaction nor a snapshot write.
 *
 * Exists for Swiss Playoff's repairing (usecases/stages/swiss-gen.ts `swissGen`), which
 * needs the division's REAL finishing order between rounds and must read it
 * inside the generation transaction it is already holding the division lock
 * in. `recomputeStandings` cannot serve that: it opens its own `withTenant`.
 *
 * Single-pool by construction for its one caller — a swiss stage has no pools
 * — so it returns the first (only) pool's rows; a stage whose fixtures are
 * all still unplayed ranks every entrant on a zero row, and a stage with no
 * fixtures at all returns [].
 */
export async function rankedStageStandings(
  tx: Tx,
  stageId: string,
): Promise<readonly StandingsRow[]> {
  const inputs = await loadStageInputs(tx, stageId);
  if (inputs.entrants.length === 0) return [];
  // The caller holds the division lock (its one caller, `swissGen`, generates under it): a draw made here is stored.
  const { tables } = await rankWithStoredLots(tx, inputs);
  return tables.pools[0]?.rows ?? [];
}

/**
 * W3 app-B T5 (SW-M11; X-SW-19; RB3-9): each entrant's points on the stage's own table, and the points rule that paid them.
 * A Swiss round is paired by SCORE GROUPS, and the score is this number: read from the same inputs (`loadStageInputs`) and
 * the same engine fold (`completeTableStage`) the published table is, so the groups, the table and the tie-breaks agree
 * (rulebook §5, last paragraph). A formula over the fixtures (`win.regulation`, `swissDrawPoints`) would be a second
 * authority; it would part from the table on an IIHF overtime win (3 / 2 / 1 / 0), a `bySetScore` map and a bonus rule.
 *
 * `points` holds a row for every entrant the fold lists; an entrant with no row (not seated yet) is simply absent, which
 * the caller reads as 0. `rule` is the very `rules.points` object `loadStageInputs` paid every result with
 * (`payout(…, rules.points, …)`): the stage's one rule, its pin once started - returned as handed, never re-read, so a
 * caller that needs the rule (the final-round maximum) shares it with the scores.
 *
 * It NEVER stores a lots draw, unlike `rankedStageStandings`: points do not depend on the order a tie is broken in, so the
 * draw the fold may make (`newLotsDraws`) is dropped on the floor here - nothing is persisted, and a stage's stored draws are
 * exactly what they were. Safe to call in the caller's transaction under the division lock, as `swissGen` does.
 */
export async function stageTablePoints(
  tx: Tx,
  stageId: string,
): Promise<{ points: ReadonlyMap<string, number>; rule: PointsRule }> {
  const inputs = await loadStageInputs(tx, stageId);
  return { points: tablePointsOf(inputs, await loadLotsDraws(tx, stageId)), rule: inputs.rules.points };
}

/**
 * Swiss float history (engine `SwissHistory.floats`; FIDE C.04.3 C14): each entrant's points on the stage's own table as they
 * stood going INTO each round of `cuts` - the score that round's boards were paired on, so the Pair can tell which earlier board
 * was between different scores (`swissFloatHistory`, usecases/stages/swiss-gen.ts). The same load and the same fold as
 * `stageTablePoints` (`tablePointsOf`), over the fixtures of the rounds before each one only: one authority for the number,
 * never a second count of the results. Read-only, like `stageTablePoints` (no lots draw is stored).
 *
 * A points adjustment names no round, so it is cut by when it was WRITTEN: only one whose ledger row comes before the round's
 * ledger seq in `cuts` (the round's newest pairing row, from the caller) is folded. An adjustment written after a round was
 * paired moved the table after its boards were seated, so it is not in that round's score. A round whose seq is null (no
 * such row known) folds every adjustment in force: the table as it stands. `division_events.seq` is the ordered field: gapless
 * per division and unique with it (db V220__division_events.sql), each row appended at the division's next seq under the
 * division lock (the adjustment's writer: usecases/points-adjustments.ts `appendRow`; the Pair's: usecases/stages/helpers.ts
 * `appendDivisionEvent`). `created_at` is not: every row of one transaction shares its `now()`.
 *
 * Otherwise the table is read as it stands now: a result corrected, or an adjustment undone, after a later round was paired is
 * read corrected. No cuts asked, no read.
 */
export async function stageTablePointsBefore(
  tx: Tx,
  stageId: string,
  /** round -> the ledger seq its adjustments are cut at (null: every adjustment in force). */
  cuts: ReadonlyMap<number, number | null>,
): Promise<ReadonlyMap<number, ReadonlyMap<string, number>>> {
  const out = new Map<number, ReadonlyMap<string, number>>();
  if (cuts.size === 0) return out;
  const inputs = await loadStageInputs(tx, stageId);
  const lotsDraws = await loadLotsDraws(tx, stageId);
  for (const [round, ledgerSeq] of cuts) out.set(round, tablePointsOf(inputsBefore(inputs, round, ledgerSeq), lotsDraws));
  return out;
}

/** Every entrant's points on the stage's table: the published table's fold (`completeTableStage`), its rows' `points`. */
function tablePointsOf(inputs: StageInputs, lotsDraws: Awaited<ReturnType<typeof loadLotsDraws>>): Map<string, number> {
  const { tables } = completeTableStage(toTableStage(inputs, lotsDraws), inputs.tableFixtures);
  const points = new Map<string, number>();
  for (const pool of tables.pools) for (const row of pool.rows) points.set(row.entrantId, row.points);
  return points;
}

/** The stage as it stood going into `round`: its fixtures of earlier rounds only, a declared absence only from an earlier
 *  round (the engine's map omits an entrant with none), and the adjustments written before `ledgerSeq` (all, when null).
 *  The entrants are kept whole: one seated only later reads 0, and one who has since left keeps what he held. */
function inputsBefore(inputs: StageInputs, round: number, ledgerSeq: number | null): StageInputs {
  const before = (r: number | null | undefined): boolean => r != null && r < round;
  const swissAbsentRounds = new Map<string, readonly number[]>();
  for (const [entrantId, absent] of inputs.swissAbsentRounds) {
    const earlier = absent.filter(before);
    if (earlier.length > 0) swissAbsentRounds.set(entrantId, earlier);
  }
  return {
    ...inputs,
    fixtures: inputs.fixtures.filter((f) => before(f.round_no)),
    tableFixtures: inputs.tableFixtures.filter((f) => before(f.roundNo)),
    swissAbsentRounds,
    adjustments: ledgerSeq === null ? inputs.adjustments : inputs.adjustments.filter((a) => a.seq < ledgerSeq),
  };
}

/**
 * W2d (spec §5.8, X-TB-4; PS-5b): rank the stage with its stored lots draws; store any draw the ranker had to make
 * (`persistLotsDraws`, one live draw per pool and member set), then RE-READ the stored rows and rank again, so the order
 * and `drawn_at` every caller sees — the snapshot, the rank_lock event — are the stored ones (the DB's `now()`), never
 * this call's own. Called under the division advisory lock. A second pass that still draws means a draw was not stored:
 * refused, never ranked by an order nobody stored.
 */
export async function rankWithStoredLots(tx: Tx, inputs: StageInputs): Promise<CompletedTableStage> {
  const done = await rankWithStoredLotsRaw(tx, inputs);
  if (inputs.kind !== "league" && inputs.kind !== "group") return done;
  return withDepartedRankedLast(done, await stageTableWithdrawals(tx, inputs), inputs);
}

/** W5 T8 fix round 1 (C1): the entrants THIS stage's own withdrawal cascade settled — its active `table_withdrawal` rows
 *  (`activeTableWithdrawals`). Read per stage, never from the division's field: an entrant who leaves later, from another
 *  stage (a knockout after the league finished), has no row here, and the finished table she topped is not re-ranked
 *  (RB5-L8). */
async function stageTableWithdrawals(tx: Tx, inputs: StageInputs, policy?: "expunge"): Promise<ReadonlySet<string>> {
  const ledger = await tx<{ seq: number; type: string; payload: unknown }[]>`
    select seq::int as seq, type, payload from division_events
     where division_id = (select division_id from stages where id = ${inputs.stage.id}) and type in (${TABLE_WITHDRAWAL_ROW}, ${TABLE_WITHDRAWAL_VOIDED_ROW})`;
  return new Set(
    activeTableWithdrawals(ledger)
      .filter((r) => r.stage_id === inputs.stage.id && (policy === undefined || r.policy === policy))
      .map((r) => r.entrant_id),
  );
}

/**
 * W5 T8 (RB5-W1, X-WDT-7): a league's or group's departed entrants rank LAST, on every surface — the stored snapshot (every
 * table page, the hub, the API) and the `stage_completed` places alike, so a walkover leaver who won her first matches
 * neither tops the table she left nor heads its final order. One place, after the fold ranked and any lots were stored.
 * A Swiss table is W3's and keeps its own order.
 */
function withDepartedRankedLast(done: CompletedTableStage, settled: ReadonlySet<string>, inputs: StageInputs): CompletedTableStage {
  // Both: this stage's cascade settled her (its row), and she is still out (a Reinstate the cascade could not reverse — a
  // table already complete — leaves the row standing with her back in the field).
  const departed = (id: string) => settled.has(id) && !inputs.field.has(id);
  return {
    ...done,
    tables: { ...done.tables, pools: done.tables.pools.map((p) => ({ ...p, rows: departedRankedLast(p.rows, departed) })) },
    events: done.events.map((e) => (e.type === "stage_completed" ? { ...e, finalRanks: departedRankedLast(e.finalRanks, departed) } : e)),
  };
}

async function rankWithStoredLotsRaw(tx: Tx, inputs: StageInputs): Promise<CompletedTableStage> {
  const stageId = inputs.stage.id;
  const first = completeTableStage(toTableStage(inputs, await loadLotsDraws(tx, stageId)), inputs.tableFixtures);
  if (first.newLotsDraws.length === 0) return first;
  const byPool = new Map<string, (typeof first.newLotsDraws)[number][]>();
  for (const draw of first.newLotsDraws) byPool.set(draw.pool, [...(byPool.get(draw.pool) ?? []), draw]);
  for (const [pool, draws] of byPool) await persistLotsDraws(tx, stageId, pool === "" ? null : pool, draws);
  const stored = completeTableStage(toTableStage(inputs, await loadLotsDraws(tx, stageId)), inputs.tableFixtures);
  if (stored.newLotsDraws.length > 0) {
    throw new EngineError("CONFIG_INVALID", `stage ${stageId}: a drawing of lots was made but not stored`, {
      stageId,
      reason: "lots_draw_unstored",
      membersKeys: stored.newLotsDraws.map((d) => d.membersKey),
    });
  }
  return stored;
}

/**
 * W3 T13 (reviewer flag R3): whether `completeStageIfReady` would complete this TABLE stage now — its own predicate
 * (`isTableStageComplete` over the stage as the caller's transaction sees it), so a write that hands the stage to
 * `completeStage` once it commits ("Finish the Swiss now") can refuse BEFORE it commits instead of leaving the stage
 * half-finished. Already complete: true. Another kind: false (its only caller is a Swiss).
 */
export async function tableStageCompletable(tx: Tx, stageId: string): Promise<boolean> {
  const inputs = await loadStageInputs(tx, stageId);
  if (inputs.stage.status === "complete") return true;
  if (!TABLE_KINDS.has(inputs.kind)) return false;
  return isTableStageComplete(toTableStage(inputs, new Map()), inputs.tableFixtures);
}
