// W3 app-B Task 6: the twin of app-A's "Finish the Swiss now" verdict, for the fake drivers that stand in for the product.
// ONE implementation, so the twin's Pair refusal (`canFinish`, `finishAfter`) and its Finish route cannot disagree - the
// product's own two emitters read one predicate for the same reason (`swissFinishState`, controller ruling C11).
//
// Restated from the product's text, not invented (this layer may not import apps/web/src/server, boundary.test.ts):
//   usecases/swiss-rounds-admin.ts judgeSwissFinish   - k, the refusal order, `canFinish`, `completeInstead`
//   usecases/swiss-rounds-admin.ts swissBoardStartedSql - what "started" means for a board past k
//   lib/swiss-refusals.ts SWISS_REFUSALS               - each refusal's status and sentence (imported, not typed)
// The statuses and sentences are the table's own, so a new row there moves the twin with it.
import { SWISS_REFUSALS, type SwissRefusalCode } from "../../../apps/web/src/lib/swiss-refusals.ts";
import { RefusedCall } from "../lib/driver/types.ts";

/** swiss-rounds-admin.ts DECIDED: a board the Finish predicate counts as finished. */
const DECIDED = new Set(["decided", "finalized", "forfeited"]);

/** One Swiss row, as the verdict reads it. `seated`: swiss-shell.ts isSwissBoardSeated (an award row, or both seats filled);
 *  `bye`: the stage's bye shell (isSwissByeShellExtKey); `started`: swissBoardStartedSql. */
export interface FinishRow {
  readonly id: string;
  readonly round: number;
  readonly status: string;
  readonly seated: boolean;
  readonly bye: boolean;
  readonly started: boolean;
  /** seq_in_round: the board's number within its round (1-based). */
  readonly board: number;
}

/** A board named by a Finish refusal (swiss-rounds-admin.ts SwissFinishBoard). */
export interface FinishBoard { readonly fixtureId: string; readonly round: number; readonly board: number }

export type FinishRefusal = "over" | "nothing_played" | "round_undecided";

export interface FinishState {
  readonly rounds: number;
  /** k: the latest round whose seated boards are all decided (0: none is). */
  readonly finishedAfter: number;
  readonly refusal: FinishRefusal | null;
  /** A board past k has STARTED, so its round stays ("the round in progress"). */
  readonly inProgress: boolean;
  /** `round_undecided`: the boards to decide first; else []. */
  readonly boards: readonly FinishBoard[];
  /** Every round is decided and Finish would remove nothing: exactly Complete. Nothing offers Finish then. */
  readonly completeInstead: boolean;
  /** `refusal === null` and not `completeInstead`: what every emitter of `canFinish` sends. */
  readonly canFinish: boolean;
}

/** The part of a fake's fixture row the verdict's input is built from. */
export interface FinishFixture { readonly id: string; readonly round_no: number | null; readonly status: string }

/** A fake's rows as `FinishRow`s: the board number is the row's place within its round, in row order. What a fake decides for
 *  itself - which row is the bye shell, which is seated, which holds a result - is passed in, because each of them keeps that
 *  state its own way (the model twin's ledger, the multi-stage fake's events). */
export function finishRowsOf<F extends FinishFixture>(rows: readonly F[], is: { bye(f: F): boolean; seated(f: F): boolean; result(f: F): boolean }): FinishRow[] {
  const next = new Map<number, number>();
  return rows.map((f) => {
    const round = f.round_no ?? 0;
    const board = (next.get(round) ?? 0) + 1;
    next.set(round, board);
    const bye = is.bye(f);
    // swissBoardStartedSql: a result, or a decided board that is not the bye shell.
    return { id: f.id, round, status: f.status, seated: is.seated(f), bye, started: is.result(f) || (DECIDED.has(f.status) && !bye), board };
  });
}

/** judgeSwissFinish, over the twin's rows. */
export function judgeFinish(rows: readonly FinishRow[], rounds: number, over: boolean): FinishState {
  const seatedByRound = new Map<number, FinishRow[]>();
  for (const f of rows) if (f.seated) seatedByRound.set(f.round, [...(seatedByRound.get(f.round) ?? []), f]);
  let k = 0;
  for (const [round, seated] of seatedByRound) {
    // batch-4 ruling 4: a round whose only seated row is the bye was never played, so it is not decided.
    const played = seated.some((f) => !f.bye);
    if (round > k && played && seated.every((f) => DECIDED.has(f.status))) k = round;
  }
  const state = (refusal: FinishRefusal | null, boards: readonly FinishBoard[] = [], inProgress = false, completeInstead = false): FinishState => ({
    rounds, finishedAfter: k, refusal, inProgress, boards, completeInstead, canFinish: refusal === null && !completeInstead,
  });
  if (over) return state("over");
  if (k === 0) return state("nothing_played");
  // The latest round past k with a started board: it and every round before it stay.
  const kept = rows.reduce((m, f) => (f.round > k && f.started ? Math.max(m, f.round) : m), k);
  const shortOfResult = rows.some((f) => f.round <= k && !DECIDED.has(f.status));
  if (kept === k && !shortOfResult) return state(null, [], false, k >= rounds && !rows.some((f) => f.round > k));
  // The refusal names what the organiser decides first: every undecided row of a round <= k, and every undecided seated or
  // started board of a kept round past k; failing both, the started boards past k (planted: a decided round past k makes k larger).
  const owed = rows.filter((f) => !DECIDED.has(f.status) && (f.round <= k || (f.round <= kept && !f.bye && (f.seated || f.started))));
  const named = owed.length > 0 ? owed : rows.filter((f) => f.round > k && f.started);
  const boards = [...named].sort((x, y) => x.round - y.round || x.board - y.board).map((f) => ({ fixtureId: f.id, round: f.round, board: f.board }));
  return state("round_undecided", boards, kept > k);
}

const REFUSAL_CODE: Record<FinishRefusal, SwissRefusalCode> = {
  over: "SWISS_OVER",
  nothing_played: "SWISS_FINISH_NOTHING_PLAYED",
  round_undecided: "SWISS_FINISH_ROUND_UNDECIDED",
};

/** swissRefusal(code, details, { resolvable }): the table row's status (or its resolvable one), the sentence, the details as
 *  the error envelope's extra fields. */
export function swissRefusedCall(method: string, path: string, code: SwissRefusalCode, details: Record<string, unknown>, resolvable = false): RefusedCall {
  const row = SWISS_REFUSALS[code];
  const status = resolvable ? row.resolvableStatus : row.status;
  if (status === undefined) throw new Error(`fake: swiss refusal ${code} declares no resolvable status`);
  return new RefusedCall(method, path, status, code, row.message, null, details);
}

/** finishSwissNow's refusals, in its order, or null when the call goes through. */
export function finishRefusal(path: string, state: FinishState): RefusedCall | null {
  if (state.refusal === null) return null;
  const code = REFUSAL_CODE[state.refusal];
  const details = state.refusal === "round_undecided" ? { canFinish: false, inProgress: state.inProgress, boards: state.boards } : { canFinish: false };
  return swissRefusedCall("POST", path, code, details);
}
