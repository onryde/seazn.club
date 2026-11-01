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
//
// 2026-09-12: each identity change also `sync`s against the live window so a
// scorer undo folds away a slab that would otherwise keep announcing a voided
// ball (see moment-queue `sync` + undo tests).
//
// R4 S7: the queue's proof-of-play lines (spec 2026-10-27 §3.6) — a sponsor
// card entering `hold` logs a start line, leaving `out` an end line. The rule is
// `sponsorQueueLines` (pure, `lib/overlay-compositor.ts`); this hook only feeds
// it each committed state and prints what it returns, and only when the caller
// says `sponsorLines` (the stage: `host=compositor`, never a preview).
import { useEffect, useReducer, useRef } from "react";
import { incomingKey } from "@/lib/overlay-incoming";
import type { OverlayMoment } from "@/lib/overlay-moments";
import { droppingSponsorLine, sponsorQueueLines, type SponsorLineBuilder } from "@/lib/overlay-compositor";
import { INITIAL, momentQueueReducer, nextDeadline, type Phase } from "./moment-queue";
import { OVERLAY_MOMENT_FOLD_MS, OVERLAY_MOMENT_HOLD_MS } from "./moment-timing";

export function useMomentQueue(
  incoming: readonly OverlayMoment[],
  /** `discard` (R2005, spec §4.8): the active scene's `momentsFire` is false, so every new moment is marked seen and
   *  never queued. The stage reads it off the scene's declaration (`momentsFireIn`), never off a scene id. */
  opts: {
    reducedMotion: boolean;
    discard?: boolean;
    /** R4 S7: log the sponsor proof-of-play lines. The stage passes its compositor-host flag; absent ⇒ none. */
    sponsorLines?: boolean;
    /** R4 S7 fix round 1 (ruling m4): a match card is up — sponsor cards wait (the reducer's rule 4). */
    holdSponsors?: boolean;
  },
): { current: OverlayMoment | null; phase: Phase } {
  const discard = opts.discard === true;
  const sponsorLines = opts.sponsorLines === true;
  const holdSponsors = opts.holdSponsors === true;
  // Reduced motion shortens the folds to nothing but keeps the PHASES, so the
  // slab still appears and leaves on the same schedule and `data-phase` still
  // reaches the DOM for the e2e to read. Skipping the phases would make the
  // reduced-motion build a different state machine.
  const foldMs = opts.reducedMotion ? 0 : OVERLAY_MOMENT_FOLD_MS;
  const holdMs = OVERLAY_MOMENT_HOLD_MS;
  const [state, dispatch] = useReducer(momentQueueReducer, INITIAL);

  // Owner ruling (4), 2026-10-19: on the edge INTO a discarding scene (Final), every moment already queued is dropped,
  // so none of them plays under it. Keyed on `discard` alone: it fires when Final arrives, not on every poll under it.
  useEffect(() => {
    if (discard) dispatch({ type: "flush" });
  }, [discard]);

  // Rule 4, on each edge of the match card. Declared BEFORE the enqueue effect, so a card arriving in the same commit
  // as the match card (the first poll of a Reconnecting) meets the hold, not an idle queue that would air it.
  useEffect(() => {
    dispatch({ type: "holdSponsors", hold: holdSponsors, now: Date.now(), foldMs });
  }, [holdSponsors, foldMs]);

  // `incoming` is a fresh array on every poll even when nothing changed, so the
  // effect is keyed on the moments' IDENTITIES rather than the array. The
  // reducer would drop the repeats anyway (it remembers what it has shown);
  // this keeps the dispatch itself from running fifteen times a minute.
  //
  // Sync runs even when the live set is EMPTY: that is the undo case — the
  // only moment on air was voided and `momentsFor` returns nothing. Enqueue
  // alone would early-return and leave the lie on screen.
  const key = incomingKey(incoming);
  useEffect(() => {
    const now = Date.now();
    dispatch({ type: "sync", live: incoming, now, foldMs, holdMs });
    if (incoming.length > 0) {
      dispatch(discard ? { type: "discard", moments: incoming } : { type: "enqueue", moments: incoming, now, foldMs, holdMs });
    }
    // `incoming` is read from the closure and deliberately NOT a dependency: a
    // fresh array arrives on every poll even when nothing changed, so the
    // effect keys on the moments' IDENTITIES instead. Writing it to a ref
    // during render — the first shape this took — is what
    // `react-hooks/purity` forbids ("Cannot access refs during render"), and
    // the score tick in `overlay-stage.tsx` carries the same exemption for the
    // same reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, foldMs, holdMs, discard]);

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

  // The sponsor id whose start line has been logged and whose end has not. Read and written only inside the effect
  // (`react-hooks/refs`); a mutable box, so the effect owns one object for the island's life. A line `sponsorLine`
  // refuses is dropped with one warning (`droppingSponsorLine`), never thrown into the tree.
  const onAir = useRef<{ id: string | null; build: SponsorLineBuilder }>({ id: null, build: droppingSponsorLine() });
  useEffect(() => {
    if (!sponsorLines) return;
    const box = onAir.current;
    const step = sponsorQueueLines(
      box.id,
      { current: state.current, phase: state.phase, cutShort: state.cutShort },
      new Date().toISOString(),
      box.build,
    );
    box.id = step.onAir;
    for (const line of step.lines) console.info(line);
    // Keyed on the whole state: a re-run on a state that changed nothing the tracker reads logs nothing (it is
    // idempotent on a repeated view), so the extra runs cost a comparison, never a line.
  }, [sponsorLines, state]);

  return { current: state.current, phase: state.phase };
}
