// W3 Task 13 (RB3-20, X-SW-26): "Finish the Swiss now" as the desk says it — which round's standings become final and
// which rounds go — read off the server's own answer, so every door that offers Finish (the stage rail's More item, and
// the recovery under a refusal whose details say `canFinish: true`) confirms the same sentence before anything is sent.
//
// The plan is THE Finish predicate's (`swissFinishState`, server/usecases/swiss-rounds-admin.ts): `after` is k, the
// latest round whose seated boards are all decided; `rounds` is the stored count N. A refusal offering Finish carries it
// as `finish: { after, rounds }` beside `canFinish: true`; the desk's read carries it as `finish.finishedAfter` and the
// stage's `rounds`. Client-safe and pure (the stage rail, the stages panel and the entrants panel import it).
import type { MessageKey } from "./messages";

export interface SwissFinishPlan {
  /** k: the round whose standings become final. */
  after: number;
  /** N: the stored round count; rounds k+1..N are removed. */
  rounds: number;
}

const isRound = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

/** The plan a refusal's details offer, or null when they do not offer Finish (`canFinish` not true, or no plan sent). */
export function swissFinishPlanOf(details: Record<string, unknown> | undefined): SwissFinishPlan | null {
  if (details?.canFinish !== true) return null;
  const finish = details.finish as { after?: unknown; rounds?: unknown } | undefined;
  if (!isRound(finish?.after) || !isRound(finish?.rounds) || finish.after > finish.rounds) return null;
  return { after: finish.after, rounds: finish.rounds };
}

/** `useMsg()` satisfies it. */
export type SwissFinishMsg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/**
 * The confirm's body: "The Swiss ends after round {k}. The table is recalculated as a {k}-round event. Rounds {k+1}–{N} are removed." (one removed round said
 * as one; none when every round is played), and — when rounds go — that the change cannot be undone (the finish appends
 * an undo barrier, SWISS_ROUNDS_CHANGE_NOT_UNDOABLE).
 */
export function swissFinishConfirmBody(plan: SwissFinishPlan, msg: SwissFinishMsg): string {
  const final = msg("stage.finish.confirm.final", { round: plan.after });
  if (plan.after >= plan.rounds) return final;
  const removed =
    plan.after + 1 === plan.rounds
      ? msg("stage.finish.confirm.removeOne", { round: plan.rounds })
      : msg("stage.finish.confirm.removeMany", { from: plan.after + 1, to: plan.rounds });
  return `${final} ${removed} ${msg("swiss.refusal.SWISS_ROUNDS_CHANGE_NOT_UNDOABLE")}`;
}

/** The house confirm (`useConfirm`) for a Finish: danger tone (rounds go for good), phone-sized buttons. */
export function swissFinishConfirm(plan: SwissFinishPlan, msg: SwissFinishMsg) {
  return {
    title: msg("stage.finish.confirm.title"),
    body: swissFinishConfirmBody(plan, msg),
    confirmLabel: msg("stage.finish.confirm.label"),
    cancelLabel: msg("schedule.cancel"),
    tone: "danger" as const,
    size: "touch" as const,
  };
}

/** `useMsgPlural()` satisfies it. */
export type SwissFinishPlural = (key: string, count: number, vars?: Record<string, string | number>) => string;

/** What `POST /stages/{id}/swiss/finish` answers that the panels say. */
export interface SwissFinishAnswer {
  finished_after: number;
  slots_freed: number;
  completed: boolean;
}

/**
 * The notice after a Finish lands, the same in the stages panel and the entrants panel (Fix round 1, reviews m5, m6):
 * "The Swiss finished after round {k}." — or, when the completion behind it did not complete the stage (a round-k result
 * was taken back between the finish and the completion), that the Swiss now ends after round k but is not complete yet —
 * then, when removed rounds held a time or court, the slots freed (as Save and a Rebuild say them).
 */
export function swissFinishedNotice(out: SwissFinishAnswer, msg: SwissFinishMsg, plural: SwissFinishPlural): string {
  const said = msg(out.completed ? "schedule.notice.swissFinished" : "schedule.notice.swissFinishedOpen", { round: out.finished_after });
  return out.slots_freed > 0 ? `${said} ${plural("schedule.notice.roundsSlotsFreed", out.slots_freed)}` : said;
}

/**
 * The Finish door's one refusal that is not a Swiss code: STAGE_NOT_READY, the R3 backstop (the stage could not complete
 * on rounds 1..k — a round k keeps holds no rows). Its wire sentence is English, so it is said here; null for any other
 * code, which keeps its own copy (review I2).
 */
export function swissFinishNotReadyText(code: string | undefined, msg: SwissFinishMsg): string | null {
  return code === "STAGE_NOT_READY" ? msg("stage.finish.notReady") : null;
}
