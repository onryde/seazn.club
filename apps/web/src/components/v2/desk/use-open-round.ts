"use client";

// The Open / Resend / "+5 min" press of ONE round, lifted out of OpenRoundControl so the arbiter column presses the very
// same thing. It owns what the control used to own: the reducer (open-round-state.ts, rules R1-R5: one request at a time,
// the open only from its confirmation), the router, and the runner that puts each request on the network with an `apiV1`
// POST and a `router.refresh()` after the answer. Nothing here is new behaviour; a second caller reads the same state and
// calls the same four presses.
//
// The runner lives for the life of the component, not of the round on screen: its in-flight flag is what keeps a double tap
// off the network (a tap lands before the re-render that disables the button), so a new `view` must never rebuild it.
// Only the round the presses TARGET follows the view - `stageId` and `roundNo`, read at call time, never a stale render's.
import { useMemo, useReducer } from "react";
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

/** What a handle with no round reports: nothing asked, nothing in flight, nothing answered. */
const IDLE: OpenRoundUiState = initialOpenRoundUi();

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
  const shown = stageId === null ? IDLE : state;
  return useMemo(() => ({ state: shown, ...presses }), [shown, presses]);
}
