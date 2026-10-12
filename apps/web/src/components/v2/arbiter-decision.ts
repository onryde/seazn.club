// T15 — the arbiter panel's decision actions as one reducer (canvas "Your
// decision · Board N" and the outage card). The rules it keeps are stated
// with their tests in __tests__/arbiter-decision.test.ts: one request at a
// time; nothing acts without a board on screen; a completion lands only if
// it answers the request in flight; a notice belongs to the board on screen;
// "Let the game go on" writes nothing; the settle disclosure closes on a
// switch.

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
  | { type: "resync" }
  | { type: "override" }
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
      return { ...s, busy: { kind: a.type, boardId: s.boardId }, notice: null };
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
