// T15 — the arbiter panel's decision actions as one reducer (canvas "Your
// decision · Board N" and the outage card). The rules it keeps are stated
// with their tests in __tests__/arbiter-decision.test.ts: one request at a
// time; nothing acts without a board on screen; a completion lands only if
// it answers the request in flight; a notice belongs to the board on screen;
// the settle disclosure closes on a switch.
//
// T16: "Let the game go on" and the settle disclosure's four buttons are
// requests like the others (they used to write nothing). The go-on closes
// exactly the flags on screen when it was pressed (controller ruling A); a
// settle that finishes the board closes the disclosure.
import { ApiV1Error } from "@/lib/client-v1";

export type ArbiterRequestKind = "resync" | "override" | "goOn" | "settle";

/** The buttons of "Settle the result now…" (resolve.ts RESOLVE_KINDS:
 *  restated here because a client component cannot import server code).
 *  `no_result` is the void and `double_walkover` W2b's — each sent by its own
 *  button, so a stale screen is refused rather than given the other (M-7). */
export type SettleChoice = "home_wins" | "away_wins" | "draw" | "no_result" | "double_walkover";

export type ArbiterNotice =
  | { boardId: string; kind: "resynced"; adopted: number }
  | { boardId: string; kind: "resync_nothing" }
  | { boardId: string; kind: "resync_failed"; code: string }
  /** The flags closed; `stillOpen` raised since the screen loaded. */
  | { boardId: string; kind: "went_on"; stillOpen: number }
  | { boardId: string; kind: "go_on_failed"; code: string }
  | { boardId: string; kind: "settled"; status: "finished" | "tiebreak_owed" }
  | { boardId: string; kind: "settle_failed"; code: string }
  | { boardId: string; kind: "overridden" }
  | { boardId: string; kind: "override_failed"; code: string };

export type ArbiterDecisionState = {
  /** The board on screen (a fixture id), or none. */
  boardId: string | null;
  /** The one request in flight, and the board it was sent for. */
  busy: { kind: ArbiterRequestKind; boardId: string } | null;
  settleOpen: boolean;
  notice: ArbiterNotice | null;
};

type Failed = { ok: false; code: string };

export type ArbiterDecisionAction =
  | { type: "select"; boardId: string }
  /** Sent for the board that was on screen when it was pressed. */
  | { type: "resync"; boardId: string }
  | { type: "override"; boardId: string }
  | { type: "goOn"; boardId: string }
  | { type: "settle"; boardId: string }
  | { type: "toggleSettle" }
  | { type: "resyncDone"; boardId: string; outcome: { ok: true; read: boolean; adopted: number } | Failed }
  | { type: "overrideDone"; boardId: string; outcome: { ok: true } | Failed }
  | { type: "goOnDone"; boardId: string; outcome: { ok: true; closed: number; stillOpen: number } | Failed }
  | { type: "settleDone"; boardId: string; outcome: { ok: true; status: "finished" | "tiebreak_owed" } | Failed };

type Done = Extract<ArbiterDecisionAction, { type: "resyncDone" | "overrideDone" | "goOnDone" | "settleDone" }>;
const KIND_OF_DONE: Record<Done["type"], ArbiterRequestKind> = {
  resyncDone: "resync",
  overrideDone: "override",
  goOnDone: "goOn",
  settleDone: "settle",
};

export function initialArbiterDecision(boardId: string | null): ArbiterDecisionState {
  return { boardId, busy: null, settleOpen: false, notice: null };
}

export function arbiterDecision(s: ArbiterDecisionState, a: ArbiterDecisionAction): ArbiterDecisionState {
  switch (a.type) {
    case "select":
      if (a.boardId === s.boardId) return s;
      return { ...s, boardId: a.boardId, settleOpen: false, notice: null };
    case "resync":
    case "override":
    case "goOn":
    case "settle":
      if (s.boardId === null || s.busy !== null) return s;
      // A press that raced a switch is still THE request in flight, so its
      // answer frees the panel (R3); it shows nothing on this board (R4).
      return { ...s, busy: { kind: a.type, boardId: a.boardId }, notice: a.boardId === s.boardId ? null : s.notice };
    case "toggleSettle":
      if (s.boardId === null) return s;
      return { ...s, settleOpen: !s.settleOpen };
    case "resyncDone":
    case "overrideDone":
    case "goOnDone":
    case "settleDone": {
      const kind = KIND_OF_DONE[a.type];
      if (s.busy === null || s.busy.kind !== kind || s.busy.boardId !== a.boardId) return s;
      if (a.boardId !== s.boardId) return { ...s, busy: null };
      // A finished board has nothing left to settle: the disclosure closes.
      const finished = a.type === "settleDone" && a.outcome.ok && a.outcome.status === "finished";
      return { ...s, busy: null, notice: noticeFor(a), settleOpen: finished ? false : s.settleOpen };
    }
  }
}

function noticeFor(a: Done): ArbiterNotice {
  const { boardId } = a;
  switch (a.type) {
    case "resyncDone":
      if (!a.outcome.ok) return { boardId, kind: "resync_failed", code: a.outcome.code };
      return a.outcome.read ? { boardId, kind: "resynced", adopted: a.outcome.adopted } : { boardId, kind: "resync_nothing" };
    case "overrideDone":
      return a.outcome.ok ? { boardId, kind: "overridden" } : { boardId, kind: "override_failed", code: a.outcome.code };
    case "goOnDone":
      return a.outcome.ok ? { boardId, kind: "went_on", stillOpen: a.outcome.stillOpen } : { boardId, kind: "go_on_failed", code: a.outcome.code };
    case "settleDone":
      return a.outcome.ok ? { boardId, kind: "settled", status: a.outcome.status } : { boardId, kind: "settle_failed", code: a.outcome.code };
  }
}

/** The requests behind the decision buttons, sent at most one at a time.
 *  The reducer refuses a second press too, but a double tap lands before the
 *  re-render that disables the button — this guard is what keeps the second
 *  request off the network. */
export function decisionRunner(deps: {
  dispatch: (a: ArbiterDecisionAction) => void;
  post: (path: string, body?: unknown) => Promise<unknown>;
  refresh: () => void;
  overrideNote: string;
}) {
  let inflight = false;
  const path = (boardId: string, tail: string) => `/api/v1/fixtures/${encodeURIComponent(boardId)}/external-play/${tail}`;
  const run = async (
    kind: ArbiterRequestKind,
    boardId: string,
    send: () => Promise<Done>,
    failed: (code: string) => Done,
  ): Promise<boolean> => {
    if (inflight) return false;
    inflight = true;
    deps.dispatch({ type: kind, boardId });
    try {
      deps.dispatch(await send());
      deps.refresh();
    } catch (err) {
      deps.dispatch(failed(err instanceof ApiV1Error ? err.code : "UNKNOWN"));
    } finally {
      inflight = false;
    }
    return true;
  };
  return {
    resync: (boardId: string) =>
      run(
        "resync",
        boardId,
        async () => {
          const r = (await deps.post(path(boardId, "resync"))) as { read: boolean; adopted: number };
          return { type: "resyncDone", boardId, outcome: { ok: true, read: r.read, adopted: r.adopted } };
        },
        (code) => ({ type: "resyncDone", boardId, outcome: { ok: false, code } }),
      ),
    override: (boardId: string) =>
      run(
        "override",
        boardId,
        async () => {
          await deps.post(path(boardId, "video-override"), { note: deps.overrideNote });
          return { type: "overrideDone", boardId, outcome: { ok: true } };
        },
        (code) => ({ type: "overrideDone", boardId, outcome: { ok: false, code } }),
      ),
    /** "Let the game go on" for the flags on screen — their ids, as shown. */
    goOn: (boardId: string, flagIds: readonly string[]) =>
      run(
        "goOn",
        boardId,
        async () => {
          const r = (await deps.post(path(boardId, "flags/close"), { ids: [...flagIds] })) as { closed: number; stillOpen: number };
          return { type: "goOnDone", boardId, outcome: { ok: true, closed: r.closed, stillOpen: r.stillOpen } };
        },
        (code) => ({ type: "goOnDone", boardId, outcome: { ok: false, code } }),
      ),
    settle: (boardId: string, kind: SettleChoice) =>
      run(
        "settle",
        boardId,
        async () => {
          const r = (await deps.post(path(boardId, "resolve"), { kind })) as { status: "finished" | "tiebreak_owed" };
          return { type: "settleDone", boardId, outcome: { ok: true, status: r.status } };
        },
        (code) => ({ type: "settleDone", boardId, outcome: { ok: false, code } }),
      ),
  };
}
