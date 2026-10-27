// Stage state machines — spec 05 §1 (six kinds), §3 (rank locks), §5 (division
// events, withdrawal policies). A stage moves draft → open → complete; this
// module owns the completion predicate per kind, the ranking of a completed
// stage into `finalRanks`, and the division-event ledger those transitions
// emit. Fixture GENERATION is PROMPT-09 — a stage here consumes an
// already-generated fixture set (its status + results) and never builds one.
import type { EntrantId, StageKind } from "../core/types.ts";
import { foldResults, foldStandings, type FixtureResult } from "./standings.ts";
import { applyRankLocks, type RankLock } from "./points.ts";
import type { StandingsDelta } from "../core/types.ts";
import type { CrossGroupRules, PoolTable, SourceTables as StageTables } from "./progression.ts";
import type { TableRules } from "./table-rules.ts";
import { buildSwissTable, membersKeyOf, rankStandings, type MembersKey, type NewLotsDraw, type RankContext, type StoredLotsDraw } from "./tiebreakers.ts";

// spec 02 §6 fixture statuses that matter to a stage's completion/ranking.
export type FixtureStatus = "scheduled" | "in_play" | "decided" | "void" | "walkover";

const SETTLED: ReadonlySet<FixtureStatus> = new Set(["decided", "void", "walkover"]);
/** A fixture in one of these statuses is finished for its stage: it can no
 *  longer move a table. Exported (standings qualification, plan M12) so the web
 *  builder counts a table's remaining matches with the engine's own set rather
 *  than a copy that could drift from `isTableStageComplete`. */
export { SETTLED as SETTLED_FIXTURE_STATUSES };
const COUNTS_FOR_STANDINGS: ReadonlySet<FixtureStatus> = new Set(["decided", "walkover"]);

// A league/group/swiss fixture as the stage sees it: a status and, once
// decided, the sport module's [home, away] delta pair. Void fixtures never
// reach the standings fold (the adapter may still attach a result, which
// counts only for pool membership).
//
// `awardDelta` is the one-sided sit-out path (Swiss odd-field bye, KO seeded
// bye): forfeited + `outcome.kind === "award"` with the other seat null, so
// there is no [home, away] pair and no match_state for `standingsDelta`. The
// adapter synthesises a single win delta; the fold treats it like any other
// played win. Buchholz/SB see it as an unplayed game (opponent null).
export interface TableFixture {
  id: string;
  poolId?: string;
  roundNo?: number;
  status: FixtureStatus;
  result?: FixtureResult;
  awardDelta?: StandingsDelta;
}

// A bracket fixture (knockout / double_elim / stepladder). `round` is 0-based
// and monotonic (higher = later); the deciding game carries `isFinal`.
export interface BracketFixture {
  id: string;
  bracket?: "WB" | "LB" | "GF"; // double-elim lanes; omit for single bracket
  round: number;
  isFinal?: boolean; // SE final / DE grand final (or bracket-reset game)
  thirdPlace?: boolean;
  status: FixtureStatus;
  home?: EntrantId;
  away?: EntrantId;
  winner?: EntrantId; // set once decided/walkover
  loser?: EntrantId;
  /** W2b (spec §5.3, W2b-R11), set by the web's `bracketWinnerLoser`: "loser" — the loser forfeited (an `award`), so it
   *  is out of the tournament here and never drops to a losers'-bracket or third-place seat (X-DE-1); "both" — a double
   *  walkover, no winner and no loser, both sides out here (X-DW-2). Ranks pin these entrants' elimination round to
   *  this fixture, so they read the same answer seating does. */
  walkedOver?: "loser" | "both";
}

// Everything the ranking pass needs about a table stage that isn't in the
// fixtures themselves (spec 05 §4 cascade is data).
export interface TableStage {
  id: string;
  kind: Extract<StageKind, "league" | "group" | "swiss">;
  entrants: readonly EntrantId[];
  /** W2d (spec §5.4, §6 E1): the stage's effective table rules (`resolveTableRules`). The table ranks by
   *  `rules.tiebreakers`; `points` and `crossGroup` ride along for the caller that pays and the progression that compares
   *  groups — `completeTableStage` folds the deltas it is handed and never re-pays them. */
  rules: TableRules;
  /** W2d (B2, HK-TB-1): which wins the `wins` step counts — the module's `winsCount`. Absent = every win. */
  winsCount?: RankContext["winsCount"];
  /** W2d (B5): a result's GAME points, for `sberger` and `direct` on a non-Swiss stage. Absent = the table points. */
  gamePoints?: RankContext["gamePoints"];
  swiss?: boolean; // assemble the Swiss ledger for buchholz/sberger/direct
  seeds?: ReadonlyMap<EntrantId, number>;
  rngSeed?: number;
  rounds?: number; // swiss: N rounds to play
  /** Carry-over openings (Jul3/05 §3): synthetic deltas folded before the
   *  stage's own fixtures — prior H2H is never replayed. */
  openingDeltas?: readonly StandingsDelta[];
  /** Manual rank locks (Jul3/05 §4): pinned ranks; the cascade orders only
   *  the unlocked remainder around them. */
  rankLocks?: readonly RankLock[];
  /** Circular-H2H mode for ≥3-way ties (Jul3/05 §5). */
  h2hScope?: "mini_table" | "overall";
  /** W2d (spec §5.8): the stage's stored lots draws, by pool (a fixture's
   *  `poolId`, "" for none — the key completeTableStage names its pools by),
   *  then by the tied set's members key. A draw belongs to its pool. */
  lotsDraws?: ReadonlyMap<string, ReadonlyMap<MembersKey, StoredLotsDraw>>;
  /** W2d (spec §5.6 "ST-G12", X-TB-8): every fixture the stage schedules, decided or not, as [home, away] — one entry per
   *  fixture (`RankContext.scheduledPairs`). A head-to-head step needs the tied class's mini-schedule complete. Absent or
   *  empty = every mini-schedule complete, as before W2d. Not read on a Swiss stage (no round-robin schedule; B1). */
  scheduledPairs?: RankContext["scheduledPairs"];
  /** W2d (IH-TB-2): the sport's partial-schedule order (`SportModule.partialScheduleOrder`). Absent = the block does not
   *  split a class whose mini-schedule is incomplete. */
  partialScheduleOrder?: RankContext["partialScheduleOrder"];
}

/** W2d (spec §5.9, ST-G4, X-TB-7): how this stage compares entrants from DIFFERENT groups (best-Nth) — its effective
 *  `crossGroup` order (pinned with the stage), with the seeds, `winsCount` and rngSeed its keys read, and the cross-group
 *  draws stored for it. Those live in the stage-wide pool "" (`stage_lots_draws.pool_id` null): a cross-group tie holds
 *  one entrant per group, so its members key never meets a group's own tie, and a pooled stage has no "" table of its
 *  own (T5 review G3). The one reading of a stage for `SourceTables.crossGroup`. */
export function crossGroupRulesOf(stage: TableStage): CrossGroupRules {
  const lotsDraws = stage.lotsDraws?.get("");
  return {
    order: stage.rules.crossGroup,
    ...(lotsDraws === undefined ? {} : { lotsDraws }),
    ...(stage.seeds === undefined ? {} : { seeds: stage.seeds }),
    ...(stage.rngSeed === undefined ? {} : { rngSeed: stage.rngSeed }),
    ...(stage.winsCount === undefined ? {} : { winsCount: stage.winsCount }),
  };
}

export interface BracketStage {
  id: string;
  // L3/#414 — page_playoff added. bracketRanks/isBracketStageComplete below
  // read only round/isFinal/loser/status off the fixtures, never stage.kind,
  // so the fixed 4-team page playoff (scheduling/generatePagePlayoff) needs
  // no algorithm change — see the page_playoff describe block in
  // stage.test.ts for why the existing lastLossRound fallback already ranks
  // it correctly with no thirdPlace fixture involved.
  kind: Extract<StageKind, "knockout" | "double_elim" | "stepladder" | "page_playoff">;
  seeds?: ReadonlyMap<EntrantId, number>;
}

// spec 05 §5 — the structural ledger. (fixtures_generated / fixture_replaced
// belong to generation, PROMPT-09.)
export type DivisionEvent =
  | { type: "stage_opened"; stageId: string }
  | { type: "stage_completed"; stageId: string; finalRanks: EntrantId[] }
  | { type: "rank_lock_required"; stageId: string; group: EntrantId[] }
  // W2d (spec §5.8, PS-5b): `order` and `drawnAt` are the STORED draw's. A draw
  // made in this call has no date yet, so it emits rank_lock_required alone and
  // goes back in `newLotsDraws`; the lock follows once the draw is stored.
  | { type: "rank_lock"; stageId: string; method: "lots"; group: EntrantId[]; order: EntrantId[]; drawnAt: string }
  | {
      type: "entrant_withdrawn";
      stageId: string;
      entrantId: EntrantId;
      policy: "void_remaining" | "bracket_walkover";
      mode?: "expunge" | "award";
    };

// spec 05 §5 — a stage's instruction to re-status fixtures after a withdrawal
// (the sport-agnostic stage can't mint an award delta; the adapter turns
// `walkoverTo` into an `award` outcome via the sport module).
export interface FixtureUpdate {
  fixtureId: string;
  status: Extract<FixtureStatus, "void" | "walkover">;
  walkoverTo?: EntrantId;
}

// ---------------------------------------------------------------------------
// Completion predicates — spec 05 §1
// ---------------------------------------------------------------------------

function poolOf(fixture: TableFixture): string {
  return fixture.poolId ?? "";
}

// league / group: every fixture decided or void (group pools all complete is
// the same condition — pools only partition the fixtures). swiss: the first
// `rounds` rounds all settled.
export function isTableStageComplete(stage: Pick<TableStage, "kind" | "rounds">, fixtures: readonly TableFixture[]): boolean {
  if (fixtures.length === 0) return false;
  if (stage.kind === "swiss") {
    const rounds = stage.rounds ?? 0;
    if (rounds <= 0) return false;
    for (let round = 1; round <= rounds; round++) {
      const inRound = fixtures.filter((fixture) => fixture.roundNo === round);
      if (inRound.length === 0 || !inRound.every((fixture) => SETTLED.has(fixture.status))) {
        return false;
      }
    }
    return true;
  }
  return fixtures.every((fixture) => SETTLED.has(fixture.status));
}

// knockout / stepladder: the final is decided. double_elim: the grand final
// (the last `isFinal` game — a bracket reset adds a second) is decided.
export function isBracketStageComplete(
  _stage: BracketStage,
  fixtures: readonly BracketFixture[],
): boolean {
  const finals = fixtures.filter((fixture) => fixture.isFinal === true);
  if (finals.length === 0) return false;
  return finals.every((fixture) => SETTLED.has(fixture.status));
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

export function openStage(stageId: string): DivisionEvent[] {
  return [{ type: "stage_opened", stageId }];
}

// ---------------------------------------------------------------------------
// Completing a table stage → per-pool ranked tables + division events
// ---------------------------------------------------------------------------

function poolNames(fixtures: readonly TableFixture[]): string[] {
  const names = new Set<string>();
  for (const fixture of fixtures) names.add(poolOf(fixture));
  if (names.size === 0) names.add("");
  return [...names];
}

// Which entrants belong to a pool: those appearing in the pool's fixtures. For
// a single-pool (league) stage every entrant is in the one pool.
function entrantsOfPool(
  pool: string,
  fixtures: readonly TableFixture[],
  allEntrants: readonly EntrantId[],
  single: boolean,
): EntrantId[] {
  if (single) return [...allEntrants];
  const ids = new Set<EntrantId>();
  for (const fixture of fixtures) {
    if (poolOf(fixture) !== pool) continue;
    if (fixture.result !== undefined) {
      ids.add(fixture.result[0].entrantId);
      ids.add(fixture.result[1].entrantId);
    }
    if (fixture.awardDelta !== undefined) ids.add(fixture.awardDelta.entrantId);
  }
  // Membership = every entrant on a fixture of this pool carrying a result or
  // an awardDelta, whatever that fixture's status (a voided fixture that kept
  // its outcome still counts). A declared entrant with neither is not a member
  // here; filtering allEntrants only restores the declared order.
  return allEntrants.filter((id) => ids.has(id));
}

export interface CompletedTableStage {
  events: DivisionEvent[];
  tables: StageTables;
  /** W2d (spec §5.8): the lots drawn now, each tagged with its pool, for the caller to store. */
  newLotsDraws: ReadonlyArray<NewLotsDraw & { readonly pool: string }>;
}

// Fold + rank each pool of a completed table stage. Emits stage_completed
// {finalRanks}, plus rank_lock_required for any tie the cascade left to a
// drawing of lots (spec 05 §3/§4.4), and rank_lock for one whose draw is stored
// (W2d §5.8). A pool with no counted fixture is an empty table: no lots, every
// row level. finalRanks interleaves pools by rank (all pool winners, then all
// runners-up, …) — the cross-pool seeding order (spec 05 §2.3).
export function completeTableStage(
  stage: TableStage,
  fixtures: readonly TableFixture[],
): CompletedTableStage {
  const pools = poolNames(fixtures);
  const single = pools.length === 1;
  const events: DivisionEvent[] = [];
  const poolTables: PoolTable[] = [];
  const newLotsDraws: (NewLotsDraw & { readonly pool: string })[] = [];

  for (const pool of pools) {
    const poolFixtures = single ? fixtures : fixtures.filter((fixture) => poolOf(fixture) === pool);
    const entrants = entrantsOfPool(pool, fixtures, stage.entrants, single);
    const results = poolFixtures
      .filter((fixture) => COUNTS_FOR_STANDINGS.has(fixture.status) && fixture.result !== undefined)
      .map((fixture) => fixture.result as FixtureResult);
    const awardDeltas = poolFixtures
      .filter((fixture) => COUNTS_FOR_STANDINGS.has(fixture.status) && fixture.awardDelta !== undefined)
      .map((fixture) => fixture.awardDelta as StandingsDelta);

    const entrantSet = new Set(entrants);
    const openings = (stage.openingDeltas ?? []).filter((d) => entrantSet.has(d.entrantId));
    const rows =
      openings.length > 0 || awardDeltas.length > 0
        ? foldStandings(entrants, [...openings, ...results.flat(), ...awardDeltas])
        : foldResults(entrants, results);
    // W2d §5.8 step 1: the pool's table is empty when nothing in it counts — no
    // counted result, no sit-out award, and no carried opening that holds
    // something (an opening is the fold of counted fixtures in its source stage;
    // one with nothing played and no points carries no table — a points-mode
    // carry plays 0 by construction, so its points are what it carries).
    const carried = openings.filter((d) => d.played > 0 || d.points !== 0);
    const countedFixtures = results.length + awardDeltas.length + carried.length;
    const poolDraws = stage.lotsDraws?.get(pool);
    const ranked = rankStandings(rows, {
      cascade: stage.rules.tiebreakers,
      results,
      countedFixtures,
      ...(stage.winsCount === undefined ? {} : { winsCount: stage.winsCount }),
      ...(stage.gamePoints === undefined ? {} : { gamePoints: stage.gamePoints }),
      ...(poolDraws === undefined ? {} : { lotsDraws: poolDraws }),
      ...(stage.seeds === undefined ? {} : { seeds: stage.seeds }),
      ...(stage.rngSeed === undefined ? {} : { rngSeed: stage.rngSeed }),
      ...(stage.h2hScope === undefined ? {} : { h2hScope: stage.h2hScope }),
      ...(stage.swiss === true ? { swiss: buildSwissTable(entrants, results, awardDeltas) } : {}),
      // ST-G12 reads a round robin's schedule; a Swiss stage pairs round by round and has none (Swiss stays W3, D7 —
      // and production's one competition, a Swiss one, does not move, B1).
      ...(stage.scheduledPairs === undefined || stage.kind === "swiss" ? {} : { scheduledPairs: stage.scheduledPairs }),
      ...(stage.partialScheduleOrder === undefined ? {} : { partialScheduleOrder: stage.partialScheduleOrder }),
    });
    // Manual override wins — it is the final structural word (Jul3/05 §8).
    if (stage.rankLocks !== undefined && stage.rankLocks.length > 0) {
      const poolLocks = stage.rankLocks.filter((l) => entrantSet.has(l.entrantId));
      if (poolLocks.length > 0) ranked.rows = applyRankLocks(ranked.rows, poolLocks);
    }

    for (const group of ranked.lotsGroups) {
      events.push({ type: "rank_lock_required", stageId: stage.id, group });
      // The lock carries the stored draw's order and date (PS-5b): the engine
      // has no clock, so a draw made just now waits for its stored row.
      const drawn = poolDraws?.get(membersKeyOf(group));
      if (drawn !== undefined) {
        events.push({ type: "rank_lock", stageId: stage.id, method: "lots", group, order: [...drawn.order], drawnAt: drawn.drawnAt });
      }
    }
    for (const draw of ranked.newLotsDraws) newLotsDraws.push({ pool, ...draw });
    poolTables.push({ pool, rows: ranked.rows, results });
  }

  const finalRanks = crossPoolOrder(poolTables);
  events.push({ type: "stage_completed", stageId: stage.id, finalRanks });

  const overall = single ? (poolTables[0] as PoolTable).rows : undefined;
  return {
    events,
    tables: { pools: poolTables, ...(overall === undefined ? {} : { overall }) },
    newLotsDraws,
  };
}

// Interleave pools by rank: rank-1 of every pool (in pool order), then rank-2,
// … — the group→knockout seeding template (spec 05 §2.3).
function crossPoolOrder(pools: readonly PoolTable[]): EntrantId[] {
  const maxRank = Math.max(0, ...pools.map((pool) => pool.rows.length));
  const order: EntrantId[] = [];
  for (let rank = 1; rank <= maxRank; rank++) {
    for (const pool of pools) {
      const row = pool.rows.find((entry) => entry.rank === rank);
      if (row !== undefined) order.push(row.entrantId);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// Completing a bracket stage → final ranks from bracket position
// ---------------------------------------------------------------------------

export interface CompletedBracketStage {
  events: DivisionEvent[];
  finalRanks: EntrantId[];
}

export function completeBracketStage(
  stage: BracketStage,
  fixtures: readonly BracketFixture[],
): CompletedBracketStage {
  const finalRanks = bracketRanks(stage, fixtures);
  return {
    events: [{ type: "stage_completed", stageId: stage.id, finalRanks }],
    finalRanks,
  };
}

// The entrants a `walkedOver` fixture puts out. Assumptions are guards: a double walkover decided nobody, so a row that
// names a winner or a loser is a wiring bug; a forfeit always names who forfeited.
function walkedOverSides(fixture: BracketFixture): EntrantId[] {
  if (fixture.walkedOver === "both") {
    if (fixture.winner !== undefined || fixture.loser !== undefined) {
      throw new Error(`bracket fixture ${fixture.id}: a double walkover (walkedOver "both") names a winner or a loser`);
    }
    // Both sides were absent, so both were seated: a "both" row with an empty seat is a wiring bug too.
    if (fixture.home === undefined || fixture.away === undefined) {
      throw new Error(`bracket fixture ${fixture.id}: a double walkover (walkedOver "both") is missing a side`);
    }
    return [fixture.home, fixture.away];
  }
  if (fixture.loser === undefined) {
    throw new Error(`bracket fixture ${fixture.id}: a forfeit (walkedOver "loser") names no loser`);
  }
  return [fixture.loser];
}

// Rank entrants by bracket position (spec 05 §1 "ranking" column). Champion =
// winner of the last `isFinal` game; runner-up = its loser; everyone else is
// ordered by how late they were eliminated (later round = better), then by
// seed. An optional 3rd-place playoff fixes ranks 3 and 4 from its result.
export function bracketRanks(
  stage: BracketStage,
  fixtures: readonly BracketFixture[],
): EntrantId[] {
  const entrants = new Set<EntrantId>();
  for (const fixture of fixtures) {
    for (const id of [fixture.home, fixture.away, fixture.winner, fixture.loser]) {
      if (id !== undefined) entrants.add(id);
    }
  }

  // The deciding game: the latest-round settled final that produced a winner.
  // A voided final (DE bracket reset skipped because the WB champion won GF1,
  // spec 05 §2.4) is settled for completion but decides nothing — without the
  // winner filter it would shadow GF1 and leave the champion undefined.
  const decidedFinals = fixtures
    .filter(
      (fixture) =>
        fixture.isFinal === true && SETTLED.has(fixture.status) && fixture.winner !== undefined,
    )
    .sort((a, b) => b.round - a.round);
  const grandFinal = decidedFinals[0];

  const lastLossRound = new Map<EntrantId, number>();
  for (const fixture of fixtures) {
    if (!SETTLED.has(fixture.status) || fixture.loser === undefined) continue;
    const prev = lastLossRound.get(fixture.loser) ?? -1;
    if (fixture.round > prev) lastLossRound.set(fixture.loser, fixture.round);
  }
  // W2b (X-DE-1, X-DW-2): a forfeit loser and both sides of a double walkover are OUT at that fixture — seating never
  // drops them — so their elimination round is pinned there, the earliest such fixture, and a later loss a stale row
  // still names cannot move it. Every other entrant is eliminated at its LAST loss (a double-elim drop is not out).
  const outAt = new Map<EntrantId, number>();
  for (const fixture of fixtures) {
    if (!SETTLED.has(fixture.status) || fixture.walkedOver === undefined) continue;
    const out = walkedOverSides(fixture);
    for (const id of out) {
      const prev = outAt.get(id);
      if (prev === undefined || fixture.round < prev) outAt.set(id, fixture.round);
    }
  }
  const eliminatedIn = (id: EntrantId): number => outAt.get(id) ?? lastLossRound.get(id) ?? -1;

  const seedOf = (id: EntrantId): number => stage.seeds?.get(id) ?? Number.MAX_SAFE_INTEGER;
  const rankRest = (ids: EntrantId[]): EntrantId[] =>
    ids.sort((a, b) => {
      const ra = eliminatedIn(a);
      const rb = eliminatedIn(b);
      if (ra !== rb) return rb - ra; // eliminated later ⇒ ranked higher
      const sa = seedOf(a);
      const sb = seedOf(b);
      if (sa !== sb) return sa - sb;
      return a < b ? -1 : a > b ? 1 : 0;
    });

  const order: EntrantId[] = [];
  const placed = new Set<EntrantId>();
  const place = (id: EntrantId | undefined): void => {
    if (id === undefined || placed.has(id)) return;
    order.push(id);
    placed.add(id);
  };

  if (grandFinal !== undefined) {
    place(grandFinal.winner);
    place(grandFinal.loser);
  }

  // 3rd-place playoff overrides the semifinal-loser ordering for ranks 3–4.
  const thirdPlace = fixtures.find(
    (fixture) => fixture.thirdPlace === true && SETTLED.has(fixture.status),
  );
  if (thirdPlace !== undefined) {
    place(thirdPlace.winner);
    place(thirdPlace.loser);
  }

  for (const id of rankRest([...entrants].filter((id) => !placed.has(id)))) place(id);
  return order;
}

// ---------------------------------------------------------------------------
// Withdrawal policies — spec 05 §5
// ---------------------------------------------------------------------------

export interface WithdrawalResult {
  events: DivisionEvent[];
  updates: FixtureUpdate[];
}

function involvesEntrant(fixture: TableFixture, entrantId: EntrantId): boolean {
  return (
    fixture.result?.[0].entrantId === entrantId || fixture.result?.[1].entrantId === entrantId
  );
}

// Which table kinds may EXPUNGE an early withdrawal. One row per kind, so a
// new table kind has to declare its rule rather than inherit one.
//
// Swiss never does (owner ruling 2026-09-24, "case 2", option A). Expunging a
// Swiss board abandons it with no outcome, and the round can then neither be
// paired past (an abandoned board is not decided), unpaired (it has a played
// result) nor forfeited (the match is over) — the division is stranded. A
// Swiss withdrawal keeps every played result, earlier walkovers included, and
// walks each paired board over to the opponent; unseated later rounds simply
// pair without them. The same verdict feeds the qualification builder
// (apps/web lib/table-withdrawal + qualification-view), so it lives here once.
const EXPUNGES_EARLY_WITHDRAWAL: Readonly<Record<TableStage["kind"], boolean>> = {
  league: true,
  group: true,
  swiss: false,
};

// spec 05 §5 — league/group `void_remaining`: if the withdrawing entrant has
// played < 50% of its fixtures, EXPUNGE (void all its games so the standings
// read as if it never entered); otherwise AWARD its remaining fixtures to the
// opponents as forfeits and keep the games already played. `played`/`total`
// are the entrant's decided vs scheduled fixture counts (the caller knows the
// full schedule, including result-less pending fixtures). Swiss always
// AWARDS — see EXPUNGES_EARLY_WITHDRAWAL.
export function withdrawTableEntrant(
  stage: Pick<TableStage, "id" | "kind">,
  entrantId: EntrantId,
  fixtures: {
    played: readonly TableFixture[]; // decided games this entrant appears in
    pending: readonly { id: string; opponent: EntrantId }[]; // its unplayed games
  },
): WithdrawalResult {
  const playedCount = fixtures.played.filter((fixture) => involvesEntrant(fixture, entrantId)).length;
  const total = playedCount + fixtures.pending.length;
  const fraction = total === 0 ? 0 : playedCount / total;
  const expunge = EXPUNGES_EARLY_WITHDRAWAL[stage.kind] && fraction < 0.5;

  const updates: FixtureUpdate[] = [];
  if (expunge) {
    for (const fixture of fixtures.played) {
      if (involvesEntrant(fixture, entrantId)) updates.push({ fixtureId: fixture.id, status: "void" });
    }
    for (const pending of fixtures.pending) updates.push({ fixtureId: pending.id, status: "void" });
  } else {
    for (const pending of fixtures.pending) {
      updates.push({ fixtureId: pending.id, status: "walkover", walkoverTo: pending.opponent });
    }
  }

  return {
    events: [
      {
        type: "entrant_withdrawn",
        stageId: stage.id,
        entrantId,
        policy: "void_remaining",
        mode: expunge ? "expunge" : "award",
      },
    ],
    updates,
  };
}

// spec 05 §5 — knockout `bracket_walkover`: the withdrawing entrant's remaining
// fixtures are walked over to the opponent, who advances.
export function withdrawBracketEntrant(
  stage: BracketStage,
  entrantId: EntrantId,
  fixtures: readonly BracketFixture[],
): WithdrawalResult {
  const updates: FixtureUpdate[] = [];
  for (const fixture of fixtures) {
    if (SETTLED.has(fixture.status)) continue;
    if (fixture.home !== entrantId && fixture.away !== entrantId) continue;
    const opponent = fixture.home === entrantId ? fixture.away : fixture.home;
    updates.push({
      fixtureId: fixture.id,
      status: "walkover",
      ...(opponent === undefined ? {} : { walkoverTo: opponent }),
    });
  }
  return {
    events: [{ type: "entrant_withdrawn", stageId: stage.id, entrantId, policy: "bracket_walkover" }],
    updates,
  };
}
