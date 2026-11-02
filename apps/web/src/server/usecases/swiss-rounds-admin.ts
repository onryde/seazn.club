import "server-only";
// W3 Task 12 (SW-M10, #838, RB3-5; rules X-SW-17 and BG-SW-1) — a Swiss stage's round count and chess colours, edited on
// the stage itself. Spec 2026-10-31-format-matrix-w3-swiss-design.md §8 Q2: "Rounds editable until the first fixture
// starts … per stage, then Finish/Add a round only"; ruling 250: "Add a round" while the Swiss runs, "This Swiss is over"
// after it. #838's defect was that the only way to change the count was the Format tab's Apply, which answers
// FORMAT_LOCKED the moment shells exist — so a count could not be corrected between the mint and the first match.
//
//   `patchSwissStage`  `PATCH /stages/{id}` `{ rounds?, chess? }`: before the stage's first START, the count moves (shells
//                      of removed rounds deleted, shells of added rounds minted for each round's own field) and the chess
//                      switch moves; after it, SWISS_ROUNDS_LOCKED `{ canFinish, canAddRound }`.
//   `addSwissRound`    `POST /stages/{id}/swiss/add-round`: round N+1 for the field it will pair, within the hard maximum
//                      (rulebook §3.1/§3.2), until the Swiss is over.
//   `finishSwissNow`   `POST /stages/{id}/swiss/finish` (W3 T13, RB3-20, X-SW-26): end the Swiss after round k, the latest
//                      round whose seated boards are all decided, then complete the stage (which seeds what follows).
//
// THE predicates this file owns, each read by every caller of its fact (one authority per fact):
//   `swissBoardStartedSql`  "a board has started" (T9's, moved here whole): any result or evidence
//                           (`fixtureHasResultSql`), an online game's bridge row, or a decided board that is not the bye.
//                           A bye alone is not a start (Task 3); a device link is not one (T9 re-ruling I1).
//   `swissAddRoundState`    whether "Add a round" goes through (controller ruling C11): every emitter of `canAddRound` —
//                           the late-entry refusal (`swiss-late-entry.ts`), SWISS_ROUNDS_LOCKED here — and
//                           `addSwissRound` itself read it, so the button the desk offers never leads to SWISS_OVER,
//                           STAGE_NOT_READY or SWISS_ROUNDS_ABOVE_MAX. The timetable freeze is NOT part of it: it is
//                           checked first, outside (`lockedSwissStage`, the ruled order), so a frozen division still
//                           answers an offered Add a round 422 SCHEDULE_LOCKED (review m2).
//   `swissFinishState`      whether "Finish the Swiss now" goes through (T13, C11 applied to Finish): every `canFinish`
//                           the server sends — SWISS_ROUNDS_LOCKED and SWISS_ROUNDS_ABOVE_MAX here, the Pair's
//                           shrunk-field refusal and warning (`swissGen`), SWISS_NO_ROUND_LEFT (`swiss-late-entry.ts`), the
//                           desk's read — and `finishSwissNow` itself read it. The freeze is outside it, as above.
//
// Every write takes the late-entry and Unpair lock order: the division's freeze (SCHEDULE_LOCKED), the `division:`
// advisory lock, then the boards' `fixture:` append locks before any "started" read (`lockSwissBoardAppends`). A round
// change appends `swiss_rounds_changed` — an undo barrier (history.ts `UNDO_BARRIER_TYPES`, design §10.8), the
// organiser's (`source: "organiser"`) — and never touches the edit watermark (T5 carry).
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { EngineError } from "@seazn/engine/core";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { isRootSwissStage } from "@/lib/open-entry-stages";
import { carrySlots } from "@/lib/rebuild-slots";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
import { judgeSwissRounds, type SwissRoundsJudgement } from "@/lib/swiss-rounds";
import type { SwissRoundControl } from "@/lib/swiss-rounds-edit";
import {
  isSwissBoardSeated,
  isSwissByeShellExtKey,
  latestSwissRoundWithAnySeat,
  mintSwissBoardExtKeys,
  nextUnseatedSwissRound,
  swissBoardsForField,
} from "@/lib/swiss-shell";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { PatchSwissStage } from "@/server/api-v1/schemas";
import { tableStageCompletable } from "@/server/engine-db/competition";
import { firstOwnFormat, ownFormatLoss } from "./fixture-override-guards";
import { fixtureHasResultSql, swissByeShellSql } from "./fixture-results-sql";
import { afterScheduleWrite, divisionLockState } from "./schedule";
import { swissRefusal } from "./swiss-refusal";
import {
  DECIDED,
  clearSwissFixtureSeats,
  completeStage,
  judgeSwissRoundsAt,
  lockSwissBoardAppends,
  refuseSwissFieldUnderTwo,
  swissActiveEntrants,
  swissFieldForRound,
  type ActiveEntrant,
  type CompleteStageResult,
  type SwissExistingFixture,
} from "./stages";

type Tx = postgres.TransactionSql;

/** The stage columns this file reads (a Swiss stage as the late-entry admission reads it, plus its division). */
export interface SwissStageRow {
  id: string;
  division_id: string;
  seq: number;
  status: string;
  kind: string;
  progression: unknown;
  config: Record<string, unknown>;
}

/**
 * THE "this board has started" predicate, as SQL over the fixtures row `on` (W3 T9, spec §4 "started"; moved here by
 * T12 so the late-entry decision and the rounds lock read one authority):
 *  - a result or any recorded evidence: `fixtureHasResultSql` (in play, decided, an outcome-bearing abandonment, a score
 *    event, a frozen cfg, a report, a mark, a suspension);
 *  - an online game stands behind it: any `fixture_external_play` row (T9 Review Focus 1), scored or not;
 *  - decided, other than the bye: a two-sided walkover an import or a pre-W2b generator wrote holds no event, yet its board
 *    is settled.
 * NOT a start: a bye alone (Task 3 — awarded at Pair, nobody played it: `swissByeShellSql` exempts it from the decided
 * arm, and `fixtureEvidenceSql` exempts its frozen cfg), and a device link (T9 re-ruling I1: a link carries no opened
 * marker, and printing a day's sheets mints one per board; a link that was used has written a score event).
 */
export function swissBoardStartedSql(tx: Tx, on = "f") {
  const f = tx(on);
  return tx`(
    ${fixtureHasResultSql(tx, on)}
    or exists (select 1 from fixture_external_play x where x.fixture_id = ${f}.id)
    or (${f}.status in ${tx([...DECIDED])} and not ${swissByeShellSql(tx, on)})
  )`;
}

/** Whether any fixture of the stage has started (`swissBoardStartedSql`). The caller holds the boards' append locks. */
async function stageHasStarted(tx: Tx, stageId: string): Promise<boolean> {
  const [hit] = await tx`select 1 from fixtures f where f.stage_id = ${stageId} and ${swissBoardStartedSql(tx, "f")} limit 1`;
  return hit !== undefined;
}

/** The stored round count. Every Swiss stage holds one (`assertSwissRoundsDeclared` at create); a row without one is a
 *  broken stage, refused by name exactly as `swissGen` refuses it. */
function storedRounds(stage: SwissStageRow): number {
  const rounds = stage.config.rounds;
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1) {
    throw new EngineError("CONFIG_INVALID", "swiss stage requires config.rounds >= 1", { stageId: stage.id });
  }
  return rounds;
}

/**
 * The entrants a Swiss stage pairs, as `generateStageFixturesTx` reads them: a stage fed by an earlier one draws from its
 * `config.qualified` (∩ the active roster, every qualifier from round 1); a root Swiss from the whole active roster, with
 * each latecomer's first round. Null for a fed Swiss before its draw: it has no field yet (T11's Start check skips it
 * for the same reason), and its own Generate judges the count once it does.
 */
async function swissStageEntrants(tx: Tx, stage: SwissStageRow): Promise<ActiveEntrant[] | null> {
  const active = await swissActiveEntrants(tx, stage.division_id, stage.id);
  const qualified = stage.config.qualified;
  if (Array.isArray(qualified)) {
    const activeIds = new Set(active.map((e) => e.id));
    return (qualified as string[]).filter((id) => activeIds.has(id)).map((id, i) => ({ id, seed: i + 1, swiss_first_round: null }));
  }
  return isRootSwissStage(stage) ? active : null;
}

/** Over (ruling 250, "This Swiss is over"): the stage is complete, or a later stage of the division (its knockout) has a
 *  fixture under way. T9's definition, unchanged: a later stage's own generator byes are no start. */
async function swissIsOver(tx: Tx, stage: SwissStageRow): Promise<boolean> {
  if (stage.status === "complete") return true;
  const [later] = await tx`
    select 1 from fixtures f join stages s on s.id = f.stage_id
    where s.division_id = ${stage.division_id} and s.seq > ${stage.seq} and ${fixtureHasResultSql(tx, "f")}
    limit 1`;
  return later !== undefined;
}

export type SwissFinishRefusal = "over" | "nothing_played" | "round_undecided";

/** A board named by a Finish refusal, in the shape the abandoned-board refusal names its boards (`swissGen`,
 *  `generatePreconditionMessage`): `board` is the board's number within its round. */
export interface SwissFinishBoard {
  fixtureId: string;
  round: number;
  board: number;
}

export interface SwissFinishState {
  over: boolean;
  /** The stored round count N. */
  rounds: number;
  /** k: the latest round whose seated boards are all decided (0: none is). Standings after round k become final. */
  finishedAfter: number;
  /** Why Finish would be refused, or null when it goes through. */
  refusal: SwissFinishRefusal | null;
  /** `round_undecided`: the boards to decide first — every undecided row of a round ≤ k, and every undecided seated or
   *  started board of a round past k that has started; else []. */
  boards: SwissFinishBoard[];
  /** `round_undecided` because a board past k has STARTED (that round stays: "the round in progress"); false when only a
   *  round ≤ k is short a result — a scorer's take-back reopened a finished round — or for any other answer. The copy
   *  branches on it (review m3). */
  inProgress: boolean;
  /** Batch-4 ruling m3: every round is decided and Finish would remove nothing nor move the count, so it is exactly
   *  Complete — the action the desk already shows. Nothing offers Finish then (`canFinish` false); the call itself still
   *  goes through (`refusal` stays null), completing the stage as Complete does. False for every other answer. */
  completeInstead: boolean;
  /** `refusal === null` and not `completeInstead`: what every emitter of `canFinish` sends (controller ruling C11,
   *  applied to Finish) — so an offered Finish always goes through. */
  canFinish: boolean;
}

/**
 * THE "Finish the Swiss now" verdict over the stage's rows (W3 T13, X-SW-26), pure. `k` is the latest round whose seated
 * boards are all decided and hold a board that is not the bye (batch-4 ruling 4: a round whose only seated row is the
 * bye — engine 1.x's "empty success", SW-H1, which seats the bye and leaves every board vacant — was never played, so
 * it is not decided; Finish drops it with the rounds after it, and never asks for its empty boards). Refused, in this order: the Swiss is over (`over`, SWISS_OVER); k = 0, no round complete
 * (`nothing_played`); else a round Finish would keep is short a result (`round_undecided`): a board past k has STARTED
 * (`started`, T9's predicate — it cannot be unpaired, so its round stays: `inProgress`), or a row of a round ≤ k is not
 * decided. The second is reachable in production — a scorer's take-back (`core.void`) reopens a finished round's board
 * while a later round stays decided, so k does not move (Fix round 1, review I2) — and it reads EVERY row ≤ k, seated or
 * not, as the completion predicate (`isTableStageComplete`) does, so the R3 backstop never refuses what this offered
 * (review m4). The refusal names what the organiser decides first. Otherwise Finish ends the Swiss after round k: a
 * paired round past k that nothing in has started is unpaired and dropped with the shells.
 */
export function judgeSwissFinish(
  rows: readonly SwissExistingFixture[],
  started: ReadonlySet<string>,
  over: boolean,
  rounds: number,
): SwissFinishState {
  const seatedByRound = new Map<number, SwissExistingFixture[]>();
  for (const f of rows) {
    if (!isSwissBoardSeated(f)) continue;
    seatedByRound.set(f.round_no, [...(seatedByRound.get(f.round_no) ?? []), f]);
  }
  let k = 0;
  for (const [round, seated] of seatedByRound) {
    const played = seated.some((f) => !isSwissByeShellExtKey(f.ext_key));
    if (round > k && played && seated.every((f) => DECIDED.has(f.status))) k = round;
  }
  const state = (
    refusal: SwissFinishRefusal | null,
    boards: SwissFinishBoard[] = [],
    inProgress = false,
    completeInstead = false,
  ): SwissFinishState => ({
    over,
    rounds,
    finishedAfter: k,
    refusal,
    boards,
    inProgress,
    completeInstead,
    canFinish: refusal === null && !completeInstead,
  });
  if (over) return state("over");
  if (k === 0) return state("nothing_played");
  // The latest round past k with a started board: it and every round before it stay.
  const kept = rows.reduce((m, f) => (f.round_no > k && started.has(f.id) ? Math.max(m, f.round_no) : m), k);
  const shortOfResult = rows.some((f) => f.round_no <= k && !DECIDED.has(f.status));
  if (kept === k && !shortOfResult) return state(null, [], false, k >= rounds && !rows.some((f) => f.round_no > k));
  const owed = rows.filter(
    (f) =>
      !DECIDED.has(f.status) &&
      (f.round_no <= k ||
        (f.round_no <= kept && !isSwissByeShellExtKey(f.ext_key) && (isSwissBoardSeated(f) || started.has(f.id)))),
  );
  // A refusal that names nothing is a sentence the organiser cannot act on: past k only a decided board can be what
  // blocked (planted — a decided round past k makes k larger), and then it is the one named.
  const named = owed.length > 0 ? owed : rows.filter((f) => f.round_no > k && started.has(f.id));
  return state(
    "round_undecided",
    [...named]
      .sort((x, y) => x.round_no - y.round_no || x.seq_in_round - y.seq_in_round)
      .map((f) => ({ fixtureId: f.id, round: f.round_no, board: f.seq_in_round })),
    kept > k,
  );
}

/**
 * THE "Finish the Swiss now" predicate (controller ruling C11, applied to Finish): every `canFinish` the server sends —
 * SWISS_ROUNDS_LOCKED and SWISS_ROUNDS_ABOVE_MAX here, the Pair's shrunk-field refusal and warning (`swissGen`), the late
 * player's SWISS_NO_ROUND_LEFT (`swiss-late-entry.ts`), the desk's read — and `finishSwissNow` itself read it, so an
 * offered Finish never leads to a Finish refusal. The timetable freeze is NOT part of it (checked first and outside, as
 * for Add a round). `rows`, when the caller already read them under its locks; a write holds the boards' append locks.
 */
export async function swissFinishState(
  tx: Tx,
  stage: SwissStageRow,
  rows?: readonly SwissExistingFixture[],
): Promise<SwissFinishState> {
  const rounds = storedRounds(stage);
  const all = rows ?? (await stageRows(tx, stage.id));
  const over = await swissIsOver(tx, stage);
  const started = await tx<{ id: string }[]>`
    select f.id from fixtures f where f.stage_id = ${stage.id} and ${swissBoardStartedSql(tx, "f")}`;
  return judgeSwissFinish(all, new Set(started.map((r) => r.id)), over, rounds);
}

/** `swissFinishState` by stage id, for a caller holding no stage row (`swissGen`'s Pair). */
export async function swissFinishStateOf(tx: Tx, stageId: string): Promise<SwissFinishState> {
  const [stage] = await tx<SwissStageRow[]>`
    select id, division_id, seq, status, kind, progression, config from stages where id = ${stageId}`;
  if (!stage) throw new HttpError(404, "stage not found");
  return swissFinishState(tx, stage);
}

/** What a refusal offering Finish carries for the recovery's confirm ("Standings after round {k} become final. Rounds
 *  {k+1}–{N} are removed."): present only when `canFinish`. */
export function swissFinishDetails(state: SwissFinishState): { canFinish: boolean; finish?: { after: number; rounds: number } } {
  return state.canFinish
    ? { canFinish: true, finish: { after: state.finishedAfter, rounds: state.rounds } }
    : { canFinish: false };
}

export type SwissAddRoundRefusal = "over" | "field" | "above_max";

export interface SwissAddRoundState {
  over: boolean;
  /** The stored round count N; Add a round makes it N + 1. */
  rounds: number;
  /** Round N + 1's field, or null when it is not known (over, or a fed Swiss before its draw). */
  field: number | null;
  /** That field's hard maximum (rulebook §3.1), or null with no pairable field. */
  hardMax: number | null;
  /** Why Add a round would be refused, or null when it goes through. */
  refusal: SwissAddRoundRefusal | null;
  /** `refusal === null`: what every emitter offers the desk's "Add a round" button on. */
  canAddRound: boolean;
}

/**
 * THE "Add a round" predicate (controller ruling C11, carry c1): the Swiss is not over, and round N + 1's field — the
 * field `addSwissRound` mints for — is pairable (2 or more) with N + 1 within its hard maximum. `excluding` leaves one
 * entrant out of that field: the arrival a late-entry refusal is about to roll back (its insert is in the refused
 * transaction, so Add a round will not see it). The caller holds the `division:` lock.
 */
export async function swissAddRoundState(
  tx: Tx,
  stage: SwissStageRow,
  opts: { excluding?: string } = {},
): Promise<SwissAddRoundState> {
  const rounds = storedRounds(stage);
  const refused = (refusal: SwissAddRoundRefusal, field: number | null, hardMax: number | null, over = false) => ({
    over,
    rounds,
    field,
    hardMax,
    refusal,
    canAddRound: false,
  });
  if (await swissIsOver(tx, stage)) return refused("over", null, null, true);
  const entrants = await swissStageEntrants(tx, stage);
  if (entrants === null) return { over: false, rounds, field: null, hardMax: null, refusal: null, canAddRound: true };
  const field = swissFieldForRound(entrants.filter((e) => e.id !== opts.excluding), rounds + 1).length;
  if (field < 2) return refused("field", field, null);
  const judgement = judgeSwissRounds(rounds + 1, field);
  if (judgement.verdict === "refuse") return refused("above_max", field, judgement.hardMax);
  return { over: false, rounds, field, hardMax: judgement.hardMax, refusal: null, canAddRound: true };
}

/** The field the stage's next Pair seats — the one a round count is judged against (T11's Start check reads the same
 *  round): round 1 before any shell, else the lowest round with an unseated board, else the round after the last. Null
 *  for a fed Swiss before its draw (no field yet). */
async function nextPairField(tx: Tx, stage: SwissStageRow, rows: readonly SwissExistingFixture[]): Promise<number | null> {
  const entrants = await swissStageEntrants(tx, stage);
  if (entrants === null) return null;
  const maxRound = rows.reduce((m, f) => Math.max(m, f.round_no), 0);
  const target = rows.length === 0 ? 1 : (nextUnseatedSwissRound(rows) ?? maxRound + 1);
  return swissFieldForRound(entrants, target).length;
}

async function stageRows(tx: Tx, stageId: string): Promise<SwissExistingFixture[]> {
  return tx<SwissExistingFixture[]>`
    select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome,
           scheduled_at, court_id, venue_id, schedule_locked
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
}

/**
 * The stage, read and locked as Unpair reads and locks it: 404 when it is not this organisation's; STAGE_NOT_SWISS for
 * any other kind; SCHEDULE_LOCKED when the division's timetable is frozen; then the `division:` advisory lock, and the
 * stage read again under it (a concurrent edit committed before the lock is seen).
 */
async function lockedSwissStage(tx: Tx, stageId: string): Promise<SwissStageRow> {
  const read = async () => {
    const [row] = await tx<SwissStageRow[]>`
      select id, division_id, seq, status, kind, progression, config from stages where id = ${stageId}`;
    return row;
  };
  const stage = await read();
  if (!stage) throw new HttpError(404, "stage not found");
  if (stage.kind !== "swiss") throw swissRefusal("STAGE_NOT_SWISS");
  if ((await divisionLockState(tx, stage.division_id)).frozen) {
    throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
  }
  await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
  return (await read())!;
}

/** Round `round`'s shells for a field of `fieldSize`: ⌊n/2⌋ boards (`mintSwissBoardExtKeys`, the one mint rule) and a
 *  bye for an odd field, unseated and `scheduled`. `org_id` and `fixture_no` come from the BEFORE INSERT triggers, as
 *  for every Swiss shell (`reconcileSwissRoundShells`). */
async function mintRoundShells(tx: Tx, stage: SwissStageRow, round: number, fieldSize: number): Promise<number> {
  refuseSwissFieldUnderTwo(stage.id, fieldSize);
  const { boards, bye } = swissBoardsForField(fieldSize);
  const shell = (extKey: string, seqInRound: number) => ({
    id: randomUUID(),
    stage_id: stage.id,
    division_id: stage.division_id,
    round_no: round,
    seq_in_round: seqInRound,
    home_entrant_id: null,
    away_entrant_id: null,
    ext_key: extKey,
    status: "scheduled",
    outcome: null,
  });
  // The round holds no row (every caller mints only a round that has none), so its keys start at b1.
  const minted = mintSwissBoardExtKeys(round, [], boards).map((key, i) => shell(key, i + 1));
  if (bye) minted.push(shell(`sw-r${round}-bye`, boards + 1));
  if (minted.length > 0) await tx`insert into fixtures ${tx(minted)}`;
  return minted.length;
}

/** `swiss_rounds_changed`, under the caller's `division:` lock: the division's token moves with the row; the watermark is
 *  NOT touched (T5 carry — a barrier that reset it would make the next Redo answer NOTHING_TO_REDO instead of the
 *  barrier's named refusal). */
async function appendRoundsChanged(
  tx: Tx,
  divisionId: string,
  payload: { stage_id: string; from: number; to: number; via: "edit" | "add_round" | "finish" },
  actorId: string | null,
): Promise<void> {
  const [{ seq: last }] = await tx<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from division_events where division_id = ${divisionId}`;
  await tx`
    insert into division_events (division_id, seq, type, payload, actor_id)
    values (${divisionId}, ${last + 1}, 'swiss_rounds_changed', ${tx.json({ ...payload, source: "organiser" } as never)}, ${actorId})`;
  await tx`update divisions set seq = ${last + 1} where id = ${divisionId}`;
}

async function competitionOf(tx: Tx, divisionId: string): Promise<string> {
  const [division] = await tx<{ competition_id: string }[]>`select competition_id from divisions where id = ${divisionId}`;
  return division!.competition_id;
}

export interface PatchSwissStageResult {
  rounds: number;
  chess: boolean;
  /** The new count against the field its next Pair seats (ok or warn); null when `rounds` was not sent or there is no
   *  pairable field to judge it against (a fed Swiss before its draw, a field under 2 — that Generate refuses). */
  swiss_rounds: (SwissRoundsJudgement & { verdict: "ok" | "warn" }) | null;
  shells: { added: number; removed: number; slots_freed: number };
}

/**
 * `PATCH /stages/{id}` (X-SW-17, BG-SW-1): the round count and the chess switch, until the stage's first start.
 *
 * Refused, nothing written: 404 (not this organisation's stage); STAGE_NOT_SWISS 422; SCHEDULE_LOCKED 422 (a frozen
 * timetable, as Unpair); SWISS_ROUNDS_LOCKED 409 `{ canFinish, canAddRound }` once any board of the stage has started
 * (`swissBoardStartedSql`, read over EVERY row — so a shell this edit would delete never holds data), and SWISS_OVER 422
 * `{ canFinish: false, canAddRound: false }` instead once the stage is complete or a later stage is under way (batch-4
 * ruling m1); for `rounds`,
 * SWISS_ROUNDS_ABOVE_MAX 422 as sent (rulebook §3.2, the field the next Pair seats — `judgeSwissRoundsAt`) and
 * SWISS_ROUNDS_BELOW_SEATED 409 below a paired round (Unpair it first); FIXTURE_HAS_OWN_FORMAT for a deleted shell
 * carrying its own format.
 *
 * Written: rounds above the new count are deleted (their laid-out slots reported, `carrySlots`); rounds added are minted
 * for each round's own field, once the stage holds shells (before its first Generate the count is only stored, and the
 * Generate mints it); the config; and, when the count moved, one `swiss_rounds_changed { via: "edit" }`. The same count
 * again writes nothing.
 */
export async function patchSwissStage(auth: AuthCtx, stageId: string, body: PatchSwissStage): Promise<PatchSwissStageResult> {
  const write = await withTenant(auth.orgId, async (tx) => {
    const stage = await lockedSwissStage(tx, stageId);
    const from = storedRounds(stage);
    const to = body.rounds ?? from;
    const rows = await stageRows(tx, stageId);
    const removed = rows.filter((f) => f.round_no > to);

    // The seated boards (the only ones a scorer or an online game can start) and every row the edit would delete take
    // their append locks before "started" is read: a first event in flight commits first and is seen, or waits.
    const seatedIds = rows.filter((f) => f.home_entrant_id !== null || f.away_entrant_id !== null).map((f) => f.id);
    await lockSwissBoardAppends(tx, [...new Set([...seatedIds, ...removed.map((f) => f.id)])]);
    if (await stageHasStarted(tx, stageId)) {
      // Phase 2 (controller ruling): a colour change alone is refused with its OWN code — the rounds sentence offers
      // Finish now and Add a round, which do nothing for the colours. A body naming the count is a rounds change.
      if (body.rounds === undefined) throw swissRefusal("SWISS_CHESS_LOCKED");
      const add = await swissAddRoundState(tx, stage);
      const finish = await swissFinishState(tx, stage, rows);
      // Batch-4 ruling m1: a finished Swiss's count can never move — 422 SWISS_OVER, as Add a round and Finish answer —
      // never the 409 LOCKED, whose status says another way resolves it.
      if (finish.over) throw swissRefusal("SWISS_OVER", { canFinish: false, canAddRound: false });
      throw swissRefusal("SWISS_ROUNDS_LOCKED", { ...swissFinishDetails(finish), canAddRound: add.canAddRound });
    }

    let judgement: PatchSwissStageResult["swiss_rounds"] = null;
    if (body.rounds !== undefined) {
      const field = (await nextPairField(tx, stage, rows)) ?? 0;
      // Nothing is played before the first start, so nothing can be finished: a count above the hard max is 422 as sent.
      if (field >= 2) judgement = judgeSwissRoundsAt(to, field, false) as PatchSwissStageResult["swiss_rounds"];

      const seatedRound = latestSwissRoundWithAnySeat(rows);
      if (seatedRound !== null && to < seatedRound) {
        throw swissRefusal("SWISS_ROUNDS_BELOW_SEATED", { rounds: to, seatedRound });
      }
    }

    let added = 0;
    let slotsFreed = 0;
    if (to < from && removed.length > 0) {
      const ids = removed.map((f) => f.id);
      const own = await firstOwnFormat(tx, tx`id in ${tx(ids)}`);
      if (own) throw ownFormatLoss(own);
      const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
      slotsFreed = carrySlots(
        removed.map((f) => ({
          round_no: f.round_no,
          seq_in_round: f.seq_in_round,
          pool_id: null,
          ext_key: f.ext_key,
          scheduled_at: iso(f.scheduled_at),
          court_id: f.court_id,
          venue_id: f.venue_id,
          schedule_locked: f.schedule_locked,
        })),
        [],
      ).freed.length;
      await tx`delete from fixtures where id in ${tx(ids)}`;
    }
    if (to > from && rows.length > 0) {
      const entrants = (await swissStageEntrants(tx, stage)) ?? [];
      for (let round = from + 1; round <= to; round++) {
        const inRound = rows.filter((f) => f.round_no === round);
        if (inRound.length > 0) continue;
        added += await mintRoundShells(tx, stage, round, swissFieldForRound(entrants, round).length);
      }
    }

    const chess = body.chess ?? stage.config.chess === true;
    // W3 PR #1104 CI: the keys this write can carry are `rounds` and `chess` and no others, written as a literal so the
    // table-writers source scan (table-writers-source.test.ts) can SEE that it never carries a tie-break order. An
    // undefined key is dropped by the JSON serialiser, so only the keys that changed reach the merge.
    const roundsPatch = body.rounds !== undefined && to !== from ? to : undefined;
    const chessPatch = body.chess !== undefined && body.chess !== stage.config.chess ? body.chess : undefined;
    const changed = roundsPatch !== undefined || chessPatch !== undefined;
    if (changed) {
      await tx`update stages set config = config || ${tx.json({ rounds: roundsPatch, chess: chessPatch } as never)} where id = ${stageId}`;
    }
    if (to !== from) {
      await appendRoundsChanged(tx, stage.division_id, { stage_id: stageId, from, to, via: "edit" }, auth.userId);
    }
    return {
      result: { rounds: to, chess, swiss_rounds: judgement, shells: { added, removed: to < from ? removed.length : 0, slots_freed: slotsFreed } },
      published: changed ? { divisionId: stage.division_id, competitionId: await competitionOf(tx, stage.division_id), removedIds: to < from ? removed.map((f) => f.id) : [] } : null,
    };
  });
  if (write.published) {
    afterScheduleWrite(write.published.divisionId, write.published.competitionId, "schedule", write.published.removedIds);
  }
  return write.result;
}

/**
 * `POST /stages/{id}/swiss/add-round` (X-SW-17, ruling 250): round N + 1, minted for the field it will pair — today's
 * active roster as round N + 1 counts it (a latecomer recorded "after the last round" is in it; a withdrawn player is
 * not). Offered while the Swiss runs and after its final round is paired (ruling 250, not rulebook §7).
 *
 * Refused, nothing written: 404; STAGE_NOT_SWISS 422; SCHEDULE_LOCKED 422; SWISS_OVER 422 `{ canAddRound: false }` once
 * the stage is complete or a later stage is under way; STAGE_NOT_READY for a field under 2; SWISS_ROUNDS_ABOVE_MAX
 * `{ rounds: N + 1, field, hardMax, canFinish }` above the field's hard maximum (carry c1: the NEW total is judged here,
 * through `swissAddRoundState` — the predicate every `canAddRound` reads), 409 when a round is complete (Finish
 * resolves it), else 422.
 *
 * Written: the round's shells (once the stage holds any — before its first Generate only the count is stored), the
 * count, and `swiss_rounds_changed { via: "add_round" }`, an undo barrier.
 */
export async function addSwissRound(auth: AuthCtx, stageId: string): Promise<{ rounds: number; shells_added: number }> {
  const write = await withTenant(auth.orgId, async (tx) => {
    const stage = await lockedSwissStage(tx, stageId);
    const state = await swissAddRoundState(tx, stage);
    const from = state.rounds;
    const to = from + 1;
    const rows = await stageRows(tx, stageId);
    if (state.refusal === "over") throw swissRefusal("SWISS_OVER", { canAddRound: false });
    if (state.refusal === "field") refuseSwissFieldUnderTwo(stageId, state.field ?? 0);
    if (state.refusal === "above_max") {
      const finish = swissFinishDetails(await swissFinishState(tx, stage, rows));
      throw swissRefusal(
        "SWISS_ROUNDS_ABOVE_MAX",
        { rounds: to, field: state.field, hardMax: state.hardMax, ...finish },
        { resolvable: finish.canFinish },
      );
    }

    let added = 0;
    if (rows.length > 0 && !rows.some((f) => f.round_no === to)) {
      const entrants = (await swissStageEntrants(tx, stage)) ?? [];
      added = await mintRoundShells(tx, stage, to, swissFieldForRound(entrants, to).length);
    }
    await tx`update stages set config = config || ${tx.json({ rounds: to } as never)} where id = ${stageId}`;
    await appendRoundsChanged(tx, stage.division_id, { stage_id: stageId, from, to, via: "add_round" }, auth.userId);
    return { rounds: to, added, divisionId: stage.division_id, competitionId: await competitionOf(tx, stage.division_id) };
  });
  afterScheduleWrite(write.divisionId, write.competitionId, "schedule", []);
  return { rounds: write.rounds, shells_added: write.added };
}

export interface FinishSwissResult extends CompleteStageResult {
  /** k: the round whose standings became final. */
  finished_after: number;
  /** The rows of rounds past k deleted (boards and byes, unplayed). */
  shells_removed: number;
  /** How many of them held a laid-out slot (`carrySlots`), freed by the delete. */
  slots_freed: number;
}

/**
 * `POST /stages/{id}/swiss/finish` (W3 T13, RB3-20, X-SW-26): "Finish the Swiss now" — end a running Swiss after round
 * k, the latest round whose seated boards are all decided (`swissFinishState`, the one predicate), and complete the
 * stage, which seeds what follows as usual. The recovery a shrunk field's refusal offers (RB3-4, "Finish after N−1").
 *
 * Refused, nothing written: 404; STAGE_NOT_SWISS 422; SCHEDULE_LOCKED 422 (a frozen timetable, first, outside the
 * predicate); SWISS_OVER 422 `{ canFinish: false }` once the stage is complete or a later stage is under way;
 * SWISS_FINISH_NOTHING_PLAYED 409 before any round is complete; SWISS_FINISH_ROUND_UNDECIDED 409 `{ boards }` when a board
 * past k has started; FIXTURE_HAS_OWN_FORMAT for a removed shell carrying its own format; STAGE_NOT_READY when the stage
 * would not complete on rounds 1..k (reviewer flag R3 — read inside this transaction, so the count never moves on a
 * stage `completeStage` would then leave open).
 *
 * Written, in one transaction under the `division:` lock and the boards' append locks: a paired round past k that
 * nothing in has started is unpaired (`clearSwissFixtureSeats` — its queued invites end `round_voided`) and every row
 * past k is deleted (no evidence: the started read covers each of them), its laid-out slots reported; `config.rounds :=
 * k`; and, when the count moved, `swiss_rounds_changed { via: "finish" }` — an undo barrier, the organiser's, the edit
 * watermark untouched. After it commits, `completeStage`: its own transactions, its own draft seed proposal (a
 * `timing: "setup"` knockout) or draw (`on_complete`).
 */
export async function finishSwissNow(auth: AuthCtx, stageId: string): Promise<FinishSwissResult> {
  const write = await withTenant(auth.orgId, async (tx) => {
    const stage = await lockedSwissStage(tx, stageId);
    // Every row of the stage takes its append lock before the rows are read for the verdict: k reads statuses, and the
    // started read covers every row Finish would clear or delete — a first event in flight commits first and is seen.
    await lockSwissBoardAppends(tx, (await stageRows(tx, stageId)).map((f) => f.id));
    const rows = await stageRows(tx, stageId);
    const state = await swissFinishState(tx, stage, rows);
    if (state.refusal === "over") throw swissRefusal("SWISS_OVER", { canFinish: false });
    if (state.refusal === "nothing_played") throw swissRefusal("SWISS_FINISH_NOTHING_PLAYED", { canFinish: false });
    if (state.refusal === "round_undecided") {
      throw swissRefusal("SWISS_FINISH_ROUND_UNDECIDED", { canFinish: false, inProgress: state.inProgress, boards: state.boards });
    }
    const k = state.finishedAfter;
    const removed = rows.filter((f) => f.round_no > k);
    let slotsFreed = 0;
    if (removed.length > 0) {
      const ids = removed.map((f) => f.id);
      const own = await firstOwnFormat(tx, tx`id in ${tx(ids)}`);
      if (own) throw ownFormatLoss(own);
      // The seat-clear runs on EVERY row going (review m2), before the delete: it ends the queued chess invites that name
      // them (`round_voided`). The outbox holds text seat refs, not foreign keys, so a delete alone would leave an invite
      // to a board that no longer exists to be sent.
      await clearSwissFixtureSeats(tx, ids);
      const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
      slotsFreed = carrySlots(
        removed.map((f) => ({
          round_no: f.round_no,
          seq_in_round: f.seq_in_round,
          pool_id: null,
          ext_key: f.ext_key,
          scheduled_at: iso(f.scheduled_at),
          court_id: f.court_id,
          venue_id: f.venue_id,
          schedule_locked: f.schedule_locked,
        })),
        [],
      ).freed.length;
      await tx`delete from fixtures where id in ${tx(ids)}`;
    }
    if (k !== state.rounds) {
      await tx`update stages set config = config || ${tx.json({ rounds: k } as never)} where id = ${stageId}`;
      await appendRoundsChanged(tx, stage.division_id, { stage_id: stageId, from: state.rounds, to: k, via: "finish" }, auth.userId);
    }
    if (!(await tableStageCompletable(tx, stageId))) {
      throw new EngineError("STAGE_NOT_READY", `swiss: rounds 1..${k} do not complete the stage`, { stageId, finishedAfter: k });
    }
    return {
      k,
      removed: removed.length,
      slotsFreed,
      divisionId: stage.division_id,
      competitionId: await competitionOf(tx, stage.division_id),
      removedIds: removed.map((f) => f.id),
    };
  });
  try {
    const complete = await completeStage(auth, stageId, { publish: false });
    return { ...complete, finished_after: write.k, shells_removed: write.removed, slots_freed: write.slotsFreed };
  } finally {
    // One publish for the finish and the completion behind it (the deleted rows' keys with it), however the second ends.
    afterScheduleWrite(write.divisionId, write.competitionId, "schedule", write.removedIds);
  }
}


/**
 * The desk's read of every Swiss stage of a division (T12 Phase 2): the rail's "Rounds: N · Edit" (editable until
 * `started`), its More menu's "Add a round" (`addRound`, the predicate `addSwissRound` judges by — ruling C11) and the
 * chess switch, each from THE predicate its write refuses by, so what the desk offers is what that predicate lets through
 * (a frozen timetable still refuses first, SCHEDULE_LOCKED — outside these predicates, by the ruled order). A display
 * read: no locks — every write re-judges under its own. Another organisation's division reads as none (RLS). A stage
 * with no valid stored count is left out (no control is offered on a stage its own Generate refuses, CONFIG_INVALID).
 */
export async function listSwissRoundControls(auth: AuthCtx, divisionId: string): Promise<Record<string, SwissRoundControl>> {
  return withTenant(auth.orgId, async (tx) => {
    const stages = await tx<SwissStageRow[]>`
      select id, division_id, seq, status, kind, progression, config from stages
      where division_id = ${divisionId} and kind = 'swiss' order by seq`;
    const out: Record<string, SwissRoundControl> = {};
    for (const stage of stages) {
      const rounds = stage.config.rounds;
      if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1) continue;
      const rows = await stageRows(tx, stage.id);
      const add = await swissAddRoundState(tx, stage);
      const finish = await swissFinishState(tx, stage, rows);
      out[stage.id] = {
        started: await stageHasStarted(tx, stage.id),
        rounds,
        chess: stage.config.chess === true,
        field: await nextPairField(tx, stage, rows),
        addRound: { canAddRound: add.canAddRound, refusal: add.refusal, field: add.field, hardMax: add.hardMax },
        finish: {
          canFinish: finish.canFinish,
          refusal: finish.refusal,
          finishedAfter: finish.finishedAfter,
          inProgress: finish.inProgress,
          completeInstead: finish.completeInstead,
        },
      };
    }
    return out;
  });
}
