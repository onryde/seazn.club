import "server-only";
import type postgres from "postgres";
import { type PointsAdjustmentRecord } from "@/lib/points-adjustment-note";
import { StageKind } from "@seazn/engine/core";
import { type FixtureResult, type TableFixture } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { type LoadedTableRules } from "../table-rules";
import { type StageSeating } from "../stage-seating";

export type Tx = postgres.TransactionSql;

export interface StageRow {
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
    // seed order on the FIRST issued challenge (usecases/stages/
    // issueChallenge) and re-swapped in place whenever a challenger beats the
    // entrant above them (usecases/scoring.ts) — absent until then, so a
    // ladder stage with zero fixtures ever has no order to complete into.
    ladder_order?: string[];
  } | null;
  status: string;
  /** W2d (V475): the table rules fixed at activation, and when (`table-rules.ts`). */
  table_rules_pinned: unknown;
  table_rules_pinned_at: string | null;
}
export interface DivisionRow {
  config: unknown;
  sport_key: string;
  module_version: string;
  tiebreakers: string[] | null;
  seq: number;
}
export interface FixtureRow {
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
  /** W4 T12 (V499; X-CH-4): when the organiser ruled this unplayed final joint winners - decided, no outcome, both seats. */
  joint_winners_at: Date | string | null;
  /** W2b D20 — the feed edges, so the bracket read can assert a double walkover seated nobody. */
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  loser_to_fixture: string | null;
  loser_to_slot: number | null;
}

export interface StageInputs {
  stage: StageRow;
  /** L3/#414 pass 2 — `stage.kind` validated into the engine's StageKind once
   *  per load (parseStageKind); every completion branch reads THIS, never
   *  `stage.kind` (raw string) directly. */
  kind: StageKind;
  division: DivisionRow;
  module: AnySportModule;
  /** W2d T9: the stage's table rules (`tableRulesOf`: its pin once active, else the live layers) — the points every
   *  decided fixture is paid by and the order the table ranks by. */
  rules: LoadedTableRules;
  /** B5 (FIDE C.07): each decided fixture's GAME points — the sport's own ledger points (`standingsDelta`), before the
   *  table rule re-pays them — keyed by the paid result the ranker is handed. */
  gamePoints: ReadonlyMap<FixtureResult, readonly [number, number]>;
  fixtures: FixtureRow[];
  tableFixtures: TableFixture[];
  entrants: string[];
  seeds: Map<string, number>;
  /** W2a D-G1: the entrants still in the competing field (`inTheField`) — the bracket guard's exemption is for the
   *  departed alone. */
  field: Set<string>;
  /** W3 T8 (X-SW-8): a Swiss stage's per-entrant unpaired rounds (`swissAbsentRounds`), for `TableStage.swissAbsentRounds`.
   *  Empty for every other kind, and for a Swiss nobody has missed a round of. */
  swissAbsentRounds: ReadonlyMap<string, readonly number[]>;
  /** W5 app PR B Task 1 (X-PO-1; C10, C11): a group stage's seating, off EVERY stored line whatever its status
   *  (`stageSeatingOf`) - handed to the fold as `TableStage.pools` when `seated`, so a pool's table lists its members from the
   *  first fold. `unpooled` and `held` (a stored seating the engine would refuse, C11) keep engine 9's membership. */
  seating: StageSeating;
  /** W5 app PR B Task 7 (X-ADJ-1, X-ADJ-4; C5, C8): THIS stage's active `points_adjustment` rows, in ledger order
   *  (`activePointsAdjustments`) - every one, held or not. `toTableStage` passes the ones the fold can hold
   *  (`foldedAdjustments`). */
  adjustments: readonly PointsAdjustmentRecord[];
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
 *
 * B5 fix wave fix round 2 (controller ruling m4, owner standing "apply rec"): WHY the table changed decides what the step is.
 * A `"result"` refold (a decided match: `onDecided`, scoring.ts) rolls the old rows into `previous_rows` as above — the step a
 * result made, which "Biggest climber" reads. A `"roster"` refold (a withdrawal, a Reinstate, a disqualification's cascade, a
 * late entrant's placement, an expunge, a pin, a rules or config refold, a generate, a completion's placement write) REBASES the
 * step instead: `previous_rows` becomes the new rows, so the move the roster made is never read as anyone's climb, and the next
 * result's step starts from the table as it now stands. No column: the step itself records the cause (a result's, or empty).
 * An unchanged table keeps its step whatever the cause (a same-answer rerun must not erase the real delta, as above).
 *
 * B5 fix wave fix round 4 (m5; controller ruling, the reviewer's option a): Pair next seating a Swiss BYE is a result too - a
 * point awarded - and it opens its OWN step like any result (`"result"`: the table just before the bye against the table just
 * after it), whose climber is the bye's holder (`afterGenerateCommit`, usecases/stages/generate.ts).
 */
export type SnapshotCause = "result" | "roster";
