import "server-only";
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
// ONE bye predicate, client-safe so `lib/swiss-shell.ts` can share it. This
// used to be a private copy here; the 2026-09-20 review found the Swiss copy
// had drifted into calling any award outcome a bye, which let Unpair destroy
// real two-sided forfeits. See that module's header.
import { byeAward, isOneSidedAwardBye } from "@/lib/fixture-bye";
// DB fixtures.status → engine FixtureStatus (spec 05 §1 vocabulary). ONE
// mapping, shared with the qualification builder and the bracket rebuild in
// usecases/stages.ts; the local name is kept so the call sites read as before.
import { log } from "@/server/logger";
import { assertAdvancingSeat, assertNoLevelSeat, fedSeatOccupant } from "./level-seat";
import { fixtureBoardRef, isLegacyForfeitWin } from "./fed-seats";
import { completionEngineStatus, hasActiveAbandonSql, rowAwaitsSettle } from "./recorded-abandon";
import { ABANDONED_MATCHES_REASON } from "@/lib/abandoned-matches-refusal";
import { inTheField } from "@/lib/entrant-field";
import { EngineError, StageKind, type MatchOutcome, type StageCtx, type StandingsDelta } from "@seazn/engine/core";
import {
  PointsRule,
  SETTLED_FIXTURE_STATUSES,
  applyPointsRule,
  completeBracketStage,
  completeTableStage,
  isBracketStageComplete,
  isTableStageComplete,
  placementTable,
  type BracketFixture,
  type BracketStage,
  type DivisionEvent,
  type FixtureResult,
  type StandingsRow,
  type TableFixture,
  type TableStage,
} from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { resolveModule } from "./registry";
import { resolveFixtureCfg } from "./fixture-cfg";
import { forfeitPlayedFacts, playedFor } from "./forfeit-played";

type Tx = postgres.TransactionSql;

// americano folds like a table stage (Jul3/08 §3): its pair fixtures feed the
// standard standings machinery.
const TABLE_KINDS = new Set(["league", "group", "swiss", "americano"]);

// L3/#414 pass 2 — the bracket-shaped kinds. TABLE_KINDS (4) ∪ {"ladder"} (1)
// ∪ BRACKET_KINDS (4) = 9 = every StageKind value: completeStageIfReady's
// branch below is exhaustive by construction, not by the type checker (kind
// is validated from a raw DB string at the loadStageInputs boundary, so TS
// can't prove the three branches cover it statically — see parseStageKind).
// Exported (round-4 review, B) so bracket-kinds-sync.test.ts can pin this
// literal against its two hand-copied siblings (usecases/stages.ts's own
// BRACKET_KINDS, the engine's BRACKET_STAGE_KINDS) — see that test's header
// comment for why an unsynced 5th bracket kind is a silent, fail-open hazard.
export const BRACKET_KINDS = ["knockout", "double_elim", "stepladder", "page_playoff"] as const;
function isBracketKind(kind: StageKind): kind is BracketStage["kind"] {
  return (BRACKET_KINDS as readonly string[]).includes(kind);
}

// L3/#414 pass 2 — `stages.kind` arrives from loadStageInputs's row as a raw
// `string`. The DB CHECK constraint (V298__page_playoff_stage_kind.sql) keeps
// it in the same 9 values as the engine's StageKind, but nothing upstream of
// here ever verified that — the two deleted casts (`as StageCtx["kind"]`,
// `as never`) just told the type checker to trust it. Parse once, reuse the
// validated value everywhere a kind is needed, and fail loudly instead of
// silently absorbing a value the engine doesn't recognise (e.g. the CHECK
// constraint drifting from StageKind again in a future migration).
export function parseStageKind(raw: string, stageId: string): StageKind {
  const parsed = StageKind.safeParse(raw);
  if (!parsed.success) {
    log.error({ event: "stage_kind_invalid", stageId, kind: raw }, "unknown stage kind from DB");
    throw new EngineError("CONFIG_INVALID", `stage ${stageId} has unknown kind "${raw}"`, {
      stageId,
      kind: raw,
    });
  }
  return parsed.data;
}


/** Phantom seat for `SportModule.init` when synthesising a one-sided award
 *  bye delta — never written to the DB, never appears in the folded table
 *  (only the winner's half of the pair is kept as `awardDelta`). */
const BYE_PHANTOM = "__bye__";

/**
 * One-sided award bye → a single win delta via the sport module's own
 * `standingsDelta` (clean-sweep / points.w), not a hand-typed constant. A
 * phantom opponent lets `init` build a legal state; only the winner's half
 * is returned for the fold.
 */
function awardByeDelta(
  sportModule: AnySportModule,
  outcome: MatchOutcome,
  rawCfg: unknown,
  ctx: StageCtx,
  pointsRule: ReturnType<typeof PointsRule.parse> | null,
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
  // `standingsDelta` returns a mutable pair, `applyPointsRule` a readonly
  // `FixtureResult` — so this is a new local, not a reassignment (TS4104).
  const rawPair = sportModule.standingsDelta(bye, cfg, ctx, state);
  // W2c X-PT-1: a bye is told apart by its reason (`isBye`), never by `played` — and it has no ledger: nothing played.
  const pair: FixtureResult = pointsRule ? applyPointsRule(bye, rawPair, pointsRule, false, sportModule.awardScoreKeys) : rawPair;
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

// L3/#414 pass 2 — `ext_key` is the ONE place a bracket fixture's lane
// (WB/LB/GF, double-elim only) and thirdPlace status can be recovered by
// PARSING an id: bracket.ts mints these ids at generation (`wb-r{r}-i{i}`,
// `lb-r{r}-i{i}`, `gf`/`gf-reset`, `${idPrefix}-3p`) and stages.ts writes
// them straight to fixtures.ext_key (PROMPT-09). F1 (2026-08-17) added
// fixtures.lane/fixtures.third_place as a direct, cheaper alternative
// (db/migration/deltas/V368__fixture_round_role.sql) — this function still
// parses ext_key rather than reading those columns because it hasn't been
// migrated to them, not because ext_key remains the only source. Either
// way, never re-derive lane/thirdPlace from round/position: a bracket's
// rounds number sparsely (1,2,3 on a winners' lane, 7-10 on a losers' lane,
// 14 for a grand final — spec 05 §2.3/§2.5), so no arithmetic on `round` can
// recover which lane a fixture belongs to.
export function parseExtKey(extKey: string | null): { bracket?: "WB" | "LB" | "GF"; thirdPlace: boolean } {
  if (extKey === null) return { thirdPlace: false };
  const bracket =
    extKey === "gf" || extKey.startsWith("gf-")
      ? ("GF" as const)
      : extKey.startsWith("wb-")
        ? ("WB" as const)
        : extKey.startsWith("lb-")
          ? ("LB" as const)
          : undefined;
  return { ...(bracket !== undefined ? { bracket } : {}), thirdPlace: extKey.endsWith("-3p") };
}

// A decided/walkover bracket fixture's outcome jsonb names its winner/loser
// (spec 03 §3 MatchOutcome), exhaustive over the engine's OUTCOME_KINDS, and —
// W2b (spec §5.3, W2b-R11) — whether the bracket was WALKED OVER there, which
// `bracketRanks` reads to pin an entrant's elimination to this fixture the way
// seating already does (`BracketFixture.walkedOver`, engine stage.ts):
//  - `win` names both directly; a LEGACY forfeit win (pre-W2b chess,
//    `isLegacyForfeitWin`) is a forfeit — walked over, "loser";
//  - `award` names its loser since W2b (`loser`, null for a bye). A row stored
//    before W2b names only the winner, and the loser is whichever side isn't
//    them (testkit/simulation.ts's own derivation). A loser means a forfeit —
//    walked over, "loser"; no loser (a bye, one seat) means neither. A loser
//    who holds NO seat here (owner ruling 116: a winner who withdrew before
//    this tie, its seat dead, `awardSeededByes`) is named for the copy alone:
//    she never sat in it, so it does not eliminate her and ranks her nowhere —
//    the bye it was, where a departed entrant always ranked (never above a
//    field entrant). Named as the loser of a walked-over FINAL, she would
//    otherwise rank runner-up;
//  - `double_walkover` names nobody — walked over, "both" (X-DW-2);
//  - draw/tie/no_result: a bracket fixture holding one is needs_decision (W2a
//    X-BR-2) and seats nobody, so neither side; a level outcome under a SEATING
//    status is the bug shape, asserted by the callers that know the stage kind
//    (level-seat.ts, X-BR-1).
export function bracketWinnerLoser(
  outcome: unknown,
  home: string | null,
  away: string | null,
): { winner?: string; loser?: string; walkedOver?: "loser" | "both" } {
  if (!outcome) return {};
  const o = outcome as MatchOutcome;
  switch (o.kind) {
    case "win":
      return isLegacyForfeitWin(o) ? { winner: o.winner, loser: o.loser, walkedOver: "loser" } : { winner: o.winner, loser: o.loser };
    case "award": {
      const loser = o.loser !== undefined ? o.loser : o.winner === home ? away : home;
      return loser === null || (loser !== home && loser !== away) ? { winner: o.winner } : { winner: o.winner, loser, walkedOver: "loser" };
    }
    case "double_walkover":
      return { walkedOver: "both" };
    case "draw":
    case "tie":
    case "no_result":
      return {};
    default: {
      const unknown: never = o;
      throw new Error(`bracketWinnerLoser: outcome kind ${JSON.stringify((unknown as { kind?: unknown }).kind)} is not an engine OUTCOME_KINDS member`);
    }
  }
}

// Rebuild one DB fixture row into the engine's BracketFixture shape (spec 05
// §1). `isFinal` starts at `!thirdPlace` and is refined true->false by the
// caller once it knows which fixtures have an onward winner_to_fixture feed
// (a second query across the whole stage, not a fact of the row alone) — but
// NEVER the other way. A thirdPlace playoff decides nothing beyond ranks 3/4,
// so its winner never feeds forward either, which means the naive
// "winner_to_fixture is null => isFinal" heuristic marks it isFinal too: with
// a thirdPlace game sharing the true final's round_no (bracket.ts:
// `round: se.rounds - 1`, identical to the final's own `rounds - 1`),
// bracketRanks's `decidedFinals` round-desc sort can then pick either one as
// the grand final depending on array order. thirdPlace status is structural
// (parsed from ext_key, never guessed) and settles it unconditionally: a
// thirdPlace fixture is never the decider, full stop.
function toBracketFixture(
  f: FixtureRow,
  stageKind: string,
  seatsOf: (fixtureId: string) => readonly [string | null, string | null] | null,
): BracketFixture {
  assertNoLevelSeat({ fixtureId: f.id, stageKind, status: f.status, outcome: f.outcome }); // X-BR-1
  // W2b D20: a double walkover seated nobody in the seats it feeds.
  assertAdvancingSeat({ fixtureId: f.id, stageKind, status: f.status, outcome: f.outcome, seatedEntrant: fedSeatOccupant(f, seatsOf) });
  const { bracket, thirdPlace } = parseExtKey(f.ext_key);
  const { winner, loser, walkedOver } = bracketWinnerLoser(f.outcome, f.home_entrant_id, f.away_entrant_id);
  return {
    id: f.id,
    round: f.round_no,
    isFinal: !thirdPlace,
    // D-G1: a recorded abandon that decided nobody is in play, never the generator's void (recorded-abandon.ts).
    status: completionEngineStatus(stageKind, f),
    ...(bracket !== undefined ? { bracket } : {}),
    ...(thirdPlace ? { thirdPlace: true } : {}),
    ...(f.home_entrant_id !== null ? { home: f.home_entrant_id } : {}),
    ...(f.away_entrant_id !== null ? { away: f.away_entrant_id } : {}),
    ...(winner !== undefined ? { winner } : {}),
    ...(loser !== undefined ? { loser } : {}),
    ...(walkedOver !== undefined ? { walkedOver } : {}),
  };
}

interface StageRow {
  id: string;
  division_id: string;
  kind: string;
  config: {
    rngSeed?: number;
    rounds?: number;
    points?: unknown; // Jul3/05 §2 PointsRule
    carry_deltas?: unknown; // Jul3/05 §3 opening deltas
    rank_overrides?: unknown; // Jul3/05 §4 manual rank locks
    h2h_scope?: string; // Jul3/05 §5
    // L3/#414 pass 2 — Jul3/08 §6: a ladder's finish order. Initialised from
    // seed order on the FIRST issued challenge (usecases/stages.ts
    // issueChallenge) and re-swapped in place whenever a challenger beats the
    // entrant above them (usecases/scoring.ts) — absent until then, so a
    // ladder stage with zero fixtures ever has no order to complete into.
    ladder_order?: string[];
  } | null;
  status: string;
}
interface DivisionRow {
  config: unknown;
  sport_key: string;
  module_version: string;
  tiebreakers: string[] | null;
  seq: number;
}
interface FixtureRow {
  id: string;
  status: string;
  round_no: number;
  pool_id: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
  state: unknown;
  /** V347 — the resolved cfg this fixture was SCORED under; null before its
   *  first event. See `fixture-cfg.ts`. */
  config_snapshot: unknown;
  /** W2c (V469) — the match's own format override, resolved last (`fixture-cfg.ts`). */
  rules_override: unknown;
  /** L3/#414 pass 2 — see parseExtKey: the only surviving record of a bracket
   *  fixture's lane and thirdPlace status. */
  ext_key: string | null;
  /** W2a D-G1: abandoned with an ACTIVE `core.abandon` (recorded-abandon.ts) — read by every completion branch
   *  through `completionEngineStatus`. */
  has_active_abandon: boolean;
  /** X-AB-5: that active abandon is a withdrawal's EXPUNGE (owner ruling 105) — the match left the table, nothing is
   *  owed on it, so it never holds a completion. */
  expunged: boolean;
  /** Rebase ruling D3: that active abandon is the organiser's online No result - already the settle, so it never
   *  holds a table stage's completion either. */
  no_result: boolean;
  /** The match's number within its round - names a held match in the refusal (`completeStageIfReady`). */
  seq_in_round: number;
  /** W2b D20 — the feed edges, so the bracket read can assert a double walkover seated nobody. */
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  loser_to_fixture: string | null;
  loser_to_slot: number | null;
}

interface StageInputs {
  stage: StageRow;
  /** L3/#414 pass 2 — `stage.kind` validated into the engine's StageKind once
   *  per load (parseStageKind); every completion branch reads THIS, never
   *  `stage.kind` (raw string) directly. */
  kind: StageKind;
  division: DivisionRow;
  module: AnySportModule;
  fixtures: FixtureRow[];
  tableFixtures: TableFixture[];
  entrants: string[];
  seeds: Map<string, number>;
  /** W2a D-G1: the entrants still in the competing field (`inTheField`) — the bracket guard's exemption is for the
   *  departed alone. */
  field: Set<string>;
}

// Load a stage's fixtures and turn each decided fixture into a StandingsDelta
// pair via the pinned sport module (spec 03 §4.3). Shared by recompute +
// complete so deltas are computed once per pass.
async function loadStageInputs(tx: Tx, stageId: string): Promise<StageInputs> {
  const [stage] = await tx<StageRow[]>`
    select id, division_id, kind, config, status from stages where id = ${stageId}
  `;
  if (!stage) throw new EngineError("STAGE_NOT_READY", `stage ${stageId} not found`, { stageId });

  const [division] = await tx<DivisionRow[]>`
    select config, sport_key, module_version, tiebreakers, seq
    from divisions where id = ${stage.division_id}
  `;
  if (!division) throw new EngineError("CONFIG_INVALID", "division not found", { stageId });

  const sportModule = resolveModule(division.sport_key, division.module_version);
  const kind = parseStageKind(stage.kind, stageId);
  const ctxBase: StageCtx = { kind };

  const fixtures = await tx<FixtureRow[]>`
    select f.id, f.status, f.round_no, f.pool_id, f.home_entrant_id, f.away_entrant_id,
           f.outcome, f.config_snapshot, f.rules_override, f.ext_key, m.state,
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
  const pointsRule = stage.config?.points ? PointsRule.parse(stage.config.points) : null;
  // W2c Task 9 (X-PT-1): under a rule, each forfeit-shaped result's "was anything played" fact, from its own ledger —
  // one read for the stage, and none without a rule (nothing reads it then) or without a forfeit.
  const playedFacts = pointsRule
    ? await forfeitPlayedFacts(tx, fixtures.filter((f) => f.outcome && f.state && f.home_entrant_id && f.away_entrant_id), sportModule)
    : new Map<string, boolean>();

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
      const pair = sportModule.standingsDelta(
        f.outcome as MatchOutcome,
        resolveFixtureCfg(
          f,
          division.config,
          { kind: stage.kind, config: stage.config as Record<string, unknown> | null },
          sportModule,
        ),
        ctx,
        f.state,
      );
      // Custom points rule (Jul3/05 §2): re-derive competition points from
      // stage config. W2c X-PT-1: a forfeit with nothing played pays the
      // rule's forfeit row, and its awarded score replaces the credit — on
      // the generic keys and on the sport's own score keys (gap a,
      // `awardScoreKeys`: football's gf/ga/gd); the rest of the ledger stands.
      base.result = pointsRule
        ? applyPointsRule(f.outcome as MatchOutcome, pair, pointsRule, playedFor(f, playedFacts), sportModule.awardScoreKeys)
        : pair;
    } else if (isOneSidedAwardBye(f)) {
      // Swiss odd-field sit-out (and KO seeded bye): forfeited award with one
      // seat null and no match_state. The two-sided gate above never fires, so
      // without this branch the bye winner stayed P0/pts=0 on the table while
      // swissGen still counted +1 for pairing — Gus on the demo Swiss 7.
      const ctx: StageCtx = { ...ctxBase, roundNo: f.round_no, ...(f.pool_id ? { poolId: f.pool_id } : {}) };
      base.awardDelta = awardByeDelta(
        sportModule,
        f.outcome as MatchOutcome,
        resolveFixtureCfg(
          f,
          division.config,
          { kind: stage.kind, config: stage.config as Record<string, unknown> | null },
          sportModule,
        ),
        ctx,
        pointsRule,
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
    // No stage-wide `cfg` field: there is no such thing any more. Each fixture
    // resolves its own above, and a single shared one is exactly how live
    // config leaked back into decided fixtures.
    fixtures,
    tableFixtures,
    entrants,
    seeds,
    field,
  };
}

function cascadeFor(inputs: StageInputs): readonly string[] {
  return inputs.division.tiebreakers ?? inputs.module.defaultTiebreakers;
}

function toTableStage(inputs: StageInputs): TableStage {
  return {
    id: inputs.stage.id,
    // americano rides the league fold (Jul3/08 §3)
    kind: (inputs.stage.kind === "americano" ? "league" : inputs.stage.kind) as TableStage["kind"],
    entrants: inputs.entrants,
    cascade: cascadeFor(inputs) as TableStage["cascade"],
    ...(inputs.seeds.size > 0 ? { seeds: inputs.seeds } : {}),
    ...(inputs.stage.config?.rngSeed != null ? { rngSeed: inputs.stage.config.rngSeed } : {}),
    ...(inputs.stage.config?.rounds != null ? { rounds: inputs.stage.config.rounds } : {}),
    ...(inputs.stage.kind === "swiss" ? { swiss: true } : {}),
    // Jul3/05: carry-over openings, manual rank locks, circular-H2H mode
    ...(Array.isArray(inputs.stage.config?.carry_deltas)
      ? { openingDeltas: inputs.stage.config.carry_deltas as never }
      : {}),
    ...(Array.isArray(inputs.stage.config?.rank_overrides)
      ? {
          rankLocks: (inputs.stage.config.rank_overrides as { entrant_id: string; rank: number }[]).map(
            (o) => ({ entrantId: o.entrant_id, rank: o.rank }),
          ),
        }
      : {}),
    ...(inputs.stage.config?.h2h_scope === "overall" ? { h2hScope: "overall" as const } : {}),
  };
}

/**
 * V358 (P3 / D7 weekly digest) — one step of standings history. `rows` rolls
 * into `previous_rows` ONLY when the write actually changes the table (`is
 * distinct from`): `recomputeStandings` is idempotent and reruns on every
 * decided/void write, so an unguarded assignment would let a same-answer
 * rerun overwrite `previous_rows` with the CURRENT rows and erase the real
 * delta before the digest's "biggest climber" line ever reads it. A stage
 * snapshotted for the first time has nothing to roll — `previous_rows` stays
 * null, which the digest treats as "no history yet", not an error.
 */
async function writeSnapshot(
  tx: Tx,
  stageId: string,
  poolId: string | null,
  rows: readonly StandingsRow[],
  through: number,
): Promise<void> {
  await tx`
    insert into standings_snapshots (stage_id, pool_id, rows, computed_through_seq)
    values (${stageId}, ${poolId}, ${tx.json(rows as never)}, ${through})
    on conflict on constraint standings_snapshots_pkey do update set
      previous_rows = case
        when standings_snapshots.rows is distinct from excluded.rows
        then standings_snapshots.rows
        else standings_snapshots.previous_rows
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
 * four (usecases/stages.ts `getStandings` + `overrideStandings`,
 * usecases/scoring.ts `onDecided`, usecases/admin-fixture-config.ts) knows
 * whether the stage it is recomputing has pools: `overrideStandings` passes
 * no pool at all, and the other three forward a FIXTURE's own `pool_id`.
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
 */
export async function recomputeStandings(
  orgId: string,
  stageId: string,
  poolId?: string,
): Promise<readonly StandingsRow[]> {
  return withTenant(orgId, async (tx) => {
    const inputs = await loadStageInputs(tx, stageId);
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + inputs.stage.division_id}))`;

    // completeTableStage folds + ranks each pool; cache them all, then hand
    // back the one we were asked for.
    const { tables } = completeTableStage(toTableStage(inputs), inputs.tableFixtures);
    for (const pool of tables.pools) {
      await writeSnapshot(tx, stageId, pool.pool || null, pool.rows, inputs.division.seq);
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
 * Exists for Swiss Playoff's repairing (usecases/stages.ts `swissGen`), which
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
  const { tables } = completeTableStage(toTableStage(inputs), inputs.tableFixtures);
  return tables.pools[0]?.rows ?? [];
}

// Append a division_event under the division lock, assigning a gapless per-
// division seq (doc 07 note 3). Returns the new seq. Callers that treat the
// event as the division watermark also bump divisions.seq (doc 07).
export async function appendDivisionEvent(
  tx: Tx,
  divisionId: string,
  type: string,
  payload: unknown,
): Promise<number> {
  const [{ seq: last }] = await tx<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from division_events where division_id = ${divisionId}
  `;
  const seq = last + 1;
  await tx`
    insert into division_events (division_id, seq, type, payload)
    values (${divisionId}, ${seq}, ${type}, ${tx.json(payload as never)})
  `;
  return seq;
}

export interface CompleteResult {
  completed: boolean;
  events: DivisionEvent[];
}

/**
 * If a stage's completion predicate holds (spec 05 §1), mark it complete, cache
 * its final placement snapshot(s), and record the structural division_events
 * (stage_completed + any rank-lock) — all under the division advisory lock and
 * idempotent (a re-run on an already-complete stage is a no-op).
 *
 * L3/#414 pass 2 — every stage kind now writes a placement snapshot on
 * completion, not just table stages: table kinds (league/group/swiss/
 * americano) snapshot per pool as before; bracket kinds (knockout/
 * double_elim/stepladder/page_playoff) rebuild BracketFixture[] from each
 * fixture's outcome + ext_key and snapshot bracketRanks() wrapped as a single
 * pool (placementTable); ladder snapshots config.ladder_order once every
 * challenge fixture is settled. seedNextStage (usecases/stages.ts, pass 3)
 * reads these snapshots to qualify entrants into the next stage.
 */
export async function completeStageIfReady(
  orgId: string,
  stageId: string,
): Promise<CompleteResult> {
  return withTenant(orgId, async (tx) => {
    const inputs = await loadStageInputs(tx, stageId);
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + inputs.stage.division_id}))`;

    if (inputs.stage.status === "complete") return { completed: true, events: [] };

    const isTable = TABLE_KINDS.has(inputs.kind);
    let events: DivisionEvent[] = [];

    if (isTable) {
      const tableStage = toTableStage(inputs);
      if (!isTableStageComplete(tableStage, inputs.tableFixtures)) {
        // X-AB-5 (N2): a held match reads in play above, so it is what keeps the stage open. When it is the ONLY thing
        // left - every other match is settled - say so BY NAME, instead of the soft "not ready" an organiser reads as
        // "play something". Counterfactual: the same stage with the held matches counted settled would complete.
        const held = inputs.fixtures.filter((f) => rowAwaitsSettle(inputs.kind, f));
        if (held.length > 0) {
          const heldIds = new Set(held.map((f) => f.id));
          const onlyHeld = isTableStageComplete(
            tableStage,
            inputs.tableFixtures.map((f) => (heldIds.has(f.id) ? { ...f, status: "void" as const } : f)),
          );
          if (onlyHeld) {
            const abandoned = held.map((f) => ({ fixtureId: f.id, round: f.round_no, board: f.seq_in_round }));
            const named = abandoned.map((m) => `round ${m.round} match ${m.board}`).join(", ");
            throw new EngineError(
              "STAGE_NOT_READY",
              `stage has ${abandoned.length === 1 ? "a match" : "matches"} abandoned without a result - settle ${abandoned.length === 1 ? "it" : "them"} first: ${named}`,
              { stageId, reason: ABANDONED_MATCHES_REASON, abandoned },
            );
          }
        }
        return { completed: false, events: [] };
      }
      const completed = completeTableStage(tableStage, inputs.tableFixtures);
      events = completed.events;
      for (const pool of completed.tables.pools) {
        await writeSnapshot(tx, stageId, pool.pool || null, pool.rows, inputs.division.seq);
      }
    } else if (inputs.kind === "ladder") {
      // Jul3/08 §6 — no table/bracket shape of its own: complete once every
      // challenge fixture is settled (SETTLED per the engine status — decided,
      // walkover or void), ranked by the ladder position players fought their
      // way into (usecases/scoring.ts swaps winner/loser on each decided
      // challenge). Zero fixtures ever issued is NOT complete — same as an
      // empty table stage (isTableStageComplete) — nothing has happened yet
      // to rank, and config.ladder_order isn't even set until the first
      // issueChallenge.
      const open = inputs.fixtures.some((f) => {
        // D-G1: an abandoned challenge nobody settled is still open (recorded-abandon.ts), not the void it used to read as.
        const status = completionEngineStatus(inputs.kind, f);
        return status === "scheduled" || status === "in_play";
      });
      if (inputs.fixtures.length === 0 || open) {
        return { completed: false, events: [] };
      }
      const finalRanks = inputs.stage.config?.ladder_order;
      if (finalRanks === undefined || finalRanks.length === 0) {
        // Defensive: issueChallenge always sets ladder_order before its first
        // fixture insert, so settled fixtures with no order is a data bug,
        // not a "not ready yet" — surface it instead of snapshotting nothing.
        throw new EngineError(
          "CONFIG_INVALID",
          `ladder stage ${stageId} has settled fixtures but no ladder_order`,
          { stageId },
        );
      }
      events = [{ type: "stage_completed", stageId, finalRanks }];
      await writeSnapshot(tx, stageId, null, placementTable(finalRanks).rows, inputs.division.seq);
    } else if (isBracketKind(inputs.kind)) {
      // Seeds matter here: bracketRanks's rankRest tiebreak cascade is
      // elimination-round first, seed SECOND (and only then a stable id
      // fallback) — the exact path a thirdPlace playoff that hasn't been
      // played yet falls back to for ranks 3/4 (see the "never masquerades"
      // regression test below). Omitting seeds — the same optional-field
      // pattern toTableStage already uses — would silently degrade that
      // tiebreak to raw entrant-id comparison.
      const bracketStage: BracketStage = {
        id: stageId,
        kind: inputs.kind,
        ...(inputs.seeds.size > 0 ? { seeds: inputs.seeds } : {}),
      };
      const seats = new Map(inputs.fixtures.map((f) => [f.id, [f.home_entrant_id, f.away_entrant_id] as const]));
      const bracketFixtures: BracketFixture[] = inputs.fixtures.map((f) => toBracketFixture(f, inputs.kind, (id) => seats.get(id) ?? null));
      // Refine: only fixtures with no onward winner feed are finals (a
      // fixture whose winner feeds nowhere is the bracket's deciding game).
      const feeders = await tx<{ id: string }[]>`
        select id from fixtures where stage_id = ${stageId} and winner_to_fixture is not null
      `;
      const feederIds = new Set(feeders.map((r) => r.id));
      for (const bf of bracketFixtures) if (feederIds.has(bf.id)) bf.isFinal = false;

      if (!isBracketStageComplete(bracketStage, bracketFixtures)) {
        return { completed: false, events: [] };
      }
      // D-G1 guard. bracketRanks orders an entrant who never lost a settled fixture by elimination round −1: LAST.
      // Right for a departed entrant whose line the generator voided (F14, walkoverDepartedQualifiers); wrong for
      // anyone still in the field — an unbeaten field entrant who won no final means the deciding game decided
      // nobody, and the loop G review measured exactly that: an abandoned final ranked its two finalists 3rd and
      // 4th behind the semi-final losers. A recorded abandon now holds the stage open (completionEngineStatus), so
      // that path no longer reaches here. The one PRODUCT path W2a left (loop G re-review, probe P2; ruling D-G3) —
      // a stepladder qualifier departed before the draw, her final voided with her seated in it and the climber
      // seated into the void row — is gone too: W2b's generator stamps her seat dead instead (spec §5.4 corner 3,
      // X-WD-3), and the climber walks over it. Refuse, never snapshot a champion last.
      const lost = new Set<string>();
      const finalWinners = new Set<string>();
      for (const bf of bracketFixtures) {
        if (!SETTLED_FIXTURE_STATUSES.has(bf.status)) continue;
        if (bf.loser !== undefined) lost.add(bf.loser);
        // PF-5 (X-DW-2): both entrants of a double walkover are out, beaten by absence.
        if (bf.walkedOver === "both") for (const id of [bf.home, bf.away]) if (id !== undefined) lost.add(id);
        if (bf.isFinal === true && bf.winner !== undefined) finalWinners.add(bf.winner);
      }
      const unranked = inputs.entrants.filter((id) => inputs.field.has(id) && !lost.has(id) && !finalWinners.has(id));
      if (unranked.length > 0) {
        // W2b PF-9 / D11 (spec §5.4 corner 3): where the line that decided nobody still SEATS a departed entrant, the
        // refusal is named — which entrant, which match — so the organiser knows the one match to record. (A row
        // written before W2b, or by hand; the generator no longer seats a departed qualifier into an undecided line.)
        const stuck = bracketFixtures.find(
          (bf) =>
            bf.winner === undefined &&
            [bf.home, bf.away].some((id) => id !== undefined && unranked.includes(id)) &&
            [bf.home, bf.away].some((id) => id !== undefined && !inputs.field.has(id)),
        );
        if (stuck) {
          const departedId = [stuck.home, stuck.away].find((id) => id !== undefined && !inputs.field.has(id))!;
          const [named] = await tx<{ display_name: string }[]>`select display_name from entrants where id = ${departedId}`;
          const match = await fixtureBoardRef(tx, stuck.id);
          throw new EngineError(
            "STAGE_SEAT_DEPARTED",
            `bracket stage ${stageId}: fixture ${stuck.id} seats departed entrant ${departedId} and decided nobody — record that match's result`,
            {
              stageId,
              reason: "seat_departed",
              entrantId: departedId,
              fixtureId: stuck.id,
              entrant: named?.display_name ?? null,
              match,
            },
          );
        }
        throw new EngineError(
          "CONFIG_INVALID",
          `bracket stage ${stageId} would rank ${unranked.length} unbeaten entrant(s) still in the field last: its deciding game decided nobody`,
          { stageId, entrants: unranked },
        );
      }
      // completeBracketStage = bracketRanks (stage.ts — already handles
      // losers, third-place, DE-reset and page-playoff with no algorithm
      // change, per the pass-1 regression tests) + the stage_completed event.
      const completed = completeBracketStage(bracketStage, bracketFixtures);
      events = completed.events;
      await writeSnapshot(
        tx,
        stageId,
        null,
        placementTable(completed.finalRanks).rows,
        inputs.division.seq,
      );
    } else {
      // Unreachable: TABLE_KINDS ∪ {"ladder"} ∪ BRACKET_KINDS covers every
      // StageKind value (see the BRACKET_KINDS comment above). Guards a
      // future StageKind addition that forgets to extend this file, instead
      // of silently falling through with no snapshot written.
      throw new EngineError(
        "CONFIG_INVALID",
        `stage ${stageId} kind "${inputs.kind}" has no completion handler`,
        { stageId, kind: inputs.kind },
      );
    }

    // Persist the structural events, then mark the stage complete and advance
    // the division watermark to the last division_event seq.
    let lastSeq = inputs.division.seq;
    for (const ev of events) {
      lastSeq = await appendDivisionEvent(tx, inputs.stage.division_id, ev.type, ev);
    }
    await tx`update stages set status = 'complete' where id = ${stageId}`;
    await tx`update divisions set seq = ${lastSeq} where id = ${inputs.stage.division_id}`;
    log.info({ event: "stage_completed", stageId, kind: inputs.kind }, "stage_completed");

    return { completed: true, events };
  });
}
