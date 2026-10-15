"use client";
// The overlay's ONE timer (_THEMES.md §6; design §3.6). Everything else in
// the overlay is CSS. It survives prefers-reduced-motion because it is
// information, not movement.
import { useEffect, useState } from "react";
import { formatClockCapped } from "@/lib/overlay-model";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";

// `["scheduled", "decided", "finalized", "needs_decision", ...VOID_STATUSES]` — proven equal to
// the console's own `VOID_STATUSES` (stages-panel.tsx) by
// use-overlay-clock.test.ts rather than importing that module here (it would
// drag the whole competition-desk panel into the overlay's client bundle).
// Exported so the test can hold the two sets to that equality without
// retyping this literal a second time.
// W2a: `needs_decision` too — a held fixture has no play running, so its
// overlay must not hold the last clock reading forever.
export const NO_CLOCK_STATUSES = new Set(["scheduled", "decided", "finalized", "abandoned", "forfeited", "cancelled", "needs_decision"]);

/**
 * @param clock  the endpoint's anchor — present only while a play phase is
 *               running (server/overlay/project.ts applies footballPosition's
 *               staleness guard); absent between periods.
 * @param status the fixture status; nothing shows outside `in_play`.
 * @param presentationNowOffsetMs the transport's delay (0 without delayMs) —
 *               the ONE authority for how far behind wall time the picture is.
 */
export function useOverlayClock(
  clock: OverlayLiveData["clock"],
  status: string,
  presentationNowOffsetMs: number,
): string | null {
  /**
   * F16 (product ruling 2026-09-10, `_THEMES.md` §3) — THE CLOCK NEVER SHOWS AN
   * IMPLAUSIBLE NUMBER. Driven live, a fixture left `in_play` displayed
   * `1205:25`: a club that starts a match and never ends it is ordinary, and
   * this is the one element on screen that keeps moving, so an absurd value is
   * both the most visible defect and the most likely.
   *
   * Two behaviours, on whether the period's length is known
   * (`nominalSeconds`, projected from the fold's own cfg —
   * `server/overlay/project.ts`):
   *  - KNOWN: keep advancing, and spell anything past it `45+`
   *    (`formatClockCapped`). Added time is real and the reading stays true.
   *  - UNKNOWN: HOLD at the anchor — the last elapsed a scorer actually
   *    recorded — instead of ticking against a bound that does not exist. The
   *    anchor still moves on every push, so the cell is not frozen, it is
   *    merely no longer counting on its own. §3: "the live dot and the period
   *    label carry liveness — the clock does not have to."
   */
  // ESLint L3: the label used to be computed in an effect and copied into
  // state (`tick()` straight out of the effect body, plus a `held` ref). It is
  // now DERIVED in render from three things, none of them a copy:
  //  - `shown`: the clock the cell is showing. A push replaces it; an absent
  //    clock (half-time / full-time) keeps the last one — the HOLD; a status
  //    with no clock clears it. Adjusted during render on a real change.
  //  - `tickAt`: the wall time of the last 1 Hz tick, set only from timer
  //    callbacks (the interval, and one zero-delay re-read each time a push
  //    re-arms it) and once at mount, lazily — `Date.now()` never runs in render.
  //  - the presentation offset.
  // So the held reading is EXACTLY what was last shown (same clock, same tick
  // time), not whatever the last tick happened to store.
  const noClock = NO_CLOCK_STATUSES.has(status);
  const [shown, setShown] = useState<Clock | null>(noClock ? null : (clock ?? null));
  const next = noClock ? null : (clock ?? shown);
  if (!sameClock(next, shown)) setShown(next);

  const [tickAt, setTickAt] = useState<number>(() => Date.now());
  // No declared period length, or paused ⇒ the value cannot advance, so no
  // timer is armed. Nor while HOLDING (no clock in the push): `tickAt` stays
  // where it was, so the held reading cannot creep. A push that brings a
  // length / resume re-arms it, and every push re-arms it so the ticks stay in
  // phase with the newest anchor.
  const live = noClock ? undefined : clock;
  const advances = !!live && live.running !== false && live.nominalSeconds !== undefined;
  useEffect(() => {
    if (!advances) return;
    // This effect re-runs on every push that moves the anchor, but `tickAt`
    // predates the push: after a pause or before a first live push it can be
    // minutes old, and a stale tick clamps the elapsed time to zero, so the
    // cell would show the bare anchor ("45:00" for a true "45:03") until the
    // first interval tick. Read the wall clock once right after the commit —
    // from a timer callback, because setting state straight from an effect body
    // is what react-hooks/set-state-in-effect forbids and `Date.now()` in the
    // render branch above is what react-hooks/purity forbids.
    const reanchor = setTimeout(() => setTickAt(Date.now()), 0);
    const id = setInterval(() => setTickAt(Date.now()), 1000);
    return () => {
      clearTimeout(reanchor);
      clearInterval(id);
    };
  }, [advances, live?.phase, live?.anchorSeconds, live?.anchorAtWallMs, presentationNowOffsetMs]);

  return next ? clockLabelAt(next, tickAt, presentationNowOffsetMs) : null;
}

type Clock = NonNullable<OverlayLiveData["clock"]>;

/** The same reading, field by field — a poll hands over a fresh object with
 *  identical values every time, and that must not count as a push. */
function sameClock(a: Clock | null, b: Clock | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.phase === b.phase &&
    a.anchorSeconds === b.anchorSeconds &&
    a.anchorAtWallMs === b.anchorAtWallMs &&
    a.nominalSeconds === b.nominalSeconds &&
    a.running === b.running
  );
}

/** The label for `clock` as of wall time `nowMs` (pure — the F16 rules). */
export function clockLabelAt(clock: Clock, nowMs: number, presentationNowOffsetMs: number): string {
  // Paused (or unknown length): hold at the last stamped elapsed.
  if (clock.running === false || clock.nominalSeconds === undefined) {
    return formatClockCapped(clock.anchorSeconds, clock.nominalSeconds);
  }
  const pictureNow = nowMs - presentationNowOffsetMs;
  const elapsed = Math.max(0, (pictureNow - clock.anchorAtWallMs) / 1000);
  return formatClockCapped(clock.anchorSeconds + elapsed, clock.nominalSeconds);
}
