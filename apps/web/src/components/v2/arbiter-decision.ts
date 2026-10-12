// T15 — the arbiter panel's decision actions as one reducer (canvas "Your
// decision · Board N" and the outage card). The rules it keeps are stated
// with their tests in __tests__/arbiter-decision.test.ts: one request at a
// time; nothing acts without a board on screen; a completion lands only if
// it answers the request in flight; a notice belongs to the board on screen;
// "Let the game go on" writes nothing; the settle disclosure closes on a
// switch.
import { ApiV1Error } from "@/lib/client-v1";

export type ArbiterRequestKind = "resync" | "override";

export type ArbiterNotice =
  | { boardId: string; kind: "resynced"; adopted: number }
  | { boardId: string; kind: "resync_nothing" }
  | { boardId: string; kind: "resync_failed"; code: string }
  | { boardId: string; kind: "went_on" }
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

export type ArbiterDecisionAction =
  | { type: "select"; boardId: string }
  /** Sent for the board that was on screen when it was pressed. */
  | { type: "resync"; boardId: string }
  | { type: "override"; boardId: string }
  | { type: "goOn" }
  | { type: "toggleSettle" }
  | {
      type: "resyncDone";
      boardId: string;
      outcome: { ok: true; read: boolean; adopted: number } | { ok: false; code: string };
    }
  | { type: "overrideDone"; boardId: string; outcome: { ok: true } | { ok: false; code: string } };

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
      if (s.boardId === null || s.busy !== null) return s;
      // A press that raced a switch is still THE request in flight, so its
      // answer frees the panel (R3); it shows nothing on this board (R4).
      return { ...s, busy: { kind: a.type, boardId: a.boardId }, notice: a.boardId === s.boardId ? null : s.notice };
    case "goOn":
      if (s.boardId === null || s.busy !== null) return s;
      return { ...s, settleOpen: false, notice: { boardId: s.boardId, kind: "went_on" } };
    case "toggleSettle":
      if (s.boardId === null) return s;
      return { ...s, settleOpen: !s.settleOpen };
    case "resyncDone":
    case "overrideDone": {
      const kind: ArbiterRequestKind = a.type === "resyncDone" ? "resync" : "override";
      if (s.busy === null || s.busy.kind !== kind || s.busy.boardId !== a.boardId) return s;
      if (a.boardId !== s.boardId) return { ...s, busy: null };
      return { ...s, busy: null, notice: noticeFor(a) };
    }
  }
}

function noticeFor(a: Extract<ArbiterDecisionAction, { type: "resyncDone" | "overrideDone" }>): ArbiterNotice {
  const { boardId } = a;
  if (a.type === "resyncDone") {
    if (!a.outcome.ok) return { boardId, kind: "resync_failed", code: a.outcome.code };
    return a.outcome.read ? { boardId, kind: "resynced", adopted: a.outcome.adopted } : { boardId, kind: "resync_nothing" };
  }
  return a.outcome.ok ? { boardId, kind: "overridden" } : { boardId, kind: "override_failed", code: a.outcome.code };
}

/** The two requests behind the decision buttons, sent at most one at a time.
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
  const run = async (kind: ArbiterRequestKind, boardId: string): Promise<boolean> => {
    if (inflight) return false;
    inflight = true;
    deps.dispatch({ type: kind, boardId });
    const path = `/api/v1/fixtures/${encodeURIComponent(boardId)}/external-play/${kind === "resync" ? "resync" : "video-override"}`;
    try {
      if (kind === "resync") {
        const r = (await deps.post(path)) as { read: boolean; adopted: number };
        deps.dispatch({ type: "resyncDone", boardId, outcome: { ok: true, read: r.read, adopted: r.adopted } });
      } else {
        await deps.post(path, { note: deps.overrideNote });
        deps.dispatch({ type: "overrideDone", boardId, outcome: { ok: true } });
      }
      deps.refresh();
    } catch (err) {
      const code = err instanceof ApiV1Error ? err.code : "UNKNOWN";
      deps.dispatch(
        kind === "resync"
          ? { type: "resyncDone", boardId, outcome: { ok: false, code } }
          : { type: "overrideDone", boardId, outcome: { ok: false, code } },
      );
    } finally {
      inflight = false;
    }
    return true;
  };
  return {
    resync: (boardId: string) => run("resync", boardId),
    override: (boardId: string) => run("override", boardId),
  };
}
