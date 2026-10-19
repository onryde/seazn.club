// T16 (D12) — the Open round control's actions as one reducer, and the runner
// that puts them on the network one at a time. Rules R1–R5 are stated with
// their tests in __tests__/open-round-state.test.ts: one request at a time
// across the round's Open and its pairings' Resend; the round is opened only
// from its confirmation; an answer lands only if it answers the request in
// flight; a request in flight holds the dialog; the open's answer is the
// round's notice, a resend's is its pairing's.
import { ApiV1Error } from "@/lib/client-v1";
import type { OpenRoundResult } from "@/lib/open-round";

export type OpenRoundNotice = { kind: "answered"; result: OpenRoundResult } | { kind: "failed"; code: string };
export type ResendNotice = { kind: "resent"; emailed: number } | { kind: "failed"; code: string };

export type OpenRoundUiState = {
  /** The confirmation is up. */
  confirming: boolean;
  /** The one request in flight. */
  busy: null | { kind: "open" } | { kind: "resend"; fixtureId: string };
  /** The answer to the round's last Open. */
  notice: OpenRoundNotice | null;
  /** The answer to the last Resend, on the pairing it was sent for. */
  rowNotice: { fixtureId: string; notice: ResendNotice } | null;
};

type Failed = { ok: false; code: string };

export type OpenRoundUiAction =
  | { type: "ask" }
  | { type: "cancel" }
  | { type: "open" }
  | { type: "resend"; fixtureId: string }
  | { type: "openDone"; outcome: { ok: true; result: OpenRoundResult } | Failed }
  | { type: "resendDone"; fixtureId: string; outcome: { ok: true; emailed: number } | Failed };

export function initialOpenRoundUi(): OpenRoundUiState {
  return { confirming: false, busy: null, notice: null, rowNotice: null };
}

export function openRoundUi(s: OpenRoundUiState, a: OpenRoundUiAction): OpenRoundUiState {
  switch (a.type) {
    case "ask":
      if (s.busy !== null) return s; // R4
      return s.confirming ? s : { ...s, confirming: true };
    case "cancel":
      if (s.busy !== null) return s; // R4
      return s.confirming ? { ...s, confirming: false } : s;
    case "open":
      if (s.busy !== null || !s.confirming) return s; // R1, R2
      return { ...s, busy: { kind: "open" }, notice: null };
    case "resend":
      if (s.busy !== null || s.confirming) return s; // R1 (the dialog is modal)
      return { ...s, busy: { kind: "resend", fixtureId: a.fixtureId }, rowNotice: null };
    case "openDone":
      if (s.busy?.kind !== "open") return s; // R3
      return {
        ...s,
        busy: null,
        confirming: false,
        notice: a.outcome.ok ? { kind: "answered", result: a.outcome.result } : { kind: "failed", code: a.outcome.code },
      };
    case "resendDone":
      if (s.busy?.kind !== "resend" || s.busy.fixtureId !== a.fixtureId) return s; // R3
      return {
        ...s,
        busy: null,
        rowNotice: {
          fixtureId: a.fixtureId,
          notice: a.outcome.ok ? { kind: "resent", emailed: a.outcome.emailed } : { kind: "failed", code: a.outcome.code },
        },
      };
  }
}

/** The requests behind the control, at most one at a time. The reducer refuses
 *  a second press too, but a double tap lands before the re-render that
 *  disables the button — this flag keeps the second request off the network. */
export function openRoundRunner(deps: {
  dispatch: (a: OpenRoundUiAction) => void;
  post: (path: string, body?: unknown) => Promise<unknown>;
  refresh: () => void;
}) {
  let inflight = false;
  const codeOf = (err: unknown) => (err instanceof ApiV1Error ? err.code : "UNKNOWN");
  return {
    open: async (stageId: string, roundNo: number): Promise<boolean> => {
      if (inflight) return false;
      inflight = true;
      deps.dispatch({ type: "open" });
      try {
        const result = (await deps.post(`/api/v1/stages/${encodeURIComponent(stageId)}/open-round`, { roundNo })) as OpenRoundResult;
        deps.dispatch({ type: "openDone", outcome: { ok: true, result } });
        deps.refresh();
      } catch (err) {
        deps.dispatch({ type: "openDone", outcome: { ok: false, code: codeOf(err) } });
      } finally {
        inflight = false;
      }
      return true;
    },
    resend: async (fixtureId: string): Promise<boolean> => {
      if (inflight) return false;
      inflight = true;
      deps.dispatch({ type: "resend", fixtureId });
      try {
        const r = (await deps.post(`/api/v1/fixtures/${encodeURIComponent(fixtureId)}/external-play/resend`, undefined)) as {
          emailed: number;
        };
        deps.dispatch({ type: "resendDone", fixtureId, outcome: { ok: true, emailed: r.emailed } });
        deps.refresh();
      } catch (err) {
        deps.dispatch({ type: "resendDone", fixtureId, outcome: { ok: false, code: codeOf(err) } });
      } finally {
        inflight = false;
      }
      return true;
    },
  };
}
