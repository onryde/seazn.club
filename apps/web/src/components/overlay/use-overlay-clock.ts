"use client";
// The overlay's ONE timer (_THEMES.md §6; design §3.6). Everything else in
// the overlay is CSS. It survives prefers-reduced-motion because it is
// information, not movement.
import { useEffect, useRef, useState } from "react";
import { formatClockCapped } from "@/lib/overlay-model";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";

// `["scheduled", "decided", "finalized", ...VOID_STATUSES]` — proven equal to
// the console's own `VOID_STATUSES` (stages-panel.tsx) by
// use-overlay-clock.test.ts rather than importing that module here (it would
// drag the whole competition-desk panel into the overlay's client bundle).
// Exported so the test can hold the two sets to that equality without
// retyping this literal a second time.
export const NO_CLOCK_STATUSES = new Set(["scheduled", "decided", "finalized", "abandoned", "forfeited", "cancelled"]);

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
  const compute = (): string | null => {
    if (!clock) return null;
    // Paused (or unknown length): hold at the last stamped elapsed.
    if (clock.running === false || clock.nominalSeconds === undefined) {
      return formatClockCapped(clock.anchorSeconds, clock.nominalSeconds);
    }
    const pictureNow = Date.now() - presentationNowOffsetMs;
    const elapsed = Math.max(0, (pictureNow - clock.anchorAtWallMs) / 1000);
    return formatClockCapped(clock.anchorSeconds + elapsed, clock.nominalSeconds);
  };
  const [label, setLabel] = useState<string | null>(() => (NO_CLOCK_STATUSES.has(status) ? null : compute()));
  const held = useRef<string | null>(label);

  useEffect(() => {
    if (NO_CLOCK_STATUSES.has(status)) {
      held.current = null;
      setLabel(null);
      return;
    }
    // Half-time / full-time: the endpoint omits `clock`. HOLD what was last
    // shown — a cell that blanks at the whistle reads as broken.
    if (!clock) {
      setLabel(held.current);
      return;
    }
    const tick = () => {
      const next = compute();
      held.current = next;
      setLabel(next);
    };
    tick(); // re-anchor immediately on every push
    // No declared period length, or paused ⇒ the value cannot advance, so no
    // timer is armed. A later push that brings a length / resume re-runs this.
    if (clock.nominalSeconds === undefined || clock.running === false) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `compute` closes over exactly these
  }, [
    clock?.phase,
    clock?.anchorSeconds,
    clock?.anchorAtWallMs,
    clock?.nominalSeconds,
    clock?.running,
    status,
    presentationNowOffsetMs,
  ]);

  return label;
}
