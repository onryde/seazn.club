"use client";
// The queue's one timer (stream overlay W2 Task 4).
//
// DELIBERATELY THIN. Everything decidable lives in the pure reducer next door,
// because `apps/web` vitest is `environment: "node"` and cannot test a hook;
// what is left here is a `useReducer`, one `setTimeout` armed to the reducer's
// own `nextDeadline`, and the reduced-motion read. The e2e proves this half.
//
// ONE setTimeout, never an interval and never rAF (`_THEMES.md` §6: "no
// continuous ticker, no setInterval for visuals"). An OBS browser source runs
// for the length of a match; a 60 Hz loop that exists to notice three state
// changes is the kind of thing that shows up as heat.
import { useEffect, useReducer } from "react";
import type { OverlayMoment } from "@/lib/overlay-moments";
import { INITIAL, momentQueueReducer, nextDeadline, type Phase } from "./moment-queue";
import { OVERLAY_MOMENT_FOLD_MS, OVERLAY_MOMENT_HOLD_MS } from "./moment-timing";

export function useMomentQueue(
  incoming: readonly OverlayMoment[],
  opts: { reducedMotion: boolean },
): { current: OverlayMoment | null; phase: Phase } {
  // Reduced motion shortens the folds to nothing but keeps the PHASES, so the
  // slab still appears and leaves on the same schedule and `data-phase` still
  // reaches the DOM for the e2e to read. Skipping the phases would make the
  // reduced-motion build a different state machine.
  const foldMs = opts.reducedMotion ? 0 : OVERLAY_MOMENT_FOLD_MS;
  const holdMs = OVERLAY_MOMENT_HOLD_MS;
  const [state, dispatch] = useReducer(momentQueueReducer, INITIAL);

  // `incoming` is a fresh array on every poll even when nothing changed, so the
  // effect is keyed on the moments' IDENTITIES rather than the array. The
  // reducer would drop the repeats anyway (it remembers what it has shown);
  // this keeps the dispatch itself from running fifteen times a minute.
  const key = incoming.map((m) => `${m.seq}:${m.kind}`).join(",");
  useEffect(() => {
    if (incoming.length === 0) return;
    dispatch({ type: "enqueue", moments: incoming, now: Date.now(), foldMs, holdMs });
    // `incoming` is read from the closure and deliberately NOT a dependency: a
    // fresh array arrives on every poll even when nothing changed, so the
    // effect keys on the moments' IDENTITIES instead. Writing it to a ref
    // during render — the first shape this took — is what
    // `react-hooks/purity` forbids ("Cannot access refs during render"), and
    // the score tick in `overlay-stage.tsx` carries the same exemption for the
    // same reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, foldMs, holdMs]);

  const deadline = nextDeadline(state);
  // `state.revision` is in the deps, and it is NOT redundant with `deadline`: a
  // deadline REPEATS when `foldMs` is 0 (reduced motion) and a tick lands
  // exactly on it, and an unchanged dependency means no re-run, no timer, and a
  // slab frozen for the rest of the broadcast. The revision is monotonic, so it
  // cannot collide.
  useEffect(() => {
    if (deadline === null) return;
    // `Math.max(0, …)` because a deadline already past must still fire — on a
    // tab that was backgrounded it will be, and a negative delay would never
    // schedule.
    const timer = setTimeout(
      () => dispatch({ type: "tick", now: Date.now(), foldMs, holdMs }),
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [deadline, state.revision, foldMs, holdMs]);

  return { current: state.current, phase: state.phase };
}
