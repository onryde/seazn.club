// The check-in extension's client half (spec 2026-10-09 §3.2.2): the words and the requests the two screens that offer it share -
// the arbiter panel (a "+5 min" per board, a "+5 min to the round" at the top) and the organiser's Open round control (the same
// round button). The RULE is the server's (`extendRefusal`): a screen offers a press only on what the server's own reading said
// it would accept (`ArbiterBoard.checkin`, `round.extendableBoards`) and never decides it again here.
//
// Pure TypeScript, no React: the reducers and the runner are tested without a DOM (apps/web vitest is node-only).
import { ApiV1Error } from "@/lib/client-v1";
import {
  CHECKIN_EXTEND_STEP_MINUTES,
  EXTEND_REFUSALS,
  EXTEND_REFUSAL_CODES,
  EXTEND_REFUSAL_KEYS,
  EXTEND_ROUND_SKIP_COPY,
  type CheckinExtendBoardResult,
  type CheckinExtendRoundResult,
} from "@/lib/checkin-extend";

type Vars = Record<string, string | number>;

/** What the copy needs from either screen's translator: the plain lookup, the plural lookup and the time of day in the viewer's
 *  own zone (`null` before mount). The arbiter panel hands its `Fmt`; the Open round control hands `useMsg` and `fmtTime`. */
export type ExtendCopy = {
  t: (key: string, vars?: Vars) => string;
  plural: (key: string, count: number, vars?: Vars) => string;
  hm: (iso: string) => string | null;
};

export const extendBoardPath = (fixtureId: string) => `/api/v1/fixtures/${encodeURIComponent(fixtureId)}/external-play/extend-checkin`;
export const extendRoundPath = (stageId: string) => `/api/v1/stages/${encodeURIComponent(stageId)}/extend-checkin`;

/** The button's label: "+5 min (2 left)". */
export const extendBoardLabel = (left: number, c: ExtendCopy) => c.t("externalPlay.checkinExtend.board", { minutes: CHECKIN_EXTEND_STEP_MINUTES, left });
export const extendRoundLabel = (c: ExtendCopy) => c.t("externalPlay.checkinExtend.round", { minutes: CHECKIN_EXTEND_STEP_MINUTES });

/** "Check-in closes 19:14" - the deadline a board is on. Null before the viewer's clock is known. */
export function extendClosesLine(deadlineAt: string, c: ExtendCopy): string | null {
  const time = c.hm(deadlineAt);
  return time === null ? null : c.t("externalPlay.checkinExtend.closesAt", { time });
}

/** The answer to ONE board's press: "Added 5 minutes to board 3. Check-in now closes 19:14." */
export function extendBoardSentence(r: CheckinExtendBoardResult, boardNo: number, c: ExtendCopy): string {
  return c.t("externalPlay.checkinExtend.notice.board", { minutes: r.addedMinutes, n: boardNo, time: c.hm(r.deadlineAt) ?? "" });
}

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
  | { type: "extendDone"; outcome: { ok: true; result: CheckinExtendRoundResult } | { ok: false; code: string } };

export const initialRoundExtend = (): RoundExtendState => ({ busy: false, notice: null });

export function roundExtendUi(s: RoundExtendState, a: RoundExtendAction): RoundExtendState {
  switch (a.type) {
    case "extend":
      return s.busy ? s : { busy: true, notice: null };
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
