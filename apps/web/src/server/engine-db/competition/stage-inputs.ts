import "server-only";
// ONE bye predicate, client-safe so `lib/swiss-shell.ts` can share it. This
// used to be a private copy here; the 2026-09-20 review found the Swiss copy
// had drifted into calling any award outcome a bye, which let Unpair destroy
// real two-sided forfeits. See that module's header.
import { byeAward, isOneSidedAwardBye } from "@/lib/fixture-bye";
// DB fixtures.status → engine FixtureStatus (spec 05 §1 vocabulary). ONE
// mapping, shared with the qualification builder and the bracket rebuild in
// usecases/stages/; the local name is kept so the call sites read as before.
import { log } from "@/server/logger";
import { completionEngineStatus, hasActiveAbandonSql } from "../recorded-abandon";
import { inTheField } from "@/lib/entrant-field";
import {
  POINTS_ADJUSTMENT_ROW,
  POINTS_ADJUSTMENT_VOIDED_ROW,
  activePointsAdjustments,
  type AdjustmentLedgerRow,
} from "@/lib/points-adjustment-note";
import { EngineError, type MatchOutcome, type StageCtx, type StandingsDelta } from "@seazn/engine/core";
import {
  decidedInFor,
  payout,
  setsToWinOf,
  swissDrawFactsOf,
  unplayedSidesOf,
  type FixtureResult,
  type MembersKey,
  type PointsAdjustment,
  type PointsRule,
  type StoredLotsDraw,
  type TableFixture,
  type TableStage,
} from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { resolveModule } from "../registry";
import { liveCfg, resolveFixtureCfg } from "../fixture-cfg";
import { forfeitPlayedFacts, playedFor } from "../forfeit-played";
import { tableRulesOf } from "../table-rules";
import { swissAbsentRounds } from "../swiss-absent-rounds";
import { locksThatFit } from "@/lib/rank-override";
import { stageSeatingOf } from "../stage-seating";
import { cascadeWhileNothingPlayed } from "../adjusted-empty-table";
import type { StageInputs, Tx, StageRow, DivisionRow, FixtureRow } from "./types";
import { parseStageKind } from "./kinds";

/** Phantom seat for `SportModule.init` when synthesising a one-sided award
 *  bye delta — never written to the DB, never appears in the folded table
 *  (only the winner's half of the pair is kept as `awardDelta`). */
const BYE_PHANTOM = "__bye__";

/**
 * One-sided award bye → a single win delta via the sport module's own
 * `standingsDelta` (clean-sweep / points.w), not a hand-typed constant. A
 * phantom opponent lets `init` build a legal state; only the winner's half
 * is returned for the fold. W2d T9: paid by the stage's table rule (`payout`),
 * as every decided fixture is — there is no "no rule" any more (the rule is the
 * pin, the stage's own, or its sport's).
 */
function awardByeDelta(
  sportModule: AnySportModule,
  outcome: MatchOutcome,
  rawCfg: unknown,
  ctx: StageCtx,
  pointsRule: PointsRule,
  homeId: string | null,
): StandingsDelta {
  const winnerId = (outcome as Extract<MatchOutcome, { kind: "award" }>).winner;
  // W2b C-5: the module is handed the TYPED bye (`reason: "bye"`, no loser), whatever the stored row carries — a bye
  // written before W2b is `{kind: "award", winner}` alone — so a bye is credited exactly today's bye delta and never
  // a walkover's goals or sets (forfeitCredit's "bye" case).
  const bye = byeAward(winnerId) as MatchOutcome;
  const cfg = sportModule.configSchema.parse(rawCfg);
  const seatedHome = homeId === winnerId;
  const state = sportModule.init(cfg, {
    home: { entrantId: seatedHome ? winnerId : BYE_PHANTOM, slots: [] },
    away: { entrantId: seatedHome ? BYE_PHANTOM : winnerId, slots: [] },
  });
  // `standingsDelta` returns a mutable pair, `payout` a readonly
  // `FixtureResult` — so this is a new local, not a reassignment (TS4104).
  const rawPair = sportModule.standingsDelta(bye, cfg, ctx, state);
  // W2c X-PT-1: a bye is told apart by its reason (`isBye`), never by `played` — and it has no ledger: nothing played.
  const pair: FixtureResult = payout(
    bye,
    decidedInFor(sportModule, bye),
    rawPair,
    false,
    pointsRule,
    sportModule.awardScoreKeys,
    setsToWinOf(sportModule, cfg),
  );
  const winner = pair[0].entrantId === winnerId ? pair[0] : pair[1];
  if (winner.entrantId !== winnerId) {
    throw new EngineError("CONFIG_INVALID", "award bye standings delta missing winner", {
      winnerId,
      home: pair[0].entrantId,
      away: pair[1].entrantId,
    });
  }
  return winner;
}

/** W5 app PR B Task 7 (C8; engine `adjustment_unseated`, `adjustment_unknown_entrant`): the adjustments the fold is handed - each
 *  one whose entrant is a member of the stage's table: SEATED in a pool when the stage is seated, else declared (holds a seat on
 *  one of its lines). Any other is HELD: still listed (the history, the desk's list), never passed, because the engine refuses
 *  the WHOLE fold for one such row - and one stale row must never block every score write of the stage. A held row comes back
 *  the moment its entrant is a member again. */
export function foldedAdjustments(
  inputs: Pick<StageInputs, "adjustments" | "entrants" | "seating">,
): PointsAdjustment[] {
  const seated = inputs.seating.kind === "seated" ? inputs.seating.pools : undefined;
  const declared = new Set(inputs.entrants);
  return inputs.adjustments
    .filter((a) => (seated === undefined ? declared.has(a.entrant_id) : seated.has(a.entrant_id)))
    .map((a) => ({ entrantId: a.entrant_id, delta: a.delta, reason: a.reason, at: a.at }));
}

// Load a stage's fixtures and turn each decided fixture into a StandingsDelta
// pair via the pinned sport module (spec 03 §4.3). Shared by recompute +
// complete so deltas are computed once per pass.
export async function loadStageInputs(tx: Tx, stageId: string): Promise<StageInputs> {
  const [stage] = await tx<StageRow[]>`
    select id, division_id, kind, config, status, table_rules_pinned,
           to_json(table_rules_pinned_at) #>> '{}' as table_rules_pinned_at
    from stages where id = ${stageId}
  `;
  if (!stage) throw new EngineError("STAGE_NOT_READY", `stage ${stageId} not found`, { stageId });

  const [division] = await tx<DivisionRow[]>`
    select config, sport_key, module_version, tiebreakers, seq
    from divisions where id = ${stage.division_id}
  `;
  if (!division) throw new EngineError("CONFIG_INVALID", "division not found", { stageId });

  // W5 app PR B Task 7: the stage's points adjustments - the division's adjustment rows and their voids, folded to the active ones.
  const adjustmentRows = await tx<AdjustmentLedgerRow[]>`
    select seq::int as seq, type, payload, to_json(created_at) #>> '{}' as at from division_events
     where division_id = ${stage.division_id} and type in (${POINTS_ADJUSTMENT_ROW}, ${POINTS_ADJUSTMENT_VOIDED_ROW})`;
  const adjustments = activePointsAdjustments(adjustmentRows).filter((a) => a.stage_id === stageId);

  const sportModule = resolveModule(division.sport_key, division.module_version);
  const kind = parseStageKind(stage.kind, stageId);
  const ctxBase: StageCtx = { kind };

  const fixtures = await tx<FixtureRow[]>`
    select f.id, f.status, f.round_no, f.pool_id, f.home_entrant_id, f.away_entrant_id,
           f.outcome, f.config_snapshot, f.rules_override, f.ext_key, m.state, f.joint_winners_at,
           f.winner_to_fixture, f.winner_to_slot, f.loser_to_fixture, f.loser_to_slot, f.seq_in_round,
           ${hasActiveAbandonSql(tx)} as has_active_abandon,
           ${hasActiveAbandonSql(tx, "f", { expunge: true })} as expunged,
           ${hasActiveAbandonSql(tx, "f", { noResult: true })} as no_result
    from fixtures f left join match_states m on m.fixture_id = f.id
    where f.stage_id = ${stageId}
    order by f.round_no, f.seq_in_round
  `;
  // NOT snapshotted, and that is not an oversight. `stage.config.points`
  // (Jul3/05 §2) is a competition-level re-derivation applied on top of the
  // sport ledger, so it is not part of the resolved cfg `stageScopedCfg`
  // produces and no fixture froze it. Its walkover award IS a fold input since
  // W2c Task 16b: `stageForfeitAward` reads `forfeit.awardScore` off the stage
  // and every server-side read and write fold offers it
  // (`FoldOptions.forfeitAward`), except the append-event `before` folds, the
  // event-import dry run and the pad's client fold, for the sports whose table
  // it reaches. That is safe for the reason below, not because the rule stays
  // out of the fold: the stage lock means no fixture of the stage holds a
  // ledger when the award can still change, so no two folds that offer it ever
  // read two different awards of one ledger. Since W2c Task 13 the rule
  // IS editable after fixtures exist — `PUT /stages/{id}/rules`' points arm
  // — but only until the stage STARTS: the first frozen config snapshot or
  // score event in that stage locks it (STAGE_FORMAT_LOCKED, the monotonic
  // `lockedStageIdsAmong` pair, never `fixtures.status`). Until then no result
  // in the stage exists to have been ranked under the old rule, and a save that
  // moves the rule re-folds a table already cached for the stage (a Swiss bye,
  // an event-less walkover — `putStageRules` calls `recomputeStandings`). Let a
  // points save through after the stage starts, or drop that re-fold, and
  // this line becomes the same defect again: a table ranked under two rules.
  //
  // Per-stage match rules (design 2026-09-17 §T1) widened what the resolved
  // cfg can contain: `stageScopedCfg` now also overlays `stage.config.rules`
  // per key, so it is no longer "division config plus shootout/extraTime".
  // Two things keep the paragraph above true. This line reads the TOP-LEVEL
  // `stage.config.points`, which the overlay still never touches; and a
  // `rules.points` — which the overlay WOULD copy through — is barred at the
  // write paths by the per-sport allowlist and the sets-sports-only gate
  // (design D2/D2a): the stage PUT and, since W2c Task 12, `createStages` /
  // `replaceStages` / template instantiation, which take `config.rules` on the
  // PUT's own terms (`validatedStageConfig`). `rules` is also a fifth key editable after fixtures exist,
  // under its own per-stage lock (D1), so "locked the moment fixtures exist"
  // now describes the format keys rather than the whole column. Let `points`
  // into `rules`, or drop D1's lock, and this line is the same defect again.
  // W2d T9 (X-TB-1, X-TB-2): the stage's table rules — its pin once active (an active or complete stage with none is the
  // loader's typed CONFIG_INVALID, never a live read), else its own ?? division ?? sport under the merged cfg. The rule
  // ALWAYS pays: since W2d every stage has one (the pin, its own, or its sport's `tablePointsRule`), so the sport's
  // `standingsDelta` points never reach the table unpaid.
  const rules = tableRulesOf(
    {
      stageId,
      kind: stage.kind,
      status: stage.status,
      stageConfig: stage.config as Record<string, unknown> | null,
      pin: stage.table_rules_pinned,
      pinnedAt: stage.table_rules_pinned_at,
      divisionConfig: division.config,
      divisionTiebreakers: division.tiebreakers,
    },
    sportModule,
  );
  // W2c Task 9 (X-PT-1): each forfeit-shaped result's "was anything played" fact, from its own ledger — one read for the
  // stage, and none without a forfeit (`forfeitPlayedFacts`'s empty case).
  const playedFacts = await forfeitPlayedFacts(
    tx,
    fixtures.filter((f) => f.outcome && f.state && f.home_entrant_id && f.away_entrant_id),
    sportModule,
  );
  const gamePoints = new Map<FixtureResult, readonly [number, number]>();

  const tableFixtures: TableFixture[] = fixtures.map((f) => {
    const base: TableFixture = {
      id: f.id,
      // X-AB-5: a TABLE stage's recorded abandon that decided nobody is held for the settle, not the generator's void
      // (a withdrawal's expunge stays void: it left the table). The same predicate as a bracket's (D-G1).
      status: completionEngineStatus(kind, f),
      ...(f.pool_id ? { poolId: f.pool_id } : {}),
      roundNo: f.round_no,
    };
    // Only decided fixtures with a folded state contribute a delta pair.
    if (f.outcome && f.state && f.home_entrant_id && f.away_entrant_id) {
      const ctx: StageCtx = { ...ctxBase, roundNo: f.round_no, ...(f.pool_id ? { poolId: f.pool_id } : {}) };
      // V347 — PER FIXTURE, not once for the stage. Standings are a SECOND
      // derivation of the same fixture, and `standingsDelta` reads cfg directly
      // (`generic` returns `cfg.points.w` for a win). Passing live
      // `division.config` here meant lowering `points.w` after matches were
      // played still rewrote the table for them, which is the first bullet of
      // the defect V347 exists to close and what
      // `content/help/divisions/settings.md` promises organisers is gone. Same
      // resolver as both folds, so a fixture's table contribution and its state
      // can never be computed under two different configs; a fixture with no
      // snapshot (never scored) still reads live cfg, deliberately.
      const fixtureCfg = resolveFixtureCfg(
        f,
        division.config,
        { kind: stage.kind, config: stage.config as Record<string, unknown> | null },
        sportModule,
      );
      const pair = sportModule.standingsDelta(f.outcome as MatchOutcome, fixtureCfg, ctx, f.state);
      // The table rule (W2d T9: always one) re-derives competition points. W2c X-PT-1: a forfeit with nothing played
      // pays the rule's forfeit row, and its awarded score replaces the credit — on the generic keys and on the sport's
      // own score keys (gap a, `awardScoreKeys`: football's gf/ga/gd); the rest of the ledger stands.
      base.result = payout(
        f.outcome as MatchOutcome,
        decidedInFor(sportModule, f.outcome as MatchOutcome),
        pair,
        playedFor(f, playedFacts),
        // the stage's ONE rule for every fixture (ruling 12: never per-fixture points) — its pin once started, so a
        // division edit after a match was played never moves the table under it (V347's promise, kept by the pin)
        rules.points,
        sportModule.awardScoreKeys,
        // I2: a set match settled before its end is scored to the sets this fixture's own format is won on
        setsToWinOf(sportModule, fixtureCfg),
      );
      gamePoints.set(base.result, [pair[0].points, pair[1].points]);
      // W3 T8 (X-SW-7; FIDE C.07 (2026) 16.2.2 / 16.2.4): the side(s) of this result that lost WITHOUT playing - a forfeit with
      // nothing played, a double walkover - from the one authority (`unplayedSidesOf`) over the one reader of "was anything
      // played" (`playedFor`, the same fact `payout` was just handed). `null` is a game played, and the engine REFUSES a
      // Swiss stage's counted result that leaves it out (final review m3). Asked of a Swiss stage alone: only its ledger reads
      // the field, and the helper refuses a malformed forfeit (CONFIG_INVALID), which no league table should now start doing.
      if (kind === "swiss") base.unplayed = unplayedSidesOf(f.outcome as MatchOutcome, playedFor(f, playedFacts), base.result);
    } else if (isOneSidedAwardBye(f)) {
      // Swiss odd-field sit-out (and KO seeded bye): forfeited award with one
      // seat null and no match_state. The two-sided gate above never fires, so
      // without this branch the bye winner stayed P0/pts=0 on the table while
      // swissGen still counted +1 for pairing — Gus on the demo Swiss 7.
      const ctx: StageCtx = { ...ctxBase, roundNo: f.round_no, ...(f.pool_id ? { poolId: f.pool_id } : {}) };
      const byeCfg = resolveFixtureCfg(
        f,
        division.config,
        { kind: stage.kind, config: stage.config as Record<string, unknown> | null },
        sportModule,
      );
      base.awardDelta = awardByeDelta(
        sportModule,
        f.outcome as MatchOutcome,
        byeCfg,
        ctx,
        rules.points,
        f.home_entrant_id,
      );
    }
    return base;
  });

  const entrantSet = new Set<string>();
  for (const f of fixtures) {
    if (f.home_entrant_id) entrantSet.add(f.home_entrant_id);
    if (f.away_entrant_id) entrantSet.add(f.away_entrant_id);
  }
  const entrants = [...entrantSet];
  // X-PO-1: every seat on a stored line, the same rows `entrants` reads (so every seated entrant is a declared one).
  const seating = stageSeatingOf(stage.kind, fixtures);
  if (seating.kind === "held") {
    // C11: never a 422 on a score write for a draw the app stored; named, so a census of the log finds the stage.
    log.warn({ event: "pool_seating_held", stageId, reason: seating.reason, entrantId: seating.entrantId, pool: seating.pool }, "pooled stage folds without its seating");
  }

  const seeds = new Map<string, number>();
  const field = new Set<string>();
  if (entrants.length > 0) {
    const seedRows = await tx<{ id: string; seed: number | null; status: string }[]>`
      select id, seed, status from entrants where id in ${tx(entrants)}
    `;
    for (const r of seedRows) {
      if (r.seed != null) seeds.set(r.id, r.seed);
      if (inTheField(r)) field.add(r.id);
    }
  }

  return {
    stage,
    kind,
    division,
    module: sportModule,
    rules,
    gamePoints,
    // No stage-wide `cfg` field: there is no such thing any more. Each fixture
    // resolves its own above, and a single shared one is exactly how live
    // config leaked back into decided fixtures.
    fixtures,
    tableFixtures,
    entrants,
    seeds,
    field,
    // W3 T8 (X-SW-8): keyed by the table's entrants (`entrants`: every entrant holding a seat), never by the roster - a
    // case-(c) latecomer with no seat yet is not on the table and the engine refuses a key that is not.
    swissAbsentRounds: kind === "swiss" ? swissAbsentRounds(fixtures, entrants) : new Map(),
    seating,
    adjustments,
  };
}

/** B5: a result's GAME points, read from the map `loadStageInputs` filled as it paid each result (identity-keyed: the
 *  engine hands back the very `FixtureResult` objects the stage gave it). A result the map does not hold is a result this
 *  stage never paid — a defect, never a fallback: game points silently equal to the paid points would rank `direct` and
 *  `sberger` by the wrong numbers (fix round 1, m2). */
export function gamePointsReader(
  gamePoints: ReadonlyMap<FixtureResult, readonly [number, number]>,
): (result: FixtureResult) => readonly [number, number] {
  return (result) => {
    const pair = gamePoints.get(result);
    if (pair === undefined) {
      throw new Error(`game points asked for a result this stage did not pay (${result[0].entrantId} v ${result[1].entrantId})`);
    }
    return pair;
  };
}

/** W2d T12 (spec §5.6 "ST-G12", X-TB-8): every fixture the stage schedules between two seated entrants, decided or not,
 *  as [home, away] — one entry per fixture, so a double round robin lists a pair twice. The head-to-head steps read it to
 *  know whether a tied class has played out its meetings. A fixture whose engine status is `void` will never be played (a
 *  withdrawal's expunge, a voided match), and a seat still to be filled names nobody, so neither is on it. Read off the
 *  same rows and statuses as the counted results (only `decided` / `walkover` count, never `void`), so every counted
 *  result is on it — the engine refuses one that is not. */
export function scheduledPairsOf(
  fixtures: readonly Pick<FixtureRow, "id" | "home_entrant_id" | "away_entrant_id">[],
  tableFixtures: readonly Pick<TableFixture, "id" | "status">[],
): [string, string][] {
  const statusOf = new Map(tableFixtures.map((f) => [f.id, f.status]));
  const pairs: [string, string][] = [];
  for (const f of fixtures) {
    const status = statusOf.get(f.id);
    if (status === undefined) throw new Error(`fixture ${f.id} has no engine status: the schedule and the table read different fixtures`);
    if (status === "void" || !f.home_entrant_id || !f.away_entrant_id) continue;
    pairs.push([f.home_entrant_id, f.away_entrant_id]);
  }
  return pairs;
}

// W2d T9: the stage as the ranker reads it — its rules (pin or live, `tableRulesOf`), the sport's `winsCount` (B2,
// HK-TB-1) and each result's game points (B5), and the lots draws stored for it (§5.8; read under the division lock,
// `rankWithStoredLots`). A bracket or ladder stage still reaches this fold (an admin cfg edit or a rules refold
// recomputes its snapshot) and ranks by the order its rules give a league (`tableStageKindOf`).
export function toTableStage(
  inputs: StageInputs,
  lotsDraws: ReadonlyMap<string, ReadonlyMap<MembersKey, StoredLotsDraw>>,
): TableStage {
  const gamePoints = inputs.gamePoints;
  // W5 app PR B Task 1 (X-PO-1, ruling 279): a seated group's pools ride the fold - every fold of the stage goes through here
  // (the snapshot, completion, best-Nth's source, the Swiss score groups' points), so all of them rank the same members.
  const seating = inputs.seating.kind === "seated" ? inputs.seating.pools : undefined;
  // W5 app PR B Task 7 (X-ADJ-1; C8): the adjustments the fold can hold, beside carry-over's `openingDeltas` (never through it:
  // an opening has no reason and no footnote).
  const adjustments = foldedAdjustments(inputs);
  const fields = {
    id: inputs.stage.id,
    // americano rides the league fold (Jul3/08 §3)
    kind: (inputs.stage.kind === "americano" ? "league" : inputs.stage.kind) as TableStage["kind"],
    entrants: inputs.entrants,
    // B3 ruling 2: no lot while the table's only content is adjustments (`cascadeWhileNothingPlayed`).
    rules: { points: inputs.rules.points, tiebreakers: cascadeWhileNothingPlayed(inputs.rules.tiebreakers, { fixtures: inputs.tableFixtures, openings: Array.isArray(inputs.stage.config?.carry_deltas) ? (inputs.stage.config.carry_deltas as { played: number; points: number }[]) : [], adjustments: adjustments.length }), crossGroup: inputs.rules.crossGroup },
    ...(inputs.module.winsCount === undefined ? {} : { winsCount: inputs.module.winsCount }),
    gamePoints: gamePointsReader(gamePoints),
    lotsDraws,
    ...(inputs.seeds.size > 0 ? { seeds: inputs.seeds } : {}),
    ...(inputs.stage.config?.rngSeed != null ? { rngSeed: inputs.stage.config.rngSeed } : {}),
    ...(inputs.stage.config?.rounds != null ? { rounds: inputs.stage.config.rounds } : {}),
    // Jul3/05: carry-over openings, manual rank locks, circular-H2H mode
    ...(Array.isArray(inputs.stage.config?.carry_deltas)
      ? { openingDeltas: inputs.stage.config.carry_deltas as never }
      : {}),
    ...(Array.isArray(inputs.stage.config?.rank_overrides)
      ? {
          // W5 T13 fix round 1 (ST-G14): a pin waits until its pool holds enough results to place it (`locksThatFit`) - since
          // PR B Task 1 (C12), enough SEATS when the stage is seated.
          rankLocks: locksThatFit(
            (inputs.stage.config.rank_overrides as { entrant_id: string; rank: number }[]).map((o) => ({ entrantId: o.entrant_id, rank: o.rank })),
            inputs.tableFixtures,
            seating,
          ),
        }
      : {}),
    ...(inputs.stage.config?.h2h_scope === "overall" ? { h2hScope: "overall" as const } : {}),
    // W2d T12 (ST-G12, IH-TB-2): the schedule the head-to-head steps need complete, and the sport's order when it is not.
    scheduledPairs: scheduledPairsOf(inputs.fixtures, inputs.tableFixtures),
    ...(inputs.module.partialScheduleOrder === undefined ? {} : { partialScheduleOrder: inputs.module.partialScheduleOrder }),
    ...(seating === undefined ? {} : { pools: seating }),
    ...(adjustments.length === 0 ? {} : { adjustments }),
  };
  if (inputs.stage.kind !== "swiss") return fields;
  // W3 (ruling R4; X-SW-7; engine 2.0.0): a Swiss ledger stage names the sport's draw facts under the stage's merged cfg
  // (`swissDrawFactsOf`: whether a draw can stand in the stage, and the sets a match is won on). They turn the stage's
  // points rule into D, the draw points of FIDE C.07 art. 16's dummy cap and of an unplayed round, and the engine
  // refuses a Swiss stage that names none (CONFIG_INVALID) on its first ranking. The same live cfg the table rules
  // resolve under (`tableRulesOf`), so the facts and the rule they scale read one cfg. Two returns, not a spread: the
  // engine's `TableStage` is a union on `swiss`, and a conditional spread widens it to `true | undefined`.
  //
  // W3 T8 (X-SW-8; engine final review m3): the stage's declared absences ride the same arm, ALWAYS - an empty map says
  // "nobody missed a round", and the engine refuses a Swiss stage that says nothing (CONFIG_INVALID), so a producer
  // that omitted it for the common case would read every absence as "nobody was absent".
  return {
    ...fields,
    swiss: true,
    swissDraw: swissDrawFactsOf(
      inputs.module,
      liveCfg(inputs.division.config, { kind: inputs.stage.kind, config: inputs.stage.config as Record<string, unknown> | null }, inputs.module),
    ),
    swissAbsentRounds: inputs.swissAbsentRounds,
  };
}
