// T16 (D12) — the Open round control's actions as one reducer, and the runner
// that puts them on the network one at a time. Rules R1–R5 are stated with
// their tests in __tests__/open-round-state.test.ts: one request at a time
// across the round's Open and its pairings' Resend; the round is opened only
// from its confirmation; an answer lands only if it answers the request in
// flight; a request in flight holds the dialog; the open's answer is the
// round's notice, a resend's is its pairing's.
//
// Spec §3.2.2: "+5 min to the round" is a request like the Open and the Resend - one at a time with them - and its answer is the
// round's second notice (`extendNotice`), kept apart from the Open's so neither wipes the other's.
import type { OpenRoundResult } from "@/lib/open-round";
import type { CheckinExtendRoundResult } from "@/lib/checkin-extend";
import { codeOf, requestRoundExtend, type RoundExtendNotice } from "../checkin-extend-ui";

export type OpenRoundNotice = { kind: "answered"; result: OpenRoundResult } | { kind: "failed"; code: string };
/** `emailed` invites the provider took; `retrying` invites queued and still sending (the mail worker keeps trying). Both zero is the
 *  one true failure: nothing went out and nothing is waiting to. */
export type ResendNotice = { kind: "resent"; emailed: number; retrying: number } | { kind: "failed"; code: string };

export type OpenRoundUiState = {
  /** The confirmation is up. */
  confirming: boolean;
  /** The one request in flight. */
  busy: null | { kind: "open" } | { kind: "resend"; fixtureId: string } | { kind: "extend" };
  /** The answer to the round's last Open. */
  notice: OpenRoundNotice | null;
  /** The answer to the last Resend, on the pairing it was sent for. */
  rowNotice: { fixtureId: string; notice: ResendNotice } | null;
  /** The answer to the last "+5 min to the round". */
  extendNotice: RoundExtendNotice | null;
};

type Failed = { ok: false; code: string };

export type OpenRoundUiAction =
  | { type: "reset" }
  | { type: "ask" }
  | { type: "cancel" }
  | { type: "open" }
  | { type: "resend"; fixtureId: string }
  | { type: "extend" }
  | { type: "extendDone"; outcome: { ok: true; result: CheckinExtendRoundResult } | Failed }
  | { type: "openDone"; outcome: { ok: true; result: OpenRoundResult } | Failed }
  | { type: "resendDone"; fixtureId: string; outcome: { ok: true; emailed: number; retrying: number } | Failed };

export function initialOpenRoundUi(): OpenRoundUiState {
  return { confirming: false, busy: null, notice: null, rowNotice: null, extendNotice: null };
}

export function openRoundUi(s: OpenRoundUiState, a: OpenRoundUiAction): OpenRoundUiState {
  switch (a.type) {
    case "reset":
      // The round on screen changed (use-open-round.ts): nothing asked, held or answered for the old one survives, and an
      // answer still in flight for it finds no request to answer (R3) and is dropped.
      return initialOpenRoundUi();
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
    case "extend":
      if (s.busy !== null || s.confirming) return s; // R1 (the dialog is modal)
      return { ...s, busy: { kind: "extend" }, extendNotice: null };
    case "extendDone":
      if (s.busy?.kind !== "extend") return s; // R3
      return {
        ...s,
        busy: null,
        extendNotice: a.outcome.ok ? { kind: "answered", result: a.outcome.result } : { kind: "failed", code: a.outcome.code },
      };
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
          notice: a.outcome.ok
            ? { kind: "resent", emailed: a.outcome.emailed, retrying: a.outcome.retrying }
            : { kind: "failed", code: a.outcome.code },
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
  return {
    /** "+5 min to the round" (spec §3.2.2): every board of it whose check-in is open. */
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
          retrying: number;
        };
        deps.dispatch({ type: "resendDone", fixtureId, outcome: { ok: true, emailed: r.emailed, retrying: r.retrying } });
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
