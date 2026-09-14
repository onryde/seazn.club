// End-of-over queue item (design 2026-09-12 Feature B). Pure / client-safe.
import type { OverlayClosedOver } from "@/lib/overlay-cricket";
import { doubleBeat, type OverlayMoment } from "@/lib/overlay-moments";
import type { OverlayMsg } from "@/lib/overlay-model";

/** Per-beat hold for the end-of-over card (2026-09-14) — longer than the
 *  slab default (`OVERLAY_MOMENT_HOLD_MS` = 2000ms) because this card carries
 *  more to read (batter/bowler lines, this-over glyphs) than a one-line slab.
 *  `doubleBeat` below fires it twice, same mechanism as SIX/FOUR/OUT/GOAL. */
export const END_OF_OVER_HOLD_MS = 3_000;

/**
 * Full split card when fine facts exist: a ball row PLUS at least one named
 * batter or bowler. Glyphs alone (consent-masked names) fall back to compact
 * — design §4.3 "if too little remains… fall back to compact".
 */
export function isFullEndOfOver(closed: OverlayClosedOver): boolean {
  if (closed.glyphs.length === 0) return false;
  const namedBatter = closed.batters.some((b) => Boolean(b.name));
  const namedBowler = Boolean(closed.bowler?.name);
  return namedBatter || namedBowler;
}

/** Mount baseline when the page has never seen a closed over. */
export const CLOSED_OVER_BASELINE_NONE = { inningsIndex: -1, over: 0 } as const;

export type ClosedOverBaseline = {
  readonly inningsIndex: number;
  readonly over: number;
};

export function closedOverBaselineOf(
  closed: OverlayClosedOver | null | undefined,
): ClosedOverBaseline {
  if (!closed) return CLOSED_OVER_BASELINE_NONE;
  return { inningsIndex: closed.inningsIndex, over: closed.over };
}

/** True when `closed` is strictly after the mount baseline (innings, then over). */
export function isClosedOverAfter(
  closed: OverlayClosedOver,
  since: ClosedOverBaseline,
): boolean {
  if (closed.inningsIndex > since.inningsIndex) return true;
  if (closed.inningsIndex < since.inningsIndex) return false;
  return closed.over > since.over;
}

/**
 * Queue identity for one closed over. Encodes innings so over 12 in innings 1
 * and over 1 in innings 2 cannot share a `seen` slot (`seq:kind`).
 */
export function endOfOverSeq(closed: OverlayClosedOver): number {
  return (closed.inningsIndex + 1) * 1_000 + closed.over;
}

/**
 * One or two queue items when `closed` is newer than the mount baseline.
 * `seq` encodes innings+over so identity is unique across the break.
 *
 * `doubleBeat` (SIX/FOUR/OUT/GOAL's own mechanism) fires the card TWICE at
 * `END_OF_OVER_HOLD_MS` each — same fold-out/fold-in the other moments use,
 * so an over card gets the same "plays twice on air" treatment rather than a
 * single flash. The second beat's `kind` carries `.bis`; the render branch in
 * `overlay-stage.tsx` keys off `graphic === "endOfOver"`, which both beats
 * carry unchanged, so both render identically.
 */
export function endOfOverMoment(args: {
  closed: OverlayClosedOver | null | undefined;
  since: ClosedOverBaseline;
  msg: OverlayMsg;
}): readonly [OverlayMoment, OverlayMoment] | null {
  const closed = args.closed;
  if (!closed) return null;
  if (!isClosedOverAfter(closed, args.since)) return null;
  return doubleBeat({
    seq: endOfOverSeq(closed),
    kind: "endOfOver",
    graphic: "endOfOver",
    tone: "led",
    headline: args.msg("overlay.endOfOver.title", { over: closed.over }),
    line: args.msg("overlay.endOfOver.runsScore", {
      runs: closed.runs,
      score: closed.score,
    }),
    endOfOver: closed,
    holdMs: END_OF_OVER_HOLD_MS,
  });
}
