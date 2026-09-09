"use client";
// The overlay's ONE timer (_THEMES.md §6; design §3.6). Everything else in
// the overlay is CSS. It survives prefers-reduced-motion because it is
// information, not movement.
import { useEffect, useRef, useState } from "react";
import { formatClock } from "@/lib/overlay-model";
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
  const compute = (): string | null => {
    if (!clock) return null;
    const pictureNow = Date.now() - presentationNowOffsetMs;
    const elapsed = Math.max(0, (pictureNow - clock.anchorAtWallMs) / 1000);
    return formatClock(clock.anchorSeconds + elapsed);
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
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `compute` closes over exactly these
  }, [clock?.phase, clock?.anchorSeconds, clock?.anchorAtWallMs, status, presentationNowOffsetMs]);

  return label;
}
