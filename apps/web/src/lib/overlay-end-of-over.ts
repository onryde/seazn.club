// End-of-over queue item (design 2026-09-12 Feature B). Pure / client-safe.
import type { OverlayClosedOver } from "@/lib/overlay-cricket";
import type { OverlayMoment } from "@/lib/overlay-moments";
import type { OverlayMsg } from "@/lib/overlay-model";

/** Full split card when the closed over carries a ball row (fine scoring). */
export function isFullEndOfOver(closed: OverlayClosedOver): boolean {
  return closed.glyphs.length > 0;
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
 * One queue item when `closed` is newer than the mount baseline.
 * `seq` encodes innings+over so identity is unique across the break.
 */
export function endOfOverMoment(args: {
  closed: OverlayClosedOver | null | undefined;
  since: ClosedOverBaseline;
  msg: OverlayMsg;
}): OverlayMoment | null {
  const closed = args.closed;
  if (!closed) return null;
  if (!isClosedOverAfter(closed, args.since)) return null;
  const full = isFullEndOfOver(closed);
  return {
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
    ...(full ? {} : {}),
  };
}
