// End-of-over queue item (design 2026-09-12 Feature B). Pure / client-safe.
import type { OverlayClosedOver } from "@/lib/overlay-cricket";
import type { OverlayMoment } from "@/lib/overlay-moments";
import type { OverlayMsg } from "@/lib/overlay-model";

/** Full split card when the closed over carries a ball row (fine scoring). */
export function isFullEndOfOver(closed: OverlayClosedOver): boolean {
  return closed.glyphs.length > 0;
}

/**
 * One queue item when `closed.over` is newer than the mount baseline.
 * `seq` uses the over number so identity is `overN:endOfOver`.
 */
export function endOfOverMoment(args: {
  closed: OverlayClosedOver | null | undefined;
  sinceOver: number;
  msg: OverlayMsg;
}): OverlayMoment | null {
  const closed = args.closed;
  if (!closed) return null;
  if (closed.over <= args.sinceOver) return null;
  const full = isFullEndOfOver(closed);
  return {
    seq: closed.over,
    kind: "endOfOver",
    graphic: "endOfOver",
    tone: "led",
    headline: args.msg("overlay.endOfOver.title", { over: closed.over }),
    line: args.msg("overlay.endOfOver.runsScore", {
      runs: closed.runs,
      score: closed.score,
    }),
    endOfOver: closed,
    // Attach variant hint in kind suffix? Prefer reading glyphs in the UI.
    ...(full ? {} : {}),
  };
}
