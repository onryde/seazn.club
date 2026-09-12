// Match openers — toss center card eligibility (design 2026-09-12 Feature A2).
// Pure / client-safe. Hold ms matches `OVERLAY_TOSS_HOLD_MS` in moment-timing.ts.
import type { OverlayCricketToss } from "@/lib/overlay-cricket";
import type { OverlayMoment } from "@/lib/overlay-moments";
import type { OverlayMsg } from "@/lib/overlay-model";

/** Must stay equal to `OVERLAY_TOSS_HOLD_MS` in `moment-timing.ts`. */
const TOSS_HOLD_MS = 8_000;

/**
 * A2: toss decided, no scoring yet. Identity is stable (`toss:0`) so reconnect
 * while still pre-scoring shows once; after scoringStarted the builder returns
 * null and the queue never sees it again.
 */
export function tossMoment(args: {
  toss: OverlayCricketToss | null | undefined;
  sideNames: readonly [string, string];
  scoringStarted: boolean;
  msg: OverlayMsg;
  seq?: number;
}): OverlayMoment | null {
  if (args.scoringStarted) return null;
  if (!args.toss) return null;
  const team = args.sideNames[args.toss.wonBySide] ?? "";
  if (team === "") return null;
  const choice = args.msg(
    args.toss.elected === "bat" ? "overlay.toss.bat" : "overlay.toss.bowl",
  );
  return {
    seq: args.seq ?? 0,
    kind: "toss",
    graphic: "toss",
    holdMs: TOSS_HOLD_MS,
    tone: "led",
    headline: args.msg("overlay.toss.wonAndElected", { team, choice }),
  };
}
