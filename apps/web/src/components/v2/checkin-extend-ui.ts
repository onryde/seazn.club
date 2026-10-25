// The check-in extension's client half (spec 2026-10-09 §3.2.2): the words and the requests the two screens that offer it share -
// the arbiter panel (a "+5 min" per board, a "+5 min to the round" at the top) and the organiser's Open round control (the same
// round button). The RULE is the server's (`extendRefusal`): a screen offers a press only on what the server's own reading said
// it would accept (`ArbiterBoard.checkin`, `round.extendableBoards`) and never decides it again here.
//
// Pure TypeScript, no React: the reducers and the runner are tested without a DOM (apps/web vitest is node-only).
import { ApiV1Error } from "@/lib/client-v1";
import {
  CHECKIN_EXTEND_MAX,
  CHECKIN_EXTEND_STEP_MINUTES,
  EXTEND_REFUSALS,
  EXTEND_REFUSAL_CODES,
  EXTEND_REFUSAL_KEYS,
  EXTEND_ROUND_SKIP_COPY,
  EXTEND_WHY_KEYS,
  liveExtendRefusal,
  roundWhy,
  type CheckinExtendBoardResult,
  type CheckinExtendRoundResult,
  type CheckinExtendState,
  type ExtendRefusal,
  type RoundWhy,
} from "@/lib/checkin-extend";

type Vars = Record<string, string | number>;

/** What the copy needs from either screen's translator: the plain lookup, the plural lookup and the time of day (`null` before mount).
 *  The arbiter panel hands its `Fmt`, whose times are the VENUE's zone, named when the viewer's own offset differs (Task 16 D1); the
 *  Open round control hands `useMsg` and the venue clock. */
export type ExtendCopy = {
  t: (key: string, vars?: Vars) => string;
  plural: (key: string, count: number, vars?: Vars) => string;
  hm: (iso: string) => string | null;
};

export const extendBoardPath = (fixtureId: string) => `/api/v1/fixtures/${encodeURIComponent(fixtureId)}/external-play/extend-checkin`;
export const extendRoundPath = (stageId: string) => `/api/v1/stages/${encodeURIComponent(stageId)}/extend-checkin`;

/** The button's label: "+5 min (2 left)". */
export const extendBoardLabel = (left: number, c: Pick<ExtendCopy, "t">) => c.t("externalPlay.checkinExtend.board", { minutes: CHECKIN_EXTEND_STEP_MINUTES, left });
export const extendRoundLabel = (c: ExtendCopy) => c.t("externalPlay.checkinExtend.round", { minutes: CHECKIN_EXTEND_STEP_MINUTES });

/** "Check-in closes 19:14" - the deadline a board is on. Null before the viewer's clock is known. */
export function extendClosesLine(deadlineAt: string, c: ExtendCopy): string | null {
  const time = c.hm(deadlineAt);
  return time === null ? null : c.t("externalPlay.checkinExtend.closesAt", { time });
}

/** The later of two ISO instants. */
export const laterIso = (a: string, b: string): string => (Date.parse(a) >= Date.parse(b) ? a : b);

/** The time a board's "Added 5 minutes" answer names: never one that differs from the board's LIVE deadline. The answer carries the
 *  deadline the press made, and the board's own check-in line carries the deadline the panel last read; once the panel has caught up
 *  they are the same instant and the sentence reads the board's. Until it has (the refresh after a press is a moment behind), the
 *  press's own is the newer of the two and is the true one - and when the board has been extended since (another arbiter, or a round
 *  press) the live one is. The sentence therefore never names a time earlier than the board's own line says. */
export function extendedNoticeTime(resultDeadlineAt: string, liveDeadlineAt: string | null): string {
  return liveDeadlineAt === null ? resultDeadlineAt : laterIso(resultDeadlineAt, liveDeadlineAt);
}

/** The answer to ONE board's press: "Added 5 minutes to board 3. Check-in now closes 19:14." `liveDeadlineAt`: the board's deadline as
 *  the screen reads it now (`board.checkin.deadlineAt`), so the sentence cannot contradict the "Check-in closes" line beside it. */
export function extendBoardSentence(r: CheckinExtendBoardResult, boardNo: number, c: ExtendCopy, liveDeadlineAt: string | null = null): string {
  return c.t("externalPlay.checkinExtend.notice.board", {
    minutes: r.addedMinutes,
    n: boardNo,
    time: c.hm(extendedNoticeTime(r.deadlineAt, liveDeadlineAt)) ?? "",
  });
}

/** The helper line under either "+5 min" button: what a press does and the limits, from the constants (never retyped). */
export const extendHelperLine = (c: ExtendCopy) =>
  c.t("externalPlay.checkinExtend.helper", { minutes: CHECKIN_EXTEND_STEP_MINUTES, max: CHECKIN_EXTEND_MAX });

/** The short reason shown where a board's "+5 min" is not offered, or null when it says nothing (a board that is over). */
export function extendWhyLine(refusal: ExtendRefusal, c: ExtendCopy): string | null {
  const key = EXTEND_WHY_KEYS[refusal];
  return key === null ? null : c.t(key);
}

/** What the board's "+5 min" is, on the screen's ticking clock: the refusal now (null: offered), its words, and the snapshot's
 *  numbers. `nowMs` null (before the viewer's clock is known): the server's own reading of the snapshot stands. */
export function boardExtendOffer(
  checkin: CheckinExtendState | null,
  nowMs: number | null,
): { refusal: ExtendRefusal | null; offered: boolean } | null {
  if (checkin === null) return null;
  const refusal = nowMs === null ? checkin.refusal : liveExtendRefusal(checkin, nowMs);
  return { refusal, offered: refusal === null };
}

/** How many of a round's boards a round-wide press would reach at `nowMs` (the arbiter panel lists every board with its check-in). */
export function liveExtendableBoards(boards: readonly { checkin: CheckinExtendState | null }[], nowMs: number | null, snapshotCount: number): number {
  if (nowMs === null) return snapshotCount;
  return boards.filter((b) => b.checkin !== null && liveExtendRefusal(b.checkin, nowMs) === null).length;
}

/** Why the round has no "+5 min to the round" on the arbiter panel at `nowMs`: the panel lists every board with its check-in, so each
 *  is asked in turn (the snapshot's own word before the viewer's clock is known, the clock's after). Null while any board would accept
 *  a press, and when no board has a reason to give (`roundWhy`). */
export function roundExtendWhy(boards: readonly { checkin: CheckinExtendState | null }[], nowMs: number | null): RoundWhy | null {
  return roundWhy(boards.flatMap((b) => (b.checkin === null ? [] : [nowMs === null ? b.checkin.refusal : liveExtendRefusal(b.checkin, nowMs)])));
}

/** The words of a round's reason. */
export const roundWhyLine = (why: RoundWhy, c: ExtendCopy): string => c.t(why.key);

/** The answer to a ROUND press, one line for what was done and one for each reason a board was left alone, only the reasons that
 *  happened: ["Added 5 minutes to 6 boards.", "2 boards skipped: game started"]. */
export function extendRoundLines(r: CheckinExtendRoundResult, c: ExtendCopy): string[] {
  const head =
    r.extended > 0
      ? c.plural("externalPlay.checkinExtend.notice.round", r.extended, { minutes: r.addedMinutes })
      : c.t("externalPlay.checkinExtend.notice.roundNone");
  const reasons: [number, string][] = [
    [r.skipped.closed, EXTEND_ROUND_SKIP_COPY.closed],
    [r.skipped.gameStarted, EXTEND_ROUND_SKIP_COPY.gameStarted],
    [r.skipped.capReached, EXTEND_ROUND_SKIP_COPY.capReached],
    [r.notOpenYet, EXTEND_ROUND_SKIP_COPY.notOpenYet],
    [r.ownBoards, EXTEND_ROUND_SKIP_COPY.ownBoards],
    [r.failed, EXTEND_ROUND_SKIP_COPY.failed],
  ];
  return [head, ...reasons.filter(([n]) => n > 0).map(([n, key]) => c.plural(key, n))];
}

/** Why a press was refused, by the door's own code. Anything else is a failure to try again. */
export function extendFailureText(code: string, c: ExtendCopy): string {
  const refusal = EXTEND_REFUSALS.find((r) => EXTEND_REFUSAL_CODES[r] === code);
  if (refusal !== undefined) return c.t(EXTEND_REFUSAL_KEYS[refusal]);
  if (code === "ARBITER_PLAYS_THIS_BOARD") return c.t("externalPlay.checkinExtend.refused.playsThis");
  if (code === "ROUND_NOT_OPEN") return c.t("externalPlay.checkinExtend.refused.roundNotOpen");
  return c.t("externalPlay.checkinExtend.refused.failed");
}

// ── the round-wide press ────────────────────────────────────────────────────────────────────────────────────────────────────
export type RoundExtendNotice = { kind: "answered"; result: CheckinExtendRoundResult } | { kind: "failed"; code: string };

/** The round press as the arbiter panel keeps it (the Open round control keeps the same two facts in its own reducer, which also
 *  holds the Open and the Resend to one request at a time). */
export type RoundExtendState = { busy: boolean; notice: RoundExtendNotice | null };
export type RoundExtendAction =
  | { type: "extend" }
  /** Another extend action (a board's "+5 min") started, or the round on screen changed: the answer on screen is no longer about
   *  what is there. */
  | { type: "clear" }
  | { type: "extendDone"; outcome: { ok: true; result: CheckinExtendRoundResult } | { ok: false; code: string } };

export const initialRoundExtend = (): RoundExtendState => ({ busy: false, notice: null });

export function roundExtendUi(s: RoundExtendState, a: RoundExtendAction): RoundExtendState {
  switch (a.type) {
    case "extend":
      return s.busy ? s : { busy: true, notice: null };
    case "clear":
      return s.notice === null ? s : { ...s, notice: null };
    case "extendDone":
      if (!s.busy) return s; // an answer lands only if it answers the request in flight
      return { busy: false, notice: a.outcome.ok ? { kind: "answered", result: a.outcome.result } : { kind: "failed", code: a.outcome.code } };
  }
}

export const codeOf = (err: unknown): string => (err instanceof ApiV1Error ? err.code : "UNKNOWN");

/** The request itself: POST the round to the extend route. Throws what the client throws (an `ApiV1Error` carries the door's code). */
export async function requestRoundExtend(
  post: (path: string, body?: unknown) => Promise<unknown>,
  stageId: string,
  roundNo: number,
): Promise<CheckinExtendRoundResult> {
  return (await post(extendRoundPath(stageId), { roundNo })) as CheckinExtendRoundResult;
}

/** The round press behind the arbiter panel's button, one at a time. The reducer refuses a second press too, but a double tap
 *  lands before the re-render that disables the button - this flag keeps the second request off the network. */
export function roundExtendRunner(deps: {
  dispatch: (a: RoundExtendAction) => void;
  post: (path: string, body?: unknown) => Promise<unknown>;
  refresh: () => void;
}) {
  let inflight = false;
  return {
    extend: async (stageId: string, roundNo: number): Promise<boolean> => {
      if (inflight) return false;
      inflight = true;
      deps.dispatch({ type: "extend" });
      try {
        const result = await requestRoundExtend(deps.post, stageId, roundNo);
        deps.dispatch({ type: "extendDone", outcome: { ok: true, result } });
        deps.refresh();
      } catch (err) {
        deps.dispatch({ type: "extendDone", outcome: { ok: false, code: codeOf(err) } });
      } finally {
        inflight = false;
      }
      return true;
    },
  };
}

/** The two "+5 min" presses share one panel and answer in two places (a board's notice, the round's bar): starting either clears the
 *  OTHER's answer, whose counts or time are about deadlines the press has just moved. The panel hands each runner the dispatch this
 *  returns for it. `board` and `round` are the two reducers' dispatches. */
export function linkedExtendDispatch<B extends { type: string }>(
  board: (a: B | { type: "clearExtend" }) => void,
  round: (a: RoundExtendAction) => void,
): { forBoard: (a: B) => void; forRound: (a: RoundExtendAction) => void } {
  return {
    forBoard: (a) => {
      if (a.type === "extend") round({ type: "clear" });
      board(a);
    },
    forRound: (a) => {
      if (a.type === "extend") board({ type: "clearExtend" });
      round(a);
    },
  };
}
