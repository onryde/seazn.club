"use client";

// The Open / Resend / "+5 min" press of ONE round, lifted out of OpenRoundControl so the arbiter column presses the very
// same thing. It owns what the control used to own: the reducer (open-round-state.ts, rules R1-R5: one request at a time,
// the open only from its confirmation), the router, and the runner that puts each request on the network with an `apiV1`
// POST and a `router.refresh()` after the answer. A second caller reads the same state and calls the same five presses.
//
// The state belongs to ONE round. It is reset when the round on screen changes - a different stage or round number, or none at
// all (`view` null is its own identity) - and NOT when the same round is redrawn with fresh data, because a poll must not close
// the dialog the organiser is reading. Without that, a confirmation opened for round 7 would survive the round advancing to 8
// and `open()` would send a round nobody confirmed, and round 7's notices would sit under round 8. A request still in flight
// for the old round answers into a reset reducer, which drops it (R3).
//
// The runner lives for the life of the component, not of the round on screen: its in-flight flag is what keeps a double tap
// off the network (a tap lands before the re-render that disables the button), so a new `view` must never rebuild it, and the
// reset does not clear it either. That is intended, not a gap: the one-request-at-a-time rule (R1) holds across a round change,
// so a press on the new round is ignored for as long as the old round's request is out (its round-trip), then works.
// Only the round the presses TARGET follows the view - `stageId` and `roundNo`, read at call time, never a stale render's.
import { useMemo, useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import type { OpenRoundView } from "@/lib/open-round";
import { initialOpenRoundUi, openRoundRunner, openRoundUi, type OpenRoundUiState } from "./open-round-state";

export type OpenRoundHandle = {
  state: OpenRoundUiState;
  /** Opens the confirmation. Sends nothing. */
  ask(): void;
  /** Closes the confirmation. Sends nothing. */
  cancel(): void;
  /** The confirmation's button: `openRoundRunner.open(view.stageId, view.roundNo)`. */
  open(): void;
  /** Resend for one pairing's invite. */
  resend(fixtureId: string): void;
  /** C8: the round "+5" OpenRoundControl still shows until Task 10 deletes the control; Task 10 removes it from the handle too. */
  extend(): void;
};

type Presses = Omit<OpenRoundHandle, "state">;

/** The presses of a handle with no round: every call does nothing. */
const NO_PRESSES: Presses = { ask: () => {}, cancel: () => {}, open: () => {}, resend: () => {}, extend: () => {} };

/** A null view gives a no-op handle (initial state; every call does nothing). ArbiterPanel calls it for the round on screen (C9). */
export function useOpenRound(view: OpenRoundView | null): OpenRoundHandle {
  const router = useRouter();
  const [state, dispatch] = useReducer(openRoundUi, undefined, initialOpenRoundUi);
  const runner = useMemo(
    () => openRoundRunner({ dispatch, post: (path, body) => apiV1(path, { method: "POST", json: body }), refresh: () => router.refresh() }),
    [router],
  );
  // Primitives, so the presses keep their identity while the same round is redrawn with fresh data.
  const stageId = view === null ? null : view.stageId;
  const roundNo = view === null ? null : view.roundNo;
  // Reset the state when the round on screen changes (adjust-state-during-render, as confirm-dialog.tsx does: no effect, no
  // frame of the old round's state under the new one). No round is a round of its own: null is a key, so a gap resets too.
  const key = stageId === null ? null : `${stageId}:${roundNo}`;
  const [seenKey, setSeenKey] = useState(key);
  if (key !== seenKey) {
    setSeenKey(key);
    dispatch({ type: "reset" });
  }
  const presses = useMemo<Presses>(
    () =>
      stageId === null || roundNo === null
        ? NO_PRESSES
        : {
            ask: () => dispatch({ type: "ask" }),
            cancel: () => dispatch({ type: "cancel" }),
            open: () => void runner.open(stageId, roundNo),
            resend: (fixtureId) => void runner.resend(fixtureId),
            extend: () => void runner.extend(stageId, roundNo),
          },
    [runner, stageId, roundNo],
  );
  return useMemo(() => ({ state, ...presses }), [state, presses]);
}
