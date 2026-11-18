"use client";
// The corner badge's match timer (owner, 2026-11-17): time since the match STARTED, for every sport whose scorebug
// carries no clock of its own. A second 1 Hz reading beside `use-overlay-clock.ts`'s, on the same footing: it is
// information, not movement, so it survives prefers-reduced-motion.
import { useEffect, useState } from "react";
import { NO_CLOCK_STATUSES, heldOffset } from "./use-overlay-clock";

/** F16 (`use-overlay-clock.ts`) applies here unchanged: a club that starts a match and never ends it is ordinary, and a
 *  timer reading `1205:25` is the most visible defect on the picture. Past this the timer shows nothing. Six hours
 *  covers a one-day cricket match with its interval; nothing shorter than that is cut off. */
export const MATCH_ELAPSED_CAP_MS = 6 * 60 * 60 * 1000;

/** The sports whose scorebug carries a match clock of its own: the engine modules that declare a `<sport>.clock` event
 *  (`brand-badge.test.tsx` holds this list to the engine's). They NEVER get the corner timer — not even before their
 *  clock is started, when the header shows none yet: a timer that vanishes at kick-off is worse than no timer. */
export const CLOCK_SPORT_KEYS: ReadonlySet<string> = new Set(["football", "hockey", "icehockey"]);

const two = (n: number) => String(n).padStart(2, "0");

/** `m:ss` under an hour, `h:mm:ss` from the hour on; `0:00` before the start; null past the cap (pure). */
export function matchElapsedLabel(startedAtMs: number, pictureNowMs: number): string | null {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(pictureNowMs)) return null;
  const elapsedMs = Math.max(0, pictureNowMs - startedAtMs);
  if (elapsedMs > MATCH_ELAPSED_CAP_MS) return null;
  const total = Math.floor(elapsedMs / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Whether the corner timer is on air at all. `sportHasClock`: the scorebug's header already shows match time (the
 *  football family) — one timer per picture, and the sport's own wins. */
export function matchElapsedShown(a: { startedAtMs: number | undefined; status: string; sportHasClock: boolean }): boolean {
  return a.startedAtMs !== undefined && !a.sportHasClock && !NO_CLOCK_STATUSES.has(a.status);
}

/**
 * The label, ticking. The start is the server's `recordedAt`, so it is read on the SERVER's clock — this machine's wall
 * clock plus the overlay's measured offset (held as the header clock holds it, `heldOffset`) — minus the presentation delay, so the timer matches the delayed picture.
 */
export function useMatchElapsed(
  startedAtMs: number | undefined,
  status: string,
  sportHasClock: boolean,
  presentationNowOffsetMs: number,
  serverOffsetMs?: () => number | null,
): string | null {
  const shown = matchElapsedShown({ startedAtMs, status, sportHasClock });
  const [tick, setTick] = useState<{ at: number; offsetMs: number | null }>(() => ({
    at: Date.now(),
    offsetMs: serverOffsetMs?.() ?? null,
  }));
  useEffect(() => {
    if (!shown) return;
    const read = () =>
      setTick((prev) => ({ at: Date.now(), offsetMs: heldOffset(prev.offsetMs, serverOffsetMs?.() ?? null) }));
    const reanchor = setTimeout(read, 0);
    const id = setInterval(read, 1000);
    return () => {
      clearTimeout(reanchor);
      clearInterval(id);
    };
  }, [shown, startedAtMs, presentationNowOffsetMs, serverOffsetMs]);
  if (!shown || startedAtMs === undefined) return null;
  return matchElapsedLabel(startedAtMs, tick.at + (tick.offsetMs ?? 0) - presentationNowOffsetMs);
}
