// Match Day online, Task 7 - the round panel's two presses that are not the open round's (that one is desk/use-open-round.ts's, with its
// reducer in desk/open-round-state.ts): a board's "+5 min" from the "Not here yet" list, and the Swiss stage's "Pair next round" (owner
// MD-R15). Pure TypeScript, no React: the reducers and the runners are tested without a DOM (apps/web vitest is node-only), the way
// open-round-state.ts and checkin-extend-ui.ts are. Their presses are START writes (`mayPress(reader, "start")`), so each can also be
// answered 402 by the billing freeze, which the panel words as the freeze and never as "failed".
//
// Each runner holds ONE request at a time with an in-flight flag: a double tap lands before the re-render that disables the button, and
// the flag is what keeps the second request off the network. The runner lives for the life of the panel (a `useMemo` over stable deps),
// never rebuilt by a poll.
import { ApiV1Error } from "@/lib/client-v1";
import type { CheckinExtendBoardResult } from "@/lib/checkin-extend";
import { nextRoundNoticeOf, type NextRoundNotice } from "@/lib/swiss-next-round";
import { codeOf, extendBoardPath } from "../checkin-extend-ui";

type Post = (path: string, body?: unknown) => Promise<unknown>;

// ---- a board's "+5 min" ------------------------------------------------------------------------------------------------------------

/** The answer to the last press, on the board it was pressed for. */
export type BoardExtendNotice = { fixtureId: string; boardNo: number } & (
  | { kind: "answered"; result: CheckinExtendBoardResult }
  | { kind: "failed"; code: string }
);
/** `busy` is the fixture id of the request in flight. */
export type BoardExtendState = { busy: string | null; notice: BoardExtendNotice | null };
export type BoardExtendAction =
  | { type: "extend"; fixtureId: string }
  /** The round's own "+5 min" started or the round on screen changed: this answer is about deadlines that have since moved. */
  | { type: "clear" }
  | { type: "done"; fixtureId: string; boardNo: number; outcome: { ok: true; result: CheckinExtendBoardResult } | { ok: false; code: string } };

export const initialBoardExtend = (): BoardExtendState => ({ busy: null, notice: null });

export function boardExtendUi(s: BoardExtendState, a: BoardExtendAction): BoardExtendState {
  switch (a.type) {
    case "extend":
      return s.busy !== null ? s : { busy: a.fixtureId, notice: null };
    case "clear":
      return s.notice === null ? s : { ...s, notice: null };
    case "done":
      if (s.busy !== a.fixtureId) return s; // an answer lands only if it answers the request in flight
      return {
        busy: null,
        notice: a.outcome.ok
          ? { fixtureId: a.fixtureId, boardNo: a.boardNo, kind: "answered", result: a.outcome.result }
          : { fixtureId: a.fixtureId, boardNo: a.boardNo, kind: "failed", code: a.outcome.code },
      };
  }
}

export function boardExtendRunner(deps: { dispatch: (a: BoardExtendAction) => void; post: Post; refresh: () => void }) {
  let inflight = false;
  return {
    extend: async (fixtureId: string, boardNo: number): Promise<boolean> => {
      if (inflight) return false;
      inflight = true;
      deps.dispatch({ type: "extend", fixtureId });
      try {
        const result = (await deps.post(extendBoardPath(fixtureId))) as CheckinExtendBoardResult;
        deps.dispatch({ type: "done", fixtureId, boardNo, outcome: { ok: true, result } });
        deps.refresh();
      } catch (err) {
        deps.dispatch({ type: "done", fixtureId, boardNo, outcome: { ok: false, code: codeOf(err) } });
      } finally {
        inflight = false;
      }
      return true;
    },
  };
}

// ---- Pair next round (MD-R15) ------------------------------------------------------------------------------------------------------

/** The stage's own generate route answers a Pair next with how many boards it made; what the panel says is that the round is paired,
 *  plus the engine's look-ahead caution when the answer carries one (`swiss_next_round`, W3 app-B T7). A refusal keeps its code and its
 *  details (`extra`): a Swiss refusal is worded from them (`swissRefusalText`), the freeze by its code. */
export type PairNextNotice =
  | { kind: "paired"; round: number; caution: NextRoundNotice | null }
  | { kind: "failed"; code: string; extra: Record<string, unknown> };
export type PairNextState = { busy: boolean; notice: PairNextNotice | null };
export type PairNextAction =
  | { type: "pair" }
  | { type: "done"; outcome: { ok: true; round: number; caution: NextRoundNotice | null } | { ok: false; code: string; extra: Record<string, unknown> } };

export const initialPairNext = (): PairNextState => ({ busy: false, notice: null });

export function pairNextUi(s: PairNextState, a: PairNextAction): PairNextState {
  switch (a.type) {
    case "pair":
      return s.busy ? s : { busy: true, notice: null };
    case "done":
      if (!s.busy) return s; // an answer lands only if it answers the request in flight
      return {
        busy: false,
        notice: a.outcome.ok
          ? { kind: "paired", round: a.outcome.round, caution: a.outcome.caution }
          : { kind: "failed", code: a.outcome.code, extra: a.outcome.extra },
      };
  }
}

/** The route the stage rail's own "Pair next round" presses (stages-panel.tsx `act(stageId, "generate")`): no second server path. */
export const pairNextPath = (stageId: string): string => `/api/v1/stages/${encodeURIComponent(stageId)}/generate`;

export function pairNextRunner(deps: { dispatch: (a: PairNextAction) => void; post: Post; refresh: () => void }) {
  let inflight = false;
  return {
    /** `round`: the round the press is expected to seat (the panel's `pairNextRound`); the answer's own `swiss_paired_round` wins when it names one. */
    pair: async (stageId: string, round: number): Promise<boolean> => {
      if (inflight) return false;
      inflight = true;
      deps.dispatch({ type: "pair" });
      try {
        // `{}` is the body of every ordinary press: the server applies its own default pairing.
        const out = (await deps.post(pairNextPath(stageId), {})) as { swiss_paired_round?: unknown; swiss_next_round?: unknown } | null;
        const paired = out !== null && typeof out === "object" && typeof out.swiss_paired_round === "number" ? out.swiss_paired_round : round;
        deps.dispatch({ type: "done", outcome: { ok: true, round: paired, caution: out === null || typeof out !== "object" ? null : nextRoundNoticeOf(out) } });
        deps.refresh();
      } catch (err) {
        deps.dispatch({
          type: "done",
          outcome: err instanceof ApiV1Error ? { ok: false, code: err.code, extra: err.extra } : { ok: false, code: "UNKNOWN", extra: {} },
        });
      } finally {
        inflight = false;
      }
      return true;
    },
  };
}
